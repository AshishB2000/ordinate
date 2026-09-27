// What a pivot cell SHOWS, once every figure is a real aggregate — PURE, MAIN
// PROCESS. Split out of pivotData.ts at its 800-line cap: that file folds the
// grouping sets into a grid; this one turns the grid's figures into what the
// cells display. Two ways, both run by `foldPivotGrid`, so the JS reference
// and the resident path cannot differ here:
//
//   `showAs` (Excel's "Show values as") — the original, moved here verbatim.
//   `calc` (table calculations, analysis/tableCalc.ts) — the richer option.
//          When a value has both, the calc wins and its `showAs` reads 'value'.
//
// A calc runs per cell, over the grid's own cells, with one extra input the
// grid alone cannot give: SOURCE totals. `at(rowPath, colPath)` reads any
// grouping set the fold was handed, so percent-of-total divides by a column
// total, a row total or a subtotal recomputed from the rows — never by the sum
// of shares, which for `avg` (a mean of means) would be a different number.
// `calcSets` names the extra grouping sets that needs, and `pivotSets` asks for
// them, so both paths compute them.

import type { PivotEncoding, PivotGrid, PivotSet } from './pivotData';
import { calcSequence, sanitizeTableCalc } from './tableCalc';
import type { TableCalc } from './tableCalc';
import { shiftBucketLabel } from './dateIntel';
import type { DateGrain } from './categoryKey';

// ── Show values as ───────────────────────────────────────────────────────────
//
// Applied to `cells` in place, AFTER every figure is a real aggregate — a
// percentage of a subtotal is still a ratio of two app-computed numbers, and a
// rank is a position among them. Totals are left as figures: "100%" in a Total
// column says nothing, and a rank of a total is meaningless.

export function applyShowAs(grid: PivotGrid): void {
  const V = grid.valueCount;
  if (!grid.showAs.some((s) => s !== 'value')) return;
  const source = grid.cells.map((r) => r.slice());
  const cols = grid.cells.length ? grid.cells[0].length : 0;

  for (let vi = 0; vi < V; vi += 1) {
    const mode = grid.showAs[vi];
    if (mode === 'value') continue;
    const colsOfValue: number[] = [];
    for (let c = vi; c < cols; c += V) colsOfValue.push(c);

    if (mode === 'pct_row') {
      for (let r = 0; r < source.length; r += 1) {
        const total = sumOf(colsOfValue.map((c) => source[r][c]));
        for (const c of colsOfValue) grid.cells[r][c] = ratio(source[r][c], total);
      }
    } else if (mode === 'pct_col') {
      for (const c of colsOfValue) {
        const total = sumOf(leafValues(grid, source, c));
        for (let r = 0; r < source.length; r += 1) grid.cells[r][c] = ratio(source[r][c], total);
      }
    } else if (mode === 'pct_total') {
      const all: (number | null)[] = [];
      for (const c of colsOfValue) all.push(...leafValues(grid, source, c));
      const total = sumOf(all);
      for (let r = 0; r < source.length; r += 1) {
        for (const c of colsOfValue) grid.cells[r][c] = ratio(source[r][c], total);
      }
    } else if (mode === 'rank') {
      for (const c of colsOfValue) rankColumn(grid, source, c);
    }
  }
}

/** Only LEAF rows contribute to a column's denominator — a subtotal would double-count. */
function leafValues(grid: PivotGrid, source: (number | null)[][], c: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let r = 0; r < source.length; r += 1) if (grid.rowKinds[r] === 'leaf') out.push(source[r][c]);
  return out;
}

function sumOf(vals: (number | null)[]): number | null {
  let total = 0;
  let seen = false;
  for (const v of vals) if (v !== null) { total += v; seen = true; }
  return seen ? total : null;
}

function ratio(v: number | null, total: number | null): number | null {
  if (v === null || total === null || total === 0) return null;
  return v / total;
}

/**
 * Dense competition ranking, 1 = largest, over the LEAF rows of one column.
 * Ties share a rank (the spec's "rank ties"); nulls stay null rather than
 * ranking last, because a missing figure has no position.
 */
function rankColumn(grid: PivotGrid, source: (number | null)[][], c: number): void {
  const entries: Array<{ r: number; v: number }> = [];
  for (let r = 0; r < source.length; r += 1) {
    if (grid.rowKinds[r] !== 'leaf') { grid.cells[r][c] = null; continue; }
    const v = source[r][c];
    if (v === null) { grid.cells[r][c] = null; continue; }
    entries.push({ r, v });
  }
  entries.sort((a, b) => b.v - a.v);
  let rank = 0;
  let prev: number | null = null;
  for (const e of entries) {
    if (prev === null || e.v !== prev) { rank += 1; prev = e.v; }
    grid.cells[e.r][c] = rank;
  }
}

// ── Table calculations ───────────────────────────────────────────────────────

/** Which axis a calc runs along, and the depth (index) of the dimension it restarts at, −1 for none. */
interface PivotDir { axis: 'rows' | 'cols'; restart: number; date: number }

function resolveDir(calc: TableCalc, enc: PivotEncoding, note: (w: string) => void): PivotDir {
  const rowAt = (name: string): number => enc.rows.findIndex((d) => d.column === name);
  const colAt = (name: string): number => enc.columns.findIndex((d) => d.column === name);
  let axis: 'rows' | 'cols' = calc.along === 'across' ? 'cols' : 'rows';
  let implicit = -1;
  let named = -1;
  if (typeof calc.along === 'object') {
    const ri = rowAt(calc.along.dimension);
    const ci = colAt(calc.along.dimension);
    if (ri >= 0) { axis = 'rows'; implicit = ri - 1; named = ri; }
    else if (ci >= 0) { axis = 'cols'; implicit = ci - 1; named = ci; }
    else note(`The table calculation's dimension "${calc.along.dimension}" is not in this pivot, so it runs down the table.`);
  }
  let restart = implicit;
  if (calc.restart) {
    const onAxis = axis === 'rows' ? rowAt(calc.restart) : colAt(calc.restart);
    const other = axis === 'rows' ? colAt(calc.restart) : rowAt(calc.restart);
    if (onAxis >= 0) restart = onAxis;
    else if (other < 0) note(`The table calculation's restart "${calc.restart}" is not in this pivot, so it was ignored.`);
  }
  // Year over year shifts a DATE dimension rolled up by grain: the one named in
  // `along` when it is one, else the outermost grained dimension on the axis.
  const dims = axis === 'rows' ? enc.rows : enc.columns;
  const date = named >= 0 && dims[named].grain ? named : dims.findIndex((d) => !!d.grain);
  return { axis, restart, date };
}

/** The extra grouping sets percent-of-total's source denominators need. */
export function calcSets(enc: PivotEncoding): PivotSet[] {
  const R = enc.rows.length;
  const C = enc.columns.length;
  const out: PivotSet[] = [];
  for (const v of enc.values) {
    const calc = sanitizeTableCalc(v.calc);
    if (!calc || calc.kind !== 'pct_of_total') continue;
    const dir = resolveDir(calc, enc, () => undefined);
    if (dir.axis === 'rows') out.push({ rowDims: 0, colDims: C });
    else {
      const q = dir.restart >= 0 ? Math.min(dir.restart + 1, C) : 0;
      for (let k = 1; k <= R; k += 1) out.push({ rowDims: k, colDims: q });
    }
  }
  return out;
}

type At = (rowPath: string[], colPath: string[]) => (number | null)[] | null;

const key = (parts: string[]): string => JSON.stringify(parts);

/**
 * Apply every value's calc to `grid.cells`, in place. Leaves the grid exactly
 * as it was when no value has a calc; otherwise attaches `calcs` (per value),
 * `rawCells` (the figures before any calc) and, when something was ignored,
 * `calcWarnings`. Totals stay figures, as they do under `showAs`.
 */
export function applyPivotCalcs(grid: PivotGrid, enc: PivotEncoding, colPaths: string[][], at: At): void {
  const V = grid.valueCount;
  const calcs = enc.values.map((v) => sanitizeTableCalc(v.calc) || null);
  if (!calcs.some(Boolean)) return;
  const raw = grid.cells.map((r) => r.slice());
  const warnings: string[] = [];
  const note = (w: string): void => { if (!warnings.includes(w)) warnings.push(w); };
  const C = enc.columns.length;

  calcs.forEach((calc, vi) => {
    if (!calc) return;
    grid.showAs[vi] = 'value';
    const dir = resolveDir(calc, enc, note);
    const dims = dir.axis === 'rows' ? enc.rows : enc.columns;
    if (calc.kind === 'yoy' && dir.date < 0) note('Year over year needs a date dimension rolled up by year, quarter or month.');
    const grain = dir.date >= 0 ? (dims[dir.date].grain as DateGrain) : null;
    const shifted = (path: string[]): string[] | null => {
      if (grain === null || path.length <= dir.date) return null;
      const label = shiftBucketLabel(path[dir.date], grain);
      if (label === null) return null;
      const out = path.slice();
      out[dir.date] = label;
      return out;
    };
    const figure = (rp: string[] | null, cp: string[] | null): number | null => {
      if (!rp || !cp) return null;
      const vals = at(rp, cp);
      return vals ? (vals[vi] ?? null) : null;
    };
    const run = (cells: Array<{ r: number; c: number }>, rowPart: string[], colPart: string[]): void => {
      const values = cells.map((x) => raw[x.r][x.c]);
      const res = calcSequence(calc.kind, values, {
        window: calc.window,
        total: calc.kind === 'pct_of_total' ? figure(rowPart, colPart) : undefined,
        prior: calc.kind === 'yoy'
          ? cells.map((x) => {
            const rp = grid.rowHeaders[x.r];
            const cp = colPaths[Math.floor(x.c / V)];
            return dir.axis === 'rows' ? figure(shifted(rp), cp) : figure(rp, shifted(cp));
          })
          : undefined,
      });
      cells.forEach((x, k) => { grid.cells[x.r][x.c] = res[k]; });
    };

    if (dir.axis === 'rows') {
      // Down, among PEERS: same column group, same level, same restart prefix.
      colPaths.forEach((cp, ci) => {
        const groups = new Map<string, { prefix: string[]; cells: Array<{ r: number; c: number }> }>();
        grid.rowHeaders.forEach((path, r) => {
          const p = dir.restart >= 0 ? Math.min(dir.restart + 1, path.length - 1) : 0;
          const prefix = path.slice(0, p);
          const k = path.length + '|' + key(prefix);
          let g = groups.get(k);
          if (!g) groups.set(k, (g = { prefix, cells: [] }));
          g.cells.push({ r, c: ci * V + vi });
        });
        groups.forEach((g) => run(g.cells, g.prefix, cp));
      });
    } else {
      // Across: within each grid row, along the column groups.
      const q = dir.restart >= 0 ? Math.min(dir.restart + 1, C) : 0;
      grid.rowHeaders.forEach((path, r) => {
        const groups = new Map<string, { prefix: string[]; cells: Array<{ r: number; c: number }> }>();
        colPaths.forEach((cp, ci) => {
          const prefix = cp.slice(0, q);
          const k = key(prefix);
          let g = groups.get(k);
          if (!g) groups.set(k, (g = { prefix, cells: [] }));
          g.cells.push({ r, c: ci * V + vi });
        });
        groups.forEach((g) => run(g.cells, path, g.prefix));
      });
    }
  });

  grid.calcs = calcs;
  grid.rawCells = raw;
  if (warnings.length) grid.calcWarnings = warnings;
}
