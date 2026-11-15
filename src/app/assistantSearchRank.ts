// What the Assistant's search of the Data model (step 3) FINDS and in what ORDER — pure, no I/O. Both answers use
// it: the index (src/server/assistantSearchIndex.ts, the SQL written once more there) and the reference that reads
// every store (src/ipc/assistantSearch.ts); scripts/test-assistantSearch.ts holds them equal with Object.is.
//
//   item    a dataset, a column, a metric, a glossary term or a documented source table. Its PARTS come from up to
//           two records: its own (the base part: it exists, its name, when it changed) and catalog.json (its
//           description, "also called" names, certified or retired). Parts are summed by item.
//   found   some part, on an allowed kind, dataset and audience, shares a word with the question; the item has a
//           base part the caller's audience may see; no part says retired.
//   score   an integer: 4 per asked word in a name, 2 per asked word in an other name, 1 per asked word in a
//           description, summed over the item's parts. Words are deduplicated per field and per question.
//   order   score, then certified first, then kind (dataset, metric, term, column, table), then the newest, then
//           the item key — every string compared by code unit, as Postgres "C" does.
//   meaning with fingerprints (PR 7c), the K items nearest the question's are a second list (`nearItems`), merged with
//           the first K by words by rank (../ai/rankFusion), then the rest by words (`withMeaning`). An item's
//           fingerprint is made from `itemText`.
//   spelling a name said is compared with the names by pg_trgm's similarity (./trigram, `speltItems`): "Did you mean".

import { fuse } from '../ai/rankFusion';
import { MIN_SIMILARITY, similarityOf, trigrams } from './trigram';

export const MODEL_KINDS = ['dataset', 'metric', 'term', 'column', 'table'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];
export type Audience = 'all' | 'editor';

export interface Part {
  /** The part of its record that changes together: '' for most, catalog.json's `d:<datasetId>` or `s`. */
  grp: string;
  item: string;
  kind: ModelKind;
  base: boolean;
  id: string;
  datasetId: string | null;
  connId: string | null;
  name: string;
  updated: string;
  audience: Audience;
  nameWords: string[];
  aliasWords: string[];
  textWords: string[];
  certified: boolean;
  retired: boolean;
  /** Exact-lookup keys (0028), base parts only: hashed names and `d:<dataset>`. No part of the rank. */
  keys: string[];
  /** What a person reads of this part (0030): names and a description as written, at most TEXT_MAX. Fingerprinted, never ranked. */
  text: string;
}

export interface ModelHit { kind: ModelKind; id: string; datasetId?: string; connId?: string; name: string; score: number }
/** `exceptDatasetIds`: a part on one of these datasets finds nothing (an agent's outside-the-topic check). */
export interface RankOptions { kinds?: readonly ModelKind[]; datasetIds?: readonly string[]; exceptDatasetIds?: readonly string[]; audiences: readonly Audience[] }

export const kindOrd = (k: ModelKind): number => MODEL_KINDS.indexOf(k);
export const allWords = (p: Pick<Part, 'nameWords' | 'aliasWords' | 'textWords'>): string[] => [...new Set([...p.nameWords, ...p.aliasWords, ...p.textWords])];

const hits = (ws: readonly string[], asked: ReadonlySet<string>): number => ws.reduce((n, w) => n + (asked.has(w) ? 1 : 0), 0);
export const partScore = (p: Part, asked: ReadonlySet<string>): number => 4 * hits(p.nameWords, asked) + 2 * hits(p.aliasWords, asked) + hits(p.textWords, asked);

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const least = (xs: readonly string[]): string => xs.reduce((m, x) => (x < m ? x : m));
const most = (xs: readonly string[]): string => xs.reduce((m, x) => (x > m ? x : m));

interface Keyed { hit: ModelHit; certified: boolean; kindOrd: number; updated: string; item: string }

function byItem(parts: readonly Part[]): Map<string, Part[]> {
  const out = new Map<string, Part[]>();
  for (const p of parts) {
    const ps = out.get(p.item);
    if (ps) ps.push(p);
    else out.set(p.item, [p]);
  }
  return out;
}

/** The item's base parts, when the caller may see one and nothing retired it; else null. */
function seen(ps: readonly Part[], audiences: ReadonlySet<string>): Part[] | null {
  const bases = ps.filter((p) => p.base);
  return bases.some((p) => audiences.has(p.audience)) && !ps.some((p) => p.retired) ? bases : null;
}

/** An item's result, from its base parts, scored by every part's words. */
function hitOf(bases: readonly Part[], ps: readonly Part[], want: ReadonlySet<string>): ModelHit {
  const dataset = bases.flatMap((p) => (p.datasetId === null ? [] : [p.datasetId]));
  const conn = bases.flatMap((p) => (p.connId === null ? [] : [p.connId]));
  return {
    kind: least(bases.map((p) => p.kind)) as ModelKind, id: least(bases.map((p) => p.id)), ...(dataset.length ? { datasetId: least(dataset) } : {}),
    ...(conn.length ? { connId: least(conn) } : {}), name: least(bases.map((p) => p.name)), score: ps.reduce((n, p) => n + partScore(p, want), 0),
  };
}

/** May a part be found under `o`? Its kind, its dataset and its audience. */
function allowed(o: RankOptions): (p: Part) => boolean {
  const aud = new Set<string>(o.audiences);
  const kinds = o.kinds ? new Set<string>(o.kinds) : null;
  const ds = o.datasetIds ? new Set(o.datasetIds) : null;
  const ex = o.exceptDatasetIds ? new Set(o.exceptDatasetIds) : null;
  return (p) => aud.has(p.audience) && (!kinds || kinds.has(p.kind)) && (!ds || (p.datasetId !== null && ds.has(p.datasetId)))
    && (!ex || p.datasetId === null || !ex.has(p.datasetId));
}

/** THE REFERENCE: every item found for `asked` (deduplicated words), best first. */
export function rankParts(parts: readonly Part[], asked: readonly string[], o: RankOptions): ModelHit[] {
  const want = new Set(asked);
  const aud = new Set<string>(o.audiences);
  const may = allowed(o);
  const out: Keyed[] = [];
  for (const [item, ps] of byItem(parts)) {
    const found = ps.some((p) => may(p) && partScore(p, want) > 0);
    const bases = found ? seen(ps, aud) : null;
    if (!bases) continue;
    const hit = hitOf(bases, ps, want);
    out.push({ hit, certified: ps.some((p) => p.certified), kindOrd: kindOrd(hit.kind), updated: most(bases.map((p) => p.updated)), item });
  }
  return out.sort((a, b) => b.hit.score - a.hit.score || Number(b.certified) - Number(a.certified) || a.kindOrd - b.kindOrd
    || byCode(b.updated, a.updated) || byCode(a.item, b.item)).map((k) => k.hit);
}

// ── Meaning (PR 7c) ─────────────────────────────────────────────────────────

/** How many items each list brings to the merge: the nearest by meaning, and the best by words. */
export const MEANING_K = 50;
/** An item's text is cut to this many code points before it is fingerprinted. */
export const TEXT_MAX = 1000;

/** A result's item key, as its parts name it: `dataset:<id>`, `column:<dataset>/<name>`, `table:<connection>/<doc>`. */
export const itemKey = (h: Pick<ModelHit, 'kind' | 'id' | 'datasetId' | 'connId'>): string =>
  `${h.kind}:${h.kind === 'column' ? `${h.datasetId ?? ''}/` : h.kind === 'table' ? `${h.connId ?? ''}/` : ''}${h.id}`;

/** `t` cut to TEXT_MAX code points (Postgres `left` counts the same). */
export const cut = (t: string): string => (t.length <= TEXT_MAX ? t : Array.from(t).slice(0, TEXT_MAX).join(''));

/** A name, its other names and a description, as a person reads them: "West coast, also called Pacific — Orders shipped west". */
export function phrase(name: string, aka: readonly string[], about: string): string {
  const called = aka.map((a) => a.trim()).filter(Boolean);
  const head = [name.trim(), called.length ? `also called ${called.join(', ')}` : ''].filter(Boolean).join(', ');
  return cut([head, about.trim()].filter(Boolean).join(' — '));
}

/** The kinds whose text starts with their dataset's name: a column, a metric. */
const ON_DATASET: ReadonlySet<ModelKind> = new Set(['column', 'metric']);

/**
 * THE REFERENCE of the text an item is fingerprinted from (../server/fingerprintStore ITEM_TEXT): each part's `text`,
 * the base part first, joined by " — ", after its dataset's name and " · " for a column or a metric, cut to TEXT_MAX
 * code points. An item has one base part and at most one other with text (catalog.json's).
 */
export function itemText(ps: readonly Part[], datasetName: (id: string) => string | undefined): string {
  const bases = ps.filter((p) => p.base);
  const body = [...bases, ...ps.filter((p) => !p.base)].map((p) => p.text).filter(Boolean).join(' — ');
  if (!body || !bases.length) return '';
  const kind = least(bases.map((p) => p.kind)) as ModelKind;
  const dataset = bases.flatMap((p) => (p.datasetId === null ? [] : [p.datasetId]));
  const on = ON_DATASET.has(kind) && dataset.length ? datasetName(least(dataset)) : undefined;
  return cut(on ? `${on} · ${body}` : body);
}

/** THE REFERENCE: each fingerprinted item's text, by key (retired ones and those with no text left out, as the job does). */
export function itemTexts(parts: readonly Part[]): Map<string, string> {
  const items = byItem(parts);
  const datasetName = (id: string): string | undefined => {
    const names = (items.get(`dataset:${id}`) ?? []).filter((p) => p.base).map((p) => p.name);
    return names.length && least(names) ? least(names) : undefined;
  };
  const out = new Map<string, string>();
  for (const [item, ps] of items) {
    const t = ps.some((p) => p.base) && !ps.some((p) => p.retired) ? itemText(ps, datasetName) : '';
    if (t) out.set(item, t);
  }
  return out;
}

/**
 * THE REFERENCE of the nearest-by-meaning query (../server/assistantSearchIndex nearestPage): the items with a
 * fingerprint (`distance` by key) no farther than `maxDistance` that the caller may find under `o` — a base part of an allowed kind, dataset and audience,
 * none retired — nearest first, then by key, `k` of them, each scored by its words for `asked`.
 */
export function nearItems(parts: readonly Part[], asked: readonly string[], o: RankOptions, distance: (item: string) => number | undefined, k: number, maxDistance: number): ModelHit[] {
  const want = new Set(asked);
  const may = allowed(o);
  const out: Array<{ hit: ModelHit; d: number; item: string }> = [];
  for (const [item, ps] of byItem(parts)) {
    const d = distance(item);
    const bases = ps.filter((p) => p.base);
    if (d === undefined || d > maxDistance || !bases.some(may) || ps.some((p) => p.retired)) continue;
    out.push({ hit: hitOf(bases, ps, want), d, item });
  }
  return out.sort((a, b) => a.d - b.d || byCode(a.item, b.item)).slice(0, k).map((x) => x.hit);
}

/** What Home counts: no columns (a column hidden from the caller would be counted, and nothing needs the number). */
export type CountedKind = Exclude<ModelKind, 'column'>;
export type ModelCounts = Record<CountedKind, number>;
export const noCounts = (): ModelCounts => ({ dataset: 0, metric: 0, term: 0, table: 0 });

/** THE REFERENCE: every item but the columns that the caller's audiences may find (retired left out), as its kind and id. */
export function foundItems(parts: readonly Part[], audiences: readonly Audience[]): Array<{ kind: CountedKind; id: string }> {
  const aud = new Set<string>(audiences);
  const out: Array<{ kind: CountedKind; id: string }> = [];
  for (const ps of byItem(parts).values()) {
    const bases = seen(ps, aud);
    const kind = bases ? (least(bases.map((p) => p.kind)) as ModelKind) : 'column';
    if (bases && kind !== 'column') out.push({ kind, id: least(bases.map((p) => p.id)) });
  }
  return out;
}

/** An item as an exact lookup returns it. */
export interface KeyedItem { id: string; datasetId: string | null }
/** The kinds an exact lookup reads (a source table has no name a spec says, nor a dataset). */
export type KeyedKind = Exclude<ModelKind, 'column' | 'table'>;

const bases = (parts: readonly Part[], kind: KeyedKind): Part[] => parts.filter((p) => p.base && p.kind === kind);
const keyed = (p: Part): KeyedItem => ({ id: p.id, datasetId: p.datasetId });
const byItemKey = (a: Part, b: Part): number => byCode(a.item, b.item);

/** THE REFERENCE of an exact lookup: each item of `kind` whose base part holds one of `keys`, by item key. Retired ones too: the vocabulary keeps them. */
export function keyedItems(parts: readonly Part[], kind: KeyedKind, keys: readonly string[]): KeyedItem[] {
  const want = new Set(keys);
  return bases(parts, kind).filter((p) => p.keys.some((k) => want.has(k))).sort(byItemKey).map(keyed);
}

/** THE REFERENCE: the `limit` newest items of `kind`, then by item key; one that is retired left out unless `retired`. */
export function newestItems(parts: readonly Part[], kind: KeyedKind, limit: number, retired = false): KeyedItem[] {
  const gone = retired ? new Set<string>() : new Set(parts.filter((p) => p.retired).map((p) => p.item));
  return bases(parts, kind).filter((p) => !gone.has(p.item)).sort((a, b) => byCode(b.updated, a.updated) || byItemKey(a, b)).slice(0, limit).map(keyed);
}

// ── Spelling (phase C) ──────────────────────────────────────────────────────

/** An item whose name is spelled near a said one, and how near: pg_trgm's similarity, at least MIN_SIMILARITY. */
export interface SpeltHit { kind: ModelKind; id: string; datasetId?: string; connId?: string; name: string; similarity: number }
/** A base part, as the spelling query reads it. */
export type NameRow = Pick<Part, 'item' | 'kind' | 'id' | 'datasetId' | 'connId' | 'name'>;

/** The base parts the caller may find under `o` (kind, dataset, audience), of no item a part retires: what spelling searches. */
export function findableBases(parts: readonly Part[], o: RankOptions): Part[] {
  const may = allowed(o);
  const gone = new Set(parts.filter((p) => p.retired).map((p) => p.item));
  return parts.filter((p) => p.base && may(p) && !gone.has(p.item));
}

/**
 * THE REFERENCE of the spelling query (../server/assistantSearchIndex speltPage): each item of `rows` with a name at
 * least MIN_SIMILARITY near `said`, at its best similarity, named by the least kind, id, dataset, connection and name of
 * those rows; by similarity, then name, then key, `limit` of them.
 */
export function speltItems(rows: readonly NameRow[], said: string, limit: number): SpeltHit[] {
  const to = trigrams(said);
  const by = new Map<string, { rows: NameRow[]; s: number }>();
  for (const r of rows) {
    const s = similarityOf(trigrams(r.name), to);
    if (s < MIN_SIMILARITY) continue;
    const at = by.get(r.item);
    if (!at) by.set(r.item, { rows: [r], s });
    else {
      at.rows.push(r);
      at.s = Math.max(at.s, s);
    }
  }
  const out = [...by].map(([item, { rows: rs, s }]) => {
    const dataset = rs.flatMap((r) => (r.datasetId === null ? [] : [r.datasetId]));
    const conn = rs.flatMap((r) => (r.connId === null ? [] : [r.connId]));
    const hit: SpeltHit = {
      kind: least(rs.map((r) => r.kind)) as ModelKind, id: least(rs.map((r) => r.id)), ...(dataset.length ? { datasetId: least(dataset) } : {}),
      ...(conn.length ? { connId: least(conn) } : {}), name: least(rs.map((r) => r.name)), similarity: s,
    };
    return { hit, item };
  });
  return out.sort((a, b) => b.hit.similarity - a.hit.similarity || byCode(a.hit.name, b.hit.name) || byCode(a.item, b.item)).slice(0, limit).map((x) => x.hit);
}

/** The words list's first MEANING_K and the meaning list, merged by rank (../ai/rankFusion, k = 60): the head of a ranking with meaning. */
export function fusedHead(words: readonly ModelHit[], near: readonly ModelHit[]): ModelHit[] {
  const by = new Map<string, ModelHit>();
  for (const h of [...near, ...words]) by.set(itemKey(h), h);
  return fuse([words.slice(0, MEANING_K).map(itemKey), near.map(itemKey)], { k: 60 }).flatMap((f) => by.get(f.key) ?? []);
}

/** THE REFERENCE of a ranking with meaning: `fusedHead`, then the rest of `words` (all of them, best first) not in it. */
export function withMeaning(words: readonly ModelHit[], near: readonly ModelHit[]): ModelHit[] {
  const head = fusedHead(words, near);
  const inHead = new Set(head.map(itemKey));
  return [...head, ...words.slice(MEANING_K).filter((h) => !inHead.has(itemKey(h)))];
}
