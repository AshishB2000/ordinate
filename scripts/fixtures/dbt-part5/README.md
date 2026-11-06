# The dbt import fixture for part 5's shapes (semantic layer part 7, f2)

`scripts/test-dbtPart5.ts` reads these files. They pin which of dbt's cumulative, per-entity, time-offset and
conversion shapes Ordinate imports, and hold every imported one to the figures dbt's engine (MetricFlow) gives over
the same rows. f1's fixture (`../dbt/`) is untouched; `../golden/dbt-f1/translation.json` pins f1's translation of it
as it was before any f2 code.

| File | What it is |
|---|---|
| `orders.csv` | 811 orders, 2023-01-01 to 2024-03-15, whole-unit amounts. Empty days (about one in eight, 2023-08-10 to 08-18, 2023-10-01, 2023-12-31), a refund (`status = refund`, negative amount) on some days, revenue on 2023-02-28 and 2024-02-29. |
| `balances.csv` | Monthly MRR for A01–A08, January to June 2024. A07 moves from EU to US in April, A08 stops after February, A05 reports on 28 May, two rows have no account, A03 has two rows on 30 April. |
| `events.csv` | Visits and buys: U1 visits on 1 and 20 January and buys on the 22nd; U2 buys exactly 7 days after its visit; U3 buys on the day of its visit. |
| `semantic_manifest.json` | The project's semantic manifest, in dbt 1.9's shape (`dbt-semantic-interfaces` 0.7), as f1's. |
| `expected.json` | `byDay` (metric → day → figure, a day MetricFlow leaves out is absent), `byPeriod` (`[metric, week \| month \| quarter \| year, first day, figure]`, every period ended by 2024-06-30), `controls`. |
| `expected.sql` | The SQL `expected.json` was computed with: `duckdb -noheader -list < expected.sql > expected.json`. |

## Status: every figure is pending MetricFlow

MetricFlow is Python and not a dependency of Ordinate. The implementer's machine had no dbt or MetricFlow, and
installing them was out of bounds, so every figure in `expected.json` is **pending MetricFlow**: DuckDB SQL (1.5.5)
written in the shapes dbt's documentation shows (linked below). The manifest is hand-written to dbt 1.9's schema.

**The owner's step, once:** build the project below, run the `mf query` commands, replace `expected.json` with their
figures (and `semantic_manifest.json` with dbt's own), and run the suite. A figure that then differs is a finding
about a mapping: remove that mapping (its metric goes back to a skip reason) and say why here. Never edit a figure.

## What MetricFlow does, and what f2 maps (each from dbt's docs, or kept skipped)

| Question | Answer | Source |
|---|---|---|
| Where a cumulative metric's window, grain and `period_agg` are | `type_params.cumulative_type_params.{window, grain_to_date, period_agg}`; an older YAML's top-level `window`/`grain_to_date` is in `type_params`. The reader takes `cumulative_type_params` first and the top level as a fallback; the two set differently, or a window with a grain, is `cumulative`. | [cumulative](https://docs.getdbt.com/docs/build/cumulative): "window … Cannot be used with grain_to_date". The manifest layout is not in the docs: both places are read. |
| The window's format | `{ count, granularity }` (f1's manifest). Singular or plural is not in the docs, so both are read as the same unit. | as above |
| `period_agg` | `first` (the default), `last` or `average`. Absent is the default, `first`: skipped `period_agg`. | [cumulative](https://docs.getdbt.com/docs/build/cumulative): "Defaults to `first` if `period_agg` isn't specified." |
| The window's days | The time spine INNER JOINed to the rows with `metric_time <= t AND metric_time > t - N days`: (t − N, t], Ordinate's "last N days" ending on t. A to-date: `>= date_trunc(grain, t) AND <= t`. | [cumulative](https://docs.getdbt.com/docs/build/cumulative), the SQL under "window" and "grain to date" |
| A day whose window holds no row | No figure (the INNER JOIN drops it). Ordinate shows none either. | as above |
| What `period_agg: last` gives for an ended month | `last_value(…) over (partition by the month order by metric_time__day)` over the days the join kept: **the figure on the month's last day whose window holds a row**. Ordinate's is the window ending on the month's last day. They are the same figure whenever that window holds a row. When it holds none Ordinate shows no figure, where dbt repeats an earlier day's (20 periods here, below). | [cumulative](https://docs.getdbt.com/docs/build/cumulative), the `period_agg` SQL |
| A window in weeks | `N weeks` is 7N days (date arithmetic). Ordinate's "last N weeks" is whole calendar weeks, so it maps to `last 7N days`. | as above |
| A count's window with no row | MetricFlow has no figure (the join leaves the day out); Ordinate counts it 0. Found by the suite (`orders_7d` on 2023-08-16): a window over a count or a distinct count is skipped `count_window`, and so is a formula over one. | the suite |
| MetricFlow's week start | **Not in the docs**: `date_trunc('week')`, which is the warehouse's. A week to-date stays skipped (`calendar_differs`). | [dimensions](https://docs.getdbt.com/docs/build/dimensions) |
| Quarters and years | Calendar (`date_trunc`), so a quarter or year to-date maps only while the workspace's year starts in January on the Gregorian calendar; a month to-date while the calendar is Gregorian. | as above |
| `input_metric` (dbt's newer spec) | The docs' newer YAML names `input_metric`; its manifest is not documented, so a cumulative metric with no `type_params.measure` is `unreadable`. | [cumulative](https://docs.getdbt.com/docs/build/cumulative) |
| `fill_nulls_with` on a cumulative input | Not on the cumulative page; dbt shows a value where Ordinate shows none: skipped `fill_nulls`. | [simple](https://docs.getdbt.com/docs/build/simple) |
| Semi-additive rows with `window_groupings` | **Not in the docs**: neither whether the latest day is per entity only (and per queried time grain) or per every grouped field too, nor whether a row with no entity is dropped or kept. So `window_groupings` **stays skipped**, and Task 3 (`snapshot.per`) is not built. `mrr`, `mrr_two` and `mrr_first` are here for the owner's run to settle it (below). | [measures](https://docs.getdbt.com/docs/build/measures) |
| Conversion | Each buy is paired with the closest visit in (buy − window, buy] (`first_value … order by visit desc`), counted once per buy; the rate is buys over visits. Ordinate's funnel starts from each person's first visit and counts people. Stays skipped `conversion`. | [conversion](https://docs.getdbt.com/docs/build/conversion) |
| Time offsets | "an offset join on the daily dataset, followed by … a date trunc and aggregation". Leap days are not in the docs; `expected.sql` takes `2024-02-29 − 1 year` as 2023-02-28 (DuckDB's), so `revenue_ly` for February 2024 counts 28 February 2023 twice. `offset_to_grain` is not in the docs. Both stay skipped `time_offset`. | [derived](https://docs.getdbt.com/docs/build/derived) |

### The periods whose last window holds no row (Ordinate: no figure)

MetricFlow's figure at each is an earlier day's: `revenue_7d`, `revenue_2w`, `eu_revenue_7d` and `eu_share_7d` in
March 2024 and Q1 2024 (the data ends on 15 March), and in the week of 18 March 2024 (`revenue_2w`: of 25 March);
`eu_revenue_7d` and `eu_share_7d` in the weeks of 6 March 2023, 14 August 2023 and 4 March 2024 (`eu_share_7d` then
divides an earlier day's EU figure by the last day's total); `revenue_mtd` and `revenue_qtd` in the week of 25 September
2023 (1 October 2023, a Sunday, has no order). 20 in all. The suite holds Ordinate to no figure at each, and to
MetricFlow's figure at every other day and period. Ordinate never shows a figure there that differs from dbt's.

## The dbt project (outside the repo)

Record `dbt --version`, `mf --version` and `duckdb --version` when it runs.

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install "dbt-core~=1.9.0" "dbt-duckdb~=1.9.0" "dbt-metricflow[dbt-duckdb]~=0.7.0"
mkdir -p seeds models && cp <ordinate>/scripts/fixtures/dbt-part5/{orders,balances,events}.csv seeds/
dbt seed && dbt run && dbt parse     # target/semantic_manifest.json
```

`dbt_project.yml`: `name: ordinate_part5`, `profile: ordinate_part5`, seed column types `orders: { order_id: varchar,
customer_id: varchar, region: varchar, amount: bigint, status: varchar, order_date: date }`, `balances: { account_id:
varchar, region: varchar, mrr: bigint, snapshot_date: date }`, `events: { user_id: varchar, event: varchar, ts: date }`.
`profiles.yml`: `ordinate_part5: { target: dev, outputs: { dev: { type: duckdb, path: part5.duckdb } } }`.
`models/<seed>_m.sql`: `select * from {{ ref('<seed>') }}` for each seed, and `models/metricflow_time_spine.sql`:
`select cast(range as date) as date_day from range(date '2023-01-01', date '2026-01-01', interval 1 day)`.

`models/semantic.yml` (the manifest's content; `semantic_manifest.json` is its dbt 1.9 form):

```yaml
time_spines:
  - { name: metricflow_time_spine, primary_column: { name: date_day, time_granularity: day } }
semantic_models:
  - name: orders
    model: ref('orders_m')
    defaults: { agg_time_dimension: order_date }
    entities: [{ name: order, type: primary, expr: order_id }, { name: customer, type: foreign, expr: customer_id }]
    dimensions: [{ name: region, type: categorical }, { name: status, type: categorical }, { name: order_date, type: time, type_params: { time_granularity: day } }]
    measures:
      - { name: order_total, agg: sum, expr: amount }
      - { name: order_count, agg: count, expr: order_id }
      - { name: refund_total, agg: sum, expr: amount }
  - name: balances
    model: ref('balances_m')
    primary_entity: balance
    defaults: { agg_time_dimension: snapshot_date }
    entities: [{ name: account, type: foreign, expr: account_id }, { name: account_region, type: foreign, expr: region }]
    dimensions: [{ name: region, type: categorical }, { name: snapshot_date, type: time, type_params: { time_granularity: day } }]
    measures:
      - { name: mrr_by_account, agg: sum, expr: mrr, non_additive_dimension: { name: snapshot_date, window_choice: max, window_groupings: [account] } }
      - { name: mrr_by_account_region, agg: sum, expr: mrr, non_additive_dimension: { name: snapshot_date, window_choice: max, window_groupings: [account, account_region] } }
      - { name: mrr_first_by_account, agg: sum, expr: mrr, non_additive_dimension: { name: snapshot_date, window_choice: min, window_groupings: [account] } }
  - name: events
    model: ref('events_m')
    primary_entity: event_row
    defaults: { agg_time_dimension: ts }
    entities: [{ name: user, type: foreign, expr: user_id }]
    dimensions: [{ name: event, type: categorical }, { name: ts, type: time, type_params: { time_granularity: day } }]
    measures:
      - { name: visit_count, agg: sum, expr: "CASE WHEN event = 'visit' THEN 1 ELSE 0 END" }
      - { name: buy_count, agg: sum, expr: "CASE WHEN event = 'buy' THEN 1 ELSE 0 END" }
metrics:
  - { name: revenue, type: simple, type_params: { measure: order_total } }
  - { name: orders, type: simple, type_params: { measure: order_count } }
  - { name: refunds_card, type: simple, type_params: { measure: refund_total }, filter: "{{ Dimension('order__status') }} = 'refund'" }
  - { name: mrr, type: simple, type_params: { measure: mrr_by_account } }
  - { name: mrr_two, type: simple, type_params: { measure: mrr_by_account_region } }
  - { name: mrr_first, type: simple, type_params: { measure: mrr_first_by_account } }
  - { name: revenue_7d, type: cumulative, type_params: { measure: order_total, cumulative_type_params: { window: 7 days, period_agg: last } } }
  - { name: revenue_2w, type: cumulative, type_params: { measure: order_total, cumulative_type_params: { window: 2 weeks, period_agg: last } } }
  - { name: revenue_wtd, type: cumulative, type_params: { measure: order_total, cumulative_type_params: { grain_to_date: week, period_agg: last } } }
  - { name: revenue_mtd, type: cumulative, type_params: { measure: order_total, cumulative_type_params: { grain_to_date: month, period_agg: last } } }
  - { name: revenue_qtd, type: cumulative, type_params: { measure: order_total, cumulative_type_params: { grain_to_date: quarter, period_agg: last } } }
  - { name: revenue_ytd, type: cumulative, type_params: { measure: order_total, cumulative_type_params: { grain_to_date: year, period_agg: last } } }
  - { name: eu_revenue_7d, type: cumulative, type_params: { measure: order_total, cumulative_type_params: { window: 7 days, period_agg: last } }, filter: "{{ Dimension('order__region') }} = 'EU'" }
  - { name: orders_7d, type: cumulative, type_params: { measure: order_count, cumulative_type_params: { window: 7 days, period_agg: last } } }
  - { name: revenue_7d_first, type: cumulative, type_params: { measure: order_total, window: 7 days } }
  - { name: revenue_all_time, type: cumulative, type_params: { measure: order_total, cumulative_type_params: { period_agg: last } } }
  - { name: revenue_rolling_month, type: cumulative, type_params: { measure: order_total, cumulative_type_params: { window: 1 month, period_agg: last } } }
  - { name: revenue_7d_filled, type: cumulative, type_params: { measure: { name: order_total, fill_nulls_with: 0, join_to_timespine: true }, cumulative_type_params: { window: 7 days, period_agg: last } } }
  - { name: refunds_7d, type: cumulative, type_params: { measure: refund_total, cumulative_type_params: { window: 7 days, period_agg: last } } }
  - { name: mrr_7d, type: cumulative, type_params: { measure: mrr_by_account, cumulative_type_params: { window: 7 days, period_agg: last } } }
  - { name: aov_7d, type: derived, type_params: { expr: revenue_7d / orders_7d, metrics: [revenue_7d, orders_7d] } }
  - { name: eu_share_7d, type: derived, type_params: { expr: eu_revenue_7d / revenue_7d, metrics: [eu_revenue_7d, revenue_7d] } }
  - { name: revenue_ly, type: derived, type_params: { expr: revenue_ly, metrics: [{ name: revenue, alias: revenue_ly, offset_window: 1 year }] } }
  - { name: revenue_yoy_change, type: derived, type_params: { expr: revenue - revenue_ly, metrics: [revenue, { name: revenue, alias: revenue_ly, offset_window: 1 year }] } }
  - { name: revenue_yoy_growth, type: derived, type_params: { expr: (revenue - revenue_ly) / revenue_ly, metrics: [revenue, { name: revenue, alias: revenue_ly, offset_window: 1 year }] } }
  - name: visit_to_buy
    type: conversion
    type_params: { conversion_type_params: { base_measure: visit_count, conversion_measure: buy_count, entity: user, calculation: conversion_rate, window: 7 days } }
```

## The figures

```sh
C=revenue_7d,revenue_2w,revenue_mtd,revenue_qtd,revenue_ytd,eu_revenue_7d,eu_share_7d,orders_7d,aov_7d
for g in day week month quarter year; do mf query --metrics $C --group-by metric_time__$g --end-time 2024-06-30 --csv $g.csv; done
mf query --metrics revenue_7d_first --group-by metric_time__month --csv first.csv
mf query --metrics revenue_rolling_month --group-by metric_time__day --end-time 2024-06-30 --csv rolling_month.csv
mf query --metrics revenue_ly --group-by metric_time__month --csv ly.csv
mf query --metrics visit_to_buy --csv conversion.csv
# window_groupings, to settle Task 3 (see above): does A07 count in EU and US by region? are the two rows with no account left out?
mf query --metrics mrr,mrr_two,mrr_first --csv mrr_total.csv
mf query --metrics mrr,mrr_two,mrr_first --group-by balance__region --csv mrr_region.csv
mf query --metrics mrr,mrr_two,mrr_first --group-by metric_time__month --csv mrr_month.csv
```

Keep only periods that ended by 2024-06-30 (`byPeriod`). If `mrr` by region counts A07 once (in US) and leaves out the
rows with no account, `window_groupings: [one entity]` can map to `snapshot.per` with a `not_empty` step on the entity
column; if it counts A07 in both regions it cannot, and it stays skipped.

## What each metric checks

| Metric | Imported as | Why it is here |
|---|---|---|
| revenue, orders | sum, count (f1) | the bases |
| refunds_card | sum, filtered (f1) | the refunds measure's only simple metric is filtered |
| revenue_7d, eu_revenue_7d | `{ base, window: { last: 7, unit: 'day' } }` | a rolling window; its own filter becomes its filters over the unfiltered base |
| revenue_2w | `last: 14, unit: 'day'` | weeks become days, never calendar weeks |
| revenue_mtd, revenue_qtd, revenue_ytd | `{ to_date: month \| quarter \| year }` | to date, while the calendar is dbt's |
| eu_share_7d | `([eu_revenue_7d] / [revenue_7d])`, by `order_date` | a derived metric over two windows: f1's formula, on its bases' date |
| orders_7d | skipped `count_window` | a count over a window with no row is 0 here, no figure in dbt (`orders_7d`'s figures stay, for that control) |
| aov_7d | skipped, falls with orders_7d | a formula over a count window |
| revenue_wtd | skipped `calendar_differs` | dbt's week is its warehouse's |
| revenue_7d_first | skipped `period_agg` | an older YAML, top-level window, `period_agg` left to `first` |
| revenue_all_time | skipped `all_time` | no window and no grain |
| revenue_rolling_month | skipped `window_unit` | MetricFlow's month window is calendar-month arithmetic |
| revenue_7d_filled | skipped `fill_nulls` | |
| refunds_7d | skipped `no_base_metric` | no unfiltered simple metric on its measure |
| mrr_7d | skipped `cumulative` | over a balance |
| mrr, mrr_two, mrr_first | skipped `window_groupings` | not settled (above) |
| revenue_ly, revenue_yoy_change, revenue_yoy_growth | skipped `time_offset` | a day-shifted roll-up |
| visit_to_buy | skipped `conversion` | closest-visit pairing, counted per buy |
