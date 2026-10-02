// Self-check for the workbench's special functions and distributions
// (src/analysis/stats/special.ts, distributions.ts) — pure, no Electron.
//
// Three kinds of reference, and nothing invented:
//   1. PUBLISHED values — the normal quantiles every table prints, R's qt()
//      to its printed six decimals, and the 5% critical values of t, F and χ²
//      from the standard tables (checked as "the upper tail at the tabled value
//      is 0.05", which the table's rounding bounds to well under 1e-6).
//   2. Python's standard library (math.lgamma / erf / erfc,
//      statistics.NormalDist.inv_cdf — Wichura's AS241), an independent
//      implementation, embedded below as literals.
//   3. CLOSED FORMS — t with 1 df is Cauchy, t with 2 df has an algebraic cdf,
//      χ² with 2 df is exponential, χ² with 1 df is erfc, F(1, d) is t².
//
//   npm run build:ts && node scripts/test-statsMath.js

export {};
import { ok, finish } from './selfcheck';

const sp: typeof import('../src/analysis/stats/special') = require('../src/analysis/stats/special');
const d: typeof import('../src/analysis/stats/distributions') = require('../src/analysis/stats/distributions');

const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const near = (label: string, got: number, want: number, tol: number, relative = true): void => {
  const err = relative && want !== 0 ? rel(got, want) : Math.abs(got - want);
  ok(`${label}: ${got} ≈ ${want}`, err <= tol, `err=${err}`);
};

// ── 1. log-gamma, erf, erfc against Python's stdlib ──────────────────────────
for (const [x, want] of [[0.1, 2.2527126517342055], [0.5, 0.5723649429247004], [1.5, -0.12078223763524543], [2.5, 0.2846828704729196],
  [10, 12.801827480081467], [100.5, 361.4355404677776], [1e5, 1051287.7089736569]] as const) {
  near(`lgamma(${x})`, sp.lgamma(x), want, 1e-12);
}
near('lgamma(1) = 0', sp.lgamma(1), 0, 1e-14, false);
near('lgamma(0.5) = ln √π', sp.lgamma(0.5), 0.5 * Math.log(Math.PI), 1e-14);
near('lgamma(6) = ln 120', sp.lgamma(6), Math.log(120), 1e-14);
for (const [x, want] of [[-3, 1.9999779095030015], [-0.5, 1.5204998778130465], [0.1, 0.8875370839817152], [0.5, 0.4795001221869535],
  [1, 0.15729920705028516], [2, 0.0046777349810472645], [5, 1.537459794428035e-12], [10, 2.0884875837625446e-45]] as const) {
  near(`erfc(${x})`, sp.erfc(x), want, 1e-12);
}
for (const [x, want] of [[-2, -0.9953222650189527], [-0.3, -0.32862675945912734], [0.001, 0.0011283787909692365], [1.5, 0.9661051464753108]] as const) {
  near(`erf(${x})`, sp.erf(x), want, 1e-12);
}
ok('erf(0) = 0 and erfc(0) = 1', sp.erf(0) === 0 && sp.erfc(0) === 1);
ok('erf is odd', sp.erf(-0.7) === -sp.erf(0.7));
near('incomplete gamma: P(1, x) = 1 − e^−x', sp.gammaP(1, 2.5), 1 - Math.exp(-2.5), 1e-14);
near('incomplete gamma: Q(1, x) = e^−x far out', sp.gammaQ(1, 40), Math.exp(-40), 1e-12);
near('incomplete beta: I_x(1, 1) = x', sp.betaI(1, 1, 0.3), 0.3, 1e-14);
near('incomplete beta: I_x(a, 1) = x^a', sp.betaI(3.5, 1, 0.42), 0.42 ** 3.5, 1e-13);
near('incomplete beta: symmetry I_x(a, b) = 1 − I_{1−x}(b, a)', sp.betaI(2.5, 7, 0.2), 1 - sp.betaI(7, 2.5, 0.8), 1e-13);
near('incomplete beta: betaIc is the complement', sp.betaIc(4, 9, 0.35), 1 - sp.betaI(4, 9, 0.35), 1e-13);

// ── 2. Normal ────────────────────────────────────────────────────────────────
// The published two-sided critical values (every statistics table), and
// statistics.NormalDist().inv_cdf for the rest.
for (const [p, want] of [[0.975, 1.959963984540054], [0.95, 1.6448536269514722], [0.99, 2.3263478740408408], [0.995, 2.5758293035489004],
  [0.9, 1.2815515655446006], [0.999, 3.090232306167813], [0.7, 0.5244005127080407], [0.02, -2.0537489106318225], [0.03, -1.8807936081512509],
  [1e-10, -6.361340902404057]] as const) {
  near(`normQuantile(${p})`, d.normQuantile(p), want, 1e-12);
}
ok('normQuantile(0.5) = 0', d.normQuantile(0.5) === 0);
ok('normQuantile at the ends is ±∞', d.normQuantile(0) === -Infinity && d.normQuantile(1) === Infinity);
for (const p of [1e-300, 1e-20, 0.001, 0.1234, 0.5, 0.8765, 0.999999]) near(`Φ(Φ⁻¹(${p})) = ${p}`, d.normCdf(d.normQuantile(p)), p, 1e-12);
near('normSf(−z) = normCdf(z)', d.normSf(-1.3), d.normCdf(1.3), 1e-15);
near('normSf keeps a far tail: P(Z > 10)', d.normSf(10), 7.619853024160593e-24, 1e-12);

// ── 3. Student t ─────────────────────────────────────────────────────────────
// R's qt() as printed (6 decimals): the tolerance is the printing, 5e-7.
for (const [p, df, want] of [[0.975, 5, 2.570582], [0.975, 10, 2.228139], [0.975, 20, 2.085963], [0.975, 30, 2.042272], [0.95, 10, 1.812461]] as const) {
  near(`qt(${p}, ${df}) = ${want} (R, 6 dp)`, d.tQuantile(p, df), want, 5e-7 + 1e-12, false);
}
// Closed forms.
for (const t of [-7, -0.4, 0, 1.3, 25]) {
  near(`t(1 df) is Cauchy: cdf(${t})`, d.tCdf(t, 1), 0.5 + Math.atan(t) / Math.PI, 1e-13);
  near(`t(2 df) cdf(${t}) = ½ + t/(2√(t²+2))`, d.tCdf(t, 2), 0.5 + t / (2 * Math.sqrt(t * t + 2)), 1e-13);
}
near('qt(0.975, 1) = tan(0.475π) (Cauchy)', d.tQuantile(0.975, 1), Math.tan(0.475 * Math.PI), 1e-14);
for (const [p, df] of [[0.975, 3], [0.9, 12.5], [0.005, 40], [0.999999, 3], [0.975, 1e6]] as const) {
  near(`tCdf(tQuantile(${p}, ${df})) = ${p}`, d.tCdf(d.tQuantile(p, df), df), p, 1e-11);
}
near('t with 10⁶ df is the normal', d.tQuantile(0.975, 1e6), d.normQuantile(0.975), 1e-5);
// The 5% two-sided critical values of the t table: the tail there is 0.05.
for (const [t, df] of [[12.706, 1], [2.228139, 10], [2.042272, 30]] as const) {
  near(`two-sided p at the tabled t(${df}) = ${t} is 0.05`, d.tSf2(t, df), 0.05, df === 1 ? 5e-6 : 1e-6, false);
}
near('tSf2 matches numerical integration: t = 4, 7 df', d.tSf2(4, 7), 0.005189913349296791, 1e-12);
near('tSf2 matches numerical integration: t = 0.3, 120 df', d.tSf2(0.3, 120), 0.7646962111751858, 1e-12);

// ── 4. F ─────────────────────────────────────────────────────────────────────
for (const [f, d1, d2] of [[4.964603, 1, 10], [3.325835, 5, 10], [2.978237, 10, 10]] as const) {
  near(`upper tail at the tabled F(${d1}, ${d2}; 0.05) = ${f} is 0.05`, d.fSf(f, d1, d2), 0.05, 1e-6, false);
}
for (const [t, df] of [[2.1, 9], [0.4, 3], [5, 60]] as const) near(`F(1, ${df}) is t²: fSf(${t}²)`, d.fSf(t * t, 1, df), d.tSf2(t, df), 1e-12);
near('fCdf + fSf = 1', d.fCdf(1.7, 4, 11) + d.fSf(1.7, 4, 11), 1, 1e-14);
near('fSf matches numerical integration: F = 1, (3, 12)', d.fSf(1, 3, 12), 0.4262213792647942, 1e-12);

// ── 5. Chi-square ────────────────────────────────────────────────────────────
for (const [x, k] of [[3.841459, 1], [5.991465, 2], [11.070498, 5], [18.307038, 10]] as const) {
  near(`upper tail at the tabled χ²(${k}; 0.05) = ${x} is 0.05`, d.chi2Sf(x, k), 0.05, 1e-6, false);
}
for (const x of [0.2, 3, 30.07, 90]) near(`χ²(2 df) is exponential: sf(${x}) = e^(−x/2)`, d.chi2Sf(x, 2), Math.exp(-x / 2), 1e-12);
for (const x of [0.5, 4, 20]) near(`χ²(1 df) sf(${x}) = erfc(√(x/2))`, d.chi2Sf(x, 1), sp.erfc(Math.sqrt(x / 2)), 1e-13);
near('chi2Cdf + chi2Sf = 1', d.chi2Cdf(7.3, 6) + d.chi2Sf(7.3, 6), 1, 1e-14);

finish();
