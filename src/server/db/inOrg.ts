// One transaction as an org, for the tables whose row-level security is forced
// (0020_notifications.sql: alert_inbox, alert_posts, mentions): `ordinate.org`
// is set for the transaction, so a statement that forgot its org sees no rows.
// Every statement names its org anyway. The transaction itself is the refresh
// URLs' (../hooks/store.ts `within`); this module only holds the pool
// (src/server/app.ts wires it; null without DATABASE_URL).

import type { Pool, PoolClient } from 'pg';
import { ctx } from '../context';
import { within } from '../hooks/store';

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
  return within(pool, 'ordinate.org', org, (c) => fn(c, org));
}
