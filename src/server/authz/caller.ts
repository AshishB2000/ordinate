// Who is asking, for row access rules (docs/row-policy/00-design.md, "Who is
// asking"). `ctx()` carries only the ORG role; a dataset's rules restrict a
// project VIEWER, so the effective project role is resolved here — with
// `grantRank`, the very rule `authorize` applies — plus, for a viewer, their
// user id and every team they are in.
//
// Fail closed: a database error THROWS (the request is refused), never falls
// back to the org role. No Postgres: only the dev admin signs in, and anyone
// else reads as a viewer with no entitlement.
//
// Memoised per request (a WeakMap keyed by the request context, so it dies with
// it); the RPC and MCP routes seed the rank `authorize` already computed.

import type { Pool } from 'pg';
import { ctx } from '../context';
import { grantRank } from './index';

export interface Caller {
  readonly restricted: boolean;
  readonly userId: string | null;
  readonly teamIds: readonly string[];
}

const UNRESTRICTED: Caller = Object.freeze({ restricted: false, userId: null, teamIds: Object.freeze([]) });
const EDITOR_RANK = 2;

// ponytail: one pool per process, like share.ts — set by register().
let poolOf: () => Pool | null = () => null;

export function register(pool: () => Pool | null): void {
  poolOf = pool;
}

const ranks = new WeakMap<object, Map<string, number>>();
const callers = new WeakMap<object, Map<string, Promise<Caller>>>();

const perRequest = <T>(m: WeakMap<object, Map<string, T>>): Map<string, T> => {
  const store = ctx() as object;
  let inner = m.get(store);
  if (!inner) {
    inner = new Map();
    m.set(store, inner);
  }
  return inner;
};

/**
 * Forget this request's memo, if a request is current: an IdP sync just changed the caller's teams (or the
 * team grants behind their rank). Syncs run before a request context exists (docs/sso-lifecycle §3.7), so
 * this is the guard for one that ever runs inside one.
 */
export function forgetCaller(): void {
  let store: object;
  try {
    store = ctx() as object;
  } catch {
    return; // outside a request on the server: no memo to drop
  }
  ranks.delete(store);
  callers.delete(store);
}

/** The rank `authorize` computed for this request's project (the route calls this): no second query. */
export function seedRank(projectId: string, rank: number): void {
  perRequest(ranks).set(projectId.toLowerCase(), rank);
}

async function resolve(projectId: string): Promise<Caller> {
  const who = ctx();
  const key = projectId.toLowerCase();
  const pool = poolOf();
  const seeded = perRequest(ranks).get(key);
  const rank = seeded !== undefined ? seeded : await grantRank(pool, who, key);
  if (seeded === undefined) seedRank(key, rank); // `rankOn` in this request (the folder resolver's) needs no second query
  if (rank >= EDITOR_RANK) return UNRESTRICTED;
  if (!pool) return { restricted: true, userId: null, teamIds: [] };
  const r = await pool.query<{ id: string; teams: string[] }>(
    `SELECT u.id::text AS id, array(SELECT tm.team_id::text FROM team_members tm WHERE tm.user_id = u.id) AS teams
       FROM users u
      WHERE u.org_id = $1 AND u.email = $2 AND u.disabled_at IS NULL`,
    [who.org.id, who.user.email],
  );
  const row = r.rows[0];
  return { restricted: true, userId: row ? row.id : null, teamIds: row && Array.isArray(row.teams) ? row.teams : [] };
}

/**
 * The caller's effective rank on `projectId` (3 admin, 2 editor, 1 viewer, 0 none), by the rule `authorize` applies:
 * an org admin is a project admin everywhere. The rank `authorize` seeded for this request, else one query. Never an
 * authorization decision by itself (the route made that); a screen's and an agent's "may they" (src/ai/agentAccess.ts).
 */
export async function rankOn(projectId: string): Promise<number> {
  const who = ctx();
  if (who.user.role === 'admin') return 3;
  const seeded = perRequest(ranks).get(projectId.toLowerCase());
  return seeded !== undefined ? seeded : grantRank(poolOf(), who, projectId.toLowerCase());
}

/** Every team the caller is in, whatever their rank (ids, lowercase). None without Postgres (the dev admin's only). */
export async function callerTeamIds(): Promise<string[]> {
  const pool = poolOf();
  if (!pool) return [];
  const who = ctx();
  const r = await pool.query<{ id: string }>(
    `SELECT tm.team_id::text AS id FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE u.org_id = $1 AND u.email = $2 AND u.disabled_at IS NULL`,
    [who.org.id, who.user.email],
  );
  return r.rows.map((row) => row.id.toLowerCase());
}

/** The caller's org's teams among `ids` (every one when `ids` is absent), by name: what an agent may name. */
export async function orgTeams(ids?: readonly string[]): Promise<{ id: string; name: string }[]> {
  const pool = poolOf();
  if (!pool) return [];
  const r = await pool.query<{ id: string; name: string }>(
    'SELECT id::text, name FROM teams WHERE org_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) ORDER BY name',
    [ctx().org.id, ids ? [...ids] : null],
  );
  return r.rows.map((row) => ({ id: row.id.toLowerCase(), name: row.name }));
}

/** The caller on `projectId`: unrestricted (org admin, project editor or admin), or restricted with their ids. */
export function callerOn(projectId: string): Promise<Caller> {
  const who = ctx();
  if (who.user.role === 'admin') return Promise.resolve(UNRESTRICTED); // org admins, the jobs' system identity, desktop
  const memo = perRequest(callers);
  const key = projectId.toLowerCase();
  let hit = memo.get(key);
  if (!hit) {
    hit = resolve(projectId);
    memo.set(key, hit);
    hit.catch(() => memo.delete(key)); // a failed lookup is not remembered as an answer
  }
  return hit;
}
