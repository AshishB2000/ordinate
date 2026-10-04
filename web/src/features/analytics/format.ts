// How the workbenches WRITE a figure the server computed — the desktop's
// statsViews.ts (swFmt, swP, swStars, swCount), segments.ts (sgFmt, sgPct,
// sgVal) and kpiCompare.ts (kpiPct), ported as they were. Display only: a
// value is rounded for reading, never re-derived.

import { formatNumber } from '../../../../src/app/format.ts';

const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** A statistic for reading — the same magnitude rule as the server's sentences.fmtStat. */
export function fmtStat(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
  const a = Math.abs(v);
  if (a >= 1e15 || (a > 0 && a < 1e-4)) return v.toExponential(2);
  if (a >= 1000) return GROUPED.format(v);
  const digits = a >= 100 ? 1 : a >= 1 ? 2 : 3;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(v);
}

/** A p-value: three places, clamped at the ends. */
export function fmtP(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  if (p < 0.001) return '< 0.001';
  if (p > 0.999) return '> 0.999';
  return p.toFixed(3);
}

/** Significance stars: *** < 0.001, ** < 0.01, * < 0.05, · < 0.1. */
export function stars(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '';
  return p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : p < 0.1 ? '·' : '';
}

/** A count, grouped. */
export function fmtCount(n: number): string {
  return GROUPED.format(n);
}

/** A coefficient to `places` decimals, or — when there is none. */
export function fmtFixed(v: number | null | undefined, places: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(places) : '—';
}

/** A number with at most `digits` decimals (segments.ts sgFmt). */
export function fmtNum(n: number, digits = 0): string {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** A share (0–1) as a percent, "<0.1%" for a sliver (segments.ts sgPct). */
export function fmtShare(share: number): string {
  const p = share * 100;
  return (p > 0 && p < 0.1 ? '<0.1' : p.toLocaleString('en-US', { maximumFractionDigits: 1 })) + '%';
}

/** A mean in a profile: whole numbers when large, more digits when small (segmentsView.ts sgVal). */
export function fmtMean(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return fmtNum(v, a >= 100 ? 0 : a >= 1 ? 2 : 3);
}

/** A change in percent with its sign (kpiCompare.ts kpiPct). */
export function fmtPct(pct: number): string {
  const a = Math.abs(pct);
  return (pct > 0 ? '+' : pct < 0 ? '−' : '') + formatNumber(a, { maxDecimals: a < 10 ? 1 : 0 }) + '%';
}
