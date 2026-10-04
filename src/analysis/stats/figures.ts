// The handful of derived figures the workbench SHOWS that a result does not
// carry — MAIN PROCESS, PURE. The desktop renderer worked these out itself (a
// group total, a cross-tab row's shares, the fit line's two ends); the web app
// never computes a figure (plan §6.4), so the server hands them over beside the
// result. Every value is plain arithmetic over the result's own numbers, in the
// same order the desktop's statsViews*.ts / statsCharts.ts did it, so the two
// agree to the bit.

import type { PairScatter, StatsResult } from './run';

export interface StatsFigures {
  /** groups: every compared group's n, summed. */
  total?: number;
  /** groups, table mode: each row's count, summed, and each cell as a share of its row (0 when the row is empty). */
  rowTotals?: number[];
  rowShares?: number[][];
  /** regression: the zero line's x span (fitted min → max) and the QQ reference line's ends. */
  residualSpan?: [number, number];
  qqSpan?: [number, number];
}

function span(v: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
  return [lo, hi];
}

export function statsFigures(r: StatsResult): StatsFigures {
  if (!r.ok) return {};
  if (r.kind === 'groups') {
    const out: StatsFigures = { total: r.groups.reduce((s, g) => s + g.n, 0) };
    if (r.mode === 'table' && r.table) {
      out.rowTotals = r.table.counts.map((row) => row.reduce((s, x) => s + x, 0));
      out.rowShares = r.table.counts.map((row, i) => {
        const total = (out.rowTotals as number[])[i];
        return row.map((x) => (total ? x / total : 0));
      });
    }
    return out;
  }
  if (r.kind === 'regression') {
    const { theoretical, sample } = r.fit.qq;
    return {
      residualSpan: span(r.fit.residuals.fitted),
      qqSpan: theoretical.length
        ? [Math.min(theoretical[0], sample[0]), Math.max(theoretical[theoretical.length - 1], sample[sample.length - 1])]
        : [-3, 3],
    };
  }
  return {};
}

/** The least-squares line across the pair's observed x range, or null without a fit. */
export function pairLine(p: PairScatter): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!p.fit || !p.points.x.length) return null;
  const [lo, hi] = span(p.points.x);
  return { x0: lo, y0: p.fit.intercept + p.fit.slope * lo, x1: hi, y1: p.fit.intercept + p.fit.slope * hi };
}
