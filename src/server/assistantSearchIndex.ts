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

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { inOrg, orgDb } from './db/inOrg';
import { logger } from '../app/logger';
import { allWords, kindOrd } from '../app/assistantSearchRank';
import type { Audience, CountedKind, KeyedItem, KeyedKind, ModelHit, ModelKind, Part, RankOptions } from '../app/assistantSearchRank';

/** Bump when what a record describes to changes (the words, the parts): every marker is then stale, and each source rebuilds once. */
export const ASSISTANT_SEARCH_VERSION = 2; // 2: base parts carry their exact-lookup keys (0028)
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
       audience, name_words, alias_words, text_words, all_words, certified, retired, keys)
     SELECT $1, $2, $3, u.path, u.grp, u.ord, u.hash, u.item, u.kind, u.kind_ord, u.base, u.id, u.dataset_id, u.conn_id, u.name, u.updated, u.audience,
       ${ARRAY('u.nw')}, ${ARRAY('u.aw')}, ${ARRAY('u.tw')}, ${ARRAY('u.allw')}, u.certified, u.retired, ${ARRAY('u.ks')}
     FROM unnest($4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::text[], $10::int[], $11::bool[], $12::text[], $13::text[], $14::text[],
       $15::text[], $16::text[], $17::text[], $18::text[], $19::text[], $20::text[], $21::text[], $22::bool[], $23::bool[], $24::text[])
       AS u(path, grp, ord, hash, item, kind, kind_ord, base, id, dataset_id, conn_id, name, updated, audience, nw, aw, tw, allw, certified, retired, ks)`,
    [
      org, projectId, source, rows.map((r) => r.path), rows.map((r) => r.grp), rows.map((r) => r.ord), rows.map((r) => r.hash), rows.map((r) => r.item),
      rows.map((r) => r.kind), rows.map((r) => kindOrd(r.kind)), rows.map((r) => r.base), rows.map((r) => r.id), rows.map((r) => r.datasetId),
      rows.map((r) => r.connId), rows.map((r) => r.name), rows.map((r) => r.updated), rows.map((r) => r.audience), rows.map((r) => joined(r.nameWords)),
      rows.map((r) => joined(r.aliasWords)), rows.map((r) => joined(r.textWords)), rows.map((r) => joined(allWords(r))), rows.map((r) => r.certified),
      rows.map((r) => r.retired), rows.map((r) => joined(r.keys)),
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

/** `limit` items after `offset`, in ../app/assistantSearchRank rankParts order, for `asked` (deduplicated words). Null without a database. */
export function rankedPage(projectId: string, asked: readonly string[], o: RankOptions, offset: number, limit: number, rowsUnder: RowsUnder): Promise<ModelHit[] | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `SELECT p.item, min(p.kind) FILTER (WHERE p.base) AS kind, min(p.id) FILTER (WHERE p.base) AS id,
         min(p.dataset_id) FILTER (WHERE p.base) AS dataset_id, min(p.conn_id) FILTER (WHERE p.base) AS conn_id,
         min(p.name) FILTER (WHERE p.base) AS name, sum(s.score)::int AS score, bool_or(p.certified) AS certified,
         min(p.kind_ord) FILTER (WHERE p.base) AS kind_ord, max(p.updated) FILTER (WHERE p.base) AS updated
       FROM assistant_search p CROSS JOIN LATERAL (${SCORE}) s
       WHERE p.org_id = $1 AND p.project_id = $2 AND p.item = ANY(ARRAY(
         SELECT DISTINCT item FROM assistant_search
         WHERE org_id = $1 AND project_id = $2 AND all_words && $3::text[] AND audience = ANY($4::text[])
           AND ($5::text[] IS NULL OR kind = ANY($5::text[])) AND ($6::text[] IS NULL OR dataset_id = ANY($6::text[]))
           AND ($9::text[] IS NULL OR dataset_id IS NULL OR dataset_id <> ALL($9::text[]))))
       GROUP BY p.item
       HAVING bool_or(p.base AND p.audience = ANY($4::text[])) AND NOT bool_or(p.retired)
       ORDER BY score DESC, certified DESC, kind_ord, updated DESC, p.item
       LIMIT $7 OFFSET $8`,
      [org, projectId, asked, o.audiences, o.kinds ?? null, o.datasetIds ?? null, limit, offset, o.exceptDatasetIds ?? null],
    );
    return (r.rows as Array<{ kind: ModelKind; id: string; dataset_id: string | null; conn_id: string | null; name: string; score: number }>).map((x) => ({
      kind: x.kind, id: x.id, ...(x.dataset_id !== null ? { datasetId: x.dataset_id } : {}), ...(x.conn_id !== null ? { connId: x.conn_id } : {}), name: x.name, score: x.score,
    }));
  });
}

/** Every item but the columns that `audiences` may find, as kind and id: ../app/assistantSearchRank foundItems (unordered). Null without a database. */
export function foundItems(projectId: string, audiences: readonly Audience[], rowsUnder: RowsUnder): Promise<Array<{ kind: CountedKind; id: string }> | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `SELECT min(kind) FILTER (WHERE base) AS kind, min(id) FILTER (WHERE base) AS id FROM assistant_search
       WHERE org_id = $1 AND project_id = $2 AND kind <> 'column'
       GROUP BY item HAVING bool_or(base AND audience = ANY($3::text[])) AND NOT bool_or(retired)`,
      [org, projectId, audiences],
    );
    return r.rows as Array<{ kind: CountedKind; id: string }>;
  });
}

/** Each item of `kind` whose base part holds one of `keys` (0028), by item key: ../app/assistantSearchRank keyedItems. Null without a database. */
export function keyedItems(projectId: string, kind: KeyedKind, keys: readonly string[], rowsUnder: RowsUnder): Promise<KeyedItem[] | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `SELECT id, dataset_id FROM assistant_search WHERE org_id = $1 AND project_id = $2 AND base AND kind = $3 AND keys && $4::text[] ORDER BY item`,
      [org, projectId, kind, keys],
    );
    return (r.rows as Array<{ id: string; dataset_id: string | null }>).map((x) => ({ id: x.id, datasetId: x.dataset_id }));
  });
}

/** The `limit` newest items of `kind`, then by item key, retired left out unless `retired`: ../app/assistantSearchRank newestItems. Null without a database. */
export function newestItems(projectId: string, kind: KeyedKind, limit: number, retired: boolean, rowsUnder: RowsUnder): Promise<KeyedItem[] | null> {
  return built(projectId, rowsUnder, async (c, org) => {
    const r = await c.query(
      `SELECT p.id, p.dataset_id FROM assistant_search p WHERE p.org_id = $1 AND p.project_id = $2 AND p.base AND p.kind = $3
         AND ($5 OR NOT EXISTS (SELECT 1 FROM assistant_search x WHERE x.org_id = $1 AND x.project_id = $2 AND x.item = p.item AND x.retired))
       ORDER BY p.updated DESC, p.item LIMIT $4`,
      [org, projectId, kind, limit, retired],
    );
    return (r.rows as Array<{ id: string; dataset_id: string | null }>).map((x) => ({ id: x.id, datasetId: x.dataset_id }));
  });
}
