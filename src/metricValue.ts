// The ONE number a dashboard metric card displays — MAIN PROCESS, PURE logic.
// No Electron, no DOM, no fs: it operates on the already-loaded dataset
// columns/rows handed in by the IPC layer, so it is node-testable by a plain
// `node` self-check (scripts/test-metricValue.ts).
//
// Strict number rule (a core promise of the app): sum/avg/min/max participate
// ONLY over finite JS numbers — anything else is ignored, and no numeric cells
// means null (NEVER NaN). count matches transforms.aggregate's count semantics:
// the number of NON-EMPTY cells in the column (text included). An unknown
// column, an unknown aggregation, or an empty column all yield null. This is
// the single-function analogue of the group-less path in transforms.aggregate()
// / the numeric branch of datasetStats.computeColumnSummary().

import type { ParsedColumn } from './parse';

// A stored cell is the coerced value from Dataset.rows[*][colIndex]: a JS number
// for numeric columns, the original string for text/date, or null for empties.
type Cell = string | number | null;

export type MetricAggregation = 'sum' | 'avg' | 'count' | 'min' | 'max';

const AGG_FNS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);

// A cell is empty when it is null or a blank/whitespace-only string. Numbers are
// never empty (0 is a real value). Mirrors datasetStats.isEmpty.
function isEmptyCell(cell: Cell): boolean {
  if (cell == null) return true;
  return typeof cell === 'string' && cell.trim() === '';
}

function colIndex(columns: ParsedColumn[], name: string): number {
  if (!Array.isArray(columns)) return -1;
  for (let i = 0; i < columns.length; i += 1) {
    if (columns[i] && columns[i].name === name) return i;
  }
  return -1;
}

// columns + rows + {column, aggregation} → the single app-computed number, or
// null. count → non-empty cell count; sum/avg/min/max → over finite numeric
// cells only (none → null). Unknown column / unknown agg / no rows → null.
export function computeMetric(
  columns: ParsedColumn[],
  rows: Cell[][],
  spec: { column: string; aggregation: MetricAggregation },
): number | null {
  if (!spec || typeof spec.column !== 'string' || !AGG_FNS.has(spec.aggregation)) return null;
  const ci = colIndex(columns, spec.column);
  if (ci < 0) return null;
  const body = Array.isArray(rows) ? rows : [];

  if (spec.aggregation === 'count') {
    let count = 0;
    for (const r of body) if (r && !isEmptyCell(r[ci])) count += 1;
    return count;
  }

  const nums: number[] = [];
  for (const r of body) {
    const v = r ? r[ci] : null;
    if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
  }
  if (nums.length === 0) return null;

  switch (spec.aggregation) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    // reduce, not Math.min(...nums)/Math.max(...nums): a large column (100k+
    // rows from an xlsx/pg import) would blow the argument-spread limit and throw
    // RangeError, hiding a correct value behind a "—".
    case 'min':
      return nums.reduce((a, b) => (b < a ? b : a));
    case 'max':
      return nums.reduce((a, b) => (b > a ? b : a));
    default:
      return null;
  }
}
