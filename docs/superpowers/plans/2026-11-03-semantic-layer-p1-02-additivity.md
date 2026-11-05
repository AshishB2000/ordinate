# Semantic layer part 1, step 02: additivity and the table-calculation refusals — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every measure gets an additivity derived from what it is, and the server refuses, with a sentence where the figure would be, any running total, percent of total, moving sum, period-overlay caption or metric-tree sum that would add up figures that can't be added. The same PR ships the reader half of snapshot metrics, so step 07's rolling deploy cannot lose one.
**Architecture:** A pure rule in new `src/analysis/additivity.ts` derives `{categories, time}` from the aggregation, from a formula's shape (`driverShape.metricShape`, the key-drivers reader over the real formula tokenizer) and from a snapshot. One async wrapper, `refuseNonAdditiveCalcs`, runs on the door's reply before `withTableCalcs` at every caller that applies calcs, and at the two published-page builders. It turns a refused calc into `{ok:false, error, code:'calc_not_additive'}`, which every surface already draws as the tile's error. The overlay caption and the metric tree ask the same rule.
**Tech Stack:** TypeScript server (`src/analysis`, `src/ipc`, `src/publish`), self-check scripts. No web change: the web app has no "Calculate as" picker (the desktop's `calcMenu.ts` was deleted in T8.1; the only UI is the calc badge, `EncodingForm.tsx:238`, `PivotShelves.tsx:193`).
**Spec:** docs/semantic-layer/00-design.md (D7 with its late addition, D8 reader half, Owner's answers) · Index: docs/superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md
**Branch and PR:** `feat/semantic-p1-02-additivity` off `origin/develop` (after step 01 merges), one PR to `develop`.

> **Index note (2026-11-03):** Task 1 (the snapshot reader) ships alone first as `feat/semantic-p1-02a-snapshot-reader` in release 1; Tasks 2–4 are the `feat/semantic-p1-02-additivity` PR in release 2. Task 5 (the metric-tree `sum` guard) is dropped: the tree already shows "Not explained by its parts" instead of a wrong total. See the index.

## Global Constraints

- A chart with no adding calc gets its reply object back (`Object.is`) and the check reads no metric and no metadata. This is the tableCalc.ts header's rule: no calc means today's behaviour, byte for byte.
- The adding kinds are exactly `running_total`, `pct_of_total` and `moving_sum` (D7). `diff`, `pct_diff`, the ranks, `percentile`, `moving_avg`, `yoy` and `index` are never refused.
- Additivity reads metric records and `datasets.getDatasetMeta` only, never `getDataset`. A Live chart must not hydrate (`test-liveRoute` spies on it).
- Golden fixtures are never re-recorded (`scripts/fixtures/golden/tableCalc.json`).
- Write sentences as English literals in `src/analysis/metricCheckMessages.ts` and `src/analysis/metricTreeMessages.ts` (both in `MAIN_FILES`, `scripts/i18n-extract.ts:346`), then run `npm run build:ts && node scripts/i18n-extract.js`. Never hand-edit `src/i18n/en.json`.
- File size: `src/ipc/visuals.ts` is at 769 lines (hard cap 800), so add at most one line there (one import). `src/analysis/metrics.ts` is at 468, so add at most 6 lines. `src/ipc/metrics.ts` (563) and `src/ipc/metricTree.ts` (443) get calls only. New logic goes in new files.
- No new channel and no contract change. `metric:save` and `metric:update` keep refusing `snapshot` (strict zod, `src/api/metrics.ts:10-13`) until step 07 adds the writer.
- Commits carry no Co-Authored-By or AI trailer.

## Review Focus

- **A split chart computes only `values[0]`'s calc** (`tableCalc.ts:283`), so the check must look at `values[0]` alone under a split. A second measure's refused calc must not refuse the chart. Pinned in Task 3.
- **A deleted metric** falls back to the stored `{column, aggregation}` (`visuals.ts` VizMeasure doc), so its stored aggregation decides. Pinned in Task 3.
- **A formula metric with a dashboard parameter** (`[Revenue] * [[k]]`) must get `params`. Without them the formula fails to read and is refused, wrongly. Pinned in Task 3.
- **`/p/`, embeds and stories never applied table calcs**: `dashboardData.ts:458` and `storyData.ts:71` call `vizDataFor` without `withTableCalcs`. With this step the refusal shows there, while an allowed calc still publishes the raw figures. That gap is older than this step; it is reported, not fixed here. Pinned in Task 3.
- **A pivot `pct_of_total` over `avg` is refused**, even though the fold divides by a source total (`pivotCalc.ts:11-15`). `test-tableCalc` pins the fold itself, and that test stays green. Pinned in Task 3.
- **The Assistant must never read a refused calculation's figures** (`copilot.ts:233`): it gets the raw figures instead. Pinned in Task 3.
- **The overlay series is still drawn over an `avg`**; only the "up 12%" caption goes. Pinned in Task 4.
- **An old pod re-saving a metric that holds `snapshot`** (a rename, a tree save, a duplicate) must keep it. Pinned in Task 1.
- **The metric tree already shows no wrong total.** Metric-tree D5 adds a "Not explained by its parts" residual row, and the new refusal also blocks a sum of averages over the same rows, which does hold. Task 5 is separable and flagged for the owner.

---

### Task 1: Snapshot, reader half (rolling-deploy safety for step 07)

**Files:** Create `src/analysis/snapshot.ts`. Modify `src/analysis/metrics.ts:57-60` (type) and `:163-173` (`sanitizeDefinition`), `src/ipc/dashboards.ts:149-157` (`computeCardMetric`), `src/analysis/metricMeasures.ts:97-101` (`build`), `src/analysis/driverShape.ts:155-160` (`Shaper.definition`) and `src/analysis/metricCheckMessages.ts` (one sentence). Test: create `scripts/test-snapshotReader.ts`.
**Interfaces:** Produces:
- `export interface MetricSnapshot { column: string; take: 'last' | 'first' }`
- `export function sanitizeSnapshot(raw: unknown): MetricSnapshot | undefined`. It keeps the snapshot only when `column` is a non-empty string of at most 512 characters and `take` is exactly `'last'` or `'first'`.
- `MetricSimpleDefinition.snapshot?: MetricSnapshot`
- `computeCardMetric`'s `spec` widened to `{ column: string; aggregation: MetricAggregation; snapshot?: MetricSnapshot }`
- `msg.measureSnapshotPending(name: string): string`

Step 03's `needsMetricPlan` and step 07 consume these. **Step 03 must refuse a snapshot metric in its own simple-metric branch** with the same `msg.measureSnapshotPending(name)`. That branch plans a simple metric without calling `build`, so without the refusal an old pod would draw a sum over every date during step 07's rollout. Step 07 removes both refusals.

- [ ] **Step 1: Write the failing test.** `scripts/test-snapshotReader.ts`: a temp `ORDINATE_LOCAL_DIR`, `projects.createProject`, and `datasets.saveDataset` with columns `day` (date), `region` (text), `units` (number) and 40 rows. Register `ipcVisuals.register()` and read `handlers.get('visual:data')`, as `scripts/test-compareSeries.ts:60-69` does.
```ts
const def = { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } };
ok('sanitize keeps a snapshot', JSON.stringify(metrics.sanitizeDefinition(def)) === '{"column":"units","aggregation":"sum","snapshot":{"column":"day","take":"last"}}');
ok('no snapshot: byte-identical to today', JSON.stringify(metrics.sanitizeDefinition({ column: 'units', aggregation: 'sum' })) === '{"column":"units","aggregation":"sum"}');
for (const bad of [{ column: '', take: 'last' }, { column: 'day', take: 'middle' }, { column: 7, take: 'last' }, 'day', null])
  ok(`sanitize drops ${JSON.stringify(bad)}`, !('snapshot' in metrics.sanitizeDefinition({ column: 'units', aggregation: 'sum', snapshot: bad })));
ok('a formula never carries one', JSON.stringify(metrics.sanitizeDefinition({ formula: '[A]', snapshot: def.snapshot })) === '{"formula":"[A]"}');
// A record a newer pod wrote. The store API is what step 07's writer calls.
const m = (await metrics.saveMetric(pid, { name: 'Stock', datasetId: ds.id, definition: def }))!;
await metrics.updateMetric(pid, m.id, { name: 'Stock on hand' });
ok('a rename keeps it', isDeepStrictEqual((await metrics.getMetric(pid, m.id))!.definition, def));
await metrics.updateMetric(pid, m.id, { tree: { relation: 'sum', children: [{ metricId: U1 }, { metricId: U2 }] } }, undefined, 'metricTree');
ok('a tree save keeps it', isDeepStrictEqual((await metrics.getMetric(pid, m.id))!.definition, def));
ok('a duplicate keeps it', isDeepStrictEqual((await metrics.duplicateMetric(pid, m.id))!.definition, def));
ok('the contract still refuses a writer', !api.metrics['metric:save'].input.safeParse({ projectId: pid, input: { name: 'x', datasetId: ds.id, definition: def } }).success);
ok('no figure until step 07, never the sum over every date', (await ipcMetrics.resolveMetric(pid, m.id))!.value === null);
const plain = (await metrics.saveMetric(pid, { name: 'Units', datasetId: ds.id, definition: { column: 'units', aggregation: 'sum' } }))!;
ok('NEGATIVE CONTROL: the same column without a snapshot has a figure', typeof (await ipcMetrics.resolveMetric(pid, plain.id))!.value === 'number');
const f = (await metrics.saveMetric(pid, { name: 'Double', datasetId: ds.id, definition: { formula: '[Stock on hand] * 2' } }))!;
const c = await viz(null, { projectId: pid, datasetId: ds.id, encoding: { category: 'region', values: [{ column: 'Double', aggregation: 'sum', metricId: f.id }] } });
ok('a chart over it says why', c.ok === false && c.error === msg.measureSnapshotPending('Stock on hand'));
ok('key drivers refuse it', driverShape.metricShape(ds.id, COLS, def as never, [], new Map()).kind === 'none');
```
`U1` and `U2` are any two fixed UUIDs. `api` is `require('../src/api/metrics')`.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-snapshotReader.js`. Expect the failure at "sanitize keeps a snapshot": today's `sanitizeDefinition` returns `{column, aggregation}`.
- [ ] **Step 3: Implement.**
  - `snapshot.ts` holds the type and `sanitizeSnapshot`, and imports nothing from `metrics.ts`. In `metrics.ts`, write `import type { MetricSnapshot } from './snapshot'`.
  - `sanitizeDefinition` sets `snapshot` only when `sanitizeSnapshot(o.snapshot)` returns one. The key is absent otherwise, which keeps the JSON byte-identical.
  - `computeCardMetric`: `if (spec.snapshot) return Promise.resolve({ ok: true, value: null }); // shortcut: snapshots are computed from step 07; until then no figure, never a sum over every date`.
  - In `build`, for a simple metric with `m.definition.snapshot`: `throw new PlanError(msg.measureSnapshotPending(m.name))`.
  - In `Shaper.definition`, for a simple `def.snapshot`: `fail('It is a snapshot, which keeps only the latest rows, so it does not split into members.')`. This refusal stays after step 07; drivers and tree splits never take snapshots in part 1.
  - The sentence: `${name} is a snapshot metric, which this version of Ordinate can't chart yet.` Then run `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-snapshotReader.js scripts/test-metrics.js scripts/test-drivers.js scripts/test-metricTree.js scripts/test-i18n.js` reports 0 failures.
- [ ] **Step 5: Commit.** `git add src/analysis/snapshot.ts src/analysis/metrics.ts src/ipc/dashboards.ts src/analysis/metricMeasures.ts src/analysis/driverShape.ts src/analysis/metricCheckMessages.ts src/i18n scripts/test-snapshotReader.ts && git commit -m "Keep a metric's snapshot through every save, and refuse to compute it until snapshots ship"`

### Task 2: The additivity rule

**Files:** Create `src/analysis/additivity.ts`. Modify `src/analysis/metricCheckMessages.ts` (two sentences). Test: create `scripts/test-additivity.ts`, section "rules".
**Interfaces:** Consumes `metricShape` (`driverShape.ts:299`), `TableCalcKind` and `CALC_KIND_NAMES` (`tableCalc.ts:78,107`), and `MetricSnapshot` (Task 1). Produces:
```ts
export interface Additivity { categories: boolean; time: boolean }
export function aggregationAdditivity(aggregation: string): Additivity      // sum | count | none → both true; avg | min | max → both false
export function additivityOf(m: Pick<Metric, 'datasetId' | 'definition' | 'filters' | 'name'>, columns: ParsedColumn[], byName: Map<string, Metric>, params?: ParamValues): Additivity
export function calcNeedsAdditive(kind: TableCalcKind, alongTime: boolean): 'categories' | 'time' | null
export function calcRefusal(measure: string, kind: TableCalcKind, a: Additivity, alongTime: boolean): string | null
// metricCheckMessages.ts
export function calcNotAdditive(measure: string, calc: string): string
export function calcNotAdditiveOverTime(measure: string, calc: string): string
```
The rules:
- **Simple metric:** `aggregationAdditivity(def.aggregation)`. With a snapshot, `time` becomes `false`.
- **Formula metric:** both true exactly when `metricShape(m.datasetId, columns, m.definition, m.filters, byName, params, m.name).kind === 'additive'`, else both false.
- **`calcNeedsAdditive`:** for the three adding kinds it returns `alongTime ? 'time' : 'categories'`, and `null` for every other kind.
- **`calcRefusal`:** `null` when the needed side holds. When `a.categories` is true but `time` is needed and `false` (a snapshot), it returns `calcNotAdditiveOverTime`. Every other refusal returns `calcNotAdditive`. The calc's name is `CALC_KIND_NAMES[kind]`.

- [ ] **Step 1: Write the failing test.** Section "rules" of `scripts/test-additivity.ts`:
```ts
const same = (a: Additivity, c: boolean, t: boolean) => Object.is(a.categories, c) && Object.is(a.time, t);
for (const [agg, want] of [['sum', true], ['count', true], ['none', true], ['avg', false], ['min', false], ['max', false]] as const)
  ok(`aggregation ${agg}`, same(A.aggregationAdditivity(agg), want, want));
const COLS = [{ name: 'revenue', type: 'number' }, { name: 'cost', type: 'number' }, { name: 'day', type: 'date' }, { name: 'units', type: 'number' }];
const M = (name: string, definition: object) => ({ id: name, name, datasetId: DS, definition, filters: [] }) as never as Metric;
const ms = [M('Revenue', { column: 'revenue', aggregation: 'sum' }), M('Cost', { column: 'cost', aggregation: 'sum' }), M('Avg price', { column: 'revenue', aggregation: 'avg' })];
const byName = new Map(ms.map((m) => [m.name.toLowerCase(), m]));
for (const [formula, want] of [['[Revenue] - [Cost]', true], ['sum(revenue) + sum(cost)', true], ['2 * [Revenue]', true],
  ['[Revenue] / [Cost]', false], ['[Revenue] + [Avg price]', false], ['sum(revenue) + 5', false], ['[Missing] + [Revenue]', false]] as const)
  ok(`formula ${formula}`, same(A.additivityOf(M('F', { formula }), COLS, byName), want, want));
ok('snapshot sum: across categories yes, across time no', same(A.additivityOf(M('Stock', { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } }), COLS, byName), true, false));
ok('snapshot avg: neither', same(A.additivityOf(M('Lvl', { column: 'units', aggregation: 'avg', snapshot: { column: 'day', take: 'last' } }), COLS, byName), false, false));
for (const k of ['running_total', 'pct_of_total', 'moving_sum'] as const) ok(`${k} adds`, A.calcNeedsAdditive(k, false) === 'categories' && A.calcNeedsAdditive(k, true) === 'time');
for (const k of ['diff', 'pct_diff', 'rank_dense', 'rank_competition', 'percentile', 'moving_avg', 'yoy', 'index'] as const)
  ok(`${k} adds nothing`, A.calcNeedsAdditive(k, false) === null && A.calcNeedsAdditive(k, true) === null);
ok('avg running total → refused', A.calcRefusal('Avg price', 'running_total', { categories: false, time: false }, false) === msg.calcNotAdditive('Avg price', 'a running total'));
ok('snapshot along dates → the time sentence', A.calcRefusal('Stock', 'running_total', { categories: true, time: false }, true) === msg.calcNotAdditiveOverTime('Stock', 'a running total'));
ok('snapshot across regions → allowed', A.calcRefusal('Stock', 'pct_of_total', { categories: true, time: false }, false) === null);
ok('sum along dates → allowed', A.calcRefusal('Revenue', 'moving_sum', { categories: true, time: true }, true) === null);
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-additivity.js` fails with "Cannot find module '../src/analysis/additivity'".
- [ ] **Step 3: Implement.** Write the signatures above. The sentences, as literals, then run `node scripts/i18n-extract.js`:
  - `` `${measure} can't be shown as ${calc}: it can't be added up, so a total of it would be wrong.` ``
  - `` `${measure} can't be shown as ${calc} along dates: it is a snapshot, and a snapshot can't be added up across time.` ``

  Add a comment on the formula branch: `// shortcut: a formula over a snapshot metric reads as not additive (metricShape refuses snapshots); give metricShape a linearity-only mode when snapshot formulas need running totals.`
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-additivity.js scripts/test-i18n.js` reports 0 failures.
- [ ] **Step 5: Commit.** `git add src/analysis/additivity.ts src/analysis/metricCheckMessages.ts src/i18n scripts/test-additivity.ts && git commit -m "Derive whether a measure can be added up across categories and across time"`

### Task 3: Refuse an adding calc on every chart surface

**Files:** Modify:
- `src/analysis/tableCalc.ts:283-290`: extract `calcAlong`; `applyChartCalcs` keeps its dimension note.
- `src/analysis/additivity.ts`
- `src/ipc/visuals.ts`: `:417` adds `'calc_not_additive'` to the `code` union, a single import line for `refuseNonAdditiveCalcs` goes after `:22`, and `:638` is replaced in place. That is +1 line, to 770.
- `src/ipc/vizSample.ts:11,35-36`
- `src/analysis/planPreview.ts:32,251`
- `src/ipc/copilot.ts:14,232-235`
- `src/publish/dashboardData.ts:458`
- `src/publish/storyData.ts:71`

Test: `scripts/test-additivity.ts`, sections "doors", "published" and "assistant".
**Interfaces:** Produces:
```ts
export function calcAlong(calc: TableCalc, enc: { category: string; series?: string }): 'across' | 'down'   // tableCalc.ts
export async function measureAdditivity(projectId: string, datasetId: string, m: VizMeasure, params?: ParamValues): Promise<Additivity>
export async function refuseNonAdditiveCalcs<R extends { ok: boolean; category?: { kind?: string } }>(
  reply: R, projectId: string, datasetId: string, enc: VizEncoding, params?: ParamValues,
): Promise<R | { ok: false; error: string; code: 'calc_not_additive' }>
```
- **`measureAdditivity`:** when `m.metricId` names a metric on `m.datasetId ?? datasetId` that is a formula or carries a snapshot, it returns `additivityOf(metric, meta.columns, byName, params)`. `getDatasetMeta` and `metricsByName` are read lazily, for formulas only. Otherwise it returns `aggregationAdditivity(m.aggregation)`: what is plotted, including a deleted metric's stored copy. **Step 03 must pass `followedEncoding(...)` as `enc` here wherever it passes it to `withTableCalcs`**, so a simple metric's current aggregation decides.
- **`refuseNonAdditiveCalcs`** checks these measures:
  - on a chart, `enc.series ? enc.values.slice(0, 1) : enc.values`;
  - on a pivot, `enc.pivot.values`, each by `aggregationAdditivity` alone, with `alongTime = false` (a pivot plots the stored column).

  The fast path: no measure carries an adding calc, or the reply is not ok, returns `reply` itself.
  - `alongTime`: `calcAlong(...) === 'across'` gives `reply.category?.kind === 'date'`; `'down'` gives "the split column's declared type is `date`", read from the meta.
  - The measure's name in the sentence is the metric's name when `metricId` resolves, else `` `${aggregation} of ${column}` ``.
  - The first refusal wins.

- [ ] **Step 1: Write the failing test.** Section "doors". Fixture `Sales`: columns `day` (date, every day of 2023-01 to 2024-02), `region` (text, East/West), `amount` (number, integer) and `qty`. Metrics:
  - `Revenue`: sum of amount
  - `Cost`: sum of qty
  - `Profit`: `[Revenue] - [Cost]`
  - `Per unit`: `[Revenue] / [Cost]`
  - `Scaled`: `[Revenue] * [[k]]`
  - `Gone`: saved, then deleted

  `chart = (encoding, extra = {}) => viz(null, { projectId: pid, datasetId: ds, encoding, filters: [], ...extra })`, and `RT = { kind: 'running_total', along: 'across' }`.
```ts
const avgRT = await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: RT }] });
ok('avg running total → refused with its sentence', avgRT.ok === false && avgRT.code === 'calc_not_additive' && avgRT.error === msg.calcNotAdditive('avg of amount', 'a running total'), show(avgRT));
const sumRT = await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'sum', calc: RT }] });
ok('NEGATIVE CONTROL: sum running total still runs', sumRT.ok && sumRT.data.series[0].calc?.kind === 'running_total' && Object.is(sumRT.data.series[0].values.at(-1), sumRT.data.series[0].raw.reduce((a, b) => a + b, 0)));
for (const [agg, kind] of [['max', 'pct_of_total'], ['min', 'moving_sum']] as const)
  ok(`${agg} ${kind} → refused`, (await chart({ category: 'region', values: [{ column: 'amount', aggregation: agg, calc: { kind, along: 'across' } }] })).code === 'calc_not_additive');
ok('NEGATIVE CONTROL: diff over avg is not adding', (await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: { kind: 'diff', along: 'across' } }] })).ok === true);
ok('split: values[0] decides', (await chart({ category: 'day', grain: 'month', series: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: { kind: 'running_total', along: 'down' } }] })).code === 'calc_not_additive');
ok('split: a second measure\'s calc is ignored, as the grid ignores it', (await chart({ category: 'day', grain: 'month', series: 'region', values: [{ column: 'amount', aggregation: 'sum' }, { column: 'amount', aggregation: 'avg', calc: RT }] })).ok === true);
ok('formula + − → allowed', (await chart({ category: 'region', values: [{ column: 'Profit', aggregation: 'sum', metricId: profit.id, calc: RT }] })).ok === true);
ok('formula ratio → refused, named', (await chart({ category: 'region', values: [{ column: 'Per unit', aggregation: 'sum', metricId: perUnit.id, calc: RT }] })).error === msg.calcNotAdditive('Per unit', 'a running total'));
ok('formula with a parameter reads it', (await chart({ category: 'region', values: [{ column: 'Scaled', aggregation: 'sum', metricId: scaled.id, calc: RT }] }, { params: [{ name: 'k', kind: 'number', value: 2 }] })).ok === true);
ok('a deleted metric: the stored aggregation decides', (await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'sum', metricId: gone.id, calc: RT }] })).ok === true);
const pv = { rows: [{ column: 'region' }], columns: [], values: [{ column: 'amount', aggregation: 'avg', calc: { kind: 'pct_of_total', along: 'down' } }] };
ok('pivot avg pct_of_total → refused', (await chart({ category: 'region', values: pv.values, pivot: pv })).code === 'calc_not_additive');
const plainReply = { ok: true, data: { labels: [], series: [] } };
let reads = 0; spyOn(metrics, 'getMetric', () => reads++); spyOn(datasets, 'getDatasetMeta', () => reads++);
ok('no adding calc: the reply itself, nothing read', Object.is(await A.refuseNonAdditiveCalcs(plainReply, pid, ds, { category: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: { kind: 'rank_dense', along: 'across' } }] }), plainReply) && reads === 0);
```
  `spyOn` wraps the export and counts calls, as `liveRouteHarness.ts:40-45` wraps `getDataset`. The parameter payload is `paramValues`' input (`params.ts:166`): `[{ name: 'k', kind: 'number', value: 2 }]`.

  Section "published":
  - Build `visuals.saveVisual` for the `avgRT` and `sumRT` encodings, and an `analysis.saveAnalysis` with both as cards, as `scripts/test-publishMemo.ts:22-38` does. Then `const d = await buildDashboard(pid, dash.id, 1)`.
  - Assert that the avg card's `payloads[variants[0]]` deep-equals `{ error: msg.calcNotAdditive('avg of amount', 'a running total') }`.
  - Assert that the sum card's payload has no `error`.

  Section "assistant": `(await ipcCopilot.buildFacts(pid, { kind: 'visual', id: avgVisual.id })).text` does not include `'before the calculation'`, and the same call for the sum visual does (`copilotFacts.ts:346`).
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-additivity.js` fails at "avg running total → refused", because today `ok` is `true`.
- [ ] **Step 3: Implement.** The call sites:
  - **The visual:data handler, `visuals.ts:638`:** `withTableCalcs(await refuseNonAdditiveCalcs(await vizDataFor(p, d, e, f, { params: values }), p, d, e, values), e)`. `withTableCalcs` passes an `ok:false` through untouched.
  - **The preview, `vizSample.ts:36`:** the same, with `sample: true`.
  - **`planPreview.ts:251`:** the same, without params. The existing `if (!res.ok)` then shows the sentence as the card's note.
  - **The Assistant, `copilot.ts:232-235`:** `const refused = await refuseNonAdditiveCalcs(reply, projectId, v.datasetId, v.encoding)`. When it is not ok, build `viz` from `reply` exactly as today but skip `withTableCalcs`, so the Assistant reads raw figures.
  - **The published builders, `dashboardData.ts:458` and `storyData.ts:71`:** wrap the `vizDataFor(...)` result: `await refuseNonAdditiveCalcs(await vizDataFor(...), projectId, v.datasetId, enc, scope.params)`. Story blocks pass no params.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-additivity.js scripts/test-tableCalc.js scripts/test-compareSeries.js scripts/test-publishMemo.js scripts/test-copilot.js scripts/test-liveRoute.js scripts/test-file-size.js scripts/test-asyncReach.js && npm run lint` reports 0 failures and 0 findings, and `wc -l src/ipc/visuals.ts` is ≤ 770.
- [ ] **Step 5: Commit.** `git add src/analysis/tableCalc.ts src/analysis/additivity.ts src/ipc/visuals.ts src/ipc/vizSample.ts src/analysis/planPreview.ts src/ipc/copilot.ts src/publish/dashboardData.ts src/publish/storyData.ts scripts/test-additivity.ts && git commit -m "Refuse a running total, share or moving sum of a measure that can't be added up, on every chart surface"`

### Task 4: No overlay caption over a measure that can't be added across time

**Files:** Modify `src/ipc/visualsOverlay.ts:74`. Test: `scripts/test-additivity.ts`, section "overlay".
**Interfaces:** Consumes `measureAdditivity` (Task 3). Produces no new name. The caption is written only when `(await measureAdditivity(projectId, datasetId, enc.values[0])).time`; the overlay series is unchanged.
- [ ] **Step 1: Write the failing test.**
```ts
const by = (aggregation: string) => chart({ category: 'day', grain: 'month', overlay: 'previous_year', values: [{ column: 'amount', aggregation }] }, { filters: FEB_2024 });
const avg = await by('avg');
ok('avg: the year-earlier series is drawn', avg.ok && avg.data.series.some((s) => s.role === 'overlay'));
ok('avg: no "up N% vs last year" caption', avg.ok && avg.overlay?.kind === 'previous_year' && avg.overlay.caption === undefined && avg.overlay.pct === undefined, show(avg.overlay));
const sum = await by('sum');
ok('NEGATIVE CONTROL: sum keeps its caption', sum.ok && typeof sum.overlay?.caption === 'string' && typeof sum.overlay?.pct === 'number');
```
  `FEB_2024` is a custom-period filter on `day` for 2024-02-01..2024-02-29. The fixture has 2023-02 rows, so a prior year exists.
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-additivity.js` fails at "avg: no … caption".
- [ ] **Step 3: Implement.** `const cap = (await measureAdditivity(projectId, datasetId, enc.values[0])).time ? overlayCaption(...) : null;`. The existing `try` keeps a failure from blanking the chart.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-additivity.js scripts/test-compareSeries.js scripts/test-dateIntel.js` reports 0 failures.
- [ ] **Step 5: Commit.** `git add src/ipc/visualsOverlay.ts scripts/test-additivity.ts && git commit -m "Say nothing in the period overlay caption when the measure can't be added across time"`

### Task 5: A metric-tree sum over a part that can't be added (separable; see Review Focus)

**Files:** Modify `src/ipc/metricTree.ts:231-243` (`metricNode`), `src/analysis/metricTreeJs.ts:118-121` (`treeJs`, the reference) and `src/analysis/metricTreeMessages.ts`. Test: `scripts/test-metricTree.ts` (extend `endToEnd`).
**Interfaces:** Consumes `additivityOf`. Produces `msg.sumOfNonAdditive(part: string): string`.

When a `sum` relation has a child whose `additivityOf(child, ctx.columns, byName).categories` is `false`, the node gets `note = msg.sumOfNonAdditive(child.name)`. Its children keep their own figures, with no contribution, share or residual row. `byName` is `metrics.metricsByName`, read once per compute. `treeJs` mirrors it by leaving `contribution` unset.
- [ ] **Step 1: Write the failing test.** In `scripts/test-metricTree.ts` after "a deleted part", using the existing `avgPrice`, `cost` and `revenue` metrics and the `feb`/`compare` scope:
```ts
const avgSum = await ipc.computeTree(pid, revenue.id, { filters: feb, compare, tree: { relation: 'sum', children: [{ metricId: avgPrice.id }, { metricId: cost.id }] } });
ok('a sum over an average says why, and weighs nothing', avgSum.ok && avgSum.root.note === msg.sumOfNonAdditive('Avg price')
  && avgSum.root.children.every((c) => c.kind !== 'residual' && c.contribution === undefined), avgSum.ok ? avgSum.root.note : '');
const pr = await ipc.computeTree(pid, profit.id, { filters: feb, compare }); // the saved tree: sum of Revenue (split) and −Cost
ok('NEGATIVE CONTROL: Profit = Revenue − Cost still credits its parts', pr.ok && pr.root.children.filter((c) => c.kind !== 'residual').every((c) => typeof c.contribution === 'number'));
```
  The existing reference comparison (`same(out, reference(...))`) covers the mirror for the saved trees.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-metricTree.js` fails at "a sum over an average", because today the root has no note.
- [ ] **Step 3: Implement.** Before `contributions(...)` at `metricTree.ts:235`, find the first child metric that cannot be added, set the note, set `node.children = kids`, and skip `credit`. The sentence, as a literal: `` `${part} can't be added up, so this sum can't say how much each part contributed.` `` Then run `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-metricTree.js scripts/test-i18n.js` reports 0 failures, and `npm --prefix web run e2e -- metricTree` passes.
- [ ] **Step 5: Commit.** `git add src/ipc/metricTree.ts src/analysis/metricTreeJs.ts src/analysis/metricTreeMessages.ts src/i18n scripts/test-metricTree.ts && git commit -m "Refuse a metric-tree sum over a part that can't be added up"`

### Task 6: The Assistant and agents know what can be added up (added at the index review)

**Files:** Modify `src/ai/copilotFacts.ts` (`FactMetric` l.115-123, `metricLines` l.125-134), `src/ipc/copilot.ts` (`factMetrics` l.151), `src/automation/handlers.ts` (`metricsList` l.188-197) · Test `scripts/test-additivity.ts` (extend)
**Interfaces:** Consumes `additivityOf` (Task 2). Produces `FactMetric.additivity?: Additivity` and an `adds_up: { categories: boolean; time: boolean } | null` field on each `list_metrics` row.

- [ ] **Step 1: Write the failing test.** In `scripts/test-additivity.ts`, section "facts":
  ```ts
  const lines: string[] = []; copilotFacts.metricLines(lines, [], [{ name: 'Avg basket', definitionText: 'avg of amount', value: 3, display: '3', additivity: { categories: false, time: false } }]);
  ok('facts say an average cannot be added up', lines.some((l) => l.includes("Can't be added up across groups or over time.")));
  const plain: string[] = []; copilotFacts.metricLines(plain, [], [{ name: 'Revenue', definitionText: 'sum of revenue', value: 3, display: '3', additivity: { categories: true, time: true } }]);
  ok('NEGATIVE CONTROL: an additive metric gets no extra sentence', !plain.some((l) => l.includes('added up')));
  const rows = await handlers.metricsList(ctx) as Array<{ name: string; adds_up: unknown }>;
  ok('list_metrics carries adds_up', JSON.stringify(rows.find((r) => r.name === 'Avg basket')?.adds_up) === JSON.stringify({ categories: false, time: false }));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-additivity.js`. Expected: the three new `ok` lines fail.
- [ ] **Step 3: Implement.** `factMetrics` fills `additivity` from `additivityOf`; `metricLines` appends `` ` Can't be added up ${where}.` `` where `where` is `across groups`, `over time` or `across groups or over time` (only when a side is `false`); `metricsList` adds `adds_up` (null for a formula with a `[[parameter]]`, as step 10's `metricAdditivity`). Run `node scripts/gen-automation-docs.js` if the tool's summary changes.
- [ ] **Step 4: Run it to see it pass.** Same command, plus `node scripts/test-copilot.js`. Expected: 0 failures.
- [ ] **Step 5: Commit.** `git add src/ai/copilotFacts.ts src/ipc/copilot.ts src/automation/handlers.ts scripts/test-additivity.ts && git commit -m "Tell the Assistant and agents which metrics can be added up"`

## Existing tests that must stay green

`test-tableCalc` (fold and golden), `test-dateIntel` (`overlayCaption` pure), `test-compareSeries`, `test-metricTree`, `test-metricMeasures`, `test-drivers`, `test-driversPoint`, `test-metrics`, `test-publishMemo`, `test-publishSite`, `test-embedLock`, `test-copilot`, `test-liveRoute`, `test-asyncReach`, `test-i18n`, `test-file-size`, `node scripts/check-contracts.js` (0 unresolved), `npm run lint` (0).
