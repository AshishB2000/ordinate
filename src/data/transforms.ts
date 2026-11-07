// Reversible transform pipeline — MAIN PROCESS, PURE logic.
// No fs, no DOM: `applyPipeline` folds an ordered list of steps over
// an immutable `source` table and returns the derived output, so it is
// node-testable by a plain `node` self-check (scripts/test-transforms.ts).
//
// Core invariants:
//   1. The input `source` is NEVER mutated (deep-copied first). Removing a step
//      recomputes the output from the untouched source → fully reversible.
//   2. A broken/unknown step is SKIPPED with a warning — so one bad step can't
//      break reversibility; the user can edit or remove it. Two refusals THROW
//      instead, because skipping either would widen the figure: a glossary term
//      no door expanded (TermNotExpandedError) and a row access lock that cannot
//      be honoured (RowPolicyError).
//   3. Number-accuracy: the model never computes values. `calculated_field` runs
//      our safe evaluator (src/formula.ts); every computed/derived column is typed
//      via parse.detectColumnType (the STRICT isFiniteNumber gate) and coerced via
//      parse.coerceValue, so "007"/zips/>15-digit ids never corrupt to numbers.

import type { ParsedColumn } from './parse';
import { RowPolicyError, isRowPolicyError } from './rowPolicyError';
import { TermNotExpandedError, isTermNotExpandedError } from './termStep';
import { termNoJoinHere } from './termMessages';
import { detectColumnType, coerceValue } from './parse';
import { compile } from '../formula/formula';
import type { FValue } from '../formula/formula';
import { evaluateTable, lodDimProblem } from '../formula/lod';
import { isFormulaBudgetError, newFormulaBudget, type FormulaBudget } from '../formula/formulaBudget';
import type { FilterOp } from './filterOps';
import { FILTER_OPS, LIST_OPS, PERIOD_OP, emptyListWarning, periodSkipWarning } from './filterOps';
import { resolvePeriodNow, periodDay, daysFromIso } from '../analysis/dateIntel';
import type { PeriodSpec } from '../analysis/dateIntel';
import { applyMaskStep } from './maskSteps';
import type { MaskStep, PipelineCtx as MaskCtx } from './maskSteps';
import type { PipelineContext, PowerStep, StepCount } from './stepsPower';
import { POWER_STEP_TYPES, applyPowerStep, conditionalAsCalc } from './stepsPower';
import type { SegmentStep } from './stepsSegment';
import { applySegmentStep } from './stepsSegment';
import type { TextStep } from './textStepTypes';
import { TEXT_STEP_TYPES } from './textStepTypes';
import { applyTextStep } from './stepsText';
import type { RegexMemo } from './regexMemo';
import { RADIUS_OP, withinKm } from '../analysis/geo/radius';
import type { RadiusSpec } from '../analysis/geo/radius';
import { AGGREGATIONS, type Aggregation as AggregationName } from './aggregations';
import { PendingError, isPendingError } from './pendingError';

/**
 * What a pipeline may be handed beyond its source: the project's masking key
 * for a mask_hash step (maskSteps.ts) and the other datasets' tables a union /
 * lookup step reads (stepsPower.ts, loaded in main by stepRefs.ts).
 */
export type PipelineCtx = MaskCtx & Partial<PipelineContext> & { budget?: FormulaBudget };

/** The power steps' half of the context — only when tables were loaded. */
function powerCtx(ctx: PipelineCtx): PipelineContext | undefined {
  return ctx.tables ? { tables: ctx.tables, errors: ctx.errors, boundaries: ctx.boundaries } : undefined;
}

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
  /** Rows into and out of each step, index-aligned with the steps. */
  stepCounts?: StepCount[];
}

// ── TransformStep union (single-source steps only) ───────────────────────────

export type { FilterOp } from './filterOps';
export type AggFn = AggregationName;
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
  /**
   * The value LIST for `in` / `not in` — deliberately a SEPARATE field rather
   * than widening `value` to `Cell | Cell[]`. Every stored visual.json /
   * dashboard.json and every existing code path reads `value` as a scalar, so
   * widening it would make each of them a type error and a migration; adding a
   * field makes older steps keep working untouched and newer ones simply carry
   * one more key. Ignored by every other operator.
   */
  values?: Cell[];
  /** The relative range for op `period` — the PRESET, resolved when evaluated. */
  period?: PeriodSpec;
  /** op `within_km`: the longitude column, a centre and a distance (analysis/geo/radius.ts). */
  radius?: RadiusSpec;
  /** r7:lod — a CONTEXT filter: applied before LOD expressions (analysis/lodQuery.ts). */
  context?: boolean;
  /** A row access / embed lock (data/rowLock.ts): a warehouse compares it byte for byte (row-policy D13). */
  lock?: true;
  /** Made by a dashboard date control (semantic D9): the server may move its period onto the metric's timeColumn. */
  fromControl?: true;
  /**
   * The relationship (id) `column` is read through, when it belongs to a RELATED table (the join
   * planner, analysis/joinPlan.ts). Kept by every sanitizer so an older pod never drops it, and
   * REFUSED by every evaluator that cannot walk it: it never filters the primary's own same-named column.
   */
  via?: string;
  /** Set on a term's step from another dataset (semantic D11); only the join planner applies it, every single-table engine refuses it. */
  datasetId?: string;
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
  | RenameColumnStep
  | MaskStep
  | PowerStep
  | SegmentStep
  | TextStep;

export type StepType = TransformStep['type'];

// ── Small helpers ────────────────────────────────────────────────────────────

export const AGG_FNS: ReadonlySet<string> = new Set<string>(AGGREGATIONS);
export const STEP_TYPES: ReadonlySet<string> = new Set([
  'calculated_field',
  'filter',
  'group_aggregate',
  'dedupe',
  'fill_empty',
  'trim',
  'drop_column',
  'rename_column',
  // The mask steps (maskSteps.ts). Literal here, not spread from MASK_STEP_TYPES:
  // the two modules import each other, and this Set is built at load time.
  'mask_hash',
  'mask_redact',
  'mask_generalize',
  ...POWER_STEP_TYPES,
  'segment', // Find segments' fitted model (stepsSegment.ts)
  ...TEXT_STEP_TYPES,
]);

// The three table helpers combine.ts shares. Exported for that, not as an
// invitation — everything else in this file is the pipeline core.
export function colIndex(columns: ParsedColumn[], name: string): number {
  return columns.findIndex((c) => c.name === name);
}

// Exported for analysis/qualityRules — the app's ONE definition of "empty".
export function isEmptyCell(cell: Cell): boolean {
  if (cell == null) return true;
  return typeof cell === 'string' && cell.trim() === '';
}

export function cellToString(cell: Cell): string {
  return cell == null ? '' : String(cell);
}

// Re-run detectColumnType over a column's stringified cells (the STRICT-number
// path), set the column's type, then coerce every cell to match. Mutates the
// (freshly-built, caller-owned) columns/rows arrays. Used after calculated_field
// and fill_empty, and for combine outputs.
export function retypeColumn(columns: ParsedColumn[], rows: Cell[][], c: number): void {
  // A cell that is ALREADY a JS number needs no inference — the app computed it,
  // so its type is known rather than guessed.
  //
  // detectColumnType classifies untrusted TEXT, and its >15-significant-digit
  // guard (which stops a 20-digit id becoming a lossy double) also rejects a
  // genuine quotient: `revenue / units` is 54.142857142857146, seventeen digits.
  // Round-tripping computed doubles through that guard typed a column of real
  // numbers as `text`, and nothing aggregates a text column — sum/avg over text
  // is refused ON PURPOSE so a wrong figure can never appear — so a chart built
  // on it drew nothing, with no error anywhere to say why. The guard's premise,
  // "cannot round-trip through a JS double without loss", is false by
  // construction here: the string came FROM a double.
  //
  // Text cells still go through detectColumnType, which is what keeps an
  // identifier-shaped result such as concat('0', sku) → "0007" text.
  const present = rows.map((r) => r[c]).filter((v) => v !== null && v !== '');
  if (present.length > 0 && present.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    columns[c] = { ...columns[c], type: 'number' };
    return; // already numbers — nothing to coerce
  }
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

export interface StepResult {
  table: TableData;
  warnings: string[];
}

function skip(t: TableData, warning: string): StepResult {
  return { table: t, warnings: [warning] };
}

// ── applyPipeline ────────────────────────────────────────────────────────────

// Fold each step left→right over a deep copy of `source`, accumulating warnings.
// A step referencing a missing column is skipped with a warning. It throws only to refuse: a row access lock's
// step (RowPolicyError) or a glossary term no door expanded (TermNotExpandedError).
// `ctx.salt` is the project's masking key for a mask_hash step (maskSteps.ts);
// without it that step is skipped, never hashed unsalted. `ctx.tables` are the
// datasets a union / lookup step reads (stepRefs.ts); without them it is skipped.
// Pure JS and synchronous. The in-memory DuckDB twin (pipelineDuck.runOnDuckDb,
// off by default) is no longer tried here: it needs the async bridge, and this
// fold is called synchronously from every request (T4.2). The Parquet-resident
// twin (pipelineDuck.runResidentPipeline) is tried by datasets.updateSteps.
export function applyPipeline(source: TableData, steps: TransformStep[], ctx: PipelineCtx = {}): ApplyResult {
  if (!ctx.budget) ctx = { ...ctx, budget: newFormulaBudget() }; // ONE formula work budget for the whole fold (NV-42)
  let table = cloneTable(source);
  const warnings: string[] = [];
  const list = Array.isArray(steps) ? steps : [];
  const stepCounts: StepCount[] = [];

  for (const step of list) {
    const result = foldStep(table, step, ctx);
    stepCounts.push({ before: table.rows.length, after: result.table.rows.length });
    table = result.table;
    for (const w of result.warnings) warnings.push(w);
  }

  return { columns: table.columns, rows: table.rows, rowCount: table.rows.length, warnings, stepCounts };
}

/** One step of the fold: a failing step is skipped, except an unexpanded term or an unhonoured lock, which throw. `memo`: the regex worker's answers (./regexOffThread.ts). */
export function foldStep(t: TableData, step: TransformStep, ctx: PipelineCtx, memo?: RegexMemo): StepResult {
  try {
    return dispatch(t, step, ctx, memo);
  } catch (e) {
    if (isRowPolicyError(e)) throw e; // a lock that cannot be honoured refuses the figure: never a skipped step
    if (isTermNotExpandedError(e)) throw e; // a glossary term no door expanded refuses it the same way
    if (isPendingError(e)) throw e; // a count distinct this release cannot compute: never an ungrouped table
    // Defense in depth: no step should throw, but if one does, skip it.
    const msg = e instanceof Error ? e.message : 'unknown error';
    return skip(t, `Step "${step && step.type}" skipped: ${msg}`);
  }
}

function dispatch(t: TableData, step: TransformStep, ctx: PipelineCtx, memo?: RegexMemo): StepResult {
  switch (step.type) {
    case 'calculated_field':
      return stepCalculatedField(t, step, ctx.budget);
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
    case 'mask_hash':
    case 'mask_redact':
    case 'mask_generalize':
      return applyMaskStep(t, step, ctx);
    case 'split_column': case 'unpivot': case 'pivot': case 'parse_date': case 'dedupe_key':
    case 'replace_values': case 'union': case 'lookup_join': case 'window':
    case 'spatial_join':
      return applyPowerStep(t, step, powerCtx(ctx), memo);
    case 'conditional_column': {
      const calc = conditionalAsCalc(t.columns, step);
      return typeof calc === 'string' ? skip(t, calc) : stepCalculatedField(t, calc, ctx.budget);
    }
    case 'segment':
      return applySegmentStep(t, step);
    case 'text_terms': case 'text_sentiment': case 'keyword_rules':
      return applyTextStep(t, step, memo);
    default:
      if ((step as { type?: unknown }).type === 'term') throw new TermNotExpandedError('not_expanded'); // not a Prepare step: never skipped
      return skip(t, `Unknown step type "${(step as { type?: string }).type}" skipped`);
  }
}

// ── Per-step implementations (each pure: builds a new table, never mutates t) ──

function stepCalculatedField(t: TableData, s: CalculatedFieldStep, budget?: FormulaBudget): StepResult {
  const name = typeof s.name === 'string' ? s.name.trim() : '';
  if (!name) return skip(t, 'Calculated field skipped: blank column name');
  if (colIndex(t.columns, name) >= 0) {
    return skip(t, `Calculated field skipped: column "${name}" already exists`);
  }

  const compiled = compile(s.expression);
  if (!compiled.ok) {
    return skip(t, `Calculated field "${name}" skipped: ${compiled.error}`);
  }

  // r7:lod — an LOD dimension that is not a column would fuse its groups.
  const lodBad = lodDimProblem(compiled.fn, t.columns.map((c) => c.name));
  if (lodBad) return skip(t, `Calculated field "${name}" skipped: ${lodBad.error}`);

  const warnings: string[] = [];
  const missing = compiled.fn.refs.filter((ref) => colIndex(t.columns, ref) < 0);
  if (missing.length > 0) {
    warnings.push(`Calculated field "${name}" references unknown column(s): ${missing.join(', ')}`);
  }

  const columns = t.columns.map((c) => ({ ...c }));
  const rows = t.rows.map((r) => r.slice());

  // Evaluate per row against a {colName: value} map — LODs filled over the
  // whole table first (formula/lod.ts), at no visual's dimensions.
  let results: FValue[];
  try {
    results = evaluateTable(compiled.fn, columns, rows, { budget });
  } catch (e) {
    if (isFormulaBudgetError(e)) return skip(t, `Calculated field "${name}" skipped: ${e.message}`);
    throw e;
  }

  // Append the new column, then type it. retypeColumn keeps a computed double a
  // number and still sends text results through the strict-number path.
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
  if (s.datasetId) throw new TermNotExpandedError('unreachable', termNoJoinHere()); // another table's term step: never this table's same-named column
  if (s.via) return skip(t, `Filter skipped: unknown column "${s.column}"`); // a related table's column: never the primary's own
  const ci = colIndex(t.columns, s.column);
  if (ci < 0 && s.lock) throw new RowPolicyError('column'); // a row access lock never skips (docs/row-policy D6)
  if (ci < 0) return skip(t, `Filter skipped: unknown column "${s.column}"`);
  if (!FILTER_OPS.has(s.op)) return skip(t, `Filter skipped: unknown operator "${s.op}"`);

  const col = t.columns[ci];
  const columns = t.columns.map((c) => ({ ...c }));

  if (s.op === PERIOD_OP) {
    const r = s.period ? resolvePeriodNow(s.period) : null;
    if (!r) return skip(t, periodSkipWarning(s.column));
    const lo = daysFromIso(r.from);
    const hi = daysFromIso(r.to);
    const rows = t.rows
      .filter((row) => {
        const d = periodDay(row[ci]);
        return d !== null && (lo === null || d >= lo) && (hi === null || d <= hi);
      })
      .map((row) => row.slice());
    return { table: { columns, rows }, warnings: [] };
  }

  if (s.op === RADIUS_OP) {
    const gi = s.radius ? colIndex(t.columns, s.radius.lngColumn) : -1;
    if (!s.radius) return skip(t, `Filter skipped: "${s.column}" has no radius to filter on`);
    if (gi < 0) return skip(t, `Filter skipped: unknown column "${s.radius.lngColumn}"`);
    const r = s.radius;
    return { table: { columns, rows: t.rows.filter((row) => withinKm(row[ci], row[gi], r)).map((row) => row.slice()) }, warnings: [] };
  }

  // `in` / `not in` are handled before the scalar operators because they read a
  // different field (`values`, not `value`).
  if (LIST_OPS.has(s.op)) {
    const list = Array.isArray(s.values) ? s.values : [];
    // An empty list SKIPS, matching the "unknown step skipped with a warning,
    // never throws" contract. Matching zero rows would blank the chart the
    // instant a filter is created, which reads as a bug rather than as "you
    // haven't picked any values yet".
    if (list.length === 0) return skip(t, emptyListWarning(s.column, s.op));

    // `in` is EXACTLY a disjunction of the existing `=` operator, so it reuses
    // `=`'s coercion rules verbatim: a number column compares round-tripped
    // finite numbers (uncoercible entries can never match and are dropped), a
    // text/date column compares `cellToString` output (so a null cell reads as
    // '' — the same as `= ''` does today).
    let inList: (cell: Cell) => boolean;
    if (col.type === 'number') {
      const targets = new Set<number>();
      for (const v of list) {
        const n = coerceValue(v ?? null, 'number');
        if (typeof n === 'number' && Number.isFinite(n)) targets.add(n);
      }
      inList = (cell) => typeof cell === 'number' && Number.isFinite(cell) && targets.has(cell);
    } else {
      const targets = new Set<string>(list.map((v) => cellToString(v ?? null)));
      inList = (cell) => targets.has(cellToString(cell));
    }

    // EXACT negation — deliberately unlike `!=`. On a number column `!=` returns
    // false for a null cell (both `=` and `!=` do, because the `cn === null`
    // guard precedes the switch), so `!=` is not the complement of `=`. `not in`
    // IS the complement: a null cell is not in the list, so it survives. That
    // matches what "exclude these three regions" means to a user, and every
    // implementation of this operator is pinned to that choice by test.
    const rows = t.rows.filter((r) => (s.op === 'in' ? inList(r[ci]) : !inList(r[ci]))).map((r) => r.slice());
    return { table: { columns, rows }, warnings: [] };
  }

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
  if (fn === 'countd') throw new PendingError('countd', agg.as); // shortcut: computed from part 5 step 02

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

export { sanitizeSteps } from './stepSanitize'; // moved to its own file (the 800-line cap); STEP_TYPES above is read by it at call time
