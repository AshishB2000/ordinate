// Compare groups and Distribution (statsViewsGroups.ts). Formatting only:
// every test statistic, p, effect size, group total and cross-tab share is
// the server's (src/analysis/stats + stats/figures.ts).

import { useMemo, type ReactNode } from 'react';
import { Chart } from '../../../charts/Chart';
import { Figure, Plot, axes } from '../Plot';
import type { DistributionResult, GroupsResult, StatsFigures } from '../api';
import { fmtCount, fmtFixed, fmtP, fmtStat } from '../format';
import { ResultHead, Sentence, SimpleTable, StatRow, TestCard, Warnings } from './StatsParts';
import s from './Stats.module.css';

/** A share (0–1) as a percent to one place, as the desktop wrote it. */
const pct1 = (v: number) => `${(v * 100).toFixed(1)}`;

function MeansBar({ outcome, groups }: { outcome: string; groups: GroupsResult['groups'] }) {
  const data = useMemo(() => ({ labels: groups.map((g) => g.label), series: [{ name: `Mean ${outcome}`, values: groups.map((g) => g.mean) }] }), [groups, outcome]);
  return (
    <Figure title={`Average ${outcome} by group`}>
      <Chart type="column" data={data} label={`Average ${outcome} by group`} />
    </Figure>
  );
}

export function GroupsView({ r, figures, actions }: { r: GroupsResult; figures: StatsFigures; actions: ReactNode }) {
  const tests =
    r.mode === 'two'
      ? "Welch's t-test and Mann–Whitney U"
      : r.mode === 'many'
        ? 'One-way ANOVA and Kruskal–Wallis'
        : r.prop
          ? 'Two-proportion z-test and chi-square'
          : 'Chi-square test of independence';
  const cards: ReactNode[] = [];
  if (r.mode === 'two' && r.welch && r.mannWhitney) {
    const w = r.welch;
    const [a, b] = r.groups;
    cards.push(
      <TestCard
        key="welch"
        title="Welch's t-test"
        p={w.p}
        rows={[
          ['t', fmtStat(w.t)],
          ['df', fmtStat(w.df)],
          ['p', fmtP(w.p)],
          [`Mean difference (${a.label} − ${b.label})`, fmtStat(w.diff)],
          ['95% CI', `${fmtStat(w.ciLow)} to ${fmtStat(w.ciHigh)}`],
          ["Cohen's d", fmtStat(w.cohenD)],
          ["Hedges' g", fmtStat(w.hedgesG)],
        ]}
        note="Does not assume equal variances."
      />,
    );
    const m = r.mannWhitney;
    cards.push(
      <TestCard
        key="mw"
        title="Mann–Whitney U"
        p={m.p}
        rows={[['U', fmtStat(m.u)], ['z', fmtStat(m.z)], ['p', fmtP(m.p)], ['Rank-biserial r', fmtStat(m.rankBiserial)]]}
        note="Rank-based: no normality assumption. Normal approximation with tie and continuity corrections."
      />,
    );
  } else if (r.mode === 'many' && r.anova && r.kruskal) {
    const an = r.anova;
    cards.push(
      <TestCard
        key="anova"
        title="One-way ANOVA"
        p={an.p}
        rows={[['F', fmtStat(an.f)], ['df', `${an.df1}, ${fmtCount(an.df2)}`], ['p', fmtP(an.p)], ['η²', fmtStat(an.etaSq)]]}
        note="Assumes similar spread in every group."
      />,
    );
    const kw = r.kruskal;
    cards.push(
      <TestCard
        key="kw"
        title="Kruskal–Wallis"
        p={kw.p}
        rows={[['H', fmtStat(kw.h)], ['df', String(kw.df)], ['p', fmtP(kw.p)], ['ε²', fmtStat(kw.epsilonSq)]]}
        note="Rank-based, with the tie correction."
      />,
    );
  } else {
    if (r.prop && r.table) {
      const p = r.prop;
      const [a, b] = r.table.rows;
      cards.push(
        <TestCard
          key="prop"
          title="Two-proportion z-test"
          p={p.p}
          rows={[
            [`${a}: share ${p.success}`, `${pct1(p.p1)}%`],
            [`${b}: share ${p.success}`, `${pct1(p.p2)}%`],
            ['Difference', `${pct1(p.diff)} points`],
            ['95% CI', `${pct1(p.ciLow)} to ${pct1(p.ciHigh)} points`],
            ['z', fmtStat(p.z)],
            ['p', fmtP(p.p)],
            ["Cohen's h", fmtStat(p.cohenH)],
          ]}
        />,
      );
    }
    if (r.chi) {
      const c = r.chi;
      cards.push(
        <TestCard
          key="chi"
          title="Chi-square test of independence"
          p={c.p}
          rows={[['χ²', fmtStat(c.chi2)], ['df', String(c.df)], ['p', fmtP(c.p)], ["Cramér's V", fmtStat(c.cramerV)], ['n', fmtCount(c.n)]]}
          note="Without continuity correction."
        />,
      );
    }
  }
  return (
    <>
      <ResultHead title={`${r.outcome} by ${r.group}`} meta={`${tests} · ${r.groups.length} groups · n = ${fmtCount(figures.total ?? 0)}`}>
        {actions}
      </ResultHead>
      <Sentence text={r.sentence} />
      <Warnings list={r.warnings} />
      <div className={s.cards}>{cards}</div>
      {r.mode === 'table' && r.table ? (
        <SimpleTable
          caption="Counts"
          head={[r.group, ...r.table.cols, 'Total']}
          rows={r.table.rows.map((row, i) => [
            row,
            ...(r.table as NonNullable<GroupsResult['table']>).counts[i].map((x, j) => `${fmtCount(x)} (${((figures.rowShares?.[i]?.[j] ?? 0) * 100).toFixed(0)}%)`),
            fmtCount(figures.rowTotals?.[i] ?? 0),
          ])}
        />
      ) : (
        <div className={s.split}>
          <SimpleTable
            caption="Groups"
            head={[r.group, 'n', 'Mean', 'SD', 'Median']}
            rows={r.groups.map((g) => [g.label, fmtCount(g.n), fmtStat(g.mean), fmtStat(g.sd), fmtStat(g.median)])}
          />
          <MeansBar outcome={r.outcome} groups={r.groups} />
        </div>
      )}
    </>
  );
}

export function DistributionView({ r, actions }: { r: DistributionResult; actions: ReactNode }) {
  const m = r.moments;
  const tv = r.normality;
  const name = tv ? (tv.method === 'shapiro-wilk' ? 'Shapiro–Wilk' : "D'Agostino–Pearson K²") : 'no normality test';
  const h = r.histogram;
  return (
    <>
      <ResultHead title={`Distribution of ${r.column}`} meta={`${fmtCount(m.n)} values · ${name}`}>
        {actions}
      </ResultHead>
      <Sentence text={r.sentence} />
      <StatRow
        items={[
          ['n', fmtCount(m.n)],
          ['Mean', fmtStat(m.mean)],
          ['SD', fmtStat(m.sd)],
          ['Median', fmtStat(m.median)],
          ['Min', fmtStat(m.min)],
          ['Max', fmtStat(m.max)],
          ['Skewness', fmtStat(m.skewness), 'adjusted G1'],
          ['Excess kurtosis', fmtStat(m.kurtosis), 'G2, normal = 0'],
        ]}
      />
      <div className={`${s.split} ${s.splitWide}`}>
        <Figure title={`Distribution of ${r.column}`} note="Bars are counts; the line is a normal curve with the same mean and SD" tall>
          <Plot
            label={`Distribution of ${r.column}`}
            deps={[h]}
            config={(th) => ({
              type: 'bar',
              data: {
                labels: h.labels,
                datasets: [
                  { type: 'bar', label: 'Count', data: h.counts, backgroundColor: th.c1, borderRadius: 3, barPercentage: 0.96, categoryPercentage: 0.96, order: 2 },
                  { type: 'line', label: 'Normal curve', data: h.normal, borderColor: th.line, borderWidth: 2, pointRadius: 0, tension: 0.35, order: 1 },
                ],
              },
              options: {
                scales: axes(th, r.column, 'Count', false),
                plugins: { legend: { display: true, labels: { color: th.muted, boxWidth: 12, font: { size: 11 } } } },
              },
            })}
          />
        </Figure>
        <div className={`${s.cards} ${s.cardsStack}`}>
          {tv && (
            <TestCard
              title={tv.method === 'shapiro-wilk' ? 'Shapiro–Wilk test' : "D'Agostino–Pearson test"}
              p={tv.p}
              rows={
                tv.method === 'shapiro-wilk'
                  ? [['W', fmtFixed(tv.statistic, 4)], ['p', fmtP(tv.p)], ['n', fmtCount(m.n)]]
                  : [['K²', fmtStat(tv.statistic)], ['z (skewness)', fmtStat(tv.zSkew)], ['z (kurtosis)', fmtStat(tv.zKurt)], ['p', fmtP(tv.p)], ['n', fmtCount(m.n)]]
              }
              note={
                tv.method === 'shapiro-wilk'
                  ? 'Royston (1995), for 3 to 5,000 values. A small p means the data are unlikely to be normal.'
                  : "Above 5,000 values: D'Agostino's skewness and Anscombe–Glynn's kurtosis tests combined."
              }
            />
          )}
        </div>
      </div>
    </>
  );
}
