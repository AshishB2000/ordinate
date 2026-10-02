// Multi-currency — THE JS REFERENCE for converting money columns to a target
// currency at each row's date. PURE: no fs, no Electron, no DuckDB. The resident
// twin is src/engine/fxResident.ts (an ASOF join over the stored Parquet), held
// to `Object.is` agreement with this file by scripts/test-fxResident.ts.
//
// ── What a declaration says ──────────────────────────────────────────────────
// A NUMBER column may declare its currency: fixed (`{kind:'fixed', code:'EUR'}`)
// or per row from another column (`{kind:'column', column:'currency'}`), plus
// the date column whose value picks the rate. No date given → the dataset's
// first date column; a dataset with no date column at all converts at the
// LATEST rate (LATEST_DAY), which is the only rate it can honestly name.
//
// ── The rate a row gets — the precedence, in order ──────────────────────────
//   1. Identity: the row's currency IS the target → 1. Explicit, needs no date,
//      and is never what a missing rate falls back to.
//   2. Direct: cur→target, the NEAREST rate dated on or before the row's day.
//   3. Inverse: target→cur, nearest-earlier, as 1 / rate.
//   4. Triangulated via USD (only when neither side is USD): leg(cur→USD) ×
//      leg(USD→target), where each leg is itself direct-else-inverse,
//      nearest-earlier.
//   5. Otherwise MISSING: the converted cell is null (so the row drops out of
//      sum/avg/min/max exactly like an empty cell), and the row is COUNTED in
//      the hidden marker column, which names the pair ("EUR→USD"). Never 1.
// A direct rate wins over a FRESHER inverse — precedence is by kind first, date
// second, so the answer does not depend on which direction a table happens to
// have published most recently.
//
// ── Cells ────────────────────────────────────────────────────────────────────
// Amount: only a finite JS number converts; anything else (empty, text) is left
// exactly as it was and is not counted. Currency cell: exactly three ASCII
// letters, upper-cased; anything else (empty included) is no currency → missing
// as "?→USD". Date cell: `categoryKey.parseDateCell` (the app's one date
// grammar); an empty or unreadable date → missing unless identity applies.
// Rate table rows: a valid from/to code, a readable date and a finite rate > 0,
// else skipped. Two rates for the same pair on the same day: the LAST in table
// order wins.

import type { Cell, TableData } from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import { daysFromCivil, parseDateCell } from './categoryKey';

export const PIVOT_CURRENCY = 'USD';
/** The day a dataset with no date column converts at: after every rate. */
export const LATEST_DAY = 99_999_999;
/** The hidden marker column a converted table carries: the missing pair, or null. */
export const FX_MARK = '\u0001fx';
/** How many missing pairs a warning names before "+N more". */
export const MAX_PAIRS = 5;

const CODE_RE = /^[A-Z]{3}$/;
const CELL_CODE_RE = /^[A-Za-z]{3}$/;
const MAX_NAME = 200;

export function isCurrencyCode(v: unknown): v is string {
  return typeof v === 'string' && CODE_RE.test(v);
}

export type CurrencyDecl =
  | { kind: 'fixed'; code: string; date?: string }
  | { kind: 'column'; column: string; date?: string };

export interface FxSourceMap {
  datasetId: string;
  date: string;
  from: string;
  to: string;
  rate: string;
}

export interface FxSettings {
  /** '' = the workspace currency (Settings → Formats). */
  target: string;
  /** null = the bundled sample rates. */
  source: FxSourceMap | null;
  /** datasetId → column → declaration. */
  columns: Record<string, Record<string, CurrencyDecl>>;
  /** dashboard / analysis id → its own target. */
  dashboards: Record<string, string>;
}

/** What a converted answer carries to the tile. */
export interface FxInfo {
  target: string;
  missing: number;
  pairs: string[];
  sample: boolean;
  /** `fxWarning` of the above, for the tile to print as is ('' = nothing missing). */
  warning?: string;
}

/** An FxInfo with its warning sentence filled in — what leaves main. */
export function fxInfo(target: string, miss: { missing: number; pairs: string[] }, sample: boolean): FxInfo {
  const out: FxInfo = { target, missing: miss.missing, pairs: miss.pairs, sample };
  out.warning = fxWarning(out);
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function name(v: unknown): string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME ? v : '';
}

export function sanitizeDecl(raw: unknown): CurrencyDecl | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const date = name(o.date);
  let out: CurrencyDecl | null = null;
  if (o.kind === 'fixed' && isCurrencyCode(o.code)) out = { kind: 'fixed', code: o.code };
  else if (o.kind === 'column' && name(o.column)) out = { kind: 'column', column: name(o.column) };
  if (out && date) out.date = date;
  return out;
}

export function sanitizeSource(raw: unknown): FxSourceMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.datasetId !== 'string' || !UUID_RE.test(o.datasetId)) return null;
  const m = { datasetId: o.datasetId, date: name(o.date), from: name(o.from), to: name(o.to), rate: name(o.rate) };
  return m.date && m.from && m.to && m.rate ? m : null;
}

export function sanitizeSettings(raw: unknown): FxSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: FxSettings = { target: isCurrencyCode(o.target) ? o.target : '', source: sanitizeSource(o.source), columns: {}, dashboards: {} };
  const cols = o.columns && typeof o.columns === 'object' ? (o.columns as Record<string, unknown>) : {};
  for (const [ds, map] of Object.entries(cols)) {
    if (!UUID_RE.test(ds) || !map || typeof map !== 'object') continue;
    const keep: Record<string, CurrencyDecl> = {};
    for (const [col, d] of Object.entries(map as Record<string, unknown>)) {
      const decl = name(col) ? sanitizeDecl(d) : null;
      if (decl) keep[col] = decl;
    }
    if (Object.keys(keep).length) out.columns[ds] = keep;
  }
  const dash = o.dashboards && typeof o.dashboards === 'object' ? (o.dashboards as Record<string, unknown>) : {};
  for (const [id, code] of Object.entries(dash)) if (UUID_RE.test(id) && isCurrencyCode(code)) out.dashboards[id] = code;
  return out;
}

// ── Cells ────────────────────────────────────────────────────────────────────

export function cellCode(cell: Cell | undefined): string | null {
  return typeof cell === 'string' && CELL_CODE_RE.test(cell) ? cell.toUpperCase() : null;
}

export function cellDay(cell: Cell | undefined): number | null {
  const c = parseDateCell(cell ?? null);
  return c ? daysFromCivil(c.y, c.m, c.d) : null;
}

// ── The rate table ───────────────────────────────────────────────────────────

export interface RateRow {
  from: string;
  to: string;
  day: number;
  rate: number;
}

export interface RateTable {
  /** `FROM>TO` → ascending days with their rates. */
  byPair: Map<string, { days: number[]; rates: number[] }>;
}

/** The valid rows of a rate table, in table order (no de-duplication here). */
export function rateRowsFromTable(table: TableData, map: { date: string; from: string; to: string; rate: string }): RateRow[] {
  const idx = (n: string): number => table.columns.findIndex((c) => c.name === n);
  const di = idx(map.date);
  const fi = idx(map.from);
  const ti = idx(map.to);
  const ri = idx(map.rate);
  if (di < 0 || fi < 0 || ti < 0 || ri < 0) return [];
  const out: RateRow[] = [];
  for (const r of table.rows) {
    if (!r) continue;
    const from = cellCode(r[fi]);
    const to = cellCode(r[ti]);
    const day = cellDay(r[di]);
    const rate = r[ri];
    if (from && to && day !== null && typeof rate === 'number' && Number.isFinite(rate) && rate > 0) out.push({ from, to, day, rate });
  }
  return out;
}

/** Index rows by pair; the LAST row for a (pair, day) wins. */
export function buildRates(rows: RateRow[]): RateTable {
  const tmp = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const k = r.from + '>' + r.to;
    let m = tmp.get(k);
    if (!m) tmp.set(k, (m = new Map()));
    m.set(r.day, r.rate);
  }
  const byPair = new Map<string, { days: number[]; rates: number[] }>();
  for (const [k, m] of tmp) {
    const days = [...m.keys()].sort((a, b) => a - b);
    byPair.set(k, { days, rates: days.map((d) => m.get(d) as number) });
  }
  return { byPair };
}

/** The rate for from→to dated on or before `day` — the nearest earlier one — or null. */
export function nearestRate(t: RateTable, from: string, to: string, day: number): number | null {
  const p = t.byPair.get(from + '>' + to);
  if (!p) return null;
  let lo = 0;
  let hi = p.days.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p.days[mid] <= day) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return hit < 0 ? null : p.rates[hit];
}

/** One leg: direct, else the inverse of the reverse pair. */
function leg(t: RateTable, from: string, to: string, day: number): number | null {
  const direct = nearestRate(t, from, to, day);
  if (direct !== null) return direct;
  const inv = nearestRate(t, to, from, day);
  return inv === null ? null : 1 / inv;
}

/** The multiplier taking 1 `from` to `to` on `day`, by the precedence above, or null. */
export function crossRate(t: RateTable, from: string | null, to: string, day: number | null): number | null {
  if (from === null) return null;
  if (from === to) return 1;
  if (day === null) return null;
  const one = leg(t, from, to, day);
  if (one !== null) return one;
  if (from === PIVOT_CURRENCY || to === PIVOT_CURRENCY) return null;
  const a = leg(t, from, PIVOT_CURRENCY, day);
  const b = leg(t, PIVOT_CURRENCY, to, day);
  return a !== null && b !== null ? a * b : null;
}

// ── A conversion plan over one table ─────────────────────────────────────────

export interface ConvertCol {
  /** The amount column. */
  index: number;
  /** A fixed code, or the index of the currency column (-1 when it is gone). */
  code: string | null;
  curIndex: number;
  /** The date column, or -1 → LATEST_DAY. */
  dateIndex: number;
}

export interface FxPlan {
  target: string;
  cols: ConvertCol[];
}

/**
 * Which of `wanted` convert, and how. A declaration on a non-number column is
 * ignored — an aggregate over it is null on both paths anyway.
 */
export function resolvePlan(columns: ParsedColumn[], decls: Record<string, CurrencyDecl> | undefined, wanted: string[], target: string): FxPlan | null {
  if (!decls || !isCurrencyCode(target)) return null;
  const at = (n: string | undefined): number => (n ? columns.findIndex((c) => c.name === n) : -1);
  const firstDate = columns.findIndex((c) => c.type === 'date');
  const cols: ConvertCol[] = [];
  for (const w of new Set(wanted)) {
    const d = Object.prototype.hasOwnProperty.call(decls, w) ? decls[w] : undefined;
    const index = at(w);
    if (!d || index < 0 || columns[index].type !== 'number') continue;
    const di = d.date ? at(d.date) : -1;
    cols.push({
      index,
      code: d.kind === 'fixed' ? d.code : null,
      curIndex: d.kind === 'column' ? at(d.column) : -1,
      dateIndex: di >= 0 ? di : firstDate,
    });
  }
  return cols.length ? { target, cols } : null;
}

/** The pair a missing cell names. */
export function pairLabel(cur: string | null, target: string): string {
  return (cur ?? '?') + '→' + target;
}

/**
 * The table with every planned amount converted, plus the FX_MARK column. A
 * missing rate nulls the cell and marks the row with its pair — the FIRST
 * missing column's pair when several convert.
 */
export function convertTable(table: TableData, plan: FxPlan, rates: RateTable): TableData {
  const columns = table.columns.concat([{ name: FX_MARK, type: 'text' }]);
  const rows: Cell[][] = new Array(table.rows.length);
  for (let i = 0; i < table.rows.length; i++) {
    const src = table.rows[i] || [];
    const row = src.slice(0, table.columns.length);
    while (row.length < table.columns.length) row.push(null);
    let mark: string | null = null;
    for (const c of plan.cols) {
      const amt = src[c.index];
      if (typeof amt !== 'number' || !Number.isFinite(amt)) continue;
      const cur = c.code ?? (c.curIndex >= 0 ? cellCode(src[c.curIndex]) : null);
      const day = c.dateIndex >= 0 ? cellDay(src[c.dateIndex]) : LATEST_DAY;
      const eff = crossRate(rates, cur, plan.target, day);
      if (eff === null) {
        row[c.index] = null;
        if (mark === null) mark = pairLabel(cur, plan.target);
      } else {
        row[c.index] = amt * eff;
      }
    }
    row.push(mark);
    rows[i] = row;
  }
  return { columns, rows };
}

/** Missing rows and their pairs, over a converted (and already filtered) table. */
export function missingOf(table: TableData): { missing: number; pairs: string[] } {
  const mi = table.columns.findIndex((c) => c.name === FX_MARK);
  if (mi < 0) return { missing: 0, pairs: [] };
  let missing = 0;
  const pairs = new Set<string>();
  for (const r of table.rows) {
    const v = r ? r[mi] : null;
    if (typeof v === 'string' && v) { missing += 1; pairs.add(v); }
  }
  return { missing, pairs: sortPairs([...pairs]) };
}

export function sortPairs(pairs: string[]): string[] {
  return pairs.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Two answers on one tile (a formula's operands) → one note. */
export function mergeFx(a: FxInfo | undefined, b: FxInfo | undefined): FxInfo | undefined {
  if (!a) return b;
  if (!b) return a;
  return fxInfo(a.target, { missing: a.missing + b.missing, pairs: sortPairs([...new Set(a.pairs.concat(b.pairs))]) }, a.sample || b.sample);
}

/** "3 rows had no EUR→USD rate — excluded", or '' when nothing was missing. */
export function fxWarning(fx: FxInfo | undefined): string {
  if (!fx || fx.missing <= 0) return '';
  const rows = fx.missing === 1 ? '1 row' : fx.missing.toLocaleString('en-US') + ' rows';
  const named = fx.pairs.filter((p) => !p.startsWith('?'));
  const noCode = fx.pairs.some((p) => p.startsWith('?'));
  const shown = named.slice(0, MAX_PAIRS).join(', ') + (named.length > MAX_PAIRS ? ` +${named.length - MAX_PAIRS} more` : '');
  if (!named.length) return `${rows} had no currency code — excluded`;
  return `${rows} had no ${shown} rate${noCode ? ' or no currency code' : ''} — excluded`;
}

export const SAMPLE_LABEL = 'Sample rates, not live';

/** The codes the pickers offer. Any valid ISO-4217 code is accepted from a file. */
export const COMMON_CODES: readonly string[] = [
  'USD', 'EUR', 'GBP', 'JPY', 'INR', 'CNY', 'CAD', 'AUD', 'CHF', 'BRL', 'MXN', 'SEK',
  'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'NZD', 'SGD', 'HKD', 'KRW', 'TWD', 'THB', 'IDR',
  'MYR', 'PHP', 'ZAR', 'TRY', 'AED', 'SAR', 'ILS',
];
