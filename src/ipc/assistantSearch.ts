// The Assistant's search of the Data model (docs/assistant/00-design.md, step 3) — MAIN PROCESS ONLY. Its datasets,
// their columns, metrics, glossary terms and documented source tables, ranked for a question's words
// (../app/assistantSearchRank: what is found and in what order). Names, "also called" names and descriptions only:
// no row value, no dataset origin. Two ways that must agree, field by field (scripts/test-assistantSearch.ts):
//
//   INDEXED    with a database: ../server/assistantSearchIndex ranks inside one query, the caller's audience in its
//              WHERE (a viewer never matches a source table), and reads no record once built.
//   REFERENCE  every store read, each record turned into parts by the SAME mapping below, ranked in JS. Without a
//              database this is the path, and with one it answers whenever the index fails.
//
// What is per person is never in the index: a column hidden from the caller (../data/rowAccess hiddenColumnsFor), and a
// metric or term that reads one (../analysis/columnHidden, as the Assistant's vocabulary leaves them out), are dropped
// from the ranked results here, a page at a time, and from the counts, the same way on both paths.
//
// MEANING (PR 7c, ./meaning): with fingerprints, the index also finds the MEANING_K items nearest the question under
// the same access WHERE, merges them with the first MEANING_K by words by rank, and the rest follow by words; the
// hidden ones are dropped after, as above. The reference takes the distances it is given (`distance`) the same way.
//
// SPELLING (phase C): `spellModel` finds the datasets whose name is spelled near one a model's answer said, by pg_trgm's
// similarity in the index (0031) and by its JS twin (../app/trigram) in the reference; scripts/test-nameSpelling.ts.

import { createHash } from 'crypto';
import * as recordFs from '../app/recordFs';
import { logger } from '../app/logger';
import { isValidId } from '../app/ids';
import { clean } from '../app/searchMatch';
import { squash } from '../app/columnNames';
import { orgDb } from '../server/db/inOrg';
import * as index from '../server/assistantSearchIndex';
import * as datasets from '../data/datasets';
import * as metrics from '../analysis/metrics';
import * as terms from '../analysis/terms';
import * as catalog from '../app/catalog';
import { parseStatusRef } from '../app/statusDocs';
import { listSourceIndex, sanitizeIndex, type SourceIndexEntry } from '../app/sourceTables';
import { connectionsDir } from '../connectors/connections';
import { seesSourceNames } from '../data/sourceNames';
import { columnAccessFromRecord } from '../data/columnAccess';
import { MAX_DEPTH, parentsOfRecord } from '../data/upstream';
import { hiddenAnywhere, hiddenColumnsFor, inFanOut, restrictedOn } from '../data/rowAccess';
import { datasetFilePath } from '../data/datasetRecord';
import { readTexts } from '../app/recordTexts';
import { metricHidden, termHidden } from '../analysis/columnHidden';
import { searchWords, searchWordsOf } from '../ai/modelWords';
import { MEANING_K, MODEL_KINDS, findableBases, foundItems, fusedHead, itemKey, itemTexts, keyedItems, nearItems, newestItems, noCounts, phrase, rankParts, speltItems, withMeaning } from '../app/assistantSearchRank';
import { meaningOf, nearOrWords } from './meaning';
import type { Audience, CountedKind, KeyedItem, KeyedKind, ModelCounts, ModelHit, ModelKind, Part, RankOptions, SpeltHit } from '../app/assistantSearchRank';

export type { KeyedItem, ModelCounts, ModelHit, ModelKind, SpeltHit } from '../app/assistantSearchRank';

/** An item key longer than this is skipped on both paths: it could not sit in a btree index entry. */
const MAX_KEY = 256;
const MAX_LIMIT = 200;
/** Ranked results are read this many at a time (at least), so a page that is mostly hidden columns reads the next. */
const BATCH = 20;

let useIndex = true;
/** Test hook: off, every ask path takes its reference, as without a database (the NEGATIVE CONTROL of scripts/test-askNoProjectLists.ts). */
export function _setIndexed(on: boolean): void {
  useIndex = on;
}

// ── A store's record → its parts: the ONE mapping both paths use ────────────

const stamp = (v: unknown): string => (typeof v === 'string' ? clean(v) : '');
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
function part(p: Pick<Part, 'item' | 'kind'> & Partial<Part>): Part {
  return { grp: '', base: false, id: '', datasetId: null, connId: null, name: '', updated: '', audience: 'all', nameWords: [], aliasWords: [], textWords: [], certified: false, retired: false, keys: [], text: '', ...p };
}

// ── Exact-lookup keys (0028): a name as the answer validator compares it (../ai/answerSpec resolveDataset and
// resolveMeasure, ../ai/termFacts matchTerm), hashed so any name fits a GIN entry. A key match is a candidate only:
// the caller reads the records and applies the validator's own rule, so a collision costs a read, never a wrong word.
const hashed = (tag: string, s: string): string => tag + createHash('sha256').update(s).digest('base64url').slice(0, 22);
/** A name trimmed and lowercased: how a dataset, a metric and a term are matched first. */
export const lowerKey = (name: string): string => hashed('l', name.trim().toLowerCase());
/** A name squashed (../app/columnNames squash), or none for one of symbols only: matched second. */
export const squashKey = (name: string): string[] => { const k = squash(name); return k ? [hashed('s', k)] : []; };
/** The metrics and terms of a dataset. */
export const onKey = (datasetId: string): string => `d:${datasetId}`;
const onKeys = (datasetId: string): string[] => (datasetId.includes(' ') ? [] : [onKey(datasetId)]); // stored space-joined: an id with a space is no dataset's
const namesKeys = (names: readonly string[]): string[] => [...new Set(names.flatMap((n) => [lowerKey(n), ...squashKey(n)]))];

function columnNames(columns: unknown): string[] {
  const names = (Array.isArray(columns) ? columns : []).flatMap((c: { name?: unknown } | null) => (typeof c?.name === 'string' && c.name && c.name.length <= MAX_KEY ? [clean(c.name)] : []));
  return [...new Set(names)];
}

/**
 * What may hide a column (../data/rowAccess hiddenAnywhere's candidates, ../server/assistantSearchIndex hidingDatasets):
 * the keys of the dataset record `raw`, stored at `fileId`'s path, whose summary's id is `id`. Only the index carries
 * them (no reference search reads them): hiddenAnywhere's reference is its own walk over every dataset.
 */
export function hidingKeys(fileId: string, id: string, raw: unknown): string[] {
  const ruled = columnAccessFromRecord(raw) !== null || id !== fileId; // another id's record: read it, never trust its keys
  return [index.KNOWN_KEY, ...(ruled ? [index.RULED_KEY] : []), ...parentsOfRecord(raw).map(index.upKey)];
}

/** A dataset and each of its columns: what exists and what it is called. Its description and the columns' docs are the catalog's. `hiding`: its hidingKeys (the index's). */
export function datasetParts(s: Pick<datasets.DatasetSummary, 'id' | 'name' | 'updatedAt'>, columns: unknown, hiding: readonly string[] = []): Part[] {
  const id = clean(String(s.id));
  if (id.length > MAX_KEY) return [];
  const updated = stamp(s.updatedAt);
  return [
    part({ item: `dataset:${id}`, kind: 'dataset', base: true, id, datasetId: id, name: clean(text(s.name)), updated, nameWords: searchWords(text(s.name)), keys: [...namesKeys([text(s.name)]), ...hiding], text: phrase(clean(text(s.name)), [], '') }),
    ...columnNames(columns).map((name) => part({ item: `column:${id}/${name}`, kind: 'column', base: true, id: name, datasetId: id, name, updated, nameWords: searchWords(name), text: phrase(name, [], '') })),
  ];
}

export function metricParts(m: metrics.MetricSummary): Part[] {
  const id = clean(String(m.id));
  return id.length > MAX_KEY ? [] : [part({
    item: `metric:${id}`, kind: 'metric', base: true, id, datasetId: clean(String(m.datasetId)), name: clean(text(m.name)), updated: stamp(m.updatedAt),
    nameWords: searchWords(text(m.name)), textWords: searchWords(text(m.description)), keys: [lowerKey(text(m.name)), ...onKeys(clean(String(m.datasetId)))],
    text: phrase(clean(text(m.name)), [], clean(text(m.description))),
  })];
}

export function termParts(t: terms.TermSummary): Part[] {
  const id = clean(String(t.id));
  return id.length > MAX_KEY ? [] : [part({
    item: `term:${id}`, kind: 'term', base: true, id, datasetId: clean(String(t.datasetId)), name: clean(text(t.name)), updated: stamp(t.updatedAt),
    nameWords: searchWords(text(t.name)), aliasWords: searchWordsOf(t.aliases), textWords: searchWords(text(t.description)),
    keys: [...namesKeys([text(t.name), ...t.aliases.filter((a) => typeof a === 'string')]), ...onKeys(clean(String(t.datasetId)))],
    text: phrase(clean(text(t.name)), t.aliases.filter((a) => typeof a === 'string').map(clean), clean(text(t.description))),
  })];
}

/** A connection's documented tables, for editors only: a viewer never reads a warehouse table's name (p2-01). */
export const tableParts = (connId: string, entries: readonly SourceIndexEntry[]): Part[] => entries.map((e) => part({
  item: `table:${connId}/${e.docId}`, kind: 'table', base: true, id: e.docId, connId, name: clean(e.table), audience: 'editor', nameWords: searchWords(e.table),
  text: phrase(clean(e.table), [], ''),
}));

/**
 * catalog.json: a dataset's description and its columns' "also called" names, display name and description, one
 * group per dataset; certified and retired, one group. Never a column's example or value labels: those are values.
 */
export function catalogParts(file: catalog.CatalogFile): Part[] {
  const out: Part[] = [];
  const ids = new Set([...Object.keys(file.records).flatMap((k) => (k.startsWith('dataset:') ? [k.slice('dataset:'.length)] : [])), ...Object.keys(file.columns)]);
  for (const ds of ids) {
    const grp = `d:${ds}`;
    const description = clean(file.records[`dataset:${ds}`]?.description ?? '');
    const about = searchWords(description);
    if (about.length) out.push(part({ grp, item: `dataset:${ds}`, kind: 'dataset', datasetId: ds, textWords: about, text: phrase('', [], description) }));
    for (const [name, doc] of Object.entries(file.columns[ds] ?? {})) {
      const aliasWords = searchWordsOf([doc.displayName, ...doc.aliases]);
      const textWords = searchWords(doc.description);
      const text = phrase('', [doc.displayName, ...doc.aliases].map(clean), clean(doc.description)); // never the example or value labels: values
      if (aliasWords.length || textWords.length) out.push(part({ grp, item: `column:${ds}/${clean(name)}`, kind: 'column', datasetId: ds, aliasWords, textWords, text }));
    }
  }
  for (const [ref, doc] of Object.entries(file.status ?? {})) {
    const r = parseStatusRef(ref);
    if (r) out.push(part({ grp: 's', item: `${r.kind}:${r.id}`, kind: r.kind, certified: doc.status === 'certified', retired: doc.status === 'retired' }));
  }
  return out;
}

/** The index's describer: one stored record → its parts, through each store's own parser. */
export const describeModelRecord: index.DescribeModel = (where, body) => {
  const p = where.projectId;
  try {
    switch (where.source) {
      case 'datasets': { const s = datasets.summaryOf(p, body); const raw = JSON.parse(body) as { columns?: unknown }; return s ? datasetParts(s, raw.columns, hidingKeys(where.id, s.id, raw)) : []; }
      case 'metrics': { const m = metrics.summaryOf(p, body); return m ? metricParts(m) : []; }
      case 'terms': { const t = terms.termOf(p, body); return t ? termParts(t) : []; }
      case 'catalog': return catalogParts(catalog.sanitizeCatalog(JSON.parse(body)));
      case 'tables': return tableParts(where.id, sanitizeIndex(JSON.parse(body)));
    }
  } catch (_) {
    return []; // unreadable: its list skips it too
  }
};

const TABLES_FILE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.tables\.json$/;

/** REFERENCE: every searched record of the project, read through its store, as parts. */
async function storeParts(projectId: string): Promise<Part[]> {
  const out: Part[] = [];
  for (const s of await datasets.listDatasets(projectId)) out.push(...datasetParts(s, (await datasets.getDatasetMeta(projectId, s.id))?.columns));
  out.push(...catalogParts(await catalog.load(projectId)));
  for (const m of await metrics.listMetrics(projectId)) out.push(...metricParts(m));
  for (const t of await terms.listTerms(projectId)) out.push(...termParts(t));
  const names = await recordFs.readdir(connectionsDir(projectId)).catch(() => [] as string[]);
  for (const n of names) {
    const conn = TABLES_FILE.exec(n)?.[1];
    if (conn) out.push(...tableParts(conn, await listSourceIndex(projectId, conn)));
  }
  return out;
}

// ── The answer ──────────────────────────────────────────────────────────────

/** `exceptDatasetIds`: nothing on these datasets is found (an agent's outside-the-topic check). */
export interface SearchOptions { kinds?: readonly ModelKind[]; limit: number; datasetIds?: readonly string[]; exceptDatasetIds?: readonly string[] }

const audiencesOf = async (projectId: string): Promise<Audience[]> => ((await seesSourceNames(projectId)) ? ['all', 'editor'] : ['all']);

async function rankOptions(projectId: string, o: SearchOptions): Promise<RankOptions> {
  return {
    audiences: await audiencesOf(projectId),
    ...(o.kinds ? { kinds: MODEL_KINDS.filter((k) => o.kinds?.includes(k)) } : {}),
    ...(o.datasetIds ? { datasetIds: [...new Set(o.datasetIds.filter((d) => typeof d === 'string'))] } : {}),
    ...(o.exceptDatasetIds ? { exceptDatasetIds: [...new Set(o.exceptDatasetIds.filter((d) => typeof d === 'string'))] } : {}),
  };
}

const limitOf = (o: Pick<SearchOptions, 'limit'>): number => Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(o.limit) || 0)));

/**
 * Is this result hidden from the caller? A column hidden from them, or a metric or term that reads one. Fails closed:
 * a check that throws hides (a dataset's columns all of them). For this one answer only, never kept across requests.
 */
function hiddenCheck(projectId: string): (h: Pick<ModelHit, 'kind' | 'id' | 'datasetId'>, text?: () => string) => Promise<boolean> {
  const held = new Map<string, Promise<ReadonlySet<string> | null>>();
  return async (h, text) => {
    if (h.kind === 'metric') return metricHidden(projectId, h.id, text).catch(() => true);
    if (h.kind === 'term') return termHidden(projectId, h.id, text).catch(() => true);
    if (h.kind !== 'column' || !h.datasetId) return false;
    let s = held.get(h.datasetId);
    if (!s) held.set(h.datasetId, (s = hiddenColumnsFor(projectId, h.datasetId).then((x) => new Set([...x].map(clean)), () => null)));
    const set = await s;
    return set === null || set.has(h.id);
  };
}

/**
 * The first `limit` ranked results the caller may see: `head` first, then `page` by page (null: none) less what `head`
 * holds, so a page of hidden ones reads the next. Null when a page is.
 */
function visible(projectId: string, limit: number, page: ((offset: number, n: number) => Promise<ModelHit[] | null>) | null, head: readonly ModelHit[] = []): Promise<ModelHit[] | null> {
  return recordFs.withReadMemo(async () => {
    const hidden = hiddenCheck(projectId);
    // A restricted caller's column checks read each result's dataset record: one query a page (an editor's read none).
    const reads = inFanOut() || (await restrictedOn(projectId));
    const n = Math.max(limit, BATCH);
    const out: ModelHit[] = [];
    const take = async (batch: readonly ModelHit[]): Promise<void> => {
      if (reads) await recordFs.readMany([...new Set(batch.flatMap((h) => (h.kind === 'column' && h.datasetId && isValidId(h.datasetId) ? [datasetFilePath(projectId, h.datasetId)] : [])))]);
      for (const h of batch) {
        if (out.length < limit && !(await hidden(h))) out.push(h);
      }
    };
    for (let i = 0; i < head.length && out.length < limit; i += n) await take(head.slice(i, i + n));
    const had = new Set(head.map(itemKey));
    for (let offset = 0; page && out.length < limit; offset += n) {
      const batch = await page(offset, n);
      if (!batch) return null;
      await take(had.size ? batch.filter((h) => !had.has(itemKey(h))) : batch);
      if (batch.length < n) break;
    }
    return out;
  });
}

/**
 * The items the caller may see, counted. A caller nothing is hidden from costs no read; one with a hidden column has each
 * metric and term checked, their records read a thousand at a time.
 */
function tally(projectId: string, items: ReadonlyArray<{ kind: CountedKind; id: string }>): Promise<ModelCounts> {
  return recordFs.withReadMemo(async () => {
    const out = noCounts();
    const hidden = (await hiddenAnywhere(projectId)).size ? hiddenCheck(projectId) : null;
    const textOf = hidden ? await prefetch(projectId, items) : null;
    for (const it of items) if (!hidden || !(await hidden(it, textOf?.(it)))) out[it.kind] += 1;
    return out;
  });
}

/** Records read per query when the checks of a caller with a hidden column are prefetched. */
const PREFETCH = 1000;

/** The metric and term records `items` name, read a page of ids at a time: each one's text, or none (a dataset, a table). */
async function prefetch(projectId: string, items: ReadonlyArray<{ kind: CountedKind; id: string }>): Promise<(it: { kind: CountedKind; id: string }) => (() => string) | undefined> {
  const fileOf = (it: { kind: CountedKind; id: string }): string | null => (!isValidId(it.id) ? null : it.kind === 'term' ? terms.termFile(projectId, it.id) : it.kind === 'metric' ? metrics.metricFilePath(projectId, it.id) : null);
  const paths = [...new Set(items.flatMap((it) => fileOf(it) ?? []))];
  const pageOf = new Map<string, (path: string) => () => string>();
  for (let i = 0; i < paths.length; i += PREFETCH) {
    const page = paths.slice(i, i + PREFETCH);
    const textOf = await readTexts(page);
    for (const p of page) pageOf.set(p, textOf);
  }
  return (it) => {
    const file = fileOf(it);
    const textOf = file === null ? undefined : pageOf.get(file);
    return file !== null && textOf ? textOf(file) : undefined;
  };
}

/**
 * REFERENCE: every store read, ranked in JS, then what the caller may see. `meaning` (each item's distance to the
 * question, by key, none for no fingerprint; and the farthest that counts) merges meaning in as the index does: only the
 * differential gives it, from the stored vectors.
 */
export async function referenceModel(projectId: string, question: string, o: SearchOptions, meaning?: { distance: (item: string) => number | undefined; maxDistance: number }): Promise<ModelHit[]> {
  const asked = searchWords(question);
  if (!isValidId(projectId) || !asked.length) return [];
  const parts = await storeParts(projectId);
  const opts = await rankOptions(projectId, o);
  const words = rankParts(parts, asked, opts);
  const ranked = meaning ? withMeaning(words, nearItems(parts, asked, opts, meaning.distance, MEANING_K, meaning.maxDistance)) : words;
  return (await visible(projectId, limitOf(o), async (offset, n) => ranked.slice(offset, offset + n))) ?? [];
}

/** REFERENCE of what the fingerprint job sends: each item's text, by key (../app/assistantSearchRank itemText). */
export const referenceTexts = async (projectId: string): Promise<Map<string, string>> => itemTexts(await storeParts(projectId));

/** INDEXED: the same answer from the index, with meaning when there are fingerprints. Null without a database (or for an id not as records store it). */
export async function indexedModel(projectId: string, question: string, o: SearchOptions): Promise<ModelHit[] | null> {
  if (!useIndex || !orgDb() || projectId !== projectId.toLowerCase()) return null;
  const asked = searchWords(question);
  if (!isValidId(projectId) || !asked.length) return [];
  const opts = await rankOptions(projectId, o);
  const page = (offset: number, n: number): Promise<ModelHit[] | null> => index.rankedPage(projectId, asked, opts, offset, n, recordFs.rowsUnder);
  const to = await meaningOf(projectId, question);
  const near = to && (await nearOrWords(() => index.nearestPage(projectId, asked, opts, to, MEANING_K, recordFs.rowsUnder)));
  if (!near) return visible(projectId, limitOf(o), page);
  const words = await page(0, MEANING_K);
  if (!words) return null;
  return visible(projectId, limitOf(o), words.length < MEANING_K ? null : (offset, n) => page(MEANING_K + offset, n), fusedHead(words, near));
}

export async function referenceCount(projectId: string): Promise<ModelCounts> {
  return isValidId(projectId) ? tally(projectId, foundItems(await storeParts(projectId), await audiencesOf(projectId))) : noCounts();
}

export async function indexedCount(projectId: string): Promise<ModelCounts | null> {
  if (!useIndex || !orgDb() || projectId !== projectId.toLowerCase()) return null;
  if (!isValidId(projectId)) return noCounts();
  const items = await index.foundItems(projectId, await audiencesOf(projectId), recordFs.rowsUnder);
  return items && tally(projectId, items);
}

let warned = false;
function fellBack(err: unknown): void {
  if (warned) return;
  warned = true;
  logger.warn(`[assistant search] the index query failed (${String((err as { code?: unknown })?.code ?? 'error')}); answering from the records. Further failures are not logged.`);
}

async function indexedOr<T>(fn: () => Promise<T | null>, reference: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    if (r !== null) return r;
  } catch (err) {
    fellBack(err);
  }
  return reference();
}

/** The `limit` items of the Data model that best match `question`'s words, that the caller may see, best first. */
export function searchModel(projectId: string, question: string, o: SearchOptions): Promise<ModelHit[]> {
  return indexedOr(() => indexedModel(projectId, question, o), () => referenceModel(projectId, question, o));
}

// ── Spelling: "Did you mean" a dataset (phase C) ───────────────────────────────
// Datasets only: a column, metric or term would need the per-person checks `visible` makes after the query.

export type SpellOptions = Pick<SearchOptions, 'limit' | 'datasetIds'>;
const spellingOptions = (o: SpellOptions): SearchOptions => ({ ...o, kinds: ['dataset'] });

/** REFERENCE: every store read, the datasets the caller may find whose name is spelled near `said` (../app/trigram). */
export async function referenceSpelling(projectId: string, said: string, o: SpellOptions): Promise<SpeltHit[]> {
  if (!isValidId(projectId)) return [];
  const opts = await rankOptions(projectId, spellingOptions(o));
  return speltItems(findableBases(await storeParts(projectId), opts), clean(said), limitOf(o));
}

/** INDEXED: the same from the index, in one query (pg_trgm where it agrees with the reference). Null without a database. */
export async function indexedSpelling(projectId: string, said: string, o: SpellOptions): Promise<SpeltHit[] | null> {
  if (!useIndex || !orgDb() || projectId !== projectId.toLowerCase()) return null;
  if (!isValidId(projectId)) return [];
  return index.speltPage(projectId, clean(said), await rankOptions(projectId, spellingOptions(o)), limitOf(o), recordFs.rowsUnder);
}

/** The `limit` datasets the caller may find whose name is spelled nearest `said` (similarity ≥ MIN_SIMILARITY), nearest first. */
export function spellModel(projectId: string, said: string, o: SpellOptions): Promise<SpeltHit[]> {
  return indexedOr(() => indexedSpelling(projectId, said, o), () => referenceSpelling(projectId, said, o));
}

/** How many datasets, metrics, terms and source tables the caller can find in the project (Home's counts); no columns. */
export function countModel(projectId: string): Promise<ModelCounts> {
  return indexedOr(() => indexedCount(projectId), () => referenceCount(projectId));
}

// ── Exact lookups: no word ranking, no access check (a name or a dataset's members, as the stores list them) ──
// INDEXED only: null without a database, or (logged once) when the query fails, and the caller takes its own reference
// path, the whole list it read before. The REFERENCE of each is here for the differential (scripts/test-askIndex.ts).

/** Can the index answer for this project? Records live under the id as written: a differently-cased one reads nothing there. */
export const indexedFor = (projectId: string): boolean => useIndex && !!orgDb() && isValidId(projectId) && projectId === projectId.toLowerCase();

async function onIndex<T>(projectId: string, fn: () => Promise<T | null>): Promise<T | null> {
  if (!indexedFor(projectId)) return null;
  try {
    return await fn();
  } catch (err) {
    fellBack(err);
    return null;
  }
}

/**
 * Each item of `kind` whose name (or a term's other name) has one of `keys` (`lowerKey`, `squashKey`), or which is on a
 * dataset of `onKey`, by item key; retired ones too, as the stores list them. CANDIDATES: the caller reads the records.
 */
export function keyedModel(projectId: string, kind: KeyedKind, keys: readonly string[]): Promise<KeyedItem[] | null> {
  return onIndex(projectId, async () => (keys.length ? index.keyedItems(projectId, kind, [...new Set(keys)], recordFs.rowsUnder) : []));
}
export const keyedReference = async (projectId: string, kind: KeyedKind, keys: readonly string[]): Promise<KeyedItem[]> => keyedItems(await storeParts(projectId), kind, keys);

const capped = (limit: number): number => Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || 1));
/** The `limit` newest items of `kind` (by their record's updatedAt, then key); a retired one left out unless `retired`. */
export function newestModel(projectId: string, kind: KeyedKind, limit: number, retired = false): Promise<KeyedItem[] | null> {
  return onIndex(projectId, () => index.newestItems(projectId, kind, capped(limit), retired, recordFs.rowsUnder));
}
export const newestReference = async (projectId: string, kind: KeyedKind, limit: number, retired = false): Promise<KeyedItem[]> => newestItems(await storeParts(projectId), kind, capped(limit), retired);

/**
 * The datasets that may hide a column from someone, by their hiding keys: ../data/rowAccess hiddenAnywhere reads only
 * these (../server/assistantSearchIndex hidingDatasets says why the set is complete). Null without the index.
 */
export const hidingModel = (projectId: string): Promise<string[] | null> => onIndex(projectId, () => index.hidingDatasets(projectId, MAX_DEPTH, recordFs.rowsUnder));

/** recordFs writes keep the index current through this describer (src/server/app.ts registers it at startup). */
export function register(): void {
  index.useModelDescriber(describeModelRecord);
}
