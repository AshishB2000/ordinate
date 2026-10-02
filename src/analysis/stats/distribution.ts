// One column's distribution — MAIN PROCESS, PURE.
//
// HISTOGRAM: the app's own bucket geometry (analysis/categoryKey binPlan /
// binIndex / binLabel — the same edges a binned chart axis uses), with
// Sturges' count (⌈log₂ n⌉ + 1, clamped to 5–40). The normal overlay is the
// expected count per bucket, n·[Φ((hi−μ)/σ) − Φ((lo−μ)/σ)].
//
// SHAPE. `skewness` is the adjusted Fisher–Pearson G1 = g1·√(n(n−1))/(n−2) and
// `kurtosis` is the sample EXCESS kurtosis G2 = ((n+1)g2 + 6)(n−1)/((n−2)(n−3)),
// with g1 = m3/m2^1.5 and g2 = m4/m2² − 3 on population moments — the
// estimators Excel's SKEW/KURT and SPSS report.
//
// NORMALITY. Shapiro–Wilk for 3 ≤ n ≤ 5,000, by Royston (1995), Algorithm AS
// R94 — the algorithm behind R's shapiro.test. Above 5,000, where AS R94's
// approximations are not calibrated, D'Agostino–Pearson K² (D'Agostino 1971
// skewness transform, Anscombe & Glynn 1983 kurtosis transform), p from χ² on
// 2 df. Both run on the finite values in their stored order, sorted here.

import { binIndex, binLabel, binPlan } from '../categoryKey';
import { chi2Sf, normCdf, normQuantile, normSf } from './distributions';

export const SW_MAX = 5000;

export interface Moments {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  median: number;
  skewness: number | null;
  kurtosis: number | null;
  /** Population-moment g1 and b2 = m4/m2², what the K² transforms take. */
  g1: number;
  b2: number;
}

export function moments(v: readonly number[]): Moments | null {
  const n = v.length;
  if (n < 1) return null;
  let m = 0;
  for (const x of v) m += x;
  m /= n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of v) {
    const d = x - m;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  const ss = m2;
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const g1 = m2 > 0 ? m3 / m2 ** 1.5 : 0;
  const b2 = m2 > 0 ? m4 / (m2 * m2) : 0;
  const g2 = b2 - 3;
  const s = [...v].sort((a, b) => a - b);
  return {
    n, mean: m, sd: n > 1 ? Math.sqrt(ss / (n - 1)) : 0, min: lo, max: hi,
    median: n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2,
    skewness: n >= 3 && m2 > 0 ? (g1 * Math.sqrt(n * (n - 1))) / (n - 2) : null,
    kurtosis: n >= 4 && m2 > 0 ? (((n + 1) * g2 + 6) * (n - 1)) / ((n - 2) * (n - 3)) : null,
    g1, b2,
  };
}

export interface Histogram {
  labels: string[];
  edges: number[];
  counts: number[];
  /** Expected count per bucket under a normal with the sample mean and SD. */
  normal: number[];
}

export function histogram(v: readonly number[], mean: number, sd: number): Histogram {
  const n = v.length;
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const want = Math.max(5, Math.min(40, Math.ceil(Math.log2(Math.max(1, n))) + 1));
  const plan = binPlan(n ? lo : null, n ? hi : null, want);
  const counts = new Array<number>(plan.bins).fill(0);
  for (const x of v) counts[binIndex(x, plan.lo, plan.width, plan.bins)] += 1;
  const labels: string[] = [];
  const edges: number[] = [];
  const normal: number[] = [];
  for (let i = 0; i < plan.bins; i++) {
    labels.push(binLabel(i, plan.lo, plan.width, plan.bins, plan.hi));
    const a = plan.lo + i * plan.width;
    const b = i >= plan.bins - 1 ? plan.hi : plan.lo + (i + 1) * plan.width;
    edges.push(a);
    normal.push(sd > 0 ? n * (normCdf((b - mean) / sd) - normCdf((a - mean) / sd)) : 0);
  }
  edges.push(plan.bins > 0 ? plan.hi : plan.lo);
  return { labels, edges, counts, normal };
}

// ── Shapiro–Wilk, Royston (1995) AS R94 ──────────────────────────────────────

const C1 = [0, 0.221157, -0.147981, -2.07119, 4.434685, -2.706056];
const C2 = [0, 0.042981, -0.293762, -1.752461, 5.682633, -3.582633];
const C3 = [0.544, -0.39978, 0.025054, -6.714e-4];
const C4 = [1.3822, -0.77857, 0.062767, -0.0020322];
const C5 = [-1.5861, -0.31082, -0.083751, 0.0038915];
const C6 = [-0.4803, -0.082676, 0.0030302];
const G = [-2.273, 0.459];

/** AS 181.2's poly(): cc[0] + cc[1]x + … + cc[n−1]x^(n−1). */
function poly(cc: readonly number[], x: number): number {
  let p = x * cc[cc.length - 1];
  for (let j = cc.length - 2; j > 0; j--) p = (p + cc[j]) * x;
  return cc.length > 1 ? cc[0] + p : cc[0];
}

export interface NormalityTest {
  method: 'shapiro-wilk' | 'dagostino';
  statistic: number;
  p: number;
  /** D'Agostino only: the skewness and kurtosis z-scores whose squares sum to K². */
  zSkew?: number;
  zKurt?: number;
}

/** W and its p for 3 ≤ n ≤ 5000; null outside that range or for a constant sample. */
export function shapiroWilk(values: readonly number[]): NormalityTest | null {
  const x = [...values].sort((p, q) => p - q);
  const n = x.length;
  if (n < 3 || n > SW_MAX) return null;
  const range = x[n - 1] - x[0];
  if (!(range > 1e-19)) return null;
  const nn2 = Math.floor(n / 2);
  const a = new Array<number>(nn2 + 1).fill(0); // 1-based, as in the paper
  if (n === 3) {
    a[1] = Math.SQRT1_2;
  } else {
    const an25 = n + 0.25;
    let summ2 = 0;
    for (let i = 1; i <= nn2; i++) {
      a[i] = normQuantile((i - 0.375) / an25);
      summ2 += a[i] * a[i];
    }
    summ2 *= 2;
    const ssumm2 = Math.sqrt(summ2);
    const rsn = 1 / Math.sqrt(n);
    const a1 = poly(C1, rsn) - a[1] / ssumm2;
    let i1: number;
    let fac: number;
    if (n > 5) {
      i1 = 3;
      const a2 = -a[2] / ssumm2 + poly(C2, rsn);
      fac = Math.sqrt((summ2 - 2 * a[1] * a[1] - 2 * a[2] * a[2]) / (1 - 2 * a1 * a1 - 2 * a2 * a2));
      a[2] = a2;
    } else {
      i1 = 2;
      fac = Math.sqrt((summ2 - 2 * a[1] * a[1]) / (1 - 2 * a1 * a1));
    }
    a[1] = a1;
    for (let i = i1; i <= nn2; i++) a[i] /= -fac;
  }
  // W as the squared correlation between the ordered sample and the coefficients.
  let sa = -a[1];
  let sx = x[0] / range;
  for (let i = 1, j = n - 1; i < n; j--) {
    sx += x[i] / range;
    i++;
    if (i !== j) sa += Math.sign(i - j) * a[Math.min(i, j)];
  }
  sa /= n;
  sx /= n;
  let ssa = 0;
  let ssx = 0;
  let sax = 0;
  for (let i = 0, j = n - 1; i < n; i++, j--) {
    const asa = i !== j ? Math.sign(i - j) * a[1 + Math.min(i, j)] - sa : -sa;
    const xsx = x[i] / range - sx;
    ssa += asa * asa;
    ssx += xsx * xsx;
    sax += asa * xsx;
  }
  const ssassx = Math.sqrt(ssa * ssx);
  const w1 = ((ssassx - sax) * (ssassx + sax)) / (ssa * ssx); // 1 − W, without the rounding of 1 − W near 1
  const w = 1 - w1;
  if (n === 3) {
    const p = (6 / Math.PI) * (Math.asin(Math.sqrt(w)) - Math.PI / 3);
    return { method: 'shapiro-wilk', statistic: w, p: Math.max(0, Math.min(1, p)) };
  }
  let y = Math.log(w1);
  const lx = Math.log(n);
  let m: number;
  let s: number;
  if (n <= 11) {
    const gamma = poly(G, n);
    if (y >= gamma) return { method: 'shapiro-wilk', statistic: w, p: 1e-99 };
    y = -Math.log(gamma - y);
    m = poly(C3, n);
    s = Math.exp(poly(C4, n));
  } else {
    m = poly(C5, lx);
    s = Math.exp(poly(C6, lx));
  }
  return { method: 'shapiro-wilk', statistic: w, p: normSf((y - m) / s) };
}

// ── D'Agostino–Pearson K² ────────────────────────────────────────────────────

export function dagostino(values: readonly number[]): NormalityTest | null {
  const n = values.length;
  if (n < 20) return null;
  const mo = moments(values);
  if (!mo || !(mo.sd > 0)) return null;
  // Skewness (D'Agostino 1970).
  const y = mo.g1 * Math.sqrt(((n + 1) * (n + 3)) / (6 * (n - 2)));
  const beta2 = (3 * (n * n + 27 * n - 70) * (n + 1) * (n + 3)) / ((n - 2) * (n + 5) * (n + 7) * (n + 9));
  const w2 = -1 + Math.sqrt(2 * (beta2 - 1));
  const delta = 1 / Math.sqrt(0.5 * Math.log(w2));
  const alpha = Math.sqrt(2 / (w2 - 1));
  const zSkew = delta * Math.asinh(y / alpha);
  // Kurtosis (Anscombe & Glynn 1983).
  const e = (3 * (n - 1)) / (n + 1);
  const varb2 = (24 * n * (n - 2) * (n - 3)) / ((n + 1) * (n + 1) * (n + 3) * (n + 5));
  const xk = (mo.b2 - e) / Math.sqrt(varb2);
  const sqrtBeta1 = ((6 * (n * n - 5 * n + 2)) / ((n + 7) * (n + 9))) * Math.sqrt((6 * (n + 3) * (n + 5)) / (n * (n - 2) * (n - 3)));
  const A = 6 + (8 / sqrtBeta1) * (2 / sqrtBeta1 + Math.sqrt(1 + 4 / (sqrtBeta1 * sqrtBeta1)));
  const term1 = 1 - 2 / (9 * A);
  const denom = 1 + xk * Math.sqrt(2 / (A - 4));
  const term2 = denom === 0 ? NaN : Math.sign(denom) * Math.cbrt((1 - 2 / A) / Math.abs(denom));
  const zKurt = (term1 - term2) / Math.sqrt(2 / (9 * A));
  const k2 = zSkew * zSkew + zKurt * zKurt;
  if (!Number.isFinite(k2)) return null;
  return { method: 'dagostino', statistic: k2, p: chi2Sf(k2, 2), zSkew, zKurt };
}

/** The workbench's normality test: Shapiro–Wilk up to 5,000 values, D'Agostino above. */
export function normality(values: readonly number[]): NormalityTest | null {
  return values.length <= SW_MAX ? shapiroWilk(values) : dagostino(values);
}
