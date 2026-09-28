// Spec + vectors → a result — MAIN PROCESS, PURE. The one dispatcher between
// what the loaders read (src/engine/statsVectors.ts, resident or JS) and the
// maths in this folder. Runs identically on the main thread and in the
// compute worker, so a big run is the same code as a small one.

import type { StatsSpec } from './spec';
import { MAX_GROUPS } from './spec';
import { corrMatrix, correlate, completePairs, fitLine } from './correlation';
import type { CorrMatrix } from './correlation';
import { olsFit } from './regression';
import type { RegInput, RegressionOk } from './regression';
import { anova, chiSquare, describe, kruskal, mannWhitney, twoProportions, welch } from './groups';
import type { AnovaResult, ChiSquareResult, Describe, KruskalResult, MannWhitneyResult, TwoPropResult, WelchResult } from './groups';
import { histogram, moments, normality } from './distribution';
import type { Histogram, Moments, NormalityTest } from './distribution';
import {
  chiSquareSentence, correlationSentence, distributionSentence, manyGroupSentence,
  regressionSentence, twoGroupSentence, twoPropSentence,
} from './sentences';

export interface StatsVectors {
  /** Rows read, after any filters. */
  rows: number;
  number: Map<string, Array<number | null>>;
  label: Map<string, Array<string | null>>;
}

export interface GroupStat extends Describe {
  label: string;
}

export type StatsResult =
  | { ok: false; kind: StatsSpec['kind']; error: string }
  | { ok: true; kind: 'correlation'; rows: number; matrix: CorrMatrix }
  | { ok: true; kind: 'regression'; rows: number; fit: RegressionOk; sentence: string }
  | {
      ok: true; kind: 'groups'; rows: number; group: string; outcome: string;
      mode: 'two' | 'many' | 'table';
      /** Every level of the grouping column with its row count, largest first (≤ 200). */
      available: Array<{ level: string; n: number }>;
      groups: GroupStat[];
      welch?: WelchResult; mannWhitney?: MannWhitneyResult;
      anova?: AnovaResult; kruskal?: KruskalResult;
      table?: { rows: string[]; cols: string[]; counts: number[][] };
      chi?: ChiSquareResult; prop?: TwoPropResult & { success: string };
      sentence: string;
      warnings: string[];
    }
  | {
      ok: true; kind: 'distribution'; rows: number; column: string;
      moments: Moments; histogram: Histogram; normality: NormalityTest | null; sentence: string;
    };

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const fail = (kind: StatsSpec['kind'], error: string): StatsResult => ({ ok: false, kind, error });

export function runStats(spec: StatsSpec, v: StatsVectors): StatsResult {
  if (spec.kind === 'correlation') {
    const cols = spec.columns;
    const matrix = corrMatrix(cols, cols.map((c) => v.number.get(c) || []), spec.method || 'pearson');
    if (matrix.cells.every((row, i) => row.every((c, j) => i === j || c.r === null))) {
      return fail('correlation', 'Need at least 3 rows where both columns have a value.');
    }
    return { ok: true, kind: 'correlation', rows: v.rows, matrix };
  }
  if (spec.kind === 'regression') {
    const target = spec.target as string;
    const preds: RegInput[] = (spec.predictors || []).map((p) => (v.number.has(p)
      ? { name: p, kind: 'numeric', values: v.number.get(p) as Array<number | null> }
      : { name: p, kind: 'categorical', values: v.label.get(p) || [] }));
    const fit = olsFit(target, v.number.get(target) || [], preds);
    if (!fit.ok) return fail('regression', fit.error);
    return { ok: true, kind: 'regression', rows: v.rows, fit, sentence: regressionSentence(target, fit.r2, fit.adjR2, fit.f, fit.fP, fit.n) };
  }
  if (spec.kind === 'groups') return runGroups(spec, v);
  const column = spec.columns[0];
  const vals = (v.number.get(column) || []).filter((x): x is number => x !== null && Number.isFinite(x));
  if (vals.length < 3) return fail('distribution', `Need at least 3 values — “${column}” has ${vals.length}.`);
  const mo = moments(vals) as Moments;
  const test = normality(vals);
  return {
    ok: true, kind: 'distribution', rows: v.rows, column, moments: mo,
    histogram: histogram(vals, mo.mean, mo.sd), normality: test,
    sentence: distributionSentence(column, test, mo.n, mo.skewness),
  };
}

function runGroups(spec: StatsSpec, v: StatsVectors): StatsResult {
  const group = spec.group as string;
  const outcome = spec.outcome as string;
  const keys = v.label.get(group) || [];
  const numeric = v.number.has(outcome);
  const num = v.number.get(outcome) || [];
  const cat = v.label.get(outcome) || [];
  const present = (i: number): boolean => keys[i] !== null && (numeric ? num[i] !== null : cat[i] !== null);

  const counts = new Map<string, number>();
  for (let i = 0; i < keys.length; i++) if (present(i)) counts.set(keys[i] as string, (counts.get(keys[i] as string) || 0) + 1);
  const available = [...counts.entries()].map(([level, n]) => ({ level, n }))
    .sort((a, b) => b.n - a.n || byCode(a.level, b.level)).slice(0, 200);
  let levels = (spec.levels || []).filter((l) => counts.has(l));
  if (!levels.length) {
    if (counts.size > MAX_GROUPS) {
      return fail('groups', `“${group}” has ${counts.size.toLocaleString('en-US')} values. Pick up to ${MAX_GROUPS} groups to compare.`);
    }
    levels = available.map((a) => a.level);
  }
  if (levels.length < 2) return fail('groups', counts.size < 2 ? `“${group}” needs at least two groups with a value of “${outcome}”.` : 'Pick at least two groups.');
  const index = new Map(levels.map((l, i) => [l, i] as const));
  const warnings: string[] = [];

  if (numeric) {
    const vecs: number[][] = levels.map(() => []);
    for (let i = 0; i < keys.length; i++) {
      if (!present(i)) continue;
      const g = index.get(keys[i] as string);
      if (g !== undefined) vecs[g].push(num[i] as number);
    }
    const groups: GroupStat[] = levels.map((l, i) => ({ label: l, ...describe(vecs[i]) }));
    const small = groups.filter((g) => g.n < 2).map((g) => g.label);
    if (small.length) return fail('groups', `Each group needs at least 2 values — ${small.map((s) => `“${s}”`).join(', ')} ${small.length === 1 ? 'has' : 'have'} fewer.`);
    const base = { ok: true as const, kind: 'groups' as const, rows: v.rows, group, outcome, available, groups, warnings };
    if (levels.length === 2) {
      const w = welch(vecs[0], vecs[1]);
      const mw = mannWhitney(vecs[0], vecs[1]);
      if (!w || !mw) return fail('groups', `“${outcome}” does not vary within these groups, so there is nothing to test.`);
      return { ...base, mode: 'two', welch: w, mannWhitney: mw, sentence: twoGroupSentence(outcome, groups[0], groups[1], w.p) };
    }
    const a = anova(vecs);
    const kw = kruskal(vecs);
    if (!a || !kw) return fail('groups', `“${outcome}” does not vary within these groups, so there is nothing to test.`);
    return { ...base, mode: 'many', anova: a, kruskal: kw, sentence: manyGroupSentence(outcome, group, groups, a.p) };
  }

  // Categorical outcome: a groups × outcome-levels table of counts.
  const outLevels = [...new Set(cat.filter((c, i): c is string => c !== null && keys[i] !== null && index.has(keys[i] as string)))].sort(byCode);
  if (outLevels.length > MAX_GROUPS) return fail('groups', `“${outcome}” has ${outLevels.length} values — too many to tabulate (the limit is ${MAX_GROUPS}).`);
  if (outLevels.length < 2) return fail('groups', `“${outcome}” has only one value in these groups, so there is nothing to compare.`);
  const oi = new Map(outLevels.map((l, i) => [l, i] as const));
  const table = levels.map(() => new Array<number>(outLevels.length).fill(0));
  for (let i = 0; i < keys.length; i++) {
    if (!present(i)) continue;
    const g = index.get(keys[i] as string);
    if (g !== undefined) table[g][oi.get(cat[i] as string) as number] += 1;
  }
  const chi = chiSquare(table);
  if (!chi) return fail('groups', 'Every group and every outcome needs at least one row.');
  if (chi.lowExpected) warnings.push(`Some expected counts are below 5 (the smallest is ${chi.minExpected.toFixed(1)}), so the chi-square p-value is approximate.`);
  const groups: GroupStat[] = levels.map((l, i) => {
    const n = table[i].reduce((s, x) => s + x, 0);
    return { label: l, n, mean: NaN, sd: NaN, median: NaN };
  });
  const base = {
    ok: true as const, kind: 'groups' as const, rows: v.rows, group, outcome, available, groups, warnings,
    mode: 'table' as const, table: { rows: levels, cols: outLevels, counts: table }, chi,
  };
  if (levels.length === 2 && outLevels.length === 2) {
    const success = spec.success !== undefined && oi.has(spec.success) ? spec.success : outLevels[1];
    const s = oi.get(success) as number;
    const pr = twoProportions(table[0][s], groups[0].n, table[1][s], groups[1].n);
    if (pr) {
      return {
        ...base, prop: { ...pr, success },
        sentence: twoPropSentence(outcome, success, { label: levels[0], rate: pr.p1 }, { label: levels[1], rate: pr.p2 }, pr.p),
      };
    }
  }
  return { ...base, sentence: chiSquareSentence(outcome, group, chi.p, chi.cramerV) };
}

/** A pair's scatter for the workbench: ≤ 2,000 points evenly thinned, the fit line, the cell. */
export function pairScatter(xName: string, yName: string, x: Array<number | null>, y: Array<number | null>, method: 'pearson' | 'spearman') {
  const pr = completePairs(x, y);
  const n = pr.x.length;
  const step = Math.max(1, Math.ceil(n / 2000));
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < n; i += step) { px.push(pr.x[i]); py.push(pr.y[i]); }
  const cell = correlate(x, y, method);
  return {
    x: xName, y: yName, points: { x: px, y: py }, shown: px.length, n,
    fit: fitLine(x, y), cell,
    sentence: cell.r === null || cell.p === null ? '' : correlationSentence(xName, yName, cell.r, cell.p, cell.n, method),
  };
}
export type PairScatter = ReturnType<typeof pairScatter>;
