// The one list of aggregations (semantic layer part 5, D4). Every store and surface takes its list from here, so a
// new one reaches them all at once; scripts/test-aggregationList.ts forbids a list of its own anywhere else in src/.
// No imports: the engines, the stores and the contracts all read it.

/** What a stored measure may say. `countd` counts distinct non-empty values (analysis/countDistinct, its resident and Live SQL twins). */
export const AGGREGATIONS = ['sum', 'avg', 'count', 'min', 'max', 'countd'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

/** A surface that cannot count distinct values. */
export const PLAIN_AGGREGATIONS = ['sum', 'avg', 'count', 'min', 'max'] as const;
export type PlainAggregation = (typeof PLAIN_AGGREGATIONS)[number];

/** The aggregations that need a number column. */
export const NUMBER_AGGREGATIONS = ['sum', 'avg', 'min', 'max'] as const;

const ALL: ReadonlySet<string> = new Set<string>(AGGREGATIONS);
const PLAIN: ReadonlySet<string> = new Set<string>(PLAIN_AGGREGATIONS);

export function isAggregation(s: unknown): s is Aggregation {
  return typeof s === 'string' && ALL.has(s);
}

export function isPlainAggregation(s: unknown): s is PlainAggregation {
  return typeof s === 'string' && PLAIN.has(s);
}

/** The aggregation as a series or a sentence says it: "sum of price", "count distinct of customer_id". */
export function aggWord(a: string): string {
  return a === 'countd' ? 'count distinct' : a;
}

/** A count of cells: any column type, never FX-converted. */
export function isCountLike(a: string): boolean {
  return a === 'count' || a === 'countd';
}
