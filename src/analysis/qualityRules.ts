// Data-quality rules — MAIN PROCESS, PURE. The rule vocabulary, its sanitizer,
// the stored-record shape, and the JS REFERENCE evaluator.
//
// `src/engine/qualityResident.ts` answers the same questions in SQL straight off
// the stored Parquet; this file is the reference it is differentially tested
// against (`scripts/test-qualityRules.ts`, `Object.is` on `failing` and on every
// sample cell). `src/analysis/qualityRun.ts` decides which one runs and keeps
// the results. No model is anywhere on this path: every count is the app's.
//
// ── Semantics (both engines, exactly) ────────────────────────────────────────
// EMPTY is the app's one definition — `transforms.isEmptyCell`: null, '' or
// whitespace-only (SQL spells the class out: `sqlGen.sqlEmpty`). In a NUMBER
// column a stored cell hydrates to a finite number or null, so "empty" there is
// "not a finite number" on both sides.
//
// KEYS (unique, in_set, references): a number column compares NUMBERS (cast on
// the DECLARED type only — `007` in a text column stays `007`); a text or date
// column compares the stored text verbatim (case-sensitive, untrimmed, `2024-1-5`
// is not `2024-01-05`). References across a number and a non-number column are
// refused with an error rather than compared by some guessed formatting.
//
//   not_null(col)     failing = rows whose cell is empty.
//   unique(col)       failing = rows whose non-empty key occurs more than once
//                     (every copy counts). Empties are ignored.
//   range(col,{min?,max?})
//                     number col: failing = non-empty cells outside [min, max],
//                     plus any non-empty cell that is not a finite number.
//                     date col: the cell must be a CANONICAL date (YYYY-M-D or
//                     M/D/YYYY, a real calendar day — `categoryKey`'s grammar,
//                     the only one SQL implements); failing = non-empty cells that
//                     are not, plus those outside the YYYY-MM-DD bounds.
//                     Text columns are refused. Empties are ignored.
//   regex(col,{pattern})
//                     failing = non-empty cells that do not FULLY match. Text and
//                     date columns only; the pattern is limited to the subset
//                     both engines read identically (./qualityRegex.ts).
//   in_set(col,{values})
//                     failing = non-empty cells whose key is not in the set (a
//                     number column reads the set through `coerceValue`, the
//                     same rule the `in` filter uses).
//   row_count({min?,max?})
//                     failing = 1 when the table's row count is outside the
//                     bounds, else 0. No column, no sample.
//   references(col,{datasetId,column})
//                     failing = non-empty cells whose key is not among the other
//                     dataset's column's non-empty keys (an anti-join).
//
// sample = the first SAMPLE_ROWS failing rows, whole, in STORED row order.
// passed = failing === 0 — except a rule that cannot run (its column is gone,
// its types do not fit) which is `passed: false` with an `error`, never a crash.
//
// ── Known, inherited limits (not papered over) ────────────────────────────────
//   · JS `trim()` also strips U+1680, U+2000–U+200A, U+2028/9, U+202F, U+205F and
//     U+3000; `sqlEmpty` does not. A cell of only those is empty here and not
//     there — the same gap every resident module inherits from sqlGen.
//   · A number cell stored as '' or whitespace hydrates as 0 (`Number('') === 0`)
//     but is NULL to TRY_CAST. Unreachable for a file this app wrote
//     (`coerceValue` maps those to null before storage).
//   · "A non-numeric cell in a number column" can only be SEEN by this JS
//     evaluator over an in-memory table: once stored, it reads back as null, i.e.
//     empty, on both sides.

import type { ColumnType, ParsedColumn } from '../data/parse';
import { coerceValue } from '../data/parse';
import type { Cell } from '../data/transforms';
import { colIndex, isEmptyCell } from '../data/transforms';
import { isCanonicalDateCell, parseDateCell } from './categoryKey';
import { isValidId } from '../app/ids';
import { REGEX_PRESETS, checkPattern, jsRegex } from './qualityRegex';

export type RuleKind = 'not_null' | 'unique' | 'range' | 'regex' | 'in_set' | 'row_count' | 'references';
export const RULE_KINDS: readonly RuleKind[] = ['not_null', 'unique', 'range', 'regex', 'in_set', 'row_count', 'references'];
export type Severity = 'warn' | 'fail';

/** One bag, sanitized PER KIND: a rule only ever carries the keys its kind reads. */
export interface RuleArgs {
  /** range: numbers, or YYYY-MM-DD strings for a date column. row_count: integers. */
  min?: number | string;
  max?: number | string;
  /** regex: the pattern, and the preset it came from (if any). */
  pattern?: string;
  preset?: string;
  /** in_set: the allowed values, as text. */
  values?: string[];
  /** references: the other dataset and its column. */
  datasetId?: string;
  column?: string;
}

export interface QualityRule {
  id: string;
  kind: RuleKind;
  column?: string;
  args: RuleArgs;
  severity: Severity;
}

export interface RuleResult {
  ruleId: string;
  passed: boolean;
  failing: number;
  sample: Cell[][];
  error?: string;
}

export interface QualityRun {
  at: string;
  passed: number;
  failed: number;
  failing: Record<string, number>;
}

export interface DatasetQuality {
  rules: QualityRule[];
  latest?: { at: string; results: RuleResult[] };
  history?: QualityRun[];
}

/** The other side of a `references` rule, as far as each engine needs it. */
export interface RefTable {
  columns: ParsedColumn[];
  rows: Cell[][];
}

export const MAX_RULES = 50;
export const MAX_HISTORY = 30;
export const SAMPLE_ROWS = 5;
export const MAX_SET_VALUES = 200;
const MAX_TEXT = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Sanitizing ───────────────────────────────────────────────────────────────

type Check = { ok: true; rule: QualityRule } | { ok: false; error: string };
const fail = (error: string): Check => ({ ok: false, error });

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() && v.length <= MAX_TEXT ? v : null;
}

/** A range bound: a finite number, a real YYYY-MM-DD date, absent (undefined), or invalid (null). */
function bound(v: unknown): number | string | undefined | null {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && ISO_DATE.test(v) && isCanonicalDateCell(v)) return v;
  return null;
}

function checkBounds(a: Record<string, unknown>, integers: boolean): { min?: number | string; max?: number | string } | string {
  const min = bound(a.min);
  const max = bound(a.max);
  if (min === null || max === null) return integers ? 'Row counts must be whole numbers' : 'Bounds must be numbers, or dates as YYYY-MM-DD';
  if (min === undefined && max === undefined) return 'Set a minimum, a maximum, or both';
  if (integers && [min, max].some((b) => b !== undefined && (typeof b !== 'number' || !Number.isInteger(b) || b < 0))) {
    return 'Row counts must be whole numbers';
  }
  if (min !== undefined && max !== undefined) {
    if (typeof min !== typeof max) return 'Both bounds must be numbers, or both dates';
    if (min > max) return 'The minimum is above the maximum';
  }
  const out: { min?: number | string; max?: number | string } = {};
  if (min !== undefined) out.min = min;
  if (max !== undefined) out.max = max;
  return out;
}

/**
 * Validate one untrusted rule (a stored file, or the editor over IPC). The error
 * is a sentence the editor shows as-is. Closed kinds, a severity enum, a UUID id,
 * and ONLY the args the kind reads — anything else is dropped.
 */
export function checkRule(raw: unknown): Check {
  if (!raw || typeof raw !== 'object') return fail('Not a rule');
  const o = raw as Record<string, unknown>;
  if (!isValidId(o.id)) return fail('A rule needs an id');
  const kind = o.kind as RuleKind;
  if (!RULE_KINDS.includes(kind)) return fail('Unknown rule kind');
  const a = o.args && typeof o.args === 'object' ? (o.args as Record<string, unknown>) : {};
  const rule: QualityRule = { id: o.id, kind, args: {}, severity: o.severity === 'warn' ? 'warn' : 'fail' };
  if (kind !== 'row_count') {
    const col = text(o.column);
    if (!col) return fail('Pick a column');
    rule.column = col;
  }
  if (kind === 'range' || kind === 'row_count') {
    const b = checkBounds(a, kind === 'row_count');
    if (typeof b === 'string') return fail(b);
    rule.args = b;
  } else if (kind === 'regex') {
    const preset = typeof a.preset === 'string' ? REGEX_PRESETS[a.preset] : undefined;
    const pattern = preset ? preset.pattern : a.pattern;
    const bad = checkPattern(pattern);
    if (bad) return fail(bad);
    rule.args = preset ? { pattern: pattern as string, preset: a.preset as string } : { pattern: pattern as string };
  } else if (kind === 'in_set') {
    const raw = Array.isArray(a.values) ? a.values : [];
    const values: string[] = [];
    for (const v of raw) {
      const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v : null;
      if (s === null || s.trim() === '' || values.includes(s)) continue;
      if (s.length > MAX_TEXT) return fail(`Keep each value under ${MAX_TEXT} characters`);
      values.push(s);
    }
    if (!values.length) return fail('Add at least one allowed value');
    if (values.length > MAX_SET_VALUES) return fail(`Keep the list to ${MAX_SET_VALUES} values`);
    rule.args = { values };
  } else if (kind === 'references') {
    if (!isValidId(a.datasetId)) return fail('Pick the dataset to check against');
    const col = text(a.column);
    if (!col) return fail('Pick the column to check against');
    rule.args = { datasetId: a.datasetId, column: col };
  }
  return { ok: true, rule };
}

export function sanitizeRule(raw: unknown): QualityRule | null {
  const c = checkRule(raw);
  return c.ok ? c.rule : null;
}

function isCell(v: unknown): v is Cell {
  return v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function sanitizeResult(raw: any, ids: Set<string>): RuleResult | null {
  if (!raw || typeof raw !== 'object' || !ids.has(raw.ruleId)) return null;
  const failing = count(raw.failing);
  if (failing === null || typeof raw.passed !== 'boolean') return null;
  const sample = (Array.isArray(raw.sample) ? raw.sample : [])
    .filter((r: unknown) => Array.isArray(r) && r.every(isCell))
    .slice(0, SAMPLE_ROWS);
  const out: RuleResult = { ruleId: raw.ruleId, passed: raw.passed, failing, sample };
  if (typeof raw.error === 'string' && raw.error) out.error = raw.error.slice(0, 300);
  return out;
}

function sanitizeRun(raw: any): QualityRun | null {
  if (!raw || typeof raw !== 'object' || typeof raw.at !== 'string') return null;
  const passed = count(raw.passed);
  const failed = count(raw.failed);
  if (passed === null || failed === null) return null;
  const failing: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.failing && typeof raw.failing === 'object' ? raw.failing : {})) {
    const n = count(v);
    if (isValidId(k) && n !== null) failing[k] = n;
  }
  return { at: raw.at, passed, failed, failing };
}

/** The `quality` block of a dataset record, off disk. Undefined when there is nothing to keep. */
export function sanitizeQuality(raw: unknown): DatasetQuality | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, any>;
  const rules: QualityRule[] = [];
  const ids = new Set<string>();
  for (const r of Array.isArray(o.rules) ? o.rules : []) {
    if (rules.length >= MAX_RULES) break;
    const clean = sanitizeRule(r);
    if (clean && !ids.has(clean.id)) {
      ids.add(clean.id);
      rules.push(clean);
    }
  }
  if (!rules.length) return undefined;
  const q: DatasetQuality = { rules };
  if (o.latest && typeof o.latest === 'object' && typeof o.latest.at === 'string') {
    const results = (Array.isArray(o.latest.results) ? o.latest.results : [])
      .map((r: unknown) => sanitizeResult(r, ids))
      .filter((r: RuleResult | null): r is RuleResult => r !== null);
    q.latest = { at: o.latest.at, results };
  }
  if (Array.isArray(o.history)) {
    const runs = o.history.map(sanitizeRun).filter((r: QualityRun | null): r is QualityRun => r !== null);
    if (runs.length) q.history = runs.slice(-MAX_HISTORY);
  }
  return q;
}

// ── The record's bookkeeping ─────────────────────────────────────────────────

/** `not_null(order_date)` — the rule's name in an alert and a log line. */
export function ruleSignature(rule: QualityRule): string {
  return rule.kind === 'row_count' ? 'row_count' : `${rule.kind}(${rule.column ?? ''})`;
}

/** FAIL-severity rules failing in the latest run — the red dot's number. */
export function qualityFailingCount(q: DatasetQuality | undefined): number | undefined {
  if (!q || !q.latest) return undefined;
  const fails = new Set(q.rules.filter((r) => r.severity === 'fail').map((r) => r.id));
  return q.latest.results.filter((r) => !r.passed && fails.has(r.ruleId)).length;
}

/** Record a run: it becomes `latest`, and one line of `history` (capped at MAX_HISTORY). */
export function appendRun(q: DatasetQuality, results: RuleResult[], at: string): DatasetQuality {
  const ids = new Set(q.rules.map((r) => r.id));
  // A rule deleted while the run was in flight is not reported.
  const kept = results.filter((r) => ids.has(r.ruleId));
  const failing: Record<string, number> = {};
  let passed = 0;
  for (const r of kept) {
    failing[r.ruleId] = r.failing;
    if (r.passed) passed += 1;
  }
  const history = (q.history || []).concat([{ at, passed, failed: kept.length - passed, failing }]).slice(-MAX_HISTORY);
  return { rules: q.rules, latest: { at, results: kept }, history };
}

/**
 * FAIL-severity rules that went from passing (or never run) to failing between
 * two runs — each is told once, and stays quiet while it keeps failing.
 */
export function newlyFailing(
  rules: QualityRule[],
  prev: RuleResult[] | undefined,
  next: RuleResult[],
): Array<{ rule: QualityRule; result: RuleResult; previous?: RuleResult }> {
  const before = new Map((prev || []).map((r) => [r.ruleId, r]));
  const out: Array<{ rule: QualityRule; result: RuleResult; previous?: RuleResult }> = [];
  for (const result of next) {
    if (result.passed) continue;
    const rule = rules.find((r) => r.id === result.ruleId);
    const was = before.get(result.ruleId);
    if (!rule || rule.severity !== 'fail' || (was && !was.passed)) continue;
    out.push({ rule, result, previous: was });
  }
  return out;
}

// ── Resolution (shared by both engines, so their errors are identical) ───────

export type Resolved =
  | { ok: false; error: string }
  | { ok: true; ci: number; type: ColumnType; refCi: number; refType: ColumnType };

/**
 * Bind a rule to a schema. `ref` is the referenced table's columns for a
 * `references` rule — `null` when that dataset is gone.
 */
export function resolveRule(
  rule: QualityRule,
  columns: ParsedColumn[],
  ref?: { columns: ParsedColumn[] } | null,
): Resolved {
  const err = (error: string): Resolved => ({ ok: false, error });
  if (rule.kind === 'row_count') return { ok: true, ci: -1, type: 'number', refCi: -1, refType: 'number' };
  const name = rule.column ?? '';
  const ci = colIndex(columns, name);
  if (ci < 0) return err(`Column "${name}" no longer exists`);
  const type = columns[ci].type;
  if (rule.kind === 'range') {
    if (type === 'text') return err(`"${name}" is a text column — a range needs a number or date column`);
    const b = rule.args.min ?? rule.args.max;
    if ((typeof b === 'number') !== (type === 'number')) return err(`The bounds don't match "${name}", which is a ${type} column`);
  }
  if (rule.kind === 'regex' && type === 'number') return err(`"${name}" is a number column — patterns apply to text and date columns`);
  if (rule.kind === 'references') {
    if (!ref) return err('The dataset this rule checks against no longer exists');
    const other = rule.args.column ?? '';
    const refCi = colIndex(ref.columns, other);
    if (refCi < 0) return err(`Column "${other}" no longer exists in the referenced dataset`);
    const refType = ref.columns[refCi].type;
    if ((type === 'number') !== (refType === 'number')) {
      return err(`"${name}" is a ${type} column but "${other}" is ${refType} — the types must match`);
    }
    return { ok: true, ci, type, refCi, refType };
  }
  return { ok: true, ci, type, refCi: -1, refType: type };
}

// ── The JS reference ─────────────────────────────────────────────────────────

/** A cell's key: a finite number in a number column, the text otherwise, null when empty or unkeyable. */
export function cellKey(cell: Cell | undefined, isNumber: boolean): string | number | null {
  const c = cell ?? null;
  if (isEmptyCell(c)) return null;
  if (isNumber) return typeof c === 'number' && Number.isFinite(c) ? c : null;
  return String(c);
}

/** A canonical date cell as YYYY-MM-DD, or null. */
function dateKey(cell: Cell): string | null {
  if (!isCanonicalDateCell(cell)) return null;
  const d = parseDateCell(cell)!;
  return `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
}

/** The in_set values a number column compares against — the `in` filter's rule. */
export function numberSet(values: string[] | undefined): number[] {
  const out: number[] = [];
  for (const v of values || []) {
    const n = coerceValue(v, 'number');
    if (typeof n === 'number' && Number.isFinite(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * "Does this row fail the rule?", built over the WHOLE table (`unique` needs
 * every row to judge one). Not defined for row_count, which has no failing rows.
 */
export function failingPredicateJs(
  rule: QualityRule,
  columns: ParsedColumn[],
  rows: Cell[][],
  ref?: RefTable | null,
): { test: (row: Cell[]) => boolean } | { error: string } {
  const r = resolveRule(rule, columns, ref);
  if (!r.ok) return { error: r.error };
  if (rule.kind === 'row_count') return { error: 'A row-count rule has no failing rows' };
  const ci = r.ci;
  const isNum = r.type === 'number';
  const at = (row: Cell[]): Cell => (Array.isArray(row) ? row[ci] ?? null : null);
  const { min, max } = rule.args;
  const outside = (v: number | string): boolean => (min !== undefined && v < min) || (max !== undefined && v > max);

  switch (rule.kind) {
    case 'not_null':
      return { test: (row) => isEmptyCell(at(row)) };
    case 'unique': {
      const seen = new Map<string | number, number>();
      for (const row of rows) {
        const k = cellKey(at(row), isNum);
        if (k !== null) seen.set(k, (seen.get(k) || 0) + 1);
      }
      return { test: (row) => { const k = cellKey(at(row), isNum); return k !== null && (seen.get(k) || 0) > 1; } };
    }
    case 'range':
      return {
        test: (row) => {
          const c = at(row);
          if (isEmptyCell(c)) return false;
          const v = isNum ? (typeof c === 'number' && Number.isFinite(c) ? c : null) : dateKey(c);
          return v === null || outside(v);
        },
      };
    case 'regex': {
      const re = jsRegex(rule.args.pattern ?? '');
      return { test: (row) => { const c = at(row); return !isEmptyCell(c) && !re.test(String(c)); } };
    }
    case 'in_set': {
      const set = new Set<string | number>(isNum ? numberSet(rule.args.values) : rule.args.values || []);
      return { test: (row) => { const c = at(row); if (isEmptyCell(c)) return false; const k = cellKey(c, isNum); return k === null || !set.has(k); } };
    }
    case 'references': {
      const keys = new Set<string | number>();
      const refNum = r.refType === 'number';
      for (const row of ref ? ref.rows : []) {
        const k = cellKey(Array.isArray(row) ? row[r.refCi] : null, refNum);
        if (k !== null) keys.add(k);
      }
      return { test: (row) => { const c = at(row); if (isEmptyCell(c)) return false; const k = cellKey(c, isNum); return k === null || !keys.has(k); } };
    }
  }
  return { error: 'Unknown rule kind' };
}

/** A row_count rule over `n` rows — shared by both engines, which only differ in how they count. */
export function rowCountResult(rule: QualityRule, n: number): RuleResult {
  const { min, max } = rule.args;
  const out = (typeof min === 'number' && n < min) || (typeof max === 'number' && n > max);
  return { ruleId: rule.id, passed: !out, failing: out ? 1 : 0, sample: [] };
}

/** One rule, over a whole in-memory table. The reference `qualityResident` is tested against. */
export function evaluateRuleJs(
  rule: QualityRule,
  columns: ParsedColumn[],
  rows: Cell[][],
  ref?: RefTable | null,
): RuleResult {
  if (rule.kind === 'row_count') return rowCountResult(rule, rows.length);
  const p = failingPredicateJs(rule, columns, rows, ref);
  if ('error' in p) return { ruleId: rule.id, passed: false, failing: 0, sample: [], error: p.error };
  let failing = 0;
  const sample: Cell[][] = [];
  for (const row of rows) {
    if (!p.test(row)) continue;
    failing += 1;
    if (sample.length < SAMPLE_ROWS) sample.push(columns.map((_, c) => (Array.isArray(row) ? row[c] ?? null : null)));
  }
  return { ruleId: rule.id, passed: failing === 0, failing, sample };
}
