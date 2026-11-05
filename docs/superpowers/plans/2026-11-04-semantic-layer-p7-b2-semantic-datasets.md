# Semantic layer part 7, step b2: semantic datasets, the layer sync and external metrics — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A connection with the `semantic` capability lists its models; **Add as dataset** makes a Live dataset whose columns are the layer's dimensions and whose metrics are the layer's own, mirrored as metric records that hold a name and never math; charts, KPI tiles, alerts, scorecards, answers, value lists and MCP read them through the three existing doors, and everything a layer cannot do is refused with a sentence naming it.
**Architecture:** The dataset record gains a top-level `semantic` block (beside `baseFilters`, so no Live writer erases it), read into `meta.live.semantic` by `applyLive`. `liveTarget` returns a semantic target, and `liveQuery`'s ask runs b1's `evaluateSemantic` instead of `evaluateLive` for it, through an adapter registry (one encoder per backend; c1, e1, d1 add theirs). The schema sync gets a semantic branch that reads dimensions and metrics with `describeModel`, writes them in the record's one write, then creates or updates the mirror metrics (`{ external, additive, layer }`, b0's kind). b0's refusals at the KPI resolver and the chart planner become answers on a semantic dataset; everywhere else they become final, layer-naming refusals.
**Tech Stack:** `src/data`, `src/engine/live`, `src/ipc`, `src/api`, `src/analysis`, `src/app`, self-checks.
**Spec:** docs/semantic-layer/07-portability.md (D11, D12, D13, D14, D16, D17, D18) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-b2-semantic-datasets` off `origin/develop` after b1 and a3 merge (Task 6 edits a1–a3's model files). One PR. Release 2. **Merge gate:** `git tag -l 'v*' --no-contains <b0 merge sha>` prints nothing, or a `v*` tag contains b0 (no released server without b0 may roll straight into this one).

## Rolling deploys

| New stored thing | A b0 pod reads and re-saves it | A pod before b0 |
|---|---|---|
| Dataset top-level `semantic` | `semanticPending`: every door, sync and copy refuses; the key is never touched | `badSource` on every question (no `table`, no `sql`); untouched |
| Metric `definition: { external, additive, layer }` | kept verbatim, every figure refused `externalPending` | **do not ship before b0 is everywhere** (the merge gate) |
| Mirror metrics in Trash, versions, bundles | kept (b0 Task 1) | — |

## Global Constraints

- **The block.** `interface SemanticSettings { backend: SemanticBackendId; model: string; metrics: Array<{ name: string; additive: boolean; description?: string }>; grains: Array<{ column: string; grains: DateGrain[] }>; syncedAt: string }`, stored at the record's top level as `semantic`, sanitized by `sanitizeSemantic` (new `src/data/semanticDataset.ts`; caps: 2,000 metrics, 512-character names). Unreadable → `live.semanticUnreadable` and every door refuses, as 08a does for base filters. The origin is `{ kind: 'connection', connId }` with no `table` or `sql`.
- **Columns are the layer's dimensions**, typed as the layer reports them (`ColumnType`); a dimension of a type we cannot map is left out and named in the sync report. No row sample, so no sensitivity detection: markings are set by hand and the dataset's Schema reply says `sensitivity: 'manual'` (D11).
- **Mirrors (D13).** One `Metric` per layer metric: `datasetId` the semantic dataset, `definition: { external: <layer name>, additive, layer: backend }`, `filters: []`, the default format. The sync is the only writer of an external definition; mirrors are written after the dataset's one sync write (my call), each through `metrics.saveMetric`/`updateMetric` plus `versions.record`, idempotent. Names are unique per project case-insensitively, against metrics and terms; a clash appends ` · <connection name>` (D13). A dropped layer metric keeps its mirror, which then refuses `metricMissing`; a layer-side rename is missing plus new, never a remap. A mirror in Trash (`datasetId` and `external` equal) is never recreated.
- **Read-only.** `metric:update` on a mirror refuses a non-empty `filters` or a `definition` with `externalReadOnly(layer)` "Defined in {layer}: edit it there."; format, name, description and direction save as today. `metric:save` of a column metric on a semantic dataset refuses `columnOnLayer`. `describeDefinition` (`src/analysis/metricFormat.ts:101`) says "Defined in {layer}".
- **Doors (live rule).** Every figure goes through `vizDataFor`, `computeCardMetric` or `computeCard`. `computeCardMetric`'s spec widens to `{ column; aggregation } | { metric: string }` (`src/ipc/dashboards.ts:150`), `lockedMetric`'s bound to `S extends { column?: string }` (`src/ipc/rowDoors.ts:146`), and `resolveDefinition` (`src/ipc/metrics.ts:121`) asks `{ metric: definition.external }` on the mirror's own dataset. A chart measure carries `metricId` and an empty `column` (b3's picker writes it so); `fromSemanticViz` maps each `metricId` to its mirror's `external` and refuses a measure without one (`columnOnLayer`). Series are relabelled with the mirror's Ordinate name. `planMetricMeasures` returns `null` for mirror-only measures, and a formula metric naming a mirror refuses `formulaOverLayer`.
- **Cache key (D18).** `keyOf(t, { ir, semantic: { backend, model } })`; the epoch, `schemaSyncedAt` and `orgKey` as today. Refresh bumps the epoch as for any Live dataset.
- **Certification pin (part 4, cross-part check item 7).** Part 4's `DATASET_PIN.live` (`src/analysis/statusPin.ts`) gains the semantic block's `backend` and `model`, so a certified semantic dataset reads `needs_review` when it is pointed at another model; a sync that only refreshes `metrics`/`grains`/`syncedAt` does not move it. Test it in `test-governanceStatus`'s DATASET_PIN loop.
- **Row access (D17).** A restricted caller's lock reaches the plan as `binary: true` filters and is refused `layerRowPolicy` by b1's plan, at every door, value lists and the Assistant's lookups included, until a backend declares `binaryCompare` (c1 may, after its pin). A caller from whom part 4's column rules hide any column of the dataset (`hiddenColumnsFor(projectId, datasetId)` non-empty) is refused `layerRowPolicy` too, whatever the backend declares; test it beside the row-rule case, with the named team as the negative control.
- **No origin in a reply.** No model name, view name, environment id or URL in a dataset reply, a refusal or a sync report; layer error text goes to the log through `safeError` (R-L6).
- **Copies.** `dataset:copyLive` and `dataset:setMode` refuse a semantic dataset with `semanticNoCopy()` "A copy can't be made from {dataset}: {layer} returns totals, not rows."; b3 hides the button.
- Model files: `exportModel` skips mirrors; a file metric with an external definition plans as `skipped: external`; a mirror is never `onlyHere`.
- Contracts in a new `src/api/semantic.ts` (appended to `src/api/index.ts`), both `write` with project scope; nothing to classify in `scripts/rowPolicyReaders.ts`. Sentences in `src/data/semanticMessages.ts` (`MAIN_FILES`). Files near the cap: `src/ipc/metrics.ts`, `src/ipc/liveDatasets.ts` 298, `src/engine/live/schemaSync.ts` 334 (a 2-line branch), `src/engine/live/liveQuery.ts` 406 (the branch only), `src/server/app.ts` (module list, 0 lines). No dependency, no migration.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **No silent math.** An average from the layer is never summed into "Other", a total, a running total or a dashboard roll-up; each is refused or asked of the layer. Tasks 4–5.
- **Old pods.** The merge gate, and b0's tests still green over the records this PR writes. Task 2.
- **Restricted viewers** are refused at every door, value lists and Assistant lookups included; negative control: an unrestricted editor answers. Task 5.
- **Leaks.** A planted model name, environment id and layer error text never reach a reply. Task 3.
- **Safety net.** A semantic dataset in `test-liveSafetyNet`: every row-reading channel refuses `live_dataset`. Task 6.

---

### Task 1: The record and the target
**Files:** Create `src/data/semanticDataset.ts`, `src/data/semanticMessages.ts`, `scripts/test-semanticDatasets.ts` (on `scripts/liveRouteHarness.ts` + b1's `scripts/semanticFake.ts`) · Modify `src/data/liveDataset.ts` (`LiveSettings.semantic?`, `semanticUnreadable?`; `applyLive` l.191, replacing b0's presence flag), `src/data/liveRecord.ts` (`saveSemanticRecord`), `src/engine/live/liveTarget.ts` (semantic branch before `liveSourceOf`), `scripts/i18n-extract.ts`
**Interfaces:** Produces `SemanticSettings`, `sanitizeSemantic(raw: unknown): SemanticSettings | null`; `saveSemanticRecord(projectId, input: { name: string; connId: string; semantic: SemanticSettings; columns: ParsedColumn[]; maxCacheAgeSec?: number }): Promise<DatasetMeta | null>`; `writeSemanticSync(projectId, id, w: { columns: ParsedColumn[]; semantic: SemanticSettings; missingColumns: string[]; syncedAt: string; changed: boolean }): Promise<boolean>` (one `serialized` write); `LiveTarget.semantic?: { backend; model; env: SemanticEnv }` (the target's `source` is an inert `{ kind: 'table', parts: [] }` never compiled).
- [ ] **Step 1: Write the failing test.** A saved semantic record reads back with `meta.live.semantic` equal to what was saved; `bumpEpoch` and `setMaxCacheAge` keep the top-level key; an unreadable block refuses every door; `liveTarget` on it returns `semantic.env` with the synced metrics and grains and its connection's `def.semantic`; a connection whose connector has no `semantic` (or another backend) is `unavailable`; no SQL compile runs for a semantic target (spy on `compileChart`).
- [ ] **Step 2–4:** red → implement → `npm run build:ts && node scripts/test-semanticDatasets.js && node scripts/test-liveBaseFilters.js && node scripts/test-externalReader.js` green.
- [ ] **Step 5: Commit.** `git add src/data src/engine/live/liveTarget.ts scripts/i18n-extract.ts src/i18n scripts/test-semanticDatasets.ts` · "Store a semantic dataset's layer block where no Live writer can erase it"

### Task 2: The sync and the mirrors
**Files:** Create `src/engine/live/semantic/semanticSync.ts`, `src/engine/live/semantic/mirrors.ts` · Modify `src/engine/live/schemaSync.ts:293` (first line: a semantic record goes to `syncSemantic`), `src/connectors/semanticRun.ts` (b1: `describeSemanticModel`, `listSemanticModels`, both through `guardHost` and `safeError`, as a catalog read: not counted, as `readLiveSchema` is not)
**Interfaces:** Produces `syncSemantic(projectId, datasetId, signal): Promise<SyncReply>` (the existing reply shape, `sample: { ok: false, reason: 'semantic' }`, `sensitivity: 'manual'`); `syncMirrors(projectId, datasetId, s: SemanticSettings, connectionName: string): Promise<{ created: string[]; updated: string[]; missing: string[] }>`.
- [ ] **Step 1: Write the failing test.**
```ts
const ds = await addSemantic(P, CONN, 'orders'); await sync(P, ds);
const ms = (await metrics.listMetrics(P)).filter((m) => m.datasetId === ds);
ok('one mirror per layer metric, holding a name, not math', ms.length === FAKE_METRICS_COUNT && ms.every((m) => isExternalDefinition(m.definition) && !('column' in m.definition)));
ok('additive comes from the layer', ms.find((m) => m.name === 'revenue')!.definition.additive === true && ms.find((m) => m.name === 'avg_amount')!.definition.additive === undefined);
ok('a second sync writes nothing new', (await syncMirrors(P, ds, S, 'Layer prod')).created.length === 0 && versionsOf(ms[0]) === 1);
// in a fresh project P2, an Ordinate metric "Orders" exists before the first sync
ok('a name clash (case-blind) takes the connection\'s name', (await names(P2)).includes('orders · Layer prod') && (await names(P2)).includes('Orders'));
await trash(P, mirror('revenue')); await sync(P, ds);
ok('a trashed mirror is not recreated', !(await names(P)).includes('revenue'));
await layerDrops('max_amount'); await sync(P, ds);
ok('a dropped layer metric keeps its mirror, which refuses metricMissing', (await kpi(mirror('max_amount'))).code === 'live_refused' && (await kpi(mirror('max_amount'))).reason === 'metricMissing');
ok('the sync never runs a row sample', fakeLog.every((q) => q.metrics.length > 0 || q.dimensions.length > 0) && sampleCalls() === 0);
ok('b0 still keeps every mirror through a format save', isExternalDefinition((await post('metric:update', { projectId: P, id: mirror('revenue'), patch: { format: { kind: 'currency' } } })).metric.definition));
```
- [ ] **Step 2–4:** red → implement → `node scripts/test-semanticDatasets.js && node scripts/test-liveProfileSync.js` green.
- [ ] **Step 5: Commit.** `git add src/engine/live src/connectors/semanticRun.ts scripts/test-semanticDatasets.ts` · "Sync a semantic dataset's dimensions and mirror its layer's metrics"

### Task 3: Listing models and adding a dataset
**Files:** Create `src/api/semantic.ts`, `src/ipc/semanticDatasets.ts` · Modify `src/api/index.ts` (append), `src/server/app.ts:570` (module in the Data list), `src/connectors/index.ts:265-280` (`connectorCatalog` entries gain `semantic: boolean`)
**Interfaces:** `'connection:semanticModels': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, connId: Uuid }), project: byProjectId })` → `{ ok: true; models: Array<{ name: string; label?: string; description?: string }> } | { ok: false; error }`; `'connection:addSemanticDataset': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, connId: Uuid, model: z.string().min(1).max(512), name: z.string().max(200).optional(), maxCacheAgeSec: z.number().int().optional() }), project: byProjectId })` → `{ ok: true; dataset } | { ok: false; error }`; it describes the model, saves the record and queues the first sync (`startSchemaSync`, lazily required as `queueSync` does, `src/ipc/liveDatasets.ts:111`).
- [ ] **Step 1: Write the failing test.** The listing returns the fake's models; a connection without `semantic` → a sentence; adding saves a Live record with no `table`/`sql` and a `semantic` block, and its mirrors land after the queued sync; a viewer → 403. Leak: a planted model name, an environment-id-shaped value in the connection's values and a layer error with a token: none in any reply (`JSON.stringify` grep), all in the log; canary: the dataset's own name is found.
- [ ] **Step 2–4:** red → implement → `node scripts/test-semanticDatasets.js && node scripts/check-contracts.js && node scripts/test-connectors.js` green.
- [ ] **Step 5: Commit.** `git add src/api src/ipc/semanticDatasets.ts src/server/app.ts src/connectors/index.ts scripts/test-semanticDatasets.ts` · "List a semantic layer's models and add one as a Live dataset"

### Task 4: The three doors answer from the layer
**Files:** Create `src/engine/live/semantic/semanticSpec.ts` (`fromSemanticViz`, `fromSemanticMetric`, `fromSemanticAnswer`), `src/engine/live/semantic/adapters.ts` (the backend registry, plus `registerTestSemanticAdapter`, refused under `ORDINATE_ENV=prod`) · Modify `src/engine/live/liveSpec.ts` (`chartCore` l.312 takes a measure reader, default `checkMeasure`), `src/engine/live/liveQuery.ts` (`ask`/`answer` l.179-257: semantic targets run `evaluateSemantic` with a runner that encodes through the adapter and calls `warehouse`), `src/ipc/liveRoute.ts:86,98` (mirror ids and names), `src/ipc/dashboards.ts:150`, `src/ipc/rowDoors.ts:146`, `src/ipc/liveBaseFilters.ts` (part 1 08's `setLiveBaseFilters`: a semantic dataset refuses with `liveRefusals.layer_baseFilter`, "Always-applied filters are not available on {layer}'s datasets."), `src/ipc/liveCalcs.ts` (part 8 04's `live:setCalculated` and `live:checkCalc` refuse `formulaOverLayer`), `src/ipc/metrics.ts:121-170`, `src/analysis/metricMeasures.ts` (b0's `door` sites), `src/analysis/additivity.ts` (part 1 step 02: an external definition adds up across categories and time exactly when `definition.additive`, D16 "only where the layer says plain sum or count"), `src/analysis/snapshotGuards.ts` (b0's chart refusal lets a mirror through on its own semantic dataset), `scripts/definitionSites.ts` (`door` → `answers`) · Test `scripts/test-semanticDoors.ts`
**Interfaces:** Produces `interface SemanticAdapter { encode(q: SemanticQuery, model: string): SemanticRequest }`; `ADAPTERS: Partial<Record<SemanticBackendId, SemanticAdapter>>`; `computeCardMetric(projectId, datasetId, spec: { column: string; aggregation: MetricAggregation; snapshot?: MetricSnapshot } | { metric: string }, filters?, params?)`.
- [ ] **Step 1: Write the failing test.** Over the fake layer and an extract of the same seed with equal Ordinate metrics (b1's `FAKE_METRICS`), through the real routes:
```ts
for (const c of DOOR_CASES) { // visual:data, visual:dataBatch, analysis:tiles (chart + KPI), dashboard:metric, metric:value, metric:values (compare previous period), alerts:test, scorecard:compute, answer:card, MCP metric_value
  ok(`${c.ch}: the semantic figure equals the extract's (Object.is)`, figuresAgree(await onSemantic(c), await onExtract(c)));
}
ok('a chart\'s series carry the mirror\'s Ordinate name', (await chart(MIRROR_REV)).data.series[0].name === 'revenue');
ok('one question per chart, cached by the IR', fakeCalls(() => chart(MIRROR_REV), 2) === 1);
for (const [code, ask] of D16_CASES) ok(`${code}: refused at its door with the layer's sentence`, refusalOf(await ask()).reason === code && /Fake layer/.test(refusalOf(await ask()).error));
// D16_CASES: pivot, cohort, funnel, drivers, facet, map, raw, related, bins, weekRollup, autoGrain, nonAdditiveCalc (running_total over avg_amount),
// formulaOverLayer ([revenue] / [orders]), columnOnLayer (a column measure), metricMissing
ok('NEGATIVE CONTROL: running_total over an additive mirror is allowed', (await chartWithCalc(MIRROR_REV, 'running_total')).ok === true);
// cross-part check item 14: part 1's always-applied filters and part 8's Live calcs never reach a layer
ok('live:setBaseFilters on a semantic dataset is refused, and nothing is stored', !(await post('live:setBaseFilters', { projectId: P, datasetId: SEM, filters: [WEST] })).value.ok && !('baseFilters' in (await raw(P, SEM))));
ok('NEGATIVE CONTROL: the same call on a plain Live dataset stores the filter', (await post('live:setBaseFilters', { projectId: P, datasetId: PLAIN_LIVE, filters: [WEST] })).value.ok === true);
for (const ch of ['live:setCalculated', 'live:checkCalc']) ok(`${ch} on a semantic dataset: refused formulaOverLayer, nothing stored`, refusalOf(await post(ch, calcBody(SEM))).reason === 'formulaOverLayer' && !('calculated' in (await raw(P, SEM))));
ok('NEGATIVE CONTROL: live:checkCalc on a plain Live dataset types the expression', (await post('live:checkCalc', calcBody(PLAIN_LIVE))).value.ok === true);
ok('a KPI on a mirror never falls back to "deleted"', !/was deleted/.test(JSON.stringify(await tiles([kpiOf(MIRROR_MISSING)]))));
```
- [ ] **Step 2–4:** red → implement → `node scripts/test-semanticDoors.js && node scripts/test-liveRoute.js && node scripts/test-liveRouteAnswers.js && node scripts/test-metricMeasures.js && node scripts/test-chartsFollowMetric.js && node scripts/test-definitionSites.js && node scripts/test-externalReader.js` green.
- [ ] **Step 5: Commit.** `git add src/engine/live src/ipc src/analysis scripts/definitionSites.ts scripts/test-semanticDoors.ts` · "Answer charts, KPIs and answers on a semantic dataset through the three doors"

### Task 5: Value lists, lookups and row access
**Files:** Modify `src/ipc/liveProfile.ts:113` (`liveDistinct`: a semantic dataset asks one dimension-only question through `warehouse`, or refuses `layerLookup`), `src/ipc/liveAnswers.ts` (spelling lookups: the same), `src/engine/live/semantic/semanticPlan.ts` (b1: `planValues`) · Test `scripts/test-rowPolicyLive.ts` (§ semantic), `scripts/test-semanticDoors.ts` (§ values)
- [ ] **Step 1: Write the failing test.** `dataset:distinct` on a dimension returns the fake's values, sorted as the extract's, and is one counted question; with `caps.lookups: false` it refuses `layerLookup`. In `test-rowPolicyLive`: a caller restricted by a rule on the semantic dataset is refused `layerRowPolicy` at `visual:data`, `dashboard:metric`, `answer:card`, `dataset:distinct` and the Assistant's spelling lookup, with no layer call (`fakeLog` unchanged); NEGATIVE CONTROL: an unrestricted editor answers at each; and a backend adapter registered with `binaryCompare: true` plans the lock (the hook c1 uses).
- [ ] **Step 2–4:** red → implement → `node scripts/test-rowPolicyLive.js && node scripts/test-semanticDoors.js && node scripts/test-liveValues.js` green.
- [ ] **Step 5: Commit.** `git add src/ipc/liveProfile.ts src/ipc/liveAnswers.ts src/engine/live/semantic scripts/test-rowPolicyLive.ts scripts/test-semanticDoors.ts` · "Ask a layer for value lists, and refuse restricted callers on every layer door"

### Task 6: Saves, words, copies, model files and the safety net
**Files:** Modify `src/ipc/metricSave.ts` (a2: `externalReadOnly`, `columnOnLayer`), `src/analysis/metricFormat.ts:83,101` ("Defined in {layer}"), `src/ipc/liveDatasets.ts:201-260` (`semanticNoCopy`), `src/app/modelExport.ts`, `src/app/modelPlan.ts`, `scripts/test-liveSafetyNet.ts` (a semantic dataset beside the Live one) · Test `scripts/test-semanticDatasets.ts` (§ saves), `scripts/test-modelPlan.ts`, `scripts/test-liveSafetyNet.ts`
- [ ] **Step 1: Write the failing test.** `metric:update` on a mirror with `filters: [F]` → `externalReadOnly('Fake layer')`, and with only `format` → saved; `metric:save` of `{ column, aggregation }` on the semantic dataset → `columnOnLayer`; `metric:list`'s `definitionText` for a mirror is "Defined in Fake layer"; `dataset:copyLive` → `semanticNoCopy`; a mirror is not in `exportModel`'s files, a file metric with `{ external }` plans `skipped: external`, a mirror is never `onlyHere`; every row-reading channel in `test-liveSafetyNet` refuses `live_dataset` on the semantic dataset (NEGATIVE CONTROL: the extract answers).
- [ ] **Step 2–4:** red → implement → `node scripts/test-semanticDatasets.js && node scripts/test-modelPlan.js && node scripts/test-modelExport.js && node scripts/test-liveSafetyNet.js && node scripts/test-metrics.js && npm run lint` green.
- [ ] **Step 5: Commit.** `git add src scripts` · "Keep a layer's metrics read-only here, out of copies and model files, and in the safety net"

### Task 7: Docs and the release note
**Files:** Modify `docs/server/live-data.md` (a "Semantic layers" section: what a semantic dataset is, what it refuses and why, restricted viewers refused, markings by hand), `CHANGELOG.md` (`[Unreleased]`)
- [ ] **Step 1:** `node scripts/test-serverDocs.js` → `ok` (no env var added).
- [ ] **Step 2: Commit.** `git add docs/server/live-data.md CHANGELOG.md` · "Document semantic datasets and what a layer cannot answer"

**Before the PR:** `npm test`, `npm run test:web`, `npm run lint`, `node scripts/check-contracts.js`, `node scripts/test-file-size.js`; check the merge gate with `git tag`.
