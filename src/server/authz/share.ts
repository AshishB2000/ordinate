// Project sharing (T3.3): the handlers behind `project:access` (who holds
// which role) and `project:share` (grant, change, remove); T2.2 adds
// `projects:roles` (the caller's own) and `project:shareTargets` (whom to add). The route has
// already checked the caller — read on the project for the list, project
// admin for a change — so these only check that the grantee is a user or
// team of the caller's org. The owner team's grant is not changed here
// (ownership moves in Admin → Projects, ../admin/org.ts). Server only: they
// need Postgres.

import type { Pool } from 'pg';
import { ctx } from '../context';
import { registry } from '../rpc';
import { rolesOf } from './index';

type Role = 'viewer' | 'editor' | 'admin';
type Member = { userId: string } | { teamId: string };

export interface Grant {
  readonly kind: 'user' | 'team';
  readonly id: string;
  /** The user's email or the team's name. */
  readonly label: string;
  readonly role: Role;
  readonly owner: boolean;
}

/** Who a project admin may share with: the org's enabled users and its teams. */
export interface ShareTargets {
  readonly users: readonly { id: string; email: string }[];
  readonly teams: readonly { id: string; name: string }[];
}

// ponytail: one pool per process, like app.ts's — set by register().
let poolOf: () => Pool | null = () => null;

/**
 * A deleted project's grants (projects:delete, src/ipc/projects.ts). Ids are
 * never reused, so a left-over row would only be dead weight in every
 * `readable()` set — but a project that is gone should leave no access behind.
 */
export async function dropGrants(projectId: string): Promise<void> {
  const p = poolOf();
  if (p) await p.query('DELETE FROM project_grants WHERE org_id = $1 AND project_id = $2', [ctx().org.id, projectId]);
}

/** Registers the channels; `pool()` is read per call (null → the server has no Postgres). */
export function register(pool: () => Pool | null): void {
  poolOf = pool;
  const db = (): Pool => {
    const p = pool();
    if (!p) throw new Error('sharing needs Postgres (DATABASE_URL)');
    return p;
  };

  // The caller's own role on each project they can open, in one query. Works
  // without Postgres: there the only caller is the dev admin, admin on all.
  registry.handle('projects:roles', async () =>
    rolesOf(pool(), ctx(), async () => {
      const projects = require('../../app/projects') as typeof import('../../app/projects');
      return (await projects.listProjects()).map((p) => p.id);
    }),
  );

  registry.handle('project:shareTargets', async (): Promise<ShareTargets> => {
    const org = ctx().org.id;
    const [users, teams] = await Promise.all([
      db().query<{ id: string; email: string }>(
        'SELECT id::text, email FROM users WHERE org_id = $1 AND disabled_at IS NULL ORDER BY email',
        [org],
      ),
      db().query<{ id: string; name: string }>('SELECT id::text, name FROM teams WHERE org_id = $1 ORDER BY name', [org]),
    ]);
    return { users: users.rows, teams: teams.rows };
  });

  registry.handle('project:access', async (_e, { projectId }: { projectId: string }): Promise<Grant[]> => {
    const r = await db().query<Grant>(
      `SELECT CASE WHEN g.user_id IS NULL THEN 'team' ELSE 'user' END AS kind,
              coalesce(g.user_id, g.team_id)::text AS id,
              coalesce(u.email, t.name) AS label, g.role, g.owner
         FROM project_grants g
         LEFT JOIN users u ON u.id = g.user_id
         LEFT JOIN teams t ON t.id = g.team_id
        WHERE g.org_id = $1 AND g.project_id = $2
        ORDER BY g.owner DESC, kind, label`,
      [ctx().org.id, projectId],
    );
    return r.rows;
  });

  registry.handle(
    'project:share',
    async (_e, { projectId, member, role }: { projectId: string; member: Member; role: Role | null }): Promise<{ ok: boolean; error?: string }> => {
      const org = ctx().org.id;
      const [col, id, table] = 'userId' in member ? ['user_id', member.userId, 'users'] : ['team_id', member.teamId, 'teams'];
      const exists = await db().query(`SELECT 1 FROM ${table} WHERE id = $1 AND org_id = $2`, [id, org]);
      if (exists.rowCount !== 1) return { ok: false, error: 'unknown member' };
      if (role === null) {
        await db().query(`DELETE FROM project_grants WHERE org_id = $1 AND project_id = $2 AND ${col} = $3 AND NOT owner`, [org, projectId, id]);
        return { ok: true };
      }
      const r = await db().query(
        `INSERT INTO project_grants (org_id, project_id, ${col}, role) VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, project_id, ${col}) DO UPDATE SET role = EXCLUDED.role WHERE NOT project_grants.owner`,
        [org, projectId, id, role],
      );
      return r.rowCount === 1 ? { ok: true } : { ok: false, error: 'owner' };
    },
  );
}
