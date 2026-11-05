# Semantic layer part 5, step 03: `countd` on Live datasets — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Live dataset answers a distinct count in the warehouse with the same figure the extract path gives (step 02), on every dialect, at every level the statement ranks or folds at, and refuses it with a sentence where the compiler would have to add distinct counts up.
**Architecture:** The compiler builds measures from re-aggregable parts (`partsOf`/`AGG_OF`/`REAGG_OF`, `src/engine/live/compile.ts:74-85,164-166`) and re-aggregates them three times: ranking categories across series (`totalOver :283-294`), folding "Other" (`compileChart :354-374`), and the final category and series totals (`lv_fin`). A distinct count survives none of that, so a `countd` measure gets its own part `d` whose value at each of those levels is **counted again from `lv_base`** in its own CTE, joined back by key. The one dialect difference is a new `SqlDialect.countDistinct` (ClickHouse `uniqExact`). The week-calendar date axis, which rolls days up in JS (`shape.ts` `rollUp :296-341`), refuses `countd`.
**Tech Stack:** `src/engine/live/` (compile, shape, evaluate, liveSpec, six dialects), `src/engine/liveRefusals.ts`, the parity kit (`scripts/liveParityMatrix.ts`), `scripts/test-liveCompile.ts`.
**Spec:** docs/semantic-layer/05-metrics-depth.md (D2 Live, "Left to the builder" bullet 1, Tests "Distinct") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p5-00-index.md
**Branch and PR:** `feat/semantic-p5-03-countd-live` off `origin/develop` after step 02 merges. One PR. Writes nothing new.

## Decisions made here (the spec left them to the builder)

- **CTEs, not `GROUPING SETS`.** Six dialects compile (`CompileDialectId`, `src/connectors/types.ts:149`: snowflake, bigquery, redshift, databricks, clickhouse, and duckdb as the bench; Postgres runs `redshift`, `scripts/liveParityEngines.ts:171-172`). `GROUPING SETS` and its NULL-vs-rolled-up marker differ across them; a CTE that groups `lv_base` by a key and joins back works on all six with the SQL the compiler already writes.
- **The join back is on the key expression, null-safe.** A NULL category or series is a real group (the extract's `''` group). Join with `(a = b OR (a IS NULL AND b IS NULL))`, which every dialect reads; no dialect method.
- **Keys counted:** number `numberOf(c, col) + 0.0` (one `-0`/`0`), date `dateOf(c, col)` (`compileFilter.ts:55`, a day), text `CASE WHEN NOT emptyOf(c, col) THEN textOf(c, col) END` (`:59`, `:93-97`, so whitespace-only is empty, as on the extract). If a warehouse refuses `DISTINCT` over its safe-cast double (BigQuery has, historically, for grouping), that dialect spells the number key as its canonical string of the same double; the golden test and `scripts/warehouseLiveParity.ts` decide it, not this plan.

## Global Constraints

- Live and extract agree with `Object.is` through the parity kit (`parityKit.chartProblems :160-180`, `metricProblems :182-189`): `countd` is not in `TOLERANT` (`:54`), so exact.
- A statement with no `countd` measure compiles byte-identically to today: every golden shape in `scripts/test-liveCompile.ts:74-121` is unchanged.
- `compile.ts` is 455 lines: the distinct CTEs go in a new `src/engine/live/compileDistinct.ts`; `compile.ts` gets the calls.
- A new refusal code joins `LiveRefusalCode` (`liveSpec.ts:121-126`) and `MESSAGES` (`:149-180`), its sentence in `liveRefusals.ts` (in `MAIN_FILES`), then `node scripts/i18n-extract.js`.
- Commits carry no Co-Authored-By or AI trailer.

## Review Focus

- **A split chart ranks categories by the first measure's total across series** (`lv_tot`). For `countd` that total is the distinct count over the category's base rows, never a sum of its series cells. Pinned by a fixture where customers order in two regions.
- **The split top-N cut** (`shape.ts:263`) drops whole groups and re-aggregates nothing, so it needs no change. Confirmed by the parity matrix's split cases.
- **`compile.ts:252`, the grain probe, already sends `count(DISTINCT …)` to every dialect, ClickHouse included.** It counts distinct buckets, where `count_distinct_implementation` cannot change the answer. Leave it.
- **The KPI** (`compileMetric :175-190`) is one aggregate with no `GROUP BY`; over zero rows `count(DISTINCT)` is `0`, the extract's empty answer.

---

### Task 1: The aggregation, the part and the dialect method

**Files:** Modify `src/engine/live/liveSpec.ts` (`LiveAgg :60`, `LIVE_AGGS :61` from `AGGREGATIONS`, `checkMeasure :212-219` lets a count-like measure through on any type), `src/engine/live/compile.ts` (`Part :75`, `partsOf :77-85`, `measureInput :157-162`, `AGG_OF`/`REAGG_OF :164-166`), `src/engine/live/dialect.ts` (`SqlDialect :77-125`), `src/engine/live/dialects/*.ts` (six), `src/engine/live/shape.ts` (`Parts :52`, `emptyParts :78-80`, `addPart :83-90`, `measureValue :93-101`). Test: `scripts/test-liveCompile.ts` (`goldenShapes :74-121`, refusals `:242-277`).
**Interfaces:** Produces `Part = 's' | 'c' | 'n' | 'x' | 'd'`; `partsOf` returns `['d']` for `countd`; `SqlDialect.countDistinct(x: string): string` — `count(DISTINCT x)` on five, `uniqExact(x)` on ClickHouse. `REAGG_OF.d` is never used: Task 2 routes every re-aggregation of a `d` part to `compileDistinct.ts`; until then `compileChart` refuses a `countd` measure with a series or more than 50 text categories (`badQuery`), so this task ships only the KPI and the unsplit chart.
- [ ] **Step 1: Write the failing test.** In `goldenShapes`, a KPI and an unsplit chart of `{ column: 'customer', aggregation: 'countd' }`; the per-dialect `want` fragment is `uniqExact(` for clickhouse and `count(DISTINCT ` for the other five. `ok('every other golden shape is unchanged', ...)` keeps its existing assertions as they are.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveCompile.js` → `unknownAggregation`.
- [ ] **Step 3: Implement** as listed. `measureValue` for `d` returns the part (a NULL part reads `0`, as `count`).
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-liveCompile.js scripts/test-liveParity.js scripts/test-liveRoute.js`.
- [ ] **Step 5: Commit.** `git add src/engine/live scripts/test-liveCompile.ts && git commit -m "Compile a distinct count on Live: the KPI and an unsplit chart"`

### Task 2: Counted again at every level the statement folds or ranks at

**Files:** Create `src/engine/live/compileDistinct.ts`. Modify `src/engine/live/compile.ts` (`compileChart :311-416`: `lv_tot`, `lv_fold`/`lv_out`, `lv_fin` call into it when the first measure, or any measure in the fold, is `countd`). Test: `scripts/liveParityMatrix.ts` (`MEASURES :252-255`, `METRICS :372-375`, answers `:398`), `scripts/test-liveParity.ts`.
**Interfaces:** Produces, in `compileDistinct.ts`,
```ts
export function distinctTotalCte(c: Ctx, name: string, by: string[], v: string): string            // `${name} AS (SELECT ${by}, ${c.d.toDouble(c.d.countDistinct(v))} AS lv_dv FROM lv_base GROUP BY ${by})`
export function nullSafeOn(a: string, b: string): string                                         // `(${a} = ${b} OR (${a} IS NULL AND ${b} IS NULL))`
```
Where each level reads its value:
- **Category rank under a split** (`lv_tot.lv_ct`): `distinctTotalCte(…, 'lv_dct', ['lv_g'], 'lv_v0')`, joined on `lv_g`.
- **"Other"** (`lv_out`): the folded key comes from `lv_fold` as today; the `countd` value of `(lv_k, lv_s)` is `countDistinct` over `lv_base` joined to `SELECT DISTINCT lv_g, lv_k FROM lv_fold` on `lv_g`, grouped by `lv_k, lv_s`. Parts `s/c/n/x` of other measures keep `REAGG_OF`.
- **Final category and series totals** (`lv_fin.lv_ct2`, `lv_st`): the same over the folded key, grouped by `lv_k`, and by `lv_s`.
- [ ] **Step 1: Write the failing test.** In `liveParityMatrix.ts`, `MEASURES` gains `{ column: <text col>, aggregation: 'countd' }`, `{ column: <number col>, aggregation: 'countd' }` and `{ column: <date col>, aggregation: 'countd' }`; `METRICS` gains the same three; the answer list gains one `countd` answer with `top`. The fixture (`scripts/liveParityFixture.ts`) gains a customer text column with more than 50 distinct values in the category used for "Other", where some customers appear under two categories and two series values. In `scripts/test-liveParity.ts`:
  ```ts
  ok('NEGATIVE CONTROL: the fixture can tell a distinct count from a sum of counts', sumOfFoldedCounts(extractByCategory) !== extractOther && sumAcrossSeries(extractSplit) !== extractKpi);
  ```
  With parity holding, that line proves the Live "Other" and the Live split rank are counted from rows, not re-added: a compile that re-added per-category counts would differ from the extract on this fixture.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveParity.js` → the split and "Other" cases are refused (`badQuery`, Task 1's guard).
- [ ] **Step 3: Implement** as specified; drop Task 1's guard.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveParity.js scripts/test-liveCompile.js`; with `CLICKHOUSE_URL` set, `node scripts/test-liveParityClickhouse.js`; with `DATABASE_URL`, `node scripts/test-liveParityPostgres.js`. Expected: 0 problems. Run `scripts/warehouseLiveParity.ts` on Snowflake and BigQuery if credentials exist; otherwise say so in the PR.
- [ ] **Step 5: Commit.** `git add src/engine/live/compileDistinct.ts src/engine/live/compile.ts scripts/liveParityMatrix.ts scripts/liveParityFixture.ts scripts/test-liveParity.ts && git commit -m "Count a Live distinct count again from rows wherever the chart folds or ranks"`

### Task 3: The week-calendar axis refuses it

**Files:** Modify `src/engine/live/liveSpec.ts` (`LiveRefusalCode`, `MESSAGES`), `src/engine/liveRefusals.ts` (a sentence; and `liveUnknownAggregation :69-72`'s doc comment, which lists the five), `src/engine/live/evaluate.ts` (`resolveKey :86-103`: a `days` key with a `countd` measure refuses). Test: `scripts/liveParityMatrix.ts` week-calendar block `:416-423`, `scripts/test-liveCompile.ts` refusals (`all :273-275`).
**Interfaces:** Produces `LiveRefusalCode` `'distinctByWeekCalendar'` and `liveDistinctByWeekCalendar(): string`: `A distinct count can't be drawn by the periods of a week calendar from a live dataset yet. Chart it by day, or make a copy of the dataset.`
- [ ] **Step 1: Write the failing test.** In the week-calendar block, for `'445'` and `'iso'` at grain `month` and with no grain, a `countd` measure gives `{ code: 'live_refused', reason: 'distinctByWeekCalendar' }`, never hydrates, and sends no statement; at grain `day` it answers and agrees with the extract (NEGATIVE CONTROL: `day` is not rolled up). `test-liveCompile`'s `all` list gains the code.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveParity.js` → the month case answers with a summed roll-up.
- [ ] **Step 3: Implement** as specified, then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveParity.js scripts/test-liveCompile.js scripts/test-liveRoute.js scripts/test-liveSafetyNet.js scripts/test-i18n.js`.
- [ ] **Step 5: Commit.** `git add src/engine src/i18n scripts/liveParityMatrix.ts scripts/test-liveCompile.ts && git commit -m "Refuse a Live distinct count by week-calendar periods"`

## Existing tests that must stay green

`test-liveCompile` (every existing golden shape byte-identical), `test-liveParity`, `test-liveRoute`, `test-liveSafetyNet`, `test-liveRouteAnswers`, `test-countDistinct`, `test-countSites` (re-classify `compile.ts:159` and `shape.ts:105` if they moved), `test-aggregationList`, `test-i18n`, `test-file-size`, `npm run lint`.
