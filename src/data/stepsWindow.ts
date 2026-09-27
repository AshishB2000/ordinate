// The window step — row_number, lag/lead, running sum/avg over partitions in an
// order. MAIN PROCESS, PURE: the JS REFERENCE for sqlGenPower's window SQL.
//
// ORDER. Within a partition rows sort on `orderBy` (a number column
// numerically, anything else as text), NULLS LAST in both directions, and every
// tie breaks on the stored row order — so the fold and SQL (which ends its
// window ORDER BY with the ordinal) can never disagree about who is "previous".
// Rows keep their stored order in the output; only the new column is computed.

import type { Cell, TableData } from './transforms';
import { colIndex } from './transforms';
import type { ParsedColumn } from './parse';
import type { WindowStep } from './stepTypes';
import { rankValue } from './stepsClean';
import type { PowerResult } from './stepsReshape';
import { skipped } from './stepsReshape';

export function windowProblem(columns: ParsedColumn[], s: WindowStep): string | null {
  const as = typeof s.as === 'string' ? s.as.trim() : '';
  if (!as) return 'Window skipped: blank column name';
  if (colIndex(columns, as) >= 0) return `Window skipped: column "${as}" already exists`;
  if (s.fn !== 'row_number' && colIndex(columns, s.column || '') < 0) return `Window skipped: unknown column "${s.column || ''}"`;
  const missing = (s.partitionBy || []).filter((p) => colIndex(columns, p) < 0);
  if (missing.length) return `Window skipped: unknown partition column(s): ${missing.join(', ')}`;
  if (s.orderBy && colIndex(columns, s.orderBy) < 0) return `Window skipped: unknown column "${s.orderBy}"`;
  return null;
}

/** The new column's declared type: a copy's source type for lag/lead, else number. */
export function windowType(columns: ParsedColumn[], s: WindowStep): ParsedColumn['type'] {
  return s.fn === 'lag' || s.fn === 'lead' ? columns[colIndex(columns, s.column || '')].type : 'number';
}

export function applyWindow(t: TableData, s: WindowStep): PowerResult {
  const problem = windowProblem(t.columns, s);
  if (problem) return skipped(t, problem);
  const pi = (s.partitionBy || []).map((p) => colIndex(t.columns, p));
  const oi = s.orderBy ? colIndex(t.columns, s.orderBy) : -1;
  const vi = s.fn === 'row_number' ? -1 : colIndex(t.columns, s.column || '');
  const offset = Math.max(1, Math.floor(s.offset || 1));

  const parts = new Map<string, number[]>();
  t.rows.forEach((r, i) => {
    const key = JSON.stringify(pi.map((k) => r[k] ?? null));
    const list = parts.get(key);
    if (list) list.push(i);
    else parts.set(key, [i]);
  });
  const otype = oi >= 0 ? t.columns[oi].type : 'text';
  const rank = (i: number): number | string | null => (oi >= 0 ? rankValue(t.rows[i][oi] ?? null, otype) : null);

  const out: Cell[] = new Array(t.rows.length).fill(null);
  for (const list of parts.values()) {
    const sorted = oi < 0 ? list : list.slice().sort((a, b) => {
      const va = rank(a);
      const vb = rank(b);
      if (va === null || vb === null) return va === vb ? a - b : va === null ? 1 : -1;
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return (s.desc ? -cmp : cmp) || a - b;
    });
    let sum = 0;
    let count = 0;
    sorted.forEach((i, pos) => {
      if (s.fn === 'row_number') { out[i] = pos + 1; return; }
      if (s.fn === 'lag' || s.fn === 'lead') {
        const j = s.fn === 'lag' ? pos - offset : pos + offset;
        out[i] = j >= 0 && j < sorted.length ? t.rows[sorted[j]][vi] ?? null : null;
        return;
      }
      const v = t.rows[i][vi];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
        count += 1;
      }
      out[i] = count === 0 ? null : s.fn === 'running_sum' ? sum : sum / count;
    });
  }
  const columns = [...t.columns.map((c) => ({ ...c })), { name: s.as.trim(), type: windowType(t.columns, s) }];
  const rows = t.rows.map((r, i) => [...r, out[i]]);
  return { table: { columns, rows }, warnings: [] };
}
