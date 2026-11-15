// One transaction as an org: `BEGIN`, `SET LOCAL ordinate.org` (the RLS policy
// of every org-scoped table reads it), the caller's statements, `COMMIT` — or
// `ROLLBACK` on a throw. The same three statements src/engine/storage.ts and
// src/app/recordFs.ts run for their own tables; the any-pod stores share this
// one (docs/any-pod/00-design.md §4).

import type { Pool, PoolClient, QueryResult } from 'pg';

// Same rule as src/app/paths.ts: the org id becomes a SQL literal below.
const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Runs `fn` in one transaction whose RLS org is `org`. Throws on an invalid org id. */
export async function inOrg<T>(pool: Pool, org: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (!ORG_RE.test(org)) throw new Error('invalid org id');
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    // org passed ORG_RE: it cannot close this literal.
    await c.query(`BEGIN; SELECT set_config('ordinate.org', '${org}', true)`);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch((e: Error) => { broken = e; });
    throw err;
  } finally {
    c.release(broken);
  }
}

/**
 * ONE constant read with no parameters (`sql`, never built from input), as `org`, in ONE round trip: `BEGIN`, the
 * `set_config`, `sql` and `COMMIT` over the simple protocol. For a check on a list's hot path, where `inOrg`'s three
 * statements would be the cost (src/server/authz/folders.ts `foldersRestrict`). Its rows; `ROLLBACK` on a throw.
 */
export async function readOnceInOrg<R extends object>(pool: Pool, org: string, sql: string): Promise<R[]> {
  if (!ORG_RE.test(org)) throw new Error('invalid org id');
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    // org passed ORG_RE: it cannot close this literal. Four statements, four results: the third is the read's.
    const all = (await c.query(`BEGIN; SELECT set_config('ordinate.org', '${org}', true); ${sql}; COMMIT`)) as unknown as Array<QueryResult<R>>;
    return all[2].rows;
  } catch (err) {
    await c.query('ROLLBACK').catch((e: Error) => { broken = e; });
    throw err;
  } finally {
    c.release(broken);
  }
}
