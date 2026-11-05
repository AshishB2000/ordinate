# Semantic layer part 5, step 01: readers for every part-5 shape — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one release in which every pod keeps every shape part 5 writes (`countd`, the funnel and period definition kinds, `snapshot.per`, a metric's `target`, an alert's `compare: 'target'`) through every load and re-save, and computes none of them: a chart refuses with a sentence, a KPI shows no figure, an alert is skipped untouched.
**Architecture:** One aggregation module (`src/data/aggregations.ts`) replaces the 29 aggregation lists in `src/`, and a ratchet test keeps it that way. Each new shape gets a pure sanitizer in its own file that imports nothing from `metrics.ts` (the `snapshot.ts` pattern from part 1's 02a). `MetricDefinition` widens to four kinds, so `tsc` names every reader that assumed "not a formula = a column and an aggregation"; each one refuses a kind it cannot compute, through one guard module (`src/analysis/pendingKinds.ts`), the same call sites 02a's `snapshotGuards.ts` covers.
**Tech Stack:** TypeScript server (`src/data`, `src/analysis`, `src/ipc`, `src/engine`, `src/ai`), self-check scripts, `docs/server/upgrade.md`.
**Spec:** docs/semantic-layer/05-metrics-depth.md (D4; the shapes of D1, D5, D8, D11, D12, D14) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p5-00-index.md
**Branch and PR:** `feat/semantic-p5-01-readers` off `origin/develop`, after part 1's last PR (`feat/semantic-p1-10-data-model-section`) merges. One PR. Release 5A. No part-5 writer (step 04 onward) may reach a release before 5A has rolled out on every pod.

## What a pod of the previous release does today (why this PR exists)

| Shape a part-5 pod writes | Pod without this PR | Pod with this PR |
|---|---|---|
| `aggregation: 'countd'` on a metric | `sanitizeDefinition` makes it `sum` (`src/analysis/metrics.ts:139,175`) and `updateMetric` saves that back | keeps it; KPI "—"; chart refuses |
| `countd` on a chart measure / pivot value | `sum` (`src/analysis/visuals.ts:279,311`; `pivotData.ts:169,199`), saved back on the next edit | keeps it; chart refuses |
| `countd` on a dashboard KPI card | the card is **dropped** (`dashboards.ts:251,462`, `sanitizeCard` returns null) | keeps it; "—" |
| `countd` in a Prepare group step | the aggregation is **dropped** (`src/data/stepSanitize.ts:56`); a refresh would write a table without that column | keeps it; the pipeline run refuses (typed), so nothing is written |
| `countd` in a stored answer spec | the measure is **dropped** (`src/ai/answerSpec.ts:408`) | keeps it; the card refuses |
| `countd` on an alert rule | the **rule is deleted** (`alerts.ts:241` returns null; `alertStore.save` rewrites `alerts.json` from the sanitized load on the next evaluation tick) | keeps it; not evaluated |
| `definition: { funnel, show }` or `{ base, window?, compare? }` | becomes `{ column: '', aggregation: 'sum' }` (`metrics.ts:169-180`), saved back on a rename | keeps it; no figure; charts refuse |
| `snapshot.per` | `sanitizeSnapshot` drops `per` (`src/analysis/snapshot.ts:13-18`): the figure becomes the whole-scope latest day, a **wrong number**, then saved back | keeps it; no figure; charts refuse |
| `Metric.target` | `normalize` drops it (`metrics.ts:229-250`), lost on the next `updateMetric` | keeps it; shows nothing |
| alert `compare: 'target'` + `targetPct`, or an alert with no column but a `metricId` | the rule becomes a threshold rule with no threshold → null → **deleted** on the next tick | keeps it; not evaluated, its state untouched |

Contracts stay strict in this PR (`src/api/metrics.ts:10-13`, `src/api/visuals.ts:47`, `src/api/analyses.ts:25`): a newer browser writing to a 5A pod gets a 400 and retries on another pod. Each writer PR widens its own contract.

## Global Constraints

- Nothing new computes. Every figure path that would need a new shape refuses or shows no figure; a record with none of the new shapes is byte-identical on every read and write (`JSON.stringify` of the sanitized record equals today's).
- Kept shapes are fully sanitized here, not passed through: these sanitizers are the ones the writer PRs use.
- KPI doors show no figure (`{ ok: true, value: null }`), as 02a does for a snapshot; chart and answer doors return `{ ok: false, error }` with a catalog sentence.
- `src/analysis/metrics.ts` is at 475 lines: at most +20 here (types and one branch each). `src/ipc/visuals.ts` (773 before part 1's release 2; re-measure) gets **one** line. `src/analysis/alerts.ts` (623) and `src/analysis/alertStore.ts` (636) get ≤ 12 and ≤ 4. New logic goes in new files.
- Sentences: English literals in a new `src/analysis/pendingMessages.ts`, appended to `MAIN_FILES` (`scripts/i18n-extract.ts:346`), then `npm run build:ts && node scripts/i18n-extract.js`. Never hand-edit `en.json`.
- Golden fixtures are never re-recorded. `npm run lint` 0. No contract change, so `scripts/rowPolicyReaders.ts` is untouched.
- Commits carry no Co-Authored-By or AI trailer.

## Review Focus

- **The alert file is rewritten whole.** A rule this pod skips must come back from `evaluateProject` byte-identical (no `lastEvaluatedAt`, no `armed` change), or two pods fight over it. Pinned in Task 4.
- **A KPI card whose metric is a new kind** has `column: ''` and a `metricId` (allowed today, `dashboards.ts:467-473`). Its `aggregation` must still be a stored one, so the writer PRs store the metric's own aggregation, or `sum` for a funnel or period metric. Pinned in Task 1.
- **Sites `tsc` cannot see** read the definition through a cast: `metricAuto.ts:159`, `app/sampleProject.ts:221`, `ai/planExec.ts:72`, `ipc/templates.ts:53-55`, `ipc/search.ts:96`. Task 3 lists them; a reviewer greps `definition as`.
- **A Prepare run that meets `countd` must fail, not skip.** `foldStep` skips a throwing step (`transforms.ts:276-285`), which would leave an ungrouped table. Pinned in Task 1.

---

### Task 1: One aggregation list, and every store keeps `countd`

**Files:** Create `src/data/aggregations.ts`, `src/data/pendingError.ts`, `scripts/test-aggregationList.ts`, `scripts/test-part5Readers.ts` (harness: `scripts/test-snapshotReader.ts:10-40`). Modify, one line each unless noted, every list `grep -rnE "['\"]sum['\"]\s*,\s*['\"]avg['\"]" src` finds:
- **Stores (take `AGGREGATIONS`, plus `'none'` where they had it):** `metrics.ts:139`, `visuals.ts:279`, `pivotData.ts:169`, `dashboards.ts:251` (`METRIC_AGGS`), `alerts.ts:159`, `transforms.ts:163` (`AGG_FNS`, read by `stepSanitize.ts:56`). `answerSpec.ts:408`: `(AGG_ALIASES[m.aggregation] === m.aggregation || m.aggregation === 'countd')`.
- **Surfaces that never count distinct here (take `PLAIN_AGGREGATIONS`):** `metricValue.ts:22`, `metricFormula.ts:46`, `userTemplateRefs.ts:54`, `rebuildPlan.ts:66`, `driverScope.ts:70`, `ipc/rebuild.ts:28`, `ai/rebuildRead.ts:20`, `data/stepsSanitize.ts:21` (the Prepare **pivot** step, which never takes `countd`), `engine/sqlGen.ts:112`, `engine/residentQuery.ts:145`, `engine/live/liveSpec.ts:61` (`LIVE_AGGS`), and the zod enums `api/metrics.ts:12`, `api/visuals.ts:47` (+`'none'`), `api/analyses.ts:25`, `api/rebuild.ts:10` (`z.enum(PLAIN_AGGREGATIONS)`), `automation/registry.ts:137`.
- **Number-only (take `NUMBER_AGGREGATIONS`, `+'none'` where they had it):** `dashboardDelta.ts:47`, `analysisPlan.ts:83`, `answerSpec.ts:120`, `liveSpec.ts:63`.
- **Types:** `MetricAggregation` (`metricValue.ts:20`, `dashboards.ts:82`) becomes `Aggregation`; `AggFn` (`transforms.ts:74`) and `VizAggregation` (`visuals.ts:45`, `Aggregation | 'none'`) widen. `LiveAgg` and `MatchAgg` stay five. Every site `tsc` then flags (`lodResident.ts:136-142` is one) refuses `countd`.
- **Compute refusals:** `transforms.ts:564` `aggregate` throws `new PendingError('countd')` for `countd`; `foldStep` (`:280-281`) rethrows `isPendingError` beside the row-policy and term errors. `residentQuery.ts:612` `aggExpr` throws for anything not in `PLAIN_AGGREGATIONS` instead of degrading to `count` (resident callers already turn a throw into null, so the JS reference answers, and refuses). `src/server/app.ts` (after the `isTermNotExpandedError` branch, `:488`): `isPendingError(err)` → 409 `{ error: 'pending', code: 'pending', message }`.

**Interfaces:** Produces
```ts
// src/data/aggregations.ts — no imports
export const AGGREGATIONS = ['sum', 'avg', 'count', 'min', 'max', 'countd'] as const;   // what a stored measure may say
export type Aggregation = (typeof AGGREGATIONS)[number];
export const PLAIN_AGGREGATIONS = ['sum', 'avg', 'count', 'min', 'max'] as const;       // a surface that cannot count distinct
export const NUMBER_AGGREGATIONS = ['sum', 'avg', 'min', 'max'] as const;              // needs a number column
export function isAggregation(s: unknown): s is Aggregation
export function isPlainAggregation(s: unknown): s is (typeof PLAIN_AGGREGATIONS)[number]
export function isCountLike(a: string): boolean   // 'count' | 'countd': any column type, never FX-converted (step 02 adopts it)
// src/data/pendingError.ts
export class PendingError extends Error { readonly code = 'pending'; constructor(readonly what: 'countd' | 'kind') }
export function isPendingError(e: unknown): e is PendingError   // by class or by name + code, as isRowPolicyError
```
Sets are built where used (`new Set<string>(AGGREGATIONS)`) so each call site keeps its `ReadonlySet<string>`.

- [ ] **Step 1: Write the failing tests.** `scripts/test-aggregationList.ts` scans `src/**/*.ts` (no `.js`, no `scripts/`) with `/['"]sum['"]\s*,\s*['"](avg|count|min|max)['"]/` and `/['"]count['"]\s*,\s*['"]sum['"]/`, and allows only `src/data/aggregations.ts`, `src/formula/formulaParse.ts` (`LOD_AGGS`, the formula grammar's own) and `src/publish/sanitize.ts` (`GEO_AGGS`, a map's deliberate subset), each with its reason in the allowlist. `ok(\`${file}: no aggregation list of its own\`, ...)`. NEGATIVE CONTROL: a planted `src/__aggProbe.ts` holding `new Set(['sum', 'avg'])` fails the scan; it is deleted in `finally`.
  `scripts/test-part5Readers.ts`, section "countd kept" (a temp project, a dataset `orders` with `customer_id` text, `amount` number, `day` date, 40 rows):
  ```ts
  const m = (await metrics.saveMetric(P, { name: 'Customers', datasetId: D, definition: { column: 'customer_id', aggregation: 'countd' } }))!;
  await metrics.updateMetric(P, m.id, { name: 'Buyers' });
  ok('metric: countd survives a rename', (await metrics.getMetric(P, m.id))!.definition.aggregation === 'countd');
  ok('visual: countd survives save → update → get', /* visuals.saveVisual + updateVisual({name}) */ got.encoding.values[0].aggregation === 'countd' && got.encoding.pivot!.values[0].aggregation === 'countd');
  ok('dashboard: a countd KPI card survives', /* analysis.saveAnalysis with a metric card {column:'customer_id', aggregation:'countd'} → getAnalysis */ card !== undefined);
  ok('stored answer spec keeps a countd measure', answerSpec.sanitizeStoredSpec({ datasetId: D, category: 'day', measures: [{ column: 'customer_id', aggregation: 'countd' }] })!.measures[0].aggregation === 'countd');
  ok('Prepare: a countd group step survives sanitize', JSON.stringify(sanitizeSteps([G])) === JSON.stringify([G]));   // G = group_aggregate by day, countd of customer_id
  ok('Prepare: a run that meets it refuses, typed — never an ungrouped table', throws(() => applyPipeline(T, [G]), isPendingError));
  ok('NEGATIVE CONTROL: the Prepare pivot step still refuses countd', typeof sanitizeStep({ type: 'pivot', key: 'day', value: 'amount', fn: 'countd' }) === 'string');
  ok('NEGATIVE CONTROL: an unknown aggregation still reads as sum', metrics.sanitizeDefinition({ column: 'amount', aggregation: 'median' }).aggregation === 'sum');
  ok('a countd(col) metric formula has no figure on this release', metricFormula.compileMetricFormula('countd(customer_id)', COLS).ok === false);
  ```
- [ ] **Step 2: Run them to see them fail.** `npm run build:ts && node scripts/test-aggregationList.js scripts/test-part5Readers.js` → 29 files unclassified; "countd survives a rename" fails (`sum`).
- [ ] **Step 3: Implement** as listed. `sanitizeStep` is `stepSanitize.ts`'s; `sanitizeStep` for the pivot step is `stepsSanitize.ts`'s and returns its error string.
- [ ] **Step 4: Run them to see them pass.** `npm run build:ts && node scripts/test-aggregationList.js scripts/test-part5Readers.js scripts/test-metrics.js scripts/test-visuals.js scripts/test-pivotData.js scripts/test-transforms.js scripts/test-residentQuery.js scripts/test-liveCompile.js scripts/test-answerSpec.js scripts/test-termGuards.js scripts/test-file-size.js && npm run lint` → 0 failures, 0 findings.
- [ ] **Step 5: Commit.** `git add src scripts/test-aggregationList.ts scripts/test-part5Readers.ts && git commit -m "Keep one aggregation list, keep countd in every store, and refuse to compute it"`

### Task 2: The new definition kinds, `snapshot.per` and `target` survive every save

**Files:** Create `src/analysis/funnelMetric.ts`, `src/analysis/periodMetric.ts`, `src/analysis/metricTarget.ts`. Modify `src/analysis/snapshot.ts` (`per`), `src/analysis/metrics.ts` (`:59-77` types, `:169-180` `sanitizeDefinition`, `:229-250` `normalize`, `:399-421` `updateMetric`), `src/analysis/recordDiff.ts` (`:31` and `:53` add `'target'`; `diffMetric :213-222` adds `changed its target`). Test: `scripts/test-part5Readers.ts`, section "kinds kept".
**Interfaces:** Produces (each file imports only types, never `metrics.ts`):
```ts
// funnelMetric.ts
export type FunnelShow = 'rate' | 'converted' | 'entered';
export interface MetricFunnelDefinition { funnel: FunnelEncoding; show: FunnelShow }   // FunnelEncoding: funnelEvents.ts:30-38, no breakdown
export function sanitizeFunnelDefinition(raw: unknown): MetricFunnelDefinition | undefined  // sanitizeEventFunnel (:82-97) minus breakdown; < FUNNEL_MIN_STEPS steps → undefined
// periodMetric.ts
export type MetricWindow = { to_date: 'week' | 'month' | 'quarter' | 'year' } | { last: number; unit: 'day' | 'week' | 'month' };  // last: integer 1–366
export interface MetricCompare { vs: 'previous_period' | 'previous_year'; show: 'change' | 'pct_change' | 'prior' }
export interface MetricPeriodDefinition { base: string; window?: MetricWindow; compare?: MetricCompare }   // base: UUID; at least one of window/compare
export function sanitizePeriodDefinition(raw: unknown): MetricPeriodDefinition | undefined
// metricTarget.ts
export interface MetricTargetSpec { source: { value: number } | { metricId: string }; per?: ScorePeriod; thresholds?: Thresholds }  // scorecardModel.ts:20,24
export function sanitizeTarget(raw: unknown): MetricTargetSpec | undefined   // value finite; metricId UUID; thresholds via sanitizeThresholds (:60-65)
// snapshot.ts
MetricSnapshot.per?: string                                            // a non-empty column name ≤ 512, else the key is absent
// metrics.ts
export type MetricDefinition = MetricSimpleDefinition | MetricFormulaDefinition | MetricFunnelDefinition | MetricPeriodDefinition;
export function isSimpleDefinition(d: MetricDefinition): d is MetricSimpleDefinition
export function isFunnelDefinition(d: MetricDefinition): d is MetricFunnelDefinition
export function isPeriodDefinition(d: MetricDefinition): d is MetricPeriodDefinition
Metric.target?: MetricTargetSpec
```
`sanitizeDefinition` order: formula, then `funnel`, then `base`, then simple (today's fallback). `normalize` sets `target` only when `sanitizeTarget` returns one. `updateMetric` keeps `existing.target` (the spread does; this PR's contract cannot send one).
- [ ] **Step 1: Write the failing test.**
  ```ts
  const FUN = { funnel: { entity: 'user', event: 'event', time: 'ts', steps: ['visit', 'buy'], window: { n: 7, unit: 'days' } }, show: 'rate' };
  const PER = { base: U1, window: { to_date: 'year' }, compare: { vs: 'previous_year', show: 'pct_change' } };
  const SNAP = { column: 'amount', aggregation: 'sum', snapshot: { column: 'day', take: 'last', per: 'customer_id' } };
  const TARGET = { source: { metricId: U2 }, per: 'month', thresholds: { good: 100, warn: 90 } };
  for (const [name, definition] of [['Visit → buy', FUN], ['Revenue YTD', PER], ['MRR', SNAP]] as const) {
    const m = (await metrics.saveMetric(P, { name, datasetId: D, definition, target: TARGET } as never))!;
    await metrics.updateMetric(P, m.id, { name: name + ' (2)' });
    await metrics.updateMetric(P, m.id, { tree: TREE }, undefined, 'metricTree');
    const back = (await metrics.getMetric(P, m.id))!, dup = (await metrics.duplicateMetric(P, m.id))!;
    ok(`${name}: definition survives rename, tree save and duplicate`, isDeepStrictEqual(back.definition, definition) && isDeepStrictEqual(dup.definition, definition));
    ok(`${name}: target survives`, isDeepStrictEqual(back.target, TARGET) && isDeepStrictEqual(dup.target, TARGET));
  }
  ok('a plain metric is byte-identical', JSON.stringify(metrics.sanitizeDefinition({ column: 'amount', aggregation: 'sum' })) === '{"column":"amount","aggregation":"sum"}');
  ok('NEGATIVE CONTROL: a one-step funnel is not a funnel', !('funnel' in metrics.sanitizeDefinition({ ...FUN, funnel: { ...FUN.funnel, steps: ['visit'] } })));
  ok('NEGATIVE CONTROL: a period metric with neither window nor compare is not one', !('base' in metrics.sanitizeDefinition({ base: U1 })));
  ok('NEGATIVE CONTROL: last: 0 is refused', !('base' in metrics.sanitizeDefinition({ base: U1, window: { last: 0, unit: 'day' } })));
  ok('a version restore keeps the target', /* restore through ipc/versions as test-snapshotReader does */ isDeepStrictEqual(restored.target, TARGET));
  ok('the edit-conflict tag covers target', editConflict.contentTag('metric', back) !== editConflict.contentTag('metric', { ...back, target: undefined }));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-part5Readers.js` → "Visit → buy: definition survives" fails (`{"column":"","aggregation":"sum"}`). `tsc` errors from the widened union are expected; Task 3 fixes them, so do Tasks 2 and 3 in one sitting and commit at Task 3's end if `tsc` will not build otherwise.
- [ ] **Step 3: Implement** to the signatures above.
- [ ] **Step 4: Run it to see it pass** (after Task 3 compiles): `node scripts/test-part5Readers.js scripts/test-metrics.js scripts/test-snapshotReader.js scripts/test-versionHistory.js scripts/test-metricTimeReader.js`.
- [ ] **Step 5: Commit.** `git add src/analysis/funnelMetric.ts src/analysis/periodMetric.ts src/analysis/metricTarget.ts src/analysis/snapshot.ts src/analysis/metrics.ts src/analysis/recordDiff.ts scripts/test-part5Readers.ts && git commit -m "Keep funnel and period definitions, a snapshot's per and a metric's target through every save"`

### Task 3: Every reader refuses what it cannot compute

**Files:** Create `src/analysis/pendingKinds.ts`, `src/analysis/pendingMessages.ts`. Modify each site `tsc` flags after Task 2 and each cast site: `driverShape.ts:157`, `scenarioResolve.ts:216,429`, `metricFormat.ts:84-86`, `metricTreeJs.ts:47-50`, `metricMeasures.ts:99-101`, `publish/embedLock.ts:66-67`, `publish/kpiSubtitle.ts:29`, `ipc/periods.ts:108`, `ipc/metricCheck.ts:49`, `ipc/answers.ts:142-148` (`computeCard`) and `:255-259`, `ipc/stories.ts:30-31`, `ipc/metrics.ts:132-133` (`resolveDefinition`), `:246`, `:271`, `:368`, `ipc/scenarios.ts:113-116`, `ipc/search.ts:96`, `ipc/templates.ts:53-55`, `metricAuto.ts:159`, `app/sampleProject.ts:221`, `ai/planExec.ts:72`, `snapshotGuards.ts:12` (if part 1's step 07 kept it); `ipc/dashboards.ts` `computeCardMetric` (two refusals beside part 1's snapshot branch); `ipc/visuals.ts` `vizDataForUnlocked` (one line, before `planMetricMeasures`); `scripts/i18n-extract.ts:346`. Test: `scripts/test-part5Readers.ts`, section "refused".
**Interfaces:** Produces
```ts
// pendingKinds.ts
export function pendingMetric(m: Pick<Metric, 'definition'>): boolean   // a funnel or period kind, a simple countd, or snapshot.per
export async function pendingMeasureRefusal(projectId: string, encoding: VizEncoding | null | undefined): Promise<string | null>
  // drawn measures (values[0] under a split; every pivot value) with aggregation 'countd', or whose metricId names a pendingMetric → its sentence
export function pendingSpecRefusal(spec: AnswerSpec): string | null      // a countd measure → its sentence
// pendingMessages.ts
export function countdPending(measure: string): string     // `“${measure}” counts distinct values, which needs a newer version of Ordinate. Finish the upgrade, then try again.`
export function metricKindPending(name: string): string    // `“${name}” is a kind of metric from a newer version of Ordinate. Finish the upgrade, then try again.`
```
The rule at each site: use `isSimpleDefinition` where the code reads `.column`; a funnel or period kind gives the site's "no figure" (null, `kind: 'none'`, skipped from a list, or `PlanError(metricKindPending(name))` in `metricMeasures.build`). `describeDefinitionShort` returns `metricKindPending`'s noun phrase "a newer kind of metric" for both. `computeCardMetric`: `if (spec.aggregation === 'countd' || spec.snapshot?.per) return Promise.resolve({ ok: true, value: null }); // shortcut: computed from step 02 / step 07`. `computeCard`: `const pending = pendingSpecRefusal(spec); if (pending) return { ok: false, error: pending };` after `expandAnswerTerms`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const plain = (await metrics.saveMetric(P, { name: 'Revenue', datasetId: D, definition: { column: 'amount', aggregation: 'sum' } }))!;
  for (const m of [customers, funnelM, periodM, perM]) {
    ok(`${m.name}: no KPI figure, never a sum`, (await ipcMetrics.resolveMetric(P, m.id))!.value === null);
    const c = await viz(null, { projectId: P, datasetId: D, encoding: { category: 'day', grain: 'month', values: [{ column: 'amount', aggregation: 'sum', metricId: m.id }] } });
    ok(`${m.name}: a chart says why`, c.ok === false && [msg.countdPending('Customers'), msg.metricKindPending(m.name)].includes(c.error));
  }
  ok('a raw countd measure is refused', (await viz(null, { projectId: P, datasetId: D, encoding: { category: 'day', values: [{ column: 'customer_id', aggregation: 'countd' }] } })).error === msg.countdPending('countd of customer_id'));
  ok('a countd pivot value is refused', (await viz(null, { ..., encoding: { category: 'day', values: [V], pivot: { rows: [{ column: 'day' }], columns: [], values: [{ column: 'customer_id', aggregation: 'countd' }] } } })).ok === false);
  ok('an answer card with a countd measure is refused', (await answers.computeCard(P, { ...SPEC, measures: [{ column: 'customer_id', aggregation: 'countd' }] })).ok === false);
  ok('key drivers refuse a funnel metric', driverShape.metricShape(D, COLS, funnelM.definition, [], new Map()).kind === 'none');
  ok('the tree reference gives no figure', treeRef.metricJs(COLS, ROWS, [funnelM], funnelM, []) === null);
  ok('the words say it is newer', describeDefinition(periodM) === 'a newer kind of metric');
  ok('NEGATIVE CONTROL: the plain metric has its figure and its chart', typeof (await ipcMetrics.resolveMetric(P, plain.id))!.value === 'number' && (await viz(null, { ..., values: [{ column: 'amount', aggregation: 'sum', metricId: plain.id }] })).ok === true);
  ```
  Add each new label to the 02a sections of the test that cover stories, scenarios, templates, plans and embeds (`scripts/test-snapshotReader.ts`'s shape): the same call with a funnel metric gives that surface's "no figure".
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` → the `tsc` errors are the list above; fix each, then `node scripts/test-part5Readers.js` fails at "a raw countd measure is refused".
- [ ] **Step 3: Implement** as specified, then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-part5Readers.js scripts/test-snapshotReader.js scripts/test-metricMeasures.js scripts/test-metricTree.js scripts/test-drivers.js scripts/test-scenarios.js scripts/test-answerSpec.js scripts/test-copilot.js scripts/test-embedLock.js scripts/test-i18n.js scripts/test-file-size.js && npm run lint`, and `wc -l src/ipc/visuals.ts src/analysis/metrics.ts` are ≤ 800 and ≤ 495.
- [ ] **Step 5: Commit.** `git add src scripts/i18n-extract.ts scripts/test-part5Readers.ts && git commit -m "Refuse, with a sentence, a metric kind or count distinct this release cannot compute"`

### Task 4: Alert rules this release cannot evaluate are kept, untouched

**Files:** Modify `src/analysis/alerts.ts` (`AlertCompare :44`, `AlertRule :79-130`, `sanitizeRule :234-310`; add `canEvaluate`), `src/analysis/alertStore.ts` (`evaluateProject :452-516`, `testRule :518`). Test: `scripts/test-part5Readers.ts`, section "alerts".
**Interfaces:** Produces `AlertCompare` += `'target'`; `AlertRule.targetPct?: { op: 'below' | 'above'; pct: number }` (pct finite, 0 < pct ≤ 1000; a `target` rule without one is null, as a threshold rule without a threshold is); `metric.column` may be empty when `metric.metricId` is set; `export function canEvaluate(rule: AlertRule): boolean` — false for `compare: 'target'`, `aggregation: 'countd'`, or an empty column on a non-anomaly rule. `metricFor` (`alertStore.ts:320`) gains `skip?: true` in its reply and returns `{ value: null, previous: null, skip: true }` when `rule.metric.metricId` names a `pendingMetric`. `evaluateProject`: `if (!alerts.canEvaluate(rule)) continue;` before `metricFor`, and `if (m.skip) continue;` after it, so neither kind of rule reaches `evaluateRule`. `testRule` replies `{ ok: true, fire: false, message: msg.alertPending(), value: null, previous: null }` for one it cannot evaluate. `pendingMessages.ts` gains `alertPending()`: `This alert uses a figure from a newer version of Ordinate. It will be checked again once the upgrade is finished.`
- [ ] **Step 1: Write the failing test.**
  ```ts
  const R = (over: object) => ({ id: randomUUID(), name: 'r', datasetId: D, enabled: true, compare: 'threshold', threshold: { op: '>', value: 0 }, metric: { column: 'amount', aggregation: 'sum' }, ...over });
  const rules = [R({ metric: { column: 'customer_id', aggregation: 'countd' } }), R({ compare: 'target', threshold: undefined, targetPct: { op: 'below', pct: 90 }, metric: { column: '', aggregation: 'sum', metricId: periodM.id } }), R({ metric: { column: 'amount', aggregation: 'sum', metricId: funnelM.id }, armed: true, history: [1, 2] })];
  const plainRule = R({});
  // write alerts.json with the four rules (alertStore.restoreRule for each), then:
  const before = JSON.stringify((await alertStore.load(P)).rules);
  await alertStore.evaluateProject(P, D, Date.parse('2026-11-04T12:00:00Z'));
  const after = (await alertStore.load(P)).rules;
  for (const r of rules) ok(`kept, byte-identical after an evaluation tick: ${r.metric.aggregation}/${r.compare}`, JSON.stringify(after.find((x) => x.id === r.id)) === JSON.stringify(JSON.parse(before).find((x: { id: string }) => x.id === r.id)));
  ok('NEGATIVE CONTROL: the plain rule was evaluated', typeof after.find((x) => x.id === plainRule.id)!.lastEvaluatedAt === 'string');
  ok('NEGATIVE CONTROL: a target rule with no targetPct is not a rule', alerts.sanitizeRule(R({ compare: 'target', threshold: undefined })) === null);
  ok('the Test button says why', (await alertStore.testRule(P, rules[0])).message === msg.alertPending());
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-part5Readers.js` → the countd rule is missing after load.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-part5Readers.js scripts/test-alerts.js scripts/test-alertDiagnosis.js scripts/test-i18n.js scripts/test-file-size.js`.
- [ ] **Step 5: Commit.** `git add src/analysis/alerts.ts src/analysis/alertStore.ts src/analysis/pendingMessages.ts src/i18n scripts/test-part5Readers.ts && git commit -m "Keep alert rules a newer release writes and leave them unevaluated"`

### Task 5: Say how the release gap is held

**Files:** Modify `docs/server/upgrade.md` (a section after 05a's "Filters a newer release writes are kept"), `CHANGELOG.md` (`[Unreleased]`).
- [ ] **Step 1: Write the failing test.** `node scripts/test-serverDocs.js` must stay green; nothing new to fail.
- [ ] **Step 2: Run it.** Nothing to fail: documentation.
- [ ] **Step 3: Implement.** Section "Metrics a newer release writes are kept (part 5 readers)": this release keeps count distinct, funnel and period metrics, per-account snapshots, targets and target alerts, and computes none of them. The release that adds them needs this one on every pod first: upgrade through it, or stop all pods (`kubectl -n ordinate scale deploy/ordinate --replicas=0`, then `helm upgrade`). A rollback below this release, once such metrics exist, shows them as `sum` (or as nothing) and drops them on the next save; never `helm rollback` past it. CHANGELOG: one line under `### Changed`, "Older pods keep part 5's metric shapes; see the upgrade guide."
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-serverDocs.js`.
- [ ] **Step 5: Commit.** `git add docs/server/upgrade.md CHANGELOG.md && git commit -m "Document the reader release part 5's metrics need first"`

## Existing tests that must stay green

`test-metrics`, `test-visuals`, `test-pivotData`, `test-transforms`, `test-residentQuery`, `test-lod-resident`, `test-liveCompile`, `test-liveParity`, `test-alerts`, `test-answerSpec`, `test-snapshotReader`, `test-metricTimeReader`, `test-termGuards`, `test-termSites` (re-count only where a line moved), `test-versionHistory`, `test-i18n`, `test-file-size`, `test-asyncReach`, `node scripts/check-contracts.js` (0 unresolved), `npm run lint` (0).
