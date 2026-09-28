// Distribution functions — MAIN PROCESS, PURE. Normal, Student t, F and
// chi-square, each written as the special function it is (./special.ts).
//
// Every p-value in the workbench comes from an UPPER-TAIL function here
// (`normSf`, `tSf2`, `fSf`, `chi2Sf`), computed directly rather than as
// 1 − cdf, so a p of 1e-30 is 1e-30 and not a cancelled zero.
//
// The normal quantile is Acklam's rational approximation (relative error
// 1.15e-9) polished by one Halley step against the exact erfc, which brings it
// to full double precision. The t quantile is solved from the exact t cdf by
// safeguarded Newton; 1 and 2 degrees of freedom use their closed forms.

import { betaI, betaIc, erfc, gammaP, gammaQ, lgamma } from './special';

const SQRT2 = Math.SQRT2;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

// ── Normal ───────────────────────────────────────────────────────────────────

export function normPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

/** P(Z ≤ z). */
export function normCdf(z: number): number {
  return 0.5 * erfc(-z / SQRT2);
}

/** P(Z > z), computed directly. */
export function normSf(z: number): number {
  return 0.5 * erfc(z / SQRT2);
}

const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

/** Φ⁻¹(p). */
export function normQuantile(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  let x: number;
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p <= 1 - P_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log1p(-p));
    x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  // One Halley step against the exact cdf. In the upper half the error is
  // measured on the upper tail, so p = 1 − 1e-12 is not rounded away.
  const e = p > 0.5 ? -(normSf(x) - (1 - p)) : normCdf(x) - p;
  const u = e * SQRT_2PI * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// ── Student t ────────────────────────────────────────────────────────────────

export function tPdf(t: number, df: number): number {
  return Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log1p((t * t) / df));
}

/** Two-sided P(|T| ≥ |t|). */
export function tSf2(t: number, df: number): number {
  if (Number.isNaN(t) || !(df > 0)) return NaN;
  if (!Number.isFinite(t)) return 0;
  return betaI(df / 2, 0.5, df / (df + t * t));
}

/** P(T ≤ t). */
export function tCdf(t: number, df: number): number {
  if (Number.isNaN(t) || !(df > 0)) return NaN;
  if (t === Infinity) return 1;
  if (t === -Infinity) return 0;
  const tail = 0.5 * tSf2(t, df);
  return t > 0 ? 1 - tail : tail;
}

/** The t quantile: the t with P(T ≤ t) = p. */
export function tQuantile(p: number, df: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1 || !(df > 0)) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  if (p === 0.5) return 0;
  if (df === 1) return Math.tan(Math.PI * (p - 0.5));
  if (df === 2) return (2 * p - 1) / Math.sqrt(2 * p * (1 - p));
  // Solve the upper tail q = P(T > t) for t > 0, then flip for p < ½.
  const q = p > 0.5 ? 1 - p : p;
  const sf = (t: number): number => 0.5 * tSf2(t, df);
  let lo = 0;
  let hi = Math.max(1, -normQuantile(q)) * 2;
  while (sf(hi) > q && hi < 1e300) { lo = hi; hi *= 4; }
  let t = Math.min(hi, Math.max(lo, -normQuantile(q)));
  for (let i = 0; i < 200; i++) {
    const f = sf(t) - q;
    if (f > 0) lo = t; else hi = t; // sf decreases in t
    let next = t + f / tPdf(t, df);  // Newton on sf(t) − q, whose derivative is −pdf
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - t) <= 1e-15 * Math.max(1, Math.abs(t))) { t = next; break; }
    t = next;
  }
  return p > 0.5 ? t : -t;
}

// ── F ────────────────────────────────────────────────────────────────────────

/** P(F ≤ f) with (d1, d2) degrees of freedom. */
export function fCdf(f: number, d1: number, d2: number): number {
  if (Number.isNaN(f) || !(d1 > 0) || !(d2 > 0)) return NaN;
  if (f <= 0) return 0;
  if (f === Infinity) return 1;
  return betaI(d1 / 2, d2 / 2, (d1 * f) / (d1 * f + d2));
}

/** P(F > f), computed directly. */
export function fSf(f: number, d1: number, d2: number): number {
  if (Number.isNaN(f) || !(d1 > 0) || !(d2 > 0)) return NaN;
  if (f <= 0) return 1;
  if (f === Infinity) return 0;
  return betaIc(d1 / 2, d2 / 2, (d1 * f) / (d1 * f + d2));
}

// ── Chi-square ───────────────────────────────────────────────────────────────

export function chi2Cdf(x: number, k: number): number {
  if (Number.isNaN(x) || !(k > 0)) return NaN;
  return gammaP(k / 2, Math.max(0, x) / 2);
}

/** P(X > x), computed directly. */
export function chi2Sf(x: number, k: number): number {
  if (Number.isNaN(x) || !(k > 0)) return NaN;
  return gammaQ(k / 2, Math.max(0, x) / 2);
}
