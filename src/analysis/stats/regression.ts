// Ordinary least squares — MAIN PROCESS, PURE.
//
// One numeric target, any mix of numeric and categorical predictors, solved by
// Householder QR on EQUILIBRATED columns (each column scaled to unit length
// before the factorisation, the scale divided back out of the estimates). That
// is what passes NIST StRD Longley, Pontius and Wampler1 to 1e-6 relative:
// normal equations square the condition number and fail Longley outright, and
// unscaled QR loses Wampler1's x⁵ column.
//
// ROWS. A row is used only when the target and EVERY predictor are present;
// the rest are dropped and counted (`dropped`), never imputed.
//
// CATEGORICAL PREDICTORS are one-hot encoded against a REFERENCE LEVEL: the
// level with the most rows among the rows used, ties going to the first in
// code-unit sort order. Each other level gets a 0/1 column named
// `column[level]`, in sort order, and its coefficient is the difference from
// the reference. (R's default reference is the first level alphabetically; the
// app prefers the largest group because it gives the most stable baseline, and
// the two agree whenever the first level is also the largest — as in every
// balanced design.)
//
// FITTED VALUES are summed predictor by predictor, intercept first — the order
// ./regressionFormula.ts writes the calculated field in, so evaluating that
// formula through the formula engine reproduces them bit for bit.

import { fSf, normQuantile, tQuantile, tSf2 } from './distributions';

export const MAX_LEVELS = 50;
const RESID_POINTS = 2000;
const QQ_POINTS = 400;
const RANK_TOL = 1e-9;

export type RegInput =
  | { name: string; kind: 'numeric'; values: readonly (number | null)[] }
  | { name: string; kind: 'categorical'; values: readonly (string | null)[] };

export interface RegTerm {
  /** "(Intercept)", "price", "region[West]". */
  name: string;
  /** The source column; null for the intercept. */
  column: string | null;
  /** The level this dummy stands for (categorical terms only). */
  level?: string;
  estimate: number;
  se: number;
  t: number;
  p: number;
  ciLow: number;
  ciHigh: number;
}

export interface RegressionOk {
  ok: true;
  target: string;
  n: number;
  dropped: number;
  /** Residual degrees of freedom, n − (number of terms). */
  df: number;
  terms: RegTerm[];
  /** The baseline each categorical predictor's coefficients are measured from. */
  references: Array<{ column: string; level: string; levels: string[] }>;
  r2: number;
  adjR2: number;
  f: number;
  fDf1: number;
  fDf2: number;
  fP: number;
  /** Residual standard error σ̂. */
  sigma: number;
  /** Fitted vs residual, every row up to 2,000, then evenly thinned. */
  residuals: { fitted: number[]; residual: number[] };
  /** Normal QQ of the standardised residuals, at most 400 points (ranks evenly spaced). */
  qq: { theoretical: number[]; sample: number[] };
}

export type RegressionResult = RegressionOk | { ok: false; error: string };

/** One predictor as the fitted-value sum and the formula both walk it. */
export type PredictorFit =
  | { kind: 'numeric'; column: string; coef: number }
  | { kind: 'categorical'; column: string; reference: string; coefs: Array<{ level: string; coef: number }> };

/** Code-unit order: deterministic on every machine, unlike locale collation. */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The reference level: most rows, ties to the first in code-unit order. */
export function referenceLevel(counts: Map<string, number>): string {
  let best = '';
  let bestN = -1;
  for (const level of [...counts.keys()].sort(byCode)) {
    const n = counts.get(level) as number;
    if (n > bestN) { best = level; bestN = n; }
  }
  return best;
}

/** Evaluate one fitted value, predictor by predictor — the calculated field's order. */
export function fittedAt(intercept: number, fits: readonly PredictorFit[], row: (column: string) => number | string | null): number | null {
  let s = intercept;
  for (const f of fits) {
    const v = row(f.column);
    if (f.kind === 'numeric') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      s = s + f.coef * v;
    } else {
      if (typeof v !== 'string') return null;
      if (v === f.reference) { s = s + 0; continue; }
      const hit = f.coefs.find((c) => c.level === v);
      if (!hit) return null;
      s = s + hit.coef;
    }
  }
  return s;
}

export function olsFit(target: string, y: readonly (number | null)[], predictors: readonly RegInput[]): RegressionResult {
  if (!predictors.length) return { ok: false, error: 'Pick at least one predictor.' };
  const total = y.length;

  // ── Complete cases ──────────────────────────────────────────────────────
  const rows: number[] = [];
  for (let i = 0; i < total; i++) {
    const yi = y[i];
    if (yi === null || !Number.isFinite(yi)) continue;
    let ok = true;
    for (const p of predictors) {
      const v = p.values[i];
      if (v === null || v === undefined || (p.kind === 'numeric' && !Number.isFinite(v as number))) { ok = false; break; }
    }
    if (ok) rows.push(i);
  }
  const n = rows.length;

  // ── Design columns ──────────────────────────────────────────────────────
  const cols: Float64Array[] = [];
  const names: string[] = ['(Intercept)'];
  const sources: Array<{ column: string | null; level?: string }> = [{ column: null }];
  const references: RegressionOk['references'] = [];
  const intercept = new Float64Array(n).fill(1);
  cols.push(intercept);
  for (const p of predictors) {
    if (p.kind === 'numeric') {
      const c = new Float64Array(n);
      for (let r = 0; r < n; r++) c[r] = p.values[rows[r]] as number;
      let lo = Infinity;
      let hi = -Infinity;
      for (let r = 0; r < n; r++) { if (c[r] < lo) lo = c[r]; if (c[r] > hi) hi = c[r]; }
      if (n > 0 && lo === hi) return { ok: false, error: `“${p.name}” has the same value in every row used, so it cannot explain anything.` };
      cols.push(c);
      names.push(p.name);
      sources.push({ column: p.name });
      continue;
    }
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = p.values[r] as string;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    if (counts.size > MAX_LEVELS) {
      return { ok: false, error: `“${p.name}” has ${counts.size.toLocaleString('en-US')} distinct values — too many to use as a category (the limit is ${MAX_LEVELS}).` };
    }
    if (n > 0 && counts.size < 2) return { ok: false, error: `“${p.name}” has only one value in the rows used, so it cannot explain anything.` };
    const ref = referenceLevel(counts);
    const levels = [...counts.keys()].sort(byCode);
    references.push({ column: p.name, level: ref, levels });
    for (const level of levels) {
      if (level === ref) continue;
      const c = new Float64Array(n);
      for (let r = 0; r < n; r++) c[r] = p.values[rows[r]] === level ? 1 : 0;
      cols.push(c);
      names.push(`${p.name}[${level}]`);
      sources.push({ column: p.name, level });
    }
  }
  const k = cols.length;
  if (n <= k) {
    return { ok: false, error: `Need more rows than terms: ${n.toLocaleString('en-US')} complete row${n === 1 ? '' : 's'} for ${k} terms.` };
  }

  // ── Equilibrate, then Householder QR (in place on copies) ───────────────
  const scale = new Float64Array(k);
  const a: Float64Array[] = cols.map((c, j) => {
    let s = 0;
    for (let r = 0; r < n; r++) s += c[r] * c[r];
    scale[j] = Math.sqrt(s);
    const out = new Float64Array(n);
    for (let r = 0; r < n; r++) out[r] = c[r] / scale[j];
    return out;
  });
  const qty = new Float64Array(n);
  for (let r = 0; r < n; r++) qty[r] = y[rows[r]] as number;
  const rdiag = new Float64Array(k);
  for (let j = 0; j < k; j++) {
    const col = a[j];
    let norm = 0;
    for (let r = j; r < n; r++) norm += col[r] * col[r];
    norm = Math.sqrt(norm);
    const alpha = col[j] > 0 ? -norm : norm;
    rdiag[j] = alpha;
    const v0 = col[j] - alpha;
    col[j] = v0;
    let vv = v0 * v0;
    for (let r = j + 1; r < n; r++) vv += col[r] * col[r];
    if (vv === 0) continue;
    const apply = (t: Float64Array): void => {
      let d = 0;
      for (let r = j; r < n; r++) d += col[r] * t[r];
      const f = (2 * d) / vv;
      for (let r = j; r < n; r++) t[r] -= f * col[r];
    };
    for (let c2 = j + 1; c2 < k; c2++) apply(a[c2]);
    apply(qty);
  }
  let maxDiag = 0;
  for (let j = 0; j < k; j++) maxDiag = Math.max(maxDiag, Math.abs(rdiag[j]));
  for (let j = 0; j < k; j++) {
    if (Math.abs(rdiag[j]) <= RANK_TOL * maxDiag) {
      return { ok: false, error: `“${names[j]}” is a combination of the other predictors, so its effect cannot be separated from theirs. Remove it or one of them.` };
    }
  }
  // R (upper triangle): R[i][j] = a[j][i] for i < j, rdiag on the diagonal.
  const R = (i: number, j: number): number => (i === j ? rdiag[i] : a[j][i]);
  const gamma = new Float64Array(k);
  for (let i = k - 1; i >= 0; i--) {
    let s = qty[i];
    for (let j = i + 1; j < k; j++) s -= R(i, j) * gamma[j];
    gamma[i] = s / R(i, i);
  }
  // R⁻¹ (upper triangular), for the covariance diagonal.
  const rinv: Float64Array[] = Array.from({ length: k }, () => new Float64Array(k));
  for (let j = 0; j < k; j++) {
    rinv[j][j] = 1 / R(j, j);
    for (let i = j - 1; i >= 0; i--) {
      let s = 0;
      for (let m = i + 1; m <= j; m++) s += R(i, m) * rinv[m][j];
      rinv[i][j] = -s / R(i, i);
    }
  }
  const beta = Array.from(gamma, (g, j) => g / scale[j]);

  // ── Fitted values, residuals, fit statistics ────────────────────────────
  const fits = predictorFits(predictors, sources, beta, references);
  const byName = new Map(predictors.map((p) => [p.name, p.values as readonly (number | string | null)[]] as const));
  const fitted = new Float64Array(n);
  const resid = new Float64Array(n);
  let ym = 0;
  for (let r = 0; r < n; r++) ym += y[rows[r]] as number;
  ym /= n;
  let rss = 0;
  let tss = 0;
  for (let r = 0; r < n; r++) {
    const i = rows[r];
    const f = fittedAt(beta[0], fits, (col) => (byName.get(col) as readonly (number | string | null)[])[i]) as number;
    fitted[r] = f;
    const e = (y[i] as number) - f;
    resid[r] = e;
    rss += e * e;
    tss += ((y[i] as number) - ym) ** 2;
  }
  if (!(tss > 0)) return { ok: false, error: `“${target}” has the same value in every row used, so there is nothing to explain.` };
  const df = n - k;
  const sigma2 = rss / df;
  const sigma = Math.sqrt(sigma2);
  const tcrit = tQuantile(0.975, df);
  const terms: RegTerm[] = beta.map((b, j) => {
    let v = 0;
    for (let m = j; m < k; m++) v += rinv[j][m] * rinv[j][m];
    const se = (sigma * Math.sqrt(v)) / scale[j];
    const t = se > 0 ? b / se : b === 0 ? 0 : b > 0 ? Infinity : -Infinity;
    const term: RegTerm = {
      name: names[j], column: sources[j].column, estimate: b, se, t,
      p: se > 0 ? tSf2(t, df) : 0, ciLow: b - tcrit * se, ciHigh: b + tcrit * se,
    };
    if (sources[j].level !== undefined) term.level = sources[j].level;
    return term;
  });
  const r2 = 1 - rss / tss;
  const fDf1 = k - 1;
  const f = rss > 0 ? ((tss - rss) / fDf1) / sigma2 : Infinity;
  return {
    ok: true, target, n, dropped: total - n, df, terms, references,
    r2, adjR2: 1 - ((1 - r2) * (n - 1)) / df, f, fDf1, fDf2: df, fP: rss > 0 ? fSf(f, fDf1, df) : 0, sigma,
    residuals: thinPairs(fitted, resid),
    qq: qqPoints(resid, sigma),
  };
}

function predictorFits(
  predictors: readonly RegInput[],
  sources: Array<{ column: string | null; level?: string }>,
  beta: number[],
  references: RegressionOk['references'],
): PredictorFit[] {
  return predictors.map((p): PredictorFit => {
    if (p.kind === 'numeric') {
      const j = sources.findIndex((s) => s.column === p.name && s.level === undefined);
      return { kind: 'numeric', column: p.name, coef: beta[j] };
    }
    const ref = references.find((r) => r.column === p.name) as RegressionOk['references'][number];
    const coefs: Array<{ level: string; coef: number }> = [];
    sources.forEach((s, j) => { if (s.column === p.name && s.level !== undefined) coefs.push({ level: s.level, coef: beta[j] }); });
    return { kind: 'categorical', column: p.name, reference: ref.level, coefs };
  });
}

/** The fit a calculated field is written from: intercept + one entry per predictor. */
export function modelFits(res: RegressionOk): { intercept: number; fits: PredictorFit[] } {
  const fits: PredictorFit[] = [];
  const seen = new Set<string>();
  for (const t of res.terms) {
    if (t.column === null || seen.has(t.column)) continue;
    seen.add(t.column);
    const ref = res.references.find((r) => r.column === t.column);
    if (!ref) { fits.push({ kind: 'numeric', column: t.column, coef: t.estimate }); continue; }
    const coefs = res.terms.filter((x) => x.column === t.column && x.level !== undefined).map((x) => ({ level: x.level as string, coef: x.estimate }));
    fits.push({ kind: 'categorical', column: t.column, reference: ref.level, coefs });
  }
  return { intercept: res.terms[0].estimate, fits };
}

function thinPairs(a: Float64Array, b: Float64Array): { fitted: number[]; residual: number[] } {
  const n = a.length;
  const step = Math.max(1, Math.ceil(n / RESID_POINTS));
  const fitted: number[] = [];
  const residual: number[] = [];
  for (let i = 0; i < n; i += step) { fitted.push(a[i]); residual.push(b[i]); }
  return { fitted, residual };
}

/** R's ppoints: (i − a)/(n + 1 − 2a), a = 3/8 for n ≤ 10, else ½. */
function qqPoints(resid: Float64Array, sigma: number): { theoretical: number[]; sample: number[] } {
  const n = resid.length;
  const sorted = Array.from(resid).sort((x, y) => x - y);
  const aa = n <= 10 ? 3 / 8 : 0.5;
  const take = Math.min(n, QQ_POINTS);
  const theoretical: number[] = [];
  const sample: number[] = [];
  for (let t = 0; t < take; t++) {
    const i = take === 1 ? 0 : Math.round((t * (n - 1)) / (take - 1));
    theoretical.push(normQuantile((i + 1 - aa) / (n + 1 - 2 * aa)));
    sample.push(sigma > 0 ? sorted[i] / sigma : 0);
  }
  return { theoretical, sample };
}
