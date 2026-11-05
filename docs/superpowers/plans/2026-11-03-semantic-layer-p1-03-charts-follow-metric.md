# Semantic layer part 1, step 03: Charts follow their metric — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chart measure picked from a saved metric draws the metric as it is defined now (its filters, its current column and aggregation), and `metric:usage` names every chart whose numbers change.
**Architecture:** The planner the chart door already calls for every metric measure (`planMetricMeasures`, `src/analysis/metricMeasures.ts`) stops skipping simple metrics. When every drawn measure shares one metric filter list it returns the followed measures plus that list, and the door asks itself once with them (works for facets, overlays and Live). When measures need different filters it returns the existing per-leaf plan (`src/ipc/vizMetricMeasures.ts`). A simple metric with no filters whose copy still matches returns `null`, so today's path runs unchanged.
**Tech Stack:** TypeScript server (`src/analysis`, `src/ipc`), React (`web/src/features/visuals`, `web/src/features/analyses/metrics`), self-checks, Vitest.
**Spec:** docs/semantic-layer/00-design.md (D16, Owner's answer A, "Left to the builder") · Index: docs/superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md
**Branch and PR:** `feat/semantic-p1-03-charts-follow-metric` off `origin/develop` (after step 02 merges), one PR to `develop`.

## Answer to "Left to the builder": does `vizMetricMeasures` run on Live?

**Yes.** `vizDataForUnlocked` (`src/ipc/visuals.ts:465-466`) runs the planner **before** the Live split (`liveMetaOf`, line 468), and every inner question goes back through `vizDataFor` and so reaches `liveChart`. `scripts/test-metricMeasures.ts` §7 already proves a formula measure on a Live dataset is answered by the warehouse and never hydrated. So D16 works on Live through the same code. Two things change there and the owner should know about them:
- **More warehouse statements in one case.** The shared-filter path is one statement, the same as today. The per-measure path (measures with *different* metric filters on one chart) costs one statement per distinct filter list, and each counts toward `LIVE_DAILY_QUERY_LIMIT`.
- **New typed refusals.** A metric filter the Live compiler refuses (`within_km`, `contains` on a number: `adaptFilter`, `src/engine/live/liveSpec.ts:227-281`) now refuses the chart with its catalog sentence. Before, the chart drew the unfiltered copy.

## Global Constraints

- Two implementations agree: the chart door's figure equals the KPI resolver's (`metric:values`) under the same label filter, compared with `Object.is` on integer totals.
- A simple metric with no filters, still matching its copy, draws byte-identically to today. Golden fixtures are never re-recorded.
- Live has no JS fallback. Every new figure goes through `vizDataFor`. `test-liveRoute` and `test-liveSafetyNet` stay green, and no channel is added.
- `src/ipc/visuals.ts` is at 769 lines (cap 800): it gets **no net new lines**. The new code goes in `metricMeasures.ts` (166) and `vizMetricMeasures.ts` (156).
- `src/api/index.ts`, `routes.tsx` and `nav.ts` are untouched. No new contract: `metric:usage` reaches the browser inside `metric:table` (`src/ipc/analysesServer.ts:205-225`).
- Rolling deploy: no stored field is added. `MetricUsageRef.change` exists only in replies. For a few minutes an old pod draws the copy and a new pod draws the metric. Each pod's answer cache is its own, so no wrong answer gets cached across pods.

## Review Focus

- **Facets.** A faceted chart whose measures need *different* metric filters is now refused with `measureNoFacets` (before, it drew the copy). A faceted chart with one filtered metric measure still draws. Task 1 tests both.
- **Series name.** A followed simple metric keeps the plain measure's series name (`sum of qty`), so per-series formatting keyed by name still applies. Task 1 pins it, on both the shared-filter path and the per-measure path.
- **Share policy follows the edit.** If a metric is edited onto a sensitive column, `applyToChart` must see the new column (`withLeafMeasures`). Task 1 tests export/drop.
- **Table calcs see the followed aggregation.** If a metric is edited from `sum` to `avg`, step 02's additivity refusal must see `avg`, not the stored `sum`. Task 1 passes the followed encoding to `withTableCalcs`.
- **No loop.** The follow path's inner ask carries no `metricId`, so the planner returns `null` the second time. Task 1 checks this implicitly (the chart answers) and directly (`planMetricMeasures` on the inner encoding is `null`).
- **Drill.** The rows behind a followed chart's mark must carry the metric's filters, or they don't add up to the bar. Task 2 tests this.
- **Out of part 1 (owner: flagged).** Pivot values (`encoding.pivot.values[].metricId`) still draw their copy: `hasMetricMeasure` returns false for pivots and the pivot door has no plan. Restricted viewers are still refused any chart with a metric measure (`rowDoors.reachesOther`, unchanged).

---

### Task 1: The chart door follows the metric

**Files:** Modify `src/analysis/metricMeasures.ts` (`PlanResult` l.53, `planMetricMeasures` l.68-144, `withLeafMeasures` l.160-166) · Modify `src/ipc/vizMetricMeasures.ts` (add `followMetricMeasures` after l.61; simple-leaf series in `metricMeasureData` l.127-137) · Modify `src/ipc/visuals.ts` l.59-60 (import), l.466 (dispatch), l.637-638 (`run` hands `withTableCalcs` the followed encoding) · Test: Create `scripts/test-chartsFollowMetric.ts`
**Interfaces:** Produces:
- `needsMetricPlan(m: Metric): boolean`. It is `m.filters.length > 0` here; step 07 adds `|| !!m.definition.snapshot`. Step 04 does **not** add `timeColumn` (see step 04's plan).
- `type PlanResult = { ok: true; values: VizMeasure[]; filters: FilterStep[]; plan?: MeasurePlan } | { ok: false; error: string }`. `values` are the encoding's measures, with each drawn simple-metric measure's `column`/`aggregation` replaced by the metric's own (`metricId`, `datasetId` and `calc` kept). `filters` is the shared metric filter list, with params bound. `plan` is present only when the measures need separate questions.
- `MeasurePlan.formulas` values gain `simple?: true` (a simple metric planned as one leaf).
- `followedEncoding(projectId: string, datasetId: string, encoding: VizEncoding, params?: ParamValues): Promise<VizEncoding>`, which returns `{ ...encoding, values: res.values }`, or the encoding itself when the planner returns `null`.
- `followMetricMeasures(res: Extract<PlanResult, { ok: true }>, encoding: VizEncoding, filters: FilterStep[], ask: Ask): Promise<VizDataReply>` (in `vizMetricMeasures.ts`).

Planner rule for each drawn measure (`considered`: only `values[0]` under a split, as today):
- No `metricId`, a metric that is gone, or a simple metric on another dataset: plain, own filters `[]`, stored copy kept.
- A formula metric: the plan, as today.
- A simple metric: the followed copy, own filters = its `filters` if `needsMetricPlan`, else `[]`.

Outcomes:
- No formula and every measure's own-filter JSON is equal: `{ ok, values, filters: shared }` with no plan, or `null` when the shared list is `[]` and no copy changed.
- Otherwise: `{ ok, values, filters: [], plan }`. In the plan, a filtered simple metric is `formulas.set(i, { name: measureLabel(followed), root: leafOf(...), simple: true })` and an unfiltered one is a plain measure.

- [ ] **Step 1: Write the failing test.** `scripts/test-chartsFollowMetric.ts`. Same harness and helpers as `scripts/test-metricMeasures.ts` l.23-60 (`save`, `chart`, `kpi`, `eq`, `nums`, `sum`, `inRegion`, `COL`). Assertions:
  ```ts
  const t3 = await save('Tier 3 qty', X, { column: 'qty', aggregation: 'sum' }, [eq('tier', 3)]);
  const enc3 = { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: t3 }] };
  const c = await chart(X, enc3);
  for (const [i, label] of c.data.labels.entries()) {
    const want = sum(nums(inRegion(label).filter((r) => r[COL.tier] === 3), COL.qty));
    ok(`"${label}": the metric's filter applies (reference, Object.is)`, Object.is(c.data.series[0].values[i], want));
    if (label !== '') ok(`"${label}": equals the metric's KPI tile (Object.is)`, Object.is(c.data.series[0].values[i], await kpi(t3, [eq('region', label)])));
  }
  ok('the series keeps the plain measure\'s name', c.data.series[0].name === 'sum of qty');
  const plainQty = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum' }] });
  ok('NEGATIVE CONTROL: the unfiltered column is a different figure', JSON.stringify(c.data) !== JSON.stringify(plainQty.data));
  // byte-identical when there is nothing to follow
  const sales = await save('Sales', X, { column: 'qty', aggregation: 'sum' });
  const same = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: sales }] });
  ok('an unfiltered, unedited metric draws byte-identically', JSON.stringify(same.data) === JSON.stringify(plainQty.data) && JSON.stringify(same.warnings) === JSON.stringify(plainQty.warnings));
  ok('… and the planner returns null for it', (await H.as(ORG_A, () => measures.planMetricMeasures(P, X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: sales }] } as never))) === null);
  // edited since the chart was made: the stored copy says amt, the metric says qty
  const edited = await chart(X, { category: 'region', values: [{ column: 'amt', aggregation: 'sum', metricId: sales }] });
  ok('a chart follows an edit to its metric', JSON.stringify(edited.data) === JSON.stringify(plainQty.data));
  // two measures, two metric filter lists, one plain beside them
  const t1 = await save('Tier 1 qty', X, { column: 'qty', aggregation: 'sum' }, [eq('tier', 1)]);
  const threeEnc = { category: 'region', values: [enc3.values[0], { column: 'qty', aggregation: 'sum', metricId: t1 }, { column: 'amt', aggregation: 'sum' }] };
  const two = await chart(X, threeEnc);
  // per label: series[0] = tier-3 reference, series[1] = tier-1 reference, series[2] equals the plain amt chart's cell (Object.is each)
  ok('each measure keeps its own name', two.data.series.map((x: Reply) => x.name).join('|') === 'sum of qty|sum of qty|sum of amt');
  // editing the metric changes the chart on the next draw
  await post('metric:update', { projectId: P, id: t3, patch: { filters: [eq('tier', 2)] } });
  // chart(X, enc3) cells now equal the tier-2 reference (Object.is)
  // facets
  const f1 = await chart(X, { ...enc3, facet: { rows: 'cat' } });
  const f0 = await chart(X, { category: 'region', values: [{ column: 'qty', aggregation: 'sum' }], facet: { rows: 'cat' } }, { filters: [eq('tier', 2)] });
  ok('a faceted chart with one filtered metric draws, equal to the hand-filtered chart', f1.ok === true && JSON.stringify(f1.data) === JSON.stringify(f0.data));
  const f2 = await chart(X, { ...threeEnc, facet: { rows: 'cat' } });
  ok('measures with different metric filters on small multiples are refused with the sentence', f2.ok === false && /small multiples/.test(String(f2.error)));
  // resident ≡ JS
  // stub residentQuery.isResident = () => false, run H.queryCache.invalidateDataset(X, P) under H.as(ORG_A), re-ask enc3 and the three-measure chart,
  // assert JSON.stringify(slow.data) === JSON.stringify(fast.data) for both, then restore the stub
  // Live: the same metric on L
  const t3L = await save('Tier 3 qty live', L, { column: 'qty', aggregation: 'sum' }, [eq('tier', 3)]);
  const lv = await hydrates(L, () => chart(L, { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: t3L }] }));
  ok('Live: answered by the warehouse, never hydrated', lv.value.ok === true && lv.value.asOf?.mode === 'live' && lv.hydrated === false);
  // Live cells equal the extract's tier-3 chart: cmp.compareCharts(...) returns []
  const bad = await save('Qty contains', L, { column: 'qty', aggregation: 'sum' }, [{ type: 'filter', column: 'qty', op: 'contains', value: '1' }]);
  ok('Live: a metric filter the compiler refuses is a typed refusal', (await chart(L, { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: bad }] })).code === 'live_refused');
  // share policy follows the edit: catalog.setColumn(P, X, 'amt', { sensitivity: 'financial' }); privacy.setPolicy(P, { export: 'drop' });
  // a metric now {amt,sum} drawn from a stored copy {qty,sum} with share:'export' → hiddenByPolicy === true; the qty metric → shown (NEGATIVE CONTROL)
  ```
  Write each commented case as explicit `ok(...)` calls in the same style. The file ends with `await close(); finish();` and the same `.catch` as `test-metricMeasures.ts` l.191-196.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-chartsFollowMetric.js`. Expected: "the metric's filter applies" fails (the chart draws the copy), and so do the edit and facet cases.
- [ ] **Step 3: Implement.** The signatures are listed under Interfaces.
  - `followMetricMeasures`: if `res.plan`, return `metricMeasureData(res.plan, { ...encoding, values: res.values }, filters, ask)`. Otherwise return `ask({ ...encoding, values: res.values.map(({ metricId: _m, ...v }) => v) }, res.filters.concat(filters))`.
  - `metricMeasureData`, non-split branch: if `f.simple`, return `{ ...(leafAt.get(root.leaf)?.series ?? { name: f.name }), values }`, so the series keeps the door's own fields.
  - `visuals.ts` l.466: `if (planned) return planned.ok ? followMetricMeasures(planned, encoding, filters, (e, f) => vizDataFor(projectId, datasetId, e, f, opts)) : { ok: false, error: planned.error };`
  - l.637-638: `withTableCalcs(await vizDataFor(p, d, e, f, { params: values }), await followedEncoding(p, d, e, values))`.
  - `withLeafMeasures`: when there is no `plan`, return `{ ...encoding, values: res.values }`. Otherwise, return as today over `res.values`.
  - Update the header comments of `metricMeasures.ts` (l.18-19) and `VizMeasure.metricId` (`src/analysis/visuals.ts` l.50-63). The copy is now only a fallback for a deleted metric.
  - **From step 02 (already merged by now):** l.637-638 also hands `followedEncoding(...)` to `refuseNonAdditiveCalcs` (`src/analysis/additivity.ts`), in the same place it hands it to `withTableCalcs`, so the additivity check sees the metric's current aggregation.
  - **From step 02's snapshot reader:** in the simple-metric branch of the planner, a metric whose `definition.snapshot` is set is refused with `msg.measureSnapshotPending` (step 02 adds the sentence) until step 07 replaces this with the snapshot door. Without it, a step-03 pod would draw a sum over every date during step 07's rollout. Add `ok('a snapshot metric is refused until step 07', (await chart(X, snapEnc)).ok === false)` to the test, with the snapshot metric saved through step 02's reader.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-chartsFollowMetric.js && node scripts/test-metricMeasures.js && node scripts/test-sharePolicy.js && node scripts/test-liveRoute.js && node scripts/test-rowPolicyLabels.js && node scripts/test-file-size.js`. Expected: every suite prints 0 failures. `test-metricMeasures` keeps "a SIMPLE metric measure plots its stored column, as before", because that metric has no filters.
- [ ] **Step 5: Commit.** `git add src/analysis/metricMeasures.ts src/ipc/vizMetricMeasures.ts src/ipc/visuals.ts src/analysis/visuals.ts scripts/test-chartsFollowMetric.ts`, message `Draw a chart measure as its metric defines it now`.

### Task 2: The rows behind a followed chart carry the metric's filters

**Files:** Modify `src/ipc/drillScope.ts` l.36-62 · Test: `scripts/test-chartsFollowMetric.ts` (new section)
**Interfaces:** Consumes `planMetricMeasures` (Task 1).
- [ ] **Step 1: Write the failing test.**
  ```ts
  const rows = (await post('visual:rows', { projectId: P, datasetId: X, encoding: enc3, filters: [], mark: { category: 'West' } })).value;
  ok('drill: the metric\'s filter is in the row scope', rows.ok && rows.filters.some((f: Reply) => f.column === 'tier' && f.value === 2));
  ok('drill: the count is the rows behind the bar', rows.total === inRegion('West').filter((r) => r[COL.tier] === 2).length);
  const plainRows = (await post('visual:rows', { projectId: P, datasetId: X, encoding: { category: 'region', values: [{ column: 'qty', aggregation: 'sum' }] }, filters: [], mark: { category: 'West' } })).value;
  ok('NEGATIVE CONTROL: a plain chart\'s drill has no tier filter', !plainRows.filters.some((f: Reply) => f.column === 'tier'));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-chartsFollowMetric.js`. Expected: "the metric's filter is in the row scope" fails.
- [ ] **Step 3: Implement.** In `drillFilters`, with no `req.metricId`: `const res = await planMetricMeasures(projectId, datasetId, enc, values)`. If `res?.ok && !res.plan`, set `filters = res.filters.concat(filters)`. Run the grain call on l.58 with the filters as they were **before** this concat, so it hits the tile's cached answer. A per-measure plan keeps today's rows (no single set of rows adds up to two filter lists).
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-chartsFollowMetric.js && node scripts/test-visual-rows.js`. Expected: 0 failures.
- [ ] **Step 5: Commit.** `git add src/ipc/drillScope.ts scripts/test-chartsFollowMetric.ts`, message `List the rows behind a followed chart under its metric's filters`.

### Task 3: `metric:usage` names the charts whose numbers change

**Files:** Modify `src/analysis/metricUsage.ts` (`MetricUsageRef` l.34-43, the visuals loop l.109-122; read the metric once at the top) · Modify `src/analysis/metricMeasures.ts` (add `chartChange`) · Modify `web/src/features/analyses/metrics/MetricsPage.tsx` (`Usage` type l.34, the Used-in cell l.193) · Modify `CHANGELOG.md` (`[Unreleased]`) · Test: `scripts/test-chartsFollowMetric.ts`, `web/src/features/analyses/metrics/viewer.test.tsx`
**Interfaces:** Produces:
- `chartChange(m: Metric, datasetId: string, encoding: VizEncoding): 'filters' | 'definition' | null`. It is null for a formula metric, a pivot (`!hasMetricMeasure`), another dataset, or a metric that isn't a drawn measure. `'filters'` if `needsMetricPlan(m)`. `'definition'` if a drawn copy's `column`/`aggregation` differs from the metric's.
- `MetricUsageRef.change?: 'filters' | 'definition'`, on `kind: 'visual'` refs only.

The Data model section (step 10) and this PR's Metrics page both read it from `metric:table` → `rows[id].usage.refs`. Nothing new to call.
- [ ] **Step 1: Write the failing test.** Server:
  ```ts
  const v1 = (await post('visual:save', { projectId: P, datasetId: X, name: 'Tier chart', chartType: 'column', encoding: enc3 })).value;
  const v2 = (await post('visual:save', { projectId: P, datasetId: X, name: 'Plain sales', chartType: 'column', encoding: { category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: sales }] } })).value;
  const v3 = (await post('visual:save', { projectId: P, datasetId: X, name: 'Old copy', chartType: 'column', encoding: { category: 'region', values: [{ column: 'amt', aggregation: 'sum', metricId: sales }] } })).value;
  const u3 = await H.as(ORG_A, () => usage.metricUsage(P, t3));
  // `visual:save` replies with the saved record itself (src/ipc/visuals.ts l.574-582)
  ok('usage marks a chart built from a filtered metric', u3.refs.find((r) => r.id === v1.id)?.change === 'filters');
  const us = await H.as(ORG_A, () => usage.metricUsage(P, sales));
  ok('usage marks a chart whose copy differs from the metric', us.refs.find((r) => r.id === v3.id)?.change === 'definition');
  ok('NEGATIVE CONTROL: a chart that draws the same figure is not marked', us.refs.find((r) => r.id === v2.id)?.change === undefined);
  ok('the delete sentence is unchanged', us.summary === '2 visuals');
  ```
  Web (`viewer.test.tsx`): a `metric:table` stub row whose `usage.refs` holds two refs with `change` renders the text `2 charts changed`, with the chart names in its `title`. A row with no `change` shows no badge (negative control).
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-chartsFollowMetric.js` and `npm run test:web -- viewer`. Expected: the `change` assertions and the badge test fail.
- [ ] **Step 3: Implement.** `chartChange` uses the same drawn-measure rule as the planner (only `values[0]` under a split). In `MetricsPage`, add `<Badge tone="warn">{n} {n === 1 ? 'chart' : 'charts'} changed</Badge>` after the summary, with `title` set to the changed charts' names joined by `, `. In `CHANGELOG.md`, under `[Unreleased]`, add `### Charts follow their metric`. Say that a chart measure picked from a metric now draws the metric as defined today: its filters apply, and editing the metric changes the chart. Say that charts built from a metric with filters (or from a metric edited since) change their numbers once. Say that the Metrics page marks them per metric ("N charts changed"). Say that pivots still draw their saved copy, and that on a Live dataset a chart with two differently filtered metrics asks the warehouse once per filter list.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-chartsFollowMetric.js && node scripts/test-metrics.js && node scripts/test-analysesServer.js && npm run test:web -- viewer`. Expected: 0 failures. `test-metrics`' "the confirm sentence counts what would break" is unchanged.
- [ ] **Step 5: Commit.** `git add src/analysis/metricUsage.ts src/analysis/metricMeasures.ts web/src/features/analyses/metrics/MetricsPage.tsx web/src/features/analyses/metrics/viewer.test.tsx CHANGELOG.md scripts/test-chartsFollowMetric.ts`, message `Name the charts whose numbers follow their metric now`.

### Task 4: The measure chip says when its metric is gone

**Files:** Modify `web/src/features/visuals/EncodingForm.tsx` l.206-226 · Modify `web/src/features/calc/api.ts` l.67-74 (comment only) · Test: `web/src/features/visuals/calcMeasure.test.tsx`
**Interfaces:** None new.
- [ ] **Step 1: Write the failing test.** In `calcMeasure.test.tsx`, add `it('a measure whose metric was deleted says so and keeps its column', …)`. Mount with `{ category: 'region', values: [{ column: 'revenue', aggregation: 'sum', metricId: '3f0c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b' }] }`. Then:
  `expect(await screen.findByText('Metric deleted')).toBeTruthy()` and `expect(screen.getByRole('combobox', { name: 'Measure column' }).textContent).toBe('revenue')`.
  Negative control: mounted with `metricId: SIMPLE`, `screen.queryByText('Metric deleted')` is null.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- calcMeasure`. Expected: "Metric deleted" not found.
- [ ] **Step 3: Implement.** When `m.metricId && !metric && metrics.isSuccess`, render `<Badge tone="warn" icon="alert">Metric deleted</Badge>`, with `title` set to `` `Its metric was deleted, so this draws the copy it was made from: ${m.aggregation} of ${m.column}.` ``. The column select stays as it is. Rewrite the `metricMeasure` comment: the server draws the metric, and the stored copy is only what a deleted metric falls back to.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web -- calcMeasure && npm run lint && npm --prefix web run size`. Expected: passes, 0 lint findings, initial JS ≤ 300 KB gzip.
- [ ] **Step 5: Commit.** `git add web/src/features/visuals/EncodingForm.tsx web/src/features/calc/api.ts web/src/features/visuals/calcMeasure.test.tsx`, message `Say on the measure chip when its metric was deleted`.

**Before the PR:** `npm test` (all suites, including `test-metricMeasures`, `test-metrics`, `test-sharePolicy`, `test-embedLock`, `test-publishCombos`, `test-liveRoute`, `test-liveSafetyNet`, `test-rowPolicyLabels`, `test-visual-rows`, `test-file-size`, `test-i18n`), `node scripts/check-contracts.js` (0 unresolved), `npm run test:web`, `npm run lint`.
