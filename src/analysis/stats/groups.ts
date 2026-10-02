// Comparing groups — MAIN PROCESS, PURE. Every test here takes vectors the
// app already loaded and returns its statistic, p, effect size and the pieces
// a sentence needs; ./sentences.ts writes the words.
//
//   two groups, numeric       Welch's t (Welch–Satterthwaite df, 95% CI of the
//                             mean difference, Cohen's d on the pooled SD and
//                             Hedges' g with the exact gamma correction) and
//                             Mann–Whitney U (tie-corrected normal approximation
//                             with continuity correction — R's
//                             wilcox.test(exact = FALSE, correct = TRUE) — and
//                             the rank-biserial correlation).
//   three or more, numeric    one-way ANOVA (η²) and Kruskal–Wallis (tie
//                             corrected, ε² = H / (n − 1)).
//   category × category       Pearson's chi-square test of independence without
//                             continuity correction (R's correct = FALSE),
//                             Cramér's V, and a warning when an expected count
//                             is below 5.
//   two proportions           the pooled two-proportion z-test (z² equals the
//                             uncorrected chi-square of the same 2×2 table), the
//                             Wald 95% CI of the difference and Cohen's h.

import { chi2Sf, fSf, normQuantile, normSf, tQuantile, tSf2 } from './distributions';
import { rank } from './correlation';
import { lgamma } from './special';

export interface Describe {
  n: number;
  mean: number;
  sd: number;
  median: number;
}

export function describe(v: readonly number[]): Describe {
  const n = v.length;
  let m = 0;
  for (const x of v) m += x;
  m /= n;
  let ss = 0;
  for (const x of v) ss += (x - m) ** 2;
  const s = [...v].sort((a, b) => a - b);
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { n, mean: m, sd: n > 1 ? Math.sqrt(ss / (n - 1)) : 0, median };
}

export interface WelchResult {
  t: number;
  df: number;
  p: number;
  diff: number;
  ciLow: number;
  ciHigh: number;
  cohenD: number;
  hedgesG: number;
}

export function welch(a: readonly number[], b: readonly number[]): WelchResult | null {
  if (a.length < 2 || b.length < 2) return null;
  const da = describe(a);
  const db = describe(b);
  const va = da.sd ** 2 / da.n;
  const vb = db.sd ** 2 / db.n;
  const se = Math.sqrt(va + vb);
  if (!(se > 0)) return null;
  const diff = da.mean - db.mean;
  const t = diff / se;
  const df = (va + vb) ** 2 / (va ** 2 / (da.n - 1) + vb ** 2 / (db.n - 1));
  const q = tQuantile(0.975, df);
  const dfp = da.n + db.n - 2;
  const pooled = Math.sqrt(((da.n - 1) * da.sd ** 2 + (db.n - 1) * db.sd ** 2) / dfp);
  const cohenD = pooled > 0 ? diff / pooled : 0;
  // Exact small-sample correction J = Γ(m/2) / (√(m/2) Γ((m−1)/2)), m = n1 + n2 − 2.
  const J = Math.exp(lgamma(dfp / 2) - lgamma((dfp - 1) / 2)) / Math.sqrt(dfp / 2);
  return { t, df, p: tSf2(t, df), diff, ciLow: diff - q * se, ciHigh: diff + q * se, cohenD, hedgesG: cohenD * J };
}

export interface MannWhitneyResult {
  /** U for the FIRST group (R's W). */
  u: number;
  z: number;
  p: number;
  /** Rank-biserial r = 2U/(n1·n2) − 1: positive when the first group tends larger. */
  rankBiserial: number;
}

export function mannWhitney(a: readonly number[], b: readonly number[]): MannWhitneyResult | null {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 < 1 || n2 < 1) return null;
  const { ranks, ties } = rank([...a, ...b]);
  let r1 = 0;
  for (let i = 0; i < n1; i++) r1 += ranks[i];
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const n = n1 + n2;
  let tieSum = 0;
  for (const t of ties) tieSum += t * t * t - t;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieSum / (n * (n - 1))));
  const d = u - (n1 * n2) / 2;
  const z = sigma > 0 ? (d - Math.sign(d) * 0.5) / sigma : 0;
  return { u, z, p: sigma > 0 ? Math.min(1, 2 * normSf(Math.abs(z))) : 1, rankBiserial: (2 * u) / (n1 * n2) - 1 };
}

export interface AnovaResult {
  f: number;
  df1: number;
  df2: number;
  p: number;
  etaSq: number;
  ssBetween: number;
  ssWithin: number;
}

export function anova(groups: ReadonlyArray<readonly number[]>): AnovaResult | null {
  const k = groups.length;
  const n = groups.reduce((s, g) => s + g.length, 0);
  if (k < 2 || n <= k) return null;
  let grand = 0;
  for (const g of groups) for (const x of g) grand += x;
  grand /= n;
  let ssb = 0;
  let ssw = 0;
  for (const g of groups) {
    if (!g.length) continue;
    let m = 0;
    for (const x of g) m += x;
    m /= g.length;
    ssb += g.length * (m - grand) ** 2;
    for (const x of g) ssw += (x - m) ** 2;
  }
  const df1 = k - 1;
  const df2 = n - k;
  if (!(ssw > 0)) return null;
  const f = (ssb / df1) / (ssw / df2);
  return { f, df1, df2, p: fSf(f, df1, df2), etaSq: ssb / (ssb + ssw), ssBetween: ssb, ssWithin: ssw };
}

export interface KruskalResult {
  h: number;
  df: number;
  p: number;
  epsilonSq: number;
}

export function kruskal(groups: ReadonlyArray<readonly number[]>): KruskalResult | null {
  const k = groups.length;
  const all: number[] = [];
  for (const g of groups) for (const x of g) all.push(x);
  const n = all.length;
  if (k < 2 || n < 3) return null;
  const { ranks, ties } = rank(all);
  let at = 0;
  let sum = 0;
  for (const g of groups) {
    let r = 0;
    for (let i = 0; i < g.length; i++) r += ranks[at + i];
    at += g.length;
    if (g.length) sum += (r * r) / g.length;
  }
  let tieSum = 0;
  for (const t of ties) tieSum += t * t * t - t;
  const corr = 1 - tieSum / (n * n * n - n);
  if (!(corr > 0)) return null;
  const h = ((12 / (n * (n + 1))) * sum - 3 * (n + 1)) / corr;
  return { h, df: k - 1, p: chi2Sf(h, k - 1), epsilonSq: h / (n - 1) };
}

export interface ChiSquareResult {
  chi2: number;
  df: number;
  p: number;
  cramerV: number;
  n: number;
  expected: number[][];
  /** The smallest expected count; below 5 the approximation is shaky. */
  minExpected: number;
  lowExpected: boolean;
}

/** Test of independence on a rows × columns table of counts. */
export function chiSquare(table: ReadonlyArray<readonly number[]>): ChiSquareResult | null {
  const r = table.length;
  const c = r ? table[0].length : 0;
  if (r < 2 || c < 2) return null;
  const rowSum = table.map((row) => row.reduce((s, x) => s + x, 0));
  const colSum = Array.from({ length: c }, (_, j) => table.reduce((s, row) => s + row[j], 0));
  const n = rowSum.reduce((s, x) => s + x, 0);
  if (!(n > 0) || rowSum.some((x) => x === 0) || colSum.some((x) => x === 0)) return null;
  let chi2 = 0;
  let minExpected = Infinity;
  const expected = table.map((row, i) => row.map((o, j) => {
    const e = (rowSum[i] * colSum[j]) / n;
    chi2 += ((o - e) * (o - e)) / e;
    if (e < minExpected) minExpected = e;
    return e;
  }));
  const df = (r - 1) * (c - 1);
  return {
    chi2, df, p: chi2Sf(chi2, df), cramerV: Math.sqrt(chi2 / (n * (Math.min(r, c) - 1))),
    n, expected, minExpected, lowExpected: minExpected < 5,
  };
}

export interface TwoPropResult {
  p1: number;
  p2: number;
  diff: number;
  z: number;
  p: number;
  ciLow: number;
  ciHigh: number;
  cohenH: number;
}

export function twoProportions(x1: number, n1: number, x2: number, n2: number): TwoPropResult | null {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pool = (x1 + x2) / (n1 + n2);
  const se0 = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  if (!(se0 > 0)) return null;
  const diff = p1 - p2;
  const z = diff / se0;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  const q = normQuantile(0.975);
  return {
    p1, p2, diff, z, p: Math.min(1, 2 * normSf(Math.abs(z))),
    ciLow: diff - q * se, ciHigh: diff + q * se,
    cohenH: 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2)),
  };
}
