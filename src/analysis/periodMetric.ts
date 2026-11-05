// A period metric (semantic layer part 5, D8): another metric over a window (to date, or the last N units) and/or
// compared with the previous period or year — "Revenue YTD", "Orders 7d", "Revenue vs LY". This file is PURE — the
// type and its whitelist; ./metrics imports from here, never the other way round. A release that cannot compute one
// keeps it verbatim and shows no figure (./pendingKinds).

export type MetricWindow = { to_date: 'week' | 'month' | 'quarter' | 'year' } | { last: number; unit: 'day' | 'week' | 'month' };

export interface MetricCompare {
  vs: 'previous_period' | 'previous_year';
  show: 'change' | 'pct_change' | 'prior';
}

export interface MetricPeriodDefinition {
  /** The id of the metric it is built on. */
  base: string;
  window?: MetricWindow;
  compare?: MetricCompare;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TO_DATE: ReadonlySet<string> = new Set(['week', 'month', 'quarter', 'year']);
const LAST_UNITS: ReadonlySet<string> = new Set(['day', 'week', 'month']);
const VS: ReadonlySet<string> = new Set(['previous_period', 'previous_year']);
const SHOWS: ReadonlySet<string> = new Set(['change', 'pct_change', 'prior']);
const MAX_LAST = 366;

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function sanitizeWindow(raw: unknown): MetricWindow | undefined {
  const o = record(raw);
  if (!o) return undefined;
  if (typeof o.to_date === 'string' && TO_DATE.has(o.to_date)) return { to_date: o.to_date as 'week' | 'month' | 'quarter' | 'year' };
  if (Number.isInteger(o.last) && (o.last as number) >= 1 && (o.last as number) <= MAX_LAST && typeof o.unit === 'string' && LAST_UNITS.has(o.unit)) {
    return { last: o.last as number, unit: o.unit as 'day' | 'week' | 'month' };
  }
  return undefined;
}

function sanitizeCompare(raw: unknown): MetricCompare | undefined {
  const o = record(raw);
  if (!o || typeof o.vs !== 'string' || !VS.has(o.vs) || typeof o.show !== 'string' || !SHOWS.has(o.show)) return undefined;
  return { vs: o.vs as MetricCompare['vs'], show: o.show as MetricCompare['show'] };
}

/** The definition when `raw` names a base metric and has a well-formed window or compare (or both), else undefined. Idempotent. */
export function sanitizePeriodDefinition(raw: unknown): MetricPeriodDefinition | undefined {
  const o = record(raw);
  if (!o || typeof o.base !== 'string' || !UUID_RE.test(o.base)) return undefined;
  const window = sanitizeWindow(o.window);
  const compare = sanitizeCompare(o.compare);
  if (!window && !compare) return undefined;
  const out: MetricPeriodDefinition = { base: o.base };
  if (window) out.window = window;
  if (compare) out.compare = compare;
  return out;
}

const VS_WORDS: Record<MetricCompare['vs'], string> = { previous_period: 'the previous period', previous_year: 'last year' };

/** A period metric in words: "Revenue, year to date", "Revenue, last 7 days", "Revenue, % change on last year". `base`: its base's name. */
export function periodWords(def: MetricPeriodDefinition, base = 'its base metric'): string {
  const parts = [base];
  const w = def.window;
  if (w) parts.push('to_date' in w ? `${w.to_date} to date` : w.last === 1 ? `last ${w.unit}` : `last ${w.last} ${w.unit}s`);
  const c = def.compare;
  if (c) parts.push(c.show === 'prior' ? VS_WORDS[c.vs] : `${c.show === 'pct_change' ? '% change' : 'change'} on ${VS_WORDS[c.vs]}`);
  return parts.join(', ');
}
