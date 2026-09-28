// Special functions for the statistics workbench — MAIN PROCESS, PURE.
//
// Hand-written from the standard series, no dependency: log-gamma (Lanczos,
// g = 7, nine terms), the regularized incomplete gamma (series below a + 1,
// Lentz continued fraction above) and the regularized incomplete beta (Lentz
// continued fraction, with the symmetry swap), and erf / erfc on top of the
// incomplete gamma. Every distribution function in ./distributions.ts is one
// of these with its arguments rearranged.
//
// ACCURACY. Lanczos g=7/n=9 is good to ~1e-15 relative; both continued
// fractions iterate to a 1e-15 relative step. The upper tails are computed
// DIRECTLY (gammaQ from the fraction, betaIc from the swapped fraction) rather
// than as 1 - lower, so a p-value of 1e-20 keeps its digits instead of
// cancelling to zero. scripts/test-statsMath.ts pins all of it against
// closed forms and published tables.

const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];
const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
const EPS = 1e-15;
const FPMIN = 1e-300;
const MAX_IT = 20_000;

/** ln Γ(x) for x > 0 (and the reflection for x < 0.5). */
export function lgamma(x: number): number {
  if (!Number.isFinite(x)) return x === Infinity ? Infinity : NaN;
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i);
  const t = z + LANCZOS_G + 0.5;
  return LOG_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** e^(−x) x^a / Γ(a), in logs — the common factor of both incomplete-gamma forms. */
function gammaPrefix(a: number, x: number): number {
  return Math.exp(-x + a * Math.log(x) - lgamma(a));
}

function gammaSeries(a: number, x: number): number {
  let ap = a;
  let del = 1 / a;
  let sum = del;
  for (let i = 0; i < MAX_IT; i++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * gammaPrefix(a, x);
}

function gammaFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_IT; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return gammaPrefix(a, x) * h;
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (!(a > 0) || Number.isNaN(x)) return NaN;
  if (x <= 0) return 0;
  if (x === Infinity) return 1;
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaFraction(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 − P(a, x), computed directly. */
export function gammaQ(a: number, x: number): number {
  if (!(a > 0) || Number.isNaN(x)) return NaN;
  if (x <= 0) return 1;
  if (x === Infinity) return 0;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaFraction(a, x);
}

function betaFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < MAX_IT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** x^a (1−x)^b / B(a, b), in logs. */
function betaPrefix(a: number, b: number, x: number): number {
  return Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log1p(-x));
}

/** Regularized incomplete beta I_x(a, b). */
export function betaI(a: number, b: number, x: number): number {
  if (!(a > 0) || !(b > 0) || Number.isNaN(x)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = betaPrefix(a, b, x);
  if (x < (a + 1) / (a + b + 2)) return (bt * betaFraction(a, b, x)) / a;
  return 1 - (bt * betaFraction(b, a, 1 - x)) / b;
}

/** 1 − I_x(a, b) = I_{1−x}(b, a), computed on whichever side keeps its digits. */
export function betaIc(a: number, b: number, x: number): number {
  if (!(a > 0) || !(b > 0) || Number.isNaN(x)) return NaN;
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  const bt = betaPrefix(a, b, x);
  if (x < (a + 1) / (a + b + 2)) return 1 - (bt * betaFraction(a, b, x)) / a;
  return (bt * betaFraction(b, a, 1 - x)) / b;
}

/** erf(x) = sign(x) · P(½, x²). */
export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === 0) return 0;
  const v = gammaP(0.5, x * x);
  return x < 0 ? -v : v;
}

/** erfc(x) = 1 − erf(x); for x ≥ 0 it is Q(½, x²) directly, so the tail keeps its digits. */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x >= 0) return gammaQ(0.5, x * x);
  return 1 + gammaP(0.5, x * x);
}
