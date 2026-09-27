// SCORECARDS — the model. PURE, MAIN PROCESS, NO MODEL.
//
// A scorecard is a list of METRICS, each with an optional target, owner, group
// and thresholds, read one period at a time: this month's revenue against its
// target, green / amber / red, with its change on last month and a twelve-period
// sparkline. The record stores ONLY definitions; every figure is recomputed by
// the app, per period, through the metrics layer (src/ipc/scorecards.ts), and
// the period picker's history is recomputed on demand, never stored.
//
// This file owns what needs no I/O: the whitelist a record goes through, the
// period windows (week / month / quarter / year, the workspace calendar's week
// start and fiscal year honoured), a row's status from its attainment and its
// metric's direction, and a group's roll-up.

import type { CalendarPrefs } from './dateIntel';
import { daysFromIso, isoFromDays } from './dateIntel';
import { civilFromDays, daysFromCivil } from './categoryKey';

export type ScorePeriod = 'week' | 'month' | 'quarter' | 'year';
export const SCORE_PERIODS: readonly ScorePeriod[] = ['week', 'month', 'quarter', 'year'];

/** Percent of target. `good`/`warn` are read against the metric's direction. */
export interface Thresholds { good: number; warn: number }

export interface ScorecardRow {
  metricId: string;
  /** A fixed figure, or another metric resolved over the same period. */
  target?: number | { metricId: string };
  owner?: string;
  group?: string;
  thresholds?: Thresholds;
}

export interface Scorecard {
  id: string;
  projectId: string;
  name: string;
  period: ScorePeriod;
  rows: ScorecardRow[];
  description?: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export type RowStatus = 'good' | 'warn' | 'off' | 'none';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 60;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

export function isScorePeriod(v: unknown): v is ScorePeriod {
  return typeof v === 'string' && (SCORE_PERIODS as readonly string[]).includes(v);
}

/** Thresholds are percentages of target, 0–1000. Anything else is dropped (defaults apply). */
export function sanitizeThresholds(raw: unknown): Thresholds | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || !finite(o.good) || !finite(o.warn)) return undefined;
  if (o.good < 0 || o.good > 1000 || o.warn < 0 || o.warn > 1000) return undefined;
  return { good: o.good, warn: o.warn };
}

/** One row, or null when it names no metric. Never throws. */
export function sanitizeRow(raw: unknown): ScorecardRow | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.metricId !== 'string' || !UUID_RE.test(o.metricId)) return null;
  const row: ScorecardRow = { metricId: o.metricId };
  if (finite(o.target)) row.target = o.target;
  else if (o.target && typeof o.target === 'object') {
    const t = (o.target as Record<string, unknown>).metricId;
    if (typeof t === 'string' && UUID_RE.test(t)) row.target = { metricId: t };
  }
  const owner = str(o.owner, 80);
  if (owner) row.owner = owner;
  const group = str(o.group, 80);
  if (group) row.group = group;
  const th = sanitizeThresholds(o.thresholds);
  if (th) row.thresholds = th;
  return row;
}

export function sanitizeRows(raw: unknown): ScorecardRow[] {
  return (Array.isArray(raw) ? raw : []).map(sanitizeRow).filter((r): r is ScorecardRow => !!r).slice(0, MAX_ROWS);
}

// ── period windows ───────────────────────────────────────────────────────────

export interface PeriodWindow {
  /** Inclusive ISO dates. */
  from: string;
  to: string;
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthIndexToCivil(idx: number): { y: number; m: number } {
  const y = Math.floor(idx / 12);
  return { y, m: idx - y * 12 + 1 };
}

function monthSpan(startIdx: number, months: number): { from: string; to: string } {
  const a = monthIndexToCivil(startIdx);
  const b = monthIndexToCivil(startIdx + months);
  return { from: isoFromDays(daysFromCivil(a.y, a.m, 1)), to: isoFromDays(daysFromCivil(b.y, b.m, 1) - 1) };
}

/**
 * The period `offset` steps BEFORE the one holding `anchorIso` (0 = that one).
 *
 * Weeks start on the workspace's week start; quarters and years follow its
 * fiscal year. A fiscal year is named for the calendar year it ENDS in
 * (FY2025 = Jul 2024 – Jun 2025), the usual convention; a calendar year is
 * just its number. Null when the anchor is not an ISO date.
 */
export function periodWindow(anchorIso: string, period: ScorePeriod, offset: number, cal: CalendarPrefs): PeriodWindow | null {
  const day = daysFromIso(anchorIso);
  if (day === null) return null;
  const k = Math.floor(offset) || 0; // negative = periods AFTER the anchor (a forecast axis)
  if (period === 'week') {
    const dow = ((day + 4) % 7 + 7) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
    const start = day - ((dow - cal.weekStart + 7) % 7) - 7 * k;
    const c = civilFromDays(start);
    return { from: isoFromDays(start), to: isoFromDays(start + 6), label: `Week of ${MONTHS[c.m - 1]} ${c.d}, ${c.y}` };
  }
  const c = civilFromDays(day);
  const idx = c.y * 12 + (c.m - 1);
  if (period === 'month') {
    const s = idx - k;
    const m = monthIndexToCivil(s);
    return { ...monthSpan(s, 1), label: `${MONTHS[m.m - 1]} ${m.y}` };
  }
  const fs = cal.fiscalYearStart;
  const intoYear = (c.m - fs + 12) % 12; // months since the fiscal year began
  const fiscal = fs !== 1;
  if (period === 'quarter') {
    const s = idx - (intoYear % 3) - 3 * k;
    const m = monthIndexToCivil(s);
    const q = Math.floor(((m.m - fs + 12) % 12) / 3) + 1;
    const fyEnd = monthIndexToCivil(s - ((m.m - fs + 12) % 12) + 11).y;
    return { ...monthSpan(s, 3), label: fiscal ? `Q${q} FY${fyEnd}` : `Q${q} ${m.y}` };
  }
  const s = idx - intoYear - 12 * k;
  const end = monthIndexToCivil(s + 11).y;
  return { ...monthSpan(s, 12), label: fiscal ? `FY${end}` : String(monthIndexToCivil(s).y) };
}

// ── status, change, roll-up ──────────────────────────────────────────────────

/** Default thresholds: at or over target is good, within 10% of it a warning. */
export function defaultThresholds(direction?: 'up_good' | 'down_good'): Thresholds {
  return direction === 'down_good' ? { good: 100, warn: 110 } : { good: 100, warn: 90 };
}

/**
 * A row's status from its attainment (value ÷ target × 100) and its metric's
 * direction. Up is good unless the metric says otherwise: for a `down_good`
 * metric (cost, churn) being UNDER target is on track, so the comparisons flip.
 * No target, or a zero one, is `none` — a grey dot, never a guess.
 */
export function rowStatus(
  value: number | null, target: number | null, thresholds: Thresholds | undefined, direction?: 'up_good' | 'down_good',
): { status: RowStatus; attainment: number | null } {
  if (!finite(value) || !finite(target) || target === 0) return { status: 'none', attainment: null };
  const attainment = (value / target) * 100;
  const th = thresholds || defaultThresholds(direction);
  const status: RowStatus = direction === 'down_good'
    ? (attainment <= th.good ? 'good' : attainment <= th.warn ? 'warn' : 'off')
    : (attainment >= th.good ? 'good' : attainment >= th.warn ? 'warn' : 'off');
  return { status, attainment };
}

/** The change on the previous period, and whether it is good news. */
export function periodChange(
  value: number | null, previous: number | null, direction?: 'up_good' | 'down_good',
): { delta: number | null; pct: number | null; tone: 'good' | 'bad' | 'flat' | 'neutral' } {
  if (!finite(value) || !finite(previous)) return { delta: null, pct: null, tone: 'flat' };
  const delta = value - previous;
  const pct = previous === 0 ? null : (delta / Math.abs(previous)) * 100;
  if (delta === 0) return { delta, pct, tone: 'flat' };
  if (!direction) return { delta, pct, tone: 'neutral' };
  const good = direction === 'down_good' ? delta < 0 : delta > 0;
  return { delta, pct, tone: good ? 'good' : 'bad' };
}

export interface GroupRollup { group: string; onTrack: number; scored: number; total: number }

/**
 * Rows by `group`, in first-seen order ("" for ungrouped), with how many are on
 * track (good) out of how many CAN be (have a target) and how many there are.
 */
export function rollupGroups(rows: Array<{ group?: string; status: RowStatus }>): GroupRollup[] {
  const by = new Map<string, GroupRollup>();
  for (const r of rows) {
    const g = r.group || '';
    const cur = by.get(g) || { group: g, onTrack: 0, scored: 0, total: 0 };
    cur.total += 1;
    if (r.status !== 'none') cur.scored += 1;
    if (r.status === 'good') cur.onTrack += 1;
    by.set(g, cur);
  }
  return [...by.values()];
}

export const STATUS_WORDS: Record<RowStatus, string> = { good: 'on track', warn: 'at risk', off: 'off track', none: 'no target' };
