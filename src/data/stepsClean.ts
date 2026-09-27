// Cleaning steps — parse_date, dedupe_key, replace_values, conditional_column.
// MAIN PROCESS, PURE: the JS REFERENCE that src/engine/sqlGenClean.ts must
// reproduce (scripts/test-powerStepsDuck.ts holds them to Object.is).
//
// conditional_column is NOT evaluated here: `conditionalAsCalc` compiles its
// rules to ONE formula and transforms.ts runs it through the calculated-field
// machinery — the formula engine is the only evaluator.

import type { Cell, TableData, CalculatedFieldStep } from './transforms';
import { colIndex, cellToString, isEmptyCell, retypeColumn } from './transforms';
import type { ParsedColumn } from './parse';
import { coerceValue } from './parse';
import type { ConditionalColumnStep, DedupeKeyStep, ParseDateStep, ReplaceValuesStep } from './stepTypes';
import { checkRegex, jsRegex } from './regexSubset';
import type { PowerResult } from './stepsReshape';
import { skipped } from './stepsReshape';

// ── parse_date ───────────────────────────────────────────────────────────────

export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MMM-YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD', 'YYYYMMDD'];
export const TIME_FORMATS = ['', ' HH:mm', ' HH:mm:ss', 'THH:mm', 'THH:mm:ss'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
type Tok = 'YYYY' | 'MMM' | 'MM' | 'DD' | 'HH' | 'mm' | 'ss';
const TOKS: Tok[] = ['YYYY', 'MMM', 'MM', 'DD', 'HH', 'mm', 'ss'];
const STRPTIME: Record<Tok, string> = { YYYY: '%Y', MMM: '%b', MM: '%m', DD: '%d', HH: '%H', mm: '%M', ss: '%S' };

export function isDateFormat(f: unknown): f is string {
  return typeof f === 'string' && DATE_FORMATS.some((d) => TIME_FORMATS.some((t) => d + t === f));
}

export interface DateFormatPlan {
  parts: Array<Tok | { lit: string }>;
  hasTime: boolean;
  /** RE2 shape gate — exact digit counts, so try_strptime's leniency never decides. */
  re2: string;
  strptime: string;
  outFormat: string;
}

/** Tokenise an allow-listed format. The one parse every engine derives from. */
export function planDateFormat(f: string): DateFormatPlan {
  const parts: DateFormatPlan['parts'] = [];
  for (let i = 0; i < f.length; ) {
    const tok = TOKS.find((t) => f.startsWith(t, i));
    if (tok) {
      parts.push(tok);
      i += tok.length;
    } else {
      parts.push({ lit: f[i] });
      i += 1;
    }
  }
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const monthRe = '(?:' + MONTHS.map((m) => m.split('').map((c) => `[${c.toUpperCase()}${c}]`).join('')).join('|') + ')';
  const re2 = parts.map((p) => (typeof p === 'string' ? (p === 'YYYY' ? '[0-9]{4}' : p === 'MMM' ? monthRe : '[0-9]{2}') : esc(p.lit))).join('');
  const strptime = parts.map((p) => (typeof p === 'string' ? STRPTIME[p] : p.lit)).join('');
  const hasTime = parts.includes('HH');
  return { parts, hasTime, re2, strptime, outFormat: hasTime ? '%Y-%m-%d %H:%M:%S' : '%Y-%m-%d' };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

function daysIn(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** Only ASCII space/tab is trimmed — the same class the SQL side strips. */
export function trimSpaceTab(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

/** One cell → ISO text, or null when it does not match the format or the calendar. */
export function parseDateCell(text: string, plan: DateFormatPlan): string | null {
  const s = trimSpaceTab(text);
  const f: Partial<Record<Tok, number>> = {};
  let i = 0;
  for (const p of plan.parts) {
    if (typeof p !== 'string') {
      if (s[i] !== p.lit) return null;
      i += 1;
      continue;
    }
    if (p === 'MMM') {
      const m = MONTHS.indexOf(s.slice(i, i + 3).toLowerCase());
      if (m < 0 || !/^[A-Za-z]{3}$/.test(s.slice(i, i + 3))) return null;
      f.MM = m + 1;
      i += 3;
      continue;
    }
    const w = p === 'YYYY' ? 4 : 2;
    const digits = s.slice(i, i + w);
    if (!/^[0-9]+$/.test(digits) || digits.length !== w) return null;
    f[p] = Number(digits);
    i += w;
  }
  if (i !== s.length) return null;
  const y = f.YYYY as number;
  const mo = f.MM as number;
  const d = f.DD as number;
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null;
  const date = `${pad(y, 4)}-${pad(mo)}-${pad(d)}`;
  if (!plan.hasTime) return date;
  const h = f.HH as number;
  const mi = f.mm as number;
  const sec = f.ss ?? 0;
  if (h > 23 || mi > 59 || sec > 59) return null;
  return `${date} ${pad(h)}:${pad(mi)}:${pad(sec)}`;
}

export function parseDateProblem(columns: ParsedColumn[], s: ParseDateStep): string | null {
  if (colIndex(columns, s.column) < 0) return `Parse dates skipped: unknown column "${s.column}"`;
  if (!isDateFormat(s.format)) return `Parse dates skipped: unsupported format "${s.format}"`;
  const as = typeof s.as === 'string' ? s.as.trim() : '';
  if (as && as !== s.column && colIndex(columns, as) >= 0) return `Parse dates skipped: column "${as}" already exists`;
  return null;
}

export function applyParseDate(t: TableData, s: ParseDateStep): PowerResult {
  const problem = parseDateProblem(t.columns, s);
  if (problem) return skipped(t, problem);
  const ci = colIndex(t.columns, s.column);
  const plan = planDateFormat(s.format);
  const as = typeof s.as === 'string' ? s.as.trim() : '';
  const parsed = (cell: Cell): Cell => (isEmptyCell(cell) ? null : parseDateCell(cellToString(cell), plan));
  if (!as || as === s.column) {
    const columns = t.columns.map((c, k) => (k === ci ? { name: c.name, type: 'date' as const } : { ...c }));
    const rows = t.rows.map((r) => r.map((v, k) => (k === ci ? parsed(v ?? null) : v)));
    return { table: { columns, rows }, warnings: [] };
  }
  const columns = [...t.columns.map((c) => ({ ...c })), { name: as, type: 'date' as const }];
  const rows = t.rows.map((r) => [...r, parsed(r[ci] ?? null)]);
  return { table: { columns, rows }, warnings: [] };
}

/** The editor's preview over the step's INPUT: how many failed, and the first distinct failures. */
export function parseDatePreview(t: TableData, s: ParseDateStep, sampleMax = 5): {
  total: number; parsed: number; failed: number; empty: number; samples: string[];
} {
  const ci = colIndex(t.columns, s.column);
  const out = { total: t.rows.length, parsed: 0, failed: 0, empty: 0, samples: [] as string[] };
  if (ci < 0 || !isDateFormat(s.format)) return out;
  const plan = planDateFormat(s.format);
  for (const r of t.rows) {
    const cell = r[ci] ?? null;
    if (isEmptyCell(cell)) { out.empty += 1; continue; }
    const text = cellToString(cell);
    if (parseDateCell(text, plan) !== null) { out.parsed += 1; continue; }
    out.failed += 1;
    if (out.samples.length < sampleMax && !out.samples.includes(text)) out.samples.push(text);
  }
  return out;
}

// ── dedupe_key ───────────────────────────────────────────────────────────────

/** The value a max/min survivor is ranked on: a finite number, a non-empty string, or null. */
export function rankValue(cell: Cell, type: ParsedColumn['type']): number | string | null {
  if (type === 'number') return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
  return isEmptyCell(cell) ? null : cellToString(cell);
}

export function applyDedupeKey(t: TableData, s: DedupeKeyStep): PowerResult {
  const warnings: string[] = [];
  const keyIdx: number[] = [];
  for (const name of s.columns) {
    const ci = colIndex(t.columns, name);
    if (ci < 0) warnings.push(`Dedupe: unknown column "${name}" ignored`);
    else keyIdx.push(ci);
  }
  if (!keyIdx.length) return { table: t, warnings: [...warnings, 'Dedupe skipped: none of the given columns exist'] };
  const byIdx = s.keep === 'max' || s.keep === 'min' ? colIndex(t.columns, s.by || '') : -1;
  if ((s.keep === 'max' || s.keep === 'min') && byIdx < 0) {
    return { table: t, warnings: [...warnings, `Dedupe skipped: unknown column "${s.by || ''}" to rank by`] };
  }
  const byType = byIdx >= 0 ? t.columns[byIdx].type : 'text';
  const best = new Map<string, number>();
  t.rows.forEach((r, i) => {
    const key = JSON.stringify(keyIdx.map((ci) => r[ci] ?? null));
    const cur = best.get(key);
    if (cur === undefined || s.keep === 'last') { best.set(key, i); return; }
    if (s.keep === 'first') return;
    const a = rankValue(r[byIdx] ?? null, byType);
    const b = rankValue(t.rows[cur][byIdx] ?? null, byType);
    // Strictly better only: a tie keeps the EARLIER row, and null never wins.
    if (a !== null && (b === null || (s.keep === 'max' ? a > b : a < b))) best.set(key, i);
  });
  const keep = new Set(best.values());
  const rows = t.rows.filter((_, i) => keep.has(i)).map((r) => r.slice());
  return { table: { columns: t.columns.map((c) => ({ ...c })), rows }, warnings };
}

// ── replace_values ───────────────────────────────────────────────────────────

export function replaceProblem(columns: ParsedColumn[], s: ReplaceValuesStep): string | null {
  if (colIndex(columns, s.column) < 0) return `Replace skipped: unknown column "${s.column}"`;
  if (!s.rules.length) return 'Replace skipped: add at least one rule';
  if (s.mode === 'contains' && s.rules.some((r) => r.from === '')) return 'Replace skipped: a "contains" rule needs text to find';
  if (s.mode === 'regex') {
    for (const r of s.rules) {
      const chk = checkRegex(r.from);
      if (!chk.ok) return `Replace skipped: ${chk.error}`;
    }
  }
  return null;
}

export function applyReplace(t: TableData, s: ReplaceValuesStep): PowerResult {
  const problem = replaceProblem(t.columns, s);
  if (problem) return skipped(t, problem);
  const ci = colIndex(t.columns, s.column);
  const exact = new Map<string, string>();
  if (s.mode === 'exact') for (const r of s.rules) if (!exact.has(r.from)) exact.set(r.from, r.to);
  const res = s.mode === 'regex'
    ? s.rules.map((r) => {
      const chk = checkRegex(r.from);
      return chk.ok ? jsRegex(chk.js, !!s.ignoreCase) : null;
    })
    : [];
  const rewrite = (cell: Cell): Cell => {
    if (s.mode === 'exact') {
      const hit = exact.get(cellToString(cell));
      return hit === undefined ? cell : hit;
    }
    if (cell === null) return null;
    const before = cellToString(cell);
    let text = before;
    s.rules.forEach((r, k) => {
      // A replacer FUNCTION, so `$&` / `$1` in the replacement stay literal text.
      text = s.mode === 'contains' ? text.split(r.from).join(r.to) : text.replace(res[k] as RegExp, () => r.to);
    });
    return text === before ? cell : text;
  };
  const columns = t.columns.map((c) => ({ ...c }));
  const rows = t.rows.map((r) => r.map((v, k) => (k === ci ? rewrite(v ?? null) : v)));
  retypeColumn(columns, rows, ci);
  return { table: { columns, rows }, warnings: [] };
}

// ── conditional_column ───────────────────────────────────────────────────────

/** A formula string literal. The tokenizer's one escape: backslash + any char. */
export function formulaString(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** The rule's operand as a NUMBER literal (number column + a strictly numeric value), else null. */
export function ruleNumber(type: ParsedColumn['type'], value: unknown): number | null {
  if (type !== 'number') return null;
  const n = coerceValue(typeof value === 'number' || typeof value === 'string' ? value : null, 'number');
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** A column a formula can reference as `[name]` — the tokenizer has no escape for `]` and trims. */
export function formulaReferenceable(name: string): boolean {
  return name !== '' && !name.includes(']') && name.trim() === name;
}

/**
 * The rules as ONE `IF … ELSEIF … ELSE … END` formula for the calculated-field
 * machinery, or the warning the step skips with. The name/column guards run
 * here so the warning names the conditional step, not a calculated field.
 */
export function conditionalAsCalc(columns: ParsedColumn[], s: ConditionalColumnStep): CalculatedFieldStep | string {
  const name = typeof s.name === 'string' ? s.name.trim() : '';
  if (!name) return 'Conditional column skipped: blank column name';
  if (colIndex(columns, name) >= 0) return `Conditional column skipped: column "${name}" already exists`;
  if (!s.rules.length) return 'Conditional column skipped: add at least one rule';
  const tests: string[] = [];
  for (const rule of s.rules) {
    const c = rule.when.column;
    const ci = colIndex(columns, c);
    if (ci < 0) return `Conditional column skipped: unknown column "${c}"`;
    if (!formulaReferenceable(c)) return `Conditional column skipped: column "${c}" cannot be used in a rule`;
    const ref = `[${c}]`;
    const raw = rule.when.value;
    const text = raw === undefined ? '' : String(raw);
    const n = ruleNumber(columns[ci].type, raw);
    const lit = n === null ? formulaString(text) : String(n);
    const op = rule.when.op;
    // No leading "(": `IF (` would parse as a call to the if() function.
    if (op === 'is_empty') tests.push(`isnull(${ref}) or trim(${ref}) = ""`);
    else if (op === 'not_empty') tests.push(`not (isnull(${ref}) or trim(${ref}) = "")`);
    else if (op === 'contains') tests.push(`contains(${ref}, ${formulaString(text)})`);
    else tests.push(`${ref} ${op} ${lit}`);
  }
  const val = (v: string | null | undefined): string => (v === null || v === undefined ? 'null' : formulaString(v));
  let expression = `IF ${tests[0]} THEN ${val(s.rules[0].then)}`;
  for (let k = 1; k < tests.length; k += 1) expression += ` ELSEIF ${tests[k]} THEN ${val(s.rules[k].then)}`;
  expression += ` ELSE ${val(s.else)} END`;
  return { type: 'calculated_field', name, expression };
}
