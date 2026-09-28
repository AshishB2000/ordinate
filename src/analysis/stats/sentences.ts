// The app's own plain sentences about a statistical result — MAIN PROCESS,
// PURE and DETERMINISTIC. No model writes these: each one is a template filled
// with figures the workbench computed, rounded for reading. The Assistant gets
// the unrounded figures separately, in the fact ledger (src/ai/statsFacts.ts).
//
// Conventions, in one place so every sentence reads alike:
//   p      "p < 0.001" below 0.001, "p > 0.999" above 0.999, else three
//          decimals — "p = 0.003".
//   alpha  a difference or association is called significant at p < 0.05.
//   words  |r| ≥ 0.7 strong, ≥ 0.5 moderate, ≥ 0.3 weak, ≥ 0.1 very weak;
//          Cramér's V ≥ 0.5 strong, ≥ 0.3 moderate, ≥ 0.1 weak.

import { corrStrength } from './correlation';

export const ALPHA = 0.05;

export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return 'p = n/a';
  if (p < 0.001) return 'p < 0.001';
  if (p > 0.999) return 'p > 0.999';
  return 'p = ' + p.toFixed(3);
}

/** A p-value for a table cell: "<0.001", "0.003". */
export function fmtPCell(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '—';
  if (p < 0.001) return '<0.001';
  if (p > 0.999) return '>0.999';
  return p.toFixed(3);
}

/** Significance marks: *** < 0.001, ** < 0.01, * < 0.05, · < 0.1. */
export function stars(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '';
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  if (p < 0.1) return '·';
  return '';
}

const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** A statistic for reading: magnitude-aware decimals, thousands separated. */
export function fmtStat(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
  const a = Math.abs(v);
  if (a >= 1e15 || (a > 0 && a < 1e-4)) return v.toExponential(2);
  if (a >= 1000) return GROUPED.format(v);
  const digits = a >= 100 ? 1 : a >= 1 ? 2 : 3;
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(v);
}

/** A count: "1,234". */
export function fmtCount(n: number): string {
  return GROUPED.format(n);
}

const pct1 = (v: number): string => v.toFixed(1) + '%';
const poss = (label: string): string => `${label}'s`;
const verdict = (p: number): string => (p < ALPHA ? `the difference is significant (${fmtP(p)})` : `the difference is not significant (${fmtP(p)})`);

/** Two groups, numeric outcome — the higher mean is named first. */
export function twoGroupSentence(outcome: string, a: { label: string; mean: number }, b: { label: string; mean: number }, p: number): string {
  if (a.mean === b.mean) return `${a.label} and ${b.label} have the same average ${outcome} (${fmtStat(a.mean)}); ${verdict(p)}.`;
  const [hi, lo] = a.mean > b.mean ? [a, b] : [b, a];
  if (lo.mean > 0) {
    return `${poss(hi.label)} average ${outcome} is ${pct1(((hi.mean - lo.mean) / lo.mean) * 100)} higher than ${poss(lo.label)}; ${verdict(p)}.`;
  }
  return `${poss(hi.label)} average ${outcome} is ${fmtStat(hi.mean - lo.mean)} higher than ${poss(lo.label)} (${fmtStat(hi.mean)} against ${fmtStat(lo.mean)}); ${verdict(p)}.`;
}

/** Three or more groups, numeric outcome. */
export function manyGroupSentence(outcome: string, group: string, groups: Array<{ label: string; mean: number }>, p: number): string {
  const k = groups.length;
  if (p >= ALPHA) return `Average ${outcome} does not differ significantly across the ${k} ${group} groups (${fmtP(p)}).`;
  let top = groups[0];
  let bottom = groups[0];
  for (const g of groups) {
    if (g.mean > top.mean) top = g;
    if (g.mean < bottom.mean) bottom = g;
  }
  return `Average ${outcome} differs significantly across the ${k} ${group} groups (${fmtP(p)}): ${top.label} is highest at ${fmtStat(top.mean)} and ${bottom.label} lowest at ${fmtStat(bottom.mean)}.`;
}

export function cramerWord(v: number): string {
  if (v >= 0.5) return 'strong';
  if (v >= 0.3) return 'moderate';
  if (v >= 0.1) return 'weak';
  return 'negligible';
}

export function chiSquareSentence(outcome: string, group: string, p: number, v: number): string {
  if (p >= ALPHA) return `${outcome} and ${group} show no significant association (${fmtP(p)}, Cramér's V = ${v.toFixed(2)}).`;
  return `${outcome} and ${group} are associated (${fmtP(p)}); Cramér's V = ${v.toFixed(2)}, a ${cramerWord(v)} association.`;
}

export function twoPropSentence(outcome: string, success: string, a: { label: string; rate: number }, b: { label: string; rate: number }, p: number): string {
  const [hi, lo] = a.rate >= b.rate ? [a, b] : [b, a];
  const gap = (hi.rate - lo.rate) * 100;
  return `${poss(hi.label)} rate of ${outcome} = ${success} is ${pct1(hi.rate * 100)} against ${poss(lo.label)} ${pct1(lo.rate * 100)}; the gap of ${gap.toFixed(1)} points is ${p < ALPHA ? 'significant' : 'not significant'} (${fmtP(p)}).`;
}

export function correlationSentence(x: string, y: string, r: number, p: number, n: number, method: 'pearson' | 'spearman'): string {
  const dir = r > 0 ? 'positive' : r < 0 ? 'negative' : 'zero';
  const sym = method === 'spearman' ? 'ρ' : 'r';
  const word = corrStrength(r);
  const sig = p < ALPHA ? '' : ' that is not significant';
  return `${x} and ${y} have a ${word} ${dir} ${method === 'spearman' ? 'rank ' : ''}correlation${sig} (${sym} = ${r.toFixed(2)}, ${fmtP(p)}, n = ${fmtCount(n)}).`;
}

export function regressionSentence(target: string, r2: number, adjR2: number, f: number, p: number, n: number): string {
  return `The model explains ${pct1(r2 * 100)} of the variance in ${target} (R² = ${r2.toFixed(3)}, adjusted ${adjR2.toFixed(3)}; F = ${fmtStat(f)}, ${fmtP(p)}; n = ${fmtCount(n)}).`;
}

export function skewWord(g1: number | null): string {
  if (g1 === null) return '';
  if (Math.abs(g1) < 0.5) return 'roughly symmetric';
  return g1 > 0 ? 'right-skewed' : 'left-skewed';
}

export function distributionSentence(column: string, test: { method: string; statistic: number; p: number } | null, n: number, skew: number | null): string {
  const shape = skew === null ? '' : `; it is ${skewWord(skew)} (skewness ${skew.toFixed(2)})`;
  if (!test) return `${column} has ${fmtCount(n)} values${shape}.`;
  const name = test.method === 'shapiro-wilk' ? `Shapiro–Wilk W = ${test.statistic.toFixed(3)}` : `D'Agostino K² = ${fmtStat(test.statistic)}`;
  const verdictText = test.p < ALPHA ? 'is not normally distributed' : 'is consistent with a normal distribution';
  return `${column} ${verdictText} (${name}, ${fmtP(test.p)}, n = ${fmtCount(n)})${shape}.`;
}
