# Semantic layer part 5, step 07: snapshots per entity ("each account's own last value") — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `snapshot: { column, take, per }` (D11): after every filter, the row lock and terms, keep each entity's rows on its own latest (or earliest) day — per date bucket when charted by the snapshot's date — then aggregate as usual. MRR is each account's last MRR, summed, even for accounts that last reported in different months.
**Architecture:** Part 1's snapshot (step 07) composes existing doors around one "latest day"; that cannot express a day per entity. So `per` gets a real row-level path, with a JS reference and a resident twin held to `Object.is`. The reference extends part 1's `snapshotRows` (`src/analysis/snapshot.ts`) with an entity partition. The twin (`src/engine/snapshotResident.ts`) writes the kept rows into a DuckDB temp table with one parameterised statement (`QUALIFY day = max(day) OVER (PARTITION BY entity[, bucket])`), registers it through `residentQuery.withRelationAsync` (`src/engine/residentQuery.ts:574`, the hook fx and joins use), and runs the **unchanged** resident KPI and chart aggregate over it. Both entry points are part 1's snapshot doors (`src/ipc/snapshotDoors.ts`): its KPI branch and its chart branch each take `per` first.
**Tech Stack:** `src/analysis`, `src/engine` (DuckDB), `src/ipc`, `src/api` (zod), React (the metric editor), self-checks, Vitest.
**Spec:** docs/semantic-layer/05-metrics-depth.md (D11; Tests "Per entity") and part 1's D8 · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p5-00-index.md
**Branch and PR:** `feat/semantic-p5-07-snapshot-per-entity` off `origin/develop` after step 06 merges. Release 5B.

## Rolling deploy

New stored field: `definition.snapshot.per`. A 5A pod keeps it (step 01: `sanitizeSnapshot`) and shows no figure (`computeCardMetric`'s `per` shortcut, `pendingMetric` on charts); a pod older than 5A would compute the whole-scope latest day, a wrong figure, which is why step 04's gate holds for this PR too. An editor from before this PR sends `snapshot` without `per`: part 1's key-presence merge (`mergeSnapshot`) replaces the stored snapshot with the incoming one, so `per` would be lost. This PR changes the merge: an incoming snapshot with no `per` key keeps the stored `per` when its `column` is the same; `per: null` clears it.

## Global Constraints

- **Partition keys** follow `cohortData.entityKey` (`src/analysis/cohortData.ts:185-188`; SQL `entityKeySql`, `src/engine/cohortResident.ts:50-52`): a number by value, text as stored. Empty entities (null, `''`, whitespace) form **one partition of their own** (D11): a JS sentinel key; in SQL the NULL key is already one partition.
- **The day** is read the way part 1's snapshot reads it, the date axis's way: JS `categoryKey.parseDateCell` (`:105`), SQL `residentCategory.sqlCanonicalDate` (`src/engine/residentCategory.ts:105`); a row with no readable day is dropped first (P1-D8). Ties on the day are all kept.
- **By the snapshot's own date** the partition is (entity, bucket), the bucket being the axis's (`dateBucket`/`dateBucketSql`, `residentCategory.ts:117`). By anything else it is the entity alone.
- **Without `per`, byte-identical to part 1's snapshot** on every path.
- The temp table is created and dropped on the org's own worker through `queryAsync`/`execAsync` only (`.claude/rules/engine.md`), named `snap_<uuid>` with a validated identifier, dropped in `finally`. If creating it fails, the resident path returns null and the JS reference answers.
- **Not combined, refused with a sentence:** a measure needing FX conversion, a parameter-replayed pipeline (`paramTable`, `src/ipc/dashboards.ts:195`) or a filter on a related table (`joinedMetricFor`). `// shortcut: per-entity snapshots read the dataset's own rows only; compose with fxRelationSql / the join relation when asked for`. Live: part 1's `snapshot` refusal already covers it.
- Sentences in `src/analysis/metricCheckMessages.ts`, then `node scripts/i18n-extract.js`. Commits carry no Co-Authored-By or AI trailer.

## Review Focus

- **"After every filter, the row lock and terms":** the temp table's `WHERE` is the door's full filter list (the lock first, terms already expanded), so a restricted viewer's latest day is the latest of rows they may see. Pinned in Task 2 with a lock that hides an account's last month.
- **An account that moved region** counts once, in the region of its latest row. Pinned in Task 1.
- **The caption:** with no period in scope, an account that stopped reporting still counts its last value; the tile says so (part 1's `notes`). Pinned in Task 2.
- **The KPI cache key** (`computeCardMetricUnlocked`, `dashboards.ts:182`) holds `{column, aggregation, filters, params}`. A `per` figure differs from a plain one under the same filters, so the key gains `snapshot` (absent from the key for every other metric, so their keys are unchanged). Pinned in Task 2.

---

### Task 1: The reference and the twin

**Files:** Modify `src/analysis/snapshot.ts` (`snapshotRows` takes `per`). Create `src/engine/snapshotResident.ts`, `scripts/test-snapshotPer.ts` (harness: part 1's `scripts/test-snapshot.ts`).
**Interfaces:** Produces
```ts
// snapshot.ts — part 1's signature; `snap.per` adds the entity to the partition
export function snapshotRows(columns: ParsedColumn[], rows: Cell[][], snap: MetricSnapshot, partition?: (row: Cell[]) => string | null): Cell[][]
// snapshotResident.ts
export async function withSnapshotRows<T>(
  src: ResidentSource, filters: FilterStep[], snap: MetricSnapshot & { per: string }, bucket: DateGrain | null,
  run: (kept: ResidentSource) => Promise<T | null>,
): Promise<T | null>
```
`withSnapshotRows` runs `CREATE TEMP TABLE snap_<uuid> AS SELECT __ord, c0, …, cN FROM (SELECT <ordinal> AS __ord, * FROM <relation> WHERE <filterPredicates(filters)> AND <day> IS NOT NULL) QUALIFY <day> = <max|min>(<day>) OVER (PARTITION BY <entityKeySql(per)>[, <dateBucketSql(day, bucket)>])` with the predicates' params, then `withRelationAsync('snap_<uuid>', 'snap_<uuid>', () => run({ parquetPath: 'snap_<uuid>', columns: src.columns }))`, then drops the table.
- [ ] **Step 1: Write the failing test.** Fixture `MRR`, 1,400 rows: `month` (date, the 1st of each month 2023-01..2024-10, both spellings), `account` (text, 60 accounts; three are `''`, `'  '` and null), `region` (text), `mrr` (integers). Account `A7` stops reporting in 2024-03; `A9` moves from East to West in 2024-06; `A3` has two rows on its last day (a tie). A number-keyed copy `MRRN` with `account` as number ids, `1` and `1.0` the same account.
  ```ts
  const S = { column: 'month', take: 'last', per: 'account' } as const;
  const ref = (rows: Cell[][], part?: (r: Cell[]) => string | null) => snapshotRows(COLS, rows, S, part);
  ok('each account keeps its own last month', ref(ROWS).every((r) => periodDay(r[0]) === lastDayOf(r[1])));
  ok('a stopped account still counts its last value', ref(ROWS).some((r) => r[1] === 'A7'));
  ok('a tie keeps both rows', ref(ROWS).filter((r) => r[1] === 'A3').length === 2);
  ok('empty accounts are one partition, not dropped', ref(ROWS).filter((r) => isEmptyEntity(r[1])).length === rowsOnLastDayOfEmpties);
  ok('A9 counts once, in West', ref(ROWS).filter((r) => r[1] === 'A9').every((r) => r[2] === 'West'));
  ok('without per: part 1\'s rows exactly', same(snapshotRows(COLS, ROWS, { column: 'month', take: 'last' }), PART1_ROWS));
  for (const [name, filters, bucket] of [['no scope', [], null], ['East, 2024', [EAST, Y2024], null], ['by month', [], 'month'], ['by quarter, earliest', [], 'quarter'], ['nothing in scope', [Y1999], null]] as const)
    for (const agg of ['sum', 'count', 'avg', 'max'] as const)
      ok(`resident = JS: ${name}, ${agg}`, Object.is(await residentKpi(S, agg, filters, bucket), jsKpi(S, agg, filters, bucket)));
  ok('number accounts by value', Object.is(await residentKpiOn(MRRN, S, 'count', []), jsKpiOn(MRRN, S, 'count', [])));
  ok('the temp table is gone afterwards', (await duck.queryAsync("SELECT count(*) AS n FROM duckdb_tables() WHERE table_name LIKE 'snap_%'", []))[0].n === 0);
  ok('NEGATIVE CONTROL: per account is not the whole scope\'s last month', jsKpi(S, 'sum', [], null) !== jsKpi({ column: 'month', take: 'last' }, 'sum', [], null));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-snapshotPer.js` → module not found.
- [ ] **Step 3: Implement** to the signatures.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-snapshotPer.js scripts/test-snapshot.js scripts/test-asyncReach.js`.
- [ ] **Step 5: Commit.** `git add src/analysis/snapshot.ts src/engine/snapshotResident.ts scripts/test-snapshotPer.ts && git commit -m "Keep each entity's own latest rows, in JS and in place, held to Object.is"`

### Task 2: Through the KPI and chart doors, with words

**Files:** Modify `src/api/metrics.ts` (part 1's `snapshot` zod object gains `per: z.string().min(1).max(512).nullable().optional()`), `src/analysis/snapshot.ts` (`mergeSnapshot` keeps a stored `per` under the same column), `src/analysis/snapshotProblem` (part 1's, in the same file or `src/ipc/metrics.ts`: `per` must be a column of the dataset and not the snapshot column), `src/ipc/snapshotDoors.ts` (`snapshotCardMetric` and `snapshotAnswer` take `per` first), `src/ipc/dashboards.ts` (drop step 01's `per` shortcut; the cache key gains `snapshot`), `src/analysis/pendingKinds.ts` (`per` is no longer pending), `src/analysis/metricFormat.ts` (words), `src/analysis/metricCheckMessages.ts`. Test: `scripts/test-snapshotPer.ts`, section "doors".
**Interfaces:** Produces
```ts
export async function perEntityCardMetric(projectId: string, datasetId: string, spec: { column: string; aggregation: Aggregation; snapshot: MetricSnapshot & { per: string } }, filters: FilterStep[], params?: ParamValues): Promise<{ ok: boolean; value: number | null; notes?: string[] }>
export async function perEntityChart(projectId: string, datasetId: string, snap: MetricSnapshot & { per: string }, enc: VizEncoding, filters: FilterStep[], opts: VizOpts): Promise<VizDataReply>
// metricCheckMessages.ts
snapshotPerStale(): string         // "Accounts that stopped reporting still count their last value. Pick a period to count only recent ones."
snapshotPerUnsupported(name: string): string   // "“{name}” keeps each account's own latest rows, which can't yet be combined with currency conversion, a parameter in the data's preparation, or a filter on a related table."
snapshotPerNotColumn(per: string): string      // "“{per}” is not a column of this dataset."
```
Words: `sum of mrr, on each account's latest month`. Both functions: `ensureFresh`, then resident (`withSnapshotRows` → `computeMetricResident` / `resolveCatKey` + `aggregateResident`), else the JS reference over `getDataset` (`applyPipeline(filters)` → `snapshotRows` → `computeMetric` / `buildVizData`). `perEntityChart` is cached through `queryCache.through('aggregate', …)` with `snapshot` in the key, under `answerKey.keyParts` as `vizDataForUnlocked` does. `notes = [snapshotPerStale()]` when `scopeRange(filters, [snapshot column])` is null.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const mrr = (await post('metric:save', { projectId: P, input: { name: 'MRR', datasetId: D, definition: { column: 'mrr', aggregation: 'sum', snapshot: S } } })).value.metric;
  ok('KPI = the reference', Object.is(await kpi(mrr, []), jsKpi(S, 'sum', [], null)));
  ok('a KPI with no period says stopped accounts still count', (await resolved(mrr, [])).notes?.includes(msg.snapshotPerStale()));
  ok('NEGATIVE CONTROL: with a period, no such note', !(await resolved(mrr, [Y2024])).notes?.includes(msg.snapshotPerStale()));
  for (const enc of [{ category: 'region', values: [M(mrr)] }, { category: 'month', grain: 'quarter', values: [M(mrr)] }, { category: 'month', grain: 'month', series: 'region', values: [M(mrr)] }])
    ok(`chart = reference, cell by cell: ${JSON.stringify(enc)}`, sameCells(await chart(enc, []), refChart(enc)));
  ok('the region bars add up to the KPI (one partition per account)', Object.is(sum((await chart({ category: 'region', values: [M(mrr)] }, [])).data.series[0].values), await kpi(mrr, [])));
  ok('a row lock hides A7\'s last month: its earlier month counts for that viewer', Object.is(await asRestricted(() => kpi(mrr, [])), jsKpiLocked(LOCK_HIDING_A7_LAST)));
  ok('the cache never serves the plain snapshot for per (same filters)', (await kpi(mrr, [])) !== (await kpi(plainSnapshot, [])));
  ok('an old editor\'s save keeps per', /* metric:update with snapshot { column: 'month', take: 'last' } and no per */ (await metrics.getMetric(P, mrr.id))!.definition.snapshot.per === 'account');
  ok('per: null clears it', /* update with per: null */ !('per' in (await metrics.getMetric(P, mrr.id))!.definition.snapshot));
  ok('per must be a column', (await trySave({ ...S, per: 'nope' })).error === msg.snapshotPerNotColumn('nope'));
  ok('FX is refused with a sentence, not computed', (await kpiFx(mrrUsd, [])).ok === false || (await resolved(mrrUsd, [])).notes?.[0] === msg.snapshotPerUnsupported('MRR (USD)'));
  ok('Live: part 1\'s typed refusal', (await liveKpi(mrrLive)).code === 'live_refused');
  ok('words', describeDefinition(mrr) === "sum of mrr, on each account's latest month");
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-snapshotPer.js` → the contract refuses `per`.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/i18n-extract.js && node scripts/test-snapshotPer.js scripts/test-snapshot.js scripts/test-snapshotReader.js scripts/test-part5Readers.js scripts/test-metrics.js scripts/test-liveRoute.js scripts/test-rowPolicy.js scripts/test-i18n.js scripts/check-contracts.js scripts/test-file-size.js && npm run lint`.
- [ ] **Step 5: Commit.** `git add src scripts/test-snapshotPer.ts && git commit -m "Compute a per-account snapshot through the KPI and chart doors"`

### Task 3: The editor

**Files:** Modify part 1's Snapshot field in `web/src/features/analyses/metrics/MetricEditor.tsx` (a **For each** select after it), `web/src/features/analyses/metrics/api.ts` (`snapshot.per?: string | null`). Test: `web/src/features/analyses/metrics/MetricEditor.test.tsx` (part 1's).
**Interfaces:** **For each**: `''` → "The whole scope", then each text or number column → its name. Hint under it when set: "Each account's own latest row counts, even if it stopped reporting earlier. Pick a period to count only recent ones." The definition sends `per: <col> | null`.
- [ ] **Step 1: Write the failing test.** Choosing "Latest month only" and then "account" saves `snapshot: { column: 'month', take: 'last', per: 'account' }`; choosing "The whole scope" on an existing one saves `per: null`; the select is absent until a snapshot date is chosen (NEGATIVE CONTROL).
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- MetricEditor`.
- [ ] **Step 3: Implement** with the existing `Select` and `s.filterHint`.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run size && npm run lint`.
- [ ] **Step 5: Commit.** `git add web/src/features/analyses/metrics && git commit -m "Choose the account a snapshot keeps its own latest rows for"`

## Existing tests that must stay green

`test-snapshot` and `test-snapshotReader` (part 1's: without `per`, identical), `test-metricMeasures`, `test-additivity`, `test-residentQuery`, `test-fxResident`, `test-joins`, `test-liveRoute`, `test-liveSafetyNet`, `test-rowPolicy`, `test-rowPolicySafetyNet`, `test-part5Readers`, `test-asyncReach`, `test-i18n`, `test-file-size`, `check-contracts`, `npm run test:web`, `npm run lint`.
