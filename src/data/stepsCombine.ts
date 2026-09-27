// Combine steps — union and lookup_join, each reading ANOTHER dataset's table.
// MAIN PROCESS, PURE: the other table arrives in the PipelineContext, loaded by
// main before the fold runs (src/data/stepRefs.ts), so nothing here does I/O.
// src/engine/sqlGenCombine.ts is the SQL twin (scripts/test-powerStepsDuck.ts).
//
// A reference that is missing, is this dataset itself, or would close a cycle
// SKIPS the step with the reason the loader recorded — never throws.

import type { Cell, TableData } from './transforms';
import { colIndex, retypeColumn } from './transforms';
import type { ParsedColumn } from './parse';
import type { LookupJoinStep, PipelineContext, UnionStep } from './stepTypes';
import { refProblem } from './stepTypes';
import type { PowerResult } from './stepsReshape';
import { skipped } from './stepsReshape';

// ── union ────────────────────────────────────────────────────────────────────

export interface UnionPlan {
  /** Per column of THIS table: the other table's column index, or -1 (nulls). */
  source: number[];
  /** Other-table columns nothing reads — dropped. */
  unmatched: string[];
  warnings: string[];
}

/**
 * Match columns: an explicit `{from, to}` mapping first (an other column used
 * there is consumed), then by exact name. Unknown names in the mapping warn.
 */
export function unionPlan(mine: ParsedColumn[], other: ParsedColumn[], mapping: UnionStep['mapping']): UnionPlan {
  const source = mine.map(() => -1);
  const used = new Set<number>();
  const warnings: string[] = [];
  for (const m of mapping || []) {
    const to = colIndex(mine, m.to);
    const from = colIndex(other, m.from);
    if (to < 0 || from < 0) {
      warnings.push(`Union: mapping "${m.from}" → "${m.to}" ignored (unknown column)`);
      continue;
    }
    if (source[to] >= 0) continue; // the first mapping into a column wins
    source[to] = from;
    used.add(from);
  }
  mine.forEach((c, k) => {
    if (source[k] >= 0) return;
    const j = other.findIndex((o, x) => o.name === c.name && !used.has(x));
    if (j >= 0) {
      source[k] = j;
      used.add(j);
    }
  });
  const unmatched = other.filter((_, x) => !used.has(x)).map((o) => o.name);
  return { source, unmatched, warnings };
}

/** Columns whose two declared types disagree are typed again from the combined values. */
export function unionRetyped(mine: ParsedColumn[], other: ParsedColumn[], plan: UnionPlan): number[] {
  return plan.source.map((j, k) => (j >= 0 && other[j].type !== mine[k].type ? k : -1)).filter((k) => k >= 0);
}

export function applyUnion(t: TableData, s: UnionStep, ctx?: PipelineContext): PowerResult {
  const problem = refProblem(ctx, s.datasetId);
  if (problem) return skipped(t, `Union skipped: ${problem}`);
  const other = (ctx as PipelineContext).tables[s.datasetId];
  const plan = unionPlan(t.columns, other.columns, s.mapping);
  const columns = t.columns.map((c) => ({ ...c }));
  const rows: Cell[][] = t.rows.map((r) => r.slice());
  for (const r of other.rows) rows.push(plan.source.map((j) => (j >= 0 ? r[j] ?? null : null)));
  for (const k of unionRetyped(t.columns, other.columns, plan)) retypeColumn(columns, rows, k);
  return { table: { columns, rows }, warnings: plan.warnings };
}

// ── lookup_join ──────────────────────────────────────────────────────────────

/**
 * The join key of one cell — joinJs.keyOf's rule, restated here so the
 * pipeline core does not import the visual-join module: the stored text of the
 * cell, and null (matches nothing) when empty or, for a number column, not a
 * finite number. scripts/test-powerSteps.ts pins it to keyOf.
 */
export function lookupKey(cell: Cell | undefined, type: ParsedColumn['type']): string | null {
  if (type === 'number') return typeof cell === 'number' && Number.isFinite(cell) ? String(cell) : null;
  if (cell == null) return null;
  const s = String(cell);
  return s.trim() === '' ? null : s;
}

export function lookupDupWarning(rightKey: string, dupes: number): string {
  return `Lookup: ${dupes} key value(s) repeat in "${rightKey}" of the other dataset; the first match in stored order was used`;
}

interface LookupPlan {
  other: TableData;
  li: number;
  ri: number;
  bring: number[];
  names: string[];
  warnings: string[];
}

/** Every guard, in the order both engines run them: a plan, or the skip warning(s). */
export function lookupPlan(columns: ParsedColumn[], s: LookupJoinStep, ctx?: PipelineContext): LookupPlan | string[] {
  const problem = refProblem(ctx, s.datasetId);
  if (problem) return [`Lookup skipped: ${problem}`];
  const other = (ctx as PipelineContext).tables[s.datasetId];
  const li = colIndex(columns, s.leftKey);
  if (li < 0) return [`Lookup skipped: unknown column "${s.leftKey}"`];
  const ri = colIndex(other.columns, s.rightKey);
  if (ri < 0) return [`Lookup skipped: the other dataset has no column "${s.rightKey}"`];
  const warnings: string[] = [];
  const bring: number[] = [];
  for (const c of s.columns) {
    const j = colIndex(other.columns, c);
    if (j < 0) warnings.push(`Lookup: the other dataset has no column "${c}"; ignored`);
    else if (!bring.includes(j)) bring.push(j);
  }
  if (!bring.length) return [...warnings, 'Lookup skipped: choose at least one column to bring across'];
  const prefix = typeof s.prefix === 'string' ? s.prefix : '';
  const names = bring.map((j) => prefix + other.columns[j].name);
  const clash = names.find((nm, k) => colIndex(columns, nm) >= 0 || names.indexOf(nm) !== k);
  if (clash !== undefined) return [...warnings, `Lookup skipped: column "${clash}" already exists — set a prefix`];
  return { other, li, ri, bring, names, warnings };
}

/** First row per key in stored order, and how many keyed rows repeated a key. */
function rightIndex(other: TableData, ri: number): { index: Map<string, number>; dupes: number } {
  const index = new Map<string, number>();
  let dupes = 0;
  const type = other.columns[ri].type;
  other.rows.forEach((r, i) => {
    const k = lookupKey(r[ri], type);
    if (k === null) return;
    if (index.has(k)) dupes += 1;
    else index.set(k, i);
  });
  return { index, dupes };
}

export function applyLookup(t: TableData, s: LookupJoinStep, ctx?: PipelineContext): PowerResult {
  const plan = lookupPlan(t.columns, s, ctx);
  if (Array.isArray(plan)) return { table: t, warnings: plan };
  const { other, li, ri, bring, names } = plan;
  const { index, dupes } = rightIndex(other, ri);
  const ltype = t.columns[li].type;
  const columns = [...t.columns.map((c) => ({ ...c })), ...bring.map((j, k) => ({ name: names[k], type: other.columns[j].type }))];
  const rows = t.rows.map((r) => {
    const k = lookupKey(r[li], ltype);
    const hit = k === null ? undefined : index.get(k);
    const right = hit === undefined ? null : other.rows[hit];
    return [...r, ...bring.map((j) => (right ? right[j] ?? null : null))];
  });
  const warnings = dupes > 0 ? [...plan.warnings, lookupDupWarning(s.rightKey, dupes)] : plan.warnings;
  return { table: { columns, rows }, warnings };
}

/** The editor's matched-rate preview over the step's INPUT — counted by the app. */
export function lookupStats(t: TableData, s: LookupJoinStep, ctx?: PipelineContext): {
  matched: number; total: number; dupes: number;
} | null {
  if (refProblem(ctx, s.datasetId)) return null;
  const other = (ctx as PipelineContext).tables[s.datasetId];
  const li = colIndex(t.columns, s.leftKey);
  const ri = colIndex(other.columns, s.rightKey);
  if (li < 0 || ri < 0) return null;
  const { index, dupes } = rightIndex(other, ri);
  const ltype = t.columns[li].type;
  let matched = 0;
  for (const r of t.rows) {
    const k = lookupKey(r[li], ltype);
    if (k !== null && index.has(k)) matched += 1;
  }
  return { matched, total: t.rows.length, dupes };
}
