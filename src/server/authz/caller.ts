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
