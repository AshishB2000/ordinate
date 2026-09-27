// SCENARIOS — the model. PURE, MAIN PROCESS, NO MODEL.
//
// A scenario is a what-if over the project's METRICS: "unit_price +5%", "units
// in West −3%", "discount = 0". The record stores ONLY definitions — which
// metrics, which drivers — and every figure is recomputed by the app
// (./scenarioResolve.ts). A driver is applied as a VIRTUAL transform over the
// AGGREGATED INPUTS of a metric, never over the stored data: a column's sum,
// numeric count, non-empty count, min and max are read per PARTITION (one
// partition per combination of the drivers' filters), each partition is moved
// by every driver whose filter it satisfies, in list order, and the aggregate
// is folded back out of the moved pieces.
//
// Why pieces and not rows: `sum(x·f) = f·sum(x)`, `min(x·f) = f·min(x)` for
// f ≥ 0, and "every targeted cell = v" is `v × count` — so five numbers per
// partition answer every aggregation exactly, and the table is never copied.
// `count` counts non-empty cells, which a value driver cannot change.
//
// This file owns what needs no I/O: the record whitelist, the driver algebra,
// the tornado's ordering and the labels.

import { sanitizeSteps } from '../data/transforms';
import type { FilterStep } from '../data/transforms';
import type { MetricAggregation } from './metricValue';
import type { ParamValues } from './params';

export type DriverKind = 'pct' | 'abs';
export interface ColumnTarget { column: string; filter?: FilterStep }
export interface MetricTarget { metricId: string }
export type DriverTarget = ColumnTarget | MetricTarget;

export interface Driver {
  /** The driver in words — refreshed by main on every save (driverLabel). */
  name: string;
  kind: DriverKind;
  target: DriverTarget;
  /** pct: percent change (≥ −100). abs: the value the target is SET to. */
  value: number;
  /** A dashboard NUMBER parameter whose current value replaces `value` there. */
  param?: string;
}

export interface Scenario {
  id: string;
  projectId: string;
  name: string;
  baseMetricIds: string[];
  drivers: Driver[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

/** The five numbers a column contributes, over the rows of one partition. */
export interface Pieces {
  sum: number;
  /** Finite numeric cells. */
  n: number;
  /** Non-empty cells of any type — what `count` counts. */
  nonEmpty: number;
  min: number | null;
  max: number | null;
}

/** One combination of the column drivers' filters: `key[j]` = row matches driver j. */
export interface Partition { key: boolean[]; pieces: Pieces }

/** A driver as the algebra needs it: where it sits in the list, and what it does. */
export interface Move { index: number; kind: DriverKind; value: number }

/** The tornado's extra push on ONE driver's target: ×0.9 or ×1.1. */
export interface Nudge { index: number; factor: number }

export const MAX_BASE_METRICS = 12;
export const MAX_DRIVERS = 16;
export const MAX_COMPARE = 4;
/** The tornado moves each driver's target by this share, both ways. */
export const TORNADO_STEP = 0.1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/; // params.PARAM_NAME_RE — kept local so this file loads bare
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A percent change below −100 would flip signs; −100 is "all of it gone". */
const PCT_MIN = -100;
const PCT_MAX = 10_000;

export function isMetricTarget(t: DriverTarget): t is MetricTarget {
  return typeof (t as MetricTarget).metricId === 'string';
}

// ── the whitelist ────────────────────────────────────────────────────────────

/** One driver, or null when it is unusable. Never throws, never guesses a value. */
export function sanitizeDriver(raw: unknown): Driver | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || (o.kind !== 'pct' && o.kind !== 'abs') || !finite(o.value)) return null;
  const t = o.target && typeof o.target === 'object' ? (o.target as Record<string, unknown>) : null;
  if (!t) return null;
  let target: DriverTarget;
  if (typeof t.metricId === 'string') {
    if (!UUID_RE.test(t.metricId)) return null;
    target = { metricId: t.metricId };
  } else {
    const column = typeof t.column === 'string' ? t.column.trim().slice(0, 200) : '';
    if (!column) return null;
    target = { column };
    // The filter is an ordinary FilterStep, whitelisted by the pipeline's own
    // sanitizer — the same one a dashboard filter goes through.
    const f = t.filter ? sanitizeSteps([t.filter])[0] : undefined;
    if (f && f.type === 'filter') target.filter = f;
  }
  const value = o.kind === 'pct' ? Math.min(PCT_MAX, Math.max(PCT_MIN, o.value)) : o.value;
  const d: Driver = { name: typeof o.name === 'string' ? o.name.trim().slice(0, 120) : '', kind: o.kind, target, value };
  if (typeof o.param === 'string' && PARAM_RE.test(o.param.trim())) d.param = o.param.trim();
  return d;
}

export function sanitizeDrivers(raw: unknown): Driver[] {
  const out: Driver[] = [];
  for (const r of Array.isArray(raw) ? raw.slice(0, MAX_DRIVERS) : []) {
    const d = sanitizeDriver(r);
    if (d) out.push(d);
  }
  return out;
}

/** Distinct metric ids, in order, capped. */
export function sanitizeBaseMetricIds(raw: unknown): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    if (typeof v === 'string' && UUID_RE.test(v) && out.indexOf(v) < 0) out.push(v);
    if (out.length >= MAX_BASE_METRICS) break;
  }
  return out;
}

// ── parameters ───────────────────────────────────────────────────────────────

/** Drivers with a bound NUMBER parameter take its current value. Others are untouched. */
export function effectiveDrivers(drivers: Driver[], params: ParamValues | undefined): Driver[] {
  if (!params || params.size === 0) return drivers;
  return drivers.map((d) => {
    const p = d.param ? params.get(d.param.toLowerCase()) : undefined;
    if (!p || p.kind !== 'number' || !finite(p.value)) return d;
    const value = d.kind === 'pct' ? Math.min(PCT_MAX, Math.max(PCT_MIN, p.value)) : p.value;
    return { ...d, value };
  });
}

// ── the algebra ──────────────────────────────────────────────────────────────

/** The drivers aimed at one column, in list order. */
export function columnMoves(drivers: Driver[], column: string): Array<Move & { filter: FilterStep | null }> {
  const out: Array<Move & { filter: FilterStep | null }> = [];
  drivers.forEach((d, index) => {
    if (!isMetricTarget(d.target) && d.target.column === column) {
      out.push({ index, kind: d.kind, value: d.value, filter: d.target.filter ?? null });
    }
  });
  return out;
}

/** The drivers aimed at one metric, in list order. */
export function metricMoves(drivers: Driver[], metricId: string): Move[] {
  const out: Move[] = [];
  drivers.forEach((d, index) => {
    if (isMetricTarget(d.target) && d.target.metricId === metricId) out.push({ index, kind: d.kind, value: d.value });
  });
  return out;
}

function factorOf(m: Move, nudge: Nudge | null): number {
  return nudge && nudge.index === m.index ? nudge.factor : 1;
}

/** One driver over one partition's pieces. pct scales every numeric cell; abs sets it. */
export function movePieces(p: Pieces, m: Move, factor = 1): Pieces {
  if (m.kind === 'pct') {
    const f = Math.max(0, 1 + m.value / 100) * factor;
    return { sum: p.sum * f, n: p.n, nonEmpty: p.nonEmpty, min: p.min === null ? null : p.min * f, max: p.max === null ? null : p.max * f };
  }
  const v = m.value * factor;
  // No numeric cell to set: nothing moves (an empty cell stays empty).
  if (p.n === 0) return p;
  return { sum: v * p.n, n: p.n, nonEmpty: p.nonEmpty, min: v, max: v };
}

/** Every partition moved by the drivers whose filter it satisfies, in list order. */
export function applyColumnMoves(parts: Partition[], moves: Move[], nudge: Nudge | null = null): Pieces[] {
  return parts.map((part) => {
    let p = part.pieces;
    moves.forEach((m, j) => { if (part.key[j]) p = movePieces(p, m, factorOf(m, nudge)); });
    return p;
  });
}

/**
 * Fold pieces back into one aggregate, with metricValue.computeMetric's
 * contract: count over no rows is 0, sum/avg/min/max over no numeric cell is
 * null — never 0, never NaN.
 */
export function foldPieces(list: Pieces[], aggregation: MetricAggregation): number | null {
  let sum = 0;
  let n = 0;
  let nonEmpty = 0;
  let min: number | null = null;
  let max: number | null = null;
  for (const p of list) {
    sum += p.sum;
    n += p.n;
    nonEmpty += p.nonEmpty;
    if (p.min !== null && (min === null || p.min < min)) min = p.min;
    if (p.max !== null && (max === null || p.max > max)) max = p.max;
  }
  if (aggregation === 'count') return nonEmpty;
  if (n === 0) return null;
  if (aggregation === 'sum') return sum;
  if (aggregation === 'avg') return sum / n;
  if (aggregation === 'min') return min;
  if (aggregation === 'max') return max;
  return null;
}

/** A metric-target driver: pct scales the resolved value, abs sets it. */
export function applyMetricMoves(value: number | null, moves: Move[], nudge: Nudge | null = null): number | null {
  let v = value;
  for (const m of moves) {
    const f = factorOf(m, nudge);
    if (m.kind === 'abs') v = m.value * f;
    else if (v !== null) v = v * Math.max(0, 1 + m.value / 100) * f;
  }
  return v;
}

// ── the tornado ──────────────────────────────────────────────────────────────

export interface TornadoBar {
  index: number;
  label: string;
  /** The metric with this driver's target moved −10% / +10%, the others as set. */
  low: number | null;
  high: number | null;
  /** |high − low| — the bar's length, and the sort key. */
  swing: number;
}

/** Bars centred on the scenario value, widest swing first; ties keep driver order. */
export function tornadoBars(rows: Array<{ index: number; label: string; low: number | null; high: number | null }>): TornadoBar[] {
  return rows
    .map((r) => ({ ...r, swing: finite(r.low) && finite(r.high) ? Math.abs(r.high - r.low) : 0 }))
    .sort((a, b) => b.swing - a.swing || a.index - b.index);
}

// ── labels ───────────────────────────────────────────────────────────────────

/** 5 → "5", 2.5 → "2.5", 1/3 → "0.33". No grouping: a label, not a figure. */
export function amount(v: number): string {
  return String(Number(v.toFixed(2)));
}

/** "+5%" / "−3%" — a real minus sign. */
export function signedPct(v: number): string {
  return (v < 0 ? '−' : '+') + amount(Math.abs(v)) + '%';
}

const OP_WORDS: Record<string, string> = { '!=': '≠', '>=': '≥', '<=': '≤', is_empty: 'is empty', not_empty: 'is not empty' };

function listWords(values: unknown): string {
  const vals = Array.isArray(values) ? values.map((v) => String(v)) : [];
  return vals.length > 3 ? `${vals.slice(0, 3).join(', ')} +${vals.length - 3} more` : vals.join(', ');
}

/** "in West", "in East, West", "where ship_days > 5". */
export function filterWords(f: FilterStep): string {
  if (f.op === '=') return `in ${f.value == null ? '' : String(f.value)}`;
  if (f.op === 'in') return `in ${listWords(f.values)}`;
  if (f.op === 'not in') return `outside ${listWords(f.values)}`;
  if (f.op === 'is_empty' || f.op === 'not_empty') return `where ${f.column} ${OP_WORDS[f.op]}`;
  if (f.op === 'period') return `where ${f.column} is in a period`;
  return `where ${f.column} ${OP_WORDS[f.op] || f.op} ${f.value == null ? '' : String(f.value)}`.trim();
}

/** "unit_price +5%", "units in West −3%", "discount = 0", "Revenue −10%". */
export function driverLabel(d: Pick<Driver, 'kind' | 'target' | 'value'>, metricName = 'metric'): string {
  const subject = isMetricTarget(d.target)
    ? metricName
    : d.target.column + (d.target.filter ? ' ' + filterWords(d.target.filter) : '');
  return d.kind === 'pct' ? `${subject} ${signedPct(d.value)}` : `${subject} = ${amount(d.value)}`;
}
