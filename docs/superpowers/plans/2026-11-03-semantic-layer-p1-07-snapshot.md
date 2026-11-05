# Semantic layer part 1, step 07: snapshot metrics — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A simple metric can be a snapshot (`snapshot: { column, take: 'last' | 'first' }`): among the rows a figure covers, keep only those on the latest (or earliest) day, per date bucket when charted by its own date and otherwise over the whole scope. It must give the same number on every surface and be refused, typed, on Live.
**Architecture:** No new SQL. A snapshot is composed from the doors that already exist, so their resident paths, JS fallbacks, joins, LOD, parameters, fx, row locks and answer caches all apply unchanged:
1. Find the day: a day-grain chart of the snapshot column through `vizDataFor`, then its latest or earliest label.
2. Ask the ordinary figure restricted to that day: `computeCardMetric` with an added custom `period` filter for a KPI, or `vizDataFor` for a chart by category.
3. On a chart by the snapshot's own date, ask that measure at day grain and keep each bucket's latest day's figure.

The new code is two small door adapters (`src/ipc/snapshotDoors.ts`), pure helpers plus a row-level JS reference (`src/analysis/snapshot.ts`), and the writer: the contract, the store merge and the editor.
**Tech Stack:** TypeScript server (`src/analysis`, `src/ipc`, `src/api`, `src/engine/live`), React (`web/src/features/analyses/metrics`), self-checks, Vitest and Playwright.
**Spec:** docs/semantic-layer/00-design.md (D8, D7, D16, Non-goals "Snapshot metrics on Live tables", "each account's own last value") · Index: docs/superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md
**Branch and PR:** `feat/semantic-p1-07-snapshot` off `origin/develop` (after step 06 merges), one PR to `develop`. **Its release must not reach pods older than step 02's release** (see Rolling deploy).

## Global Constraints

- The JS reference and the door path agree with `Object.is` over the D8 matrix: by month, by category, by both, with filters, with an empty scope, and with dates in both shapes `dateIntel` reads (`YYYY-MM-DD` and `MM/DD/YYYY`). Use whole-number figures, so DuckDB's parallel sum and a JS fold agree exactly (`.claude/rules/engine.md`).
- "Latest" is per time bucket only when the chart's category is the snapshot column. Otherwise it is over everything in scope, never per category (D8, matching dbt `non_additive_dimension` without `window_groupings`).
- Live is a typed refusal: `{code:'live_refused', reason:'snapshot'}` with a catalog sentence, thrown as `LiveFigureError` from the KPI door. No Live statement is sent and `getDataset` is never called.
- Don't add a line to `src/data/transforms.ts` (798/800 after step 04a) or to `src/ipc/visuals.ts` (770 after step 02, plus whatever step 03 adds). The edit in `visuals.ts` rewrites lines 465–466 in place.
- `src/ipc/metrics.ts` (563), `src/analysis/alertStore.ts` (633), `src/ai/answerSpec.ts` (632) and `src/analysis/metrics.ts` (~474 after step 02) get calls of at most 4 lines. Logic goes in new files.
- Sentences: write literals in `src/analysis/metricCheckMessages.ts` and `src/engine/liveRefusals.ts` (both in `MAIN_FILES`), then `npm run build:ts && node scripts/i18n-extract.js`. Removing step 02's `measureSnapshotPending` drops its key on that run.
- Golden fixtures are never re-recorded. A metric without `snapshot` must be byte-identical everywhere, `definitionText` included.
- Commits carry no Co-Authored-By or AI trailer.

## Rolling deploy

The one new stored field is `Metric.definition.snapshot`.
- **An old pod with step 02** keeps the field through rename, tree save, duplicate and `metric:get`. Its strict contract refuses a new client's write with a 400, so nothing changes. It shows "—" for a snapshot KPI (`computeCardMetric`), refuses a snapshot chart measure with a sentence (`build`, plus step 03's simple-metric branch, which step 02 requires to refuse too), and its key drivers refuse it.
- **A pod older than step 02** drops `snapshot` on every `updateMetric`, tree save and duplicate, because `sanitizeDefinition` rebuilds `{column, aggregation}` (`metrics.ts:163-173`). The owner must therefore release step 02 before this step's release reaches a cluster.
- **An old browser tab** (JavaScript from before step 07) saves a definition with no `snapshot` key. Task 1's key-presence merge keeps the stored snapshot; only an explicit `snapshot: null` clears it.
- **During the window, an old pod evaluating an alert** made from a snapshot metric uses the stored copy and computes a plain sum. That lasts for the rollout only.

## Review Focus

- **A region with no rows on the latest day shows no figure, never its own older one.** It has no bar when the snapshot measure is alone, and a null cell when another measure brings the label. Pinned in Task 4.
- **ISO and US spellings of the same day in one column count as the same day.** Pinned in Task 3.
- **An empty scope:** a KPI's `count` is 0 and every other aggregation is null; a chart has no labels. Pinned in Tasks 3 and 4.
- **A chart by a different date column than the snapshot's** is refused with a sentence that names both columns (D9's "refused, never guessed"). Pinned in Task 4.
- **A pivot value naming a snapshot metric** is refused: pivots plot the stored column (`pivotData.ts:69`) and would show a sum over every date. Pinned in Task 4.
- **A text axis over 50 values, or a binned number axis,** needs two questions that cannot be lined up, so the existing `measureNeedsOneAxis` sentence refuses it. Pinned in Task 4.
- **The snapshot day is read the way a date axis reads it** (`categoryKey.parseDateCell`), while the rows on it are kept by the `period` filter (`dateIntel.periodDay`). The two agree on both canonical shapes. A timestamp with a UTC offset can land on another day. Scorecards already have the same seam (`scorecards.ts:158-171`). Put a `shortcut:` comment on `snapshotCardMetric`; no test, because it depends on the machine's time zone.
- **Spec D8 is wrong about alerts.** They evaluate their stored `{column, aggregation}` copy (`alertStore.ts:323`) and never read the metric, so the existing door would not carry a snapshot. Task 6 makes an alert with a `metricId` read its metric's snapshot.
- **The Assistant's answer cards** must not turn a snapshot metric into a bare `{column, aggregation}` measure. Pinned in Task 6.
- **A scenario's column drivers** cannot move a snapshot's rows, so they are not applied and the scenario says so. Pinned in Task 6.
- **Editing the data changes the latest day.** The KPI cache keys on the filters, which include the day, so a refresh can never serve an old day's figure. Pinned in Task 3: the figure follows a row added after the first answer.

---

### Task 1: Write a snapshot (contract, store, words)

**Files:**
- Modify `src/api/metrics.ts:10-13`: the simple branch of `Definition` gains `snapshot: z.strictObject({ column: z.string().min(1).max(512), take: z.enum(['last', 'first']) }).nullable().optional()`.
- Modify `src/analysis/snapshot.ts`.
- Read (do not change) `src/analysis/metrics.ts:413`, `updateMetric`: 02a already merges the snapshot there.
- Modify `src/ipc/metrics.ts:466-497`: the `metric:save` and `metric:update` handlers.
- Modify `src/analysis/metricFormat.ts:81-85` (`describeDefinitionShort`) and `src/analysis/metricCheckMessages.ts`.
- Test: create `scripts/test-snapshot.ts`, section "store".

**Interfaces:** Consumes `MetricSnapshot` and `sanitizeSnapshot` (step 02, Task 1). Produces:
```ts
// mergeSnapshot is NOT redefined here: 02a already ships `mergeSnapshot(incoming: unknown, stored: unknown): MetricSnapshot | undefined`
// in this file (no `snapshot` key → keep the stored one; null → none), and `updateMetric` already calls it through
// `sanitizeDefinition(patch.definition, existing.definition.snapshot)` (src/analysis/metrics.ts:413). Part 5 step 07 extends that one.
export async function snapshotProblem(projectId: string, datasetId: string, def: MetricDefinition): Promise<string | null>
export function snapshotNotDate(column: string): string   // metricCheckMessages.ts
```
`snapshotProblem` returns `msg.snapshotNotDate(column)` when the column is not a `date` column in `getDatasetMeta(...).columns`. Both handlers return `{ ok: false, error, field: 'snapshot' }` for it. `describeDefinitionShort` appends `` `, on the ${take === 'last' ? 'latest' : 'earliest'} ${column}` ``.
- [ ] **Step 1: Write the failing test.** The `scripts/test-snapshot.ts` harness is a temp `ORDINATE_LOCAL_DIR` with `ipcVisuals.register()`, `ipcMetrics.register()` and `handlers`, as in `scripts/test-compareSeries.ts:60-69`. Fixture `STOCK` (also used by Tasks 3–6):
  - Columns `day` (date), `region` (text), `sku` (text), `units` (number) and `counted` (date).
  - Rows every second day from 2023-01-01 for 420 days, for regions East, North and West and skus A and B: 1,260 rows, above `RESIDENT_MIN_ROWS`.
  - `day` is spelled ISO on even rows and `MM/DD/YYYY` on odd rows.
  - West stops 10 days before the end.
  - `units = (d * 7 + r * 13 + s * 5) % 50`, and null when `(d + r) % 17 === 0`.
  - Twelve extra rows with `day` set to `''`.
  - `counted` is the day after `day`, ISO.
```ts
const S = { column: 'day', take: 'last' };
const save = (input: object) => handlers.get('metric:save')!(null, { projectId: pid, input: { datasetId: ds, format: { kind: 'number' }, ...input } });
const update = (id: string, patch: object) => handlers.get('metric:update')!(null, { projectId: pid, id, patch });
ok('contract: save takes a snapshot', api['metric:save'].input.safeParse({ projectId: pid, input: { name: 'S', datasetId: ds, definition: { column: 'units', aggregation: 'sum', snapshot: S } } }).success);
ok('contract: update takes snapshot: null', api['metric:update'].input.safeParse({ projectId: pid, id: ds, patch: { definition: { column: 'units', aggregation: 'sum', snapshot: null } } }).success);
ok('contract: take is last or first', !api['metric:preview'].input.safeParse({ projectId: pid, datasetId: ds, definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'max' } } }).success);
ok('contract: a formula takes none', !api['metric:save'].input.safeParse({ projectId: pid, input: { name: 'S', datasetId: ds, definition: { formula: '[A]', snapshot: S } } }).success);
const r = await save({ name: 'Stock', definition: { column: 'units', aggregation: 'sum', snapshot: S } });
ok('saved with its snapshot', r.ok && isDeepStrictEqual(r.metric.definition.snapshot, S));
const bad = await save({ name: 'Bad', definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'region', take: 'last' } } });
ok('a text column is refused beside the field', bad.ok === false && bad.field === 'snapshot' && bad.error === msg.snapshotNotDate('region'));
await update(r.metric.id, { definition: { column: 'units', aggregation: 'avg' } });
ok('an editor that knows no snapshot keeps it', isDeepStrictEqual((await metrics.getMetric(pid, r.metric.id))!.definition, { column: 'units', aggregation: 'avg', snapshot: S }));
await update(r.metric.id, { definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'first' } } });
ok('words', describeDefinition((await metrics.getMetric(pid, r.metric.id))!) === 'sum of units, on the earliest day');
await update(r.metric.id, { definition: { column: 'units', aggregation: 'sum', snapshot: null } });
ok('null clears it, byte-identical to a plain metric', JSON.stringify((await metrics.getMetric(pid, r.metric.id))!.definition) === '{"column":"units","aggregation":"sum"}');
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-snapshot.js` fails at "contract: save takes a snapshot".
- [ ] **Step 3: Implement.** `updateMetric` keeps 02a's merge as it is (`sanitizeDefinition(patch.definition, existing.definition.snapshot)` → `mergeSnapshot`); only check that the contract change above reaches it. Call `snapshotProblem` in both handlers after the name check. The sentence: `` `${column} is not a date column, so it can't be a snapshot's date.` `` Then run `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-snapshot.js scripts/test-snapshotReader.js scripts/test-metrics.js scripts/check-contracts.js scripts/test-i18n.js` reports 0 failures and 0 unresolved contracts.
- [ ] **Step 5: Commit.** `git add src/api/metrics.ts src/analysis/snapshot.ts src/analysis/metrics.ts src/ipc/metrics.ts src/analysis/metricFormat.ts src/analysis/metricCheckMessages.ts src/i18n scripts/test-snapshot.ts && git commit -m "Let a simple metric be saved as a snapshot of its latest or earliest day"`

### Task 2: The pure pieces and the row-level reference

**Files:** Modify `src/analysis/snapshot.ts`. Test: `scripts/test-snapshot.ts`, section "pure".
**Interfaces:** Produces:
```ts
/** The JS REFERENCE: rows kept by a snapshot. A row's day is parseDateCell(snapshot column); rows with none are never kept.
 *  `partition` (a date bucket id) makes "latest" per bucket; absent = one partition. */
export function snapshotRows(columns: ParsedColumn[], rows: Cell[][], snap: MetricSnapshot, partition?: (row: Cell[]) => string | null): Cell[][]
export function latestDay(labels: (string | number)[], take: MetricSnapshot['take']): string | null   // ISO day labels only
export function pickPerBucket<D extends { labels: (string | number)[]; series: { name: string; values: (number | null)[] }[] }>(day: D, grain: DateGrain, take: MetricSnapshot['take']): D
export function onDay(column: string, day: string): FilterStep   // { type:'filter', column, op:'period', period:{ preset:'custom', from: day, to: day } }
```
`pickPerBucket` maps each ISO day label to its bucket label with `dateBucketLabel(dateBucket(parseDateCell(label)!, grain), grain)`, under the request's week calendar. It keeps, per bucket, the index of its latest (or earliest) day label, and returns those buckets in first-seen order with each series' value at that index (null when that series had none). Non-ISO labels are skipped.
- [ ] **Step 1: Write the failing test.**
```ts
const C = [{ name: 'day', type: 'date' }, { name: 'units', type: 'number' }] as ParsedColumn[];
const R = [['2024-03-30', 1], ['03/31/2024', 2], ['2024-03-31', 3], ['', 9], ['2024-04-02', 4]];
ok('latest day: only 2024-04-02', isDeepStrictEqual(snap.snapshotRows(C, R, { column: 'day', take: 'last' }), [['2024-04-02', 4]]));
ok('latest per month: 31 March twice, 2 April once', isDeepStrictEqual(snap.snapshotRows(C, R, { column: 'day', take: 'last' }, (r) => String(r[0]).includes('03') ? 'm3' : 'm4'), [['03/31/2024', 2], ['2024-03-31', 3], ['2024-04-02', 4]]));
ok('an undated row is never kept', !snap.snapshotRows(C, R, { column: 'day', take: 'first' }).some((r) => r[0] === ''));
ok('latestDay', snap.latestDay(['2024-01-02', '', '2024-01-09', 'Other'], 'last') === '2024-01-09' && snap.latestDay(['2024-01-02', '2024-01-09'], 'first') === '2024-01-02' && snap.latestDay([], 'last') === null);
const day = { labels: ['2024-01-30', '2024-01-31', '2024-02-03'], series: [{ name: 'East', values: [5, null, 7] }, { name: 'West', values: [1, 2, null] }] };
ok('per month: each bucket\'s latest day, never an older value', isDeepStrictEqual(snap.pickPerBucket(day, 'month', 'last'), { labels: ['2024-01', '2024-02'], series: [{ name: 'East', values: [null, 7] }, { name: 'West', values: [2, null] }] }));
ok('onDay', isDeepStrictEqual(snap.onDay('day', '2024-01-31'), { type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-01-31', to: '2024-01-31' } }));
```
  The "latest per month" partition is a stand-in; Task 4 uses the real bucket.
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-snapshot.js` fails at "latest day …" because `snapshotRows` is not exported.
- [ ] **Step 3: Implement** to the signatures above.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-snapshot.js` reports 0 failures.
- [ ] **Step 5: Commit.** `git add src/analysis/snapshot.ts scripts/test-snapshot.ts && git commit -m "Add the snapshot's row-level reference and the helpers that pick its day"`

### Task 3: A snapshot KPI through the KPI door

**Files:**
- Create `src/ipc/snapshotDoors.ts`.
- Modify `src/ipc/dashboards.ts`: `:149-157` removes step 02's `{ok:true, value:null}` shortcut, and `:159-166` adds the branch in `computeCardMetricUnlocked`.
- Test: `scripts/test-snapshot.ts`, section "kpi".

**Interfaces:**
```ts
export async function snapshotCardMetric(
  projectId: string, datasetId: string, spec: { column: string; aggregation: MetricAggregation; snapshot: MetricSnapshot },
  filters: FilterStep[], params: ParamValues | undefined,
  figure: (spec: { column: string; aggregation: MetricAggregation }, filters: FilterStep[]) => Promise<{ ok: boolean; value: number | null; fx?: FxInfo; asOf?: AsOf }>,
): Promise<{ ok: boolean; value: number | null; fx?: FxInfo; asOf?: AsOf }>
```
The body:
1. Ask `vizDataFor(projectId, datasetId, { category: snap.column, grain: 'day', values: [{ column: snap.column, aggregation: 'count' }] }, filters, { params })`. When it is not ok, return `{ ok: false, value: null }`.
2. `day = latestDay(labels, take)`. When there is none, return `{ ok: true, value: spec.aggregation === 'count' ? 0 : null }`.
3. Otherwise return `figure({ column, aggregation }, filters.concat([onDay(snap.column, day)]))`.

In `computeCardMetricUnlocked`, after the Live branch: `if (spec.snapshot) return snapshotCardMetric(projectId, datasetId, spec, filters, params, (s, f) => computeCardMetricUnlocked(projectId, datasetId, s, f, params));`. The nested `vizDataFor` re-locks idempotently (`withLockSteps`, `rowAccess.ts:289-294`), and the callback avoids a `dashboards` ↔ `snapshotDoors` import cycle. Every caller that passes a metric's definition as `spec` now gets the snapshot: `metrics.resolveDefinition`, `scenarioResolve.operand` and `drivers` once `shape.kind` is none. That covers tiles, `/p/`, scorecards, the metric tree, sparklines, `metric_value` and Assistant facts.
- [ ] **Step 1: Write the failing test.** Section "kpi". Save these metrics through `save`, all with `snapshot: S` unless marked:
  - `Stock`: sum of units
  - `Opening`: sum of units, with `take: 'first'`
  - `Lines`: count of units
  - `Level`: avg of units
  - `Peak`: max of units
  - `East stock`: sum of units, with filter `region = East`
  - `Units`: sum of units, no snapshot

  `kpi = async (m, scope) => (await ipcMetrics.resolveMetric(pid, m.id, { filters: scope }))!.value`.
```ts
const table = (f: FilterStep[]) => transforms.applyPipeline({ columns: COLS, rows: ROWS }, f);
const ref = (m: Metric, scope: FilterStep[]) => { const t = table(m.filters.concat(scope)); return computeMetric(t.columns, snap.snapshotRows(t.columns, t.rows, m.definition.snapshot), m.definition); };
const SPRING = [{ type: 'filter', column: 'region', op: 'in', values: ['East', 'West'] }, { type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2023-03-01', to: '2023-06-30' } }];
const NONE = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '1999-01-01', to: '1999-12-31' } }];
const t0 = trace.snapshot();
for (const m of [stock, opening, lines, level, peak, eastStock]) for (const [name, scope] of [['no scope', []], ['East and West in spring', SPRING], ['nothing in scope', NONE]] as const)
  ok(`kpi ${m.name}, ${name}: door = reference (Object.is)`, Object.is(await kpi(m, scope), ref(m, scope)), show([await kpi(m, scope), ref(m, scope)]));
ok('resident: the day list and the figure ran in place', trace.snapshot().vizAggregate.resident > (t0.vizAggregate?.resident ?? 0) && trace.snapshot().metric.resident > (t0.metric?.resident ?? 0));
ok('empty scope: count 0, sum null', (await kpi(lines, NONE)) === 0 && (await kpi(stock, NONE)) === null);
ok('NEGATIVE CONTROL: not the sum over every date', (await kpi(stock, [])) !== (await kpi(units, [])));
ok('NEGATIVE CONTROL: earliest ≠ latest', (await kpi(opening, [])) !== (await kpi(stock, [])));
ok('both spellings on the latest day count', LAST_SPELLINGS.size === 2 && (await kpi(lines, [])) === ROWS.filter((r) => periodDay(r[0]) === LAST && typeof r[3] === 'number').length);
ok('a formula over it: [Stock] * 2', Object.is((await kpi(double, [])), 2 * (await kpi(stock, []))!));
await datasets.updateDatasetData(pid, ds, { columns: COLS, rows: ROWS.concat([[isoFromDays(LAST + 2), 'East', 'A', 41, isoFromDays(LAST + 3)]]) }); // a refresh adds a later day
ok('a later day after refresh → that day\'s figure, not a cached old one', (await kpi(stock, [])) === 41);
await datasets.updateDatasetData(pid, ds, { columns: COLS, rows: ROWS }); // back, for the sections below
```
  The fixture defines `LAST` (the epoch day of the last date, `dateIntel.periodDay`), `LAST_SPELLINGS` (the set of raw spellings on it) and `double`, the `[Stock] * 2` formula. `updateDatasetData` is the store's refresh write (`datasets.ts:596`, used by `scripts/test-analyticsBServer.ts:251`).
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-snapshot.js` fails at "kpi Stock, no scope": the value is null from step 02's shortcut.
- [ ] **Step 3: Implement** as specified. Add the comment `// shortcut: the day is read as a date axis reads it, the rows by the period filter; a timestamp with an offset can disagree (scorecards.ts:158 has the same seam) — give `period` the axis's parser to close it.`
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-snapshot.js scripts/test-metrics.js scripts/test-alerts.js scripts/test-scorecards.js scripts/test-metricTree.js scripts/test-asyncReach.js` reports 0 failures.
- [ ] **Step 5: Commit.** `git add src/ipc/snapshotDoors.ts src/ipc/dashboards.ts scripts/test-snapshot.ts && git commit -m "Compute a snapshot KPI as the figure on its latest day, through the KPI door"`

### Task 4: Snapshot measures on charts

**Files:**
- Modify `src/analysis/metricMeasures.ts`, as step 03 left it (re-read it first; the line numbers are develop's today):
  - `Leaf` (`:38-42`) gains `snapshot?: MetricSnapshot`.
  - `leafOf` (`:82-95`) takes it and adds it to its key.
  - `needsMetricPlan` (step 03, `m.filters.length > 0`) adds `|| (!isFormulaDefinition(m.definition) && !!m.definition.snapshot)`.
  - A simple metric with a snapshot is **always planned as its own leaf**: step 03's `formulas.set(i, { name, root: leafOf(..., def.snapshot), simple: true })`. It never takes step 03's shared-filters shortcut ("every own-filter JSON is equal"), because two snapshot measures with `[]` filters would otherwise share one plain question.
  - `build` (`:97-101`, for a formula's operand) drops step 02's `measureSnapshotPending` and passes `def.snapshot` to `leafOf`.
  - Before either `leafOf` with a snapshot, an awaited check runs against the dataset's meta, loaded once per plan. A date `encoding.category` other than `snapshot.column` throws `PlanError(msg.snapshotOtherDate(...))`.
  - `planMetricMeasures` (`:68-74`) first returns `{ ok: false, error: msg.snapshotInPivot(name) }` when `encoding.pivot` has a value whose `metricId` names a snapshot metric.
- Modify `src/ipc/vizMetricMeasures.ts`:
  - `Call` and `callsFor` (`:38-59`): the key is `JSON.stringify([l.filters, l.snapshot ?? null])` and the call carries `snapshot`.
  - `run` (`:70-74`) sends a snapshot call to `snapshotAnswer`.
- Modify `src/ipc/visuals.ts:465-466`. Line 465 drops its `hasMetricMeasure` gate (`planMetricMeasures` gates itself at `:74`), so a pivot reaches the check; `withLeafMeasures` and the other `hasMetricMeasure` callers (`rowDoors.ts:53`, `embedLock.ts:55`, `sharePolicy.ts:248`) are unchanged. On line 466, step 03's `: { ok: false, error: planned.error }` becomes `: planned`, so a typed code passes through. Net +0 lines.
- Modify `src/ipc/snapshotDoors.ts` and `src/analysis/metricCheckMessages.ts`.
- Test: `scripts/test-snapshot.ts`, section "chart".

**Interfaces:**
- Consumes from step 03: `needsMetricPlan`, the `simple: true` leaf branch of `planMetricMeasures`, `followMetricMeasures` (which sends a plan to `metricMeasureData`) and `followedEncoding` (which step 02's additivity check reads).
- Produces:
```ts
export async function snapshotAnswer(snap: MetricSnapshot, enc: VizEncoding, filters: FilterStep[], ask: (e: VizEncoding, f: FilterStep[]) => Promise<VizDataReply>): Promise<VizDataReply>
export function snapshotOtherDate(metric: string, snapshotColumn: string, category: string): string
export function snapshotInPivot(metric: string): string
```
- **`enc.category === snap.column`:**
  1. `grain = enc.grain ?? (await ask({ ...enc, values: [{ column: enc.category, aggregation: 'count' }] }, filters)).category?.grain`. The first call has no pinned grain.
  2. `day = await ask({ ...enc, grain: 'day' }, filters)`.
  3. Return `{ ...day, data: pickPerBucket(day.data, grain, snap.take), category: { kind: 'date', grain } }`. With no grain, the labels and series are empty.
- **Any other category:**
  1. `days = await ask({ category: snap.column, grain: 'day', values: [{ column: snap.column, aggregation: 'count' }] }, filters)`.
  2. With no day, return `{ ok: true, data: { labels: [], series: [] }, recommendedShape: days.recommendedShape, warnings: days.warnings }`.
  3. Otherwise return `ask(enc, filters.concat([onDay(snap.column, day)]))`.
- [ ] **Step 1: Write the failing test.** Section "chart". `chart = (encoding, filters = []) => viz(null, { projectId: pid, datasetId: ds, encoding, filters })` and `M = (m) => ({ column: m.name, aggregation: m.definition.aggregation, metricId: m.id })`. The reference is `buildVizData(t.columns, snap.snapshotRows(t.columns, t.rows, s, part), { ...enc, values: [{ column: 'units', aggregation: agg }] }, [])` over `t = table(m.filters.concat(filters))`. Its `part` is `(r) => { const c = parseDateCell(r[0]); return c ? String(dateBucket(c, grain)) : null; }` when the category is `day`, and absent otherwise.
```ts
for (const [name, enc, m, f] of [
  ['by month', { category: 'day', grain: 'month', values: [M(stock)] }, stock, []],
  ['by quarter, earliest', { category: 'day', grain: 'quarter', values: [M(opening)] }, opening, []],
  ['by region', { category: 'region', values: [M(stock)] }, stock, []],
  ['by month × region', { category: 'day', grain: 'month', series: 'region', values: [M(stock)] }, stock, []],
  ['by month, filtered', { category: 'day', grain: 'month', values: [M(eastStock)] }, eastStock, [{ type: 'filter', column: 'sku', op: '=', value: 'A' }]],
  ['by region, nothing in scope', { category: 'region', values: [M(stock)] }, stock, NONE],
] as const) {
  const got = await chart(enc, f); const want = refChart(enc, m, f);
  ok(`${name}: labels = reference`, got.ok && sameItems(got.data.labels, want.data.labels), show([got, want.data]));
  // By series NAME under a split: the door's day grid can carry a series with no kept row (all null) that the reference never sees.
  const gotOf = (s: { name: string }, i: number) => (enc.series ? got.data.series.find((g) => g.name === s.name) : got.data.series[i]);
  ok(`${name}: every cell = reference (Object.is)`, got.ok && want.data.series.every((s, i) => !!gotOf(s, i) && sameItems(gotOf(s, i)!.values, s.values))
    && (!enc.series || got.data.series.filter((g) => !want.data.series.some((s) => s.name === g.name)).every((g) => g.values.every((v) => v === null))));
}
const byRegion = await chart({ category: 'region', values: [M(stock)] });
ok('West, with no row on the latest day, has no bar — not its older value', byRegion.ok && !byRegion.data.labels.includes('West'));
const two = await chart({ category: 'region', values: [M(stock), { column: 'units', aggregation: 'sum' }] });
const w = two.ok ? two.data.labels.indexOf('West') : -1;
ok('beside a plain measure, West is an empty cell', w >= 0 && two.data.series[0].values[w] === null && typeof two.data.series[1].values[w] === 'number');
const auto = await chart({ category: 'day', values: [M(stock)] }); const plainAuto = await chart({ category: 'day', values: [{ column: 'units', aggregation: 'sum' }] });
ok('auto grain is the plain chart\'s', auto.ok && plainAuto.ok && auto.category?.grain === plainAuto.category?.grain);
ok('a chart by another date is refused, naming both', (await chart({ category: 'counted', grain: 'month', values: [M(stock)] })).error === msg.snapshotOtherDate('Stock', 'day', 'counted'));
ok('a pivot is refused', (await chart({ category: 'region', values: [M(stock)], pivot: { rows: [{ column: 'region' }], columns: [], values: [M(stock)] } })).error === msg.snapshotInPivot('Stock'));
ok('step 02 end to end: running total along months refused (time)', (await chart({ category: 'day', grain: 'month', values: [{ ...M(stock), calc: { kind: 'running_total', along: 'across' } }] })).error === msg.calcNotAdditiveOverTime('Stock', 'a running total'));
ok('…and percent of total across regions allowed', (await chart({ category: 'region', values: [{ ...M(stock), calc: { kind: 'pct_of_total', along: 'across' } }] })).ok === true);
ok('a formula over it per cell: [Stock] * 2', (await chart({ category: 'region', values: [M(double)] })).data.series[0].values.every((v, i) => Object.is(v, byRegion.data.series[0].values[i] === null ? null : 2 * (byRegion.data.series[0].values[i] as number))));
```
  `sameItems` compares arrays item by item with `Object.is`.
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-snapshot.js` fails at "by month: labels": step 02's sentence comes back instead.
- [ ] **Step 3: Implement** as specified. The sentences, as literals:
  - `` `${metric} is a snapshot on ${snapshotColumn}, so it can be charted by ${snapshotColumn} or by something that is not a date, not by ${category}.` ``
  - `` `${metric} is a snapshot, which a pivot table can't show yet. Use a chart.` ``
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-snapshot.js scripts/test-metricMeasures.js scripts/test-additivity.js scripts/test-tableCalc.js scripts/test-embedLock.js scripts/test-file-size.js scripts/test-i18n.js && npm run lint` reports 0 failures and 0 findings, and `wc -l src/ipc/visuals.ts` has not grown in this PR.
- [ ] **Step 5: Commit.** `git add src/analysis/metricMeasures.ts src/ipc/vizMetricMeasures.ts src/ipc/visuals.ts src/ipc/snapshotDoors.ts src/analysis/metricCheckMessages.ts src/i18n scripts/test-snapshot.ts && git commit -m "Chart a snapshot metric per date bucket by its own date, and over the whole scope otherwise"`

### Task 5: Live is a typed refusal

**Files:**
- Modify `src/engine/liveRefusals.ts`: add `liveSnapshotRefused`.
- Modify `src/engine/live/liveQuery.ts:83`: add `'snapshot'` to `LiveFailure.reason`.
- Modify `src/ipc/dashboards.ts`, the Live branch of `computeCardMetricUnlocked`, which throws `new LiveFigureError({ ok: false, code: 'live_refused', reason: 'snapshot', error: liveSnapshotRefused() })` when `spec.snapshot`.
- Modify `src/analysis/metricMeasures.ts`: Task 4's snapshot check also ends the plan on a Live dataset (`isLive(meta)`, `src/data/liveDataset.ts:119`), with `{ ok: false, error, code: 'live_refused', reason: 'snapshot' }`. That covers both the simple leaf and a formula's operand. `PlanResult`'s failure (step 03's `{ ok: false; error: string }`) gains `code?: 'live_refused'; reason?: 'snapshot'`.
- Test: `scripts/test-metricMeasures.ts`, which already runs the Live route harness with extract `X` and Live `L` of the parity fixture.

**Interfaces:** Produces `liveSnapshotRefused(): string`.
- [ ] **Step 1: Write the failing test.** Append to `scripts/test-metricMeasures.ts` before `close()`:
```ts
const snapDef = { column: 'amt', aggregation: 'sum', snapshot: { column: 'd', take: 'last' } };
const onLive = await save('Live stock', L, snapDef); const onCopy = await save('Copy stock', X, snapDef);
const k = await hydrates(L, async () => ((await post('metric:values', { projectId: P, ids: [onLive], filters: [] })).value as unknown as Reply[])[0]);
ok('Live snapshot KPI: typed refusal, its sentence, no hydrate', k.value.ok === false && k.value.code === 'live_refused' && k.value.reason === 'snapshot' && k.value.error === liveRefusals.liveSnapshotRefused() && !k.hydrated, show(k));
const c = await hydrates(L, () => chart(L, { category: 'region', values: [M('Live stock', onLive)] }));
ok('Live snapshot chart: typed refusal, no hydrate', c.value.ok === false && c.value.code === 'live_refused' && c.value.reason === 'snapshot' && !c.hydrated, show(c));
ok('NEGATIVE CONTROL: the same definition on the copy has a figure', typeof (await kpi(onCopy, [])) === 'number');
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-metricMeasures.js` fails at "Live snapshot KPI": today the figure is the compiler's plain `sum(amt)`.
- [ ] **Step 3: Implement.** The sentence, as a literal: `A snapshot metric can't be worked out from a Live dataset yet. Make a copy of the dataset to use it.` Then run `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-metricMeasures.js scripts/test-liveRoute.js scripts/test-liveSafetyNet.js scripts/test-liveParity.js scripts/test-i18n.js` reports 0 failures.
- [ ] **Step 5: Commit.** `git add src/engine/liveRefusals.ts src/engine/live/liveQuery.ts src/ipc/dashboards.ts src/analysis/metricMeasures.ts src/i18n scripts/test-metricMeasures.ts && git commit -m "Refuse a snapshot metric on a Live dataset with a typed sentence"`

### Task 6: The surfaces that copy a metric (alerts, answer cards, scenarios)

**Files:**
- Modify `src/analysis/alertStore.ts:319-324`. When `rule.metric.metricId` names a simple metric with a snapshot, `spec` gains `snapshot`. This is the decision on D8's alerts claim: an alert follows its metric's snapshot; it is not refused.
- Modify `src/ipc/answers.ts:245-258`: export `specMetrics`, and set `hasFilters: !!(full && (full.filters.length || (!isFormulaDefinition(full.definition) && full.definition.snapshot)))`.
- Modify `src/ai/answerSpec.ts:80`, the doc comment: "own row filters or a snapshot".
- Modify `src/analysis/scenarioResolve.ts:192-195`. `operand`'s `spec` type gains `snapshot?`. When `spec.snapshot` is set and `columnMoves(...)` is not empty, it applies no moves and adds `` `Drivers on "${spec.column}" were not applied to a snapshot metric.` `` to `ctx.notes`, the file's own plain-English convention.
- Test: `scripts/test-snapshot.ts`, section "surfaces".

**Interfaces:** Produces `export async function specMetrics(projectId: string): Promise<SpecMetric[]>`. It is exported for the test.
- [ ] **Step 1: Write the failing test.**
```ts
const rule = (metric: object) => ({ id: U(1), name: 'r', datasetId: ds, metric, compare: 'threshold', threshold: { op: '>', value: 0 }, enabled: true }) as never as AlertRule;
ok('an alert on Stock watches the snapshot', (await alertStore.metricFor(pid, rule({ column: 'units', aggregation: 'sum', metricId: stock.id }))).value === (await kpi(stock, [])));
ok('NEGATIVE CONTROL: an alert on the bare column is the plain sum', (await alertStore.metricFor(pid, rule({ column: 'units', aggregation: 'sum' }))).value === (await kpi(units, [])));
const sm = await ipcAnswers.specMetrics(pid);
ok('an answer card never treats Stock as a bare column', sm.find((m) => m.id === stock.id)?.hasFilters === true && sm.find((m) => m.id === units.id)?.hasFilters === false);
const sc = await scenarioResolve.computeScenario(pid, { id: U(2), name: 't', baseMetricIds: [stock.id], drivers: scenarioModel.sanitizeDrivers([{ kind: 'pct', target: { column: 'units' }, value: 5 }]) });
ok('a scenario says its drivers were not applied, and keeps the baseline', sc.notes.includes('Drivers on "units" were not applied to a snapshot metric.') && sc.metrics[0].value === (await kpi(stock, [])));
```
  `validateAnswerSpec` already refuses a `hasFilters` metric as a measure (`scripts/test-answerSpec.ts:143`).
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-snapshot.js` fails at "an alert on Stock …", because it computes the plain sum.
- [ ] **Step 3: Implement** as specified. In alertStore, one `metrics.getMetric` only when `metricId` is set (`import * as metrics from './metrics'`).
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-snapshot.js scripts/test-alerts.js scripts/test-answerSpec.js scripts/test-scenarios.js scripts/test-file-size.js` reports 0 failures.
- [ ] **Step 5: Commit.** `git add src/analysis/alertStore.ts src/ipc/answers.ts src/ai/answerSpec.ts src/analysis/scenarioResolve.ts scripts/test-snapshot.ts && git commit -m "Carry a metric's snapshot into its alerts, and keep answer cards and scenarios from dropping it"`

### Task 7: The snapshot field in the metric editor

**Files:**
- Modify `web/src/features/analyses/metrics/api.ts:16`, where `Definition`'s simple branch gains `snapshot?: { column: string; take: 'last' | 'first' } | null`.
- Modify `web/src/features/analyses/metrics/MetricEditor.tsx`: the state near `:71`, `definition` at `:93`, and a `Select` after the aggregation radios at `:236`.
- Test: create `web/src/features/analyses/metrics/MetricEditor.test.tsx`, and extend `web/e2e/analyses.e2e.ts:299-339`.

**Interfaces:** The field is a `Select`:
- label **"Snapshot"**
- options: `''` → "Every row", then for each of the dataset's `date` columns `last:<col>` → "Latest <col> only" and `first:<col>` → "Earliest <col> only"; split on the first `:`
- hint: "For balances, stock and headcount: keeps only the rows on the latest date in scope (per month on a chart by month), then aggregates them."
- shown only in Simple mode when the dataset has a date column

The definition always sends `snapshot: <object> | null` (null for "Every row"), which is how the server tells a clear from an old tab. The preview is the server's `definitionText`.
- [ ] **Step 1: Write the failing test.** `MetricEditor.test.tsx` stubs `fetch` the way `web/src/features/visuals/calcMeasure.test.tsx` does, with columns `day` (date) and `units` (number).
  - Choose "Latest day only" and save.
  - `expect(savedBody.input.definition).toEqual({ column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } })`.
  - Then choose "Every row" on an existing snapshot metric and expect `patch.definition.snapshot` toBe `null`.
  - The field is absent when the columns hold no date.

  e2e, in the "metrics" test (`analyses.e2e.ts:299`), after the filter dialog closes and **before** `figure` is read, so the row check later compares the snapshot's figure:
```ts
await dlg.getByRole('combobox', { name: 'Snapshot' }).click();
await page.getByRole('option', { name: 'Latest order_date only' }).click();
await preview.getByText(/on the latest order_date/).waitFor(); // the server's words for the definition
```
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- MetricEditor` fails because no Snapshot combobox exists.
- [ ] **Step 3: Implement** as specified, with the existing `Select`, `s.filterHint` and CSS-module tokens; no new styles.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web -- MetricEditor && npm run build:web && npm --prefix web run e2e -- analyses && npm --prefix web run size && npm run lint`. Everything passes, the RPC budget stays ≤ 25, and the initial JS stays ≤ 300 KB gzip. Look at `web/e2e/__screens__/metrics-editor*` in both themes.
- [ ] **Step 5: Commit.** `git add web/src/features/analyses/metrics/api.ts web/src/features/analyses/metrics/MetricEditor.tsx web/src/features/analyses/metrics/MetricEditor.test.tsx web/e2e/analyses.e2e.ts && git commit -m "Offer a snapshot date in the metric editor"`

### Task 8: The Assistant and agents know a metric is a snapshot (added at the index review)

**Files:** Modify `src/ai/copilotFacts.ts` (`FactMetric`, `metricLines`), `src/ipc/copilot.ts` (`factMetrics`), `src/automation/handlers.ts` (`metricsList`) · Test `scripts/test-snapshot.ts` (extend)
**Interfaces:** Consumes `MetricSnapshot` (step 02a). Produces `FactMetric.snapshot?: MetricSnapshot` and a `snapshot: { column: string; take: 'last' | 'first' } | null` field on each `list_metrics` row.

- [ ] **Step 1: Write the failing test.** In `scripts/test-snapshot.ts`, section "facts": `metricLines` for a metric with `snapshot: { column: 'as_of', take: 'last' }` writes a line containing `Snapshot: the value on the latest as_of in the period, not a sum over dates.`; a metric without one gets no such sentence (NEGATIVE CONTROL); `handlers.metricsList(ctx)` returns `snapshot` equal to the stored object for it and `null` for a plain metric.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-snapshot.js`. Expected: the new lines fail.
- [ ] **Step 3: Implement.** Fill the field in `factMetrics` and `metricsList`; `metricLines` appends the sentence (`latest` for `last`, `earliest` for `first`). Regenerate `docs/automation.md` with `node scripts/gen-automation-docs.js` if needed.
- [ ] **Step 4: Run it to see it pass.** Same command, plus `node scripts/test-copilot.js`. Expected: 0 failures.
- [ ] **Step 5: Commit.** `git add src/ai/copilotFacts.ts src/ipc/copilot.ts src/automation/handlers.ts scripts/test-snapshot.ts && git commit -m "Tell the Assistant and agents which metrics are snapshots"`

## Existing tests that must stay green

`test-snapshotReader` (rewrite its "no figure until step 07" and "can't chart yet" assertions as the opposite, since they are step 02's temporary guards), `test-metrics`, `test-metricMeasures`, `test-metricTree`, `test-additivity`, `test-tableCalc`, `test-alerts`, `test-scorecards`, `test-scenarios`, `test-answerSpec`, `test-drivers`, `test-liveRoute`, `test-liveSafetyNet`, `test-liveParity`, `test-publishMemo`, `test-embedLock`, `test-asyncReach`, `test-i18n`, `test-file-size`, `node scripts/check-contracts.js`, `npm run lint`, `npm run test:web`.
