// A mapping change re-applied to every synced member AT ONCE (docs/sso-lifecycle §3.13), set-based so the
// exclusive people lock is held for a bounded time (review S-M1: a member-by-member loop held it 27 s for
// 15,000 members and starved the pool). Four reads, the decision in memory, at most five writes.
//
// The rules are `applyLocked`'s (./idpGroups.ts), member by member:
//   - promotions to admin are counted FIRST, then each demotion keeps the org's last signed-in admin (C3);
//   - a list read longer ago than a session (SESSION_ABSOLUTE_HOURS) only takes away: no higher role, no new
//     team, and no digest, so header mode reads the member's groups again at their next request (S-L3);
//   - a kept admin gets a `kept:` digest; any promotion clears the org's other `kept:` markers (C2).

import type { Pool, PoolClient } from 'pg';
import type { Role } from '../context';
import type { AuthEnv } from '../env';
import { auditMany, type AuditEntry } from '../authz/audit';
import { countSync, digestOf, oncePerHour, readMap, rolesAndTeams, type Applied, type SyncLog } from './idpGroups';
import { CLEAR_KEPT } from './store';

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

interface Row {
  id: string;
  email: string;
  role: Role;
  groups: string[];
  digest: string | null;
  fresh: boolean;
  signed: boolean;
}

export interface Reapplied {
  readonly userId: string;
  readonly email: string;
  readonly applied: Applied;
}

/**
 * Every enabled member with a stored group list, applied again with the CURRENT map — inside the caller's
 * EXCLUSIVE people-lock transaction (`admin:setIdpGroup`). Returns the members it changed or kept.
 */
export async function reapplyAll(c: PoolClient, auth: AuthEnv, org: string): Promise<Reapplied[]> {
  const map = await readMap(c, org);
  const linked = [...new Set(map.flatMap((m) => (m.teamId ? [m.teamId] : [])))];
  const users = (await c.query<Row>(
    `SELECT id::text, email, role, idp_groups AS groups, idp_groups_digest AS digest, last_login_at IS NOT NULL AS signed,
            coalesce(idp_groups_at > now() - $2 * interval '1 millisecond', false) AS fresh
       FROM users WHERE org_id = $1 AND disabled_at IS NULL AND idp_groups IS NOT NULL ORDER BY email`,
    [org, auth.sessionAbsoluteMs],
  )).rows;
  const member = new Map<string, Set<string>>();
  for (const r of (await c.query<{ u: string; t: string }>(
    `SELECT m.user_id::text AS u, m.team_id::text AS t FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE t.org_id = $1 AND m.team_id = ANY($2::uuid[])`, [org, linked])).rows) {
    let set = member.get(r.u);
    if (!set) member.set(r.u, (set = new Set()));
    set.add(r.t);
  }
  // The last-admin rule's set: the org's enabled admins who have signed in — every member, synced or not.
  const admins = new Set((await c.query<{ id: string }>(
    `SELECT id::text FROM users WHERE org_id = $1 AND role = 'admin' AND disabled_at IS NULL AND last_login_at IS NOT NULL`, [org])).rows.map((r) => r.id));

  const plans = users.map((u) => {
    const bg = auth.adminEmail === u.email;
    const out = rolesAndTeams(u.groups, map, bg);
    let role: Role = out.role ?? u.role;
    let withheld = false;
    if (!u.fresh && !bg && RANK[role] > RANK[u.role]) {
      role = u.role;
      withheld = true;
    }
    const now = member.get(u.id) ?? new Set<string>();
    const want = new Set(out.teams);
    const adds = out.teams.filter((t) => !now.has(t));
    if (adds.length && !u.fresh) withheld = true;
    return { u, role, withheld, kept: false, added: u.fresh ? adds : [], removed: [...now].filter((t) => !want.has(t)).sort(), d: digestOf(u.groups, bg) };
  });
  // Promotions first (C3), then each demotion against what remains.
  const promoted = plans.filter((p) => p.role === 'admin' && p.u.role !== 'admin');
  for (const p of promoted) if (p.u.signed) admins.add(p.u.id);
  for (const p of plans) {
    if (p.u.role !== 'admin' || p.role === 'admin') continue;
    admins.delete(p.u.id);
    if (admins.size === 0) {
      p.role = 'admin';
      p.kept = true;
      admins.add(p.u.id);
    }
  }

  const roles = plans.filter((p) => p.role !== p.u.role);
  if (roles.length) {
    await c.query(`UPDATE users SET role = v.role FROM unnest($1::uuid[], $2::text[]) AS v(id, role) WHERE users.id = v.id`,
      [roles.map((p) => p.u.id), roles.map((p) => p.role)]);
  }
  if (promoted.length) await c.query(CLEAR_KEPT, [org]); // the org gained an admin: kept ones are evaluated again
  const adds = plans.flatMap((p) => p.added.map((t) => [t, p.u.id] as const));
  if (adds.length) {
    await c.query(`INSERT INTO team_members (team_id, user_id) SELECT * FROM unnest($1::uuid[], $2::uuid[]) ON CONFLICT DO NOTHING`,
      [adds.map((a) => a[0]), adds.map((a) => a[1])]);
  }
  const dels = plans.flatMap((p) => p.removed.map((t) => [t, p.u.id] as const));
  if (dels.length) {
    await c.query(`DELETE FROM team_members m USING unnest($1::uuid[], $2::uuid[]) AS v(t, u) WHERE m.team_id = v.t AND m.user_id = v.u`,
      [dels.map((a) => a[0]), dels.map((a) => a[1])]);
  }
  // Digests: a withheld grant has none (re-read at the next request); a kept admin is marked; the rest current.
  const digests = plans
    .map((p) => ({ id: p.u.id, was: p.u.digest, now: p.withheld ? null : p.kept ? 'kept:' + p.d : p.d }))
    .filter((x) => x.now !== x.was || (promoted.length > 0 && !!x.was && x.was.startsWith('kept:')));
  if (digests.length) {
    await c.query(`UPDATE users SET idp_groups_digest = v.d FROM unnest($1::uuid[], $2::text[]) AS v(id, d) WHERE users.id = v.id`,
      [digests.map((x) => x.id), digests.map((x) => x.now)]);
  }
  return plans
    .filter((p) => p.kept || p.role !== p.u.role || p.added.length > 0 || p.removed.length > 0)
    .map((p) => ({ userId: p.u.id, email: p.u.email, applied: { role: p.role, roleChanged: p.role !== p.u.role, added: p.added, removed: p.removed, kept: p.kept } }));
}

/** The audit rows of a re-apply, in one statement: `idp:sync` ok per changed member, denied per kept admin (once an hour). */
export async function reportMany(pool: Pool, org: string, done: readonly Reapplied[], log: SyncLog, requestId?: string): Promise<void> {
  const rows: AuditEntry[] = [];
  for (const { userId, email, applied: a } of done) {
    const changed = a.roleChanged || a.added.length > 0 || a.removed.length > 0;
    countSync(a.kept ? 'kept' : changed ? 'applied' : 'unchanged');
    if (changed) rows.push({ org, actor: email, action: 'rpc', channel: 'idp:sync', targets: [userId, ...a.added, ...a.removed], outcome: 'ok', requestId });
    if (a.kept && oncePerHour(`kept\n${org}\n${email}`)) {
      log.error({ org }, 'idp groups would demote the org\'s last admin: role kept');
      rows.push({ org, actor: email, action: 'rpc', channel: 'idp:sync', targets: [userId], outcome: 'denied', requestId });
    }
  }
  await auditMany(pool, rows).catch((err: unknown) => log.error({ err: { name: (err as Error | null)?.name } }, 'audit write failed'));
}
