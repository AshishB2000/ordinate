// Authorization (T3.3): may this caller make this call? Asked by the RPC
// route (app.ts) after the input parses and BEFORE the handler runs; a deny is
// a 403 and the handler never sees the call.
//
// The rule, in full:
//
//   effective role on project P = admin              if the caller is an org admin
//                               = max(user grant on P, grants on P of every
//                                     team the caller is in)       otherwise
//                               = none                     when there is no grant
//
//   project channel   P must exist in the caller's org, and the effective role
//                     must reach the channel's access: read ≥ viewer,
//                     write ≥ editor, admin ≥ admin.
//   org channel       the caller's ORG role must reach the access the same way
//                     (read → any member, write → org editor, admin → org admin).
//
// Org editor/viewer give no access to any project by themselves — a project is
// seen only by its grantees (and org admins). Anything unresolvable — no
// project id, a project not in this org, a resolver that throws, an access
// level not in the table — is a deny.

import type { Pool } from 'pg';
import type { Contract } from '../../api/contract';
import type { Identity } from '../context';

const RANK: Readonly<Record<string, number>> = { viewer: 1, editor: 2, admin: 3 };
const NEED: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Decision = { readonly ok: true; readonly projectId: string | null } | { readonly ok: false; readonly projectId: string | null };

const deny = (projectId: string | null = null): Decision => ({ ok: false, projectId });

/** Own properties only: `RANK['toString']` must not be a rank. */
const rankOf = (table: Readonly<Record<string, number>>, key: unknown): number =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 0;

/** May an org `role` do an org-level call of this `access`? Unknown either side → no. */
export function orgAllows(role: string, access: string): boolean {
  const need = rankOf(NEED, access);
  return need > 0 && rankOf(RANK, role) >= need;
}

/** Is `id` a project in the CURRENT request's org? Paths are per org, so another org's id is simply absent. */
async function projectExists(id: string): Promise<boolean> {
  const projects = require('../../app/projects') as typeof import('../../app/projects');
  return (await projects.getProject(id)) !== null;
}

/** The caller's best grant rank on `projectId` (0 = none), by user and through teams. */
async function grantRank(pool: Pool | null, who: Identity, projectId: string): Promise<number> {
  if (!pool) return 0;
  const r = await pool.query<{ rank: number | null }>(
    `SELECT max(CASE g.role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)::int AS rank
       FROM users u
       JOIN project_grants g ON g.org_id = u.org_id AND g.project_id = $3
        AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))
      WHERE u.org_id = $1 AND u.email = $2 AND u.disabled_at IS NULL`,
    [who.org.id, who.user.email, projectId],
  );
  return r.rows[0]?.rank ?? 0;
}

/** Decides one call. Never throws: a failure anywhere is a deny. */
export async function authorize(contract: Contract, input: unknown, who: Identity, pool: Pool | null): Promise<Decision> {
  const need = rankOf(NEED, contract.access);
  if (need === 0) return deny();
  if ('org' in contract && contract.org === true) return orgAllows(who.user.role, contract.access) ? { ok: true, projectId: null } : deny();
  if (!('project' in contract) || typeof contract.project !== 'function') return deny();
  let projectId: string | null = null;
  try {
    const raw: unknown = await contract.project(input);
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) return deny();
    projectId = raw.toLowerCase();
    if (!(await projectExists(projectId))) return deny(projectId);
    const rank = who.user.role === 'admin' ? RANK.admin : await grantRank(pool, who, projectId);
    return rank >= need ? { ok: true, projectId } : deny(projectId);
  } catch {
    return deny(projectId);
  }
}

/**
 * The caller's effective role on every project they hold one on, by the rule
 * above — what a screen asks so it offers only the actions the server would
 * allow (`projects:roles`). Never an authorization decision itself. An org
 * admin's is `admin` on all of `orgProjects`.
 */
export async function rolesOf(pool: Pool | null, who: Identity, orgProjects: () => Promise<string[]>): Promise<Record<string, 'viewer' | 'editor' | 'admin'>> {
  const out: Record<string, 'viewer' | 'editor' | 'admin'> = {};
  if (who.user.role === 'admin') {
    for (const id of await orgProjects()) out[id] = 'admin';
    return out;
  }
  if (!pool) return out;
  const r = await pool.query<{ project_id: string; role: 'viewer' | 'editor' | 'admin' }>(
    `SELECT g.project_id::text,
            (ARRAY['viewer', 'editor', 'admin'])[max(CASE g.role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 END)] AS role
       FROM users u
       JOIN project_grants g ON g.org_id = u.org_id
        AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))
      WHERE u.org_id = $1 AND u.email = $2 AND u.disabled_at IS NULL
      GROUP BY g.project_id`,
    [who.org.id, who.user.email],
  );
  for (const row of r.rows) out[row.project_id] = row.role;
  return out;
}

/**
 * `canRead(projectId)` for the caller — what an org-level list is trimmed by.
 * Org admins read every project of their org; anyone else, the projects they
 * hold any grant on (directly or through a team).
 */
export async function readable(pool: Pool | null, who: Identity): Promise<(projectId: string) => boolean> {
  if (who.user.role === 'admin') return () => true;
  if (!pool) return () => false;
  const r = await pool.query<{ project_id: string }>(
    `SELECT DISTINCT g.project_id
       FROM users u
       JOIN project_grants g ON g.org_id = u.org_id
        AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))
      WHERE u.org_id = $1 AND u.email = $2 AND u.disabled_at IS NULL`,
    [who.org.id, who.user.email],
  );
  const ids = new Set(r.rows.map((row) => row.project_id));
  return (id) => typeof id === 'string' && ids.has(id.toLowerCase());
}

/**
 * Every enabled member of `org` who may read `projectId` — org admins and its
 * grantees, directly or through a team. The inverse of `readable`, for a push
 * about one project that must reach only them (../jobs/schedules.ts).
 */
export async function readerEmails(pool: Pool, org: string, projectId: string): Promise<string[]> {
  const r = await pool.query<{ email: string }>(
    `SELECT u.email FROM users u
      WHERE u.org_id = $1 AND u.disabled_at IS NULL
        AND (u.role = 'admin' OR EXISTS (
              SELECT 1 FROM project_grants g
               WHERE g.org_id = u.org_id AND g.project_id = $2
                 AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))))
      ORDER BY u.email`,
    [org, projectId],
  );
  return r.rows.map((row) => row.email);
}

/** Project creation: the creator becomes the new project's admin. */
export async function grantCreator(pool: Pool | null, who: Identity, projectId: string): Promise<void> {
  if (!pool) return; // dev without Postgres: the only caller is the dev admin
  const r = await pool.query(
    `INSERT INTO project_grants (org_id, project_id, user_id, role)
     SELECT u.org_id, $3, u.id, 'admin' FROM users u WHERE u.org_id = $1 AND u.email = $2
     ON CONFLICT (org_id, project_id, user_id) DO UPDATE SET role = 'admin'`,
    [who.org.id, who.user.email, projectId],
  );
  if (r.rowCount !== 1) throw new Error('creator grant not written: no such member');
}
