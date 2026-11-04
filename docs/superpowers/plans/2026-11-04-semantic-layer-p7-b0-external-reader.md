# Semantic layer part 7, step b0: keep what an external semantic layer writes (reader release) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one release in which every pod keeps a metric definition `{ external, additive?, layer? }` and a metric's `importedFrom` verbatim through every read and re-save, refuses with a sentence any figure that would need one, and refuses every question about a dataset that carries a `semantic` key, so b2's layer mirrors and f1's dbt imports can never be erased or misread by an older pod.
**Architecture:** The 02a/05a pattern. A third definition kind joins the `MetricDefinition` union (`src/analysis/externalMetric.ts`), so `tsc` names every place that reads a simple definition; each one keeps it, refuses it with a typed `ExternalMetricError`, or words it. A ratchet test holds that inventory. On datasets, the presence of a top-level `semantic` key is read into the Live block in memory (as 08a reads `baseFilters`), and `liveTarget`, "Make a copy" and "Copy the data instead" refuse it.
**Tech Stack:** `src/analysis`, `src/ipc`, `src/data`, `src/engine/live/liveTarget.ts`, `src/server/app.ts`, docs.
**Spec:** docs/semantic-layer/07-portability.md (D11, D13, D10's `importedFrom`) and the brief's rolling-deploy rule · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-b0-external-reader` off `origin/develop` (after part 1's step 03, `feat/semantic-p1-03-charts-follow-metric`, and the rest of part 1 have merged). One PR. Release 1 of part 7: **b2 and f1 must not reach a release before this one is deployed on every pod** (Task 4).

## Why this release exists (what a pod before it does)

| New stored thing (written by) | A pod before b0 reads and re-saves it | After b0 |
|---|---|---|
| `Metric.definition = { external, additive?, layer? }` (b2's sync) | `sanitizeDefinition` (`src/analysis/metrics.ts:169`) turns it into `{ column: '', aggregation: 'sum' }`. Figures read null (`src/ipc/metrics.ts:133`), but the next `metric:update` of its format, a duplicate or a tree save **writes the copy back**: the mirror is lost for good | kept verbatim, refused at every figure |
| `Metric.importedFrom = { kind: 'dbt', name }` (f1) | `normalize` (`metrics.ts:220`) rebuilds the record from known keys: **dropped** on re-save, so a re-import makes a duplicate | kept |
| Dataset top-level `semantic: {…}` (b2) | Untouched by every Live writer (each is a `serialized` raw edit or rebuilds `raw.live` only; `getDataset` throws on Live, so `persist` never runs). Its origin has no `table` or `sql`, so `liveSourceOf` (`src/engine/live/liveTarget.ts:64`) is null and every question and sync refuses `badSource`. Safe already | refused with its own sentence, and "Make a copy" too |

## Global Constraints

- `MetricExternalDefinition = { external: string; additive?: true; layer?: string }`: `external` 1–512 characters, no control characters; `additive` kept only when exactly `true`; `layer` a backend id matching `/^[a-z][a-z0-9-]{0,31}$/` (b2 words "Defined in Snowflake" from it; any id, so a later backend needs no reader release of its own). An external definition wins over any other key beside it (only the sync writes one).
- **Read-only (D13).** An update whose stored definition is external keeps the stored definition, whatever the patch carries (`metrics.ts:413`): an editor that knows no external kind sends `{ column, aggregation }` with every save, as 02a found for snapshots (`mergeSnapshot`, `src/analysis/snapshot.ts`). The zod contract (`src/api/metrics.ts:10-13`) already refuses `{ external }` from a browser. `metric:duplicate` of an external metric is refused (a second copy of a layer's definition).
- `importedFrom`: `{ kind: 'dbt'; name: string }` with `name` 1–512, kept by `normalize` when valid.
- **Refuse, never read null as an answer.** `ExternalMetricError` (code `external_metric`, reason `'pending'`) with `externalPending(name)`: "“{name}” is defined in another tool's semantic layer, which this server can't ask yet. Finish the upgrade, then try again." The route answers it 409 like `TermNotExpandedError` (`src/server/app.ts:488`), and a caught one is tagged in a batch reply as `tagTermRefusals` is (`:462`). A KPI tile must never fall back to "The metric this card showed was deleted." (`src/ipc/analysesServer.ts:147-152`).
- Dataset guard: `applyLive` (`src/data/liveDataset.ts:191`) sets `live.semanticPending = true` (in memory only) when the record has a top-level `semantic` key of any value. `liveTarget` refuses `refuse('semanticPending')` before its source check; `copyLiveDataset` and `setDatasetMode` refuse as `baseFilterRefusal` does (`src/ipc/liveDatasets.ts:171`); `metric:ensureDefaults` skips such a dataset (it would propose sums over a layer's dimensions). b2 replaces the presence check with the real reader.
- The inventory is a ratchet (`scripts/definitionSites.ts`), the same shape as 05a's `scripts/termSites.ts`: classify, never just bump.
- Sentences in new `src/analysis/externalMetricMessages.ts`, appended to `MAIN_FILES`; `node scripts/i18n-extract.js`.
- Files near the cap: `src/analysis/metrics.ts` 475 (≤ 8 lines here), `src/ipc/metrics.ts` 563, `src/server/app.ts` 652 (≤ 8 lines), `src/engine/live/liveSpec.ts` 457 (one refusal code and sentence). New logic in new files.
- No dependency, no migration, no new contract. Golden fixtures untouched: nothing here changes a figure that has no external metric.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Re-save keeps it.** `metric:update` (format, name, direction, description), a tree save, Trash and restore, a version restore and a project bundle round trip each keep `{ external }` and `importedFrom`. Negative control: a plain metric still sanitizes as today. Task 1.
- **No silent null.** A KPI, a chart measure, a formula naming the metric, an alert, a scorecard, the metric tree, a scenario, a story block, an embed, an answer and MCP `metric_value` each refuse with the sentence. Task 2.
- **Datasets.** A record with `semantic` refuses every door and the schema sync without a warehouse call; negative control without the key answers. Task 3.

---

### Task 1: The definition kind and its readers
**Files:** Create `src/analysis/externalMetric.ts`, `src/analysis/externalMetricMessages.ts`, `scripts/test-externalReader.ts` (the harness of `scripts/test-snapshotReader.ts`) · Modify `src/analysis/metrics.ts` (`MetricDefinition` l.73, `sanitizeDefinition` l.169, `normalize` l.220, `updateMetric` l.413, `duplicateMetric` l.444), `scripts/i18n-extract.ts:346`
**Interfaces:** Produces
- `interface MetricExternalDefinition { external: string; additive?: true; layer?: string }`; `isExternalDefinition(d: unknown): d is MetricExternalDefinition`; `sanitizeExternal(raw: unknown): MetricExternalDefinition | null`.
- `MetricDefinition = MetricSimpleDefinition | MetricFormulaDefinition | MetricExternalDefinition`.
- `Metric.importedFrom?: { kind: 'dbt'; name: string }`; `sanitizeImportedFrom(raw: unknown)`.
- `EXTERNAL_CODE = 'external_metric'`; `class ExternalMetricError extends Error { readonly code = EXTERNAL_CODE; readonly reason: 'pending'; readonly metric: string }`; `isExternalMetricError(err)` (class, or `name` + `code`); `externalRefusal(err): { ok: false; code: 'external_metric'; reason: string; error: string }`; `externalRaised(): number`, `tagExternalRefusals(reply)`.
- [ ] **Step 1: Write the failing test.**
```ts
const EXT = { external: 'Revenue', additive: true, layer: 'dbt' };
const id = await plant(P, { name: 'Revenue · dbt', datasetId: L, definition: EXT, importedFrom: { kind: 'dbt', name: 'revenue' } }); // raw file write, as b2's sync will
ok('a read keeps the definition and importedFrom', isDeepStrictEqual((await metrics.getMetric(P, id))!.definition, EXT) && (await metrics.getMetric(P, id))!.importedFrom?.name === 'revenue');
await post('metric:update', { projectId: P, id, patch: { format: { kind: 'currency', decimals: 0 }, definition: { column: '', aggregation: 'sum' } } });
ok('an editor\'s full-definition save keeps the external one', isDeepStrictEqual(raw(P, id).definition, EXT) && raw(P, id).format.kind === 'currency');
ok('importedFrom survives the update', raw(P, id).importedFrom.kind === 'dbt');
ok('duplicate is refused', (await post('metric:duplicate', { projectId: P, id })).ok === false);
for (const via of ['trash+restore', 'version restore', 'bundle round trip', 'tree save']) ok(`${via} keeps it`, isDeepStrictEqual(await afterRoundTrip(via, P, id), EXT));
ok('NEGATIVE CONTROL: a simple definition sanitizes as before', isDeepStrictEqual(metrics.sanitizeDefinition({ column: 'a', aggregation: 'avg', external: 7 }), { column: 'a', aggregation: 'avg' }));
ok('a bad external string is not kept', metrics.sanitizeDefinition({ external: '\u0000x' }).hasOwnProperty('external') === false);
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` compiles, then `node scripts/test-externalReader.js` → the update writes `{ column: '', aggregation: 'sum' }`.
- [ ] **Step 3: Implement.** Widening the union makes `tsc` fail at every reader; leave those errors for Task 2 by landing Tasks 1 and 2 in one commit if the build cannot pass between them.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-externalReader.js && node scripts/test-metrics.js && node scripts/test-snapshotReader.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/analysis/externalMetric.ts src/analysis/externalMetricMessages.ts src/analysis/metrics.ts scripts/i18n-extract.ts src/i18n scripts/test-externalReader.ts` · "Keep a metric defined by an external semantic layer through every save"

### Task 2: Every reader of a definition keeps it, refuses it or words it
**Files:** Modify every site `tsc` names, in the files listed by the ratchet (today: `src/ipc/metrics.ts` (5 sites, `resolveDefinition` l.121-170 first), `src/analysis/scenarioResolve.ts` 3, `src/analysis/metricMeasures.ts` 3, `src/publish/kpiSubtitle.ts` 2, `src/ipc/scenarios.ts` 2, `src/ipc/metricCheck.ts` 2, `src/analysis/metricUsage.ts` 2, `src/analysis/metricTreeJs.ts` 2, `src/analysis/metricFormat.ts` 2, `src/analysis/driverShape.ts` 2, `src/publish/embedLock.ts`, `src/ipc/stories.ts`, `src/ipc/search.ts`, `src/ipc/periods.ts`, `src/ipc/metricTree.ts`, `src/ipc/drivers.ts`, `src/ipc/drillScope.ts`, `src/ipc/answers.ts`, `src/analysis/snapshotGuards.ts`, `src/analysis/metrics.ts`, plus the `definition.column|aggregation|formula` readers and the alert path of part 1 step 07), `src/analysis/snapshotGuards.ts` (`snapshotMeasureRefusal` also refuses an external measure; rename nothing), `src/server/app.ts:462,488`, `src/ipc/analysesServer.ts:57-64,147-152` · Create `scripts/definitionSites.ts`, `scripts/test-definitionSites.ts`
**Interfaces:** Produces `DEFINITION_SITES: Readonly<Record<string, { count: number; how: 'keeps' | 'refuses' | 'words' | 'door' }>>` keyed by repo path. Patterns scanned over `src/**/*.ts` and `web/src/**/*.ts(x)` (no `.js`, tests or `prototype/`): `/\bisFormulaDefinition\(/`, `/['"]formula['"]\s+in\b/`, `/\.definition\.(column|aggregation|formula|snapshot)\b/`, `/\bisExternalDefinition\(/`. `words`: `describeDefinition` and the short form say "Defined in another tool" (b2 names the layer). `door`: the KPI resolver and the chart planner, which b2 turns into answers.
- [ ] **Step 1: Write the failing test.**
```ts
const ENTRIES: Array<[string, object]> = [
  ['metric:value', { projectId: P, id }], ['dashboard:metric', kpiWith(id)], ['analysis:tiles', tilesWith(id)], ['visual:data', chartWith(id)],
  ['metric:value (formula naming it)', { projectId: P, id: FORMULA_OVER_IT }], ['alerts:test', alertOn(id)], ['scorecard:compute', scorecardOn(id)],
  ['metricTree:compute', treeOver(id)], ['scenario:compute', scenarioOn(id)], ['story:figures', storyWith(id)], ['answer:card', answerWith(id)],
];
for (const [ch, body] of ENTRIES) {
  const r = await call(ch, body);
  ok(`${ch}: refused, typed, with the sentence; no figure`, refusedExternal(r) && JSON.stringify(r).includes(externalPending('Revenue · dbt')) && !hasFigure(r));
}
ok('a KPI tile whose metric:value refused does not say "deleted"', !/was deleted/.test(tile(await call('analysis:tiles', tilesWith(id)), 0).error));
ok('MCP metric_value refuses too', (await mcp('metric_value', { metric: 'Revenue · dbt' })).error === externalPending('Revenue · dbt'));
ok('NEGATIVE CONTROL: the same entries over a plain metric answer', (await Promise.all(ENTRIES.map(([ch, b]) => call(ch, swapId(b, PLAIN))))).every((r) => !refusedExternal(r)));
// the ratchet: each scanned file's match count equals its entry; a planted `src/__defProbe.ts` with `isFormulaDefinition(d)` fails the scan (removed in finally)
```
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-externalReader.js && node scripts/test-definitionSites.js` → `metric:value` answers null; every file unclassified.
- [ ] **Step 3: Implement.** One guard per site, the narrowest that is correct: a figure path throws `new ExternalMetricError('pending', m.name)`; a planner returns its refusal; a sanitizer keeps; a wording site words. Fill `DEFINITION_SITES` from the scan with each site's `how`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-externalReader.js && node scripts/test-definitionSites.js && node scripts/test-metricMeasures.js && node scripts/test-alerts.js && node scripts/test-scenarios.js && node scripts/test-analysesServer.js && npm run lint` → all `ok`, lint 0.
- [ ] **Step 5: Commit.** `git add src scripts/definitionSites.ts scripts/test-definitionSites.ts scripts/test-externalReader.ts` · "Refuse, typed, every figure that would read an external metric"

### Task 3: A dataset with a `semantic` key answers nothing
**Files:** Modify `src/data/liveDataset.ts` (`LiveSettings.semanticPending?`, `applyLive`), `src/engine/live/liveTarget.ts:77-84`, `src/engine/live/liveSpec.ts` (code `semanticPending`, no param), `src/engine/liveRefusals.ts` (`liveSemanticPending()` "This dataset asks another tool's semantic layer, which this server can't do yet. Ask your admin to finish upgrading Ordinate."), `src/ipc/liveDatasets.ts:171-235` (`copyLiveDataset`, `setDatasetMode`), `src/ipc/metrics.ts` (`ensureDefaults` skips it) · Test `scripts/test-externalReader.ts` (§ dataset, on `scripts/liveRouteHarness.ts`)
- [ ] **Step 1: Write the failing test.** Plant `semantic: { backend: 'cube', model: 'orders' }` at the top level of the harness's Live record and drop its `table`:
```ts
for (const ch of ['visual:data', 'dashboard:metric', 'answer:card', 'dataset:syncLiveSchema', 'dataset:copyLive', 'dataset:setMode']) {
  const before = fake.calls.length; const r = await post(ch, liveBody(ch, L));
  ok(`${ch}: refused semanticPending, no warehouse call`, refusedCode(r, 'semanticPending') && fake.calls.length === before);
}
ok('a Refresh keeps the key', (await post('dataset:refresh', { projectId: P, id: L })) && 'semantic' in rawRecord(P, L));
ok('ensureDefaults proposes nothing for it', (await post('metric:ensureDefaults', { projectId: P, datasetId: L })).metrics.every((m: { datasetId: string }) => m.datasetId !== L));
ok('NEGATIVE CONTROL: without the key the same doors answer', (await post('visual:data', liveBody('visual:data', L2))).ok === true);
```
- [ ] **Step 2: Run it to see it fail.** → `badSource`, not `semanticPending`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-externalReader.js && node scripts/test-liveSafetyNet.js && node scripts/test-liveBaseFilters.js && node scripts/test-liveCompile.js && node scripts/i18n-extract.js && node scripts/test-i18n.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/data/liveDataset.ts src/engine src/ipc/liveDatasets.ts src/ipc/metrics.ts src/i18n scripts/test-externalReader.ts` · "Refuse a dataset that asks a semantic layer this pod cannot ask"

### Task 4: Say how the release gap is held
**Files:** Modify `docs/server/upgrade.md` (a section after 05a's)
- [ ] **Step 1:** `node scripts/test-serverDocs.js` stays green; nothing to fail.
- [ ] **Step 2:** Write "Definitions from another semantic layer are kept (`p7-b0`)": this release keeps external metric definitions, `importedFrom` and a dataset's `semantic` key, and refuses what it cannot compute. **The release that connects a semantic layer (Snowflake semantic views, Cube, dbt) and the dbt import needs this release on every pod first.** Upgrade through it, or stop all pods first (the Compose and Helm steps 05a's section gives). Never `helm rollback` below it once a layer is connected.
- [ ] **Step 3: Commit.** `git add docs/server/upgrade.md` · "Document the reader release external semantic layers need first"

**Before the PR:** `npm test`, `npm run test:web`, `npm run lint`, `node scripts/check-contracts.js`, `node scripts/test-file-size.js`. The PR description lists the classified sites.
