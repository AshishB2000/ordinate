// The figures a waterfall and a Pareto chart DRAW, computed in MAIN — PURE.
//
// A deliberate second copy of the desktop's chartShapes.ts's waterfallSteps and
// paretoShape arithmetic: a caption is written in main (captions.ts), and main
// cannot load a renderer script. scripts/test-captions.ts runs both copies over
// the same fixtures and holds them to Object.is — a caption naming a different
// start, end or 80% count from the picture above it would be the app
// contradicting itself.

import type { ChartData } from './vizData';

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Kept identical to chartShapes.ts: the label rule for a "total" category and
// the float tolerance at an exact 80%.
const TOTAL_RE = /^(sub[ -]?|grand )?total\b/i;
const REACH = 0.8 * (1 - 1e-12);

export interface FigureStep { label: string; value: number }

/**
 * A waterfall's start level, end level and steps. One series: each category is
 * a step from 0, and a total-labelled one resets the level to its own value
 * (the start, when it comes first). Two series: a BRIDGE from the sum of the
 * first to the sum of the second, one step per category, totals left out.
 */
export function waterfallFigures(
  data: ChartData | null | undefined, totals?: string[] | null,
): { from: number; to: number; steps: FigureStep[] } {
  const labels = (data && Array.isArray(data.labels)) ? data.labels : [];
  const series = (data && Array.isArray(data.series)) ? data.series : [];
  const named = new Set((Array.isArray(totals) ? totals : []).map(String));
  const isTotal = (l: unknown): boolean => named.has(String(l)) || TOTAL_RE.test(String(l));
  const s0: unknown[] = (series[0] && series[0].values) || [];
  const steps: FigureStep[] = [];
  let from = 0;
  let to = 0;
  if (series.length >= 2) {
    const s1: unknown[] = series[1].values || [];
    labels.forEach((l, i) => { if (!isTotal(l)) { from += finite(s0[i]) ?? 0; to += finite(s1[i]) ?? 0; } });
    labels.forEach((l, i) => {
      if (!isTotal(l)) steps.push({ label: String(l), value: (finite(s1[i]) ?? 0) - (finite(s0[i]) ?? 0) });
    });
    return { from, to, steps };
  }
  labels.forEach((l, i) => {
    const v = finite(s0[i]);
    if (isTotal(l)) { to = v ?? to; if (i === 0) from = to; return; }
    steps.push({ label: String(l), value: v ?? 0 });
    to += v ?? 0;
  });
  return { from, to, steps };
}

/**
 * How many of the largest categories it takes to reach 80% of the POSITIVE
 * total (0 when nothing is positive), how many positive categories there are,
 * and which one is largest.
 */
export function paretoFigures(data: ChartData | null | undefined): { count80: number; positives: number; top: string } {
  const labels = (data && Array.isArray(data.labels)) ? data.labels : [];
  const s0: unknown[] = (data && Array.isArray(data.series) && data.series[0] && data.series[0].values) || [];
  // Nulls as -Infinity sort last; a stable sort keeps ties in category order.
  const rows = labels.map((l, i) => ({ label: String(l), v: finite(s0[i]) ?? -Infinity }))
    .sort((a, b) => (a.v === b.v ? 0 : b.v - a.v));
  let total = 0;
  let positives = 0;
  for (const r of rows) if (r.v > 0) { total += r.v; positives += 1; }
  let cum = 0;
  let count80 = 0;
  rows.forEach((r, k) => {
    if (r.v > 0) cum += r.v;
    if (!count80 && total > 0 && cum >= total * REACH) count80 = k + 1;
  });
  return { count80, positives, top: rows.length ? rows[0].label : '' };
}
