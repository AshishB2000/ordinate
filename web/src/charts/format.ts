// How a chart prints a figure — the app's ONE formatter (src/app/format.ts,
// which has no runtime imports, so the browser imports the server's file and
// both halves format alike) under the names the chart code has always called:
// hub.ts's `_fmtVal` / `fmtWith` / `histogramBins`, and calcMenu.ts's table
// calculation display (`tcAxisFmt`, `tcTooltip`). Nothing here computes a
// figure the server did not: a histogram bins the values it was sent, and a
// calculated series is only labelled.

import * as OrdFormat from '../../../src/app/format.ts';
import { t } from './strings';
import type { ChartSeriesShape, Cx } from './types';

/** The chart default: 5.2M / 686.2K / 842.5 (hub.ts `_fmtVal`). */
export function fmtVal(v: Cx): string {
  if (v == null) return '';
  return OrdFormat.formatCompact(v);
}

/** The Customize "Number format" override: auto / plain / thousands / compact / percent / currency. */
export function fmtWith(v: Cx, mode: string): string {
  return OrdFormat.formatValue(v, mode);
}

// Bin numeric values into ~sqrt(n) equal-width buckets for a histogram.
// Returns { labels: ["lo–hi", …], counts: [n, …] }. Empty/degenerate inputs are safe.
export function histogramBins(values: number[]): { labels: string[]; counts: number[] } {
  if (!values.length) return { labels: [], counts: [] };
  const min = Math.min(...values), max = Math.max(...values);
  if (min === max) return { labels: [fmtVal(min)], counts: [values.length] };
  const k = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(values.length))));
  const width = (max - min) / k;
  const counts: number[] = new Array(k).fill(0);
  values.forEach((v) => {
    let idx = Math.floor((v - min) / width);
    if (idx >= k) idx = k - 1;        // max value lands in the last bin
    if (idx < 0) idx = 0;
    counts[idx]!++;
  });
  const labels = counts.map((_, i) => `${fmtVal(min + i * width)}–${fmtVal(min + (i + 1) * width)}`);
  return { labels, counts };
}

// ── Table calculations: display only (calcMenu.ts) ─────────────────────────

const TC_PERCENT = new Set(['pct_of_total', 'pct_diff', 'percentile', 'yoy']);
const TC_SUFFIX: Record<string, string> = {
  running_total: t('calcMenu.running_total_2'), pct_of_total: t('calcMenu.of_total'), diff: t('calcMenu.vs_previous'),
  pct_diff: t('calcMenu.vs_previous'), rank_dense: '', rank_competition: '', percentile: ' percentile',
  moving_avg: t('calcMenu.moving_avg_2'), moving_sum: t('calcMenu.moving_sum_2'), yoy: ' YoY', index: ' index',
};

const tcNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tcSigned = (v: number, text: string): string => (v > 0 ? '+' + text : text);

export function tcCalcValueText(kind: string, value: unknown): string {
  const v = tcNum(value);
  if (v === null) return '—';
  if (kind === 'pct_diff' || kind === 'yoy') return tcSigned(v, OrdFormat.formatPercent(v, 1));
  if (kind === 'pct_of_total' || kind === 'percentile') return OrdFormat.formatPercent(v, 1);
  if (kind === 'rank_dense' || kind === 'rank_competition') return '#' + OrdFormat.formatNumber(v, { maxDecimals: 0 });
  if (kind === 'index') return OrdFormat.formatNumber(v, { decimals: 1 });
  if (kind === 'diff') return tcSigned(v, OrdFormat.formatCompact(v));
  return OrdFormat.formatCompact(v);
}

export function tcCalcLabel(kind: string, value: unknown, raw?: unknown): string {
  const r = tcNum(raw);
  const rawText = r === null ? '' : OrdFormat.formatCompact(r);
  return tcCalcValueText(kind, value) + (TC_SUFFIX[kind] ?? '') + (rawText ? ' · ' + rawText : '');
}

/**
 * Tooltips name both figures for a calculated series. A chart with no calc
 * keeps Chart.js's own label, untouched.
 */
export function tcTooltip(series: ChartSeriesShape[], tooltipConfig: Cx, fmt: (v: Cx) => string): void {
  const lead = (series || []).find((s) => s && s.calc);
  if (!lead || !lead.calc) return;
  const leadKind = lead.calc.kind;
  tooltipConfig.callbacks.label = (item: Cx) => {
    const s = series[item.datasetIndex] || series[0];
    const i = item.dataIndex;
    const v = s && Array.isArray(s.values) ? s.values[i] : null;
    const name = item.dataset && item.dataset.label ? item.dataset.label + ': ' : '';
    if (s && s.calc) return name + tcCalcLabel(s.calc.kind, v, Array.isArray(s.raw) ? s.raw[i] : null);
    // A prior-period overlay of a calculated series carries calculated values too.
    if (s && s.role === 'overlay') return name + tcCalcValueText(leadKind, v);
    return name + fmt(v);
  };
}

/**
 * The axis / value-label formatter for a calculated chart: percent kinds as a
 * percent, a rank as "#3", an index to one decimal. Mixed kinds, or no calc,
 * keep `base` — which is then the very function passed in.
 */
export function tcAxisFmt(series: ChartSeriesShape[], base: (v: Cx) => string): (v: Cx) => string {
  const plotted = (series || []).filter((s) => s && s.role !== 'overlay');
  if (!plotted.length || !plotted.every((s) => s.calc)) return base;
  const kinds = plotted.map((s) => s.calc!.kind);
  if (kinds.every((k) => TC_PERCENT.has(k))) return (v: Cx) => (tcNum(v) === null ? '' : OrdFormat.formatPercent(v, 1, { maxOnly: true }));
  if (kinds.every((k) => k === 'rank_dense' || k === 'rank_competition')) return (v: Cx) => (Number.isInteger(v) ? '#' + v : '');
  if (kinds.every((k) => k === 'index')) return (v: Cx) => (tcNum(v) === null ? '' : OrdFormat.formatNumber(v, { maxDecimals: 1 }));
  return base;
}
