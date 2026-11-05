// A distinct count on Live (semantic layer part 5, D2) — PURE, the live twin of src/engine/countDistinctSql.ts.
//
// The chart statement (./compile.ts) builds its measures from parts that re-aggregate: it ranks categories by summing
// parts across series, folds "Other" by re-aggregating parts, and totals categories and series the same way. A
// distinct count survives none of that, so wherever a statement ranks or folds, a `countd` is COUNTED AGAIN from
// `lv_base`, grouped by that level's key, and joined back. Held to the extract by scripts/test-liveParity.ts.

import type { LiveColumn, LiveColumnMeasure } from './liveSpec';
import type { Ctx } from './compileFilter';
import { dateOf, emptyOf, nullsLast, numberOf, textOf } from './compileFilter';

/** What a distinct count counts, by the DECLARED type (`analysis/countDistinct`): a finite number, a day, non-empty text. */
export function distinctKey(c: Ctx, col: LiveColumn): string {
  if (col.type === 'number') {
    // −0 and 0 are one value, as in an extract (String(-0) is '0'); spelled as the compiler's number split key is.
    const n = numberOf(c, col);
    return `CASE WHEN ${n} = 0 THEN ${c.d.toDouble('0')} ELSE ${n} END`;
  }
  if (col.type === 'date') return dateOf(c, col);
  return `CASE WHEN NOT ${emptyOf(c, col)} THEN ${textOf(c, col)} END`;
}

/** `a` and `b` name the same group, a NULL key included: an equi-join every engine hashes (an OR would loop, and ClickHouse refuses one). */
export function nullSafeOn(a: string, b: string, text: boolean): string {
  const z = text ? "''" : '0';
  return `coalesce(${a}, ${z}) = coalesce(${b}, ${z}) AND ${nullsLast(a)} = ${nullsLast(b)}`;
}

/** CTE `name`: the distinct count of each `vs[i]` (as `lv_dv<i>`) over `from`, grouped by `by` (as `lv_dk<j>`). */
function countedCte(c: Ctx, name: string, from: string, by: string[], vs: string[]): string {
  const keys = by.map((k, j) => `${k} AS lv_dk${j}`);
  const counts = vs.map((v, i) => `${c.d.toDouble(c.d.countDistinct(v))} AS lv_dv${i}`);
  return `${name} AS (SELECT ${[...keys, ...counts].join(', ')} FROM ${from} GROUP BY ${by.join(', ')})`;
}

export interface Total { ctes: string[]; join: string; value: string }

/** Where a split's first-measure total is counted again: `rel` keyed by `relKey`, counted from `from` grouped by `by`. */
export interface Level { rel: string; relKey: string; text: boolean; name: string; from: string; by: string }

/**
 * The first measure's total at one level of the chart: `over` (the window over `rel` the compiler writes), or — for
 * a split's distinct count, whose series cells do not add up — the count again from rows, joined back on the key.
 */
export function totalAt(c: Ctx, again: boolean, over: string, at: Level): Total {
  if (!again) return { ctes: [], join: '', value: over };
  return {
    ctes: [countedCte(c, at.name, at.from, [at.by], ['lv_v0'])],
    join: ` JOIN ${at.name} ON ${nullSafeOn(`${at.rel}.${at.relKey}`, `${at.name}.lv_dk0`, at.text)}`,
    value: `${at.name}.lv_dv0`,
  };
}

/** `SELECT` `rel` with each total as its alias: `*` when nothing is joined, so a statement with no distinct count is unchanged. */
export function withTotals(rel: string, totals: [Total, string][]): string {
  const joins = totals.map(([t]) => t.join).join('');
  return `SELECT ${joins ? `${rel}.*` : '*'}, ${totals.map(([t, as]) => `${t.value} AS ${as}`).join(', ')} FROM ${rel}${joins}`;
}

/**
 * Every distinct count of a folded text axis, kept categories and "Other" alike, counted again from `lv_base` by the
 * folded key (`lv_fold` carries `lv_g` beside it) and the series, then joined onto `lv_out` as its `lv_b<i>d` parts.
 * Ends in `lv_outd`; `lv_bk` (the rows with their folded key, `lv_kk`) is there for the category total.
 */
export function foldedDistinct(c: Ctx, ms: LiveColumnMeasure[], split: boolean, seriesText: boolean): string[] {
  const ds = ms.flatMap((m, i) => (m.aggregation === 'countd' ? [i] : []));
  const by = split ? ['lv_kk', 'lv_s'] : ['lv_kk'];
  const on = nullSafeOn('lv_out.lv_k', 'lv_dk.lv_dk0', true) + (split ? ` AND ${nullSafeOn('lv_out.lv_s', 'lv_dk.lv_dk1', seriesText)}` : '');
  return [
    'lv_kmap AS (SELECT DISTINCT lv_g, lv_k FROM lv_fold)',
    `lv_bk AS (SELECT lv_kmap.lv_k AS lv_kk, lv_base.* FROM lv_base JOIN lv_kmap ON ${nullSafeOn('lv_base.lv_g', 'lv_kmap.lv_g', true)})`,
    countedCte(c, 'lv_dk', 'lv_bk', by, ds.map((i) => `lv_v${i}`)),
    `lv_outd AS (SELECT lv_out.*, ${ds.map((i, j) => `lv_dk.lv_dv${j} AS lv_b${i}d`).join(', ')} FROM lv_out JOIN lv_dk ON ${on})`,
  ];
}
