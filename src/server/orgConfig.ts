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
// Two pods changing settings inside the same second: each write stores only
// what IT changed — `storable(cfg)` diffed against the document `cfg` was loaded
// from, per top-level key and per member inside `starredBy` (diffDoc) — applied
// to the row as it is now, in one transaction (`SELECT … FOR UPDATE`). So one
// member's star never overwrites another pod's format change. Two pods changing
// the SAME top-level key still last-writer-wins on it. ponytail: a NOTIFY on
// write (./jobs/bus.ts) makes the other pods re-read at once.
//
// An org with no row yet and a `config.json` on this pod's disk (an install
// from before this table): the file is the first document, imported once.

import * as fs from 'fs';
import * as path from 'path';
import type { Pool, PoolClient, QueryResult } from 'pg';
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

/** `fn` in one transaction for `org` (the RLS org set), as live/usageStore.ts runs its own. */
async function within<T>(pool: Pool, org: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (!ORG_RE.test(org)) throw new Error('invalid org id');
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    await c.query(`BEGIN; SELECT set_config('ordinate.org', '${org}', true)`); // org passed ORG_RE: it cannot close this literal
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

/** One statement for `org`. `$1` is always the org. */
function sql(pool: Pool, org: string, text: string, params: unknown[] = []): Promise<QueryResult> {
  return within(pool, org, (c) => c.query(text, [org, ...params]));
}

// ── What one write changed ──────────────────────────────────────────────────

/** A write's own change: top-level keys set or gone, and `starredBy` per member (null = gone). `whole`: no base, replace. */
export type Patch = { whole: string } | { set: Record<string, unknown>; gone: string[]; starredBy: Record<string, unknown> };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
// Null-prototype: a member key is an email, and `__proto__` must stay a key, never a prototype.
const dict = (from: Record<string, unknown> = {}): Record<string, unknown> => Object.assign(Object.create(null) as Record<string, unknown>, from);

/** `body` against the `base` it was made from. Both are `config.storable` documents. */
export function diffDoc(base: string | undefined, body: string): Patch {
  if (base === undefined) return { whole: body };
  const a = obj(JSON.parse(base));
  const b = obj(JSON.parse(body));
  const patch = { set: dict(), gone: [] as string[], starredBy: dict() };
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'starredBy') {
      const [x, y] = [obj(a[k]), obj(b[k])];
      for (const m of new Set([...Object.keys(x), ...Object.keys(y)])) if (!same(x[m], y[m])) patch.starredBy[m] = Object.hasOwn(y, m) ? y[m] : null;
    } else if (!same(a[k], b[k])) {
      if (Object.hasOwn(b, k)) patch.set[k] = b[k];
      else patch.gone.push(k);
    }
  }
  return patch;
}

/** The row's document as it is now, with this write's patch on top. */
export function applyPatch(current: string, patch: Patch): string {
  if ('whole' in patch) return patch.whole;
  const next = Object.assign(dict(obj(JSON.parse(current))), patch.set);
  for (const k of patch.gone) delete next[k];
  if (Object.keys(patch.starredBy).length) {
    const sb = dict(obj(next.starredBy));
    for (const [m, v] of Object.entries(patch.starredBy)) {
      if (v === null) delete sb[m];
      else sb[m] = v;
    }
    next.starredBy = sb;
  }
  return JSON.stringify(next);
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
  write(body: string, base?: string): void {
    const pool = db;
    const org = ctx().org.id;
    const d = doc(org);
    d.body = body;
    d.writes += 1;
    if (!pool) return;
    const n = d.writes;
    const patch = diffDoc(base, body);
    d.writing = d.writing.then(async () => {
      try {
        const out = await within(pool, org, async (c) => {
          const made = await c.query('INSERT INTO org_config (org_id, body) VALUES ($1, $2) ON CONFLICT (org_id) DO NOTHING RETURNING version', [org, body]);
          if (made.rows.length) return { body, version: Number(made.rows[0].version) };
          const cur = await c.query('SELECT body FROM org_config WHERE org_id = $1 FOR UPDATE', [org]);
          const now = cur.rows[0].body as string;
          // Nobody else wrote since this document was read: exactly what was asked, byte for byte.
          const merged = now === base ? body : applyPatch(now, patch);
          const up = await c.query('UPDATE org_config SET body = $2, version = version + 1, updated_at = now() WHERE org_id = $1 RETURNING version', [org, merged]);
          return { body: merged, version: Number(up.rows[0].version) };
        });
        d.version = out.version;
        // Only the last queued write adopts the merged body: a later local one is newer still.
        if (d.writes === n && out.body !== d.body) {
          d.body = out.body;
          d.stamp += 1;
        }
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
