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

/** THE REFERENCE: every item found for `asked` (deduplicated words), best first. */
export function rankParts(parts: readonly Part[], asked: readonly string[], o: RankOptions): ModelHit[] {
  const want = new Set(asked);
  const aud = new Set<string>(o.audiences);
  const kinds = o.kinds ? new Set<string>(o.kinds) : null;
  const ds = o.datasetIds ? new Set(o.datasetIds) : null;
  const ex = o.exceptDatasetIds ? new Set(o.exceptDatasetIds) : null;
  const out: Keyed[] = [];
  for (const [item, ps] of byItem(parts)) {
    const found = ps.some((p) => aud.has(p.audience) && (!kinds || kinds.has(p.kind)) && (!ds || (p.datasetId !== null && ds.has(p.datasetId)))
      && (!ex || p.datasetId === null || !ex.has(p.datasetId)) && partScore(p, want) > 0);
    const bases = found ? seen(ps, aud) : null;
    if (!bases) continue;
    const dataset = bases.flatMap((p) => (p.datasetId === null ? [] : [p.datasetId]));
    const conn = bases.flatMap((p) => (p.connId === null ? [] : [p.connId]));
    const kind = least(bases.map((p) => p.kind)) as ModelKind;
    out.push({
      hit: {
        kind, id: least(bases.map((p) => p.id)), ...(dataset.length ? { datasetId: least(dataset) } : {}), ...(conn.length ? { connId: least(conn) } : {}),
        name: least(bases.map((p) => p.name)), score: ps.reduce((n, p) => n + partScore(p, want), 0),
      },
      certified: ps.some((p) => p.certified), kindOrd: kindOrd(kind), updated: most(bases.map((p) => p.updated)), item,
    });
  }
  return out.sort((a, b) => b.hit.score - a.hit.score || Number(b.certified) - Number(a.certified) || a.kindOrd - b.kindOrd
    || byCode(b.updated, a.updated) || byCode(a.item, b.item)).map((k) => k.hit);
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
