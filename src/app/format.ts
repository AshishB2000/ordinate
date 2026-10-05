// THE APP'S FORMATTER — every number and date a reader sees. PURE, and loaded
// by BOTH processes:
//
//   main      `import * as fmt from '../app/format'` — metric displays, captions,
//             alert sentences, anything main hands the renderer as finished text;
//   renderer  `<script src="../../src/app/format.js">` between cjsShim.js and
//             formatBind.js, which expose it as the global `OrdFormat` — chart
//             axes, tooltips, value labels, KPI cards, tables, reports, exports.
//
// One module, so "Revenue" cannot read $5.2M on a card and 5194598.73 in a
// caption, and so Settings → General → Formats changes every one of them at
// once. THIS FILE MUST NOT IMPORT ANYTHING AT RUNTIME: the renderer loads its
// CommonJS output through a two-line shim with no `require`. `import type` is
// fine — it is erased.
//
// The workspace preferences are module state (`setFormatPrefs`), set by main
// from config and by the renderer from the config it is sent; every function
// reads them unless told otherwise. A per-metric format (`formatMetric`) still
// wins over them for what it specifies — decimals, compact, its own prefix —
// and takes the rest (locale, separators, the workspace currency) from here.

export type NumberStyle = 'locale' | 'comma_dot' | 'dot_comma' | 'space_comma' | 'apostrophe_dot' | 'plain_dot';
export type DateStyle = 'short' | 'medium' | 'iso';
export type CurrencyPosition = 'before' | 'after';

export interface FormatPrefs {
  /** BCP-47, or '' for the system's own. */
  locale: string;
  /** Grouping and decimal marks: the locale's, or one spelled out. */
  numberStyle: NumberStyle;
  /** ISO 4217. */
  currency: string;
  currencyPosition: CurrencyPosition;
  dateFormat: DateStyle;
  /** 0 = Sunday … 6 = Saturday — read by the relative periods, not by this file. */
  weekStart: number;
  /** 1 = January … 12 — read by the relative periods, not by this file. */
  fiscalYearStart: number;
  /** Gregorian, a retail 4-4-5 / 4-5-4 / 5-4-4 or the ISO week-year (analysis/retailCalendar). Not read here. */
  calendarType: 'gregorian' | '445' | '454' | '544' | 'iso';
  /** Retail year end: the Saturday nearest Jan 31, or the last Saturday of January. Not read here. */
  yearEnd: 'nearest' | 'last';
  /** Big figures as 5.2M rather than 5,194,598.73 where a view has no format of its own. */
  compact: boolean;
}

const FORMAT_DEFAULTS: FormatPrefs = {
  locale: '',
  numberStyle: 'locale',
  currency: 'USD',
  currencyPosition: 'before',
  dateFormat: 'medium',
  weekStart: 1,
  fiscalYearStart: 1,
  calendarType: 'gregorian',
  yearEnd: 'nearest',
  compact: true,
};

/** The locales Settings offers, beyond the system's own. */
const LOCALES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'en-US', label: 'English (United States)' },
  { id: 'en-GB', label: 'English (United Kingdom)' },
  { id: 'en-IN', label: 'English (India)' },
  { id: 'de-DE', label: 'Deutsch (Deutschland)' },
  { id: 'fr-FR', label: 'Français (France)' },
  { id: 'es-ES', label: 'Español (España)' },
  { id: 'it-IT', label: 'Italiano (Italia)' },
  { id: 'nl-NL', label: 'Nederlands (Nederland)' },
  { id: 'pt-BR', label: 'Português (Brasil)' },
  { id: 'ja-JP', label: '日本語 (日本)' },
  { id: 'zh-CN', label: '中文 (中国)' },
];

const CURRENCIES: readonly string[] = ['USD', 'EUR', 'GBP', 'JPY', 'INR', 'CNY', 'CAD', 'AUD', 'CHF', 'BRL', 'MXN', 'SEK'];

const NUMBER_STYLES: ReadonlyArray<{ id: NumberStyle; label: string; group: string; decimal: string }> = [
  { id: 'locale', label: 'From the locale', group: '', decimal: '' },
  { id: 'comma_dot', label: '1,234.56', group: ',', decimal: '.' },
  { id: 'dot_comma', label: '1.234,56', group: '.', decimal: ',' },
  { id: 'space_comma', label: '1 234,56', group: ' ', decimal: ',' },
  { id: 'apostrophe_dot', label: "1'234.56", group: "'", decimal: '.' },
  { id: 'plain_dot', label: '1234.56', group: '', decimal: '.' },
];

// Exported by NAME, not as `export const`: tsc compiles a module's own use of
// an exported const to `exports.X`, and in the renderer `exports` is a global
// the shim removes right after load (cjsShim.ts) — so every later call would
// throw. A local name stays a local reference. test-format.ts runs the module
// the renderer's way to hold this.
export { FORMAT_DEFAULTS, LOCALES, CURRENCIES, NUMBER_STYLES };

// ── Preferences ─────────────────────────────────────────────────────────────

function oneOf<T extends string>(v: unknown, list: readonly T[], dflt: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : dflt;
}

/** Untrusted (disk, IPC) → a complete, valid set. Unknown values fall back. */
export function sanitizeFormatPrefs(raw: unknown): FormatPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ws = Number(o.weekStart);
  const fy = Number(o.fiscalYearStart);
  return {
    locale: oneOf(o.locale, ['', ...LOCALES.map((l) => l.id)], ''),
    numberStyle: oneOf(o.numberStyle, NUMBER_STYLES.map((s) => s.id), 'locale'),
    currency: oneOf(o.currency, CURRENCIES, 'USD'),
    currencyPosition: oneOf(o.currencyPosition, ['before', 'after'] as const, 'before'),
    dateFormat: oneOf(o.dateFormat, ['short', 'medium', 'iso'] as const, 'medium'),
    weekStart: Number.isInteger(ws) && ws >= 0 && ws <= 6 ? ws : FORMAT_DEFAULTS.weekStart,
    fiscalYearStart: Number.isInteger(fy) && fy >= 1 && fy <= 12 ? fy : FORMAT_DEFAULTS.fiscalYearStart,
    calendarType: oneOf(o.calendarType, ['gregorian', '445', '454', '544', 'iso'] as const, 'gregorian'),
    yearEnd: oneOf(o.yearEnd, ['nearest', 'last'] as const, 'nearest'),
    compact: o.compact === undefined ? FORMAT_DEFAULTS.compact : o.compact !== false,
  };
}

let prefs: FormatPrefs = { ...FORMAT_DEFAULTS };

export function setFormatPrefs(p: unknown): void {
  prefs = sanitizeFormatPrefs(p);
}

export function getFormatPrefs(): FormatPrefs {
  return { ...prefs };
}

function localeOf(p: FormatPrefs): string | undefined {
  return p.locale || undefined;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

/**
 * The digits of `v`, with the workspace's grouping and decimal marks. Intl
 * does the rounding and the locale's own marks; an explicit number style then
 * swaps the two separator kinds and nothing else, so digits and the minus sign
 * stay exactly what Intl wrote.
 */
function digits(v: number, minFd: number, maxFd: number, p: FormatPrefs, grouping = true): string {
  const parts = new Intl.NumberFormat(localeOf(p), {
    minimumFractionDigits: minFd, maximumFractionDigits: Math.max(minFd, maxFd), useGrouping: grouping,
  }).formatToParts(v);
  const style = NUMBER_STYLES.find((s) => s.id === p.numberStyle);
  return parts.map((part) => {
    if (style && style.id !== 'locale') {
      if (part.type === 'group') return style.group;
      if (part.type === 'decimal') return style.decimal;
    }
    if (part.type === 'minusSign') return '-';
    return part.value;
  }).join('');
}

const UNITS: ReadonlyArray<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

/**
 * 5.2M / 686.2K / 1.0B. `fixed` keeps the one decimal ("5.0K" — the chart
 * axis and 'auto' style, which never shifts width as values change); otherwise
 * trailing zeros drop ("5K" — a metric's own compact format). A value that
 * rounds up into the next unit moves to it: 999,960 is 1.0M, never 1000.0K.
 */
function compactText(v: number, maxFd: number, fixed: boolean, p: FormatPrefs): string {
  const a = Math.abs(v);
  for (let i = 0; i < UNITS.length; i += 1) {
    const [size, unit] = UNITS[i];
    if (a < size) continue;
    let scaled = v / size;
    let u = unit;
    const f = Math.pow(10, maxFd);
    if (i > 0 && Math.round(Math.abs(scaled) * f) / f >= 1000) {
      scaled = v / UNITS[i - 1][0];
      u = UNITS[i - 1][1];
    }
    return digits(scaled, fixed ? maxFd : 0, maxFd, p) + u;
  }
  return digits(v, 0, fixed ? 3 : maxFd, p);
}

/** A plain number: grouped, at most `maxDecimals` (default 2). */
export function formatNumber(v: number | null | undefined, opts: { decimals?: number; maxDecimals?: number } = {}): string {
  if (v == null || !Number.isFinite(v)) return '';
  if (typeof opts.decimals === 'number') return digits(v, opts.decimals, opts.decimals, prefs);
  return digits(v, 0, typeof opts.maxDecimals === 'number' ? opts.maxDecimals : 2, prefs);
}

/**
 * The app's default figure — what a chart axis, a tooltip and an unformatted
 * KPI show: 5.2M / 686.2K / 842.5, or the full grouped number when the
 * workspace has compact numbers OFF.
 */
export function formatCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '';
  if (!prefs.compact) return digits(v, 0, 2, prefs);
  return compactText(v, 1, true, prefs);
}

// The renderer's DISPLAY currency when a project or an open dashboard converts
// money to a target other than the workspace's (the desktop's fxUi.ts sets it).
// Main never sets it — it serves several projects at once — and passes the
// target to `formatMetric` explicitly instead.
let currencyOverride = '';

export function setCurrencyOverride(code: string | null): void {
  currencyOverride = typeof code === 'string' && /^[A-Z]{3}$/.test(code) ? code : '';
}

/** The currency money is shown in: the override, else the workspace's. */
function activeCurrency(): string {
  return currencyOverride || prefs.currency;
}

/** The workspace currency's symbol: $, €, £, ¥, ₹ — or CHF where there is no glyph. */
export function currencySymbol(code: string = activeCurrency()): string {
  try {
    const part = new Intl.NumberFormat(localeOf(prefs), { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(1).find((x) => x.type === 'currency');
    return part ? part.value : code;
  } catch (_) {
    return code;
  }
}

/** Put a symbol on a body, at the workspace position, minus sign always first. */
function withSymbol(body: string, symbol: string, position: CurrencyPosition): string {
  const neg = body.startsWith('-');
  const b = neg ? body.slice(1) : body;
  const wordy = /^[A-Za-z]{2,}$/.test(symbol);
  const out = position === 'after' ? `${b} ${symbol}` : wordy ? `${symbol} ${b}` : `${symbol}${b}`;
  return neg ? '-' + out : out;
}

/** Money in the workspace currency: $5.2M, 5,2 M €, -£1,200. */
export function formatCurrency(v: number | null | undefined, opts: { decimals?: number; compact?: boolean } = {}): string {
  if (v == null || !Number.isFinite(v)) return '';
  const compact = opts.compact === undefined ? prefs.compact : opts.compact;
  const body = compact && Math.abs(v) >= 1000
    ? compactText(v, Math.max(1, opts.decimals ?? 1), false, prefs)
    : digits(v, opts.decimals ?? 0, opts.decimals ?? 0, prefs);
  return withSymbol(body, currencySymbol(), prefs.currencyPosition);
}

/** A ratio as a percent: 0.132 → 13.2%. */
export function formatPercent(ratio: number | null | undefined, decimals = 1, opts: { maxOnly?: boolean } = {}): string {
  if (ratio == null || !Number.isFinite(ratio)) return '';
  return digits(ratio * 100, opts.maxOnly ? 0 : decimals, decimals, prefs) + '%';
}

/**
 * The chart / card format vocabulary — `auto | plain | thousands | compact |
 * percent | currency` — as the one place it is rendered. `auto` and
 * `compact` are formatCompact; `currency` is the workspace currency, whole.
 */
export function formatValue(v: unknown, mode?: string): string {
  if (v == null) return '';
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return '';
  switch (mode) {
    case 'plain': return digits(v, 0, 3, prefs);
    case 'thousands': return digits(Math.round(v), 0, 0, prefs);
    case 'percent': return formatPercent(v, 2, { maxOnly: true });
    case 'currency': return formatCurrency(v, { decimals: 0, compact: false });
    default: return formatCompact(v);
  }
}

// ── A saved metric's own format ─────────────────────────────────────────────

export interface MetricFormatLike {
  kind: 'number' | 'currency' | 'percent' | 'duration';
  decimals: number;
  prefix?: string;
  suffix?: string;
  compact: boolean;
}

/** Seconds → the two largest non-zero units: 45s, 12m 30s, 1h 23m, 3d 4h. */
function formatDuration(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? '-' : '';
  const s = Math.floor(Math.abs(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${sign}${d}d${h ? ' ' + h + 'h' : ''}`;
  if (h > 0) return `${sign}${h}h${m ? ' ' + m + 'm' : ''}`;
  if (m > 0) return `${sign}${m}m${sec ? ' ' + sec + 's' : ''}`;
  return `${sign}${sec}s`;
}

/**
 * A metric's figure under ITS format — which wins over the workspace for what
 * it says (decimals, compact, an explicit prefix or suffix). A currency metric
 * with no prefix of its own takes the WORKSPACE currency and position, so
 * switching Settings to EUR turns $5.2M into €5.2M everywhere at once.
 * `null` is the app's honest "no figure" and reads as an em dash, never 0.
 */
export function formatMetric(value: number | null | undefined, f: MetricFormatLike, currency?: string): string {
  if (value == null || typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const scaled = f.kind === 'percent' ? value * 100 : value;
  let body: string;
  if (f.kind === 'duration') body = formatDuration(value);
  // A compact number keeps ONE fraction digit at minimum: 5,194,598 with
  // decimals 0 would otherwise read "5M" and throw away the digit compact exists to show.
  else if (f.compact && Math.abs(scaled) >= 1000) body = compactText(scaled, Math.max(1, f.decimals), false, prefs);
  else if (f.compact) body = digits(scaled, 0, Math.max(1, f.decimals), prefs);
  else body = digits(scaled, f.decimals, f.decimals, prefs);

  const suffix = (f.suffix || '') + (f.kind === 'percent' ? '%' : '');
  if (f.kind === 'currency' && !f.prefix) return withSymbol(body, currencySymbol(currency || activeCurrency()), prefs.currencyPosition) + suffix;
  const prefix = f.prefix || '';
  // The minus sign leads, always: "-$1,200", never "$-1,200".
  if (prefix && body.startsWith('-')) return '-' + prefix + body.slice(1) + suffix;
  return prefix + body + suffix;
}

// ── Dates ───────────────────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * A date as the workspace writes them: short (9/24/2026), medium (Sep 24,
 * 2026) or ISO (2026-09-24). Read in UTC from the ISO date, so no timezone can
 * move the day. Anything that is not an ISO date is returned as it is.
 */
export function formatDate(iso: string | null | undefined, style: DateStyle = prefs.dateFormat, withYear = true): string {
  const m = ISO_DAY.exec(String(iso || ''));
  if (!m) return String(iso || '');
  if (style === 'iso') return withYear ? `${m[1]}-${m[2]}-${m[3]}` : `${m[2]}-${m[3]}`;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const o: Intl.DateTimeFormatOptions = style === 'short'
    ? { month: 'numeric', day: 'numeric', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (withYear) o.year = 'numeric';
  return d.toLocaleDateString(localeOf(prefs), o);
}

/** Two ISO bounds → "Sep 1 – Sep 30, 2026" in one year, both years otherwise. */
export function formatDateRange(from?: string, to?: string): string {
  if (from && to) {
    if (from === to) return formatDate(from);
    const sameYear = from.slice(0, 4) === to.slice(0, 4) && prefs.dateFormat !== 'iso';
    return formatDate(from, prefs.dateFormat, !sameYear) + ' – ' + formatDate(to);
  }
  if (from) return 'From ' + formatDate(from);
  if (to) return 'Until ' + formatDate(to);
  return '';
}
