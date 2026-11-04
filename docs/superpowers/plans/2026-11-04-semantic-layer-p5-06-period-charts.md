# Semantic layer part 5, step 06: period metrics on charts — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A period metric charts so that every point equals its tile (D10): by its own date, one resolution per bucket (at most 24, owner's answer 3); by anything else, one chart-door call over the rewritten scope (two for a compare, paired by label). The per-bucket loop is a reusable helper that funnel metrics (step 08) and target series (step 10) draw with.
**Architecture:** Part 1's chart planner (`planMetricMeasures`, `src/analysis/metricMeasures.ts`, as step 03 of part 1 left it) gains one more outcome, `special`, for a measure whose metric is a period (here) or funnel (step 08) kind; part 1's `followMetricMeasures` (`src/ipc/vizMetricMeasures.ts`) sends it to `periodChartData` (`src/ipc/periodChart.ts`). `src/ipc/visuals.ts` is untouched: its planner line already routes every plan to `followMetricMeasures`. The date-axis path is `bucketSeries` (`src/ipc/metricBuckets.ts`): ask the door for the axis once, fill the gaps (`src/analysis/periodBuckets.ts`, pure), then resolve the tile once per bucket with the bucket's range as the scope.
**Tech Stack:** `src/analysis`, `src/ipc`, self-checks, the Live route harness.
**Spec:** docs/semantic-layer/05-metrics-depth.md (D10 second and third bullets, additivity bullet; Tests "Period") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p5-00-index.md
**Branch and PR:** `feat/semantic-p5-06-period-charts` off `origin/develop` after step 05 merges. Release 5B. No new stored field.

## Decisions made here (the spec left them to the builder)

- **Gap-filled buckets, any calendar:** the axis labels come from the door (so the grain, the auto grain and week-calendar labels are the plain chart's); the gaps between the first and the last are filled by walking day by day and labelling each day the way the axis does (`categoryKey.dateBucketLabel(dateBucket(...))`, `:128-150`, which already follows the active week calendar). `resolveMetricSeries`'s `periodPlan` is not used: it rolls up past 24 raw periods and filters by label, not by range.
- **A bucket's scope** is the chart's scope with its range on the date column replaced by (bucket range ∩ scope range), through `withRange` (`periodScope.ts:85`). A period metric then caps scope end at today (step 05), so the bucket holding today ends today.
- **A period or funnel measure charts alone** (one measure, no series split, no small multiples, no pivot). The spec allows mixing only through labels it pairs; a split would need one resolution per bucket per series. Refused with a sentence, named in Review Focus.
- **Concurrency:** at most 4 bucket resolutions at once (a small loop; no new dependency). Each is a KPI-door call, cached by its scope.

## Global Constraints

- Each point is `Object.is` its bucket's tile: `resolveMetric(P, id, { filters: bucketScope })`.
- 24 buckets at most (`SERIES_MAX_POINTS`, `src/ipc/metrics.ts:63`); a 25th refuses with `periodTooManyBuckets(name, n)`, which names the Moving sum calculation (`CALC_KIND_NAMES.moving_sum`, `tableCalc.ts:111`).
- A chart with no period measure is byte-identical (golden fixtures, `test-chartsFollowMetric`).
- Additivity (part 1's `additivityOf`, `src/analysis/additivity.ts`): a window adds across categories as its base does and never across time; a compare adds across neither. Formulas over a period metric are refused on charts with a sentence and the comment `// shortcut: metricMeasures cannot plan a period operand; plan one when formula charts over period metrics are asked for`.
- Live: one statement per bucket, each counted against `LIVE_DAILY_QUERY_LIMIT`, plus the axis probe; never `getDataset`.
- Sentences in `src/analysis/metricCheckMessages.ts`, then `node scripts/i18n-extract.js`. `src/ipc/visuals.ts` gets no line.
- Commits carry no Co-Authored-By or AI trailer.

## Review Focus

- **Refused, not guessed:** a period measure with a second measure, a series, facets, a pivot, or a date axis on another date column than its base's. Pinned in Task 2.
- **"Other" and missing labels on a compare** give null, since the two "Other"s fold different categories. Pinned in Task 2.
- **The sparkline** (step 05 returned none) now draws through `bucketSeries` at month grain, last 12 buckets. Pinned in Task 3.
- **Restricted viewers** are refused any chart with a metric measure (part 1, `rowDoors.reachesOther`), unchanged.

---

### Task 1: Buckets, pure, and the per-bucket loop

**Files:** Create `src/analysis/periodBuckets.ts`, `src/ipc/metricBuckets.ts`, `scripts/test-periodCharts.ts` (harness: step 05's `scripts/test-periodMetrics.ts`, same `SALES` fixture and `ORDINATE_TODAY=2024-11-03`).
**Interfaces:** Produces
```ts
// periodBuckets.ts
export function bucketRange(label: string, grain: DateGrain): { from: string; to: string } | null
  // gregorian: 'YYYY' | 'YYYY-Qn' | 'YYYY-MM' | 'YYYY-MM-DD' (a week names its Monday); under activeWeekCal(): weekLabelRange (retailCalendar.ts:232)
export function fillBuckets(labels: readonly string[], grain: DateGrain): string[]   // first to last, every bucket, in order
// metricBuckets.ts
export interface BucketSeries { ok: true; labels: string[]; values: (number | null)[]; grain: DateGrain }
export async function bucketSeries(
  projectId: string, datasetId: string, dateColumn: string, grain: DateGrain | undefined, filters: FilterStep[],
  figure: (bucketScope: FilterStep[], label: string) => Promise<number | null>, opts?: { params?: ParamValues; name: string },
): Promise<BucketSeries | { ok: false; error: string; code?: string; reason?: string }>
```
`bucketSeries`: (1) `vizDataFor(projectId, datasetId, { category: dateColumn, grain, values: [{ column: dateColumn, aggregation: 'count' }] }, filters, { params })` for the labels and grain (a refusal passes through, typed); (2) `fillBuckets`; more than 24 → `{ ok: false, error: msg.periodTooManyBuckets(opts.name, n) }`; (3) each bucket's scope is `withRange(filters, dateColumn, intersect(bucketRange, scopeRange), types)`, then `figure(...)`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  for (const g of ['day', 'week', 'month', 'quarter', 'year'] as const) {
    const label = dateBucketLabel(dateBucket(parseDateCell('2024-02-29')!, g), g);
    ok(`bucketRange inverts the axis label: ${g}`, bucketRange(label, g)!.from <= '2024-02-29' && bucketRange(label, g)!.to >= '2024-02-29' && dateBucketLabel(dateBucket(parseDateCell(bucketRange(label, g)!.to)!, g), g) === label);
  }
  ok('fillBuckets fills a gap', same(fillBuckets(['2024-01', '2024-04'], 'month'), ['2024-01', '2024-02', '2024-03', '2024-04']));
  withWeekCal('445', () => ok('fillBuckets under a week calendar uses its periods', fillBuckets([FIRST_445_LABEL, THIRD_445_LABEL], 'month').length === 3));
  const s = await bucketSeries(P, D, 'day', 'month', [Y2024], (f) => kpi(REV, f), { name: 'Revenue' });
  ok('each bucket is the tile over that month', s.ok && s.labels.every((l, i) => Object.is(s.values[i], kpiSync(REV, [ON(bucketRange(l, 'month')!.from, min(bucketRange(l, 'month')!.to, '2024-12-31'))]))));
  ok('a month with no rows is a bucket, not skipped', s.ok && s.labels.includes(GAP_MONTH));
  ok('25 buckets are refused, naming the Moving sum', (await bucketSeries(P, D, 'day', 'day', [ON('2024-01-01', '2024-01-25')], ..., { name: 'Revenue 7d' })).error === msg.periodTooManyBuckets('Revenue 7d', 25));
  ok('NEGATIVE CONTROL: 24 are drawn', (await bucketSeries(P, D, 'day', 'day', [ON('2024-01-01', '2024-01-24')], ..., { name: 'x' })).ok === true);
  ```
  The fixture drops every row of `GAP_MONTH` (2024-06) so the gap is real.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-periodCharts.js` → module not found.
- [ ] **Step 3: Implement** to the signatures. Sentence: `` `${name} by ${grain} needs ${n} points, and a period metric charts at most 24. Use a coarser date, or chart its base with a Moving sum calculation.` ``
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-periodCharts.js scripts/test-dateIntel.js scripts/test-i18n.js`.
- [ ] **Step 5: Commit.** `git add src/analysis/periodBuckets.ts src/ipc/metricBuckets.ts src/analysis/metricCheckMessages.ts src/i18n scripts/test-periodCharts.ts && git commit -m "Resolve a metric once per date bucket, gaps included, at most 24"`

### Task 2: A period measure on a chart

**Files:** Create `src/ipc/periodChart.ts`. Modify `src/analysis/metricMeasures.ts` (`PlanResult` gains `special`; the planner returns it, or refuses), `src/ipc/vizMetricMeasures.ts` (`followMetricMeasures` dispatches `special.kind === 'period'`), `src/analysis/additivity.ts` (`additivityOf` for a period definition), `src/analysis/pendingKinds.ts` (a period measure is no longer pending on a chart), `src/analysis/metricCheckMessages.ts`. Test: `scripts/test-periodCharts.ts`, section "chart".
**Interfaces:** Produces
```ts
// metricMeasures.ts — part 1's PlanResult, one more field on the ok branch
special?: { kind: 'period' | 'funnel'; metric: Metric }
// periodChart.ts
export async function periodChartData(projectId: string, datasetId: string, metric: Metric & { definition: MetricPeriodDefinition }, encoding: VizEncoding, filters: FilterStep[], opts: VizOpts): Promise<VizDataReply>
// metricCheckMessages.ts
measureChartsAlone(name: string): string                // "“{name}” is charted on its own: one measure, no split, no small multiples."
periodOtherDate(name: string, date: string, category: string): string  // "“{name}” counts by {date}, so it can be charted by {date} or by something that is not a date, not by {category}."
periodInChartFormula(name: string): string              // "A formula over “{name}” can't be charted yet. Show it on a tile."
```
- **Date axis on the base's date:** `bucketSeries(..., (f) => resolveMetric(P, metric.id, { filters: f, params }).value)`; the reply is `{ ok: true, data: { labels, series: [{ name: metric.name, values }] }, category: { kind: 'date', grain } }`.
- **Any other axis:** the base as a measure (`{ column, aggregation, metricId: base.id }`, so part 1's follow applies its filters) through `vizDataFor` on `windowedScope(...)`; with a compare, a second `vizDataFor` on `compareScope(...).filters`, values paired by label with `periodValue`, null for a label the prior lacks and for "Other". The first reply's warnings, notes and `recommendedShape` pass through.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const M = (m: Metric) => ({ column: 'amount', aggregation: 'sum', metricId: m.id });
  const byMonth = await chart({ category: 'day', grain: 'month', values: [M(ytd)] }, [Y2024]);
  ok('YTD by month: each point is its month\'s tile', byMonth.ok && byMonth.data.labels.every((l, i) => Object.is(byMonth.data.series[0].values[i], tileUnder(ytd, l))));
  ok('October\'s point is the tile under an October control', Object.is(pointAt(byMonth, '2024-10'), await kpi(ytd, [{ ...ON_OCT, fromControl: true }])));
  const fy = await withCalendar({ weekStart: 1, fiscalYearStart: 4 }, () => chart({ category: 'day', grain: 'month', values: [M(ytd)] }, [Y2024]));
  ok('NEGATIVE CONTROL: under a fiscal year from April, January is not a running total starting in January (approach C\'s bug)', !Object.is(pointAt(fy, '2024-01'), pointAt(await chart({ category: 'day', grain: 'month', values: [M(rev)] }, [Y2024]), '2024-01')));
  const byRegion = await chart({ category: 'region', values: [M(yoy)] }, [OCT]);
  ok('% change by region pairs the two scopes by label', byRegion.ok && byRegion.data.labels.every((l, i) => Object.is(byRegion.data.series[0].values[i], await kpi(yoy, [OCT, eq('region', l)]))));
  ok('a region missing last year is null', valueAt(byRegion, 'New') === null);
  ok('Live: same points, never hydrated, one statement per bucket plus the axis', liveSame && !hydrated && statements <= 24 + 1);
  for (const [enc, err] of [[{ category: 'day', grain: 'month', values: [M(ytd), M(rev)] }, msg.measureChartsAlone('Revenue YTD')], [{ category: 'day', grain: 'month', series: 'region', values: [M(ytd)] }, msg.measureChartsAlone('Revenue YTD')], [{ category: 'ship', grain: 'month', values: [M(ytd)] }, msg.periodOtherDate('Revenue YTD', 'day', 'ship')], [{ category: 'region', values: [M(formulaOverYtd)] }, msg.periodInChartFormula('Revenue YTD')]] as const)
    ok(`refused: ${err}`, (await chart(enc, [])).error === err);
  ok('running total along months over YTD is refused (not additive over time)', (await chart({ category: 'day', grain: 'month', values: [{ ...M(ytd), calc: RT }] }, [Y2024])).code === 'calc_not_additive');
  ok('share of total across regions over YTD is allowed (its base adds across categories)', (await chart({ category: 'region', values: [{ ...M(ytd), calc: { kind: 'pct_of_total', along: 'across' } }] }, [OCT])).ok === true);
  ok('NEGATIVE CONTROL: a plain metric chart is byte-identical', JSON.stringify(await chart(PLAIN_ENC, [])) === JSON.stringify(PLAIN_BEFORE));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-periodCharts.js` → step 01's `metricKindPending` sentence comes back.
- [ ] **Step 3: Implement** as specified. In the planner, only the drawn measure is considered (`values[0]` under a split), as part 1 does; a pivot value naming a period metric is refused with `measureChartsAlone`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-periodCharts.js scripts/test-chartsFollowMetric.js scripts/test-metricMeasures.js scripts/test-additivity.js scripts/test-snapshot.js scripts/test-liveRoute.js scripts/test-liveSafetyNet.js scripts/test-embedLock.js scripts/test-file-size.js && npm run lint`.
- [ ] **Step 5: Commit.** `git add src scripts/test-periodCharts.ts && git commit -m "Chart a period metric so every point equals its tile"`

### Task 3: The sparkline, and the published page

**Files:** Modify `src/ipc/metrics.ts` `resolveMetricSeries :339` (a period metric draws through `bucketSeries` at month grain, the last `min(points, 12)` buckets; replaces step 05's null). Test: `scripts/test-periodCharts.ts`, section "spark".
**Interfaces:** No new names.
- [ ] **Step 1: Write the failing test.** `metric:table` → `rows[ytd.id].series` has 12 points, each `Object.is` its month's tile; a dashboard with a YTD chart card published through `buildDashboard` has the same series as the live chart (`publish/dashboardData.ts`, as `scripts/test-publishMemo.ts:22-38` builds one).
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-periodCharts.js` → the series is null.
- [ ] **Step 3: Implement** as specified (≤ 4 lines in `ipc/metrics.ts`).
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-periodCharts.js scripts/test-analysesServer.js scripts/test-publishMemo.js scripts/test-file-size.js`.
- [ ] **Step 5: Commit.** `git add src/ipc/metrics.ts scripts/test-periodCharts.ts && git commit -m "Draw a period metric's sparkline one month at a time"`

## Existing tests that must stay green

`test-chartsFollowMetric`, `test-metricMeasures`, `test-snapshot`, `test-additivity`, `test-tableCalc`, `test-compareSeries`, `test-periodMetrics`, `test-metrics`, `test-analysesServer`, `test-publishMemo`, `test-embedLock`, `test-liveRoute`, `test-liveSafetyNet`, `test-asyncReach`, `test-i18n`, `test-file-size`, `npm run lint`.
