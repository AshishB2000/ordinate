// DASHBOARD PARAMETERS — the one resolver. MAIN PROCESS, PURE: no Electron, no
// fs, no DuckDB. Node-testable by a plain self-check.
//
// A parameter is a named value on a dashboard — "threshold = 2000", "region =
// West", "as of = 2024-06-30" — that the reader moves with a control and that
// the rest of the sheet REFERENCES:
//
//   {{name}}  in tile titles and text cards — replaced by the value as TEXT;
//   [[name]]  in filter step values, calculated fields and metric formulas —
//             replaced by the value as a TYPED operand.
//
// Every substitution happens HERE, before anything is evaluated, and every one
// is typed rather than spliced:
//
//   · a filter step's value becomes the parameter's value itself — a number
//     stays a number, a list becomes the `values` of an `in` step — so the
//     resident SQL binds it as a parameter exactly like a value typed into the
//     filter dialog, and nothing about the value ever reaches SQL text;
//   · a formula gets a literal in the formula language (a number, or a quoted
//     string with the formula tokenizer's escapes), outside string literals only,
//     and the formula is then parsed by the app's own parser — there is no eval.
//
// The SQL of the Query tab binds through `bindSqlParams` below, for the same
// reason: numbers and dates bind as `?` parameters and a list binds as one `?`
// per element. A value is never concatenated into a statement.
//
// An unbound reference — a name no parameter has, or a parameter with no value
// yet — is never a crash. A filter step that references one is DROPPED with a
// validation message (a filter against `[[typo]]` would otherwise quietly match
// zero rows, which reads as "no data" rather than "broken reference"); a
// formula reads it as `null`, which the formula language already propagates.

import type { Cell, FilterStep, TransformStep } from '../data/transforms';
import { daysFromIso } from './dateIntel';

export type ParamKind = 'number' | 'text' | 'date' | 'list';
export const PARAM_KINDS: readonly ParamKind[] = ['number', 'text', 'date', 'list'];

export type ParamValue = number | string | string[] | null;

/** Where a list parameter's options come from: typed in, or a dataset column. */
export type ParamOptions = string[] | { datasetId: string; column: string };

export interface Parameter {
  id: string;
  /** What `{{name}}` / `[[name]]` refer to. Letters, digits and underscores. */
  name: string;
  kind: ParamKind;
  /** The DEFAULT — what a reader sees on open. The live value is view state. */
  value: ParamValue;
  list?: ParamOptions;
  min?: number;
  max?: number;
  step?: number;
}

/** What a resolver reads: each parameter's kind and CURRENT value, by lower-cased name. */
export type ParamValues = Map<string, { name: string; kind: ParamKind; value: ParamValue }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
/** `[[name]]` — a typed operand. */
export const REF_RE = /\[\[\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\]\]/g;
/** `{{name}}` — text in a title or a text card. */
export const TEXT_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}/g;

const MAX_PARAMS = 50;
const MAX_LIST = 500;
const MAX_TEXT = 500;
/** Past 15 significant digits a double stops round-tripping — parse.ts's own limit. */
const NUM_LIMIT = 1e15;

// ── Sanitising ──────────────────────────────────────────────────────────────

function finite(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= NUM_LIMIT ? n : undefined;
}

function cleanText(v: unknown): string {
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT);
}

/** One value, shaped by its kind. Anything that does not fit is null — "no value". */
export function sanitizeParamValue(kind: ParamKind, raw: unknown, bounds?: { min?: number; max?: number }): ParamValue {
  if (raw == null) return null;
  if (kind === 'number') {
    let n = finite(raw);
    if (n === undefined) return null;
    if (bounds && bounds.min !== undefined && n < bounds.min) n = bounds.min;
    if (bounds && bounds.max !== undefined && n > bounds.max) n = bounds.max;
    return n;
  }
  if (kind === 'date') return typeof raw === 'string' && daysFromIso(raw.trim()) !== null ? raw.trim() : null;
  if (kind === 'list') {
    const arr = Array.isArray(raw) ? raw : [raw];
    const out: string[] = [];
    for (const v of arr) {
      if (v == null || typeof v === 'object') continue;
      const s = cleanText(v);
      if (!out.includes(s)) out.push(s);
      if (out.length >= MAX_LIST) break;
    }
    return out;
  }
  return typeof raw === 'object' ? null : cleanText(raw);
}

function sanitizeOptions(raw: unknown): ParamOptions | undefined {
  if (Array.isArray(raw)) {
    const v = sanitizeParamValue('list', raw);
    return Array.isArray(v) && v.length ? v : undefined;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.datasetId === 'string' && UUID_RE.test(o.datasetId) && typeof o.column === 'string' && o.column) {
      return { datasetId: o.datasetId, column: o.column };
    }
  }
  return undefined;
}

/**
 * A dashboard's stored parameter list → clean. Unknown kinds, bad names and
 * duplicate names (case-insensitive — `[[Threshold]]` and `[[threshold]]` must
 * not be two things) are DROPPED; ids that are not UUIDs are regenerated by the
 * caller, which owns id minting.
 */
export function sanitizeParameters(raw: unknown, newId: () => string): Parameter[] {
  const out: Parameter[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const kind = o.kind as ParamKind;
    if (!PARAM_NAME_RE.test(name) || !PARAM_KINDS.includes(kind) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const p: Parameter = { id: typeof o.id === 'string' && UUID_RE.test(o.id) ? o.id : newId(), name, kind, value: null };
    if (kind === 'number') {
      const min = finite(o.min);
      const max = finite(o.max);
      const step = finite(o.step);
      if (min !== undefined) p.min = min;
      if (max !== undefined) p.max = max;
      if (p.min !== undefined && p.max !== undefined && p.min > p.max) [p.min, p.max] = [p.max, p.min];
      if (step !== undefined && step > 0) p.step = step;
    }
    if (kind === 'list' || kind === 'text') {
      const list = sanitizeOptions(o.list);
      if (list) p.list = list;
    }
    p.value = sanitizeParamValue(kind, o.value, p);
    out.push(p);
    if (out.length >= MAX_PARAMS) break;
  }
  return out;
}

/**
 * What the renderer sends with a query — `[{ name, kind, value }]`, the
 * dashboard's parameters at their CURRENT values — as a lookup. Untrusted
 * input: every entry is re-shaped by its kind, and a malformed one is dropped.
 */
export function paramValues(raw: unknown): ParamValues {
  const out: ParamValues = new Map();
  for (const r of Array.isArray(raw) ? raw.slice(0, MAX_PARAMS) : []) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const kind = o.kind as ParamKind;
    if (!PARAM_NAME_RE.test(name) || !PARAM_KINDS.includes(kind)) continue;
    const bounds = { min: finite(o.min), max: finite(o.max) };
    out.set(name.toLowerCase(), { name, kind, value: sanitizeParamValue(kind, o.value, bounds) });
  }
  return out;
}

/** The names a text references with `[[…]]`, lower-cased, de-duplicated. */
export function paramRefs(text: unknown): string[] {
  if (typeof text !== 'string' || text.indexOf('[[') < 0) return [];
  const out: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const k = m[1].toLowerCase();
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

// ── {{name}} — text ─────────────────────────────────────────────────────────

/** A value as a reader sees it in a title: 2,000 · 2024-06-30 · West, East. */
export function paramDisplay(kind: ParamKind, value: ParamValue): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (kind === 'number' && typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return String(value);
}

/**
 * `{{name}}` → the value as text. A name no parameter has is LEFT AS TYPED —
 * the author sees the braces and knows the reference is broken, where a blank
 * would read as a value that happens to be empty.
 */
export function substituteText(text: string, values: ParamValues, display = paramDisplay): string {
  if (typeof text !== 'string' || text.indexOf('{{') < 0) return text;
  return text.replace(TEXT_RE, (whole, name: string) => {
    const p = values.get(name.toLowerCase());
    return p ? display(p.kind, p.value) : whole;
  });
}

// ── [[name]] — typed operands in filter steps ───────────────────────────────

const SCALAR_OPS = new Set(['=', '!=', '>', '<', '>=', '<=', 'contains']);

function refOnly(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^\s*\[\[\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\]\]\s*$/.exec(v);
  return m ? m[1] : null;
}

/**
 * Filter steps with every `[[name]]` value replaced by the parameter's value.
 *
 * `value: "[[threshold]]"` becomes the NUMBER 2000 (or the string, or the ISO
 * date), so the step is exactly the step the filter dialog would have written
 * with that value typed in. A list parameter feeds `in`/`not in` as its
 * `values`. A reference embedded in longer text (`contains "Q[[quarter]]"`)
 * is replaced as text. Anything that cannot be made well-typed — an unknown
 * name, a list where one value is needed — DROPS the step and says why.
 * A parameter with no value yet drops its step silently: an unset parameter
 * filters nothing, like an unset control.
 */
export function resolveFilterParams(steps: FilterStep[], values: ParamValues): { steps: FilterStep[]; errors: string[] } {
  const out: FilterStep[] = [];
  const errors: string[] = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    const r = resolveStep(s, values);
    if (r.error) errors.push(r.error);
    if (r.step) out.push(r.step);
  }
  return { steps: out, errors };
}

function resolveStep(s: FilterStep, values: ParamValues): { step?: FilterStep; error?: string } {
  if (!s || s.type !== 'filter') return { step: s };
  const hasRef = paramRefs(s.value).length > 0 || (Array.isArray(s.values) && s.values.some((v) => paramRefs(v).length > 0));
  if (!hasRef) return { step: s };
  const unknown = (name: string): string => `Filter on "${s.column}" skipped: no parameter named "${name}" on this dashboard`;

  if (Array.isArray(s.values)) {
    const next: Cell[] = [];
    for (const v of s.values) {
      const only = refOnly(v);
      if (!only) {
        next.push(v);
        continue;
      }
      const p = values.get(only.toLowerCase());
      if (!p) return { error: unknown(only) };
      if (p.value == null) continue;
      if (Array.isArray(p.value)) next.push(...p.value);
      else next.push(p.value);
    }
    if (next.length === 0) return {}; // every referenced parameter is unset — filters nothing
    return { step: { ...s, values: next } };
  }

  const only = refOnly(s.value);
  if (only) {
    const p = values.get(only.toLowerCase());
    if (!p) return { error: unknown(only) };
    if (p.value == null || (Array.isArray(p.value) && p.value.length === 0)) return {};
    if (Array.isArray(p.value)) {
      // A list is many values: it belongs in "is any of", and `=` against a
      // list would have to pick one silently.
      if (s.op === '=' || s.op === '!=') {
        return { step: { type: 'filter', column: s.column, op: s.op === '=' ? 'in' : 'not in', values: p.value.slice() } };
      }
      return { error: `Filter on "${s.column}" skipped: "${p.name}" is a list — use it with "is any of"` };
    }
    if (!SCALAR_OPS.has(s.op)) return { step: s };
    return { step: { ...s, value: p.value } };
  }

  // Embedded in text: textual, and only for scalar values.
  let err: string | undefined;
  const text = String(s.value).replace(REF_RE, (whole, name: string) => {
    const p = values.get(name.toLowerCase());
    if (!p) { err = err || unknown(name); return whole; }
    if (Array.isArray(p.value)) { err = err || `Filter on "${s.column}" skipped: "${p.name}" is a list — use it on its own`; return whole; }
    return p.value == null ? '' : String(p.value);
  });
  if (err) return { error: err };
  return { step: { ...s, value: text } };
}

// ── [[name]] — literals in formulas ─────────────────────────────────────────

/** A value as a formula-language literal. Strings use the tokenizer's escapes. */
function formulaLiteral(kind: ParamKind, value: ParamValue): string {
  if (value == null) return 'null';
  if (typeof value === 'number') return value < 0 ? `(${String(value)})` : String(value);
  if (Array.isArray(value)) return 'null';
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * A formula with each `[[name]]` OUTSIDE a string literal replaced by a literal
 * of the parameter's value. The rewritten text is then parsed by the app's own
 * formula parser like any other — nothing is evaluated here. An unknown name or
 * a list reads as `null` and is reported.
 */
export function bindFormulaText(expr: string, values: ParamValues): { text: string; errors: string[] } {
  const errors: string[] = [];
  if (typeof expr !== 'string' || expr.indexOf('[[') < 0) return { text: expr, errors };
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < expr.length && expr[j] !== c) j += expr[j] === '\\' ? 2 : 1;
      out += expr.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '[' && expr[i + 1] === '[') {
      const end = expr.indexOf(']]', i + 2);
      const name = end > 0 ? expr.slice(i + 2, end).trim() : '';
      if (end > 0 && PARAM_NAME_RE.test(name)) {
        const p = values.get(name.toLowerCase());
        if (!p) errors.push(`No parameter named "${name}" on this dashboard`);
        else if (Array.isArray(p.value)) errors.push(`"${p.name}" is a list — a formula takes one value`);
        out += p ? formulaLiteral(p.kind, p.value) : 'null';
        i = end + 2;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return { text: out, errors };
}

/** Whether a prepare pipeline references a parameter anywhere. */
export function stepsUseParams(steps: TransformStep[] | undefined): boolean {
  for (const s of Array.isArray(steps) ? steps : []) {
    if (s && s.type === 'calculated_field' && paramRefs(s.expression).length) return true;
    if (s && s.type === 'filter' && (paramRefs(s.value).length || (Array.isArray(s.values) && s.values.some((v) => paramRefs(v).length)))) return true;
  }
  return false;
}

/**
 * A prepare pipeline with its parameters bound — calculated fields get
 * literals, filter steps get typed values — ready for `applyPipeline`. This is
 * how a calculated field that says `[revenue] * (1 - [[discount]])` follows a
 * dashboard's discount slider: the dataset is replayed from its source with
 * the slider's value, only when a query carries parameters and only for a
 * pipeline that references one.
 */
export function bindStepParams(steps: TransformStep[], values: ParamValues): { steps: TransformStep[]; errors: string[] } {
  const errors: string[] = [];
  const out: TransformStep[] = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    if (s && s.type === 'calculated_field' && paramRefs(s.expression).length) {
      const b = bindFormulaText(s.expression, values);
      errors.push(...b.errors);
      out.push({ ...s, expression: b.text });
    } else if (s && s.type === 'filter') {
      const r = resolveStep(s, values);
      if (r.error) errors.push(r.error);
      if (r.step) out.push(r.step);
    } else {
      out.push(s);
    }
  }
  return { steps: out, errors };
}
