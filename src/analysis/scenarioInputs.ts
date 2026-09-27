// SCENARIOS — a column's aggregated inputs, per driver partition. PURE, MAIN
// PROCESS. THE REFERENCE: src/engine/scenarioResident.ts answers the same
// question off the stored Parquet file, and scripts/test-scenarios.ts asserts
// the two agree with Object.is.
//
// The scope is applied first, exactly as computeCardMetric's reference path
// applies it (transforms.applyPipeline). Each driver's filter then marks the
// rows it keeps — through the SAME filter step a dashboard filter runs, so a
// driver "in West" means what a West filter means, skipped-column rule
// included — and the rows are partitioned by that truth vector, in first-seen
// row order. Per partition: sum (a left fold in row order, as
// metricValue.computeMetric folds), finite numeric count, non-empty count,
// min and max. Nothing is copied back; the table is read, never changed.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import { applyPipeline, colIndex, isEmptyCell } from '../data/transforms';
import type { Partition } from './scenarioModel';

/** A position column no dataset can have: a NUL is not a legal header character. */
const ROW = '\u0000scenario-row';

/** Null when the column is not in the table, or there are no driver filters to partition by. */
export function scenarioInputsJs(
  columns: ParsedColumn[],
  rows: Cell[][],
  column: string,
  scope: FilterStep[],
  filters: Array<FilterStep | null>,
): Partition[] | null {
  if (colIndex(columns, column) < 0 || filters.length === 0) return null;
  const table = scope.length ? applyPipeline({ columns, rows }, scope) : { columns, rows };
  const ci = colIndex(table.columns, column);
  if (ci < 0) return null;

  const indexed = {
    columns: table.columns.concat([{ name: ROW, type: 'number' } as ParsedColumn]),
    rows: table.rows.map((r, i) => r.concat([i])),
  };
  const keeps = filters.map((f) => (f ? new Set(applyPipeline(indexed, [f]).rows.map((r) => r[r.length - 1] as number)) : null));

  const byKey = new Map<string, Partition>();
  const order: Partition[] = [];
  table.rows.forEach((r, i) => {
    const key = keeps.map((k) => !k || k.has(i));
    const id = key.map((b) => (b ? '1' : '0')).join('');
    let part = byKey.get(id);
    if (!part) {
      part = { key, pieces: { sum: 0, n: 0, nonEmpty: 0, min: null, max: null } };
      byKey.set(id, part);
      order.push(part);
    }
    const p = part.pieces;
    const v = r ? r[ci] : null;
    if (!isEmptyCell(v)) p.nonEmpty += 1;
    if (typeof v === 'number' && Number.isFinite(v)) {
      p.sum += v;
      p.n += 1;
      if (p.min === null || v < p.min) p.min = v;
      if (p.max === null || v > p.max) p.max = v;
    }
  });
  return order;
}
