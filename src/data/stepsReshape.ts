// Reshape steps — split_column, unpivot, pivot. MAIN PROCESS, PURE: the JS
// REFERENCE that src/engine/sqlGenReshape.ts must reproduce cell for cell
// (scripts/test-powerStepsDuck.ts holds the two to Object.is).
//
// Every step builds a new table and never touches its input. A missing column
// SKIPS the step with a warning — the transforms.ts contract. Derived text
// columns are typed through parse (retypeColumn), so a split part of "007"
// stays text; app-computed aggregates are declared `number`.

import type { Cell, TableData, AggFn } from './transforms';
import { colIndex, cellToString, isEmptyCell, retypeColumn } from './transforms';
import type { ParsedColumn } from './parse';
import type { PivotStep, SplitColumnStep, UnpivotStep } from './stepTypes';
import { MAX_PIVOT_COLUMNS } from './stepTypes';
import { checkRegex, regexSplitter } from './regexSubset';
import type { RegexMemo } from './regexMemo';
import { inlineRegexRefused, regexRefusedWarning } from './regexMemo';

export interface PowerResult {
  table: TableData;
  warnings: string[];
}

export function skipped(t: TableData, warning: string): PowerResult {
  return { table: t, warnings: [warning] };
}

// ── split_column ─────────────────────────────────────────────────────────────

/** The part names a column split produces — also used by sqlGen and the editor. */
export function splitNames(column: string, count: number): string[] {
  return Array.from({ length: count }, (_, k) => `${column}_${k + 1}`);
}

/** How many parts `into: 'columns'` makes: the cut count + 1 for positions. */
export function splitWidth(s: SplitColumnStep): number {
  return s.mode === 'position' ? (s.positions || []).length + 1 : Math.max(1, Math.floor(s.count || 0));
}

/** A split step's validity, as the warning the step would skip with (or null). */
export function splitProblem(s: SplitColumnStep): string | null {
  if (s.mode === 'delimiter' && !s.delimiter) return 'Split skipped: the delimiter is empty';
  if (s.mode === 'position') {
    const p = s.positions || [];
    if (!p.length || p.some((x, k) => !Number.isInteger(x) || x <= 0 || (k > 0 && x <= p[k - 1]))) {
      return 'Split skipped: positions must be whole numbers above 0, in increasing order';
    }
  }
  if (s.mode === 'regex') {
    const r = checkRegex(s.pattern);
    if (!r.ok) return `Split skipped: ${r.error}`;
  }
  return null;
}

function partsOf(text: string, s: SplitColumnStep, regex: ((text: string) => string[]) | null): string[] {
  if (s.mode === 'delimiter') return text.split(s.delimiter as string);
  if (s.mode === 'regex') return (regex as (text: string) => string[])(text);
  // Code points, as DuckDB's substring counts — an emoji is ONE character.
  const cps = Array.from(text);
  const cuts = [0, ...(s.positions as number[])];
  return cuts.map((a, k) => cps.slice(a, k + 1 < cuts.length ? cuts[k + 1] : undefined).join(''));
}

/** `memo`: each cell text's parts from the regex worker (./regexMemo.ts) — required for a regex split on the server. */
export function applySplit(t: TableData, s: SplitColumnStep, memo?: RegexMemo): PowerResult {
  const ci = colIndex(t.columns, s.column);
  if (ci < 0) return skipped(t, `Split skipped: unknown column "${s.column}"`);
  const problem = splitProblem(s);
  if (problem) return skipped(t, problem);
  if (s.mode === 'regex' && !memo && inlineRegexRefused(t.rows.length)) return skipped(t, regexRefusedWarning());
  const re = s.mode !== 'regex' ? null : memo ? (x: string) => memo.get(x) as string[] : regexSplitter(s.pattern as string, !!s.ignoreCase);

  if (s.into === 'rows') {
    const columns = t.columns.map((c) => ({ ...c }));
    const rows: Cell[][] = [];
    for (const r of t.rows) {
      const cell = r[ci] ?? null;
      // A null cell stays ONE row (with a null part): splitting never drops a row.
      const parts: Cell[] = cell === null ? [null] : partsOf(cellToString(cell), s, re);
      for (const p of parts) {
        const out = r.slice();
        out[ci] = p;
        rows.push(out);
      }
    }
    retypeColumn(columns, rows, ci);
    return { table: { columns, rows }, warnings: [] };
  }

  const n = splitWidth(s);
  const names = splitNames(s.column, n);
  const clash = names.find((nm) => t.columns.some((c, k) => k !== ci && c.name === nm));
  if (clash) return skipped(t, `Split skipped: column "${clash}" already exists`);
  const columns: ParsedColumn[] = [
    ...t.columns.slice(0, ci).map((c) => ({ ...c })),
    ...names.map((name) => ({ name, type: 'text' as const })),
    ...t.columns.slice(ci + 1).map((c) => ({ ...c })),
  ];
  const rows: Cell[][] = t.rows.map((r) => {
    const cell = r[ci] ?? null;
    const parts = cell === null ? [] : partsOf(cellToString(cell), s, re);
    // Parts beyond N are dropped; missing parts are null.
    const cells: Cell[] = names.map((_, k) => (k < parts.length ? parts[k] : null));
    return [...r.slice(0, ci), ...cells, ...r.slice(ci + 1)];
  });
  for (let k = 0; k < n; k += 1) retypeColumn(columns, rows, ci + k);
  return { table: { columns, rows }, warnings: [] };
}

// ── unpivot ──────────────────────────────────────────────────────────────────

/** The two new names must differ from each other and from every kept column. */
export function unpivotNameProblem(kept: string[], attr: string, val: string): string | null {
  if (attr === val) return 'Unpivot skipped: the attribute and value columns need different names';
  const dup = [attr, val].find((nm) => kept.includes(nm));
  return dup === undefined ? null : `Unpivot skipped: "${dup}" is already a column name`;
}

export function applyUnpivot(t: TableData, s: UnpivotStep): PowerResult {
  const warnings: string[] = [];
  const idx: number[] = [];
  for (const name of s.columns) {
    const ci = colIndex(t.columns, name);
    if (ci < 0) warnings.push(`Unpivot: unknown column "${name}" ignored`);
    else if (!idx.includes(ci)) idx.push(ci);
  }
  if (!idx.length) return skipped(t, 'Unpivot skipped: none of the chosen columns exist');
  const attr = (s.attribute || 'attribute').trim() || 'attribute';
  const val = (s.value || 'value').trim() || 'value';
  const keep = t.columns.map((_, k) => k).filter((k) => !idx.includes(k));
  const problem = unpivotNameProblem(keep.map((k) => t.columns[k].name), attr, val);
  if (problem) return { table: t, warnings: [...warnings, problem] };
  // One declared type across the unpivoted columns is kept as-is; a mix is
  // re-detected from the values, exactly as a derived column always is.
  const types = [...new Set(idx.map((k) => t.columns[k].type))];
  const columns: ParsedColumn[] = [
    ...keep.map((k) => ({ ...t.columns[k] })),
    { name: attr, type: 'text' },
    { name: val, type: types.length === 1 ? types[0] : 'text' },
  ];
  const rows: Cell[][] = [];
  for (const r of t.rows) {
    const base = keep.map((k) => r[k] ?? null);
    for (const k of idx) rows.push([...base, t.columns[k].name, r[k] ?? null]);
  }
  if (types.length > 1) retypeColumn(columns, rows, columns.length - 1);
  return { table: { columns, rows }, warnings };
}

// ── pivot ────────────────────────────────────────────────────────────────────

/** Distinct non-empty keys in first-seen order, and how many there were in all. */
export function pivotKeys(t: TableData, keyIndex: number): { keys: string[]; distinct: number } {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const r of t.rows) {
    const cell = r[keyIndex] ?? null;
    if (isEmptyCell(cell)) continue;
    const k = cellToString(cell);
    if (seen.has(k)) continue;
    seen.add(k);
    if (keys.length < MAX_PIVOT_COLUMNS) keys.push(k);
  }
  return { keys, distinct: seen.size };
}

export function pivotCapWarning(key: string, distinct: number): string {
  return `Pivot: "${key}" has ${distinct} distinct values; only the first ${MAX_PIVOT_COLUMNS} became columns`;
}

/** The guard every engine runs before any work — the skip warning, or null. */
export function pivotProblem(columns: ParsedColumn[], s: PivotStep): string | null {
  if (colIndex(columns, s.key) < 0) return `Pivot skipped: unknown column "${s.key}"`;
  if (colIndex(columns, s.value) < 0) return `Pivot skipped: unknown column "${s.value}"`;
  const missing = s.groupBy.filter((g) => colIndex(columns, g) < 0);
  if (missing.length) return `Pivot skipped: unknown group column(s): ${missing.join(', ')}`;
  if (s.key === s.value || s.groupBy.includes(s.key) || s.groupBy.includes(s.value)) {
    return 'Pivot skipped: the key, the value and the group columns must all be different';
  }
  return null;
}

export function pivotClash(groupBy: string[], keys: string[]): string | null {
  const hit = keys.find((k) => groupBy.includes(k));
  return hit === undefined ? null : `Pivot skipped: the value "${hit}" would duplicate the column "${hit}"`;
}

function aggregateCells(cells: Cell[], fn: AggFn): Cell {
  if (fn === 'count') return cells.filter((v) => !isEmptyCell(v)).length;
  const nums = cells.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  if (fn === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (fn === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (fn === 'min') return nums.reduce((a, b) => (b < a ? b : a));
  return nums.reduce((a, b) => (b > a ? b : a));
}

export function applyPivot(t: TableData, s: PivotStep): PowerResult {
  const problem = pivotProblem(t.columns, s);
  if (problem) return skipped(t, problem);
  const ki = colIndex(t.columns, s.key);
  const vi = colIndex(t.columns, s.value);
  const gi = s.groupBy.map((g) => colIndex(t.columns, g));
  const { keys, distinct } = pivotKeys(t, ki);
  const clash = pivotClash(s.groupBy, keys);
  if (clash) return skipped(t, clash);
  const warnings = distinct > keys.length ? [pivotCapWarning(s.key, distinct)] : [];

  // Groups in first-seen order; per group, the value cells of each key.
  const groups: Array<{ cells: Cell[]; byKey: Map<string, Cell[]> }> = [];
  const index = new Map<string, number>();
  const kept = new Set(keys);
  for (const r of t.rows) {
    const cells = gi.map((k) => r[k] ?? null);
    const id = JSON.stringify(cells);
    let g = index.get(id);
    if (g === undefined) {
      g = groups.length;
      index.set(id, g);
      groups.push({ cells, byKey: new Map() });
    }
    const kc = r[ki] ?? null;
    if (isEmptyCell(kc)) continue;
    const k = cellToString(kc);
    if (!kept.has(k)) continue;
    const list = groups[g].byKey.get(k);
    if (list) list.push(r[vi] ?? null);
    else groups[g].byKey.set(k, [r[vi] ?? null]);
  }
  const columns: ParsedColumn[] = [
    ...gi.map((k) => ({ ...t.columns[k] })),
    ...keys.map((name) => ({ name, type: 'number' as const })),
  ];
  const rows: Cell[][] = groups.map((g) => [
    ...g.cells,
    ...keys.map((k) => {
      const list = g.byKey.get(k);
      return list ? aggregateCells(list, s.fn) : null;
    }),
  ]);
  return { table: { columns, rows }, warnings };
}
