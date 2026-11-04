# Semantic layer part 5 (metrics depth) — implementation plan index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan below task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implement the plans in the order of the table below, one PR each.

**Goal:** Build part 5 of Ordinate's semantic layer: distinct counts on every engine, period metrics (to date, last N, change on the previous period or year), per-account snapshots, funnel metrics, and targets with pro-rating and status, on tiles, scorecards, charts, alerts and agents.

**Architecture:** Only `countd` is new arithmetic, with a JS reference, a resident twin and Live parity. Everything else is a definition the server rewrites into scopes the existing doors answer (`resolveMetric` → `computeCardMetric`, `vizDataFor`), so Live, row rules, terms, the answer cache and `asOf` come free. Two exceptions, each with its own JS reference and resident twin: per-account snapshots need a row-level partition (a DuckDB temp table read through `withRelationAsync`), and funnel metrics need one new engine input (entry filters). Every new stored shape first ships in a readers release (5A) that keeps it and computes none of it.

**Tech Stack:** TypeScript server (`src/`), DuckDB resident queries, the Live compiler (`src/engine/live/`, six dialects), React 19 (`web/`), self-check suites, Vitest, Playwright.

**Spec:** [docs/semantic-layer/05-metrics-depth.md](../../semantic-layer/05-metrics-depth.md) (approved 2026-11-03; owner's answers 1–3 binding). Builds on part 1: D7 additivity (`additivityOf`, step 02), D8 snapshot (step 07), D9 `timeColumn` (`metricDate`, `metricScope`, step 04), D16 charts follow their metric (`planMetricMeasures`/`followMetricMeasures`, step 03), and 05b's terms and tile `notes`.

## The PR chain

Two releases. **5A ("keep what's coming")** is step 01 alone: every pod then keeps every part-5 shape through every save and computes none of it. **5B** holds the rest. The owner may cut 5A together with part 1's release 2 (it only adds readers). 5A must be rolled out on every pod before any 5B writer reaches a release; step 04, the first writer, checks it at merge.

| # | PR branch | Plan | Needs merged first | Release |
|---|---|---|---|---|
| 1 | `feat/semantic-p5-01-readers` | [01](2026-11-04-semantic-layer-p5-01-readers.md) | part 1's `feat/semantic-p1-10-data-model-section` | 5A |
| | **owner cuts 5A, and it rolls out everywhere** | | | |
| 2 | `feat/semantic-p5-02-countd-engines` | [02](2026-11-04-semantic-layer-p5-02-countd-engines.md) | 01 | 5B (writes nothing; may ride in 5A) |
| 3 | `feat/semantic-p5-03-countd-live` | [03](2026-11-04-semantic-layer-p5-03-countd-live.md) | 02 | 5B (writes nothing) |
| 4 | `feat/semantic-p5-04-countd-editors` | [04](2026-11-04-semantic-layer-p5-04-countd-editors.md) | 03, **5A rolled out** | 5B |
| 5 | `feat/semantic-p5-05-period-tiles` | [05](2026-11-04-semantic-layer-p5-05-period-tiles.md) | 04 | 5B |
| 6 | `feat/semantic-p5-06-period-charts` | [06](2026-11-04-semantic-layer-p5-06-period-charts.md) | 05 | 5B |
| 7 | `feat/semantic-p5-07-snapshot-per-entity` | [07](2026-11-04-semantic-layer-p5-07-snapshot-per-entity.md) | 06 | 5B |
| 8 | `feat/semantic-p5-08-funnel-metrics` | [08](2026-11-04-semantic-layer-p5-08-funnel-metrics.md) | 07 (uses 06's `bucketSeries`) | 5B |
| 9 | `feat/semantic-p5-09-targets` | [09](2026-11-04-semantic-layer-p5-09-targets.md) | 08 | 5B |
| 10 | `feat/semantic-p5-10-target-charts-alerts` | [10](2026-11-04-semantic-layer-p5-10-target-charts-alerts.md) | 09 | 5B |

The spec's build order is kept; its step 9 is split into 09 (model, tiles, scorecards) and 10 (charts, alerts), as the spec's own "then" says.

## Rolling deploys: every new stored shape

| Shape | Pod older than 5A | 5A pod | Old browser tab |
|---|---|---|---|
| `countd` on a metric, chart measure, pivot value | `sum`, saved back | kept; KPI "—", chart refuses | keeps the value its select holds |
| `countd` on a dashboard KPI card / stored answer spec | card / measure dropped | kept; "—" / refused | — |
| `countd` in a Prepare group step | aggregation dropped; a refresh writes a table without it | kept; the run refuses (typed), nothing written | — |
| `countd` on an alert rule | rule deleted on the next evaluation tick (`alerts.json` is rewritten whole) | kept; skipped, state untouched | — |
| funnel / period definition kinds | `{ column: '', aggregation: 'sum' }`, saved back | kept; "—"; charts refuse | the save is a 400 (strict contract), nothing lost |
| `snapshot.per` | dropped: a **wrong figure**, then saved back | kept; "—"; charts refuse | an editor without `per` keeps the stored one (step 07's merge) |
| `Metric.target` | dropped on the next save | kept; not shown | no `target` key keeps it; `null` clears |
| alert `compare: 'target'` + `targetPct`; a rule with no column and a `metricId` | rule deleted | kept; skipped | — |
| `countd(col)` in a formula string | kept verbatim; no figure | same | — |
| `FunnelEncoding.entry`, `series[].target`, tile `target`/`periodRange`, rule `metricGone` | runtime / reply only, never stored | — | an old tab draws a target series as a plain overlay |

A rollback below 5A once such metrics exist turns them into `sum` or drops them; `docs/server/upgrade.md` says so (step 01, Task 5).

## Global Constraints

- No push, `gh` command or release on weekdays 08:00–18:00 local time (the owner's global rule, enforced by a hook). No release, `v*` tag or image push without the owner.
- One worktree per PR off `origin/develop` (`feature-branch-workflow` skill); never commit to `develop`; never `git checkout`/`git switch` in the shared clone. No `Co-Authored-By` or AI trailer on any commit.
- No new runtime dependency, no migration, no new contract channel (only arms and fields on existing contracts), so `scripts/rowPolicyReaders.ts` is untouched; `node scripts/check-contracts.js` 0 unresolved.
- File caps 500/800. Near the cap: `src/ipc/visuals.ts` (773 before part 1's release 2: steps 01–10 add **one** line in total), `src/analysis/pivotData.ts` 739, `src/analysis/visuals.ts` 707, `src/data/transforms.ts` 690, `src/engine/residentQuery.ts` 675, `src/ai/answerSpec.ts` 639, `src/analysis/alertStore.ts` 636, `src/analysis/alerts.ts` 623, `src/ipc/metrics.ts` 563, `src/analysis/metrics.ts` 475. New logic goes in new files; these take calls.
- Two implementations agree with `Object.is`: `countd` (JS, resident, Live parity on the DuckDB bench, ClickHouse and Postgres suites, golden shapes for six dialects), entry-filtered funnels, per-account snapshots. Every guard has a negative control. Golden fixtures are never re-recorded; with nothing new set, every reply is byte-identical.
- Sentences through `t()` (`MAIN_FILES`, then `node scripts/i18n-extract.js`); the React UI is English-only. `npm run lint` 0.

## Review Focus

1. **Mixed versions:** an old pod re-saving or re-evaluating a record with a new shape (01's matrix, above). Owner: 01, each with a "re-save keeps it" test and an "evaluation tick leaves it byte-identical" test for alerts.
2. **A figure that adds what can't be added:** `countd` across categories or time, a window across time, "Other" folded from counts on Live. Owners: 02 (calcs, overlay), 03 (Live levels, fixture-sensitive negative control), 06 (period calcs).
3. **The wrong things compared:** the whole plan against a filtered actual, a target visible under one-sided row rules, the scope applied to every funnel event. Owners: 09, 08.
4. **Chart point = tile:** period buckets, funnel entry weeks, target buckets are each a tile resolution by construction. Owners: 06, 08, 10.
5. **Live:** `countd` compiles or refuses typed; period charts send ≤ 24 statements + one axis probe; funnels and per-account snapshots refuse typed. Owners: 03, 06, 08, 07.

## Interfaces other parts consume

- `src/data/aggregations.ts` (01): `AGGREGATIONS`, `Aggregation`, `PLAIN_AGGREGATIONS`, `NUMBER_AGGREGATIONS`, `isAggregation`, `isCountLike`; `scripts/test-aggregationList.ts` forbids any other list in `src/`.
- Definition kinds (01): `MetricFunnelDefinition`/`sanitizeFunnelDefinition` (`src/analysis/funnelMetric.ts`), `MetricPeriodDefinition`/`MetricWindow`/`MetricCompare`/`sanitizePeriodDefinition` (`periodMetric.ts`), `MetricTargetSpec`/`sanitizeTarget` (`metricTarget.ts`), `MetricSnapshot.per`, `isSimpleDefinition`/`isFunnelDefinition`/`isPeriodDefinition`, `Metric.target`; `pendingMetric` (`pendingKinds.ts`). Part 7 maps these 1:1 to MetricFlow's `count_distinct`, cumulative, conversion and `window_groupings`; parts 3 and 4 describe and certify them.
- `countDistinct(cells, type)` / `countDistinctSql(p, type)` (02); `SqlDialect.countDistinct` and refusal `distinctByWeekCalendar` (03).
- `windowedScope`, `windowRange`, `pctChange` (`src/analysis/periodMath.ts`, 05); `ResolvedMetric.periodRange`, `.notes`.
- `bucketSeries` (`src/ipc/metricBuckets.ts`), `bucketRange`, `fillBuckets` (06): the per-bucket loop for any metric figure on a date axis; `PlanResult.special` for measures that chart alone.
- `withSnapshotRows` (`src/engine/snapshotResident.ts`, 07): a filtered, window-qualified temp relation any resident query can read.
- `FunnelEncoding.entry` (08).
- `metricTarget`, `targetPlan`, `TargetResult` (`src/ipc/targetResolve.ts`), `periodParts`, `planAsks` (`src/analysis/targetMath.ts`) (09); the `{ role: 'overlay', target: true }` series and `compare: 'target'` alerts (10).

## Calls made while planning (the owner's answers applied; listed so a reviewer knows they are deliberate)

- **5A holds only step 01;** 02 and 03 write nothing and may ride in either release; 04 is the first writer and carries the gate.
- **The `=== 'count'` inventory moves from step 1 to step 02**, as a classifying ratchet (`scripts/countSites.ts`) rather than a blanket `isCount()` script: of 43 sites, about 10 mean "counts cells, never money" (FX, type gates, scenarios) and become `isCountLike`; the rest are compute branches, labels, or surfaces that never take `countd` (maps, drivers, rebuild, the Prepare pivot step, LOD). Replacing all 43 would compute counts as distinct counts.
- **The aggregation lists are 29, not ten,** and three are deliberate subsets kept outside the one module with a reason: the LOD grammar's `LOD_AGGS`, maps' `GEO_AGGS`, and the Prepare pivot step (which never takes `countd`).
- **A Prepare group step does take `countd`** (D2): a 5A pod refuses the run with a typed error rather than skipping the step, since `foldStep` would otherwise leave an ungrouped table.
- **KPI doors show "—" for a pending shape**, as part 1's 02a does for snapshots; charts and answer cards say why.
- **Live SQL for `countd`:** CTEs grouped from `lv_base`, joined back null-safe; not `GROUPING SETS`.
- **A period or funnel measure charts alone** (one measure, no split, no facets, no pivot), refused with a sentence otherwise.
- **A period metric counts by its base's date** and stores no `timeColumn`; **a funnel metric counts by `funnel.time`** when it is a date column.
- **The period sparkline** is drawn through the bucket loop (month grain, 12 points); `resolveMetricSeries`' label filters would give "to today" at every point.
- **Per-account snapshots** are a real row-level path (part 1 composed doors around one day, which can't express a day per account), and v1 refuses them with FX conversion, parameter-replayed pipelines or related-table filters (`shortcut:` comment).
- **Targets:** the covered range ends at today (that is what makes Nov 1–20 pro-rate); row rules compare `rowLockFor` on both datasets; segments use `joinPlan.resolveColumnOwner`; `metric_value` has no scope argument, so it reports "Pick a period" for an additive target.
- **Target series** are not drawn on `/p/` pages and stories (they draw no overlays today); `/p/` KPI tiles carry the target.
- **"Exported as `count_distinct`"** is left to part 7's export.

## Where the approved design and the code disagree

- **D2 "five dialects":** six compile (snowflake, bigquery, redshift, databricks, clickhouse, duckdb); Postgres runs `redshift`. No dialect method spells aggregates today; `countDistinct` is new. `compile.ts:252` already sends `count(DISTINCT …)` to ClickHouse for the grain probe, harmlessly.
- **D11 "resident twin in P1-D8's module":** part 1's step 07 has no row-level SQL twin (it composes doors), so step 07 here adds one.
- **D6 vs D7, flagged for the owner:** "the bar for Germany equals the tile filtered to Germany" and "entered and converted add across categories" cannot both hold for an entity whose step-1 events carry two countries. The plan keeps D7's breakdown (bars add up) and pins the edge in a test.
- **D14 "a stepped line":** the web has no stepped rendering (`web/src/charts`); step 10 adds one for target overlays.
- **Dependencies:** part 1 already moves scorecards and sparklines to `timeColumn` (its step 04, Task 7), so step 05 here does not.

## Execution

Implement in the table's order. For each PR: create its worktree off `origin/develop`, implement the plan's tasks with their tests, run the listed suites, push and open the PR outside work hours, wait for CI and the owner's merge, then start the next.
