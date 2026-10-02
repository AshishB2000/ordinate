// The Assistant's FACTS for a statistical result — MAIN PROCESS, PURE.
//
// Lays out what the workbench computed (src/analysis/stats) as a facts block,
// a provenance line and a number ledger — the contract every builder in
// ./copilotFacts keeps and ./scorecardFacts follows: the app does the math,
// the model narrates it. "Is the difference significant?" is answered from
// the app's own p-value and the app's own sentence; the model never runs a
// test, rounds a coefficient, or derives a percentage itself.
//
// Every figure goes into the ledger unrounded, with the unit a `%` token needs
// (numberAudit), and the app's sentences ride along verbatim — the backstop
// below ledgers anything they print.

import type { CopilotFacts } from './copilot';
import type { LedgerEntry } from './numberAudit';
import { harvestAppNumbers } from './numberAudit';
import type { StatsSpec } from '../analysis/stats/spec';
import type { StatsResult } from '../analysis/stats/run';
import { statsTitle } from '../analysis/stats/present';

const GUARD_LINE =
  'The numbers below were computed by the app (Ordinate), not by you. ' +
  'Treat them as ground truth: cite them exactly and NEVER recompute, round, or invent a figure. ' +
  'Significance is the app\'s call at p < 0.05; use its sentences as given.';

const raw = (v: number | null | undefined): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : 'n/a');

export interface StatsFactItem {
  spec: StatsSpec;
  result: StatsResult;
}

/** Facts for one or more results over one dataset (the open panel) or several (a dashboard's tiles). */
export function statsFacts(items: StatsFactItem[], datasetName: string): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  const add = (label: string, v: number | null | undefined, unit: LedgerEntry['unit'] = 'number'): void => {
    if (typeof v === 'number' && Number.isFinite(v)) ledger.push({ label, value: v, unit, source: 'stats' });
  };
  for (const { spec, result } of items) {
    lines.push(`Analysis: ${statsTitle(spec)} on "${datasetName}".`);
    if (!result.ok) { lines.push(`- Not computed: ${result.error}`, ''); continue; }
    add(`${statsTitle(spec)} rows read`, result.rows, 'count');
    if (result.kind === 'correlation') {
      const { columns, cells, method } = result.matrix;
      lines.push(`Method: ${method}. Each pair: coefficient, two-sided p, n (pairwise-complete rows).`);
      for (let i = 0; i < columns.length; i++) {
        for (let j = i + 1; j < columns.length; j++) {
          const c = cells[i][j];
          lines.push(`- "${columns[i]}" × "${columns[j]}": r = ${raw(c.r)}, p = ${raw(c.p)}, n = ${c.n}`);
          add(`r ${columns[i]} × ${columns[j]}`, c.r);
          add(`p ${columns[i]} × ${columns[j]}`, c.p);
          add(`n ${columns[i]} × ${columns[j]}`, c.n, 'count');
        }
      }
    } else if (result.kind === 'regression') {
      const f = result.fit;
      lines.push(`OLS of "${f.target}" on ${f.terms.length - 1} term(s); ${f.n} complete rows used, ${f.dropped} dropped for a missing value.`);
      for (const r of f.references) lines.push(`- "${r.column}" is one-hot encoded against its reference level "${r.level}".`);
      for (const t of f.terms) {
        lines.push(`- ${t.name}: estimate ${raw(t.estimate)}, std. error ${raw(t.se)}, t ${raw(t.t)}, p ${raw(t.p)}, 95% CI ${raw(t.ciLow)} to ${raw(t.ciHigh)}`);
        add(`${t.name} estimate`, t.estimate);
        add(`${t.name} std. error`, t.se);
        add(`${t.name} t`, t.t);
        add(`${t.name} p`, t.p);
        add(`${t.name} CI low`, t.ciLow);
        add(`${t.name} CI high`, t.ciHigh);
      }
      lines.push(`R² ${raw(f.r2)}, adjusted R² ${raw(f.adjR2)}, F ${raw(f.f)} on ${f.fDf1} and ${f.fDf2} df, p ${raw(f.fP)}, residual SE ${raw(f.sigma)}.`);
      add('R²', f.r2); add('R² %', f.r2 * 100, 'percent'); add('adjusted R²', f.adjR2); add('F', f.f); add('F p', f.fP); add('residual SE', f.sigma);
      add('n', f.n, 'count'); add('rows dropped', f.dropped, 'count'); add('df', f.df, 'count');
      lines.push(`App's sentence: ${result.sentence}`);
    } else if (result.kind === 'groups') {
      lines.push(`Outcome "${result.outcome}" by "${result.group}", ${result.groups.length} groups.`);
      for (const g of result.groups) {
        lines.push(result.mode === 'table' ? `- "${g.label}": n = ${g.n}` : `- "${g.label}": n = ${g.n}, mean ${raw(g.mean)}, SD ${raw(g.sd)}, median ${raw(g.median)}`);
        add(`${g.label} n`, g.n, 'count');
        if (result.mode !== 'table') { add(`${g.label} mean`, g.mean); add(`${g.label} SD`, g.sd); add(`${g.label} median`, g.median); }
      }
      if (result.welch) {
        const w = result.welch;
        lines.push(`Welch t-test: t ${raw(w.t)}, df ${raw(w.df)}, p ${raw(w.p)}, mean difference ${raw(w.diff)} (95% CI ${raw(w.ciLow)} to ${raw(w.ciHigh)}), Cohen's d ${raw(w.cohenD)}, Hedges' g ${raw(w.hedgesG)}.`);
        for (const [k, v] of Object.entries(w)) add(`Welch ${k}`, v as number);
        const [a, b] = result.groups;
        if (a && b && b.mean !== 0) add('mean gap %', (Math.abs(a.mean - b.mean) / Math.min(Math.abs(a.mean), Math.abs(b.mean))) * 100, 'percent');
      }
      if (result.mannWhitney) {
        const m = result.mannWhitney;
        lines.push(`Mann–Whitney U ${raw(m.u)}, z ${raw(m.z)}, p ${raw(m.p)}, rank-biserial r ${raw(m.rankBiserial)}.`);
        for (const [k, v] of Object.entries(m)) add(`Mann–Whitney ${k}`, v as number);
      }
      if (result.anova) {
        const a = result.anova;
        lines.push(`One-way ANOVA: F ${raw(a.f)} on ${a.df1} and ${a.df2} df, p ${raw(a.p)}, η² ${raw(a.etaSq)}.`);
        for (const [k, v] of Object.entries(a)) add(`ANOVA ${k}`, v as number);
      }
      if (result.kruskal) {
        const k = result.kruskal;
        lines.push(`Kruskal–Wallis H ${raw(k.h)} on ${k.df} df, p ${raw(k.p)}, ε² ${raw(k.epsilonSq)}.`);
        for (const [key, v] of Object.entries(k)) add(`Kruskal–Wallis ${key}`, v as number);
      }
      if (result.table) {
        const { rows, cols, counts } = result.table;
        lines.push(`Counts (rows "${result.group}", columns "${result.outcome}"):`);
        rows.forEach((r, i) => {
          lines.push(`- "${r}": ${cols.map((c, j) => `"${c}" ${counts[i][j]}`).join(', ')}`);
          cols.forEach((c, j) => add(`${r} × ${c}`, counts[i][j], 'count'));
        });
      }
      if (result.chi) {
        const c = result.chi;
        lines.push(`Chi-square test of independence: χ² ${raw(c.chi2)} on ${c.df} df, p ${raw(c.p)}, Cramér's V ${raw(c.cramerV)}, n ${c.n}.`);
        add('χ²', c.chi2); add('χ² p', c.p); add("Cramér's V", c.cramerV); add('χ² df', c.df, 'count'); add('smallest expected count', c.minExpected);
      }
      if (result.prop) {
        const p = result.prop;
        lines.push(`Two-proportion z-test on "${result.outcome}" = "${p.success}": ${raw(p.p1)} vs ${raw(p.p2)}, z ${raw(p.z)}, p ${raw(p.p)}, difference 95% CI ${raw(p.ciLow)} to ${raw(p.ciHigh)}, Cohen's h ${raw(p.cohenH)}.`);
        add('rate 1', p.p1); add('rate 1 %', p.p1 * 100, 'percent'); add('rate 2', p.p2); add('rate 2 %', p.p2 * 100, 'percent');
        add('rate gap (points)', Math.abs(p.diff) * 100); add('z', p.z); add('z p', p.p); add('CI low', p.ciLow); add('CI high', p.ciHigh); add("Cohen's h", p.cohenH);
      }
      for (const w of result.warnings) lines.push(`Warning: ${w}`);
      lines.push(`App's sentence: ${result.sentence}`);
    } else {
      const m = result.moments;
      lines.push(`Column "${result.column}": n ${m.n}, mean ${raw(m.mean)}, SD ${raw(m.sd)}, median ${raw(m.median)}, min ${raw(m.min)}, max ${raw(m.max)}, skewness (adjusted G1) ${raw(m.skewness)}, excess kurtosis (G2) ${raw(m.kurtosis)}.`);
      add('n', m.n, 'count'); add('mean', m.mean); add('SD', m.sd); add('median', m.median); add('min', m.min); add('max', m.max);
      add('skewness', m.skewness); add('excess kurtosis', m.kurtosis);
      const t = result.normality;
      if (t) {
        lines.push(`${t.method === 'shapiro-wilk' ? 'Shapiro–Wilk W' : "D'Agostino–Pearson K²"} ${raw(t.statistic)}, p ${raw(t.p)}.`);
        add('normality statistic', t.statistic); add('normality p', t.p);
      }
      lines.push(`Histogram: ${result.histogram.labels.map((l, i) => `${l}: ${result.histogram.counts[i]}`).join('; ')}.`);
      result.histogram.counts.forEach((c, i) => add(`bin ${result.histogram.labels[i]}`, c, 'count'));
      lines.push(`App's sentence: ${result.sentence}`);
    }
    lines.push('');
  }
  const text = lines.join('\n');
  // Backstop, as in scorecardFacts: a digit in a column or level NAME (or in
  // the app's own sentence, rounded for reading) is printed but was computed
  // by nobody else, and must not read as invented.
  for (const h of harvestAppNumbers(text)) {
    if (!ledger.some((e) => Object.is(e.value, h.value))) {
      ledger.push({ label: 'figure printed in the facts block', value: h.value, unit: h.unit, source: 'stats' });
    }
  }
  return { text, ledger, provenance: { kind: 'dataset', name: datasetName, note: 'statistics app-computed' } };
}
