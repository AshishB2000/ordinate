// The workbench's vectors, read from a HYDRATED table — MAIN PROCESS, PURE.
// The reference implementation for src/engine/statsVectors.ts, which reads the
// same vectors straight off the stored Parquet; scripts/test-statsVectors.ts
// asserts the two agree with Object.is, cell for cell.
//
// The rules, in one place:
//   number  a finite JS number, else null. Only a column DECLARED number is
//           ever read this way (spec.vectorNeeds checks the type first).
//   label   a number column's finite number as String(n); any other column's
//           cell verbatim (untrimmed), with empty — null, '' or whitespace —
//           as null.
//   rows    file order, after the dashboard filters (transforms.applyPipeline,
//           the same pipeline every card's JS path runs).

import type { ParsedColumn } from '../../data/parse';
import type { Cell, FilterStep } from '../../data/transforms';
import { applyPipeline, isEmptyCell } from '../../data/transforms';
import type { VectorNeed } from './spec';
import type { StatsVectors } from './run';

const finite = (c: Cell): number | null => (typeof c === 'number' && Number.isFinite(c) ? c : null);

export function loadVectorsJs(columns: ParsedColumn[], rows: Cell[][], needs: readonly VectorNeed[], filters: FilterStep[] = []): StatsVectors | null {
  const table = filters.length ? applyPipeline({ columns, rows }, filters) : { columns, rows };
  const out: StatsVectors = { rows: table.rows.length, number: new Map(), label: new Map() };
  for (const need of needs) {
    const ci = table.columns.findIndex((c) => c.name === need.column);
    if (ci < 0) return null;
    const isNum = table.columns[ci].type === 'number';
    if (need.as === 'number') {
      if (!isNum) return null;
      out.number.set(need.column, table.rows.map((r) => finite(r ? r[ci] ?? null : null)));
      continue;
    }
    out.label.set(need.column, table.rows.map((r) => {
      const c = r ? r[ci] ?? null : null;
      if (isNum) { const n = finite(c); return n === null ? null : String(n); }
      return isEmptyCell(c) ? null : String(c);
    }));
  }
  return out;
}
