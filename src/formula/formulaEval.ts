// The formula EVALUATOR: the value helpers, the date helpers, the regex cache,
// the arithmetic and comparison operators, and the FUNCTIONS table. Everything
// that turns operands into a value. MAIN PROCESS, PURE logic.
//
// Runtime problems degrade to `null` — never throw, never fabricate a number.
// A numeric STRING is not a number here; arithmetic on a text cell yields null.
//
// Split out of formula.ts — see .claude/rules/file-size.md. Ordinary TS module;
// the only edits to the moved code are the `export` keywords.

import type { FValue } from './formula';

// ── Evaluation helpers ───────────────────────────────────────────────────────

export type EvalFn = (row: Record<string, FValue>) => FValue;

// Coerce a value to a finite number, or null. A numeric STRING is NOT a number
// here — arithmetic on a non-number operand yields null (never fabricate a value
// from a text cell). Numeric literals arrive already typed as `number`.
export function num(v: FValue | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Truthiness for if()/and/or/not: null→false, boolean as-is, number nonzero,
// non-empty string.
export function truthy(v: FValue): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  return String(v).length > 0;
}

// Loose equality shared by `=`/`!=`, CASE...WHEN, and the IN operator: numeric
// when both sides are numbers, null==null only, else string compare. Never
// throws.
export function looseEq(a: FValue, b: FValue): boolean {
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return na === nb;
  if (a === null || b === null) return a === null && b === null;
  return String(a) === String(b);
}

// ── Date helpers (dates live as text cells; parse → JS Date, format back) ──────
// Screenchart has no date TYPE — a "date" column is text (parse.ts detects the
// shape but keeps the string). So date functions parse the text to a JS Date,
// compute, and return either an integer (YEAR, DATEDIFF…) or an ISO-ish string
// (DATEADD, DATETRUNC…). An unparseable value degrades to null, never throws.

// Parse a value to a local-time Date, or null. Numbers are NOT treated as date
// serials (Tableau's serial encoding is ambiguous across engines) — return null.
function toDate(v: FValue): Date | null {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'number') return null; // ponytail: no serial-date guessing
  const s = String(v).trim();
  if (!s) return null;
  // YYYY-MM-DD / YYYY/MM/DD (+ optional HH:MM[:SS]) — parsed as LOCAL time so it
  // agrees with TODAY()/NOW(); avoids new Date('YYYY-MM-DD') being UTC-midnight.
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const dt = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  // MM/DD/YYYY (US)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) {
    const dt = new Date(+m[3], +m[1] - 1, +m[2]);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function fmtDate(d: Date): string {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function fmtDateTime(d: Date): string {
  return fmtDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// Whole days since the Unix epoch for d's LOCAL calendar date (DST-safe: uses the
// y/m/d components via a UTC construction, so the count is exact integer days).
function dayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}
function dayOfYear(d: Date): number {
  return dayNumber(d) - Math.floor(Date.UTC(d.getFullYear(), 0, 1) / 86400000) + 1;
}
// Sunday-start week-of-year (Tableau's default), 1-based.
function weekOfYear(d: Date): number {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = dayNumber(d) - dayNumber(jan1);
  return Math.floor((days + jan1.getDay()) / 7) + 1;
}
// ISO-8601 week + week-numbering year.
function isoParts(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - day + 3); // move to the Thursday of this ISO week
  const isoYear = t.getUTCFullYear();
  const firstThu = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * 86400000));
  return { year: isoYear, week };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function normPart(v: FValue): string {
  return v == null ? '' : String(v).trim().toLowerCase();
}
function partIsTime(part: string): boolean {
  return part === 'hour' || part === 'minute' || part === 'second';
}

function datePart(part: string, d: Date): number | null {
  switch (part) {
    case 'year': return d.getFullYear();
    case 'quarter': return Math.floor(d.getMonth() / 3) + 1;
    case 'month': return d.getMonth() + 1;
    case 'dayofyear': return dayOfYear(d);
    case 'day': return d.getDate();
    case 'weekday': return d.getDay() + 1; // 1=Sunday … 7=Saturday
    case 'week': return weekOfYear(d);
    case 'hour': return d.getHours();
    case 'minute': return d.getMinutes();
    case 'second': return d.getSeconds();
    case 'iso-year': return isoParts(d).year;
    case 'iso-quarter': return Math.floor(d.getMonth() / 3) + 1;
    case 'iso-week': return isoParts(d).week;
    case 'iso-weekday': return ((d.getDay() + 6) % 7) + 1; // 1=Monday … 7=Sunday
    default: return null;
  }
}
function dateName(part: string, d: Date): string | null {
  if (part === 'month') return MONTH_NAMES[d.getMonth()];
  if (part === 'weekday') return WEEKDAY_NAMES[d.getDay()];
  const p = datePart(part, d);
  return p === null ? null : String(p);
}
// Tableau counts boundary crossings, not elapsed time (DATEDIFF('year',
// 2020-12-31, 2021-01-01) === 1). Day/week diffs use integer day counts (DST-safe).
function dateDiff(part: string, d1: Date, d2: Date): number | null {
  switch (part) {
    case 'year': return d2.getFullYear() - d1.getFullYear();
    case 'quarter': return (d2.getFullYear() - d1.getFullYear()) * 4 + (Math.floor(d2.getMonth() / 3) - Math.floor(d1.getMonth() / 3));
    case 'month': return (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
    case 'week': return Math.trunc(((dayNumber(d2) - d2.getDay()) - (dayNumber(d1) - d1.getDay())) / 7);
    case 'day':
    case 'dayofyear':
    case 'weekday': return dayNumber(d2) - dayNumber(d1);
    case 'hour': return Math.trunc((d2.getTime() - d1.getTime()) / 3600000);
    case 'minute': return Math.trunc((d2.getTime() - d1.getTime()) / 60000);
    case 'second': return Math.trunc((d2.getTime() - d1.getTime()) / 1000);
    default: return null;
  }
}
function dateAdd(part: string, n: number, d: Date): Date | null {
  const r = new Date(d.getTime());
  switch (part) {
    case 'year': r.setFullYear(r.getFullYear() + n); break;
    case 'quarter': r.setMonth(r.getMonth() + n * 3); break;
    case 'month': r.setMonth(r.getMonth() + n); break;
    case 'week': r.setDate(r.getDate() + n * 7); break;
    case 'day':
    case 'dayofyear':
    case 'weekday': r.setDate(r.getDate() + n); break;
    case 'hour': r.setHours(r.getHours() + n); break;
    case 'minute': r.setMinutes(r.getMinutes() + n); break;
    case 'second': r.setSeconds(r.getSeconds() + n); break;
    default: return null;
  }
  return r;
}
function dateTrunc(part: string, d: Date): Date | null {
  const y = d.getFullYear();
  const m = d.getMonth();
  switch (part) {
    case 'year': return new Date(y, 0, 1);
    case 'quarter': return new Date(y, Math.floor(m / 3) * 3, 1);
    case 'month': return new Date(y, m, 1);
    case 'week': { const r = new Date(y, m, d.getDate()); r.setDate(r.getDate() - r.getDay()); return r; }
    case 'day':
    case 'dayofyear':
    case 'weekday': return new Date(y, m, d.getDate());
    case 'hour': return new Date(y, m, d.getDate(), d.getHours());
    case 'minute': return new Date(y, m, d.getDate(), d.getHours(), d.getMinutes());
    case 'second': return new Date(y, m, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    default: return null;
  }
}

// ── Regex cache (compile each pattern once, not per row) ──────────────────────
// ponytail: user-authored patterns run over the user's own local data; a
// pathological pattern can backtrack slowly, but there is no remote input here.
const RE_CACHE = new Map<string, RegExp | null>();
function getRe(pattern: string, flags: string): RegExp | null {
  const key = flags + ' ' + pattern;
  if (RE_CACHE.has(key)) return RE_CACHE.get(key)!;
  let re: RegExp | null;
  try {
    re = new RegExp(pattern, flags);
  } catch (_) {
    re = null;
  }
  if (RE_CACHE.size < 500) RE_CACHE.set(key, re); // bounded — never an unbounded leak
  return re;
}

export function arith(op: string, l: EvalFn, r: EvalFn): EvalFn {
  return (row) => {
    const a = num(l(row));
    const b = num(r(row));
    if (a === null || b === null) return null; // non-numeric/null operand → null
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return b === 0 ? null : a / b; // div-by-zero → null, not Infinity
      case '%':
        return b === 0 ? null : a % b;
      default:
        return null;
    }
  };
}

export function compareOp(op: string, l: EvalFn, r: EvalFn): EvalFn {
  return (row) => {
    const a = l(row);
    const b = r(row);
    const na = num(a);
    const nb = num(b);
    const numeric = na !== null && nb !== null;

    if (op === '=' || op === '==' || op === '!=') {
      const eq = looseEq(a, b);
      return op === '!=' ? !eq : eq;
    }

    // ordering: numeric when both sides numeric, else string compare
    if (numeric) {
      switch (op) {
        case '>':
          return na > nb;
        case '<':
          return na < nb;
        case '>=':
          return na >= nb;
        case '<=':
          return na <= nb;
      }
    }
    const sa = a == null ? '' : String(a);
    const sb = b == null ? '' : String(b);
    switch (op) {
      case '>':
        return sa > sb;
      case '<':
        return sa < sb;
      case '>=':
        return sa >= sb;
      case '<=':
        return sa <= sb;
      default:
        return false;
    }
  };
}

// A one-argument math wrapper: coerce to number, apply f, guard the result to a
// finite number (rejects NaN/±Infinity from e.g. sqrt(-1), ln(0), tan(π/2)).
function math1(f: (x: number) => number): (a: FValue[]) => FValue {
  return (a) => {
    const x = num(a[0]);
    if (x === null) return null;
    const r = f(x);
    return Number.isFinite(r) ? r : null;
  };
}
// String function: null arg → null, else operate on String(arg0).
function str1(f: (s: string) => FValue): (a: FValue[]) => FValue {
  return (a) => (a[0] == null ? null : f(String(a[0])));
}

// Built-in functions (Tableau-compatible, row-level only). Names are matched
// case-insensitively. Unknown names → compile error (see Parser.parseCall).
export const FUNCTIONS: Record<string, (args: FValue[]) => FValue> = {
  // ── Number ──────────────────────────────────────────────────────────────
  round: (a) => {
    const x = num(a[0]);
    if (x === null) return null;
    const nRaw = a.length > 1 ? num(a[1]) : 0;
    const d = nRaw === null ? 0 : Math.trunc(nRaw);
    const f = Math.pow(10, d);
    // For |d| ≳ 309, f overflows to Infinity (or underflows to 0) and x*f/f is
    // NaN — which would poison the whole calculated-field column with "NaN". A
    // digit count beyond double precision (±15) is meaningless anyway; fall back
    // to integer rounding rather than emit NaN.
    if (!Number.isFinite(f) || f === 0) return Math.round(x);
    return Math.round(x * f) / f;
  },
  abs: math1(Math.abs),
  floor: math1(Math.floor),
  ceil: math1(Math.ceil),
  ceiling: math1(Math.ceil), // Tableau name
  sign: math1(Math.sign),
  sqrt: math1((x) => Math.sqrt(x)),
  square: math1((x) => x * x),
  exp: math1(Math.exp),
  ln: math1(Math.log), // Number.isFinite guard rejects ln(0)=-Infinity, ln(-1)=NaN
  sin: math1(Math.sin),
  cos: math1(Math.cos),
  tan: math1(Math.tan),
  asin: math1(Math.asin),
  acos: math1(Math.acos),
  atan: math1(Math.atan),
  cot: math1((x) => 1 / Math.tan(x)),
  degrees: math1((x) => (x * 180) / Math.PI),
  radians: math1((x) => (x * Math.PI) / 180),
  pi: () => Math.PI,
  atan2: (a) => {
    const y = num(a[0]);
    const x = num(a[1]);
    return y === null || x === null ? null : Math.atan2(y, x);
  },
  power: (a) => {
    const x = num(a[0]);
    const p = num(a[1]);
    if (x === null || p === null) return null;
    const r = Math.pow(x, p);
    return Number.isFinite(r) ? r : null;
  },
  log: (a) => {
    const x = num(a[0]);
    if (x === null || x <= 0) return null;
    const base = a.length > 1 ? num(a[1]) : 10; // Tableau default base 10
    if (base === null || base <= 0 || base === 1) return null;
    return Math.log(x) / Math.log(base);
  },
  div: (a) => {
    const p = num(a[0]);
    const q = num(a[1]);
    return p === null || q === null || q === 0 ? null : Math.trunc(p / q);
  },
  zn: (a) => {
    const x = num(a[0]);
    return x === null ? 0 : x; // null/non-numeric → 0
  },
  min: (a) => reduceMinMax(a, false),
  max: (a) => reduceMinMax(a, true),

  // ── String ──────────────────────────────────────────────────────────────
  lower: str1((s) => s.toLowerCase()),
  upper: str1((s) => s.toUpperCase()),
  trim: str1((s) => s.trim()),
  ltrim: str1((s) => s.replace(/^\s+/, '')),
  rtrim: str1((s) => s.replace(/\s+$/, '')),
  len: str1((s) => s.length),
  proper: str1((s) => s.replace(/[A-Za-z0-9]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())),
  ascii: str1((s) => (s.length ? s.charCodeAt(0) : null)),
  char: (a) => {
    const n = num(a[0]);
    return n === null ? null : String.fromCharCode(Math.trunc(n));
  },
  space: (a) => {
    const n = num(a[0]);
    if (n === null || n < 0) return null;
    return ' '.repeat(Math.min(Math.trunc(n), 100000)); // clamp — no runaway alloc
  },
  contains: (a) => (a[0] == null || a[1] == null ? null : String(a[0]).includes(String(a[1]))),
  startswith: (a) => (a[0] == null || a[1] == null ? null : String(a[0]).startsWith(String(a[1]))),
  endswith: (a) => (a[0] == null || a[1] == null ? null : String(a[0]).endsWith(String(a[1]))),
  left: (a) => {
    const n = num(a[1]);
    return a[0] == null || n === null ? null : String(a[0]).slice(0, Math.max(0, Math.trunc(n)));
  },
  right: (a) => {
    const n = num(a[1]);
    if (a[0] == null || n === null) return null;
    const t = Math.trunc(n);
    return t <= 0 ? '' : String(a[0]).slice(-t);
  },
  mid: (a) => {
    const start = num(a[1]);
    if (a[0] == null || start === null) return null;
    const s = String(a[0]);
    const from = Math.max(0, Math.trunc(start) - 1); // Tableau is 1-based
    if (a.length > 2) {
      const len = num(a[2]);
      if (len === null) return null;
      return s.slice(from, from + Math.max(0, Math.trunc(len)));
    }
    return s.slice(from);
  },
  find: (a) => {
    if (a[0] == null || a[1] == null) return null;
    const s = String(a[0]);
    const sub = String(a[1]);
    const startRaw = a.length > 2 ? num(a[2]) : 1;
    const start = startRaw === null ? 1 : Math.trunc(startRaw);
    const idx = s.indexOf(sub, Math.max(0, start - 1));
    return idx < 0 ? 0 : idx + 1; // 1-based, 0 = not found
  },
  findnth: (a) => {
    if (a[0] == null || a[1] == null) return null;
    const s = String(a[0]);
    const sub = String(a[1]);
    const n = num(a[2]);
    if (n === null || n < 1 || sub === '') return 0;
    let idx = -1;
    for (let k = 0; k < Math.trunc(n); k++) {
      idx = s.indexOf(sub, idx + 1);
      if (idx < 0) return 0;
    }
    return idx + 1;
  },
  replace: (a) => {
    if (a[0] == null || a[1] == null || a[2] == null) return null;
    const sub = String(a[1]);
    if (sub === '') return String(a[0]);
    return String(a[0]).split(sub).join(String(a[2])); // replace ALL, literal
  },
  split: (a) => {
    if (a[0] == null || a[1] == null) return null;
    const n = num(a[2]);
    if (n === null || n === 0) return null;
    const parts = String(a[0]).split(String(a[1]));
    const idx = n > 0 ? Math.trunc(n) - 1 : parts.length + Math.trunc(n); // negative = from end
    return idx >= 0 && idx < parts.length ? parts[idx] : null;
  },
  regexp_match: (a) => {
    if (a[0] == null || a[1] == null) return null;
    const re = getRe(String(a[1]), '');
    return re ? re.test(String(a[0])) : null;
  },
  regexp_extract: (a) => {
    if (a[0] == null || a[1] == null) return null;
    const re = getRe(String(a[1]), '');
    if (!re) return null;
    const m = String(a[0]).match(re);
    return m ? (m[1] ?? m[0]) : null; // first capture group, else whole match
  },
  regexp_extract_nth: (a) => {
    if (a[0] == null || a[1] == null) return null;
    const n = num(a[2]);
    const re = getRe(String(a[1]), '');
    if (!re || n === null) return null;
    const m = String(a[0]).match(re);
    return m ? (m[Math.trunc(n)] ?? null) : null; // 0 = whole match, 1 = group 1…
  },
  regexp_replace: (a) => {
    if (a[0] == null || a[1] == null || a[2] == null) return null;
    const re = getRe(String(a[1]), 'g');
    return re ? String(a[0]).replace(re, String(a[2])) : null;
  },

  // ── Date ────────────────────────────────────────────────────────────────
  year: (a) => { const d = toDate(a[0]); return d ? d.getFullYear() : null; },
  month: (a) => { const d = toDate(a[0]); return d ? d.getMonth() + 1 : null; },
  day: (a) => { const d = toDate(a[0]); return d ? d.getDate() : null; },
  quarter: (a) => { const d = toDate(a[0]); return d ? Math.floor(d.getMonth() / 3) + 1 : null; },
  week: (a) => { const d = toDate(a[0]); return d ? weekOfYear(d) : null; },
  isoweek: (a) => { const d = toDate(a[0]); return d ? isoParts(d).week : null; },
  isoyear: (a) => { const d = toDate(a[0]); return d ? isoParts(d).year : null; },
  isoquarter: (a) => { const d = toDate(a[0]); return d ? Math.floor(d.getMonth() / 3) + 1 : null; },
  isoweekday: (a) => { const d = toDate(a[0]); return d ? ((d.getDay() + 6) % 7) + 1 : null; },
  datepart: (a) => { const d = toDate(a[1]); return d ? datePart(normPart(a[0]), d) : null; },
  datename: (a) => { const d = toDate(a[1]); return d ? dateName(normPart(a[0]), d) : null; },
  datediff: (a) => {
    const d1 = toDate(a[1]);
    const d2 = toDate(a[2]);
    return d1 && d2 ? dateDiff(normPart(a[0]), d1, d2) : null;
  },
  dateadd: (a) => {
    const part = normPart(a[0]);
    const n = num(a[1]);
    const d = toDate(a[2]);
    if (n === null || !d) return null;
    const r = dateAdd(part, Math.trunc(n), d);
    return r ? (partIsTime(part) ? fmtDateTime(r) : fmtDate(r)) : null;
  },
  datetrunc: (a) => {
    const part = normPart(a[0]);
    const d = toDate(a[1]);
    if (!d) return null;
    const r = dateTrunc(part, d);
    return r ? (partIsTime(part) ? fmtDateTime(r) : fmtDate(r)) : null;
  },
  makedate: (a) => {
    const y = num(a[0]);
    const m = num(a[1]);
    const d = num(a[2]);
    if (y === null || m === null || d === null) return null;
    const r = new Date(Math.trunc(y), Math.trunc(m) - 1, Math.trunc(d));
    return Number.isNaN(r.getTime()) ? null : fmtDate(r);
  },
  maketime: (a) => {
    const h = num(a[0]);
    const mi = num(a[1]);
    const s = num(a[2]);
    if (h === null || mi === null || s === null) return null;
    const r = new Date(1899, 11, 30, Math.trunc(h), Math.trunc(mi), Math.trunc(s));
    return Number.isNaN(r.getTime()) ? null : fmtDateTime(r);
  },
  makedatetime: (a) => {
    const d = toDate(a[0]);
    const t = toDate(a[1]);
    if (!d || !t) return null;
    const r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.getHours(), t.getMinutes(), t.getSeconds());
    return fmtDateTime(r);
  },
  now: () => fmtDateTime(new Date()),
  today: () => fmtDate(new Date()),
  isdate: (a) => (a[0] == null ? false : toDate(a[0]) !== null),
  date: (a) => { const d = toDate(a[0]); return d ? fmtDate(d) : null; },
  datetime: (a) => { const d = toDate(a[0]); return d ? fmtDateTime(d) : null; },

  // ── Type conversion ──────────────────────────────────────────────────────
  int: (a) => {
    const v = a[0];
    if (v == null) return null;
    if (typeof v === 'number') return Math.trunc(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? Math.trunc(n) : null;
  },
  float: (a) => {
    const v = a[0];
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  },
  str: (a) => (a[0] == null ? null : String(a[0])),

  // ── Logical / misc ────────────────────────────────────────────────────────
  concat: (a) => a.map((v) => (v == null ? '' : String(v))).join(''),
  if: (a) => (truthy(a[0]) ? a[1] ?? null : a[2] ?? null), // if(cond, then, else) call form
  iif: (a) => {
    if (a[0] === null && a.length > 3) return a[3] ?? null; // explicit unknown branch
    return truthy(a[0]) ? a[1] ?? null : a[2] ?? null;
  },
  ifnull: (a) => (a[0] == null ? a[1] ?? null : a[0]),
  isnull: (a) => a[0] == null,
  coalesce: (a) => {
    for (const v of a) if (v !== null && v !== undefined) return v;
    return null;
  },
};

// Variadic min/max. Numeric when every non-null arg is a number, else lexical
// string compare. Uses reduce (never Math.min(...spread) — a huge arg list would
// overflow the call stack).
function reduceMinMax(a: FValue[], wantMax: boolean): FValue {
  const vals = a.filter((v) => v !== null && v !== undefined);
  if (!vals.length) return null;
  const nums = vals.map(num);
  if (nums.every((n) => n !== null)) {
    return (nums as number[]).reduce((m, n) => (wantMax ? (n > m ? n : m) : n < m ? n : m));
  }
  return vals.map((v) => String(v)).reduce((m, s) => (wantMax ? (s > m ? s : m) : s < m ? s : m));
}

