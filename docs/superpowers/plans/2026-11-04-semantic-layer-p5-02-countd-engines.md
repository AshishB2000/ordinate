# Semantic layer part 5, step 02: `countd` in the JS reference and the resident engine — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count distinct non-empty values (D1) on extract datasets everywhere an aggregation is computed — KPIs, charts, pivots and their subtotals, joins, Prepare's group step — with one JS function and one SQL spelling held to `Object.is`, never converted by FX, never added up by a table calculation or the overlay caption.
**Architecture:** One pure function (`src/analysis/countDistinct.ts`) is the reference; `metricValue.computeMetric` and `transforms.aggregate` each call it in one line, which carries it to `vizData`, `pivotData`, facets and Prepare. One SQL helper (`src/engine/countDistinctSql.ts`) is the twin; `residentQuery.aggExpr` calls it in one line, which carries it to every resident chart, KPI, pivot and join. The ~43 `=== 'count'` checks are classified once by a ratchet (`scripts/countSites.ts`): the ones that mean "counts cells, any column type, never money" become `isCountLike`, the rest stay and are named.
**Tech Stack:** TypeScript (`src/analysis`, `src/data`, `src/engine`, `src/ipc`), DuckDB, self-checks.
**Spec:** docs/semantic-layer/05-metrics-depth.md (D1, D2 JS and resident, D3) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p5-00-index.md
**Branch and PR:** `feat/semantic-p5-02-countd-engines` off `origin/develop` after step 01 merges. One PR. Writes nothing new, so it may ship in release 5A or 5B.

## Global Constraints

- **The rule (D1):** text counts distinct strings as stored (case-sensitive, untrimmed), not counting `null`, `''` or whitespace-only; number counts distinct finite numbers (`1`/`1.0` one value, `-0`/`0` one value), not counting `null` or a non-number cell; date counts distinct **days** read by `dateIntel.periodDay` (`:149`, ISO or US, a time after the date ignored), not counting an unreadable cell. An empty scope is `0`.
- The column's **declared** type decides (`ParsedColumn.type`), never a cell's look. LOD `COUNTD` (`src/formula/lod.ts:74-78`, `src/engine/lodResident.ts:56-57`) is not changed: it counts date spellings, and changing it would change saved figures (Non-goals).
- JS and resident agree with `Object.is` on every case. Resident fixtures have ≥ 1,000 rows (`RESIDENT_MIN_ROWS`, `src/ipc/dashboards.ts:101`).
- `src/data/transforms.ts` (690), `src/engine/residentQuery.ts` (675), `src/analysis/pivotData.ts` (739) and `src/analysis/vizData.ts` (523) take one-line calls or type widenings only.
- Live is unchanged here: `LIVE_AGGS` is still five, so a Live `countd` is the typed `unknownAggregation` refusal (`liveSpec.ts:214`) until step 03.
- Commits carry no Co-Authored-By or AI trailer.

## Review Focus

- **`-0` and `0` in SQL.** DuckDB's `count(DISTINCT DOUBLE)` is not relied on for signed zero: the twin adds `0.0` (`-0.0 + 0.0 = +0.0` in IEEE 754). Pinned in Task 1.
- **FX on pivots.** `fxQuery.measuresOf` (`src/ipc/fxQuery.ts:198-200`) treats every pivot value as money, a `count` included. This PR exempts count-like pivot values too. That changes a pivot `count` over an FX dataset with missing rates (today a missing rate empties the cell before counting). Pinned in Task 3 and named in the CHANGELOG.
- **The "Other" fold** folds rows before aggregating on both paths (`vizData.capText :302-336`, `residentQuery.textKey :435-473` → `aggregateSql :543-555`), so a distinct count of "Other" is exact, never a sum of the folded categories' counts. Pinned in Task 2.
- **The additivity rule (part 1's step 02)** already answers "not additive" for any aggregation it does not list as additive; this PR only adds tests. If part 1 wrote a closed `switch`, add `countd` to its `false` branch.

---

### Task 1: The reference and its twin

**Files:** Create `src/analysis/countDistinct.ts`, `src/engine/countDistinctSql.ts`, `scripts/test-countDistinct.ts`. Modify `src/analysis/metricValue.ts:47-56` (one branch), `src/data/transforms.ts:564-570` (one branch, and remove step 01's `PendingError` throw), `src/engine/residentQuery.ts:212-221` (`metricStmt` takes `AGGREGATIONS`) and `:608-618` (`aggExpr` branch). Delete `src/data/pendingError.ts`, its `foldStep` rethrow and its `app.ts` branch (step 01) if nothing else uses them (`grep -rn PendingError src`).
**Interfaces:** Produces
```ts
export function countDistinct(cells: Iterable<Cell>, type: ColumnType): number      // countDistinct.ts
export function countDistinctSql(p: string, type: ColumnType): string               // countDistinctSql.ts
//   number: `CAST(count(DISTINCT ${sqlNum(p)} + 0.0) AS DOUBLE)`                        (sqlNum: residentCategory.ts:56)
//   date:   `CAST(count(DISTINCT ${sqlPeriodDate(p)}) AS DOUBLE)`                       (periodSql.ts:31)
//   text:   `CAST(count(DISTINCT CASE WHEN NOT ${sqlEmpty(p)} THEN ${p} END) AS DOUBLE)` (sqlEmpty: sqlGen.ts:89-91)
```
The JS keys: text the cell as a string when `!isEmptyCell(cell)` (`transforms.ts:190`); number `typeof v === 'number' && Number.isFinite(v)` into a `Set<number>` (SameValueZero joins `-0` and `0`); date `periodDay(cell)` when not null.
- [ ] **Step 1: Write the failing test.** `scripts/test-countDistinct.ts`. A pure section, then a resident one: save each case as a 1,200-row dataset (the case's cells repeated, plus filler rows in another `grp` value) through `datasets.saveDataset`, and compare `computeMetric` on the hydrated rows with `computeMetricResident` on `datasets.residentSource`, with `Object.is`.
  ```ts
  const CASES: Array<[string, 'text' | 'number' | 'date', Cell[], number]> = [
    ['text: case, padding, blanks', 'text', ['a', 'A', ' a', 'a ', '', '   ', null, 'a'], 4],
    ['number: 1 = 1.0, -0 = 0', 'number', [1, 1.0, -0, 0, 2.5, null, 'n/a'], 3],
    ['date: both shapes, with times, unreadable', 'date', ['2024-03-01', '03/01/2024', '2024-03-01T10:00:00', '2024-03-02', 'soon', '', null], 2],
    ['empty scope', 'text', [], 0],
  ];
  for (const [name, type, cells, want] of CASES) ok(`JS ${name}`, Object.is(countDistinct(cells, type), want));
  for (const [name, type, cells] of CASES) ok(`resident = JS: ${name}`, Object.is(await resident(type, cells), countDistinct(cells, type)), show(...));
  ok('resident ran in place, not the JS fallback', trace.snapshot().metric.resident > before);
  ok('NEGATIVE CONTROL: plain count is not countd', computeMetric(C, R, { column: 'v', aggregation: 'count' }) !== computeMetric(C, R, { column: 'v', aggregation: 'countd' }));
  ok('Prepare group step: countd per group', isDeepStrictEqual(applyPipeline(T, [{ type: 'group_aggregate', groupBy: ['grp'], aggregations: [{ column: 'v', fn: 'countd', as: 'n' }] }]).rows, WANT_GROUPS));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-countDistinct.js` → "Cannot find module '../src/analysis/countDistinct'".
- [ ] **Step 3: Implement** to the signatures. In `aggExpr`, `if (fn === 'countd') return countDistinctSql(phys(ci), cols[ci].type);` before the plain check.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-countDistinct.js scripts/test-residentQuery.js scripts/test-transforms.js scripts/test-metrics.js scripts/test-file-size.js` → 0 failures. In `scripts/test-residentQuery.ts:71` add `'countd'` to `AGGS`, so `diffMetric` covers it too.
- [ ] **Step 5: Commit.** `git add src/analysis/countDistinct.ts src/engine/countDistinctSql.ts src/analysis/metricValue.ts src/data src/engine/residentQuery.ts src/server/app.ts scripts/test-countDistinct.ts scripts/test-residentQuery.ts && git commit -m "Count distinct non-empty values, in JS and in place, held to Object.is"`

### Task 2: Charts, pivots, joins and "Other"

**Files:** Modify `src/analysis/vizData.ts:162,198,319` and `src/analysis/pivotData.ts:351-355` (widen the literal casts to `Aggregation`), `src/analysis/pendingKinds.ts` (step 01: drop the `countd` half of `pendingMeasureRefusal` and `pendingSpecRefusal`; keep the kind half), `src/ipc/dashboards.ts` `computeCardMetric` (drop step 01's `countd` shortcut), `src/analysis/alerts.ts` `canEvaluate` (drop the `countd` half). Test: `scripts/test-countDistinct.ts`, section "doors".
**Interfaces:** Consumes Task 1. No new names.
- [ ] **Step 1: Write the failing test.** Fixture `ORDERS`: 1,200 rows; `customer_id` text (300 distinct, each in exactly one of 60 `city` values, so "Other" past 50 applies), `region` text (4), `day` date (both shapes), `amount` number. A related `CUSTOMERS` dataset (one row per id, `segment`) and a relationship `ORDERS.customer_id → CUSTOMERS.customer_id`. The reference for a chart cell is `countDistinct` over the rows of that cell, computed in the test from `ROWS`.
  ```ts
  const M = { column: 'customer_id', aggregation: 'countd' };
  const byCity = await chart({ category: 'city', values: [M] });
  ok('"Other" is the distinct count of its rows, not a sum of its cities', Object.is(byCity.data.series[0].values[byCity.data.labels.indexOf('Other')], refOther()));
  for (const enc of [{ category: 'region', values: [M] }, { category: 'day', grain: 'month', values: [M] }, { category: 'day', grain: 'month', series: 'region', values: [M] }])
    ok(`resident = JS: ${JSON.stringify(enc)}`, sameCells(await chart(enc), await withoutResident(() => chart(enc))));
  const pv = await chart({ category: 'region', values: [M], pivot: { rows: [{ column: 'region' }], columns: [{ column: 'day', grain: 'quarter' }], values: [M] } });
  ok('pivot subtotal and grand total are distinct counts of their rows', Object.is(grandTotal(pv), 300) && subtotals(pv).every((v, i) => Object.is(v, refRegion(i))));
  ok('pivot: resident = JS', sameCells(pv, await withoutResident(() => chart(pivotEnc))));
  ok('KPI equals the chart total by region only where regions do not share customers', Object.is((await kpi(M, [])), 300));
  ok('a related filter counts over the main table\'s rows in scope ("customers who ordered")', Object.is(await kpi(M, [eq('segment', 'Pro')]), refPro()));
  ok('NEGATIVE CONTROL: sum of the per-region bars is not the KPI when customers cross regions', /* the second fixture, CROSS, where 40 customers order in two regions */ sumBars(await chartOn(CROSS, { category: 'region', values: [M] })) !== (await kpiOn(CROSS, M, [])));
  ```
  `withoutResident` stubs `residentQuery.isResident = () => false` and invalidates the answer cache (`H.queryCache.invalidateDataset`), as `scripts/test-chartsFollowMetric.ts` does.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-countDistinct.js` → the chart is refused with step 01's `countdPending` sentence.
- [ ] **Step 3: Implement** as listed.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-countDistinct.js scripts/test-pivotData.js scripts/test-vizData.js scripts/test-joins.js scripts/test-part5Readers.js` (rewrite step 01's countd refusal assertions there as the opposite: a figure) `scripts/test-file-size.js`.
- [ ] **Step 5: Commit.** `git add src/analysis src/ipc/dashboards.ts scripts/test-countDistinct.ts scripts/test-part5Readers.ts && git commit -m "Chart, pivot and join a distinct count, with Other folded before counting"`

### Task 3: Count-like, once: FX, formats and the count-site ratchet

**Files:** Create `scripts/countSites.ts`, `scripts/test-countSites.ts`. Modify the **count-like** sites to `isCountLike(agg)` (from `src/data/aggregations.ts`):
- FX exemptions: `src/ipc/dashboards.ts:173`, `src/ipc/fxQuery.ts:198` and its pivot loop `:199-200`, `src/ipc/liveRoute.ts:106`.
- Column-type gates: `src/analysis/metricCheck.ts:135` (a count needs no number column). `chartFormat.ts:104` (`measureNames`) is a `name` site: a countd series is named `countd of <column>`. D1's whole-number default needs no code: a metric's format already defaults to 0 decimals (`sanitizeFormat`, `metrics.ts:189`).
- Scenarios (a count does not move with a value driver): `src/analysis/scenarioResolve.ts:201,429,433`, `src/ipc/scenarios.ts:116`.

Every other match stays and is classified in `COUNT_SITES` as `countOnly` (it means `count` alone: a compute branch beside countd's own, a surface that never takes countd — maps, drivers, rebuild, the Prepare pivot step, LOD, Live until step 03, the additive checks in `answers.ts:187`/`liveAnswers.ts:185`) or `name` (a series or field label). `scenarioModel.ts:214` is a compute branch: add `if (aggregation === 'countd') return countDistinct(...)` beside it.
**Interfaces:** Produces `COUNT_SITES: Readonly<Record<string, { count: number; how: 'countOnly' | 'name' }>>` keyed by repo path, the same ratchet as `scripts/termSites.ts`.
- [ ] **Step 1: Write the failing test.** `scripts/test-countSites.ts` scans `src/**/*.ts` and `web/src/**/*.{ts,tsx}` (no tests, no `.js`) for `/[!=]==\s*['"]count['"]/`. `ok(\`${file}: ${n} site(s), classified ${entry?.count}\`, entry?.count === n)` for each file with matches, and fails on a file with matches and no entry. NEGATIVE CONTROL: a planted `src/__countProbe.ts` with `a === 'count'` fails, and is deleted in `finally`. In `scripts/test-countDistinct.ts`, section "money":
  ```ts
  ok('a countd over a money column is never converted', Object.is((await kpiFx({ column: 'amount', aggregation: 'countd' })).value, countDistinct(AMOUNTS, 'number')) && (await kpiFx(...)).fx === undefined);
  ok('NEGATIVE CONTROL: its sum is', (await kpiFx({ column: 'amount', aggregation: 'sum' })).fx !== undefined);
  ok('a pivot countd value is not money either', (await chartFx(PIVOT_COUNTD_ENC)).fx === undefined);   // fxQuery.measuresOf (:197) is private: read the reply
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-countSites.js scripts/test-countDistinct.js` → every file unclassified; the countd KPI carries `fx`.
- [ ] **Step 3: Implement.** Convert the count-like sites, then fill `COUNT_SITES` from the scan, one entry per file, with a one-line reason comment per `countOnly` group.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-countSites.js scripts/test-countDistinct.js scripts/test-fxResident.js scripts/test-fx.js scripts/test-scenarios.js scripts/test-metricCheck.js && npm run lint`.
- [ ] **Step 5: Commit.** `git add scripts/countSites.ts scripts/test-countSites.ts scripts/test-countDistinct.ts src && git commit -m "Treat count distinct as a count wherever a count is never money, and classify every other count check"`

### Task 4: It never adds up (D3)

**Files:** Modify `src/analysis/additivity.ts` only if part 1's step 02 enumerated aggregations in a closed list. Test: `scripts/test-additivity.ts` (part 1's), section "countd".
**Interfaces:** Consumes `aggregationAdditivity`, `refuseNonAdditiveCalcs`, `measureAdditivity` (part 1, step 02).
- [ ] **Step 1: Write the failing test.**
  ```ts
  ok('countd adds across neither', same(A.aggregationAdditivity('countd'), false, false));
  const M = { column: 'customer_id', aggregation: 'countd' };
  ok('running total over countd → refused', (await chart({ category: 'day', grain: 'month', values: [{ ...M, calc: RT }] })).code === 'calc_not_additive');
  ok('share of total over countd → refused', (await chart({ category: 'region', values: [{ ...M, calc: { kind: 'pct_of_total', along: 'across' } }] })).code === 'calc_not_additive');
  ok('NEGATIVE CONTROL: the same over count runs', (await chart({ category: 'day', grain: 'month', values: [{ column: 'customer_id', aggregation: 'count', calc: RT }] })).ok === true);
  const ov = await chart({ category: 'day', grain: 'month', overlay: 'previous_year', values: [M] }, { filters: FEB_2024 });
  ok('overlay over countd: the series, no caption', ov.ok && ov.data.series.some((s) => s.role === 'overlay') && ov.overlay?.caption === undefined);
  ok('a diff over countd is not adding', (await chart({ category: 'region', values: [{ ...M, calc: { kind: 'diff', along: 'across' } }] })).ok === true);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-additivity.js` → if part 1 used an open rule these pass at once; then this task is tests only. Otherwise "countd adds across neither" fails.
- [ ] **Step 3: Implement** (only if needed): `countd` joins the `false` branch.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-additivity.js scripts/test-tableCalc.js scripts/test-compareSeries.js`.
- [ ] **Step 5: Commit.** `git add scripts/test-additivity.ts src/analysis/additivity.ts && git commit -m "Pin that a distinct count is never added up by a calculation or the overlay caption"`

## Existing tests that must stay green

`test-residentQuery`, `test-vizData`, `test-pivotData`, `test-lod-resident` (LOD COUNTD unchanged), `test-fx`, `test-fxResident`, `test-joins`, `test-transforms`, `test-pipelineResident`, `test-sqlGen`, `test-metrics`, `test-alerts`, `test-additivity`, `test-tableCalc`, `test-part5Readers`, `test-aggregationList`, `test-liveCompile` (Live still refuses countd), `test-liveRoute`, `test-asyncReach`, `test-file-size`, `npm run lint`. Add to CHANGELOG `[Unreleased]`: "A pivot count over a multi-currency dataset is no longer converted as money."
