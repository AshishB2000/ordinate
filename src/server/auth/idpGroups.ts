// IdP groups → org role and linked teams (docs/sso-lifecycle/00-design.md).
//
// Sign-in reads a person's groups — the ID token's OIDC_GROUPS_CLAIM, or the
// trusted proxy's TRUSTED_GROUPS_HEADER — and an admin maps groups to a role
// and to teams (`idp_groups`, 0019). Applied at every OIDC sign-in and, in
// header mode, whenever the header's groups change (`idp_groups_digest`).
//
// The rules: the highest mapped role wins; no mapped group is a viewer; the
// break-glass ORDINATE_ADMIN_EMAIL is admin; the org's last admin is kept. A
// linked team holds exactly the IdP's members; unlinked teams are manual. A
// claim or header that is absent — or Entra's overage marker — changes NOTHING:
// only an explicit list does.
//
// The pure parts are exported for scripts/test-idpGroups; the DB part runs
// under the org's people lock (./store.ts withPeopleLock).

import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type { Role } from '../context';
import type { AuthEnv } from '../env';
import { audit } from '../authz/audit';
import { forgetCaller } from '../authz/caller';
import { CLEAR_KEPT, OTHER_ADMINS, withPeopleLock } from './store';

export interface GroupMapping {
  readonly group: string;
  readonly role: Role | null;
  readonly teamId: string | null;
}

/** What a sync is told to log through: the request's or the app's logger, never `console`. */
export interface SyncLog {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

/** A group name as it is stored and compared: Unicode NFC, trimmed. Matching is exact and case-sensitive. */
export const canonGroup = (s: string): string => s.normalize('NFC').trim();

/** Canonical, deduplicated, sorted (code-point order); empty names dropped. */
export function canonGroups(list: readonly string[]): string[] {
  return [...new Set(list.map(canonGroup).filter(Boolean))].sort();
}

/** An explicit group list, or why there is none: neither changes anything. */
export type ReadGroups = string[] | 'absent' | 'overage';

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The groups an ID token's claims state under `name`. Overage FIRST — Entra's `_claim_names` naming this
 * claim, or `hasgroups` for the `groups` claim — even with a list present (a contradiction is not trusted).
 * A string is one group. An array of strings is the list. Anything else — missing, null, a number, an
 * object, an array holding a non-string — is absent: never an empty list, never a partial one.
 */
export function groupsFromClaims(claims: Record<string, unknown> | undefined, name: string): ReadGroups {
  const c = claims ?? {};
  const names = c._claim_names;
  if (names && typeof names === 'object' && !Array.isArray(names) && own(names, name)) return 'overage';
  if (name === 'groups' && (c.hasgroups === true || c.hasgroups === 'true')) return 'overage';
  const v = own(c, name) ? c[name] : undefined;
  if (typeof v === 'string') return canonGroups([v]);
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return canonGroups(v as string[]);
  return 'absent';
}

/** The groups a trusted proxy's header states, comma-separated (oauth2-proxy's format). Missing = absent; empty = []. */
export function groupsFromHeader(raw: string | string[] | undefined): string[] | 'absent' {
  if (raw === undefined) return 'absent';
  return canonGroups((Array.isArray(raw) ? raw.join(',') : raw).split(','));
}

/** What header mode compares per request: every per-person input of the decision. */
export function digestOf(groups: readonly string[], breakGlass: boolean): string {
  return createHash('sha256').update(JSON.stringify([breakGlass ? 1 : 0, ...groups])).digest('hex');
}

export interface Mapped {
  /** The role to hold, or null: no group maps a role, so roles are manual (break-glass is admin either way). */
  readonly role: Role | null;
  /** The linked teams these groups put the person in. */
  readonly teams: readonly string[];
  /** Every linked team: the only teams a sync adds to or removes from. */
  readonly linked: readonly string[];
}

/** The mapping, pure: the highest mapped role wins, no match is a viewer, break-glass is admin. */
export function rolesAndTeams(groups: readonly string[], map: readonly GroupMapping[], breakGlass: boolean): Mapped {
  const has = new Set(groups);
  const matched = map.filter((m) => has.has(m.group));
  const managed = map.some((m) => m.role !== null);
  const best = matched.reduce<Role>((r, m) => (m.role && RANK[m.role] > RANK[r] ? m.role : r), 'viewer');
  const teamsOf = (ms: readonly GroupMapping[]) => [...new Set(ms.flatMap((m) => (m.teamId ? [m.teamId] : [])))].sort();
  return { role: breakGlass ? 'admin' : managed ? best : null, teams: teamsOf(matched), linked: teamsOf(map) };
}

/** The last-admin rule, pure: an admin is demoted only while another enabled, signed-in admin remains. */
export function keepLastAdmin(current: Role, next: Role, otherAdmins: number): Role {
  return current === 'admin' && next !== 'admin' && otherAdmins === 0 ? 'admin' : next;
}

// ── The DB part ──────────────────────────────────────────────────────────

/** Sync outcomes on this pod, for /metrics (`ordinate_idp_sync_total`). */
const counts = new Map<string, number>();
export const countSync = (outcome: 'applied' | 'unchanged' | 'absent' | 'overage' | 'kept'): void => void counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
export const idpSyncCounts = (): ReadonlyMap<string, number> => counts;

/** Once per person per hour per pod: a kept admin's error and audit row, an absent claim's warning. */
const RATE_MS = 3_600_000;
const lastSaid = new Map<string, number>();
export function oncePerHour(key: string): boolean {
  const now = Date.now();
  const at = lastSaid.get(key);
  if (at !== undefined && now - at < RATE_MS) return false;
  if (lastSaid.size > 10_000) lastSaid.clear(); // ponytail: a bounded memo, not an LRU
  lastSaid.set(key, now);
  return true;
}

// Test seam: a hook between a sync's decision and its writes (scripts/test-idpGroups' race barrier).
let barrier: ((email: string) => Promise<void>) | null = null;
export function setSyncBarrierForTest(fn: ((email: string) => Promise<void>) | null): void {
  barrier = fn;
}

export async function readMap(c: PoolClient | Pool, org: string): Promise<GroupMapping[]> {
  const r = await c.query<GroupMapping>('SELECT group_name AS "group", role, team_id::text AS "teamId" FROM idp_groups WHERE org_id = $1 ORDER BY group_name', [org]);
  return r.rows;
}

export interface Applied {
  readonly role: Role;
  readonly roleChanged: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly kept: boolean;
}

const RETRY = Symbol('retry under the exclusive lock');

/**
 * One member's sync inside a people-lock transaction. Null: not an enabled member (any more). RETRY: the
 * read says an admin would be demoted and this is the shared lock — decide again under the exclusive one.
 */
async function applyLocked(
  c: PoolClient, org: string, userId: string, groups: readonly string[], breakGlass: boolean,
  mode: 'shared' | 'exclusive', compare: boolean, map?: readonly GroupMapping[], email = '',
): Promise<Applied | null | typeof RETRY> {
  const r = await c.query<{ role: Role; digest: string | null }>(
    'SELECT role, idp_groups_digest AS digest FROM users WHERE org_id = $1 AND id = $2 AND disabled_at IS NULL FOR UPDATE', [org, userId]);
  const row = r.rows[0];
  if (!row) return null;
  const d = digestOf(groups, breakGlass);
  if (compare && (row.digest === d || row.digest === 'kept:' + d)) return { role: row.role, roleChanged: false, added: [], removed: [], kept: false };
  const out = rolesAndTeams(groups, map ?? (await readMap(c, org)), breakGlass);
  let role = out.role ?? row.role;
  let kept = false;
  if (row.role === 'admin' && role !== 'admin') {
    if (mode === 'shared') return RETRY;
    const n = await c.query<{ n: string }>(`SELECT ${OTHER_ADMINS} AS n`, [org, userId]);
    role = keepLastAdmin(row.role, role, Number(n.rows[0].n));
    kept = role === 'admin';
  }
  if (barrier) await barrier(email);
  if (role !== row.role) {
    await c.query('UPDATE users SET role = $3 WHERE org_id = $1 AND id = $2', [org, userId, role]);
    if (role === 'admin') await c.query(CLEAR_KEPT, [org]);
  }
  const cur = await c.query<{ team: string }>('SELECT team_id::text AS team FROM team_members WHERE user_id = $1 AND team_id = ANY($2::uuid[])', [userId, out.linked]);
  const now = new Set(cur.rows.map((x) => x.team));
  const want = new Set(out.teams);
  const added = out.teams.filter((t) => !now.has(t));
  const removed = [...now].filter((t) => !want.has(t)).sort();
  if (added.length) await c.query('INSERT INTO team_members (team_id, user_id) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING', [added, userId]);
  if (removed.length) await c.query('DELETE FROM team_members WHERE user_id = $1 AND team_id = ANY($2::uuid[])', [userId, removed]);
  await c.query('UPDATE users SET idp_groups = $3, idp_groups_digest = $4 WHERE org_id = $1 AND id = $2', [org, userId, groups, kept ? 'kept:' + d : d]);
  return { role, roleChanged: role !== row.role, added, removed, kept };
}

/** The audit row and log line of one member's sync (after commit). Nothing for an unchanged sync. */
export async function reportSync(pool: Pool, org: string, userId: string, email: string, a: Applied, log: SyncLog, requestId?: string): Promise<void> {
  const changed = a.roleChanged || a.added.length > 0 || a.removed.length > 0;
  countSync(a.kept ? 'kept' : changed ? 'applied' : 'unchanged');
  if (a.kept && oncePerHour(`kept\n${org}\n${email}`)) {
    log.error({ org }, 'idp groups would demote the org\'s last admin: role kept');
    await audit(pool, { org, actor: email, action: 'rpc', channel: 'idp:sync', targets: [userId], outcome: 'denied', requestId })
      .catch((err: unknown) => log.error({ err: { name: (err as Error | null)?.name } }, 'audit write failed'));
  }
  if (!changed) return;
  await audit(pool, { org, actor: email, action: 'rpc', channel: 'idp:sync', targets: [userId, ...a.added, ...a.removed], outcome: 'ok', requestId })
    .catch((err: unknown) => log.error({ err: { name: (err as Error | null)?.name } }, 'audit write failed'));
}

/**
 * Applies an explicit group list to one member. `compare` (header mode): a stored digest equal to this
 * one — a parallel request already applied it — changes nothing. Returns the member's role after, or null
 * when they are not an enabled member. A DB error THROWS: sign-in refuses rather than proceed half-synced.
 */
export async function applyIdpGroups(
  pool: Pool, auth: AuthEnv, who: { userId: string; email: string }, groups: readonly string[],
  o: { compare: boolean; log: SyncLog; requestId?: string },
): Promise<Role | null> {
  const breakGlass = auth.adminEmail === who.email;
  const run = (mode: 'shared' | 'exclusive') =>
    withPeopleLock(pool, auth.org, mode, (c) => applyLocked(c, auth.org, who.userId, groups, breakGlass, mode, o.compare, undefined, who.email));
  let a = await run('shared');
  if (a === RETRY) a = await run('exclusive');
  if (a === null || a === RETRY) return null;
  forgetCaller(); // a sync inside a request (none today) must not leave its teams memo stale
  await reportSync(pool, auth.org, who.userId, who.email, a, o.log, o.requestId);
  return a.role;
}

/**
 * Every enabled member with a stored group list, applied again with the CURRENT map — inside the caller's
 * exclusive people-lock transaction (`admin:setIdpGroup`). Returns what each change needs reported.
 * ponytail: one pass over the org's synced members per mapping change; set-based if an org outgrows it.
 */
export async function reapplyAll(c: PoolClient, auth: AuthEnv, org: string): Promise<Array<{ userId: string; email: string; applied: Applied }>> {
  const map = await readMap(c, org);
  const users = await c.query<{ id: string; email: string; groups: string[] }>(
    'SELECT id::text, email, idp_groups AS groups FROM users WHERE org_id = $1 AND disabled_at IS NULL AND idp_groups IS NOT NULL ORDER BY email', [org]);
  const out: Array<{ userId: string; email: string; applied: Applied }> = [];
  for (const u of users.rows) {
    const a = await applyLocked(c, org, u.id, u.groups, auth.adminEmail === u.email, 'exclusive', false, map, u.email);
    if (a && a !== RETRY) out.push({ userId: u.id, email: u.email, applied: a });
  }
  return out;
}

/** Roles follow the IdP: the server reads groups and some group maps a role (docs §3.5). */
export async function roleManaged(pool: Pool | PoolClient, auth: AuthEnv, org: string): Promise<boolean> {
  if (!auth.groupsFrom) return false;
  return (await pool.query('SELECT 1 FROM idp_groups WHERE org_id = $1 AND role IS NOT NULL LIMIT 1', [org])).rowCount === 1;
}

/** The team's members come from the IdP: the server reads groups and a group links it. */
export async function teamLinked(pool: Pool | PoolClient, auth: AuthEnv, org: string, teamId: string): Promise<boolean> {
  if (!auth.groupsFrom) return false;
  return (await pool.query('SELECT 1 FROM idp_groups WHERE org_id = $1 AND team_id = $2 LIMIT 1', [org, teamId])).rowCount === 1;
}
