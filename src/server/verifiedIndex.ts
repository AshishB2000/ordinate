// The verified-question lookup at rest (0026_verified_index.sql): the SQL, and the two moments it changes.
// It follows ⌘K's index (./searchIndex.ts) move for move:
//
//   ON WRITE   recordFs calls onVerifiedWrite / onVerifiedRangeDelete inside the write's own transaction. A
//              question's rows are replaced there, under a SHARED advisory lock per (org, project), in a
//              SAVEPOINT: if anything fails, the project's marker is dropped instead and the save goes on.
//   ON ASK     a project with no marker at VERIFIED_INDEX_VERSION is rebuilt from its records first, in one
//              transaction under that lock EXCLUSIVE, so no write lands mid-build.
//
// What a record's rows ARE comes from `describe`, registered by src/ipc/verifiedLookup.ts (the store's own
// parser: this module may not import it, as recordFs imports this one). Without it, a write drops the marker.

import type { PoolClient } from 'pg';
import { inOrg, orgDb } from './db/inOrg';
import { logger } from '../app/logger';
import type { NearTo } from './vectorStore';

/** Bump when what a record describes to changes (`questionKey`, `words`): every marker is then stale, and each project rebuilds once. */
export const VERIFIED_INDEX_VERSION = 2; // 2: ord 0's text, the question as written (0030)
const REBUILD_BATCH = 100;
const REBUILD_BYTES = 8 * 1024 * 1024;

/** One wording of a question: ord 0 the question (with its `words`, and its `text` as written: what is fingerprinted), 1.. its phrasings (neither). */
export interface KeyRow { ord: number; key: string; datasetId: string; updated: string; words: string[]; text: string }
/** The rows of the record at projects/<projectId>/verified/<id>.json; none for a body that is no question of that id. */
export type DescribeVerified = (projectId: string, id: string, body: string) => KeyRow[];
export type RowsUnder = (c: PoolClient, org: string, rel: string, after: string, limit: number, maxBytes: number) => Promise<Array<{ rel: string; body: string | null }>>;

let describe: DescribeVerified | null = null;
export function useVerifiedDescriber(d: DescribeVerified | null): void {
  describe = d;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const RECORD = new RegExp(`^projects/(${UUID})/verified/(${UUID})\\.json$`);
const PROJECT_DIR = new RegExp(`^projects/(${UUID})(?:/verified)?$`);

/** The question a record path is, or null. The id keeps its case: the store requires the file name to be the record's id. */
export function verifiedAt(rel: string): { projectId: string; id: string } | null {
  const m = RECORD.exec(rel);
  return m ? { projectId: m[1].toLowerCase(), id: m[2] } : null;
}

export const verifiedDir = (projectId: string): string => `projects/${projectId}/verified`;
const lockKeyOf = (org: string, projectId: string): string => `verified:${org}:${projectId}`;

let warned = false;
function warnOnce(what: string, err: unknown): void {
  if (warned) return;
  warned = true;
  // A code, never a message: a question's words could ride along in one.
  logger.warn(`[verified] ${what} (${String((err as { code?: unknown })?.code ?? 'error')}); the next ask rebuilds what it needs. Further failures are not logged.`);
}

async function guarded(c: PoolClient, fn: () => Promise<void>): Promise<boolean> {
  await c.query('SAVEPOINT verified_ix');
  try {
    await fn();
    await c.query('RELEASE SAVEPOINT verified_ix');
    return true;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT verified_ix; RELEASE SAVEPOINT verified_ix');
    warnOnce('the verified-question index could not follow a write', err);
    return false;
  }
}

async function insertRows(c: PoolClient, org: string, projectId: string, rows: ReadonlyArray<KeyRow & { id: string }>): Promise<void> {
  if (!rows.length) return;
  await c.query(
    `INSERT INTO verified_keys (org_id, project_id, id, ord, key, dataset_id, updated, words, text)
     SELECT $1, $2, u.id, u.ord, u.key, u.dataset_id, u.updated, CASE WHEN u.words = '' THEN '{}'::text[] ELSE string_to_array(u.words, ' ') END, u.text
     FROM unnest($3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]) AS u(id, ord, key, dataset_id, updated, words, text)`,
    [org, projectId, rows.map((r) => r.id), rows.map((r) => r.ord), rows.map((r) => r.key), rows.map((r) => r.datasetId), rows.map((r) => r.updated),
      rows.map((r) => r.words.join(' ')), rows.map((r) => r.text)], // `words` splits on anything but letters, marks and digits: none holds a space
  );
}

const lockShared = (c: PoolClient, org: string, projectId: string) => c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [lockKeyOf(org, projectId)]);
const dropMarker = (c: PoolClient, org: string, projectId: string) => c.query('DELETE FROM verified_built WHERE org_id = $1 AND project_id = $2', [org, projectId]);

/** The record at `rel` was written (`body`) or removed (null), in transaction `c`. Never throws but on a dead connection. */
export async function onVerifiedWrite(c: PoolClient, org: string, rel: string, body: string | null): Promise<void> {
  const at = verifiedAt(rel);
  if (!at) return;
  const d = describe;
  const held = await guarded(c, async () => {
    await lockShared(c, org, at.projectId);
    await c.query('DELETE FROM verified_keys WHERE org_id = $1 AND project_id = $2 AND id = $3', [org, at.projectId, at.id]);
    if (!d) return void (await dropMarker(c, org, at.projectId)); // a script without the store: rebuilt on the next ask
    if (body !== null) await insertRows(c, org, at.projectId, d(at.projectId, at.id, body).map((r) => ({ ...r, id: at.id })));
  });
  if (!held) await guarded(c, async () => { await lockShared(c, org, at.projectId); await dropMarker(c, org, at.projectId); });
}

/** Every record under directory `rel` was removed, in transaction `c`: a whole project's (or org's) questions go, marker and all. */
export async function onVerifiedRangeDelete(c: PoolClient, org: string, rel: string): Promise<void> {
  const m = PROJECT_DIR.exec(rel);
  if (!m && rel !== '' && rel !== 'projects') return;
  await guarded(c, async () => {
    if (!m) {
      await c.query('DELETE FROM verified_keys WHERE org_id = $1', [org]);
      await c.query('DELETE FROM verified_built WHERE org_id = $1', [org]);
      return;
    }
    const projectId = m[1].toLowerCase();
    await lockShared(c, org, projectId);
    await c.query('DELETE FROM verified_keys WHERE org_id = $1 AND project_id = $2', [org, projectId]);
    await dropMarker(c, org, projectId); // the next ask rebuilds from what is left: nothing, or a restored copy
  });
}

/** Rebuild `projectId` from its records (read by `rowsUnder`, recordFs's) unless it is already built at this version. */
async function rebuild(c: PoolClient, org: string, projectId: string, rowsUnder: RowsUnder): Promise<void> {
  const d = describe;
  if (!d) throw new Error('verified index: no describer registered');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKeyOf(org, projectId)]);
  const done = await c.query('SELECT 1 FROM verified_built WHERE org_id = $1 AND project_id = $2 AND version = $3', [org, projectId, VERIFIED_INDEX_VERSION]);
  if (done.rowCount) return; // another pod built it while this one waited for the lock
  await c.query('DELETE FROM verified_keys WHERE org_id = $1 AND project_id = $2', [org, projectId]);
  for (let after = ''; ;) {
    const batch = await rowsUnder(c, org, verifiedDir(projectId), after, REBUILD_BATCH, REBUILD_BYTES);
    if (!batch.length) break;
    const rows: Array<KeyRow & { id: string }> = [];
    for (const b of batch) {
      const at = verifiedAt(b.rel);
      if (b.body !== null && at && at.projectId === projectId) for (const r of d(projectId, at.id, b.body)) rows.push({ ...r, id: at.id });
    }
    await insertRows(c, org, projectId, rows);
    after = batch[batch.length - 1].rel;
  }
  await c.query(
    `INSERT INTO verified_built (org_id, project_id, version) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, project_id) DO UPDATE SET version = EXCLUDED.version, built_at = now()`,
    [org, projectId, VERIFIED_INDEX_VERSION],
  );
}

/** `fn` over a built index of `projectId`, rebuilding it first when it is not. Null without a database. */
async function built<T>(projectId: string, rowsUnder: RowsUnder, fn: (c: PoolClient, org: string) => Promise<T>): Promise<T | null> {
  if (!orgDb()) return null;
  const ready = await inOrg(async (c, org) =>
    !!(await c.query('SELECT 1 FROM verified_built WHERE org_id = $1 AND project_id = $2 AND version = $3', [org, projectId, VERIFIED_INDEX_VERSION])).rowCount);
  if (!ready) await inOrg((c, org) => rebuild(c, org, projectId, rowsUnder));
  return inOrg(fn);
}

/** The ids of the questions one of whose wordings has `key`, on `datasets` (null = any), newest first: the reference's order. */
export function keyHits(projectId: string, key: string, datasets: readonly string[] | null, rowsUnder: RowsUnder): Promise<string[] | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `SELECT DISTINCT ON (updated, id) id FROM verified_keys
       WHERE org_id = $1 AND project_id = $2 AND key = $3 AND ($4::text[] IS NULL OR dataset_id = ANY($4::text[]))
       ORDER BY updated DESC, id`,
      [org, projectId, key, datasets],
    );
    return r.rows.map((x: { id: string }) => x.id);
  });
}

/** The ids of the questions on `datasetId`, newest first: the reference's order (`listTagged`). */
export function datasetHits(projectId: string, datasetId: string, rowsUnder: RowsUnder): Promise<string[] | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      'SELECT id FROM verified_keys WHERE org_id = $1 AND project_id = $2 AND ord = 0 AND dataset_id = $3 ORDER BY updated DESC, id',
      [org, projectId, datasetId],
    );
    return r.rows.map((x: { id: string }) => x.id);
  });
}

export interface ExampleOrder { asked: readonly string[]; datasetId?: string; first?: readonly string[] }

/**
 * The ids of `projectId`'s questions in ../ai/verifiedPick `exampleOrder`: the context's dataset, an agent's topic,
 * the most words shared with the question (`asked`, deduplicated), the newest, then the id. `limit` after `offset`.
 */
export function rankedIds(projectId: string, o: ExampleOrder, offset: number, limit: number, rowsUnder: RowsUnder): Promise<Ranked[] | null> {
  // shortcut: the shared words are counted for every question of the project (linear, in Postgres: 9.7 ms at 5,000), upgrade to a GIN prefilter on `words` past ~20,000 questions per project.
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `SELECT id, dataset_id FROM verified_keys
       WHERE org_id = $1 AND project_id = $2 AND ord = 0
       ORDER BY CASE WHEN dataset_id = $3 THEN 0 WHEN dataset_id = ANY($4::text[]) THEN 1 ELSE 2 END,
         (SELECT count(*) FROM unnest(words) AS w WHERE w = ANY($5::text[])) DESC, updated DESC, id
       LIMIT $6 OFFSET $7`,
      [org, projectId, o.datasetId ?? null, o.first ?? [], o.asked, limit, offset],
    );
    return r.rows.map((x: { id: string; dataset_id: string }) => ({ id: x.id, datasetId: x.dataset_id }));
  });
}

/** A question as the example rankings return it: its id and the dataset its chart is on. */
export interface Ranked { id: string; datasetId: string }

/** A question's key among the fingerprints (0029's `item`). */
export const verifiedItem = (id: string): string => `verified:${id}`;

/**
 * The `k` questions whose fingerprint (`to.model`'s) is nearest the question's by cosine, no farther than
 * `to.maxDistance`, nearest first, then by key.
 * Null without a database. Exact within the project, as ./assistantSearchIndex nearestPage (and why).
 */
export function nearestIds(projectId: string, to: NearTo, k: number, rowsUnder: RowsUnder): Promise<Ranked[] | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `WITH d AS MATERIALIZED (
         SELECT v.item, v.embedding ${to.place.op} $3::${to.place.type} AS d FROM assistant_search_vectors v
         WHERE v.org_id = $1 AND v.project_id = $2 AND v.model = $4 AND v.item >= 'verified:' AND v.item < 'verified;')
       SELECT k.id, k.dataset_id FROM d JOIN verified_keys k ON k.org_id = $1 AND k.project_id = $2 AND k.id = substr(d.item, 10) AND k.ord = 0
       WHERE d.d <= $6 ORDER BY d.d, d.item LIMIT $5`,
      [org, projectId, to.literal, to.model, k, to.maxDistance],
    );
    return r.rows.map((x: { id: string; dataset_id: string }) => ({ id: x.id, datasetId: x.dataset_id }));
  });
}
