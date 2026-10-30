// The ⌘K name search's index at rest (0022_search_index.sql): the SQL, and the two moments it changes.
//
//   ON WRITE   recordFs calls onRecordWrite / onRangeDelete inside the write's own transaction. A
//              searched record's rows are replaced there, under a SHARED advisory lock per
//              (org, project, source), in a SAVEPOINT: if anything fails, the source's marker is
//              dropped instead and the save goes on — the index can never fail a save.
//   ON SEARCH  a source with no marker at INDEX_VERSION is rebuilt from the records first, in one
//              transaction under that lock EXCLUSIVE, so no write of that source lands mid-build
//              (writers wait; their own rows are written after it, and win).
//
// What a record's rows ARE comes from `describe`, registered by src/ipc/search.ts (the stores'
// own parsers — this module may not import them: recordFs imports this one). Without it, a write
// drops the marker, and the next search that has one rebuilds.

import type { PoolClient } from 'pg';
import { inOrg, orgDb } from './db/inOrg';
import { SOURCES, isAboveProjects, sourceOf, sourceRel, projectIn, projectOfDir } from '../app/searchSources';
import type { RecordSource, SourceKey } from '../app/searchSources';
import { tsqueryOf, wordsOf } from '../app/searchMatch';
import { logger } from '../app/logger';

/** Bump when what a record describes to changes: every marker is then stale, and each source rebuilds once. */
export const INDEX_VERSION = 1;
/** Records read per statement while rebuilding, by count and by bytes: a v2 dataset holds its rows (up to 8 MiB),
 *  so 100 of those would be ~800 MiB in this process, parsed in one loop without yielding. */
const REBUILD_BATCH = 100;
const REBUILD_BYTES = 8 * 1024 * 1024;

export type Audience = 'all' | 'editor' | 'viewer';

/** One row a record contributes: a record, a dashboard's saved view, or one alert rule. */
export interface IndexRow {
  audience: Audience;
  /** Its place in the record: a dashboard 0, its views after; the rules of alerts.json in order. */
  ord: number;
  /** The record's id — the order's tie-break. */
  rec: string;
  updated: string;
  kind: string;
  id: string;
  parentId?: string;
  name: string;
  sub: string;
}

export type Describe = (where: RecordSource, body: string) => IndexRow[];
/** A null body: a record past its limits, skipped but paged past. */
export type RowsUnder = (c: PoolClient, org: string, rel: string, after: string, limit: number, maxBytes: number) => Promise<Array<{ rel: string; body: string | null }>>;

let describe: Describe | null = null;
/** src/ipc/search.ts registers the stores' parsers; null puts writes back to dropping markers. */
export function useDescriber(d: Describe | null): void {
  describe = d;
}

const lockKeyOf = (org: string, projectId: string, source: SourceKey): string => `search:${org}:${projectId}:${source}`;

let warned = false;
function warnOnce(what: string, err: unknown): void {
  if (warned) return;
  warned = true;
  // A code, never a message: a record's name could ride along in one.
  logger.warn(`[search] ${what} (${String((err as { code?: unknown })?.code ?? 'error')}); the next search rebuilds what it needs. Further failures are not logged.`);
}

/** `fn` in a savepoint: true when it held, false when it was rolled back (the transaction goes on). */
async function guarded(c: PoolClient, fn: () => Promise<void>): Promise<boolean> {
  await c.query('SAVEPOINT search_ix');
  try {
    await fn();
    await c.query('RELEASE SAVEPOINT search_ix');
    return true;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT search_ix; RELEASE SAVEPOINT search_ix');
    warnOnce('the search index could not follow a write', err);
    return false;
  }
}

async function insertRows(c: PoolClient, org: string, projectId: string, srcOrd: number, rows: ReadonlyArray<IndexRow & { path: string }>): Promise<void> {
  if (!rows.length) return;
  await c.query(
    `INSERT INTO search_entries (org_id, project_id, path, audience, ord, src_ord, rec, kind, id, parent_id, name, name_lc, words, updated, sub)
     SELECT $1, $2, u.path, u.audience, u.ord, $3, u.rec, u.kind, u.id, u.parent_id, u.name, u.name_lc, array_to_tsvector(string_to_array(u.words, ' ')), u.updated, u.sub
     FROM unnest($4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[])
       AS u(path, audience, ord, rec, kind, id, parent_id, name, name_lc, words, updated, sub)`,
    [
      org, projectId, srcOrd,
      rows.map((r) => r.path), rows.map((r) => r.audience), rows.map((r) => r.ord), rows.map((r) => r.rec), rows.map((r) => r.kind),
      rows.map((r) => r.id), rows.map((r) => r.parentId ?? null), rows.map((r) => r.name), rows.map((r) => r.name.toLowerCase()),
      rows.map((r) => wordsOf(r.name).join(' ')), rows.map((r) => r.updated), rows.map((r) => r.sub),
    ],
  );
}

const dropMarkers = (c: PoolClient, org: string, projectId: string, sources: readonly SourceKey[] = SOURCES) =>
  c.query('DELETE FROM search_sources WHERE org_id = $1 AND project_id = $2 AND source = ANY($3::text[])', [org, projectId, sources]);

/** A writer's hold on its sources until the transaction ends, so no rebuild reads them mid-write. */
const lockShared = (c: PoolClient, org: string, projectId: string, sources: readonly SourceKey[]) =>
  c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended(k, 0)) FROM unnest($1::text[]) AS k', [sources.map((s) => lockKeyOf(org, projectId, s))]);

/** After a failed write: drop the markers under the lock again. The rollback to the savepoint released it, and a
 *  rebuild that slipped in unlocked could commit its marker after this drop, over rows that miss this write. */
const dropLocked = async (c: PoolClient, org: string, projectId: string, sources: readonly SourceKey[] = SOURCES): Promise<void> => {
  await lockShared(c, org, projectId, sources);
  await dropMarkers(c, org, projectId, sources);
};

/** A record at `rel` was written (`body`) or removed (null), in transaction `c`. Never throws but on a dead connection. */
export async function onRecordWrite(c: PoolClient, org: string, rel: string, body: string | null): Promise<void> {
  const where = sourceOf(rel);
  if (!where) return;
  const d = describe;
  const held = await guarded(c, async () => {
    await lockShared(c, org, where.projectId, [where.source]);
    await c.query('DELETE FROM search_entries WHERE org_id = $1 AND path = $2', [org, rel]);
    if (!d) {
      await dropMarkers(c, org, where.projectId, [where.source]); // a script without the stores: rebuilt on the next search
      return;
    }
    if (body !== null) await insertRows(c, org, where.projectId, where.srcOrd, d(where, body).map((r) => ({ ...r, path: rel })));
  });
  if (!held) await guarded(c, () => dropLocked(c, org, where.projectId, [where.source]));
}

/** Every record under directory `rel` was removed, in transaction `c`: their rows go, and a whole project's markers. */
export async function onRangeDelete(c: PoolClient, org: string, rel: string): Promise<void> {
  const project = projectIn(rel);
  const above = isAboveProjects(rel);
  if (!project && !above) return; // outside every project: nothing searched lives there
  const [lo, hi] = rel ? [rel + '/', rel + '0'] : ['', '\u{10FFFF}'];
  const forget = async (): Promise<void> => {
    if (above) await c.query('DELETE FROM search_sources WHERE org_id = $1', [org]);
    else if (projectOfDir(rel)) await dropMarkers(c, org, project as string);
  };
  const held = await guarded(c, async () => {
    if (project) await lockShared(c, org, project, SOURCES);
    await c.query('DELETE FROM search_entries WHERE org_id = $1 AND path >= $2 AND path < $3', [org, lo, hi]);
    await forget();
  });
  if (!held) await guarded(c, () => (project ? dropLocked(c, org, project) : forget()));
}

/** The sources of `projectId` the index does not hold completely; null without a database. */
export async function unbuilt(projectId: string): Promise<SourceKey[] | null> {
  if (!orgDb()) return null;
  return inOrg(async (c, org) => {
    const r = await c.query('SELECT source FROM search_sources WHERE org_id = $1 AND project_id = $2 AND version = $3', [org, projectId, INDEX_VERSION]);
    const built = new Set(r.rows.map((x: { source: string }) => x.source));
    return SOURCES.filter((s) => !built.has(s));
  });
}

/** Rebuild one source from its records (read by `rowsUnder`, recordFs's), then mark it built. */
export async function rebuild(projectId: string, source: SourceKey, rowsUnder: RowsUnder): Promise<void> {
  const d = describe;
  if (!d) throw new Error('search index: no describer registered');
  const srcOrd = SOURCES.indexOf(source);
  await inOrg(async (c, org) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKeyOf(org, projectId, source)]);
    const done = await c.query('SELECT 1 FROM search_sources WHERE org_id = $1 AND project_id = $2 AND source = $3 AND version = $4', [org, projectId, source, INDEX_VERSION]);
    if (done.rowCount) return; // another pod built it while this one waited for the lock
    await c.query('DELETE FROM search_entries WHERE org_id = $1 AND project_id = $2 AND src_ord = $3', [org, projectId, srcOrd]);
    for (let after = ''; ;) {
      const batch = await rowsUnder(c, org, sourceRel(projectId, source), after, REBUILD_BATCH, REBUILD_BYTES);
      if (!batch.length) break;
      const rows: Array<IndexRow & { path: string }> = [];
      for (const b of batch) {
        if (b.body === null) continue; // past its limits: skipped, but `after` still moves past it
        const where = sourceOf(b.rel);
        if (where && where.projectId === projectId && where.source === source) for (const r of d(where, b.body)) rows.push({ ...r, path: b.rel });
      }
      await insertRows(c, org, projectId, srcOrd, rows);
      after = batch[batch.length - 1].rel;
    }
    await c.query(
      `INSERT INTO search_sources (org_id, project_id, source, version) VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, project_id, source) DO UPDATE SET version = EXCLUDED.version, built_at = now()`,
      [org, projectId, source, INDEX_VERSION],
    );
  });
}

/**
 * The rows of `projectId` an `audiences` caller may see whose words start with every one of `typed`,
 * best first (src/app/searchMatch.ts: rank, newest, section, record, place). Null without a database.
 */
export async function query(projectId: string, typed: readonly string[], needle: string, audiences: readonly Audience[], limit: number): Promise<Array<Pick<IndexRow, 'kind' | 'id' | 'parentId' | 'name' | 'sub'>> | null> {
  if (!orgDb()) return null;
  return inOrg(async (c, org) => {
    const r = await c.query(
      `SELECT kind, id, parent_id, name, sub FROM search_entries
       WHERE org_id = $1 AND project_id = $2 AND audience = ANY($3::text[]) AND words @@ $4::tsquery
       ORDER BY CASE WHEN name_lc = $5 THEN 0 WHEN starts_with(name_lc, $5) THEN 1 ELSE 2 END, updated DESC, src_ord, rec, ord
       LIMIT $6`,
      [org, projectId, audiences, tsqueryOf(typed), needle, limit],
    );
    return r.rows.map((x: { kind: string; id: string; parent_id: string | null; name: string; sub: string }) => ({
      kind: x.kind, id: x.id, ...(x.parent_id ? { parentId: x.parent_id } : {}), name: x.name, sub: x.sub,
    }));
  });
}
