// Level-of-detail expressions — the JS REFERENCE. MAIN PROCESS, PURE logic.
//
// `{FIXED [Region] : SUM([Sales])}` is a ROW-LEVEL value: every row carries the
// aggregate of its group. The parser (formulaParse.parseLod) records each LOD
// as a `LodSpec` and compiles a reader of the row-map slot `spec.key`; this
// file fills those slots over the whole table, then evaluates the expression
// row by row exactly as the pipeline always has.
//
// ── Which dimensions ─────────────────────────────────────────────────────────
//   FIXED [d…]    → exactly d…, whatever the visual shows.
//   INCLUDE [d…]  → the visual's dimensions ∪ d….
//   EXCLUDE [d…]  → the visual's dimensions \ d….
// The visual's dimensions arrive as `vizDims`. Outside a visual (a calculated
// field saved in Prepare, a KPI) there are none, so INCLUDE behaves as FIXED
// on its own dimensions and EXCLUDE as FIXED on nothing — the whole table.
// That falls out of the two set operations over an empty list; it is not a
// special case.
//
// ── Groups ───────────────────────────────────────────────────────────────────
// A group key is `JSON.stringify` of the dimension CELLS, the same key
// `transforms.stepGroupAggregate` builds, so an LOD groups exactly like every
// other grouping in the app: a number column on its number, a text column on
// its string verbatim, `null` and `''` two distinct groups. The resident twin
// (engine/lodResident.ts) reproduces this with `IS NOT DISTINCT FROM`.
//
// ── Aggregates ───────────────────────────────────────────────────────────────
//   SUM / AVG    finite numbers only, left-fold in row order, null when none.
//   MIN / MAX    numeric when the group has a number; otherwise, when every
//                non-empty value reads as a date, the earliest/latest value AS
//                WRITTEN ("first order date per customer"); otherwise null.
//   COUNT        non-empty values (null, '' and whitespace are empty).
//   COUNTD       distinct non-empty values.

import type { Compiled, FValue, SourceSpan } from './formula';
import { compile } from './formula';
import type { LodAgg, LodSpec } from './formulaParse';
import { num, toDate } from './formulaEval';
import { tokenize } from './formulaTokens';
import { nearestColumn } from './didYouMean';

type Cell = string | number | null;
interface Col {
  name: string;
}

/** The visual's dimensions — absent or empty outside a visual. */
export interface LodContext {
  vizDims?: string[];
}

/** The dimensions one LOD groups by, under the visual's own. */
export function lodGroupDims(spec: Pick<LodSpec, 'kind' | 'dims'>, vizDims: string[] = []): string[] {
  const own = spec.dims.map((d) => d.name);
  if (spec.kind === 'fixed') return own;
  if (spec.kind === 'include') return vizDims.concat(own.filter((d) => vizDims.indexOf(d) < 0));
  return vizDims.filter((d) => own.indexOf(d) < 0);
}

function isEmpty(v: FValue | undefined): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/** One group's values → its aggregate. Exported for the tests' hand-made folds. */
export function lodAggregate(agg: LodAgg, vals: FValue[]): FValue {
  if (agg === 'count') {
    let n = 0;
    for (const v of vals) if (!isEmpty(v)) n += 1;
    return n;
  }
  if (agg === 'countd') {
    const seen = new Set<string>();
    for (const v of vals) if (!isEmpty(v)) seen.add(JSON.stringify(v));
    return seen.size;
  }
  const nums: number[] = [];
  for (const v of vals) {
    const n = num(v);
    if (n !== null) nums.push(n);
  }
  if (agg === 'min' || agg === 'max') {
    const max = agg === 'max';
    if (nums.length) return nums.reduce((a, b) => (max ? (b > a ? b : a) : b < a ? b : a));
    let best: FValue = null;
    let bestT = 0;
    for (const v of vals) {
      if (isEmpty(v)) continue;
      const d = toDate(v);
      if (!d) return null;
      const t = d.getTime();
      if (best === null || (max ? t > bestT : t < bestT)) {
        best = v;
        bestT = t;
      }
    }
    return best;
  }
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return agg === 'avg' ? sum / nums.length : sum;
}

function rowMap(columns: Col[], r: Cell[]): Record<string, FValue> {
  const m: Record<string, FValue> = {};
  for (let c = 0; c < columns.length; c += 1) m[columns[c].name] = r[c] ?? null;
  return m;
}

function safe(fn: (row: Record<string, FValue>) => FValue, m: Record<string, FValue>): FValue {
  try {
    const v = fn(m);
    return v === undefined ? null : v;
  } catch (_) {
    return null;
  }
}

/**
 * Every LOD's per-row value, in fill order — `out[j][i]` is LOD j at row i.
 * The caller has already checked the dimensions exist (`lodDimProblem`); an
 * unknown one here keys as null rather than throwing.
 */
export function lodValues(lods: LodSpec[], columns: Col[], rows: Cell[][], ctx: LodContext = {}): FValue[][] {
  const out: FValue[][] = [];
  const idx = (name: string): number => columns.findIndex((c) => c.name === name);
  for (const spec of lods) {
    const dimIdx = lodGroupDims(spec, (ctx.vizDims || []).filter((d) => idx(d) >= 0)).map(idx);
    // One bare, real column with no LOD inside it: read the cell, skip the map.
    const direct = spec.argCol !== null && !spec.nested ? idx(spec.argCol) : -1;
    const byKey = new Map<string, number>();
    const groups: FValue[][] = [];
    const groupOf = new Array<number>(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      const key = JSON.stringify(dimIdx.map((c) => (c < 0 ? null : r[c] ?? null)));
      let g = byKey.get(key);
      if (g === undefined) {
        g = groups.length;
        byKey.set(key, g);
        groups.push([]);
      }
      groupOf[i] = g;
      let v: FValue;
      if (direct >= 0) v = r[direct] ?? null;
      else {
        const m = rowMap(columns, r);
        for (let j = 0; j < out.length; j += 1) m[lods[j].key] = out[j][i];
        v = safe(spec.arg, m);
      }
      groups[g].push(v);
    }
    const value = groups.map((vals) => lodAggregate(spec.agg, vals));
    out.push(groupOf.map((g) => value[g]));
  }
  return out;
}

/**
 * The compiled expression over EVERY row, LODs included — what a calculated
 * field stores and what the formula editor previews. An expression with no
 * LOD is evaluated exactly as `transforms.stepCalculatedField` always did.
 */
export function evaluateTable(fn: Compiled, columns: Col[], rows: Cell[][], ctx: LodContext = {}): FValue[] {
  const lods = fn.lods || [];
  const vals = lods.length ? lodValues(lods, columns, rows, ctx) : [];
  return rows.map((r, i) => {
    const m = rowMap(columns, r);
    for (let j = 0; j < lods.length; j += 1) m[lods[j].key] = vals[j][i];
    return fn.evaluate(m);
  });
}

/**
 * The first LOD dimension that is not a column, as a positioned error with a
 * suggestion — or null. An unknown column ELSEWHERE in a formula is a runtime
 * null and only a warning; an unknown DIMENSION would silently collapse its
 * groups into one, which is a wrong number rather than a missing one.
 */
export function lodDimProblem(fn: Compiled, columnNames: string[]): { error: string; at: SourceSpan } | null {
  for (const spec of fn.lods || []) {
    for (const d of spec.dims) {
      if (columnNames.indexOf(d.name) >= 0) continue;
      const near = nearestColumn(d.name, columnNames);
      return {
        error: `LOD dimension [${d.name}] is not a column in this dataset.` + (near ? ` Did you mean [${near}]?` : ''),
        at: { start: d.start, end: d.end },
      };
    }
  }
  return null;
}

/** True when `text` is exactly ONE LOD expression, `{…}` and nothing around it. */
export function isLodExpression(text: string): boolean {
  if (typeof text !== 'string' || text.trim()[0] !== '{') return false;
  const res = compile(text);
  if (!res.ok || res.fn.lods.length === 0) return false;
  const outer = res.fn.lods[res.fn.lods.length - 1];
  return text.slice(0, outer.start).trim() === '' && text.slice(outer.end).trim() === '';
}

const NOT_COLUMNS = new Set(['fixed', 'include', 'exclude', 'if', 'then', 'elseif', 'else', 'end', 'case', 'when',
  'and', 'or', 'not', 'in', 'true', 'false', 'null']);

/**
 * The column names referenced INSIDE LOD braces — dimensions and the
 * aggregate's argument — in first-seen order. They are ordinary `[name]`
 * tokens, so a token-level rewrite of column refs (save as template) already
 * reaches them; this says which ones sit inside an LOD. A tokenizer failure is
 * an empty list.
 */
export function lodColumnRefs(expr: string): string[] {
  let toks;
  try {
    toks = tokenize(String(expr ?? ''));
  } catch (_) {
    return [];
  }
  const out: string[] = [];
  let depth = 0;
  toks.forEach((t, i) => {
    if (t.kind === 'punc' && t.value === '{') depth += 1;
    else if (t.kind === 'punc' && t.value === '}') depth = Math.max(0, depth - 1);
    else if (depth > 0) {
      const next = toks[i + 1];
      const call = next && next.kind === 'punc' && next.value === '(';
      const isRef = t.kind === 'col' || (t.kind === 'name' && !call && !NOT_COLUMNS.has(t.value.toLowerCase()));
      if (isRef && out.indexOf(t.value) < 0) out.push(t.value);
    }
  });
  return out;
}
