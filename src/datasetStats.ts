// Per-column summaries + dataset quality issues — MAIN PROCESS, PURE logic.
// No Electron, no DOM, no fs: every function here operates on the already-loaded
// dataset columns/rows handed in by the IPC layer, so it is node-testable by a
// plain `node` self-check (scripts/test-datasetStats.ts).
//
// Number-accuracy note: these are the ONLY numbers the app shows for a dataset's
// stats. The AI narrator (if used) is fed these figures as facts and must never
// compute its own — mirroring the analyze→compute→display contract.

import type { ColumnType } from './parse';

// A stored cell is the coerced value from Dataset.rows[*][colIndex]: a JS number
// for numeric columns, the original string for text/date, or null for empties.
type Cell = string | number | null;

export interface ColumnSummary {
  name: string;
  type: ColumnType;
  nonEmpty: number; // count of non-null / non-'' cells (all column types)
  // number columns:
  min?: number;
  max?: number;
  mean?: number;
  count?: number; // count of finite numeric cells (the mean's denominator)
  // text / date columns:
  distinct?: number;
  mostCommon?: { value: string; count: number } | null;
}

export interface QualityIssue {
  kind: 'empty_heavy' | 'duplicate_rows' | 'constant_column';
  column?: string; // set for column-scoped issues
  detail: string; // human-readable, safe to show as-is
  severity: 'info' | 'warn';
}

// Empty ratio at/above this flags a column as empty-heavy.
const EMPTY_HEAVY_RATIO = 0.5;

// A cell is empty when it is null or a blank/whitespace-only string. Numbers are
// never empty (0 is a real value).
function isEmpty(cell: Cell): boolean {
  if (cell == null) return true;
  return typeof cell === 'string' && cell.trim() === '';
}

// Stringify a non-empty cell for distinct/mode counting (numbers → their JS
// string form so "1.5" and 1.5 collapse identically).
function keyOf(cell: Cell): string {
  return typeof cell === 'number' ? String(cell) : (cell as string);
}

// Summarize one column's cells. Number columns get min/max/mean/count over their
// finite numeric cells; text/date columns get distinct count + the modal value.
// Every column type reports nonEmpty.
export function computeColumnSummary(
  column: { name: string; type: ColumnType },
  cells: Cell[],
): ColumnSummary {
  const list = Array.isArray(cells) ? cells : [];
  let nonEmpty = 0;
  for (const c of list) if (!isEmpty(c)) nonEmpty += 1;

  const summary: ColumnSummary = { name: column.name, type: column.type, nonEmpty };

  if (column.type === 'number') {
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const c of list) {
      if (typeof c === 'number' && Number.isFinite(c)) {
        count += 1;
        sum += c;
        if (c < min) min = c;
        if (c > max) max = c;
      }
    }
    summary.count = count;
    if (count > 0) {
      summary.min = min;
      summary.max = max;
      summary.mean = sum / count;
    }
    return summary;
  }

  // text | date → distinct + mode over stringified non-empty cells
  const counts = new Map<string, number>();
  for (const c of list) {
    if (isEmpty(c)) continue;
    const k = keyOf(c);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  summary.distinct = counts.size;
  let mostCommon: { value: string; count: number } | null = null;
  for (const [value, n] of counts) {
    if (!mostCommon || n > mostCommon.count) mostCommon = { value, count: n };
  }
  summary.mostCommon = mostCommon;
  return summary;
}

// Scan the whole table for non-blocking quality problems: empty-heavy columns,
// constant (single-value) columns, and fully-duplicate rows.
export function findQualityIssues(
  columns: { name: string; type: ColumnType }[],
  rows: Cell[][],
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const cols = Array.isArray(columns) ? columns : [];
  const body = Array.isArray(rows) ? rows : [];
  const rowCount = body.length;

  cols.forEach((col, c) => {
    let empties = 0;
    const distinct = new Set<string>();
    for (const row of body) {
      const cell = row ? row[c] : null;
      if (isEmpty(cell)) empties += 1;
      else distinct.add(keyOf(cell));
    }

    if (rowCount > 0 && empties / rowCount >= EMPTY_HEAVY_RATIO) {
      const pct = Math.round((empties / rowCount) * 100);
      issues.push({
        kind: 'empty_heavy',
        column: col.name,
        detail: `Column "${col.name}" is ${pct}% empty`,
        severity: 'warn',
      });
    }

    // Constant column: at most one distinct non-empty value across ≥1 row.
    if (rowCount > 0 && distinct.size <= 1 && empties < rowCount) {
      issues.push({
        kind: 'constant_column',
        column: col.name,
        detail: `Column "${col.name}" has the same value in every row`,
        severity: 'info',
      });
    }
  });

  // Fully-duplicate rows: identical across every column (order-sensitive key).
  const seen = new Set<string>();
  let dups = 0;
  for (const row of body) {
    const key = JSON.stringify(cols.map((_, c) => (row ? (row[c] ?? null) : null)));
    if (seen.has(key)) dups += 1;
    else seen.add(key);
  }
  if (dups > 0) {
    issues.push({
      kind: 'duplicate_rows',
      detail: dups === 1 ? '1 fully-duplicate row' : `${dups} fully-duplicate rows`,
      severity: 'info',
    });
  }

  return issues;
}
