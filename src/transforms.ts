// Reversible transform pipeline — MAIN PROCESS, PURE logic.
// No Electron, no fs, no DOM: `applyPipeline` folds an ordered list of steps over
// an immutable `source` table and returns the derived output, so it is
// node-testable by a plain `node` self-check (scripts/test-transforms.ts).
//
// Core invariants:
//   1. The input `source` is NEVER mutated (deep-copied first). Removing a step
//      recomputes the output from the untouched source → fully reversible.
//   2. A broken/unknown step is SKIPPED with a warning, never throws — so one bad
//      step can't break reversibility; the user can edit or remove it.
//   3. Number-accuracy: the model never computes values. `calculated_field` runs
//      our safe evaluator (src/formula.ts); every computed/derived column is typed
//      via parse.detectColumnType (the STRICT isFiniteNumber gate) and coerced via
//      parse.coerceValue, so "007"/zips/>15-digit ids never corrupt to numbers.

import type { ParsedColumn } from './parse';
import { detectColumnType, coerceValue } from './parse';
import { compile } from './formula';
import type { FValue } from './formula';

// ── Shared shapes ────────────────────────────────────────────────────────────

export type Cell = string | number | null;

export interface TableData {
  columns: ParsedColumn[];
  rows: Cell[][];
}

export interface ApplyResult {
  columns: ParsedColumn[];
  rows: Cell[][];
  rowCount: number;
  warnings: string[];
}

// ── TransformStep union (single-source steps only) ───────────────────────────

export type FilterOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'is_empty' | 'not_empty';
export type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max';
export interface Aggregation {
  column: string;
  fn: AggFn;
  as: string;
}

export interface CalculatedFieldStep {
  type: 'calculated_field';
  name: string;
  expression: string;
}
export interface FilterStep {
  type: 'filter';
  column: string;
  op: FilterOp;
  value?: Cell;
}
export interface GroupAggregateStep {
  type: 'group_aggregate';
  groupBy: string[];
  aggregations: Aggregation[];
}
export interface DedupeStep {
  type: 'dedupe';
  columns?: string[]; // omitted => all columns
}
export interface FillEmptyStep {
  type: 'fill_empty';
  column: string;
  value: string | number;
}
export interface TrimStep {
  type: 'trim';
  column?: string; // omitted => all text columns
}
export interface DropColumnStep {
  type: 'drop_column';
  column: string;
}
export interface RenameColumnStep {
  type: 'rename_column';
  from: string;
  to: string;
}

export type TransformStep =
  | CalculatedFieldStep
  | FilterStep
  | GroupAggregateStep
  | DedupeStep
  | FillEmptyStep
  | TrimStep
  | DropColumnStep
  | RenameColumnStep;

export type StepType = TransformStep['type'];

// ── Small helpers ────────────────────────────────────────────────────────────

const FILTER_OPS: ReadonlySet<string> = new Set(['=', '!=', '>', '<', '>=', '<=', 'contains', 'is_empty', 'not_empty']);
const AGG_FNS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
const STEP_TYPES: ReadonlySet<string> = new Set([
  'calculated_field',
  'filter',
  'group_aggregate',
  'dedupe',
  'fill_empty',
  'trim',
  'drop_column',
  'rename_column',
]);

function colIndex(columns: ParsedColumn[], name: string): number {
  return columns.findIndex((c) => c.name === name);
}

function isEmptyCell(cell: Cell): boolean {
  if (cell == null) return true;
  return typeof cell === 'string' && cell.trim() === '';
}

function cellToString(cell: Cell): string {
  return cell == null ? '' : String(cell);
}

// Re-run detectColumnType over a column's stringified cells (the STRICT-number
// path), set the column's type, then coerce every cell to match. Mutates the
// (freshly-built, caller-owned) columns/rows arrays. Used after calculated_field
// and fill_empty, and for combine outputs.
function retypeColumn(columns: ParsedColumn[], rows: Cell[][], c: number): void {
  const strCells = rows.map((r) => cellToString(r[c]));
  const type = detectColumnType(strCells);
  columns[c] = { ...columns[c], type };
  for (const r of rows) r[c] = coerceValue(r[c] ?? null, type);
}

// Deep-copy a table so no step ever touches the input (source-immutability).
function cloneTable(t: TableData): TableData {
  return {
    columns: t.columns.map((c) => ({ ...c })),
    rows: t.rows.map((r) => r.slice()),
  };
}

interface StepResult {
  table: TableData;
  warnings: string[];
}

function skip(t: TableData, warning: string): StepResult {
  return { table: t, warnings: [warning] };
}

// ── applyPipeline ────────────────────────────────────────────────────────────

// Fold each step left→right over a deep copy of `source`, accumulating warnings.
// A step referencing a missing column is skipped with a warning (never throws).
export function applyPipeline(source: TableData, steps: TransformStep[]): ApplyResult {
  let table = cloneTable(source);
  const warnings: string[] = [];
  const list = Array.isArray(steps) ? steps : [];

  for (const step of list) {
    let result: StepResult;
    try {
      result = dispatch(table, step);
    } catch (e) {
      // Defense in depth: no step should throw, but if one does, skip it.
      const msg = e instanceof Error ? e.message : 'unknown error';
      result = skip(table, `Step "${step && step.type}" skipped: ${msg}`);
    }
    table = result.table;
    for (const w of result.warnings) warnings.push(w);
  }

  return { columns: table.columns, rows: table.rows, rowCount: table.rows.length, warnings };
}

function dispatch(t: TableData, step: TransformStep): StepResult {
  switch (step.type) {
    case 'calculated_field':
      return stepCalculatedField(t, step);
    case 'filter':
      return stepFilter(t, step);
    case 'group_aggregate':
      return stepGroupAggregate(t, step);
    case 'dedupe':
      return stepDedupe(t, step);
    case 'fill_empty':
      return stepFillEmpty(t, step);
    case 'trim':
      return stepTrim(t, step);
    case 'drop_column':
      return stepDropColumn(t, step);
    case 'rename_column':
      return stepRenameColumn(t, step);
    default:
      return skip(t, `Unknown step type "${(step as { type?: string }).type}" skipped`);
  }
}

// ── Per-step implementations (each pure: builds a new table, never mutates t) ──

function stepCalculatedField(t: TableData, s: CalculatedFieldStep): StepResult {
  const name = typeof s.name === 'string' ? s.name.trim() : '';
  if (!name) return skip(t, 'Calculated field skipped: blank column name');
  if (colIndex(t.columns, name) >= 0) {
    return skip(t, `Calculated field skipped: column "${name}" already exists`);
  }

  const compiled = compile(s.expression);
  if (!compiled.ok) {
    return skip(t, `Calculated field "${name}" skipped: ${compiled.error}`);
  }

  const warnings: string[] = [];
  const missing = compiled.fn.refs.filter((ref) => colIndex(t.columns, ref) < 0);
  if (missing.length > 0) {
    warnings.push(`Calculated field "${name}" references unknown column(s): ${missing.join(', ')}`);
  }

  const columns = t.columns.map((c) => ({ ...c }));
  const rows = t.rows.map((r) => r.slice());

  // Evaluate per row against a {colName: value} map.
  const results: FValue[] = rows.map((r) => {
    const rowMap: Record<string, FValue> = {};
    for (let c = 0; c < columns.length; c += 1) rowMap[columns[c].name] = r[c];
    return compiled.fn.evaluate(rowMap);
  });

  // Append the new column, then type it via the strict-number path.
  columns.push({ name, type: 'text' });
  const newIdx = columns.length - 1;
  for (let i = 0; i < rows.length; i += 1) {
    const v = results[i];
    rows[i].push(v == null ? null : (v as Cell));
  }
  retypeColumn(columns, rows, newIdx);

  return { table: { columns, rows }, warnings };
}

function stepFilter(t: TableData, s: FilterStep): StepResult {
  const ci = colIndex(t.columns, s.column);
  if (ci < 0) return skip(t, `Filter skipped: unknown column "${s.column}"`);
  if (!FILTER_OPS.has(s.op)) return skip(t, `Filter skipped: unknown operator "${s.op}"`);

  const col = t.columns[ci];
  const columns = t.columns.map((c) => ({ ...c }));

  let keep: (cell: Cell) => boolean;
  if (s.op === 'is_empty') {
    keep = (cell) => isEmptyCell(cell);
  } else if (s.op === 'not_empty') {
    keep = (cell) => !isEmptyCell(cell);
  } else if (s.op === 'contains') {
    const needle = cellToString(s.value ?? null);
    keep = (cell) => cellToString(cell).includes(needle);
  } else if (col.type === 'number') {
    const target = coerceValue(s.value ?? null, 'number');
    const tn = typeof target === 'number' && Number.isFinite(target) ? target : null;
    keep = (cell) => {
      const cn = typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
      if (cn === null || tn === null) return false;
      switch (s.op) {
        case '=':
          return cn === tn;
        case '!=':
          return cn !== tn;
        case '>':
          return cn > tn;
        case '<':
          return cn < tn;
        case '>=':
          return cn >= tn;
        case '<=':
          return cn <= tn;
        default:
          return false;
      }
    };
  } else {
    const target = cellToString(s.value ?? null);
    keep = (cell) => {
      const cs = cellToString(cell);
      switch (s.op) {
        case '=':
          return cs === target;
        case '!=':
          return cs !== target;
        case '>':
          return cs > target;
        case '<':
          return cs < target;
        case '>=':
          return cs >= target;
        case '<=':
          return cs <= target;
        default:
          return false;
      }
    };
  }

  const rows = t.rows.filter((r) => keep(r[ci])).map((r) => r.slice());
  return { table: { columns, rows }, warnings: [] };
}

function stepGroupAggregate(t: TableData, s: GroupAggregateStep): StepResult {
  const groupBy = Array.isArray(s.groupBy) ? s.groupBy : [];
  const aggregations = Array.isArray(s.aggregations) ? s.aggregations : [];

  const groupIdx = groupBy.map((name) => colIndex(t.columns, name));
  const missingGroup = groupBy.filter((_, i) => groupIdx[i] < 0);
  if (missingGroup.length > 0) {
    return skip(t, `Group/aggregate skipped: unknown group column(s): ${missingGroup.join(', ')}`);
  }

  const warnings: string[] = [];

  // Output columns: groupBy (keep source type) + one number column per aggregation.
  const columns: ParsedColumn[] = groupIdx.map((gi) => ({ ...t.columns[gi] }));
  for (const agg of aggregations) {
    columns.push({ name: agg.as, type: 'number' });
  }

  // Bucket rows by the groupBy cells (stringified key, first-seen order).
  interface Group {
    keyCells: Cell[];
    rows: Cell[][];
  }
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const r of t.rows) {
    const keyCells = groupIdx.map((gi) => r[gi]);
    const key = JSON.stringify(keyCells.map((c) => (c == null ? null : c)));
    let g = byKey.get(key);
    if (!g) {
      g = { keyCells, rows: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(r);
  }

  const rows: Cell[][] = groups.map((g) => {
    const out: Cell[] = g.keyCells.slice();
    for (const agg of aggregations) {
      out.push(aggregate(g.rows, t.columns, agg, warnings));
    }
    return out;
  });

  return { table: { columns, rows }, warnings };
}

// One aggregation over a group's rows. sum/avg/min/max operate over finite
// numeric cells only (our arithmetic — the model never supplies these); count is
// the number of non-empty cells in the referenced column. Returns null when there
// are no qualifying cells.
function aggregate(groupRows: Cell[][], columns: ParsedColumn[], agg: Aggregation, warnings: string[]): Cell {
  const ci = colIndex(columns, agg.column);
  if (ci < 0) {
    warnings.push(`Aggregation "${agg.as}" references unknown column "${agg.column}"`);
    return null;
  }
  const fn: AggFn = AGG_FNS.has(agg.fn) ? agg.fn : 'count';

  if (fn === 'count') {
    let count = 0;
    for (const r of groupRows) if (!isEmptyCell(r[ci])) count += 1;
    return count;
  }

  const nums: number[] = [];
  for (const r of groupRows) {
    const v = r[ci];
    if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
  }
  if (nums.length === 0) return null;

  switch (fn) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    // reduce, not Math.min(...nums)/Math.max(...nums): a large group (a low-
    // cardinality dimension over a combined/appended 100k+ row dataset) would blow
    // the argument-spread limit and throw RangeError. applyPipeline catches that and
    // skips the whole step, silently returning the UN-aggregated table (wrong output,
    // no warning). Mirrors metricValue.ts. nums is guaranteed non-empty above.
    case 'min':
      return nums.reduce((a, b) => (b < a ? b : a));
    case 'max':
      return nums.reduce((a, b) => (b > a ? b : a));
    default:
      return null;
  }
}

function stepDedupe(t: TableData, s: DedupeStep): StepResult {
  const columns = t.columns.map((c) => ({ ...c }));
  const warnings: string[] = [];

  let keyIdx: number[];
  if (Array.isArray(s.columns) && s.columns.length > 0) {
    keyIdx = [];
    for (const name of s.columns) {
      const ci = colIndex(t.columns, name);
      if (ci < 0) warnings.push(`Dedupe: unknown column "${name}" ignored`);
      else keyIdx.push(ci);
    }
    if (keyIdx.length === 0) {
      return skip(t, 'Dedupe skipped: none of the given columns exist');
    }
  } else {
    keyIdx = t.columns.map((_, i) => i);
  }

  const seen = new Set<string>();
  const rows: Cell[][] = [];
  for (const r of t.rows) {
    const key = JSON.stringify(keyIdx.map((ci) => (r[ci] ?? null)));
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r.slice());
  }

  return { table: { columns, rows }, warnings };
}

function stepFillEmpty(t: TableData, s: FillEmptyStep): StepResult {
  const ci = colIndex(t.columns, s.column);
  if (ci < 0) return skip(t, `Fill empty skipped: unknown column "${s.column}"`);

  const columns = t.columns.map((c) => ({ ...c }));
  const rows = t.rows.map((r) => r.slice());
  const fill: Cell = typeof s.value === 'number' ? s.value : String(s.value ?? '');
  for (const r of rows) {
    if (isEmptyCell(r[ci])) r[ci] = fill;
  }
  // The fill value may change the column's type (e.g. filling a number gap with
  // text) — re-detect via the strict-number path.
  retypeColumn(columns, rows, ci);

  return { table: { columns, rows }, warnings: [] };
}

function stepTrim(t: TableData, s: TrimStep): StepResult {
  const columns = t.columns.map((c) => ({ ...c }));
  const rows = t.rows.map((r) => r.slice());

  let targets: number[];
  if (typeof s.column === 'string' && s.column) {
    const ci = colIndex(t.columns, s.column);
    if (ci < 0) return skip(t, `Trim skipped: unknown column "${s.column}"`);
    targets = [ci];
  } else {
    targets = t.columns.map((c, i) => (c.type === 'text' ? i : -1)).filter((i) => i >= 0);
  }

  for (const ci of targets) {
    for (const r of rows) {
      const v = r[ci];
      if (typeof v === 'string') r[ci] = v.trim();
    }
  }

  return { table: { columns, rows }, warnings: [] };
}

function stepDropColumn(t: TableData, s: DropColumnStep): StepResult {
  const ci = colIndex(t.columns, s.column);
  if (ci < 0) return skip(t, `Drop column skipped: unknown column "${s.column}"`);

  const columns = t.columns.filter((_, i) => i !== ci).map((c) => ({ ...c }));
  const rows = t.rows.map((r) => r.filter((_, i) => i !== ci));
  return { table: { columns, rows }, warnings: [] };
}

function stepRenameColumn(t: TableData, s: RenameColumnStep): StepResult {
  const ci = colIndex(t.columns, s.from);
  if (ci < 0) return skip(t, `Rename skipped: unknown column "${s.from}"`);
  const to = typeof s.to === 'string' ? s.to.trim() : '';
  if (!to) return skip(t, `Rename skipped: blank new name for "${s.from}"`);

  const columns = t.columns.map((c) => ({ ...c }));
  columns[ci] = { ...columns[ci], name: to };
  const rows = t.rows.map((r) => r.slice());
  return { table: { columns, rows }, warnings: [] };
}

// ── sanitizeSteps: drop unknown types/fields from untrusted renderer/AI input ──

export function sanitizeSteps(raw: unknown): TransformStep[] {
  if (!Array.isArray(raw)) return [];
  const out: TransformStep[] = [];
  for (const item of raw) {
    const step = sanitizeStep(item);
    if (step) out.push(step);
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function sanitizeStep(item: unknown): TransformStep | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== 'string' || !STEP_TYPES.has(type)) return null;

  switch (type) {
    case 'calculated_field': {
      const name = asString(o.name);
      const expression = asString(o.expression);
      if (name === undefined || expression === undefined) return null;
      return { type, name, expression };
    }
    case 'filter': {
      const column = asString(o.column);
      const op = asString(o.op);
      if (column === undefined || op === undefined || !FILTER_OPS.has(op)) return null;
      const step: FilterStep = { type, column, op: op as FilterOp };
      if (typeof o.value === 'string' || typeof o.value === 'number' || o.value === null) {
        step.value = o.value as Cell;
      }
      return step;
    }
    case 'group_aggregate': {
      const groupByRaw = Array.isArray(o.groupBy) ? o.groupBy : [];
      const groupBy = groupByRaw.filter((v): v is string => typeof v === 'string');
      const aggsRaw = Array.isArray(o.aggregations) ? o.aggregations : [];
      const aggregations: Aggregation[] = [];
      for (const a of aggsRaw) {
        if (!a || typeof a !== 'object') continue;
        const ao = a as Record<string, unknown>;
        const column = asString(ao.column);
        const fn = asString(ao.fn);
        const as = asString(ao.as);
        if (column === undefined || fn === undefined || as === undefined || !AGG_FNS.has(fn)) continue;
        aggregations.push({ column, fn: fn as AggFn, as });
      }
      return { type, groupBy, aggregations };
    }
    case 'dedupe': {
      const step: DedupeStep = { type };
      if (Array.isArray(o.columns)) {
        step.columns = o.columns.filter((v): v is string => typeof v === 'string');
      }
      return step;
    }
    case 'fill_empty': {
      const column = asString(o.column);
      if (column === undefined) return null;
      const value = typeof o.value === 'number' ? o.value : asString(o.value);
      if (value === undefined) return null;
      return { type, column, value };
    }
    case 'trim': {
      const step: TrimStep = { type };
      const column = asString(o.column);
      if (column !== undefined) step.column = column;
      return step;
    }
    case 'drop_column': {
      const column = asString(o.column);
      if (column === undefined) return null;
      return { type, column };
    }
    case 'rename_column': {
      const from = asString(o.from);
      const to = asString(o.to);
      if (from === undefined || to === undefined) return null;
      return { type, from, to };
    }
    default:
      return null;
  }
}

// ── combineTables: cross-dataset (pure; invoked ONLY by the IPC layer) ─────────
//
// NEVER called inside applyPipeline — that keeps the pipeline core single-source.
// `append` unions columns by name and stacks rows (missing → null). `join` does a
// left/inner join on the `on` pair, concatenating right's non-key columns. Both
// re-detect column types over the combined cells (the strict-number path).

export function combineTables(
  left: TableData,
  right: TableData,
  mode: 'append' | 'join',
  on?: { left: string; right: string },
  limit = 50_000,
): ApplyResult {
  if (mode === 'append') return appendTables(left, right);
  if (mode === 'join') return joinTables(left, right, on, limit);
  return { columns: [], rows: [], rowCount: 0, warnings: [`Unknown combine mode "${mode}"`] };
}

function appendTables(left: TableData, right: TableData): ApplyResult {
  const warnings: string[] = [];

  // Union of column names, left order first then right's new names.
  const names: string[] = left.columns.map((c) => c.name);
  const seen = new Set(names);
  for (const c of right.columns) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      names.push(c.name);
    }
  }

  const leftIdx = new Map(left.columns.map((c, i) => [c.name, i]));
  const rightIdx = new Map(right.columns.map((c, i) => [c.name, i]));

  const rows: Cell[][] = [];
  for (const r of left.rows) {
    rows.push(names.map((n) => (leftIdx.has(n) ? r[leftIdx.get(n) as number] ?? null : null)));
  }
  for (const r of right.rows) {
    rows.push(names.map((n) => (rightIdx.has(n) ? r[rightIdx.get(n) as number] ?? null : null)));
  }

  const columns: ParsedColumn[] = names.map((name) => ({ name, type: 'text' }));
  for (let c = 0; c < columns.length; c += 1) retypeColumn(columns, rows, c);

  return { columns, rows, rowCount: rows.length, warnings };
}

function joinTables(left: TableData, right: TableData, on?: { left: string; right: string }, limit = 50_000): ApplyResult {
  const warnings: string[] = [];
  if (!on || typeof on.left !== 'string' || typeof on.right !== 'string') {
    return { columns: left.columns.map((c) => ({ ...c })), rows: left.rows.map((r) => r.slice()), rowCount: left.rows.length, warnings: ['Join skipped: missing "on" key pair'] };
  }
  const li = colIndex(left.columns, on.left);
  const ri = colIndex(right.columns, on.right);
  if (li < 0 || ri < 0) {
    return { columns: left.columns.map((c) => ({ ...c })), rows: left.rows.map((r) => r.slice()), rowCount: left.rows.length, warnings: [`Join skipped: unknown key column(s) "${on.left}"/"${on.right}"`] };
  }

  // Output columns: all left columns, then right's non-key columns (rename
  // collisions with a "_right" suffix so no two columns share a name).
  const usedNames = new Set(left.columns.map((c) => c.name));
  const rightOutCols: { srcIdx: number; name: string }[] = [];
  right.columns.forEach((c, i) => {
    if (i === ri) return; // drop the join key from the right side
    let name = c.name;
    if (usedNames.has(name)) name = `${name}_right`;
    usedNames.add(name);
    rightOutCols.push({ srcIdx: i, name });
  });

  // Index right rows by the stringified key value (inner join → matches only).
  const rightByKey = new Map<string, Cell[][]>();
  for (const r of right.rows) {
    const key = cellToString(r[ri]);
    const bucket = rightByKey.get(key);
    if (bucket) bucket.push(r);
    else rightByKey.set(key, [r]);
  }

  // Bound the OUTPUT at `limit` while building. A many-to-many join on a low-
  // cardinality/duplicate key is the full cartesian product (50k × 50k = 2.5B rows),
  // which would OOM the main process BEFORE any post-hoc slice ran. Stop pushing at
  // the cap (the IPC already intends to slice there) so retypeColumn walks ≤ limit rows.
  const rows: Cell[][] = [];
  let capped = false;
  outer: for (const lr of left.rows) {
    const key = cellToString(lr[li]);
    const matches = rightByKey.get(key);
    if (!matches) continue; // inner join drops unmatched left rows
    for (const rr of matches) {
      if (rows.length >= limit) { capped = true; break outer; }
      rows.push(lr.slice().concat(rightOutCols.map((rc) => rr[rc.srcIdx] ?? null)));
    }
  }
  if (capped) warnings.push(`Join row cap reached — kept first ${limit} matched rows`);

  const columns: ParsedColumn[] = left.columns.map((c) => ({ ...c }));
  for (const rc of rightOutCols) columns.push({ name: rc.name, type: 'text' });
  for (let c = 0; c < columns.length; c += 1) retypeColumn(columns, rows, c);

  return { columns, rows, rowCount: rows.length, warnings };
}
