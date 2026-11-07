# The dbt import fixture (semantic layer part 7, f1)

`scripts/test-dbtImport.ts` reads these files. They pin what Ordinate imports from a dbt project's
`semantic_manifest.json`, and hold every imported metric's figures to the figures dbt's own engine
(MetricFlow) gives over the same rows.

| File | What it is |
|---|---|
| `seed.csv` | The orders table: 17 rows, Jan–Mar 2024. Empty cells are NULL in dbt and "no value" in Ordinate. |
| `visits.csv` | The visits table, for a second semantic model (a cross-model ratio and a conversion). |
| `semantic_manifest.json` | The project's semantic manifest, in dbt 1.9's shape (below). |
| `expected.json` | `[metric, group, key, value]`: each importable metric by total (`''`), by `region` and by `month` (`YYYY-MM`). |
| `expected.sql` | The SQL `expected.json` was computed with (see "Status"). |

## Status: MetricFlow has not run yet

MetricFlow is Python and not a dependency of Ordinate. It runs **offline on a developer machine**, never in CI or at
run time. The implementer's machine had no dbt or MetricFlow and installing them was out of bounds, so:

- `semantic_manifest.json` was written by hand to the dbt 1.9 schema (`dbt-semantic-interfaces` 0.7), from the
  project below.
- `expected.json` was computed by `duckdb -json < expected.sql` (DuckDB 1.5.5): the SQL is written in MetricFlow's
  shapes (each input of a ratio or derived metric aggregated on its own, then FULL OUTER JOINed on the group; a
  ratio as `CAST(num AS DOUBLE) / CAST(NULLIF(den, 0) AS DOUBLE)`; a balance read on the last `stock_date` of the
  query, or of each month when grouped by month).

**The owner's step, once:** build the project below, run the `mf query` commands, and replace `expected.json` (and
`semantic_manifest.json` with dbt's own `target/semantic_manifest.json`). Then run the suite. A figure that then
differs is a finding about the mapping, never a reason to edit the figure: fix the translation or skip that shape
with a reason, and say so here.

## The dbt project (outside the repo)

Versions to record when it runs: `dbt --version`, `mf --version`, `duckdb --version`.

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install "dbt-core~=1.9.0" "dbt-duckdb~=1.9.0" "dbt-metricflow[dbt-duckdb]~=0.7.0"
mkdir -p seeds models && cp <ordinate>/scripts/fixtures/dbt/seed.csv seeds/seed.csv && cp <ordinate>/scripts/fixtures/dbt/visits.csv seeds/visit_rows.csv
dbt seed && dbt run && dbt parse     # target/semantic_manifest.json
```

`dbt_project.yml`

```yaml
name: ordinate_fixture
version: "1.0"
profile: ordinate_fixture
seeds:
  ordinate_fixture:
    seed:
      +column_types: { id: varchar, customer_id: varchar, region: varchar, amount: double, status: varchar, order_date: date, stock_date: date, units: integer }
    visit_rows:
      +column_types: { visit_id: varchar, customer_id: varchar, visit_date: date }
```

`profiles.yml`: `ordinate_fixture: { target: dev, outputs: { dev: { type: duckdb, path: fixture.duckdb } } }`

`models/orders.sql`: `select * from {{ ref('seed') }}` · `models/visits.sql`: `select * from {{ ref('visit_rows') }}` ·
`models/metricflow_time_spine.sql`:
`select cast(range as date) as date_day from range(date '2023-01-01', date '2026-01-01', interval 1 day)`

`models/semantic.yml`

```yaml
time_spines:
  - name: metricflow_time_spine
    primary_column: { name: date_day, time_granularity: day }
semantic_models:
  - name: orders
    description: One row per order.
    model: ref('orders')
    defaults: { agg_time_dimension: order_date }
    entities:
      - { name: order, type: primary, expr: id }
      - { name: customer, type: foreign, expr: customer_id }
    dimensions:
      - { name: region, type: categorical, description: Where the order was placed, label: Region }
      - { name: status, type: categorical, description: paid or refunded }
      - { name: units, type: categorical }
      - { name: order_date, type: time, type_params: { time_granularity: day }, description: The day the order was placed, label: Order date }
      - { name: stock_date, type: time, type_params: { time_granularity: day }, description: The day stock was counted }
      - { name: order_month, type: time, expr: "date_trunc('month', order_date)", type_params: { time_granularity: month }, description: The month of the order }
    measures:
      - { name: order_total, agg: sum, expr: amount }
      - { name: order_count, agg: count, expr: id }
      - { name: avg_amount, agg: average, expr: amount }
      - { name: min_amount, agg: min, expr: amount }
      - { name: max_amount, agg: max, expr: amount }
      - { name: customer_count, agg: count_distinct, expr: customer_id }
      - { name: median_amount, agg: median, expr: amount }
      - { name: doubled_amount, agg: sum, expr: amount * 2 }
      - { name: stock_units, agg: sum, expr: units, agg_time_dimension: stock_date, non_additive_dimension: { name: stock_date, window_choice: max } }
      - { name: stock_per_customer, agg: sum, expr: units, agg_time_dimension: stock_date, non_additive_dimension: { name: stock_date, window_choice: max, window_groupings: [customer] } }
  - name: visits
    model: ref('visits')
    defaults: { agg_time_dimension: visit_date }
    entities:
      - { name: visit, type: primary, expr: visit_id }
      - { name: customer, type: foreign, expr: customer_id }
    dimensions:
      - { name: visit_date, type: time, type_params: { time_granularity: day } }
    measures:
      - { name: visit_count, agg: count, expr: visit_id }
metrics:
  - { name: revenue, label: Revenue, description: "Order amounts, refunds included", type: simple, type_params: { measure: order_total } }
  - { name: orders, label: Orders, type: simple, type_params: { measure: order_count } }
  - { name: avg_order, label: Avg order, type: simple, type_params: { measure: avg_amount } }
  - { name: smallest_order, label: Smallest order, type: simple, type_params: { measure: min_amount } }
  - { name: largest_order, label: Largest order, type: simple, type_params: { measure: max_amount } }
  - { name: customers, label: Customers, type: simple, type_params: { measure: customer_count } }
  - { name: eu_revenue, label: EU revenue, type: simple, type_params: { measure: order_total }, filter: "{{ Dimension('order__region') }} = 'EU'" }
  - { name: refunds, label: Refunds, type: simple, type_params: { measure: order_total }, filter: "{{ Dimension('order__status') }} = 'refunded'" }
  - { name: not_refunded, label: Not refunded, type: simple, type_params: { measure: order_total }, filter: "{{ Dimension('order__status') }} != 'refunded'" }
  - { name: eu_us_revenue, label: EU and US revenue, type: simple, type_params: { measure: order_total }, filter: "{{ Dimension('order__region') }} IN ('EU', 'US')" }
  - name: bulk_revenue
    label: Bulk revenue
    type: simple
    type_params: { measure: order_total }
    filter: ["{{ Dimension('order__units') }} >= 5", "{{ Dimension('order__status') }} = 'paid'"]
  - { name: aov, label: AOV, type: ratio, type_params: { numerator: revenue, denominator: orders } }
  - { name: net, label: Net, type: derived, type_params: { expr: revenue - refunds, metrics: [revenue, refunds] } }
  - { name: stock, label: Stock, type: simple, type_params: { measure: stock_units } }
  - { name: stock_by_customer, label: Stock by customer, type: simple, type_params: { measure: stock_per_customer } }
  - { name: cumulative_revenue, label: Cumulative revenue, type: cumulative, type_params: { measure: order_total, cumulative_type_params: { window: 1 month } } }
  - name: visit_to_buy
    label: Visit to buy
    type: conversion
    type_params: { conversion_type_params: { base_measure: visit_count, conversion_measure: order_count, entity: customer, window: 7 days } }
  - name: revenue_vs_last_year
    label: Revenue vs last year
    type: derived
    type_params: { expr: revenue - revenue_ly, metrics: [{ name: revenue }, { name: revenue, alias: revenue_ly, offset_window: 1 year }] }
  - { name: revenue_per_visit, label: Revenue per visit, type: ratio, type_params: { numerator: revenue, denominator: visits } }
  - { name: median_order, label: Median order, type: simple, type_params: { measure: median_amount } }
  - { name: doubled_revenue, label: Doubled revenue, type: simple, type_params: { measure: doubled_amount } }
  - { name: revenue_filled, label: Revenue (filled), type: simple, type_params: { measure: { name: order_total, fill_nulls_with: 0, join_to_timespine: true } } }
  - { name: eu_or_paid_revenue, label: EU or paid revenue, type: simple, type_params: { measure: order_total }, filter: "{{ Dimension('order__region') }} = 'EU' OR {{ Dimension('order__status') }} = 'paid'" }
  - { name: median_gap, label: Median gap, type: derived, type_params: { expr: median_order - avg_order, metrics: [median_order, avg_order] } }
  - { name: visits, label: Visits, type: simple, type_params: { measure: visit_count } }
```

## The figures (`expected.json`)

```sh
M=revenue,orders,avg_order,smallest_order,largest_order,customers,eu_revenue,refunds,not_refunded,eu_us_revenue,bulk_revenue,aov,net
mf query --metrics $M --csv total.csv
mf query --metrics $M --group-by order__region --csv region.csv
mf query --metrics $M --group-by metric_time__month --csv month.csv
mf query --metrics stock --csv stock_total.csv
mf query --metrics stock --group-by order__region --csv stock_region.csv
mf query --metrics stock --group-by metric_time__month --csv stock_month.csv
mf query --metrics visits --csv visits_total.csv
mf query --metrics visits --group-by metric_time__month --csv visits_month.csv
```

Each row becomes `[<the metric's label>, '' | 'region' | 'month', <the region, or the month as YYYY-MM>, <value>]`; an
empty cell is `null`. Metrics are named by their labels, which are their Ordinate names. A group MetricFlow leaves out
(a region with no rows on Stock's last day) is not listed: Ordinate must show no figure there either.

## What each metric checks

| Metric | Translated to | Why it is here |
|---|---|---|
| Revenue, Orders, Avg order, Smallest order, Largest order | sum, count, avg, min, max | the plain aggregations; Revenue's description travels |
| Customers | countd | `count_distinct` (part 5's distinct count) |
| EU revenue, Refunds | a `=` filter step | a filtered simple metric |
| Not refunded | `not_empty`, then `!=` | SQL's `!=` leaves out a NULL status (o11); Ordinate's `!=` alone keeps an empty cell |
| EU and US revenue | `in` | a list |
| Bulk revenue | `>=` and `=` | a number comparison (o09 has no units) and two filters joined by AND |
| AOV | `[Revenue] / [Orders]` | a ratio, aggregated per group, then divided |
| Net | `([Revenue] - [Refunds])` | a derived metric; LATAM has no refunds, so its Net is NULL in MetricFlow and no figure in Ordinate |
| Stock | snapshot, last `stock_date` | a balance with no window groupings; APAC and LATAM have no row on the last day |
| Visits | count, on the second dataset | a second semantic model |
| Stock by customer | skipped `window_groupings` | f2 maps one grouping later |
| Cumulative revenue | skipped `cumulative` | |
| Visit to buy | skipped `conversion` | |
| Revenue vs last year | skipped `time_offset` | an input with `offset_window` |
| Revenue per visit | skipped `cross_model` | inputs on two semantic models |
| Median order | skipped `unknown_aggregation` | `median` |
| Doubled revenue | skipped `not_a_column` | the measure's `expr` is SQL |
| Revenue (filled) | skipped `fill_nulls` | dbt shows 0 where there are no rows; Ordinate shows no figure |
| EU or paid revenue | skipped `filter_shape` | `OR` |
| Median gap | skipped, depends on Median order | a derived metric over a skipped input |

The dimension `order_month` is skipped `not_a_column` (its `expr` is SQL); `units` has no description or label, so
it has nothing to import.
