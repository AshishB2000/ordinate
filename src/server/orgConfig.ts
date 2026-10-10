// An org's settings document in Postgres (0014_org_config.sql) — the backing
// src/app/config.ts reads and writes through on a server with a database.
//
// config.ts is synchronous (`config.get()` is called from everywhere), and a
// database is not. So this module keeps each org's document in memory:
//
//   fresh(org)    before a request or a job runs: at most once a second per
//                 org, ask Postgres for the row's version and re-read the body
//                 if another pod moved it.
//   write         config.persist() hands the new document over; it is the
//                 in-memory truth at once and is upserted in the background,
//                 in order.
//   flushed(org)  before the reply is sent: wait for those upserts, and fail
//                 the request if one failed — a setting is never reported
//                 saved when it is not.
//
// Two pods changing settings inside the same second: the later write wins, for
// the whole document. ponytail: a NOTIFY on write (./jobs/bus.ts) makes the
// other pods re-read at once; a per-field merge if whole-document
// last-writer-wins ever loses someone's change.
//
// An org with no row yet and a `config.json` on this pod's disk (an install
// from before this table): the file is the first document, imported once.

import * as fs from 'fs';
import * as path from 'path';
import type { Pool, QueryResult } from 'pg';
import * as config from '../app/config';
import { ORG_RE } from '../app/paths';
import { ctx } from './context';

/** How stale another pod's change may be here. */
const FRESH_MS = 1_000;

interface OrgDoc {
  /** The document as last read or written; undefined = no row and nothing written yet. */
  body: string | undefined;
  /** Bumped when ANOTHER pod's body replaces ours, so config.ts drops its parsed copy. */
  stamp: number;
  /** The row's version as last seen or written; 0 = no row. */
  version: number;
  checkedAt: number;
  checking: Promise<void> | null;
  writing: Promise<void>;
  /** Local writes so far: a read that raced one must not replace it. */
  writes: number;
  failed: Error | null;
}

let db: Pool | null = null;
let dataDir = '';
const docs = new Map<string, OrgDoc>();

const doc = (org: string): OrgDoc => {
  let d = docs.get(org);
  if (!d) {
    d = { body: undefined, stamp: 0, version: 0, checkedAt: 0, checking: null, writing: Promise.resolve(), writes: 0, failed: null };
    docs.set(org, d);
  }
  return d;
};

/** One statement for `org`, in a transaction that sets the RLS org. `$1` is always the org. */
async function sql(pool: Pool, org: string, text: string, params: unknown[] = []): Promise<QueryResult> {
  if (!ORG_RE.test(org)) throw new Error('invalid org id');
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    await c.query(`BEGIN; SELECT set_config('ordinate.org', '${org}', true)`); // org passed ORG_RE: it cannot close this literal
    const r = await c.query(text, [org, ...params]);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch((e: Error) => { broken = e; });
    throw err;
  } finally {
    c.release(broken);
  }
}

async function check(pool: Pool, org: string, d: OrgDoc): Promise<void> {
  await d.writing.catch(() => undefined); // our own writes first: their version is ours to know
  const writes = d.writes;
  const v = await sql(pool, org, 'SELECT version FROM org_config WHERE org_id = $1');
  const version = v.rows.length ? Number(v.rows[0].version) : 0;
  if (version === 0 && d.body === undefined) return importLegacy(pool, org, d);
  if (version === d.version) return;
  const r = await sql(pool, org, 'SELECT body, version FROM org_config WHERE org_id = $1');
  if (!r.rows.length || d.writes !== writes) return; // a local write happened meanwhile: it is newer than what was read
  d.body = r.rows[0].body as string;
  d.version = Number(r.rows[0].version);
  d.stamp += 1;
}

/** No row yet: this pod's `config.json`, if an earlier version left one, becomes the org's document. */
async function importLegacy(pool: Pool, org: string, d: OrgDoc): Promise<void> {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dataDir, 'orgs', org, 'userData', 'config.json'), 'utf8');
    JSON.parse(text);
  } catch {
    return; // no file, or not JSON: the defaults, until something is saved
  }
  const body = config.storable(JSON.parse(text));
  // Another pod may import the same moment: the first row wins and both read it back.
  await sql(pool, org, 'INSERT INTO org_config (org_id, body) VALUES ($1, $2) ON CONFLICT (org_id) DO NOTHING', [body]);
  const r = await sql(pool, org, 'SELECT body, version FROM org_config WHERE org_id = $1');
  if (!r.rows.length) return;
  d.body = r.rows[0].body as string;
  d.version = Number(r.rows[0].version);
  d.stamp += 1;
}

/** Before a request or a job for `org` runs: make its document no more than FRESH_MS behind the database. */
export function fresh(org: string): Promise<void> {
  const pool = db;
  if (!pool) return Promise.resolve();
  const d = doc(org);
  if (d.checking) return d.checking;
  if (Date.now() - d.checkedAt < FRESH_MS) return Promise.resolve();
  d.checking = check(pool, org, d).finally(() => {
    d.checkedAt = Date.now();
    d.checking = null;
  });
  return d.checking;
}

/** Before a reply for `org` is sent: its settings writes are in Postgres, or this rejects. */
export async function flushed(org: string): Promise<void> {
  const d = docs.get(org);
  if (!d) return;
  await d.writing;
  if (d.failed) {
    const err = d.failed;
    d.failed = null;
    d.checkedAt = 0; // re-read what the database really holds:
    d.version = -1;  // our in-memory document is the one that was NOT saved
    throw err;
  }
}

const backing: config.Backing = {
  read: () => doc(ctx().org.id).body,
  stamp: () => doc(ctx().org.id).stamp,
  write(body: string): void {
    const pool = db;
    const org = ctx().org.id;
    const d = doc(org);
    d.body = body;
    d.writes += 1;
    if (!pool) return;
    d.writing = d.writing.then(async () => {
      try {
        const r = await sql(
          pool, org,
          `INSERT INTO org_config (org_id, body) VALUES ($1, $2)
           ON CONFLICT (org_id) DO UPDATE SET body = EXCLUDED.body, version = org_config.version + 1, updated_at = now()
           RETURNING version`,
          [body],
        );
        d.version = Number(r.rows[0].version);
      } catch (err) {
        d.failed = err instanceof Error ? err : new Error(String(err));
      }
    });
  },
};

/** Called once the schema is current (app.ts). Null pool → config.ts is back on its file. */
export function useOrgConfig(pool: Pool | null, serverDataDir = ''): void {
  db = pool;
  dataDir = serverDataDir;
  docs.clear();
  config.useBacking(pool ? backing : null);
}
