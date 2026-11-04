# Semantic layer, part 5 — metrics depth

Status: draft, not built (2026-11-03). Builds on [part 1](00-design.md): P1-D7 (additivity), P1-D8
(snapshots), P1-D9 (`timeColumn`), P1-D16 (charts follow their metric). This doc's own decisions
are D1–D14.

Part 1 makes a metric say what it counts, by which date, and whether it adds up. Part 5 adds what
people ask for next: distinct counts, conversion, "year to date", each account's own balance, and
a goal to measure against.

## What you will see when this is done

```
Data model · Retail demo · Metrics                                              [ + Metric ]
Customers         count distinct customer_id            ⚠ can't be added up
Revenue           sum(amount) · by Order date           target: Plan (monthly, by region)
Revenue YTD       Revenue, year to date                 fiscal year from April
Orders 7d         Orders, last 7 days                   rolling
Revenue vs LY     Revenue, change on last year          %
Visit → buy       Visited, then Purchased within 7 days conversion
MRR               sum(mrr) · each account's last Snapshot date

┌ Revenue · This month (Nov 1–20) ─────────────────────┐
│ 700k        88% of target  ● at risk                 │
│ Target 800k: 1.2M for November, pro-rated to Nov 20  │
└──────────────────────────────────────────────────────┘
```

Count distinct is offered wherever an aggregation is (and as `countd(col)` in metric formulas).
Revenue YTD follows Revenue's edits; under "Last month" it is the year to last month's end, and by
month each point is the year to that month's end. Visit → buy comes from the funnel grid's new
**Save as metric**. Targets come from a figure or a plan table and show on tiles, scorecards,
charts (a stepped line) and alerts ("below 90% of target").

## Intent

- **No second engine.** Only count distinct is new math, with the full JS, resident and Live
  treatment. Everything else is a definition the server rewrites into scopes and resolutions the
  doors already answer.
- **A chart point equals its tile.** October on a Revenue YTD chart is the tile under "October".
- **Never compare the wrong things.** No distinct count is summed; no whole plan meets EMEA's actuals.

## Goals

1. A `countd` aggregation everywhere an aggregation is picked, on copies and Live.
2. Funnel metrics: conversion rate, converted, entered.
3. Period metrics: to-date and rolling windows, and change on the previous period or year.
4. Snapshots per entity: each account's own last value (dbt's `window_groupings`).
5. Targets per metric and period, per segment through the plan's columns, with a status.

## Non-goals

- Approximate distinct counts; fan-out joins computed with them; funnel and snapshot metrics on
  Live (refused, as P1-D8). All part 8.
- Carried-forward snapshots; pacing forecasts (pro-rating is the only target arithmetic); targets
  on metric-tree nodes; a period metric of a period metric; formulas over period metrics on charts.
- Changing LOD `COUNTD` on date columns to match D1 (it would change saved figures).

## Anti-goals (a failure even if it works)

- A running total or a sum of monthly distinct customers.
- A pod of the previous release reading `countd` as `sum`, or deleting an alert rule it can't read.
- The whole plan against a filtered actual, or a target that row rules restrict on one side only.
- "Rolling 7 days" that is really 7 chart cells: a day with no rows shortens it.

## Approaches

**A. New metric kinds over the existing engines (my call).** `countd` is the one new aggregation.
A period metric is a rewritten scope (tiles) or one resolution per bucket (a date axis). A compare
is a second resolution, as the KPI compare is. A funnel metric runs the funnel engine. A target is
a metric over a plan dataset. *Trade-off:* a date-axis chart costs one query per bucket, capped
at 24 (`resolveMetricSeries`' cap, `ipc/metrics.ts`); in exchange every aggregation stays exact and
every point equals its tile by construction.

**B. A windowed query engine** (MetricFlow's cumulative and conversion metrics): conditional
aggregates or range joins, one statement per chart, in JS, resident and five dialects with parity.
Fastest, and a second engine: A's upgrade if the per-bucket cost is ever measured.

**C. Saved table calculations** (`running_total` restarting yearly, `moving_sum`). Cheapest, wrong
at the edges: `tableCalc.ts` works on cells, not dates, so a day with no rows shortens a 7-day
window and a chart scoped to July starts YTD in July. Additive measures only; a tile has no cells.

A wins: it goes through `vizDataFor`, `computeCardMetric` and `computeCard`, so Live, row rules,
terms, the answer cache and `asOf` come free.

## Decisions

### Distinct counts

**D1. `countd` counts distinct non-empty values.** Stored as `countd`, the formula language's
name (`LodAgg`, `formulaParse.ts`); shown as "Count distinct"; exported as `count_distinct`.

| Column | Counts | Empty, not counted |
|---|---|---|
| text | distinct strings as stored: case-sensitive, untrimmed (the profile's rule, `statsResident.ts`) | `null`, `''`, whitespace |
| number | distinct finite numbers; `1`/`1.0` are one, `-0`/`0` are one | `null` |
| date | distinct **days** by the period grammar (`dateIntel.periodDay`: ISO or US, time ignored) (my call) | unreadable cells |

Dates count days because a spelling is not a date, and only days agree with a Live `DATE`; the
profile keeps counting spellings, a quality signal. An empty scope gives `0`, as `count` does. FX
never converts it (`dashboards.ts` exempts only `count` today). Default format: a whole number.

**D2. Three engines.**
- **JS:** one function in a new module, called by `metricValue.computeMetric` and by
  `transforms.aggregate` (795 lines: a one-line call), which carries it to `vizData`, pivots and
  Prepare's group step (my call: same function).
- **Resident:** `residentQuery.aggExpr` spells it as `lodResident.ts` already does,
  `CAST(count(DISTINCT CASE WHEN NOT <empty> THEN <key> END) AS DOUBLE)`; dates through
  `periodSql.sqlPeriodDate`. Both "Other" folds fold rows *before* aggregating
  (`vizData.capText`, `residentQuery.textKey`), so they stay exact.
- **Live:** `LIVE_AGGS` and the five dialects gain it; ClickHouse spells `uniqExact(x)`, since
  `count(DISTINCT)` there depends on `count_distinct_implementation`. **The trap:** the compiler
  builds measures from re-aggregable parts (`partsOf`, `REAGG_OF`, `compile.ts`): it folds
  "Other" by re-aggregating parts, ranks categories by summing parts across series (`totalOver`),
  and rolls days into week-calendar buckets in JS (`shape.ts` `rollUp`). A distinct count survives
  none of that. So a `countd` measure is **counted from base rows at every level** the statement
  ranks or folds at (category, series, folded key). A date axis under a week calendar (the `days`
  key, `evaluate.ts`) refuses `countd` (my call; resident computes those buckets in SQL).

**D3. Additivity and joins.** P1-D7's table gains `countd`: no across categories, no across time.
Its inventory gains one place found here: the Period overlay caption sums current and prior
buckets (`periodScope.overlayCaption`). No exception for a declared key; the editor suggests
`count` when the column is a key with no repeats (P1-D2). Joins are unchanged: fan-out is
still refused (`joinPlan.ts`), and a distinct count of a joined column counts over the main
table's rows in scope ("customers who ordered").

**D4. Readers ship a release before writers (my call).** Old pods are unsafe: `metrics.
sanitizeDefinition` and `visuals` turn an unknown aggregation into `sum` (and save it back), and
`alerts.sanitizeRule` drops the rule while `alertStore.save` rewrites the whole `alerts.json`. So
step 1 makes every sanitizer keep every part 5 shape (`countd`, the new definition kinds,
`snapshot.per`, `target`) while every engine refuses them with a sentence. The ten aggregation
lists (`AGG_FNS` in eight files, `alerts` `AGGS`, `LIVE_AGGS`) become one export; the ~44
`=== 'count'` checks become one `isCount()`, by script. The release note says a rollback past
step 1 shows these metrics as `sum`.

### Funnel metrics

**D5. A funnel kind.** `definition: { funnel: { entity, event, time, steps, window }, show:
'rate' | 'converted' | 'entered' }`, through `sanitizeEventFunnel` (at most 8 steps; fewer than 2
refused at save; no breakdown).
`rate` = converted ÷ entered as a fraction (format percent), null when nobody entered; converted =
reached the last step. The matching is the grid's (`funnelEvents.ts`): entry at the first step-1
event; each step the earliest one strictly after the previous (same instant is not after), within
the window from entry; duplicates count once; rows with no entity or an unreadable timestamp are
excluded and counted. Its `timeColumn` is `time` (my call).

**D6. The scope picks who enters; the metric picks which events count (my call, question 2).**
The metric's filters and the row lock (a security boundary, not a scope) filter **every** event.
Scope filters (tile, controls, terms, a chart's category) filter the **entry** event only. A
period on `time` is an entry period: an entity enters at its first step-1 event whose written date
is in it, and may convert after the period ends, within the window. So the bar for Germany (by
entry country) equals the tile filtered to Germany. When period end + window is after today, the
caption says "Recent entries may still convert". `buildEventFunnel` and `funnelResident` gain
one input, the entry filters, held to `Object.is`; `foldEventFunnel` is unchanged.

**D7. Relation to the funnel grid.** The grid is unchanged and filters all events. **Save as
metric** copies entity, event, time, steps and window; with no scope the metric's rate equals the
grid's last-step "% of first". Charts: by entry date, one resolution per bucket (D10); by
category, the funnel's breakdown (the entry row's value, cap 12, "truncated" note). A funnel
measure charts alone (my call). Live: the existing `funnel` refusal. `entered` and `converted` add
across categories (one entry per entity), not across time; `rate` adds across neither.

### Period metrics

**D8. A period kind, built on another metric.**

```ts
definition: {
  base: string;   // metric id: same dataset, has a timeColumn, not itself a period metric
  window?: { to_date: 'week' | 'month' | 'quarter' | 'year' } | { last: number; unit: 'day' | 'week' | 'month' };
  compare?: { vs: 'previous_period' | 'previous_year'; show: 'change' | 'pct_change' | 'prior' };
}                 // at least one of the two
```

A base without `timeColumn` is refused at save. `pct_change` is percent; the others take the
base's format. A deleted base says so; nothing falls back to a copy.

**D9. Which days a window covers.** *Scope end* is the last day of the period in scope on the
base's `timeColumn` (`periodScope.scopeRange`, after part 1's control rewrite), or today when none.
- **To date:** the start of the unit holding `min(scope end, today)`, to that day. With no scope
  this is the `ytd`/`qtd` preset exactly (`dateIntel` has no `mtd`; month and week clip
  `this_month`/`this_week`).
- **Last N:** `resolvePeriod({ preset: 'last_n_<unit>', n }, ref)` with `ref = min(scope end + 1
  day, today)`: N complete units ending at scope end. With no scope it is the "Last N days"
  preset, which ends yesterday (no partial today).
- The window **replaces** the scope's bounds on `timeColumn` (`withRange`); other filters stay.
  The caption gives the dates. Units follow the workspace calendar (fiscal start, week start, or a
  week calendar). Today is `todayIso()`: the pod's date or `ORDINATE_TODAY`, as for every period.
  Cells the period grammar can't read match no period, on every path, as today.
- **Compare** runs `compareScope` on the windowed range: like with like, so YTD to Nov 3 meets last
  year's YTD to Nov 3. `pct_change` = (now − prior) ÷ |prior|, null on a zero or null prior. With
  no window and no period in scope: null, "Pick a period to compare".

**D10. Where it is computed.**
- **Tiles, scorecards, alerts, the metric tree:** the rewritten scope through `resolveMetric` →
  `computeCardMetric`; compare is a second resolution. Every aggregation, Live included.
- **Text axis:** one chart-door call on the rewritten scope (two for compare, paired by label; a
  label missing from the prior and "Other" give null, since the two "Other"s differ).
- **Date axis:** one resolution per bucket, scope end = the bucket's last day capped at today
  (my call). Buckets run from the base's first to last in scope, gaps included, at most **24**;
  more is refused with a sentence pointing to the Moving sum calculation.
- **Additivity:** a window adds across categories as its base does, never across time; a compare
  adds across neither. Formulas over period metrics work on tiles, scorecards and alerts and are
  refused on charts (`shortcut:` until `metricMeasures` can plan a period operand).

### Snapshots per entity

**D11. `snapshot.per`.** Part 1's `snapshot: { column, take }` gains `per?: string` (the account
column). After every filter, the row lock and terms: drop rows whose snapshot date can't be read
(as P1-D8); partition by entity, and by time bucket when split by date; keep each partition's rows on
its latest (or earliest) day, ties all kept (P1-D8, dbt); aggregate those rows as usual, grouped by
the chart's category. Keys follow `cohortData.entityKey` (number by value, text as stored), except
that empty entities form **one partition of their own** rather than being dropped (my call: a
total never loses rows silently). An account with no rows in scope adds nothing; with no period in
scope, one that stopped reporting still counts its last value, and the editor and caption say so.
Additivity is P1-D8's. JS in P1-D8's module, resident twin with `max(day) OVER (PARTITION BY entity[,
bucket])`, `Object.is`. Live: P1-D8's refusal. Without `per`, byte-identical to P1-D8.

### Targets

**D12. A target lives on the metric; the numbers live in a dataset.**

```ts
target?: {
  source: { value: number } | { metricId: string };  // a figure, or a metric over a plan
  per?: 'week' | 'month' | 'quarter' | 'year';        // the period one figure covers
  thresholds?: Thresholds;                            // scorecardModel's, % of target
}
```

A plan is any dataset, usually an input table (month, region, amount) with its grid, validation
and versions (`src/data/inputTable/`); its metric is ordinary ("Plan revenue = sum(amount)").
Scorecard rows already take this shape (`ScorecardRow.target`); a row's own wins, else the
metric's. A fixed figure on an additive metric needs `per`; on a non-additive one it holds at any
scope. No new record kind, no migration.

**D13. A target under a scope.**
- **Dates:** the scope's range on the metric's `timeColumn` maps onto the plan metric's
  `timeColumn`, widened to whole `per` periods, so a plan row dated Nov 1 covers Nov 5–10. No
  period in scope: no target for an additive metric ("Pick a period").
- **Pro-rating (question 1):** for a metric additive across time, a partial period counts
  `target(p) × days covered ÷ days in p`; whole periods in the middle resolve as one figure, so at
  most three resolutions. A non-additive metric's target is the plan metric over the widened
  range, its own aggregation, never pro-rated.
- **Segments:** every other scope filter must resolve on the plan by the rules filters already
  follow (same name, or a relationship; a term by part 1's own-table rule). One that doesn't →
  **no target**, with a sentence ("The plan has no Channel"). Never the unfiltered plan.
- **Row rules (my call):** a target from another dataset shows only when the viewer's row rules
  restrict both datasets or neither; otherwise no target, with a sentence.
- **Status:** `scorecardModel.rowStatus(value, target, thresholds, direction)`.

**D14. Where targets show.** All computed on the server; React prints what it is sent.
- **Tile:** attainment, status dot, and how the target was got (period, pro-rated).
- **Scorecard:** today's target logic, plus D13 for the period in progress.
- **Chart:** a stepped target series, per bucket on a date axis (D10's 24) or per category through
  the plan's same-named column (none → no series, with a sentence). It is a `role: 'overlay'`
  series, which table calculations already skip (`tableCalc.ts`).
- **Alerts:** `compare: 'target'`, `below` or `above` a % of target, edge-triggered like a
  threshold. Alerts on period, funnel and target metrics evaluate by `metricId` through
  `resolveMetric`, since the stored `{column, aggregation}` copy (`alerts.ts`) can't express them;
  a deleted metric is said in the inbox.
- **Assistant, MCP:** `metric_value` returns target, attainment and status.

## Constraints (from the repo's rules)

- **Two implementations agree:** `countd`, entry periods and per-entity snapshots have a JS
  reference and a resident twin (`Object.is`); `countd` has Live parity on the DuckDB bench and the
  real-engine suites (`test-liveParityClickhouse`, `test-liveParityPostgres`) and golden shapes
  for five dialects. Everything else goes through the doors, so `test-liveRoute` and
  `test-liveSafetyNet` hold; the only new arithmetic (pro-rating, `pct_change`) is on the server.
- **Contracts:** none new expected; any new one gets zod, the narrowest access, project scope and
  a row-policy class. Cache keys come from the rewritten scope, under `orgKey()`. Sentences go
  through `t()`. No new dependency, no migration. Rollouts: D4.
- **File size:** `transforms.ts` (795), `ipc/visuals.ts` (769), `pivotData.ts` (739), `visuals.ts`
  (702), `residentQuery.ts` (675), `alerts.ts` (623) take one-line calls; each new kind gets a file.

## Tests (each guard with its negative control)

- **Distinct:** JS vs resident over `''`, whitespace, case, padding, `1`/`1.0`/`-0`/`0`, dates in
  both shapes with times and unreadable, empty scope, "Other" past 50, a split, by month, pivot
  subtotals; the same through `test-liveParity`. **Negative control:** a planted Live compile that
  re-aggregates per-category counts into "Other" fails it. Running total and overlay caption over
  `countd` refused, over `count` allowed. ClickHouse's golden shape says `uniqExact`.
- **Readers:** a metric and an alert rule with every new shape survive load and save on step 1; a
  grep test fails on an aggregation list outside the one export.
- **Funnel:** no scope equals the grid's last step (both engines); entry periods JS vs resident; a
  bar by entry country equals the tile filtered to it. **Negative control:** applying the scope to
  every event fails that test. The row lock still filters later events.
- **Period:** a YTD tile equals the base tile under the explicit range (fiscal start, week
  calendar, Feb 29); each chart point equals its bucket's tile; a 25th bucket is refused; with
  nothing set, golden fixtures are byte-identical.
- **Per entity:** P1-D8's matrix plus ties, empty entities, an account that moved region; without
  `per`, identical to P1-D8.
- **Targets:** pro-rating over month lengths and a week calendar. **Negative control:** a plan
  without the filtered column shows no target; removing that check shows the whole plan and fails.

## Build order (each step its own PR, chained)

1. Readers: one aggregation list; sanitizers keep every new shape; engines refuse them. Released
   before step 4.
2. `countd` in JS and resident, pivots, D3.
3. `countd` on Live: compile, five dialects, parity.
4. `countd` in the editors, `countd(col)` in `metricFormula`'s token rewrite, `answerSpec`, MCP.
5. Period metrics on tiles, scorecards, alerts (D8, D9, D10's first bullet).
6. Period metrics on charts.
7. Snapshots per entity.
8. Funnel metrics: the entry filter in both engines, the kind, Save as metric, charts.
9. Targets: model, tiles and scorecards; then charts and alerts.

## Dependencies

- **Part 1:** P1-D7, P1-D8, P1-D9 (period metrics and targets need `timeColumn`), P1-D11 (terms in a target's
  segment), P1-D16 (period and funnel measures plot through `vizMetricMeasures`). Part 1 misses that
  scorecards and `resolveMetricSeries` pick the dataset's first date column (`dateColOf`,
  `sparkColumn`); step 5 moves them to `timeColumn` if part 1 hasn't.
- **Part 7** maps 1:1 to `count_distinct`, cumulative and conversion metrics and
  `window_groupings`. **Part 8:** Live funnels and snapshots, symmetric aggregates, Approach B.
  Parts 3 and 4 only describe and certify the new kinds.

## Owner's answers

The owner took every recommended answer below (2026-11-03). They are decisions now, not open questions.

1. **Pro-rate a target for a period in progress?** Nov 1–20 against a 1.2M monthly plan: 800k, or
   1.2M? *Recommend pro-rating by calendar days, labelled, for metrics that add up; a whole-month
   target paints every month red until the 30th.*
2. **On a funnel metric, does a dashboard filter pick who enters, or which events count?**
   *Recommend who enters (D6), so a bar equals its tile. The grid keeps filtering all events;
   moving it too would change saved grids.*
3. **On Live, may a period-metric chart send one statement per bucket** (up to 24 a draw, each
   cached and counted against `LIVE_DAILY_QUERY_LIMIT`)? *Recommend yes, same cap: one rule
   everywhere, and Approach B if it bites.*

## Left to the builder

- Live SQL for counting at each level (CTEs or `GROUPING SETS`); that each engine takes
  `DISTINCT` over its safe-cast DOUBLE (BigQuery once restricted FLOAT64 grouping).
- Where the one aggregation list lives, and the script for the `=== 'count'` inventory.
- Gap-filled buckets under a week calendar; whether `resolveMetricSeries` draws them as is.
- The wire shape of target series and tile fields; the exact "both restricted or neither" check
  (`withLockOf`, `src/ipc/rowDoors.ts`).
