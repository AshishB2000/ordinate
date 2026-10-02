// A statistical result as a dashboard tile — MAIN PROCESS, PURE.
//
// Three shapes of one answer, all built from the computed result:
//   table    display strings (formatted here, deterministically) for the tile's
//            own <table>;
//   numeric  the same table as labels + NUMBER series — what an export or a
//            published site may carry through their whitelists
//            (dashboardExport.sanitizeChartData keeps finite numbers only);
//   chart    labels + series for an existing chart family (heatmap, bar,
//            column, clustered column), drawn by the ordinary chart renderer.

import type { StatsSpec } from './spec';
import type { StatsResult } from './run';
import { fmtCount, fmtPCell, fmtStat, stars } from './sentences';

export interface TileSeries {
  name: string;
  values: Array<number | null>;
}

export interface StatsTile {
  title: string;
  /** One line of fit statistics under the title ("R² 0.87 · F 123 · n 200"). */
  subtitle: string;
  sentence: string;
  table: { head: string[]; rows: string[][] };
  numeric: { labels: string[]; series: TileSeries[] };
  chart: { chartType: string; data: { labels: string[]; series: TileSeries[] } };
  warnings: string[];
}

const num = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function statsTitle(spec: StatsSpec): string {
  if (spec.kind === 'correlation') return `Correlation · ${spec.method === 'spearman' ? 'Spearman' : 'Pearson'}`;
  if (spec.kind === 'regression') return `Regression · ${spec.target || ''}`;
  if (spec.kind === 'groups') return `${spec.outcome || ''} by ${spec.group || ''}`;
  return `Distribution · ${spec.columns[0] || ''}`;
}

export function presentStats(spec: StatsSpec, res: StatsResult & { ok: true }): StatsTile {
  const title = statsTitle(spec);
  if (res.kind === 'correlation') {
    const { columns, cells } = res.matrix;
    const sym = res.matrix.method === 'spearman' ? 'ρ' : 'r';
    const series = columns.map((c, j) => ({ name: c, values: columns.map((_, i) => num(cells[i][j].r)) }));
    const ns = cells.flat().filter((c, k) => k % (columns.length + 1) !== 0).map((c) => c.n);
    return {
      title, subtitle: `${sym} per pair · n ${fmtCount(Math.min(...ns))}–${fmtCount(Math.max(...ns))}`, sentence: '', warnings: [],
      table: {
        head: ['', ...columns],
        rows: columns.map((c, i) => [c, ...columns.map((_, j) => (i === j ? '1' : cells[i][j].r === null ? '—' : `${(cells[i][j].r as number).toFixed(2)}${stars(cells[i][j].p)}`))]),
      },
      numeric: { labels: columns, series },
      chart: { chartType: 'heatmap', data: { labels: columns, series } },
    };
  }
  if (res.kind === 'regression') {
    const f = res.fit;
    const terms = f.terms;
    return {
      title,
      subtitle: `R² ${f.r2.toFixed(3)} · adj. ${f.adjR2.toFixed(3)} · F ${fmtStat(f.f)} (p ${fmtPCell(f.fP)}) · n ${fmtCount(f.n)}`,
      sentence: res.sentence, warnings: [],
      table: {
        head: ['Term', 'Estimate', 'Std. error', 't', 'p', '95% CI'],
        rows: terms.map((t) => [t.name, fmtStat(t.estimate), fmtStat(t.se), fmtStat(t.t), `${fmtPCell(t.p)} ${stars(t.p)}`.trim(), `${fmtStat(t.ciLow)} to ${fmtStat(t.ciHigh)}`]),
      },
      numeric: {
        labels: terms.map((t) => t.name),
        series: [
          { name: 'Estimate', values: terms.map((t) => num(t.estimate)) },
          { name: 'Std. error', values: terms.map((t) => num(t.se)) },
          { name: 't', values: terms.map((t) => num(t.t)) },
          { name: 'p', values: terms.map((t) => num(t.p)) },
          { name: 'CI low', values: terms.map((t) => num(t.ciLow)) },
          { name: 'CI high', values: terms.map((t) => num(t.ciHigh)) },
        ],
      },
      chart: {
        chartType: 'bar',
        data: { labels: terms.slice(1).map((t) => t.name), series: [{ name: 'Coefficient', values: terms.slice(1).map((t) => num(t.estimate)) }] },
      },
    };
  }
  if (res.kind === 'groups') {
    if (res.mode === 'table' && res.table) {
      const { rows, cols, counts } = res.table;
      const series = cols.map((c, j) => ({ name: c, values: rows.map((_, i) => counts[i][j]) }));
      const test = res.prop ? `z ${fmtStat(res.prop.z)} · p ${fmtPCell(res.prop.p)}` : `χ² ${fmtStat(res.chi?.chi2)} · p ${fmtPCell(res.chi?.p ?? null)}`;
      return {
        title, subtitle: `${test} · Cramér's V ${(res.chi?.cramerV ?? 0).toFixed(2)} · n ${fmtCount(res.chi?.n ?? 0)}`,
        sentence: res.sentence, warnings: res.warnings,
        table: { head: [res.group, ...cols, 'n'], rows: rows.map((r, i) => [r, ...counts[i].map(fmtCount), fmtCount(counts[i].reduce((s, x) => s + x, 0))]) },
        numeric: { labels: rows, series },
        chart: { chartType: 'clustered_column', data: { labels: rows, series } },
      };
    }
    const g = res.groups;
    const test = res.welch
      ? `Welch t ${fmtStat(res.welch.t)} · p ${fmtPCell(res.welch.p)} · Mann–Whitney p ${fmtPCell(res.mannWhitney?.p ?? null)}`
      : `ANOVA F ${fmtStat(res.anova?.f)} · p ${fmtPCell(res.anova?.p ?? null)} · Kruskal–Wallis p ${fmtPCell(res.kruskal?.p ?? null)}`;
    return {
      title, subtitle: test, sentence: res.sentence, warnings: res.warnings,
      table: { head: [res.group, 'n', 'Mean', 'SD', 'Median'], rows: g.map((x) => [x.label, fmtCount(x.n), fmtStat(x.mean), fmtStat(x.sd), fmtStat(x.median)]) },
      numeric: {
        labels: g.map((x) => x.label),
        series: [
          { name: 'n', values: g.map((x) => x.n) },
          { name: 'Mean', values: g.map((x) => num(x.mean)) },
          { name: 'SD', values: g.map((x) => num(x.sd)) },
          { name: 'Median', values: g.map((x) => num(x.median)) },
        ],
      },
      chart: { chartType: 'column', data: { labels: g.map((x) => x.label), series: [{ name: `Mean ${res.outcome}`, values: g.map((x) => num(x.mean)) }] } },
    };
  }
  const m = res.moments;
  const t = res.normality;
  const rows: Array<[string, number | null, string]> = [
    ['n', m.n, fmtCount(m.n)], ['Mean', m.mean, fmtStat(m.mean)], ['SD', m.sd, fmtStat(m.sd)], ['Median', m.median, fmtStat(m.median)],
    ['Min', m.min, fmtStat(m.min)], ['Max', m.max, fmtStat(m.max)],
    ['Skewness', m.skewness, fmtStat(m.skewness)], ['Excess kurtosis', m.kurtosis, fmtStat(m.kurtosis)],
  ];
  if (t) {
    rows.push([t.method === 'shapiro-wilk' ? 'Shapiro–Wilk W' : "D'Agostino K²", t.statistic, t.method === 'shapiro-wilk' ? t.statistic.toFixed(4) : fmtStat(t.statistic)]);
    rows.push(['Normality p', t.p, fmtPCell(t.p)]);
  }
  return {
    title, subtitle: t ? `${t.method === 'shapiro-wilk' ? 'Shapiro–Wilk' : "D'Agostino"} p ${fmtPCell(t.p)} · n ${fmtCount(m.n)}` : `n ${fmtCount(m.n)}`,
    sentence: res.sentence, warnings: [],
    table: { head: ['Statistic', 'Value'], rows: rows.map((r) => [r[0], r[2]]) },
    numeric: { labels: rows.map((r) => r[0]), series: [{ name: 'Value', values: rows.map((r) => num(r[1])) }] },
    chart: { chartType: 'column', data: { labels: res.histogram.labels, series: [{ name: 'Count', values: res.histogram.counts }] } },
  };
}
