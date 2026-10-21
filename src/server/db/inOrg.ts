// One transaction as an org, for the tables whose row-level security is forced
// (0020_notifications.sql: alert_inbox, alert_posts, mentions): `ordinate.org`
// is set for the transaction, so a statement that forgot its org sees no rows.
// Every statement names its org anyway. The pool is the server's
// (src/server/app.ts); null without DATABASE_URL.

import type { Pool, PoolClient } from 'pg';
import { ORG_RE } from '../../app/paths';
import { ctx } from '../context';

let pool: Pool | null = null;

/** The pool these tables are read through (src/server/app.ts), or null. A test swaps in an ordinary role's. */
export function useOrgDb(p: Pool | null): void {
  pool = p;
}

export function orgDb(): Pool | null {
  return pool;
}

/** `fn` in one transaction with `ordinate.org` = `org` (the caller's by default). Throws without a database. */
export async function inOrg<T>(fn: (c: PoolClient, org: string) => Promise<T>, org: string = ctx().org.id): Promise<T> {
  if (!pool) throw new Error('no database');
  if (!ORG_RE.test(org)) throw new Error('invalid org'); // it becomes a SQL literal below
  const c = await pool.connect();
  try {
    await c.query(`BEGIN; SELECT set_config('ordinate.org', '${org}', true)`);
    const out = await fn(c, org);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
