// Self-check for the workbench's models (src/analysis/stats/*: correlation,
// regression, regressionFormula, groups, distribution, sentences, run) — pure.
//
// References, and where each comes from:
//   • NIST StRD linear regression, certified to 15 digits — Norris, Pontius,
//     Longley and Wampler1 (scripts/fixtures/stats/nist-strd.json, fetched
//     from www.itl.nist.gov). Estimates and standard errors to 1e-6 relative.
//   • R worked examples on R's own datasets (scripts/fixtures/stats/
//     r-examples.json): sleep (t.test, wilcox.test), PlantGrowth (lm, anova,
//     kruskal.test), the ?kruskal.test, ?chisq.test and ?cor.test examples.
//     Each is checked twice: against R's printed output to its printed
//     precision, and to 1e-6 against the same quantity recomputed
//     independently in exact rational arithmetic (see the fixture's _about).
//   • Identities: z² of the two-proportion test is the uncorrected χ² of the
//     same table; Shapiro–Wilk's n = 3 case has a closed form; W is location
//     and scale invariant; K² is the sum of its two squared z-scores.
//
// And the calculated field: the regression's formula, run through the REAL
// pipeline (transforms.applyPipeline → the formula engine), reproduces the
// model's fitted values with Object.is.
//
//   npm run build:ts && node scripts/test-statsModels.js

export {};
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const cor: typeof import('../src/analysis/stats/correlation') = require('../src/analysis/stats/correlation');
const reg: typeof import('../src/analysis/stats/regression') = require('../src/analysis/stats/regression');
const rf: typeof import('../src/analysis/stats/regressionFormula') = require('../src/analysis/stats/regressionFormula');
const grp: typeof import('../src/analysis/stats/groups') = require('../src/analysis/stats/groups');
const dist: typeof import('../src/analysis/stats/distribution') = require('../src/analysis/stats/distribution');
const sen: typeof import('../src/analysis/stats/sentences') = require('../src/analysis/stats/sentences');
const run: typeof import('../src/analysis/stats/run') = require('../src/analysis/stats/run');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');

// ponytail: fixtures are plain JSON read at run time, typed loosely.
const nist: any = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/stats/nist-strd.json'), 'utf8'));
const R: any = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/stats/r-examples.json'), 'utf8'));

const relErr = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
function near(label: string, got: number, want: number, tol = 1e-6, relative = true): void {
  const err = relative && want !== 0 ? relErr(got, want) : Math.abs(got - want);
  ok(`${label}: ${got} ≈ ${want}`, err <= tol, `err=${err}`);
}
/** R printed `want` with `dp` decimals: the value must round to it. */
function printed(label: string, got: number, want: number, dp: number): void {
  ok(`${label} prints as R's ${want}`, Math.abs(got - want) <= 0.5 * 10 ** -dp + 1e-12, `got=${got}`);
}
type RegOk = import('../src/analysis/stats/regression').RegressionOk;
const mustFit = (label: string, r: import('../src/analysis/stats/regression').RegressionResult): RegOk | null => {
  ok(`${label}: fits`, r.ok, r.ok ? '' : r.error);
  return r.ok ? r : null;
};

// ── 1. NIST StRD ─────────────────────────────────────────────────────────────
for (const name of ['Norris', 'Pontius', 'Longley', 'Wampler1']) {
  const set = nist[name];
  const c = set.columns;
  const numeric = (n: string, v: number[]) => ({ name: n, kind: 'numeric' as const, values: v });
  const preds = name === 'Longley' ? ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map((k) => numeric(k, c[k]))
    : name === 'Norris' ? [numeric('x', c.x)]
    : name === 'Pontius' ? [numeric('x', c.x), numeric('x²', c.x.map((v: number) => v * v))]
    : [1, 2, 3, 4, 5].map((p) => numeric('x^' + p, c.x.map((v: number) => v ** p)));
  const fit = mustFit(`NIST ${name}`, reg.olsFit('y', c.y, preds));
  if (!fit) continue;
  const cert = set.certified;
  fit.terms.forEach((t, i) => {
    near(`NIST ${name} B${i}`, t.estimate, cert.beta[i]);
    // Wampler1 is an exact fit: the certified SEs are 0, so the check is absolute.
    near(`NIST ${name} SE(B${i})`, t.se, cert.se[i], 1e-6, cert.se[i] !== 0);
  });
  near(`NIST ${name} residual SD`, fit.sigma, cert.residualSd, 1e-6, cert.residualSd !== 0);
  near(`NIST ${name} R²`, fit.r2, cert.r2);
}

// ── 2. PlantGrowth: one categorical predictor, R's lm ────────────────────────
const pg = R.plantGrowth;
const weight: number[] = [...pg.ctrl, ...pg.trt1, ...pg.trt2];
const group: string[] = [...pg.ctrl.map(() => 'ctrl'), ...pg.trt1.map(() => 'trt1'), ...pg.trt2.map(() => 'trt2')];
const lm = mustFit('PlantGrowth lm', reg.olsFit('weight', weight, [{ name: 'group', kind: 'categorical', values: group }]));
if (lm) {
  ok('PlantGrowth: reference level is ctrl (all ten rows each → first in sort order)', lm.references[0].level === 'ctrl');
  ok('PlantGrowth: terms are (Intercept), group[trt1], group[trt2]', lm.terms.map((t) => t.name).join('|') === '(Intercept)|group[trt1]|group[trt2]');
  lm.terms.forEach((t, i) => {
    near(`PlantGrowth ${t.name} estimate`, t.estimate, pg.exact.beta[i]);
    near(`PlantGrowth ${t.name} SE`, t.se, pg.exact.se[i]);
    near(`PlantGrowth ${t.name} t`, t.t, pg.exact.t[i]);
    near(`PlantGrowth ${t.name} p`, t.p, pg.exact.p[i]);
    near(`PlantGrowth ${t.name} CI low`, t.ciLow, pg.exact.ciLow[i]);
    near(`PlantGrowth ${t.name} CI high`, t.ciHigh, pg.exact.ciHigh[i]);
    printed(`PlantGrowth ${t.name} estimate`, t.estimate, pg.r.beta[i], 4);
    printed(`PlantGrowth ${t.name} SE`, t.se, pg.r.se[i], 4);
  });
  near('PlantGrowth R²', lm.r2, pg.exact.r2);
  near('PlantGrowth adjusted R²', lm.adjR2, pg.exact.adjR2);
  near('PlantGrowth F', lm.f, pg.exact.f);
  near('PlantGrowth F p', lm.fP, pg.exact.fP);
  near('PlantGrowth residual SE', lm.sigma, pg.exact.sigma);
  printed('PlantGrowth F p', lm.fP, pg.r.fP, 5);
  printed('PlantGrowth residual SE', lm.sigma, pg.r.sigma, 4);
  ok('PlantGrowth: n and df', lm.n === 30 && lm.df === 27 && lm.fDf1 === 2 && lm.dropped === 0);
}

// Reference level = the LARGEST group, not the first alphabetically.
{
  const g = ['b', 'a', 'b', 'c', 'b', 'a', 'c', 'b'];
  const y = [5, 1, 6, 9, 5.5, 1.2, 8.8, 6.1];
  const f = mustFit('reference = largest group', reg.olsFit('y', y, [{ name: 'g', kind: 'categorical', values: g }]));
  ok('reference = largest group: b (4 rows) over a/c (2 each)', !!f && f.references[0].level === 'b', f ? f.references[0].level : '');
  ok('reference level ties go to the first in code-unit order', reg.referenceLevel(new Map([['z', 3], ['B', 3], ['a', 3]])) === 'B');
}

// ── 3. The calculated field reproduces the fitted values ─────────────────────
{
  // Mixed numeric + categorical, negative and positive coefficients, a
  // missing number, an empty category and a level the model never saw.
  const rows: Array<[string | null, number | null, number | null, number | null]> = [];
  for (let i = 0; i < 60; i++) {
    const region = ['East', 'West', 'North "N"'][i % 3];
    const price = 3 + ((i * 7) % 11) * 0.37;
    const ads = ((i * 5) % 13) - 4.25;
    const sales = 12.5 - 1.7 * price + 0.93 * ads + (region === 'West' ? 4.2 : region === 'East' ? -1.1 : 0) + (((i * 37) % 17) - 8) * 0.11;
    rows.push([region, price, ads, sales]);
  }
  const col = (j: number) => rows.map((r) => r[j]);
  const fit = mustFit('formula model', reg.olsFit('sales', col(3) as number[], [
    { name: 'price', kind: 'numeric', values: col(1) as number[] },
    { name: 'region', kind: 'categorical', values: col(0) as string[] },
    { name: 'ad spend', kind: 'numeric', values: col(2) as number[] },
  ]));
  if (fit) {
    const f = rf.regressionFormula(fit);
    ok('formula: built', f.ok, f.ok ? '' : f.error);
    if (f.ok) {
      ok('formula: numeric terms and one CASE per category', /\* \[price\]/.test(f.expression) && /CASE \[region\] WHEN/.test(f.expression) && /\* \[ad spend\]/.test(f.expression), f.expression);
      const extra: Array<[string | null, number | null, number | null, number | null]> = [
        ['West', null, 1, 0], [null, 4, 1, 0], ['   ', 4, 1, 0], ['South', 4, 1, 0],
      ];
      const table = {
        columns: [{ name: 'region', type: 'text' as const }, { name: 'price', type: 'number' as const }, { name: 'ad spend', type: 'number' as const }, { name: 'sales', type: 'number' as const }],
        rows: [...rows, ...extra] as import('../src/data/transforms').Cell[][],
      };
      const out = transforms.applyPipeline(table, [{ type: 'calculated_field', name: rf.predictedName('sales'), expression: f.expression }]);
      const ci = out.columns.findIndex((c) => c.name === 'predicted_sales');
      ok('formula: the pipeline adds predicted_sales as a number column', ci >= 0 && out.columns[ci].type === 'number', JSON.stringify(out.columns));
      const { intercept, fits } = reg.modelFits(fit);
      let same = 0;
      for (let i = 0; i < rows.length; i++) {
        const want = reg.fittedAt(intercept, fits, (c) => (c === 'region' ? rows[i][0] : c === 'price' ? rows[i][1] : rows[i][2]));
        if (Object.is(out.rows[i][ci], want)) same++;
      }
      ok(`formula: all ${rows.length} fitted values reproduced bit for bit (Object.is)`, same === rows.length, `${same} of ${rows.length}`);
      // And those ARE the model's fitted values: residual = y − fitted.
      const back = rows.map((r, i) => (r[3] as number) - (out.rows[i][ci] as number));
      near('formula: residual sum of squares matches the model', back.reduce((s, e) => s + e * e, 0), fit.sigma ** 2 * fit.df, 1e-12);
      ok('formula: a missing number → no prediction', out.rows[rows.length][ci] === null);
      ok('formula: an empty category → no prediction', out.rows[rows.length + 1][ci] === null && out.rows[rows.length + 2][ci] === null);
      ok('formula: a level the model never saw → no prediction', out.rows[rows.length + 3][ci] === null);
      ok('formula: a quoted level is escaped', f.expression.includes('"North \\"N\\""'), f.expression);
    }
  }
  ok('formula: a column the language cannot reference is refused', !rf.formulaSafeColumn('a]b') && !rf.formulaSafeColumn(' pad') && !rf.formulaSafeColumn('[x') && rf.formulaSafeColumn('ad spend'));
}

// Failure modes are sentences, not throws.
{
  const e = reg.olsFit('y', [1, 2, null], [{ name: 'x', kind: 'numeric', values: [1, 2, 3] }]);
  ok('regression: too few rows is explained', !e.ok && /more rows than terms/.test(e.error));
  const c = reg.olsFit('y', [1, 2, 3, 4, 5], [{ name: 'x', kind: 'numeric', values: [2, 2, 2, 2, 2] }]);
  ok('regression: a constant predictor is explained', !c.ok && /same value in every row/.test(c.error));
  const col = reg.olsFit('y', [1, 3, 2, 5, 4, 6], [
    { name: 'a', kind: 'numeric', values: [1, 2, 3, 4, 5, 6] }, { name: 'b', kind: 'numeric', values: [2, 4, 6, 8, 10, 12] },
  ]);
  ok('regression: collinear predictors are named', !col.ok && /“b” is a combination/.test(col.error), col.ok ? '' : col.error);
  const miss = reg.olsFit('y', [1, 2, null, 4, 5, 7], [{ name: 'x', kind: 'numeric', values: [1, 2, 3, null, 5, 6.5] }]);
  ok('regression: rows with a missing value are dropped and counted', miss.ok && miss.n === 4 && miss.dropped === 2);
}

// ── 4. Groups ────────────────────────────────────────────────────────────────
const sl = R.sleep;
const w = grp.welch(sl.group1, sl.group2);
ok('Welch: computes', !!w);
if (w) {
  for (const k of ['t', 'df', 'p', 'ciLow', 'ciHigh'] as const) near(`sleep Welch ${k}`, w[k], sl.exact[k]);
  printed('sleep Welch CI low', w.ciLow, sl.r.ciLow, 7);
  printed('sleep Welch CI high', w.ciHigh, sl.r.ciHigh, 7);
  printed('sleep Welch p', w.p, sl.r.p, 5);
  // Cohen's d on the pooled SD, and Hedges' exact J for 18 df.
  near('sleep Cohen d', w.cohenD, -1.58 / Math.sqrt((3.200555555555556 + 4.009) / 2), 1e-9);
  // J = Γ(9)/(√9 Γ(8.5)) = 0.9576464270237177 (Python math.lgamma).
  near('sleep Hedges g = d·J, J = Γ(9)/(3 Γ(8.5))', w.hedgesG, w.cohenD * 0.9576464270237177, 1e-12);
}
const mw = grp.mannWhitney(sl.group1, sl.group2);
ok('Mann–Whitney: U = 25.5 (R W)', !!mw && mw.u === sl.r.W);
if (mw) {
  near('sleep Mann–Whitney z', mw.z, sl.exact.z);
  near('sleep Mann–Whitney p', mw.p, sl.exact.wilcoxP);
  printed('sleep Mann–Whitney p', mw.p, sl.r.wilcoxP, 5);
  near('rank-biserial = 2U/(n1 n2) − 1', mw.rankBiserial, 2 * 25.5 / 100 - 1, 1e-15);
}
const av = grp.anova([pg.ctrl, pg.trt1, pg.trt2]);
if (av) {
  near('PlantGrowth ANOVA F', av.f, pg.exact.f);
  near('PlantGrowth ANOVA p', av.p, pg.exact.fP);
  near('PlantGrowth η² = SSB/SST', av.etaSq, pg.exact.ssBetween / (pg.exact.ssBetween + pg.exact.ssWithin));
  ok('PlantGrowth ANOVA df (2, 27)', av.df1 === 2 && av.df2 === 27);
} else ok('PlantGrowth ANOVA computes', false);
const kw = grp.kruskal([pg.ctrl, pg.trt1, pg.trt2]);
if (kw) {
  near('PlantGrowth Kruskal–Wallis H (tie corrected)', kw.h, pg.exact.kruskalH);
  near('PlantGrowth Kruskal–Wallis p', kw.p, pg.exact.kruskalP);
  printed('PlantGrowth Kruskal–Wallis H', kw.h, pg.r.kruskalH, 4);
  near('ε² = H/(n − 1)', kw.epsilonSq, kw.h / 29, 1e-15);
} else ok('PlantGrowth Kruskal–Wallis computes', false);
const hw = grp.kruskal([R.hollander.x, R.hollander.y, R.hollander.z]);
if (hw) {
  near('Hollander–Wolfe Kruskal–Wallis H', hw.h, R.hollander.exact.h);
  near('Hollander–Wolfe p', hw.p, R.hollander.exact.p);
  printed('Hollander–Wolfe H', hw.h, R.hollander.r.h, 5);
} else ok('Hollander–Wolfe computes', false);
const chi = grp.chiSquare(R.party.table);
if (chi) {
  near('party χ²', chi.chi2, R.party.exact.chi2);
  near('party p', chi.p, R.party.exact.p);
  near("party Cramér's V", chi.cramerV, R.party.exact.cramerV);
  printed('party χ²', chi.chi2, R.party.r.chi2, 2);
  ok('party: df 2, no low expected counts', chi.df === 2 && !chi.lowExpected);
} else ok('party χ² computes', false);
const low = grp.chiSquare([[3, 1], [1, 4]]);
ok('χ²: an expected count below 5 is flagged', !!low && low.lowExpected && low.minExpected < 5);
{
  // Two proportions: z² is the uncorrected χ² of the same 2×2 table.
  const x1 = 83, n1 = 86, x2 = 90, n2 = 93;
  const pr = grp.twoProportions(x1, n1, x2, n2);
  const c2 = grp.chiSquare([[x1, n1 - x1], [x2, n2 - x2]]);
  ok('two proportions: computes', !!pr && !!c2);
  if (pr && c2) {
    near('two proportions: z² = χ² (uncorrected)', pr.z * pr.z, c2.chi2, 1e-12);
    near('two proportions: p = χ² p', pr.p, c2.p, 1e-12);
    const se = Math.sqrt((pr.p1 * (1 - pr.p1)) / n1 + (pr.p2 * (1 - pr.p2)) / n2);
    near('two proportions: Wald CI', pr.ciHigh - pr.ciLow, 2 * 1.959963984540054 * se, 1e-12);
    near("two proportions: Cohen's h", pr.cohenH, 2 * Math.asin(Math.sqrt(83 / 86)) - 2 * Math.asin(Math.sqrt(90 / 93)), 1e-15);
  }
}

// ── 5. Correlation ───────────────────────────────────────────────────────────
const ct = R.corTest;
const pe = cor.correlate(ct.x, ct.y, 'pearson');
near('cor.test r', pe.r as number, ct.exact.r);
near('cor.test p', pe.p as number, ct.exact.p);
printed('cor.test r', pe.r as number, ct.r.r, 7);
printed('cor.test p', pe.p as number, ct.r.p, 4);
const sr = cor.correlate(ct.x, ct.y, 'spearman');
near('Spearman ρ = 0.6', sr.r as number, 0.6, 1e-12);
near('Spearman p (t approximation)', sr.p as number, ct.exact.rhoP);
{
  const ranks = cor.rank([3, 1, 4, 1, 5, 9, 2, 6, 5]);
  ok('ranks average ties', JSON.stringify(ranks.ranks) === JSON.stringify([4, 1.5, 5, 1.5, 6.5, 9, 3, 8, 6.5]) && JSON.stringify(ranks.ties) === '[2,2]');
  const m = cor.corrMatrix(['a', 'b', 'c'], [[1, 2, 3, 4, null], [2, 4, 5, 8, 10], [5, null, 3, 2, 1]], 'pearson');
  ok('matrix: symmetric, pairwise-complete n', m.cells[0][1] === m.cells[1][0] && m.cells[0][1].n === 4 && m.cells[0][2].n === 3 && m.cells[1][2].n === 4);
  ok('matrix: diagonal is 1 over the column\'s own n', m.cells[0][0].r === 1 && m.cells[0][0].n === 4 && m.cells[1][1].n === 5);
  ok('correlation: fewer than 3 pairs → no r', cor.correlate([1, 2], [3, 4], 'pearson').r === null);
  const line = cor.fitLine([1, 2, 3, 4], [3, 5, 7, 9]);
  ok('fit line: y = 1 + 2x', !!line && Math.abs(line.intercept - 1) < 1e-12 && Math.abs(line.slope - 2) < 1e-12);
}

// ── 6. Distribution ──────────────────────────────────────────────────────────
{
  const sw3 = dist.shapiroWilk([1, 2, 4]);
  // n = 3: a = (−√½, 0, √½), so W = (x₃ − x₁)² / (2·SS), and p has a closed form.
  const W3 = 9 / (2 * (42 / 9));
  ok('Shapiro–Wilk n = 3: computes', !!sw3);
  if (sw3) {
    near('Shapiro–Wilk n = 3: W = (x₃ − x₁)²/(2 SS)', sw3.statistic, W3, 1e-12);
    near('Shapiro–Wilk n = 3: p = (6/π)(asin √W − π/3)', sw3.p, (6 / Math.PI) * (Math.asin(Math.sqrt(W3)) - Math.PI / 3), 1e-12);
  }
  const men = dist.shapiroWilk(R.shapiroWilk1965.x);
  ok('Shapiro–Wilk (1965) weights of 11 men: W rounds to the paper\'s 0.79', !!men && Math.abs(men.statistic - 0.79) < 0.005, men ? String(men.statistic) : '');
  ok('Shapiro–Wilk: those weights are clearly not normal (p < 0.05)', !!men && men.p < 0.05);
  const sample = [2.1, 3.4, 1.9, 5.6, 4.4, 3.3, 2.8, 6.1, 3.9, 4.0, 2.2, 3.7, 5.1, 4.8];
  const a = dist.shapiroWilk(sample);
  const b = dist.shapiroWilk(sample.map((x) => 10 - 3 * x).reverse());
  ok('Shapiro–Wilk: invariant to location, scale, sign and order', !!a && !!b && Math.abs(a.statistic - b.statistic) < 1e-12 && Math.abs(a.p - b.p) < 1e-12);
  ok('Shapiro–Wilk: n > 5,000 is D\'Agostino\'s', dist.shapiroWilk(new Array(5001).fill(0).map((_, i) => i % 97)) === null
    && dist.normality(new Array(5001).fill(0).map((_, i) => i % 97))?.method === 'dagostino');
  const sym = Array.from({ length: 400 }, (_, i) => (i % 2 ? 1 : -1) * Math.sqrt(i));
  const k = dist.dagostino(sym);
  ok("D'Agostino: computes", !!k);
  if (k) {
    near("D'Agostino: K² = z²(skew) + z²(kurtosis)", k.statistic, (k.zSkew as number) ** 2 + (k.zKurt as number) ** 2, 1e-12);
    near("D'Agostino: p = e^(−K²/2) (χ², 2 df)", k.p, Math.exp(-k.statistic / 2), 1e-12);
  }
  const mo = dist.moments([1, 2, 3, 4, 10]);
  // Deviations −3, −2, −1, 0, 6: m2 = 10, m3 = 36, m4 = 278.8 (population
  // moments). G1 = (m3/m2^1.5)·√(n(n−1))/(n−2); G2 = ((n+1)g2 + 6)(n−1)/((n−2)(n−3)).
  ok('moments: computes', !!mo);
  if (mo) {
    near('moments: mean', mo.mean, 4, 1e-15);
    near('moments: SD (n − 1)', mo.sd, Math.sqrt(12.5), 1e-15);
    near('moments: adjusted skewness G1', mo.skewness as number, (36 / 10 ** 1.5) * Math.sqrt(20) / 3, 1e-12);
    near('moments: excess kurtosis G2', mo.kurtosis as number, ((6 * (278.8 / 100 - 3) + 6) * 4) / (3 * 2), 1e-12);
  }
  const h = dist.histogram([1, 2, 2, 3, 3, 3, 4, 4, 5, 9], 3.6, 2.2);
  ok('histogram: counts sum to n, labels match buckets', h.counts.reduce((s, x) => s + x, 0) === 10 && h.labels.length === h.counts.length && h.edges.length === h.counts.length + 1);
}

// ── 7. Sentences and the dispatcher ──────────────────────────────────────────
ok('fmtP: p < 0.001 / three decimals / p > 0.999', sen.fmtP(0.0004) === 'p < 0.001' && sen.fmtP(0.0031) === 'p = 0.003' && sen.fmtP(0.9996) === 'p > 0.999');
ok('stars', sen.stars(0.0001) === '***' && sen.stars(0.004) === '**' && sen.stars(0.04) === '*' && sen.stars(0.07) === '·' && sen.stars(0.2) === '');
ok('two-group sentence names the higher group first, with the % gap and p',
  sen.twoGroupSentence('revenue', { label: 'East', mean: 100 }, { label: 'West', mean: 112 }, 0.003)
    === "West's average revenue is 12.0% higher than East's; the difference is significant (p = 0.003).");
ok('two-group sentence says "not significant"', /not significant \(p = 0\.412\)/.test(sen.twoGroupSentence('x', { label: 'a', mean: 2 }, { label: 'b', mean: 1 }, 0.412)));
{
  const v = { rows: 30, number: new Map([['weight', weight as Array<number | null>]]), label: new Map([['group', group as Array<string | null>]]) };
  const two = run.runStats({ kind: 'groups', datasetId: 'x', columns: [], group: 'group', outcome: 'weight', levels: ['trt2', 'ctrl'] }, v);
  ok('dispatch: two chosen groups → Welch + Mann–Whitney', two.ok && two.kind === 'groups' && two.mode === 'two' && !!two.welch && !!two.mannWhitney);
  const many = run.runStats({ kind: 'groups', datasetId: 'x', columns: [], group: 'group', outcome: 'weight' }, v);
  ok('dispatch: three groups → ANOVA + Kruskal–Wallis', many.ok && many.kind === 'groups' && many.mode === 'many' && !!many.anova && !!many.kruskal);
  if (many.ok && many.kind === 'groups') ok('dispatch: the ANOVA sentence', /differs significantly across the 3 group groups \(p = 0\.016\): trt2 is highest/.test(many.sentence), many.sentence);
  const few = run.runStats({ kind: 'distribution', datasetId: 'x', columns: ['n'] }, { rows: 2, number: new Map([['n', [1, null, 2]]]), label: new Map() });
  ok('dispatch: "Need at least 3 values"', !few.ok && /Need at least 3 values/.test(few.error));
  const lab = new Map([['g', ['a', 'a', 'b', 'b', 'a', 'b'] as Array<string | null>], ['o', ['yes', 'no', 'no', 'no', 'yes', 'yes'] as Array<string | null>]]);
  const tp = run.runStats({ kind: 'groups', datasetId: 'x', columns: [], group: 'g', outcome: 'o' }, { rows: 6, number: new Map(), label: lab });
  ok('dispatch: 2 × 2 categorical → two-proportion z with "yes" as success, and χ²', tp.ok && tp.kind === 'groups' && !!tp.prop && tp.prop.success === 'yes' && !!tp.chi);
}

finish();
