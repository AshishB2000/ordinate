# Live data log

Append-only. One entry per task of [the plan](00-plan.md): date, task id, what was measured, what
was decided and why.

## 2026-10-09 — L2.2 The compiler

- **Built.** `src/engine/live/`: `liveSpec.ts` (the IR, typed refusals, and the adapters
  `fromVizEncoding` / `fromAnswerSpec` / `fromMetric`, each taking exactly what `vizDataFor`,
  `computeCard` and `metricFor` take today); `compile.ts` + `compileFilter.ts` (IR + dialect +
  source + declared columns → one statement and its `LiveParam[]`: the latest-date `MAX()`, the
  bin range, the grain probe, the chart, the metric); `dialects/{snowflake,bigquery,redshift,
  databricks,clickhouse,duckdb}.ts` behind `dialect.ts`; `sqlParams.ts` (placeholders numbered
  from the FINISHED text, so a CTE built out of order still binds `params[i]` to the (i+1)-th
  placeholder, and a fragment used twice binds twice); `shape.ts` (rows → `{labels, series}` +
  `CategoryInfo`, or the metric number); `evaluate.ts` (`evaluateLive(ir, env, run)`, the step
  order for L2.3, and `resolvePeriods`). Refusal sentences: `src/engine/liveRefusals.ts`
  (catalog keys `liveRefusals.*` — not `liveMessages.*`, which L2.1 uses; drafts translated).
  `categoryKey.gregorianBucketLabel` is the calendar-free half of `dateBucketLabel`, so a label
  follows the calendar the query was compiled under.
- **Measured** (`scripts/test-liveParity.ts`, DuckDB bench, this container): 1,090 charts, 108 KPI
  values and 112 AI answers through both paths — extract = `vizDataFor` / `computeCardMetric` /
  `computeCard` over a real stored dataset (1,060 rows, so KPIs take the resident path), live =
  adapt → compile → DuckDB → shape — 2,313 live statements, ~40 s wall. Everything agrees.
  Largest sum/avg deviation **1.0e-15** relative over 1,470 figures (tolerance 1e-13).
- **A 1e15 outlier is a summation-order test, not a compiler test.** With 1e15 among ~1,000 small
  cells the deviation reached **8.9e-14**: every later addition rounds at 1e15's ULP (0.125), a
  BIASED error of ~n·ε whose size depends on the order of addition. Inherent to parallel
  summation, so the fixture holds no huge outlier and the documented 1e-13 stands.
- **Two summation orders inside live, too.** A split ranks a category by the window total of its
  per-series sums, the flat chart by a direct sum: measured 241.9 vs 241.89999999999998 for two
  categories equal in exact arithmetic, swapping their order. Both are live's rule; the parity
  test accepts a swap only within the float tolerance.
- **Order is explicit, and differs from the extract on purpose.** Live orders dates and bins
  ascending and text by the first measure (largest first), each ending on the key, NULL last; the
  extract is first-seen. The UI note belongs to L2.6.
- **Named divergences, each pinned** (`scripts/liveParityPins.ts`, `scripts/test-liveCompile.ts`):
  1. ties AT the 50 cut — the extract keeps the first-seen, live the smaller label;
  2. ties AT an answer's top-N cut — the same;
  3. a split answer's top N — live ranks by the category total, the extract by the first series
     (`answers.ranked` reads `series[0]`);
  4. sum/avg/min/max over a non-number column — live refuses, the extract draws nulls;
  5. `contains` on a number column, a split by a date column, a period on a non-date column,
     `within_km`, raw points, pivot/cohort/funnel/drivers/facets/maps/related fields — refused;
  6. a date the warehouse holds as a TIMESTAMP — buckets and periods agree; a text comparison
     (`=`, `<`, `in`, `contains`) compares the DAY on live, the stored timestamp text on the
     extract;
  7. −0 — DuckDB stores −0.0 as 0 and an extract stores `String(-0)` = `'0'`; live shaping turns
     any −0 a warehouse returns into 0;
  8. an answer's data-relative period with no dates warns after the adapter's own warnings (the
     extract interleaves by filter position).
- **Found in the existing extract path** (reported, outside L2.2): `sqlGen.WS_CLASS`, the resident
  layer's "empty" class, is narrower than JS `trim()` — it misses U+1680, U+2000–U+200A, U+2028,
  U+2029, U+202F, U+205F and U+3000, so a cell holding only those is empty to
  `transforms.isEmptyCell` and not to the resident `count` / `is_empty` (pinned: the resident chart
  counts 5 where JS counts 1). Live spells JS's class in full and agrees with JS. Inherited and
  unchanged: a text ORDERING filter over astral characters (DuckDB bytes vs JS UTF-16) — live agrees
  with the resident path, not the JS fold.
- **For L2.3 / L2.4.** Wrap `run(query, step)` (rows positional to `query.columns`) with the cache,
  the budget, `runBound` and the abort signal. Concatenate `adapted.warnings` and
  `outcome.warnings`; `recommendedShape` stays `recommendChartType(columns, encoding)`. Live
  answers are already ranked and cut — do not apply `answers.ranked` again. Text-filter case fixing
  stays L2.4's cached DISTINCT query (the IR carries values as stated). FX conversion, LOD and
  parameter replay are not in the IR: route or refuse them before the adapter.
- **To verify on real engines (L2.8).** Only DuckDB executes here; the other five are golden shapes:
  ClickHouse `match()` over UTF-8 and `{p:Type}` values; `TRIM(x, chars)` on BigQuery and
  Snowflake, `btrim` on Databricks and Redshift; Snowflake under `WEEK_START = 1`; Databricks
  `trunc(d, 'WEEK')`; the tie order of text under each engine's collation.
