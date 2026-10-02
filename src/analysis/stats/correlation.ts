// Correlation — MAIN PROCESS, PURE. Pearson and Spearman over pairwise-complete
// observations, and the matrix the workbench draws as a heatmap.
//
// PAIRWISE-COMPLETE: a row counts for a pair when BOTH of its cells are
// present, so each cell of the matrix carries its own n. Spearman is Pearson on
// the ranks of those pairs, ties sharing their average rank. Both p-values use
// t = r·√((n−2)/(1−r²)) on n − 2 degrees of freedom — exact for Pearson under
// normality, and the usual large-sample approximation for Spearman (R's
// cor.test uses an exact permutation p for small tie-free samples; this app
// always uses the t form, and says so in the result).

import { tSf2 } from './distributions';

export type CorrMethod = 'pearson' | 'spearman';

export interface CorrCell {
  /** Coefficient, or null when n < 3 or a column is constant on the pairs. */
  r: number | null;
  n: number;
  p: number | null;
}

/**
 * Ranks, 1-based, ties sharing their average rank (R's `rank(ties="average")`).
 * `ties` lists the size of every tie group larger than one — what the tie
 * corrections in ./groups.ts need.
 */
export function rank(values: readonly number[]): { ranks: number[]; ties: number[] } {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => values[a] - values[b] || a - b);
  const ranks = new Array<number>(n);
  const ties: number[] = [];
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && values[order[j]] === values[order[i]]) j++;
    const avg = (i + 1 + j) / 2; // mean of ranks i+1 .. j
    for (let k = i; k < j; k++) ranks[order[k]] = avg;
    if (j - i > 1) ties.push(j - i);
    i = j;
  }
  return { ranks, ties };
}

/** The pairs where both sides are present, in row order. */
export function completePairs(x: readonly (number | null)[], y: readonly (number | null)[]): { x: number[]; y: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const a = x[i];
    const b = y[i];
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    xs.push(a);
    ys.push(b);
  }
  return { x: xs, y: ys };
}

function pearsonOn(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(-1, Math.min(1, r));
}

/** Two-sided p for a correlation of r over n pairs (t on n − 2 df). */
export function corrP(r: number, n: number): number {
  if (Math.abs(r) >= 1) return 0;
  const df = n - 2;
  return tSf2(r * Math.sqrt(df / (1 - r * r)), df);
}

export function correlate(x: readonly (number | null)[], y: readonly (number | null)[], method: CorrMethod): CorrCell {
  const pr = completePairs(x, y);
  const n = pr.x.length;
  const r = method === 'spearman' ? pearsonOn(rank(pr.x).ranks, rank(pr.y).ranks) : pearsonOn(pr.x, pr.y);
  return { r, n, p: r === null ? null : corrP(r, n) };
}

/** Least-squares line y = a + b·x through the complete pairs, for the scatter's fit. */
export function fitLine(x: readonly (number | null)[], y: readonly (number | null)[]): { intercept: number; slope: number } | null {
  const pr = completePairs(x, y);
  const n = pr.x.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += pr.x[i]; my += pr.y[i]; }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (pr.x[i] - mx) ** 2;
    sxy += (pr.x[i] - mx) * (pr.y[i] - my);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { intercept: my - slope * mx, slope };
}

export interface CorrMatrix {
  method: CorrMethod;
  columns: string[];
  /** cells[i][j], symmetric, the diagonal r = 1 over that column's own n. */
  cells: CorrCell[][];
}

export function corrMatrix(columns: string[], vectors: Array<readonly (number | null)[]>, method: CorrMethod): CorrMatrix {
  const k = columns.length;
  const cells: CorrCell[][] = Array.from({ length: k }, () => new Array<CorrCell>(k));
  for (let i = 0; i < k; i++) {
    const own = vectors[i].filter((v) => v !== null && Number.isFinite(v)).length;
    cells[i][i] = { r: own >= 3 ? 1 : null, n: own, p: null };
    for (let j = i + 1; j < k; j++) {
      const c = correlate(vectors[i], vectors[j], method);
      cells[i][j] = c;
      cells[j][i] = c;
    }
  }
  return { method, columns: columns.slice(), cells };
}

/** The word for |r| the sentences use: ≥ 0.7 strong, ≥ 0.5 moderate, ≥ 0.3 weak, ≥ 0.1 very weak. */
export function corrStrength(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.7) return 'strong';
  if (a >= 0.5) return 'moderate';
  if (a >= 0.3) return 'weak';
  if (a >= 0.1) return 'very weak';
  return 'negligible';
}
