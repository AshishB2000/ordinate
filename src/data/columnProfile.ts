// One column's median — MAIN PROCESS, PURE logic. No Electron, no DOM, no fs.
//
// WHY THIS FILE IS SO SMALL, AND WHY IT EXISTS AT ALL.
//
// The column-profile panel (renderer/hub/dsProfile.ts) shows type, distinct,
// empty, min/median/max, a histogram, top values and a by-month bar. Every one
// of those EXCEPT the median is already computed by something shipped:
//
//   type / min / max / distinct / nonEmpty   data/datasetStats.computeColumnSummary
//                                            (the `dataset:stats` the explorer
//                                            already fetches on open)
//   distinct on a NUMBER column              engine/datasetPage.readDistinctPage
//                                            (`dataset:distinct`, limit 0 → the
//                                            pre-cap total and no values)
//   histogram / top values / by-month        ipc/visuals.vizDataFor
//                                            (`visual:data`, one encoding each)
//
// So the panel is composed out of calls that already exist, and this module is
// the ONE gap: nothing in the app computes a quantile of a stored column. The
// alternative — adding `median` to `ColumnSummary` — would pay for a quantile
// over every numeric column on EVERY dataset open, to serve a panel that is
// only opened by a click on a header. The cost belongs on the click.
//
// THIS IS THE REFERENCE IMPLEMENTATION. `engine/medianResident.ts` answers the
// same question off the stored .parquet without hydrating a row, and
// `scripts/test-columnProfile.ts` asserts the two agree with `Object.is`.

import type { Cell } from './transforms';
import type { ParsedColumn } from './parse';
import { quantile } from '../analysis/anomalies';

/**
 * The median of a column's finite numeric cells, or `null` when there are none.
 *
 * `null` here means "there is no median" — an all-empty or all-text column —
 * and is a REAL answer, unlike the `null` from the resident twin, which always
 * means "fall back". The two conventions are deliberately different and the
 * caller in `ipc/datasets.ts` keeps them apart.
 *
 * Only a column DECLARED `number` is read numerically, matching every other
 * aggregate in this codebase: `TRY_CAST('007' AS DOUBLE)` is 7, so inferring
 * would silently turn a zero-padded id column into arithmetic.
 */
export function medianOf(columns: ParsedColumn[], rows: Cell[][], column: string): number | null {
  const cols = Array.isArray(columns) ? columns : [];
  const ci = cols.findIndex((c) => c && c.name === column);
  if (ci < 0) return null;
  if (cols[ci].type !== 'number') return null;

  const values: number[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = r ? r[ci] : null;
    if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return null;

  // `quantile` takes an ASCENDING array and is the type-7 interpolation the
  // anomaly detector uses; sorting here rather than inside it keeps that
  // contract where its other caller already relies on it.
  values.sort((a, b) => a - b);
  return quantile(values, 0.5);
}
