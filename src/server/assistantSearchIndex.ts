// The Assistant's search of the Data model at rest (0027_assistant_search.sql): the SQL, and the two moments it changes.
// It follows ⌘K's index (./searchIndex.ts) and the verified one (./verifiedIndex.ts) move for move:
//
//   ON WRITE   recordFs calls onAssistantWrite / onAssistantRangeDelete inside the write's own transaction, under a
//              SHARED advisory lock per (org, project, source), in a SAVEPOINT: if anything fails, the source's marker
//              is dropped instead and the save goes on. A record's parts come in groups (`Part.grp`); only a group
//              whose hash moved is rewritten, so a catalog.json save (one record holding every column doc of the
//              project) rewrites the one dataset it changed, not every column.
//   ON SEARCH  a source with no marker at ASSISTANT_SEARCH_VERSION is rebuilt from its records first, in one
//              transaction under that lock EXCLUSIVE, so no write of that source lands mid-build.
//
// What a record's parts ARE comes from `describe`, registered by src/ipc/assistantSearch.ts (the stores' own parsers:
// this module may not import them, as recordFs imports this one). Without it, a write drops the marker.
//
// SHARED FOLDERS (docs/team-folders D13): every query a caller's answer is made of — words, meaning, spelling, the counts, the
// exact lookups and the newest — keeps only items whose `dataset_id` sits in a folder the caller opens (`RankOptions.open`,
// ./authz/folderSql opensDataset), in its WHERE, before the ranking and the LIMIT. A source table (no dataset) is not
// foldered. `hidingDatasets` is a security walk and sees the whole project (D14).

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { inOrg, orgDb } from './db/inOrg';
import { logger } from '../app/logger';
import { allWords, kindOrd, speltItems } from '../app/assistantSearchRank';
import type { Audience, CountedKind, KeyedItem, KeyedKind, ModelHit, ModelKind, NameRow, Part, RankOptions, SpeltHit } from '../app/assistantSearchRank';
import { MIN_SIMILARITY } from '../app/trigram';
import type { NearTo } from './vectorStore';
import { trgmPlace } from './nameTrigrams';
import { opensDataset } from './authz/folderSql';

/** Bump when what a record describes to changes (the words, the parts): every marker is then stale, and each source rebuilds once. */
export const ASSISTANT_SEARCH_VERSION = 4; // 2: base parts carry their exact-lookup keys (0028); 3: a dataset's hiding keys; 4: each part's text (0030)
const REBUILD_BATCH = 100;
const REBUILD_BYTES = 8 * 1024 * 1024;

export const SOURCES = ['datasets', 'metrics', 'terms', 'catalog', 'tables'] as const;
export type SearchSource = (typeof SOURCES)[number];
export interface SourceAt { projectId: string; source: SearchSource; id: string }

export type DescribeModel = (where: SourceAt, body: string) => Part[];
export type RowsUnder = (c: PoolClient, org: string, rel: string, after: string, limit: number, maxBytes: number) => Promise<Array<{ rel: string; body: string | null }>>;

let describe: DescribeModel | null = null;
export function useModelDescriber(d: DescribeModel | null): void {
  describe = d;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
// The same rule as the 0027 trigger's.
const RECORD = new RegExp(`^projects/(${UUID})/(?:(datasets|metrics|terms)/(${UUID})\\.json|(catalog)\\.json|connections/(${UUID})\\.(tables)\\.json)$`);
const PROJECT_DIR = new RegExp(`^projects/(${UUID})$`);
const WITHIN = new RegExp(`^projects/(${UUID})(?:/|$)`);

/** The source a record path belongs to, or null: not searched. `id` keeps its case (a record's, or a connection's for tables). */
export function sourceAt(rel: string): SourceAt | null {
  const m = RECORD.exec(rel);
  if (!m) return null;
  const projectId = m[1].toLowerCase();
  if (m[2]) return { projectId, source: m[2] as SearchSource, id: m[3] };
  return m[4] ? { projectId, source: 'catalog', id: '' } : { projectId, source: 'tables', id: m[5] };
}

/** Where a source's records are: a directory, or (catalog) one file. Tables are the `.tables.json` among the connections. */
const sourceRel = (projectId: string, s: SearchSource): string =>
  `projects/${projectId}/${s === 'catalog' ? 'catalog.json' : s === 'tables' ? 'connections' : s}`;

const lockKeyOf = (org: string, projectId: string, s: SearchSource): string => `asearch:${org}:${projectId}:${s}`;

let warned = false;
function warnOnce(what: string, err: unknown): void {
  if (warned) return;
  warned = true;
  // A code, never a message: a record's name could ride along in one.
  logger.warn(`[assistant search] ${what} (${String((err as { code?: unknown })?.code ?? 'error')}); the next search rebuilds what it needs. Further failures are not logged.`);
}

async function guarded(c: PoolClient, fn: () => Promise<void>): Promise<boolean> {
  await c.query('SAVEPOINT assistant_ix');
  try {
    await fn();
    await c.query('RELEASE SAVEPOINT assistant_ix');
    return true;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT assistant_ix; RELEASE SAVEPOINT assistant_ix');
    warnOnce('the Assistant search index could not follow a write', err);
    return false;
  }
}

/** A record's parts by group, each with the hash of what it holds. */
function groupsOf(parts: readonly Part[]): Map<string, { hash: string; parts: Part[] }> {
  const by = new Map<string, Part[]>();
  for (const p of parts) by.set(p.grp, [...(by.get(p.grp) ?? []), p]);
  return new Map([...by].map(([g, ps]) => [g, { hash: createHash('sha256').update(JSON.stringify(ps)).digest('base64url'), parts: ps }]));
}

type Row = Part & { path: string; ord: number; hash: string };
const rowsOf = (path: string, groups: Iterable<{ hash: string; parts: Part[] }>): Row[] =>
  [...groups].flatMap((g) => g.parts.map((p, ord) => ({ ...p, path, ord, hash: g.hash })));

// A word holds letters, marks and digits only (../ai/modelWords), never a space: joined and split back in SQL. So does a key (base64url, or `d:` and an id).
const joined = (ws: readonly string[]): string => ws.join(' ');
const ARRAY = (x: string): string => `CASE WHEN ${x} = '' THEN '{}'::text[] ELSE string_to_array(${x}, ' ') END`;

async function insertRows(c: PoolClient, org: string, projectId: string, source: SearchSource, rows: readonly Row[]): Promise<void> {
  if (!rows.length) return;
  await c.query(
    `INSERT INTO assistant_search (org_id, project_id, source, path, grp, ord, grp_hash, item, kind, kind_ord, base, id, dataset_id, conn_id, name, updated,
       audience, name_words, alias_words, text_words, all_words, certified, retired, keys, text)
     SELECT $1, $2, $3, u.path, u.grp, u.ord, u.hash, u.item, u.kind, u.kind_ord, u.base, u.id, u.dataset_id, u.conn_id, u.name, u.updated, u.audience,
       ${ARRAY('u.nw')}, ${ARRAY('u.aw')}, ${ARRAY('u.tw')}, ${ARRAY('u.allw')}, u.certified, u.retired, ${ARRAY('u.ks')}, u.text
     FROM unnest($4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::text[], $10::int[], $11::bool[], $12::text[], $13::text[], $14::text[],
       $15::text[], $16::text[], $17::text[], $18::text[], $19::text[], $20::text[], $21::text[], $22::bool[], $23::bool[], $24::text[], $25::text[])
       AS u(path, grp, ord, hash, item, kind, kind_ord, base, id, dataset_id, conn_id, name, updated, audience, nw, aw, tw, allw, certified, retired, ks, text)`,
    [
      org, projectId, source, rows.map((r) => r.path), rows.map((r) => r.grp), rows.map((r) => r.ord), rows.map((r) => r.hash), rows.map((r) => r.item),
      rows.map((r) => r.kind), rows.map((r) => kindOrd(r.kind)), rows.map((r) => r.base), rows.map((r) => r.id), rows.map((r) => r.datasetId),
      rows.map((r) => r.connId), rows.map((r) => r.name), rows.map((r) => r.updated), rows.map((r) => r.audience), rows.map((r) => joined(r.nameWords)),
      rows.map((r) => joined(r.aliasWords)), rows.map((r) => joined(r.textWords)), rows.map((r) => joined(allWords(r))), rows.map((r) => r.certified),
      rows.map((r) => r.retired), rows.map((r) => joined(r.keys)), rows.map((r) => r.text),
    ],
  );
}

const lockShared = (c: PoolClient, org: string, projectId: string, sources: readonly SearchSource[]) =>
  c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended(k, 0)) FROM unnest($1::text[]) AS k', [sources.map((s) => lockKeyOf(org, projectId, s))]);
const dropMarkers = (c: PoolClient, org: string, projectId: string, sources: readonly SearchSource[] = SOURCES) =>
  c.query('DELETE FROM assistant_search_built WHERE org_id = $1 AND project_id = $2 AND source = ANY($3::text[])', [org, projectId, sources]);
/** After a failed write: the markers dropped under the lock again (the rollback to the savepoint released it). */
const dropLocked = async (c: PoolClient, org: string, projectId: string, sources: readonly SearchSource[] = SOURCES): Promise<void> => {
  await lockShared(c, org, projectId, sources);
  await dropMarkers(c, org, projectId, sources);
};

/** A record at `rel` was written (`body`) or removed (null), in transaction `c`. Never throws but on a dead connection. */
export async function onAssistantWrite(c: PoolClient, org: string, rel: string, body: string | null): Promise<void> {
  const at = sourceAt(rel);
  if (!at) return;
  const d = describe;
  const held = await guarded(c, async () => {
    await lockShared(c, org, at.projectId, [at.source]);
    if (!d) {
      await c.query('DELETE FROM assistant_search WHERE org_id = $1 AND path = $2', [org, rel]);
      await dropMarkers(c, org, at.projectId, [at.source]); // a script without the stores: rebuilt on the next search
      return;
    }
    const fresh = groupsOf(body === null ? [] : d(at, body));
    const stored = await c.query('SELECT DISTINCT grp, grp_hash FROM assistant_search WHERE org_id = $1 AND path = $2', [org, rel]);
    const had = new Map((stored.rows as Array<{ grp: string; grp_hash: string }>).map((r) => [r.grp, r.grp_hash]));
    const stale = [...had].filter(([g, h]) => fresh.get(g)?.hash !== h).map(([g]) => g);
    if (stale.length) await c.query('DELETE FROM assistant_search WHERE org_id = $1 AND path = $2 AND grp = ANY($3::text[])', [org, rel, stale]);
    await insertRows(c, org, at.projectId, at.source, rowsOf(rel, [...fresh].filter(([g, f]) => had.get(g) !== f.hash).map(([, f]) => f)));
  });
  if (!held) await guarded(c, () => dropLocked(c, org, at.projectId, [at.source]));
}

/** Every record under directory `rel` was removed, in transaction `c`: their rows go, and a whole project's markers. */
export async function onAssistantRangeDelete(c: PoolClient, org: string, rel: string): Promise<void> {
  const above = rel === '' || rel === 'projects';
  const project = WITHIN.exec(rel)?.[1].toLowerCase() ?? null;
  if (!project && !above) return; // outside every project: nothing searched lives there
  const [lo, hi] = rel ? [rel + '/', rel + '0'] : ['', '\u{10FFFF}'];
  const forget = async (): Promise<void> => {
    if (above) await c.query('DELETE FROM assistant_search_built WHERE org_id = $1', [org]);
    else if (PROJECT_DIR.test(rel)) await dropMarkers(c, org, project as string);
  };
  const held = await guarded(c, async () => {
    if (project) await lockShared(c, org, project, SOURCES);
    await c.query('DELETE FROM assistant_search WHERE org_id = $1 AND path >= $2 AND path < $3', [org, lo, hi]);
    await forget();
  });
  if (!held) await guarded(c, () => (project ? dropLocked(c, org, project) : forget()));
}

/** Rebuild one source of `projectId` from its records (read by `rowsUnder`, recordFs's), then mark it built. */
async function rebuild(c: PoolClient, org: string, projectId: string, source: SearchSource, rowsUnder: RowsUnder): Promise<void> {
  const d = describe;
  if (!d) throw new Error('assistant search index: no describer registered');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKeyOf(org, projectId, source)]);
  const done = await c.query('SELECT 1 FROM assistant_search_built WHERE org_id = $1 AND project_id = $2 AND source = $3 AND version = $4', [org, projectId, source, ASSISTANT_SEARCH_VERSION]);
  if (done.rowCount) return; // another pod built it while this one waited for the lock
  await c.query('DELETE FROM assistant_search WHERE org_id = $1 AND project_id = $2 AND source = $3', [org, projectId, source]);
  for (let after = ''; ;) {
    const batch = await rowsUnder(c, org, sourceRel(projectId, source), after, REBUILD_BATCH, REBUILD_BYTES);
    if (!batch.length) break;
    const rows: Row[] = [];
    for (const b of batch) {
      const at = sourceAt(b.rel);
      if (b.body !== null && at && at.projectId === projectId && at.source === source) rows.push(...rowsOf(b.rel, groupsOf(d(at, b.body)).values()));
    }
    await insertRows(c, org, projectId, source, rows);
    after = batch[batch.length - 1].rel;
  }
  await c.query(
    `INSERT INTO assistant_search_built (org_id, project_id, source, version) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, project_id, source) DO UPDATE SET version = EXCLUDED.version, built_at = now()`,
    [org, projectId, source, ASSISTANT_SEARCH_VERSION],
  );
}

/** `fn` over a complete index of `projectId`, rebuilding what is missing first. Null without a database. */
async function built<T>(projectId: string, rowsUnder: RowsUnder, fn: (c: PoolClient, org: string) => Promise<T>): Promise<T | null> {
  if (!orgDb()) return null;
  // The markers are checked in the query's own transaction: a built index costs one round trip more than the query.
  const attempt = () => inOrg(async (c, org): Promise<{ missing: SearchSource[] } | { value: T }> => {
    const r = await c.query('SELECT source FROM assistant_search_built WHERE org_id = $1 AND project_id = $2 AND version = $3', [org, projectId, ASSISTANT_SEARCH_VERSION]);
    const have = new Set((r.rows as Array<{ source: string }>).map((x) => x.source));
    const missing = SOURCES.filter((s) => !have.has(s));
    return missing.length ? { missing } : { value: await fn(c, org) };
  });
  const first = await attempt();
  if ('value' in first) return first.value;
  for (const s of first.missing) await inOrg((c, org) => rebuild(c, org, projectId, s, rowsUnder));
  const again = await attempt();
  if ('value' in again) return again.value;
  throw Object.assign(new Error('assistant search index: a marker was dropped again while it was built'), { code: 'ESTALE' }); // the reference answers
}

// One part's score, the SQL of ../app/assistantSearchRank partScore: each asked word (deduplicated) counted once per field it is in.
const SCORE = `SELECT 4 * count(*) FILTER (WHERE a = ANY(p.name_words)) + 2 * count(*) FILTER (WHERE a = ANY(p.alias_words))
  + count(*) FILTER (WHERE a = ANY(p.text_words)) AS score FROM unnest($3::text[]) AS a`;

// An item's result from its parts (../app/assistantSearchRank hitOf): its base part's fields, every part's score.
const HIT = `min(p.kind) FILTER (WHERE p.base) AS kind, min(p.id) FILTER (WHERE p.base) AS id,
  min(p.dataset_id) FILTER (WHERE p.base) AS dataset_id, min(p.conn_id) FILTER (WHERE p.base) AS conn_id,
  min(p.name) FILTER (WHERE p.base) AS name, sum(s.score)::int AS score`;
type HitRow = { kind: ModelKind; id: string; dataset_id: string | null; conn_id: string | null; name: string; score: number };
const hitOf = (x: HitRow): ModelHit => ({
  kind: x.kind, id: x.id, ...(x.dataset_id !== null ? { datasetId: x.dataset_id } : {}), ...(x.conn_id !== null ? { connId: x.conn_id } : {}), name: x.name, score: x.score,
});

/** `limit` items after `offset`, in ../app/assistantSearchRank rankParts order, for `asked` (deduplicated words). Null without a database. */
export function rankedPage(projectId: string, asked: readonly string[], o: RankOptions, offset: number, limit: number, rowsUnder: RowsUnder): Promise<ModelHit[] | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `SELECT p.item, ${HIT}, bool_or(p.certified) AS certified,
         min(p.kind_ord) FILTER (WHERE p.base) AS kind_ord, max(p.updated) FILTER (WHERE p.base) AS updated
       FROM assistant_search p CROSS JOIN LATERAL (${SCORE}) s
       WHERE p.org_id = $1 AND p.project_id = $2 AND p.item = ANY(ARRAY(
         SELECT DISTINCT item FROM assistant_search
         WHERE org_id = $1 AND project_id = $2 AND all_words && $3::text[] AND audience = ANY($4::text[])
           AND ($5::text[] IS NULL OR kind = ANY($5::text[])) AND ($6::text[] IS NULL OR dataset_id = ANY($6::text[]))
           AND ($9::text[] IS NULL OR dataset_id IS NULL OR dataset_id <> ALL($9::text[]))
           AND ${opensDataset('assistant_search.dataset_id', '$10', 'assistant_search.org_id', 'assistant_search.project_id')}))
       GROUP BY p.item
       HAVING bool_or(p.base AND p.audience = ANY($4::text[])) AND NOT bool_or(p.retired)
       ORDER BY score DESC, certified DESC, kind_ord, updated DESC, p.item
       LIMIT $7 OFFSET $8`,
      [org, projectId, asked, o.audiences, o.kinds ?? null, o.datasetIds ?? null, limit, offset, o.exceptDatasetIds ?? null, o.open ?? null],
    );
    return (r.rows as HitRow[]).map(hitOf);
  });
}

/**
 * The `k` items whose fingerprint (`to.model`'s, 0029) is nearest the question's by cosine, no farther than
 * `to.maxDistance`, that the caller may find under `o` — a base part of an allowed kind, dataset and audience (the words
 * query's WHERE), none retired — nearest first, then by key, each scored by its words for `asked`:
 * ../app/assistantSearchRank nearItems. Null without a database.
 *
 * EXACT, within the project: every allowed item's distance is computed in a MATERIALIZED CTE, so the planner never
 * takes the HNSW index. Filtered by org, project, model and access, that index's scan stopped before any row passed
 * and returned NONE (measured on the budget's project, pgvector 0.8.7, iterative scan on). The allowed items are an
 * array built once (as the words query's), so a fresh table with no statistics plans the same.
 * shortcut: linear in the project's fingerprints (23 ms for 8,000 candidates at 768 numbers); upgrade to an index
 * per project (or pgvector's filtered scans, when they return what the filter needs) past ~50,000 items a project.
 */
export function nearestPage(projectId: string, asked: readonly string[], o: RankOptions, to: NearTo, k: number, rowsUnder: RowsUnder): Promise<ModelHit[] | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `WITH d AS MATERIALIZED (
         SELECT v.item, v.embedding ${to.place.op} $7::${to.place.type} AS d FROM assistant_search_vectors v
         WHERE v.org_id = $1 AND v.project_id = $2 AND v.model = $8
           AND v.item = ANY(ARRAY(SELECT b.item FROM assistant_search b WHERE b.org_id = $1 AND b.project_id = $2 AND b.base AND b.audience = ANY($4::text[])
             AND ($5::text[] IS NULL OR b.kind = ANY($5::text[])) AND ($6::text[] IS NULL OR b.dataset_id = ANY($6::text[]))
             AND ($10::text[] IS NULL OR b.dataset_id IS NULL OR b.dataset_id <> ALL($10::text[]))
             AND ${opensDataset('b.dataset_id', '$12', 'b.org_id', 'b.project_id')}))
           AND v.item <> ALL(ARRAY(SELECT x.item FROM assistant_search x WHERE x.org_id = $1 AND x.project_id = $2 AND x.retired))),
       near AS MATERIALIZED (SELECT item, d FROM d WHERE d <= $11 ORDER BY d, item LIMIT $9)
       SELECT h.*, n.d FROM (
         SELECT p.item, ${HIT} FROM assistant_search p CROSS JOIN LATERAL (${SCORE}) s
         WHERE p.org_id = $1 AND p.project_id = $2 AND p.item = ANY(ARRAY(SELECT item FROM near))
         GROUP BY p.item) h
       JOIN near n ON n.item = h.item
       ORDER BY n.d, h.item`,
      [org, projectId, asked, o.audiences, o.kinds ?? null, o.datasetIds ?? null, to.literal, to.model, k, o.exceptDatasetIds ?? null, to.maxDistance, o.open ?? null],
    );
    return (r.rows as HitRow[]).map(hitOf);
  });
}

// The base parts the caller may find under `o`, none of an item a part retires: ../app/assistantSearchRank findableBases.
// In the folders the caller opens (`open`, the parameter holding `RankOptions.open`): before any similarity order or LIMIT.
const findable = (open: string): string => `b.org_id = $1 AND b.project_id = $2 AND b.base AND b.audience = ANY($3::text[])
  AND ($4::text[] IS NULL OR b.kind = ANY($4::text[])) AND ($5::text[] IS NULL OR b.dataset_id = ANY($5::text[]))
  AND ($6::text[] IS NULL OR b.dataset_id IS NULL OR b.dataset_id <> ALL($6::text[]))
  AND NOT EXISTS (SELECT 1 FROM assistant_search x WHERE x.org_id = $1 AND x.project_id = $2 AND x.item = b.item AND x.retired)
  AND ${opensDataset('b.dataset_id', open, 'b.org_id', 'b.project_id')}`;
type SpeltRow = { kind: ModelKind; id: string; dataset_id: string | null; conn_id: string | null; name: string; similarity: number };

/**
 * The `limit` items whose name is spelled nearest `said` (../app/assistantSearchRank speltItems), that the caller may
 * find under `o`. ONE query: on pg_trgm (0031: `%` at MIN_SIMILARITY, set just before it, by its GIN index) where this
 * database has one that agrees with the reference (./nameTrigrams); else the names it may find, ranked by the reference.
 * shortcut: without pg_trgm, linear in the project's findable names; fine for a miss, the only caller.
 * Null without a database.
 */
export async function speltPage(projectId: string, said: string, o: RankOptions, limit: number, rowsUnder: RowsUnder): Promise<SpeltHit[] | null> {
  const trgm = await trgmPlace();
  return built(projectId, rowsUnder, async (c, org) => {
    const args = [org, projectId, o.audiences, o.kinds ?? null, o.datasetIds ?? null, o.exceptDatasetIds ?? null];
    if (!trgm) {
      const r = await c.query(`SELECT b.item, b.kind, b.id, b.dataset_id AS "datasetId", b.conn_id AS "connId", b.name FROM assistant_search b WHERE ${findable('$7')}`, [...args, o.open ?? null]);
      return speltItems(r.rows as NameRow[], said, limit);
    }
    await c.query(`SELECT set_config('pg_trgm.similarity_threshold', $1, true)`, [String(MIN_SIMILARITY)]); // `%`'s, whatever the server's default
    const r = await c.query(
      `SELECT b.item, min(b.kind) AS kind, min(b.id) AS id, min(b.dataset_id) AS dataset_id, min(b.conn_id) AS conn_id, min(b.name) AS name,
         max(${trgm.similarity}(b.name, $7))::float8 AS similarity
       FROM assistant_search b WHERE ${findable('$9')} AND b.name ${trgm.op} $7
       GROUP BY b.item ORDER BY similarity DESC, name, b.item LIMIT $8`,
      [...args, said, limit, o.open ?? null],
    );
    return (r.rows as SpeltRow[]).map((x) => ({
      kind: x.kind, id: x.id, ...(x.dataset_id !== null ? { datasetId: x.dataset_id } : {}), ...(x.conn_id !== null ? { connId: x.conn_id } : {}), name: x.name, similarity: x.similarity,
    }));
  });
}

/** Every item but the columns that `audiences` may find in the folders `open` they open, as kind and id: ../app/assistantSearchRank foundItems (unordered). Null without a database. */
export function foundItems(projectId: string, audiences: readonly Audience[], rowsUnder: RowsUnder, open: readonly string[] | null = null): Promise<Array<{ kind: CountedKind; id: string }> | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `SELECT min(kind) FILTER (WHERE base) AS kind, min(id) FILTER (WHERE base) AS id FROM assistant_search
       WHERE org_id = $1 AND project_id = $2 AND kind <> 'column' AND ${opensDataset('assistant_search.dataset_id', '$4', 'assistant_search.org_id', 'assistant_search.project_id')}
       GROUP BY item HAVING bool_or(base AND audience = ANY($3::text[])) AND NOT bool_or(retired)`,
      [org, projectId, audiences, open],
    );
    return r.rows as Array<{ kind: CountedKind; id: string }>;
  });
}

/** Each item of `kind` in the folders `open` whose base part holds one of `keys` (0028), by item key: ../app/assistantSearchRank keyedItems. Null without a database. */
export function keyedItems(projectId: string, kind: KeyedKind, keys: readonly string[], rowsUnder: RowsUnder, open: readonly string[] | null = null): Promise<KeyedItem[] | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `SELECT id, dataset_id FROM assistant_search WHERE org_id = $1 AND project_id = $2 AND base AND kind = $3 AND keys && $4::text[]
         AND ${opensDataset('assistant_search.dataset_id', '$5', 'assistant_search.org_id', 'assistant_search.project_id')} ORDER BY item`,
      [org, projectId, kind, keys, open],
    );
    return (r.rows as Array<{ id: string; dataset_id: string | null }>).map((x) => ({ id: x.id, datasetId: x.dataset_id }));
  });
}

/** A dataset base part's hiding keys (../ipc/assistantSearch hidingKeys): the record holds column rules (any `columnAccess`), or another id's. */
export const RULED_KEY = 'col:rules';
/** Written by a release that writes the hiding keys: a dataset part without it (an older pod's write) is a candidate itself. */
export const KNOWN_KEY = 'col:known';
/** A dataset the record is built from (../data/upstream parentsOfRecord): its rows carry what that one hides. */
export const upKey = (id: string): string => `up:${id}`;

/**
 * The datasets whose hidden columns can be non-empty for anyone (../data/rowAccess hiddenAnywhere reads only these), by
 * the hiding keys of their base parts (../ipc/assistantSearch hidingKeys). hiddenColumnsFor is non-empty only for a
 * dataset with column rules, one built from a dataset that hides a column (or that cannot be read), or one whose walk
 * upstream runs past `depth` (../data/columnGate upstreamHides). So, a superset of those: every dataset marked ruled or
 * written without these keys, every one built from a dataset the index does not hold (gone, in the Trash, unreadable,
 * an id written in another case), everything built from those at any depth, and every one with a chain of more than
 * `depth` parents above it. Null without a database.
 */
export function hidingDatasets(projectId: string, depth: number, rowsUnder: RowsUnder): Promise<string[] | null> {
  const UP = upKey('');
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `WITH RECURSIVE
         ds AS MATERIALIZED (SELECT id, keys FROM assistant_search WHERE org_id = $1 AND project_id = $2 AND base AND kind = 'dataset'),
         edge AS MATERIALIZED (SELECT d.id AS child, substr(k, ${UP.length + 1}) AS parent FROM ds d CROSS JOIN LATERAL unnest(d.keys) AS k WHERE k LIKE '${UP}%'),
         down (id) AS (
           SELECT id FROM ds WHERE $3 = ANY(keys) OR NOT ($4 = ANY(keys))
           UNION SELECT e.child FROM edge e WHERE NOT EXISTS (SELECT 1 FROM ds WHERE ds.id = e.parent)
           UNION SELECT e.child FROM down JOIN edge e ON e.parent = down.id),
         tall (id, n) AS (
           SELECT child, 1 FROM edge
           UNION SELECT e.child, t.n + 1 FROM tall t JOIN edge e ON e.parent = t.id WHERE t.n <= $5)
       SELECT id FROM down UNION SELECT id FROM tall WHERE n > $5`,
      [org, projectId, RULED_KEY, KNOWN_KEY, depth],
    );
    return (r.rows as Array<{ id: string }>).map((x) => x.id);
  });
}

/** The `limit` newest items of `kind` in the folders `open`, then by item key, retired left out unless `retired`: ../app/assistantSearchRank newestItems. Null without a database. */
export function newestItems(projectId: string, kind: KeyedKind, limit: number, retired: boolean, rowsUnder: RowsUnder, open: readonly string[] | null = null): Promise<KeyedItem[] | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `SELECT p.id, p.dataset_id FROM assistant_search p WHERE p.org_id = $1 AND p.project_id = $2 AND p.base AND p.kind = $3
         AND ($5 OR NOT EXISTS (SELECT 1 FROM assistant_search x WHERE x.org_id = $1 AND x.project_id = $2 AND x.item = p.item AND x.retired))
         AND ${opensDataset('p.dataset_id', '$6', 'p.org_id', 'p.project_id')}
       ORDER BY p.updated DESC, p.item LIMIT $4`,
      [org, projectId, kind, limit, retired, open],
    );
    return (r.rows as Array<{ id: string; dataset_id: string | null }>).map((x) => ({ id: x.id, datasetId: x.dataset_id }));
  });
}
