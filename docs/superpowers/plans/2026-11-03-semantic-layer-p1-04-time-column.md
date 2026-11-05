# Semantic layer part 1, step 04: The metric's date (`timeColumn`) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A metric can name the date it counts by, so a dashboard date control, the KPI compare, the metric tree, scorecards, the sparkline, alerts and the Assistant all land on that date. With nothing set, behaviour is exactly today's.
**Architecture:** Date controls mark the period steps they make with `fromControl: true`, in both `controlSteps` (the server's and the browser's). Every merge keeps the mark. Before any engine sees the filters, the figure doors and the entries that read a period out of filters (overlay, compare, tree, drill, explain) call one pure rewrite, `rewriteControlPeriods`. It moves the marked period steps onto the metric's `timeColumn` and strips the mark. JS, resident and Live then receive the same plain steps.
**Tech Stack:** TypeScript server (`src/analysis`, `src/ipc`, `src/data`, `src/ai`), React (`web/src/features/analyses`, `dashboards`), zod contracts, self-checks, Vitest.
**Spec:** docs/semantic-layer/00-design.md (D9 with its late additions, D16) · Index: docs/superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md
**Branch and PR:** two PRs. Both are off `origin/develop`, after step 03 merges.
1. `feat/semantic-p1-04a-time-column-reader` (Task 1). It must reach a release and finish rolling out **before** PR 2 ships.
2. `feat/semantic-p1-04-time-column` (Tasks 2–8).

## What an old pod does (rolling deploy)

| New data | Old pod without PR 1 (today's release) | Old pod with PR 1 |
|---|---|---|
| `Metric.timeColumn` | `normalize` (`src/analysis/metrics.ts` l.221-241) drops it on read. Then **`updateMetric` writes the record back without it** (`...existing`, l.392-421): a rename, a format change or a tree save **loses the field** | Keeps it on read and re-save, uses it nowhere, draws as unset |
| `FilterStep.fromControl` (request steps, plus alert rules saved by "Alert me…" from a KPI: `AlertDialog.tsx` l.99 stores the reader's filters) | `sanitizeStep` (`src/data/transforms.ts` l.715-740) drops it. A re-saved alert loses the mark, so after the upgrade it would count by the control's column instead of the metric's | Keeps it, rewrites nothing, figures are today's |
| `metric:save` with `timeColumn` from a new browser | The strict contract refuses it (400). Retrying reaches a new pod | Same |
| An old cached SPA (no marks) on a new pod | n/a | No marks, so no rewrite, so today's figures until reload. Server-built pages (publish, reports, subscriptions) are marked by the server |

This is why PR 1 ships alone first. If the owner releases both PRs together, a metric whose date is set during the rollout can lose it.

> **Index note (2026-11-03):** the step 09 guard PR `feat/semantic-p1-09a-via-guard` lands at the head of the chain and moves the `filter` case of `sanitizeStep` out of `src/data/transforms.ts` into `src/data/filterStepSanitize.ts` (`sanitizeFilterStep`). So this plan's `fromControl` line goes into `sanitizeFilterStep` in that file, the `transforms.ts` line numbers below shift, and `transforms.ts` stays well under its cap. Re-read both files before Task 1.

> **Index note (2026-11-03), order:** PR 04a (Task 1) moves to release 1 and needs only `feat/semantic-p1-09a-via-guard`, not step 03. Tasks 2–8 stay after step 03. Explore's default date axis is dropped from part 1 (Explore carries no metric measure). See the index.

## Global Constraints

- Unset `timeColumn` means today exactly. No golden fixture under `scripts/fixtures/golden/` or `web/src/**/__golden__/` is re-recorded.
- The marker is not a security property. Row lock steps (`lock: true`) are never marked or moved. The lock is still prepended inside `lockedViz`, after the rewrite.
- The rewrite happens before the Live split and before the answer-cache key. The doors strip every marker, so no `fromControl` reaches an engine or a cache key.
- File caps:
  - `src/data/transforms.ts` 795 → **798** after PR 1. Step 05 must split it before adding the term step.
  - `src/ipc/visuals.ts` 769 → ≤ 776.
  - `src/ipc/metrics.ts` 563 → ≤ 575 (already past the soft cap).
  - New logic goes in `src/analysis/metricTime.ts` (pure) and `src/analysis/metricTimeScope.ts` (reads).
- Sentences go through `t()` in `src/analysis/metricCheckMessages.ts` (already in `MAIN_FILES`), then `node scripts/i18n-extract.js`. The React UI stays English-only.
- Contracts: `timeColumn: z.string().max(512).optional()` goes in `Fields` and the `metric:update` patch (`src/api/metrics.ts` l.22-30, l.53). There is no new channel, and no `rowPolicyReaders` entry changes.

## Review Focus

- **A tile's own date filter equal to the control's step must survive.** The dedupe keys now include the marker, and after stripping, an identical pair collapses only if one of the two was marked. Task 2 tests this.
- **Overlay and compare must shift the column the period landed on.** `withRange` (`src/analysis/periodScope.ts` l.84-93) builds an unmarked step, so the rewrite runs **before** `withPeriodOverlay`/`withCompareSeries`, `compareScope`, `pointPlan` and `drillFilters`. Task 4 and Task 5 test this.
- **Conflicts are refused, never guessed.** Under a date control, a chart whose drawn measures count by different dates is refused. A plain, non-metric measure counts as "the dashboard's date". Without a control the same chart draws (negative control). Task 4 tests both.
- **A `timeColumn` that is no longer a date column of its dataset counts as unset** everywhere (`metricDate` returns `''`). `metric:get` flags it, and the editor says so. This is the planner's call: it keeps one rule instead of refusing every figure. Flagged for the owner.
- **A formula metric's parts are checked only when the formula is saved.** If a part's date changes later, nothing re-checks the formula. At draw time the formula's own date applies to the whole formula. Flagged.
- **Why `needsMetricPlan` does not include `timeColumn`** (it differs from D16's text and the cross-step table). The rewrite is chart-level and conflicting dates are refused, so a per-measure plan buys nothing. Planning would also refuse every faceted chart (`measureNoFacets`) just because its metric has a date.
- **Not in this step (flagged).**
  - Explore has no metric measure: `decodeQuestion` drops `metricId` (`web/src/features/explore/spec.ts` l.60), and `explore:suggest` lists columns only. So "Explore's default date axis" has nothing to follow.
  - Published `/p/` pages count by the metric's date but do not show the caption.
  - The Assistant's "Same for last year" chip still picks the first date column.

---

### Task 1 (PR 1): Old pods keep `timeColumn` and `fromControl`

**Files:** Modify:
- `src/analysis/metrics.ts`: `Metric` l.74-95, `normalize` l.221-241, `MetricInput` l.348.
- `src/data/transforms.ts`: `FilterStep` l.85-108 (2 lines), the `filter` case l.727 (1 line).
- `src/analysis/recordDiff.ts`: l.32 and l.53 add `'timeColumn'`; `diffMetric` l.213-221 adds one sentence.

Test: Create `scripts/test-metricTimeReader.ts`.
**Interfaces:** Produces `Metric.timeColumn?: string` (kept when it is a non-empty string ≤ 512, trimmed), `MetricInput.timeColumn?: unknown`, and `FilterStep.fromControl?: true`.
- [ ] **Step 1: Write the failing test.** Set up a temp userData as in `scripts/test-metrics.ts` l.41-58.
  ```ts
  const m = await metrics.saveMetric(P, { name: 'Revenue', datasetId: D, definition: { column: 'amt', aggregation: 'sum' }, timeColumn: 'ship_date' });
  ok('a stored timeColumn is read', m?.timeColumn === 'ship_date');
  const r = await metrics.updateMetric(P, m!.id, { name: 'Revenue (net)' });
  ok('a re-save by this pod keeps it', (await metrics.getMetric(P, m!.id))?.timeColumn === 'ship_date' && r?.name === 'Revenue (net)');
  ok('a duplicate keeps it', (await metrics.duplicateMetric(P, m!.id))?.timeColumn === 'ship_date');
  ok('NEGATIVE CONTROL: a non-string timeColumn is dropped', (await metrics.saveMetric(P, { name: 'X', datasetId: D, definition: { column: 'amt', aggregation: 'sum' }, timeColumn: 5 }))?.timeColumn === undefined);
  const marked = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'last_n_days', n: 30 }, fromControl: true };
  ok('sanitizeSteps keeps fromControl: true', JSON.stringify(transforms.sanitizeSteps([marked])) === JSON.stringify([marked]));
  ok('NEGATIVE CONTROL: fromControl "yes" is dropped', !('fromControl' in transforms.sanitizeSteps([{ ...marked, fromControl: 'yes' }])[0]));
  ok('the edit-conflict tag covers it (two editors changing the date conflict)', editConflict.contentTag('metric', m) !== editConflict.contentTag('metric', { ...m, timeColumn: 'order_date' }));
  ok('NEGATIVE CONTROL: a record without it tags as its saved fields alone', editConflict.contentTag('metric', { ...m, timeColumn: undefined }) === editConflict.contentTag('metric', { ...m, timeColumn: undefined, junk: 1 }));
  ok('the version diff names a date change', recordDiff.summarize('metric', m, { ...m, timeColumn: 'order_date' }).includes('changed the date it counts by'));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-metricTimeReader.js`. Expected: "a stored timeColumn is read" fails.
- [ ] **Step 3: Implement.**
  - `normalize`: `const timeColumn = trimTo(data.timeColumn, 512); if (timeColumn) m.timeColumn = timeColumn;`
  - `sanitizeStep`: `if (o.fromControl === true) step.fromControl = true;` next to `context`.
  - The field doc is one comment line: `/** Made by a dashboard date control (semantic D9): the server may move its period onto the metric's timeColumn. */`.
  - `diffMetric`: `if ((a.timeColumn || '') !== (b.timeColumn || '')) parts.push('changed the date it counts by');`
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-metricTimeReader.js && node scripts/test-metrics.js && node scripts/test-dateIntel.js && node scripts/test-versionHistory.js && node scripts/test-file-size.js`. Expected: 0 failures, and `transforms.ts` at 798.
- [ ] **Step 5: Commit.** `git add src/analysis/metrics.ts src/data/transforms.ts src/analysis/recordDiff.ts scripts/test-metricTimeReader.ts`, message `Keep a metric's timeColumn and a step's fromControl through read and re-save`.

### Task 2: The rewrite, and merges that keep a tile's own date

**Files:** Create `src/analysis/metricTime.ts` · Modify `src/analysis/dashboardFilters.ts` l.33-37 (export `stepKey`, add `s.fromControl === true`) · Modify `web/src/features/analyses/VisualTile.tsx` l.46 (the same key field) · Test: Create `scripts/test-metricTime.ts`; extend `web/src/features/analyses/editor/filters.test.ts`
**Interfaces:** Produces:
- `rewriteControlPeriods(filters: FilterStep[], timeColumn: string): FilterStep[]`. It returns the same array when no step is marked. Otherwise it moves each marked `period` step to `timeColumn` (when that is non-empty), strips `fromControl` from every step, then drops a step identical (by `stepKey`) to an earlier one only when one of the pair was marked.
- `hasControlPeriod(filters): boolean`.
- `controlPeriodMoved(filters, timeColumn): boolean`, true when a marked period step names a column other than `timeColumn` (and `timeColumn` is non-empty).
- [ ] **Step 1: Write the failing test.**
  ```ts
  const CTRL = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from: '2024-03-01', to: '2024-03-31' }, fromControl: true } as FilterStep;
  const OWN = { type: 'filter', column: 'order_date', op: 'period', period: CTRL.period } as FilterStep;
  const LOCK = { type: 'filter', column: 'region', op: '=', value: 'West', lock: true } as FilterStep;
  const plain = [LOCK, OWN];
  ok('no marks: the same array back', rewriteControlPeriods(plain, 'ship_date') === plain);
  ok('a marked period moves to the metric\'s date, unmarked', same(rewriteControlPeriods([CTRL], 'ship_date'), [{ ...OWN, column: 'ship_date' }]));
  ok('unset: only the mark goes', same(rewriteControlPeriods([CTRL], ''), [OWN]));
  ok('a tile\'s own identical step survives a move', same(rewriteControlPeriods([CTRL, OWN], 'ship_date'), [{ ...OWN, column: 'ship_date' }, OWN]));
  ok('… and collapses to one when unset (today\'s merge)', same(rewriteControlPeriods([CTRL, OWN], ''), [OWN]));
  ok('NEGATIVE CONTROL: an unmarked period and a lock step never move', same(rewriteControlPeriods([LOCK, CTRL, OWN], 'ship_date')[0], LOCK) && rewriteControlPeriods([LOCK, CTRL, OWN], 'ship_date')[2].column === 'order_date');
  ok('a marked non-period step only loses its mark', same(rewriteControlPeriods([{ ...LOCK, lock: undefined, fromControl: true } as FilterStep], 'ship_date'), [{ type: 'filter', column: 'region', op: '=', value: 'West' }]));
  ok('mergeDashboardFilters keeps a control step and an identical own step', mergeDashboardFilters([CTRL], [OWN]).length === 2);
  ok('NEGATIVE CONTROL: two unmarked duplicates still collapse', mergeDashboardFilters([OWN], [OWN]).length === 1);
  ```
  Web `filters.test.ts`: `mergeFilters([CTRL], [OWN])` has length 2, and `mergeFilters([OWN], [OWN])` has length 1.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-metricTime.js` and `npm run test:web -- filters`. Expected: the module is not found, and the merge length is 1.
- [ ] **Step 3: Implement.** Signatures as above. The implementation is a single pass and needs no other reads.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-metricTime.js && node scripts/test-dashboardFilters.js && node scripts/test-crossFilter.js && npm run test:web -- filters ClickFilters`. Expected: 0 failures.
- [ ] **Step 5: Commit.** `git add src/analysis/metricTime.ts src/analysis/dashboardFilters.ts web/src/features/analyses/VisualTile.tsx scripts/test-metricTime.ts web/src/features/analyses/editor/filters.test.ts`, message `Move a dashboard control's period onto a metric's date, keeping a tile's own`.

### Task 3: Saving a metric's date

**Files:** Create `src/analysis/metricTimeScope.ts` · Modify:
- `src/api/metrics.ts` l.22-30 and l.53.
- `src/analysis/metrics.ts`: `toSummary` l.243-257, `MetricSummary` l.97-109, `updateMetric` l.392-421.
- `src/ipc/metrics.ts`: `metric:get` l.462-466 (`timeColumnGone`), `metric:save` l.468-484, `metric:update` l.486-503.
- `src/analysis/metricCheckMessages.ts` (append).

Test: Create `scripts/test-metricTimeDoors.ts` (the harness for Tasks 3–7).
**Interfaces:** Produces:
- `metricDate(projectId: string, m: Pick<Metric, 'datasetId' | 'timeColumn'>): Promise<string>` returns `''` when unset or no longer a date column.
- `checkTimeColumn(projectId: string, input: { datasetId: string; definition: MetricDefinition; timeColumn?: string }): Promise<string | null>`.
- `MetricSummary.timeColumn?`.
- Sentences:
  - `notADateColumn(column)`: "“{column}” is not a date column of this dataset."
  - `dashboardDate()`: "the dashboard’s date".
  - `formulaDatesDiffer(name, part, partDate, ownDate)`: "“{name}” counts by {ownDate}, but its part “{part}” counts by {partDate}. Give them the same date."
  - `measuresCountByDifferentDates(a, aDate, b, bDate)`: "“{a}” counts by {aDate} and “{b}” by {bDate}, so one date range cannot apply to both. Give them the same date, or put them on two charts."

Rule for a formula: every `[Ref]` metric's `timeColumn ?? ''` must equal the formula's own `timeColumn ?? ''`.
- [ ] **Step 1: Write the failing test.** Fixture (inside `H.as(ORG_A, …)`, after `H.setupOrg`):
  ```ts
  const COLS = [{ name: 'region', type: 'text' }, { name: 'amt', type: 'number' }, { name: 'order_date', type: 'date' }, { name: 'ship_date', type: 'date' }];
  const day = (n: number) => new Date(Date.UTC(2024, 0, 1) + n * 86400000).toISOString().slice(0, 10);
  const rows = Array.from({ length: 1200 }, (_, i) => [['North', 'South', 'East', 'West'][i % 4], (i % 13) + 1, day(i % 400), day((i % 400) + (i % 7))]);
  // D = datasets.saveDataset(P, { name: 'Two dates', sourceKind: 'csv', ...fx.importTyped(COLS, rows) }).id
  // DL = fx.loadWarehouse('two_dates', COLS, rows) then H.liveOver(P, { table: 'two_dates' }, COLS).liveId
  const bad = (await post('metric:save', { projectId: P, input: { name: 'Bad', datasetId: D, definition: { column: 'amt', aggregation: 'sum' }, timeColumn: 'region' } })).value;
  ok('a column that is not a date is refused beside its field', bad.ok === false && bad.field === 'timeColumn' && /not a date column/.test(bad.error));
  const REV = (await post('metric:save', { projectId: P, input: { name: 'Revenue', datasetId: D, definition: { column: 'amt', aggregation: 'sum' }, timeColumn: 'ship_date' } })).value.metric.id;
  const ORD = (await post('metric:save', { projectId: P, input: { name: 'Orders', datasetId: D, definition: { column: 'amt', aggregation: 'count' } } })).value.metric.id;
  const f1 = (await post('metric:save', { projectId: P, input: { name: 'Double', datasetId: D, definition: { formula: '[Revenue] * 2' } } })).value;
  ok('a formula whose part counts by another date is refused', f1.ok === false && f1.field === 'timeColumn' && /Revenue/.test(f1.error));
  ok('NEGATIVE CONTROL: the same formula on the part\'s date saves', (await post('metric:save', { projectId: P, input: { name: 'Double', datasetId: D, definition: { formula: '[Revenue] * 2' }, timeColumn: 'ship_date' } })).value.ok === true);
  const set = (await post('metric:update', { projectId: P, id: ORD, patch: { timeColumn: 'order_date' } })).value;
  const cleared = (await post('metric:update', { projectId: P, id: ORD, patch: { timeColumn: '' } })).value;
  ok('update sets it, and an empty timeColumn clears it', set.metric.timeColumn === 'order_date' && cleared.ok && cleared.metric.timeColumn === undefined);
  ok('the list carries it', (await post('metric:list', { projectId: P })).value.metrics.find((m: Reply) => m.id === REV).timeColumn === 'ship_date');
  ok('metricDate: a column that is gone counts as unset', (await H.as(ORG_A, () => scope.metricDate(P, { datasetId: D, timeColumn: 'gone' }))) === '');
  ```
  Also test `metric:get` on a record written with `timeColumn: 'gone'` (through `metrics.saveMetric`, which skips the handler's check): it replies `timeColumnGone: true`. Revenue's `metric:get` has no such flag (negative control).
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-metricTimeDoors.js`. Expected: the contract refuses `timeColumn` (400).
- [ ] **Step 3: Implement.**
  - `metric:save`: call `checkTimeColumn` after `nameTaken`. A sentence comes back as `{ ok: false, error, field: 'timeColumn' }`.
  - `metric:update`: check against `before` merged with the patch, only when the patch has `definition` or `timeColumn`.
  - `updateMetric`: `timeColumn` is clearable, like `description`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/i18n-extract.js && node scripts/test-metricTimeDoors.js && node scripts/test-metrics.js && node scripts/test-metricCheck.js && node scripts/test-i18n.js && node scripts/check-contracts.js`. Expected: 0 failures and 0 unresolved.
- [ ] **Step 5: Commit.** `git add src/analysis/metricTimeScope.ts src/api/metrics.ts src/analysis/metrics.ts src/ipc/metrics.ts src/analysis/metricCheckMessages.ts src/i18n scripts/test-metricTimeDoors.ts`, message `Let a metric name the date it counts by, checked on save`.

### Task 4: Charts under a date control

**Files:** Modify `src/analysis/metricTimeScope.ts` (add `chartScope`) · Modify:
- `src/ipc/visuals.ts`: `VizDataReply` l.397-418 (`periodOn?: string`), `vizDataFor` l.452-455, and the `vizData` handler l.629-653 (rewrite before `run`, stamp `periodOn`).
- `src/ipc/drillScope.ts` l.36-62.
- `src/ipc/driversPoint.ts` l.62-64.

Test: `scripts/test-metricTimeDoors.ts`.
**Interfaces:** Consumes `hasMetricMeasure` (step 03), and `rewriteControlPeriods`, `hasControlPeriod`, `controlPeriodMoved` (Task 2). Produces:
- `chartScope(projectId: string, datasetId: string, encoding: VizEncoding, filters: FilterStep[]): Promise<{ ok: true; filters: FilterStep[]; periodOn?: string } | { ok: false; error: string }>`. With no mark it returns the filters unchanged and makes no reads. Otherwise the drawn measures (`values[0]` under a split) give one date each: the metric's `metricDate` for a metric measure on this dataset, `''` for anything else. Two different dates give `measuresCountByDifferentDates`.
- `VizDataReply.periodOn?: string`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const CTRL = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from: '2024-03-01', to: '2024-03-31' }, fromControl: true };
  const ON = (column: string) => ({ type: 'filter', column, op: 'period', period: CTRL.period });
  const byRegion = (id: string, agg = 'sum') => ({ category: 'region', values: [{ column: 'amt', aggregation: agg, metricId: id }] });
  const a = await chart(D, byRegion(REV), { filters: [CTRL] });
  const b = await chart(D, byRegion(REV), { filters: [ON('ship_date')] });
  ok('the control lands on the metric\'s date', JSON.stringify(a.data) === JSON.stringify(b.data) && a.periodOn === 'ship_date');
  ok('NEGATIVE CONTROL: the control\'s own column is a different figure', JSON.stringify(a.data) !== JSON.stringify((await chart(D, byRegion(REV), { filters: [ON('order_date')] })).data));
  const u1 = await chart(D, byRegion(ORD, 'count'), { filters: [CTRL] });
  const u0 = await chart(D, byRegion(ORD, 'count'), { filters: [ON('order_date')] });
  ok('unset: byte-identical to today, no caption', JSON.stringify(u1.data) === JSON.stringify(u0.data) && JSON.stringify(u1.warnings) === JSON.stringify(u0.warnings) && u1.periodOn === undefined);
  const both = { category: 'region', values: [byRegion(REV).values[0], { column: 'amt', aggregation: 'count', metricId: ORD }] };
  const clash = await chart(D, both, { filters: [CTRL] });
  ok('two dates under a control: refused, naming both', clash.ok === false && /Revenue/.test(clash.error) && /Orders/.test(clash.error));
  ok('NEGATIVE CONTROL: the same chart with no control draws', (await chart(D, both)).ok === true);
  ok('a tile\'s own date filter stays on its column', JSON.stringify((await chart(D, byRegion(REV), { filters: [CTRL, ON('order_date')] })).data) === JSON.stringify((await chart(D, byRegion(REV), { filters: [ON('ship_date'), ON('order_date')] })).data));
  const cmpA = await chart(D, { ...byRegion(REV), compare: { mode: 'previous_period' } }, { filters: [CTRL] });
  const cmpB = await chart(D, { ...byRegion(REV), compare: { mode: 'previous_period' } }, { filters: [ON('ship_date')] });
  ok('compare shifts the date the period landed on', JSON.stringify(cmpA.data) === JSON.stringify(cmpB.data));
  const drill = (await post('visual:rows', { projectId: P, datasetId: D, encoding: byRegion(REV), filters: [CTRL], mark: { category: 'West' } })).value;
  ok('drill rows use the metric\'s date', drill.filters.some((f: Reply) => f.column === 'ship_date' && f.op === 'period') && !drill.filters.some((f: Reply) => 'fromControl' in f));
  const lv = await hydrates(DL, () => chart(DL, byRegion(REVL), { filters: [CTRL] }));
  ok('Live: same figures as the extract, never hydrated', lv.hydrated === false && cmp.compareCharts(a.data, lv.value.data, () => true, false).length === 0);
  ```
  `REVL` is Revenue saved on `DL` with `timeColumn: 'ship_date'`.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-metricTimeDoors.js`. Expected: "the control lands on the metric's date" fails.
- [ ] **Step 3: Implement.**
  - `vizDataFor`: run `chartScope` first. A refusal comes back as `{ ok: false, error }`. Otherwise call `lockedViz(…, scoped.filters, …)` and spread `periodOn` onto a successful reply.
  - The handler calls `chartScope` on `bound.steps` before `run`/`withPeriodOverlay`/`withCompareSeries`, then adds `periodOn` to the reply before `stampAsOf`. The door's own call is then a no-op.
  - `drillFilters` rewrites `filters` with `chartScope`. With `req.metricId`, it uses `metricScope` (Task 5) before prepending the metric's filters.
  - `explainPoint` rewrites with `chartScope` before `vizDataFor`/`pointPlan`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-metricTimeDoors.js && node scripts/test-compareSeries.js && node scripts/test-visual-rows.js && node scripts/test-driversPoint.js && node scripts/test-liveRoute.js && node scripts/test-file-size.js`. Expected: 0 failures, and `visuals.ts` ≤ 776.
- [ ] **Step 5: Commit.** `git add src/analysis/metricTimeScope.ts src/ipc/visuals.ts src/ipc/drillScope.ts src/ipc/driversPoint.ts scripts/test-metricTimeDoors.ts`, message `Apply a dashboard's date control to a chart metric's own date`.

### Task 5: KPIs, compare, the metric tree, alerts and "Why did this change?"

**Files:** Modify `src/analysis/metricTimeScope.ts` (add `metricScope`) · Modify:
- `src/ipc/metrics.ts`: `ResolvedMetric` l.205 (`periodOn?`), `resolveMetric` l.228.
- `src/ipc/dashboards.ts`: `computeCardMetric` l.149-157 strips marks.
- `src/ipc/periods.ts` `compareMetric` l.56-75, and `src/analysis/periodScope.ts` `compareScope` l.125-143 (4th parameter `dateColumn?: string`).
- `src/ipc/metricTree.ts` `computeFor` l.326-328.
- `src/analysis/alertStore.ts` `metricFor` l.319-342.
- `src/ipc/drivers.ts` `drivers:explain` l.527-536.
- `src/ipc/analysesServer.ts` l.153 (pass `periodOn`).

Test: `scripts/test-metricTimeDoors.ts`.
**Interfaces:** Produces `metricScope(projectId: string, m: Metric, filters: FilterStep[]): Promise<{ filters: FilterStep[]; periodOn?: string }>` and `compareScope(filters, columns, compare, dateColumn?)`. `dateColumn` is used in place of the first date column for `custom` with nothing in scope.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const tile = async (metricId: string, filters: unknown[], compare?: unknown) => (await post('analysis:tiles', { projectId: P, items: [{ kind: 'metric', metricId, datasetId: D, column: 'amt', aggregation: 'sum', filters, ...(compare ? { compare } : {}) }] })).value[0];
  const k1 = await tile(REV, [CTRL]);
  ok('KPI: the control lands on the metric\'s date, and says so', Object.is(k1.value, (await tile(REV, [ON('ship_date')])).value) && k1.periodOn === 'ship_date');
  ok('KPI unset: today\'s figure, no caption', Object.is((await tile(ORD, [CTRL])).value, (await tile(ORD, [ON('order_date')])).value) && (await tile(ORD, [CTRL])).periodOn === undefined);
  ok('compare: the previous period on the metric\'s date', Object.is((await tile(REV, [CTRL], { mode: 'previous_period' })).compare.previous, (await tile(REV, [ON('ship_date')], { mode: 'previous_period' })).compare.previous));
  const feb = { type: 'filter', column: 'ship_date', op: 'period', period: { preset: 'custom', from: '2024-02-01', to: '2024-02-29' } };
  ok('custom compare with nothing in scope uses the metric\'s date', Object.is((await tile(REV, [], { mode: 'custom', from: '2024-02-01', to: '2024-02-29' })).compare.previous, (await tile(REV, [feb])).value));
  const tree = (await post('metricTree:compute', { projectId: P, id: REV, filters: [CTRL] })).value;
  ok('tree: the period is the control\'s, on the metric\'s date', tree.period.from === '2024-03-01' && Object.is(tree.root.current, (await tile(REV, [ON('ship_date')])).value));
  const t0 = (await post('metricTree:compute', { projectId: P, id: REV })).value;
  ok('tree with no scope: its latest month is on the metric\'s date', Object.is(t0.root.current, (await tile(REV, [{ type: 'filter', column: 'ship_date', op: 'period', period: { preset: 'custom', from: t0.period.from, to: t0.period.to } }])).value));
  const rule = { id: '55555555-5555-4555-8555-555555555555', name: 'r', datasetId: D, metric: { column: 'amt', aggregation: 'sum', metricId: REV, filters: [CTRL] }, compare: 'threshold', threshold: { op: '<', value: 1 }, enabled: true };
  ok('an alert saved from the KPI counts the KPI\'s figure', Object.is((await H.as(ORG_A, () => alertStore.metricFor(P, rule as never))).value, k1.value));
  const bareRule = await H.as(ORG_A, () => alertStore.metricFor(P, { ...rule, metric: { ...rule.metric, metricId: undefined } } as never));
  const onOrder = (await post('dashboard:metric', { projectId: P, datasetId: D, column: 'amt', aggregation: 'sum', filters: [ON('order_date')] })).value;
  ok('NEGATIVE CONTROL: an alert on a bare column keeps the control\'s column', Object.is(bareRule.value, onOrder.value));
  // Live KPI: tile on REVL under [CTRL] is Object.is the extract's k1.value and never hydrates
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-metricTimeDoors.js`. Expected: the KPI assertions fail.
- [ ] **Step 3: Implement.**
  - `resolveMetric`: `const s = await metricScope(projectId, metric, scope.filters ?? [])`. Use `s.filters` as `ctx.scope` and set `out.periodOn` from `s.periodOn`.
  - `computeCardMetric`: `rewriteControlPeriods(filters, '')` before `lockedMetric`.
  - `compareMetric` with a metric: run `metricScope` before `compareScope(…, await metricDate(projectId, metric) || undefined)`.
  - `computeFor`: run `metricScope` on `filters` after l.326. On l.328 the fallback becomes `|| (await metricDate(projectId, root)) || meta.columns.find(…)`.
  - `alertStore.metricFor`: if `rule.metric.metricId` resolves to a metric, run `metricScope` on its filters.
  - `drivers:explain`: if `spec.metric.metricId` resolves, run `metricScope` on `spec.filters`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-metricTimeDoors.js && node scripts/test-metrics.js && node scripts/test-metricTree.js && node scripts/test-alerts.js && node scripts/test-drivers.js && node scripts/test-analysesServer.js && node scripts/test-liveRoute.js`. Expected: 0 failures.
- [ ] **Step 5: Commit.** `git add src/analysis/metricTimeScope.ts src/analysis/periodScope.ts src/ipc/metrics.ts src/ipc/dashboards.ts src/ipc/periods.ts src/ipc/metricTree.ts src/analysis/alertStore.ts src/ipc/drivers.ts src/ipc/analysesServer.ts scripts/test-metricTimeDoors.ts`, message `Count a KPI, its compare, its tree and its alert by the metric's date`.

### Task 6: Date controls mark their steps, and tiles say which date

**Files:** Modify `src/analysis/dashboardFilters.ts` l.187-195 (both `period` returns get `fromControl: true`) · Modify `web/src/features/analyses/editor/filters.ts` l.17-21 (the same) · Modify `web/src/features/analyses/api.ts` l.269 and l.291 (`periodOn?: string` on `VisualTile` and `MetricTile`) · Modify `web/src/features/analyses/VisualTile.tsx` l.258-266 and `web/src/features/analyses/editor/MetricCard.tsx` (the caption) · Update the pinned expectations: `scripts/test-dashboardFilters.ts` l.179-191, `scripts/test-dateIntel.ts` l.253-257, `scripts/test-savedViews.ts` l.158-163, `web/src/features/analyses/editor/doc.test.ts` l.61 · Test: `scripts/test-metricTimeDoors.ts`; Create `web/src/features/analyses/periodOn.test.tsx`
**Interfaces:** The step order is `{ type, column, op: 'period', period, fromControl: true }`, so JSON pins read `…"period":{…},"fromControl":true}`.
- [ ] **Step 1: Write the failing test.** Server:
  - `controlSteps({ kind: 'date_range', column: 'd' }, { preset: 'last_n_days', n: 30 })[0].fromControl === true`.
  - NEGATIVE CONTROL: the dropdown step has no `fromControl`.
  - A published dashboard: `buildDashboard(P, A, 4)`, with a `date_range` control on `order_date` defaulting to March and a KPI card on Revenue (shaped as in `scripts/test-publishCombos.ts`). Its KPI payload `value` is `Object.is` `(await tile(REV, [ON('ship_date')])).value`.
  - `viewScope` (reports, subscriptions) marks the same step.

  Web `periodOn.test.tsx`, mocking `fetch` as `liveTile.test.tsx` does:
  - A `VisualTileBody` whose `analysis:tiles` reply has `periodOn: 'ship_date'` shows `Date range applied to ship_date`. One without `periodOn` doesn't (negative control).
  - The same two cases for a KPI card.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-metricTimeDoors.js && node scripts/test-dashboardFilters.js` and `npm run test:web -- periodOn doc`. Expected: no `fromControl`, and the caption is missing.
- [ ] **Step 3: Implement.** Add the mark in both `controlSteps` and update the four pinned expectations listed above. These are hand-written expectations, not golden fixtures. Render the caption as `<p className={s.periodOn}>Date range applied to {periodOn}</p>`, with a muted small-text class in each component's CSS module, for both themes.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-metricTimeDoors.js && node scripts/test-dashboardFilters.js && node scripts/test-dateIntel.js && node scripts/test-savedViews.js && node scripts/test-savedViewsServer.js && node scripts/test-publishCombos.js && node scripts/test-embedLock.js && npm run test:web && npm run lint`. Expected: 0 failures and 0 findings.
- [ ] **Step 5: Commit.** `git add src/analysis/dashboardFilters.ts web/src/features/analyses scripts/test-dashboardFilters.ts scripts/test-dateIntel.ts scripts/test-savedViews.ts scripts/test-metricTimeDoors.ts`, message `Mark a date control's steps and say on the tile which date it used`.

### Task 7: Sparkline, scorecards, the alert's period and the editor's suggestion

**Files:** Modify:
- `src/ipc/metrics.ts`: `sparkColumn` l.380-385 takes the `Metric`, and its caller in `metric:series` l.544.
- `src/ipc/scorecards.ts`: `dateColOf` l.148-155 takes the `Metric`, and its callers at l.188 and l.210. The `anchorFor` `seen` key becomes `datasetId|column`.
- `web/src/features/dashboards/AlertDialog.tsx` l.79: `period` is `string | null`, read as `period ?? suggested ?? ''`, where `suggested` is the metric's `timeColumn` from `useMetricList`.
- `web/src/features/analyses/metrics/MetricEditor.tsx`: a "Date it counts by" select, `'' = the dashboard's date`, plus the date columns. When it is unset and the dataset has exactly one date column, a "Use <column>" button sets it (it never sets it silently). A `timeColumnGone` warning. `timeColumn` goes in both `saveMetric` calls (l.137, l.148).
- `web/src/features/analyses/metrics/api.ts` (types).

Test: `scripts/test-metricTimeDoors.ts`; Create `web/src/features/analyses/metrics/timeColumn.test.tsx`.
- [ ] **Step 1: Write the failing test.** Server:
  - `metric:table` → `rows[REV].series` is element-wise `Object.is` `resolveMetricSeries(P, REV, 'ship_date').values`.
  - NEGATIVE CONTROL: Orders' series equals the `order_date` one.
  - `computeScorecard(P, sc)` with one Revenue row: `rows[0].value` is `Object.is` `(await resolveMetric(P, REV, { filters: [{ type: 'filter', column: 'ship_date', op: 'period', period: { preset: 'custom', from: res.window.from, to: res.window.to } }] })).value`.

  Web:
  - A dataset with one date column shows `Use order_date`, with the select still on "The dashboard's date". Clicking the button puts `timeColumn: 'order_date'` in the save body.
  - With two date columns there is no button (negative control).
  - An `AlertDialog` for a metric with `timeColumn: 'ship_date'`, switched to "previous period", shows `ship_date` picked.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-metricTimeDoors.js` and `npm run test:web -- timeColumn`. Expected: the series runs along `order_date`, and the button is missing.
- [ ] **Step 3: Implement.** `sparkColumn(projectId, m)` and `dateColOf(ctx, m)` both return `(await metricDate(projectId, m)) || <the dataset's first date column, as today>`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-metricTimeDoors.js && node scripts/test-scorecards.js && node scripts/test-analysesServer.js && npm run test:web && npm run lint && npm --prefix web run size`. Expected: 0 failures, and ≤ 300 KB gzip.
- [ ] **Step 5: Commit.** `git add src/ipc/metrics.ts src/ipc/scorecards.ts web/src/features/dashboards/AlertDialog.tsx web/src/features/analyses/metrics scripts/test-metricTimeDoors.ts`, message `Run sparklines, scorecards and alerts along a metric's date; suggest it in the editor`.

### Task 8: The Assistant puts "last month" on the metric's date

**Files:** Modify:
- `src/ai/answerSpec.ts`: `SpecMetric` l.74-82 (`timeColumn?`), `resolveFilter` l.255-266 (a `period` with no `column` takes the default), and the filter loop l.347-352 (default = the one `timeColumn` shared by the spec's metric measures, when it is a date column of the dataset).
- `src/ipc/answers.ts` `specMetrics` l.245-258.
- `src/ai/copilotFacts.ts`: `FactMetric` l.115-123, and `metricLines` l.130 appends `` ` Counts by ${m.timeColumn}.` ``.
- `src/ipc/copilot.ts` l.163.
- `src/ai/suggestedAction.ts` l.198: `{"column":"<date column>","period":…}`, then `; leave "column" out to use a metric's own date`.

Test: `scripts/test-answerSpec.ts`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const metricsT = [{ id: REV_ID, name: 'Revenue', datasetId: DS.id, column: 'amt', aggregation: 'sum', timeColumn: 'ship_date' }];
  const v = validateAnswerSpec({ dataset: DS.name, category: 'region', measures: [{ metric: 'Revenue' }], filters: [{ period: 'last_month' }] }, [DS], { metrics: metricsT });
  ok('a period with no column lands on the metric\'s date', v.ok && same(v.spec.filters, [{ column: 'ship_date', period: 'last_month' }]));
  ok('an explicit date column is kept', validateAnswerSpec({ dataset: DS.name, category: 'region', measures: [{ metric: 'Revenue' }], filters: [{ column: 'order_date', period: 'last_month' }] }, [DS], { metrics: metricsT }).spec.filters[0].column === 'order_date');
  ok('NEGATIVE CONTROL: with no metric date a period needs its column (today\'s refusal)', validateAnswerSpec({ dataset: DS.name, category: 'region', measures: [{ column: 'amt' }], filters: [{ period: 'last_month' }] }, [DS], {}).ok === false);
  ```
  `DS` gets `order_date` and `ship_date` date columns in this suite. Also test that `metricLines` writes `Counts by ship_date.` for a fact metric with `timeColumn`, and nothing extra without one.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-answerSpec.js`. Expected: the first assertion is refused as an unknown filter column.
- [ ] **Step 3: Implement** as listed under Files.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-answerSpec.js && node scripts/test-liveRouteAnswers.js && node scripts/test-pluginSkills.js`. Expected: 0 failures.
- [ ] **Step 5: Commit.** `git add src/ai/answerSpec.ts src/ipc/answers.ts src/ai/copilotFacts.ts src/ipc/copilot.ts src/ai/suggestedAction.ts scripts/test-answerSpec.ts`, message `Put the Assistant's relative periods on a metric's own date`.

**Before each PR:** `npm test` (all suites), `node scripts/check-contracts.js` (0 unresolved), `npm run test:web`, `npm run lint` (0), `npm --prefix web run size`, and `node scripts/gen-automation-docs.js` (commit `docs/automation.md` if `list_metrics` now shows `timeColumn`). Note (index review): `metricsList` in `src/automation/handlers.ts` maps fixed fields, so add `counts_by: m.timeColumn ?? null` there explicitly, with an assertion in this step's suite.
