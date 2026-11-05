# Semantic layer part 1, step 06: Value labels — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A text column can say what its coded values mean (`EU` → "Europe"), and every chart axis, legend, caption, picker, published page and embed shows the label while every filter still filters by the stored value.
**Architecture:** Labels are stored on the column's catalog doc (`ColumnDoc.values`, reader shipped in step 01a). The server decides, per reply, which labels apply: `applyValueLabels` (pure, `src/analysis/valueLabels.ts`) adds `data.valueLabels` — raw → label pairs for the values IN that reply only — beside the unchanged raw `labels` and series names. Text the server writes itself (captions, `/p/` pages, embeds, stories, Assistant facts) uses the pairs directly; the browser draws through the same pure module, exactly as it already draws a first-of-month raw label as "Jan 2023" while every click, custom sort, colour and annotation keeps the raw label.
**Tech Stack:** catalog JSON, RPC contracts (zod), `visual:*` replies, answer cards, `src/publish/` page builders, `dataset:distinct`, Assistant facts, MCP, React chart engine (`web/src/charts/`), the Columns tab.
**Spec:** docs/semantic-layer/00-design.md (D6; D12 for the restricted-viewer rule) · Index: docs/superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md
**Branch and PR:** `feat/semantic-p1-06-value-labels` off `origin/develop` (after step 05 merges), one PR to `develop`. Precondition: step 01a (`sanitizeValueLabels`, `ColumnDoc.values`) is in a release already deployed.

## Global Constraints

- Text columns only (declared `type === 'text'`), ≤ 500 labels per column, value ≤ 256 chars matched EXACTLY against the stored cell text (never trimmed; blank refused), label ≤ 120 chars, trimmed (D6; caps from 01a's `MAX_VALUE_LABELS`, `MAX_VALUE_LEN`, `MAX_LABEL_LEN`).
- Refused with a sentence, nothing saved: a value listed twice; two values with one label; more than 500; a non-text column (D6).
- Applied on the server for: grouped-chart category axes and split legends (`visual:data`, `visual:dataBatch`, `analysis:tiles`, `visual:preview`), answer cards (Explore and the Assistant), captions, filter value pickers (`dataset:distinct`), published pages, stories and embeds (charts and control options), chart exports. Row grids and row exports keep stored values (D6).
- Not applied in part 1 (each keeps raw values; reported to the owner): maps (regions are matched by name), pivot headers, cohort and event-funnel grids, facet panel titles, metric-tree splits, scorecard breakdowns, key-driver explanations. `kpiCaption` names metrics, never a category, so KPI tiles have nothing to label.
- A restricted viewer (`closedToCaller`) gets no value list from `catalog:columns`, `describe_dataset` or the Assistant's facts; pairs in any reply exist only for values already in that caller's locked result (D6).
- Labels are applied AFTER the Share policy shapes a reply, so a masked token never gets a pair and no raw sensitive value rides in `valueLabels`.
- A reply with no pair carries NO `valueLabels` key (the wire encodes `undefined`): replies and golden fixtures stay byte-identical.
- Files near the cap: `src/ipc/visuals.ts` 769 and `src/ipc/datasets.ts` 748 (≤ 3 lines each), `src/publish/dashboardData.ts` 615, `src/analysis/captions.ts` 585, `src/ipc/copilot.ts` 604, `src/app/catalog.ts` 419. New logic in new files.
- i18n: sentences in new `src/analysis/valueLabelMessages.ts`, added to `MAIN_FILES`, then `node scripts/i18n-extract.js`. `src/analysis/valueLabels.ts` stays pure (the web imports it).
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A label equal to another stored value** (`EU` → "Europe" while some row says `Europe`): two bars both "Europe". The pair is dropped for that reply and a warning names it. → Task 1 "collision" and Task 3.
- **The "Other" bucket** of a capped axis is the app's, not the value `Other`. → Task 1.
- **Share policy, then labels.** A masked category yields no pairs and no raw value in the reply. → Task 3.
- **A filter picked by its label filters by the raw value**: chart click, right-click menu, drill, picker, published control. → Tasks 4, 5, 7.
- **Restricted viewer** sees no value list, and only their own values' labels. → Task 2 (safety-net canary).
- **`'EU '` ≠ `'EU'`**, a number column is refused, a retyped column (text → number) stops applying. → Tasks 1–3.
- **Picker search by the label** still respects the row lock. → Task 5.
- **Byte-identical with no labels**: no `valueLabels` key anywhere. → Tasks 1 and 3.

## Rolling deploys

`ColumnDoc.values` is read and kept by every pod from step 01a on (its Task 1 test pins it); a pre-01a pod would drop every label of the project on its next catalog write, hence the precondition above. During this PR's rollout an older pod 400s a `catalog:setColumn` carrying `values` (strict zod) and draws raw values on the replies it serves; nothing is lost.

---

### Task 1: The pure rules — check, apply, show, invert

**Files:** Modify `src/analysis/valueLabels.ts` (from 01a). Create `src/analysis/valueLabelMessages.ts`, `scripts/test-valueLabels.ts`. Modify `src/analysis/vizData.ts:40-63` (`VizDataResult['data'].valueLabels?`), `scripts/i18n-extract.ts` (`MAIN_FILES`).
**Interfaces:** Consumes `ValueLabel`, `sanitizeValueLabels`, `MAX_VALUE_LABELS` (01a), `OTHER_LABEL` (`src/analysis/categoryKey.ts:36`). Produces
- `export interface ValueLabelPairs { category?: [string, string][]; series?: [string, string][] }` (pairs, not an object map: a value may be `__proto__`).
- `export type ValueLabelProblem = { kind: 'repeatValue'; value: string } | { kind: 'sharedLabel'; label: string; values: [string, string] } | { kind: 'tooMany' }`; `valueLabelProblem(list: ValueLabel[]): ValueLabelProblem | null`.
- `applyValueLabels(data: ChartData, lists: { category?: ValueLabel[]; series?: ValueLabel[] }, opts: { otherBucket?: boolean } = {}): { data: ChartData & { valueLabels?: ValueLabelPairs }; dropped: string[] }` — a pair only for a raw value present in `data.labels` (category) or `data.series[].name` (series); a pair whose label equals another raw value present on the same axis is dropped and its label returned in `dropped`; with `otherBucket`, the value `OTHER_LABEL` gets no pair.
- `shownText<T>(values: readonly T[], pairs?: [string, string][]): (T | string)[]`; `rawOf<T>(shown: T, pairs?: [string, string][]): T | string`; `shownChart<D extends ChartData & { valueLabels?: ValueLabelPairs }>(data: D): D` — labels and series names as shown, `valueLabels` removed.
- `valueLabelMessages.ts`: `valueListedTwice(value)` "“{value}” is listed twice.", `labelShared(label, a, b)` "“{label}” would name both “{a}” and “{b}”. A label can name one value only.", `tooManyLabels(count)` "A column can have at most {count} value labels.", `labelsTextOnly(column, type)` "Value labels are for text columns. {column} is a {type} column.", `labelNotShown(label, column)` "“{label}” is also a value of {column}, so its labelled value shows as stored."

- [ ] **Step 1: Write the failing test** — `scripts/test-valueLabels.ts` §1 (pure):
  ```ts
  const L = [{ value: 'EU', label: 'Europe' }, { value: 'NA', label: 'North America' }];
  const d = { labels: ['EU', 'APAC', 'NA'], series: [{ name: 'sum of amount', values: [1, 2, 3] }] };
  const r = vl.applyValueLabels(d, { category: L });
  ok('pairs only for values in the reply', JSON.stringify(r.data.valueLabels) === '{"category":[["EU","Europe"],["NA","North America"]]}');
  ok('raw labels untouched', JSON.stringify(r.data.labels) === '["EU","APAC","NA"]');
  ok('no labels → no valueLabels key', !('valueLabels' in vl.applyValueLabels(d, {}).data));
  ok('a value not in the reply gets no pair', !('valueLabels' in vl.applyValueLabels({ ...d, labels: ['APAC'] }, { category: L }).data));
  const clash = vl.applyValueLabels({ ...d, labels: ['EU', 'Europe'] }, { category: L });
  ok('collision: the pair is dropped and named', !('valueLabels' in clash.data) && clash.dropped[0] === 'Europe');
  ok('the Other bucket is the app\'s', !('valueLabels' in vl.applyValueLabels({ ...d, labels: ['Other'] }, { category: [{ value: 'Other', label: 'Misc' }] }, { otherBucket: true }).data));
  ok('exact match: "EU " is not "EU"', !('valueLabels' in vl.applyValueLabels({ ...d, labels: ['EU '] }, { category: L }).data));
  ok('split legend', JSON.stringify(vl.applyValueLabels({ labels: ['x'], series: [{ name: 'EU', values: [1] }] }, { series: L }).data.valueLabels) === '{"series":[["EU","Europe"]]}');
  ok('shownChart', JSON.stringify(vl.shownChart(r.data)) === JSON.stringify({ labels: ['Europe', 'APAC', 'North America'], series: d.series }));
  ok('rawOf inverts, and passes an unlabelled value through', vl.rawOf('Europe', r.data.valueLabels!.category) === 'EU' && vl.rawOf('APAC', r.data.valueLabels!.category) === 'APAC');
  ok('a value named __proto__ is a value', vl.shownText(['__proto__'], [['__proto__', 'P']])[0] === 'P');
  ok('problems', vl.valueLabelProblem([...L, { value: 'EU', label: 'x' }])?.kind === 'repeatValue'
    && vl.valueLabelProblem([...L, { value: 'EUR', label: 'Europe' }])?.kind === 'sharedLabel'
    && vl.valueLabelProblem(Array.from({ length: 501 }, (_, i) => ({ value: `v${i}`, label: `l${i}` })))?.kind === 'tooMany'
    && vl.valueLabelProblem(L) === null);
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-valueLabels.js` → tsc "has no exported member 'applyValueLabels'".
- [ ] **Step 3: Implement** — the signatures above; no Node import in `valueLabels.ts`. Then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-valueLabels.js`, `node scripts/test-i18n.js`, `node scripts/test-vizData.js` (unchanged).
- [ ] **Step 5: Commit** — `git add src/analysis/valueLabels.ts src/analysis/valueLabelMessages.ts src/analysis/vizData.ts src/i18n/*.json scripts/i18n-extract.ts scripts/test-valueLabels.ts` · "Decide which value labels a chart reply carries"

### Task 2: Saving labels, and who may read the list

**Files:** Modify `src/api/catalog.ts:13-20` (`ColumnPatch.values`), `src/app/catalog.ts:328,365-375` (`ColumnPatch.values`; `setColumn` validates and stores), `src/ipc/catalog.ts:33-45` (text-only check; `catalog:columns` strips `values` for a closed caller), `src/ipc/liveDatasets.ts:170-181` (`copyColumnNotes` copies `values`), `scripts/rowPolicyReaders.ts` (`'catalog:columns': 'REDACT'`), `scripts/test-rowPolicySafetyNet.ts`. Test: extend `scripts/test-valueLabels.ts`, `scripts/test-liveCopy.ts`.
**Interfaces:** Consumes `valueLabelProblem`, the four refusal sentences, `closedToCaller` (`src/data/rowAccess.ts:268`). Produces contract field `values: z.array(z.strictObject({ value: z.string().min(1).max(256), label: z.string().max(120) })).max(500).optional()` (replaces the list; `[]` removes it); `setColumn` THROWS the problem's sentence and saves nothing of the patch, as it does for "Also called".

- [ ] **Step 1: Write the failing test** — §2 over the `scripts/test-qualityRun.ts` harness (`handlers`, `call`), Orders with `region` text and `amount` number:
  `catalog:setColumn { column: 'region', patch: { values: L } }` → `{ ok: true, column.values: L }`; with `{ value: 'EUR', label: 'Europe' }` added → `{ ok: false, error: '“Europe” would name both “EU” and “EUR”. A label can name one value only.' }` and `catalog:columns` still holds the two; `column: 'amount'` → `'Value labels are for text columns. amount is a number column.'`; a label `'  Europe  '` stores `'Europe'`, a value `'EU '` stores `'EU '`; a later `{ description: 'x' }` patch keeps the list. `test-liveCopy.ts`: "Make a copy" of a Live dataset carries the labels. `test-rowPolicySafetyNet.ts`: `boss` labels Orders' `customer` with `{ value: `${H.W_CANARY}_3`, label: 'West three' }` and `{ value: 'c1', label: 'Customer one' }`; east's `catalog:columns` reply passes `!H.leaks(text) && !text.includes('Customer one')` and the editor's has both (NEGATIVE CONTROL); east's `visual:data` by `customer` carries `["c1","Customer one"]` and no West label; every east reply joins the existing "nothing leaks" sweep.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-valueLabels.js` → zod refuses `values` (`FAIL setColumn stores value labels`).
- [ ] **Step 3: Implement** — the handler reads `getDatasetMeta` when `patch.values !== undefined` and refuses a column whose declared type is not `text` before calling `setColumn`; `setColumn` runs the patch through `sanitizeValueLabels`'s field rules (but REFUSES, via `valueLabelProblem` on the raw list, what the reader would silently drop).
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-valueLabels.js`, `node scripts/test-catalog.js`, `node scripts/test-columnNames.js`, `node scripts/test-liveCopy.js`, `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js`, `node scripts/check-contracts.js`.
- [ ] **Step 5: Commit** — `git add src/api/catalog.ts src/app/catalog.ts src/ipc/catalog.ts src/ipc/liveDatasets.ts scripts/rowPolicyReaders.ts scripts/test-rowPolicySafetyNet.ts scripts/test-valueLabels.ts scripts/test-liveCopy.ts` · "Save a text column's value labels, refusing any that would merge two values"

### Task 3: Chart replies, answer cards and captions carry the labels

**Files:** Create `src/ipc/valueLabelReplies.ts`. Modify `src/ipc/visuals.ts:648` (the `vizData` handler's `reply`), `src/ipc/vizSample.ts:40` (`visual:preview`), `src/ipc/answers.ts:178-181` (`computeCard`, before `tileCaption`), `src/ipc/liveAnswers.ts:183-184`, `src/analysis/captions.ts:~157` (`familyCaption` reads the data through `shownChart`). Test: extend `scripts/test-valueLabels.ts`, `scripts/test-captions.ts`.
**Interfaces:** Consumes `applyValueLabels`, `shownChart`, `labelNotShown`, `catalog.getColumns`, `datasets.getDatasetMeta`, `OTHER_NOTE` (`categoryKey.ts:39`). Produces
- `labelListsFor(projectId: string, datasetId: string, encoding: VizEncoding): Promise<{ category?: ValueLabel[]; series?: ValueLabel[] }>` — the category's doc from `encoding.categoryDatasetId || datasetId`, the split's from `encoding.seriesDatasetId || datasetId`; only a column declared `text`; nothing for `encoding.geo`, `pivot`, `cohort`, `eventFunnel`. One catalog read; a meta read only for a column that has labels.
- `withValueLabels<R extends VizDataReply>(projectId, datasetId, encoding, reply: R): Promise<R>` — `ok:false` passes through; `otherBucket` when `reply.category?.note === OTHER_NOTE`; each dropped label adds `labelNotShown(label, column)` to `warnings`.
- `labelCardData(projectId, datasetId, encoding, data: ChartData, category?: CategoryInfo): Promise<ChartData & { valueLabels?: ValueLabelPairs }>`.

- [ ] **Step 1: Write the failing test** — §3: `visual:data` on Orders by `region` (labels `EU`, `NA` set) returns raw `data.labels` and `data.valueLabels.category` `[["EU","Europe"],["NA","North America"]]`; the same chart with `encoding.geo` set, or as a pivot, has no `valueLabels`; split by `region` → `valueLabels.series`; a chart on a project without labels is `Object.is`-equal, key by key, to its reply before this task (golden: `JSON.stringify` of the reply matches a reply built with `labelListsFor` stubbed empty); a row `region = 'Europe'` added → the pair for `EU` is gone and `warnings` holds `“Europe” is also a value of region, so its labelled value shows as stored.`; with the project's Share policy masking `region` (`share: 'export'`), the reply has no `valueLabels` and its text holds neither `EU` nor `Europe`; `answer:card` by region → its caption says `Europe`, not `EU`; `test-captions.ts`: `tileCaption({ chartType: 'column', data: { labels: ['EU', 'NA'], series: [{ name: 'sum of amount', values: [5, 3] }], valueLabels: { category: [['EU', 'Europe']] } } })` leads with `Europe`.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-valueLabels.js` → `FAIL visual:data carries the category's labels`.
- [ ] **Step 3: Implement** — in the handler: `const reply = await withValueLabels(projectId, datasetId, enc, withFigures(…))` — after the Share policy, analytics, events and figures, before `stampAsOf`. In `familyCaption`: `const data = shownChart(family === 'calendar' ? input.data : monthNamed(input.data))` (guarded for a null `data`).
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-valueLabels.js`, `node scripts/test-captions.js`, `node scripts/test-vizData.js`, `node scripts/test-liveRoute.js`, `node scripts/test-liveRouteAnswers.js`, `node scripts/test-asyncReach.js`.
- [ ] **Step 5: Commit** — `git add src/ipc/valueLabelReplies.ts src/ipc/visuals.ts src/ipc/vizSample.ts src/ipc/answers.ts src/ipc/liveAnswers.ts src/analysis/captions.ts scripts/test-valueLabels.ts scripts/test-captions.ts` · "Send each chart's value labels beside its raw labels, and caption with them"

### Task 4: Published pages, stories and embeds

**Files:** Modify `src/publish/dashboardData.ts:176-203` (`chartPayload` draws `shownChart` AFTER `outgoing`), `:236-265` (`controlSpec`: option text through `shownText`, states keep raw), `:458` (label the reply before `chartPayload`), `src/publish/storyData.ts:71-72`. Add `labelPairsForValues` to `src/ipc/valueLabelReplies.ts`. Test: extend `scripts/test-valueLabels.ts`.
**Interfaces:** Produces `labelPairsForValues(projectId: string, datasetId: string, column: string, values: readonly string[]): Promise<[string, string][] | undefined>`. The page payload carries labels as text and never `valueLabels`; `sanitizeBundle` is unchanged.

- [ ] **Step 1: Write the failing test** — §4: a dashboard with a `region` bar card and a `region` dropdown control. `planDashboard(P, A, 50)`: `specs[0].domain.options` is `['All', 'Europe', 'APAC', 'North America']` (data order) and `JSON.stringify(specs[0].states[1]) === '{"value":"EU"}'` — the label shows, the raw value filters; `buildDashboard(P, A, 4)`: its JSON includes `"Europe"`, and `!JSON.stringify(built).includes('valueLabels')`; a chart click on `/p/` selects the control option by label text, so both sides say `Europe` (`PublishedControl.column` matching); an embed locked to `region = EU` (`test-embedLock` lock shape) offers `['All', 'Europe']`.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-valueLabels.js` → `FAIL /p/: the control option shows the label`.
- [ ] **Step 3: Implement** — `shown = shownText(shown, await labelPairsForValues(projectId, control.datasetId, control.column, values))` after the `outgoing` branch, under the lock and off it alike.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-valueLabels.js`, `node scripts/test-publishSite.js`, `node scripts/test-publishCombos.js`, `node scripts/test-embedLock.js`, `node scripts/test-chartShapes.js`.
- [ ] **Step 5: Commit** — `git add src/publish/dashboardData.ts src/publish/storyData.ts src/ipc/valueLabelReplies.ts scripts/test-valueLabels.ts` · "Show value labels on published pages, stories and embeds"

### Task 5: Filter value pickers show labels and find by them

**Files:** Modify `src/ipc/datasets.ts:474-494` (`dataset:distinct` through `distinctWithLabels`), `src/ipc/distinctFor.ts:18` (append `req.filters` after the lock, never replace it). Add `distinctWithLabels` to `src/ipc/valueLabelReplies.ts`. Test: extend `scripts/test-valueLabels.ts`; `scripts/test-liveSafetyNet.ts` stays green.
**Interfaces:** Produces `distinctWithLabels(projectId, datasetId, column, req: DistinctRequest, read: (r: DistinctRequest) => Promise<DistinctResult | LiveValuesRefusal | null>): Promise<…same | (DistinctResult & { valueLabels?: [string, string][] })>` — with a search, the raw values whose label contains it (case-insensitive) are asked again through `read` as one `in` filter (Live: the profile list filtered in JS) and appended after the raw matches, capped at `limit`; pairs for the values returned only.

- [ ] **Step 1: Write the failing test** — §5: `dataset:distinct { column: 'region' }` → `values` raw, `valueLabels` `[["EU","Europe"],["NA","North America"]]`; `search: 'euro'` → `values` includes `EU`; `search: 'ap'` → `['APAC']` and no `valueLabels`; under a row lock to `region = NA` (a `withLockOf` world as in `test-rowPolicy.ts`), `search: 'euro'` returns no value and no pair; an unlabelled column's reply is `Object.is`-equal to today's.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-valueLabels.js` → `FAIL picker: the search finds a value by its label`.
- [ ] **Step 3: Implement** — the handler's two branches (`liveDistinct`, `distinctFor`) become the `read` callback; the Live-refusal and row-policy rethrows stay as they are.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-valueLabels.js`, `node scripts/test-liveSafetyNet.js`, `node scripts/test-liveProfile.js`, `DATABASE_URL=… node scripts/test-rowPolicy.js`.
- [ ] **Step 5: Commit** — `git add src/ipc/datasets.ts src/ipc/distinctFor.ts src/ipc/valueLabelReplies.ts scripts/test-valueLabels.ts` · "Let a filter picker show value labels and find a value by its label"

### Task 6: The Assistant's facts and MCP

**Files:** Modify `src/ai/columnNotes.ts:10,33-47` (`FactColumnDoc.values?`; `columnNoteLines` prints codes), `src/analysis/planFacts.ts:89-93` (capped copy keeps `values`), `src/app/sharePolicy.ts:129-138` (`assistantColumnDocs` drops `values` when `closedToCaller`), `src/automation/handlers.ts:109` (`describe_dataset` columns get `valueLabels` unless `closedToCaller`). Test: extend `scripts/test-copilot.ts`, `scripts/test-planFacts.ts`, `scripts/test-automationTools.ts`.
**Interfaces:** Produces `export const VALUE_LABEL_FACT_MAX = 20`; a column note bit `codes "EU" = Europe, "NA" = North America` (then `(+N more)`), left out for a column marked personal or financial. MCP `describe_dataset.columns[i].valueLabels?: ValueLabel[]`.

- [ ] **Step 1: Write the failing test** — `test-copilot.ts`: `datasetFacts(…, { region: { values: L } })` contains `- region: codes "EU" = Europe, "NA" = North America`; 25 labels print 20 then `(+5 more)`; `sensitivity: 'personal'` prints no codes; a column without labels prints exactly today's line (`Object.is`). `test-planFacts.ts`: `buildFactsText(ctx, '', { columnDocs: { [D]: { region: { values: L } } } })` carries the same bit inside `USER_BLOCK_MAX`. `test-automationTools.ts`: `describe_dataset` → `columns.find((c) => c.name === 'region').valueLabels` deep-equals `L`.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-copilot.js` → `FAIL facts: value labels as codes`.
- [ ] **Step 3: Implement** — values are user text: each value and label through planFacts' `note()` rule (one line) before printing.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-copilot.js`, `node scripts/test-planFacts.js`, `node scripts/test-automationTools.js`, `node scripts/test-numberAudit.js`, `node scripts/test-liveProfile.js`.
- [ ] **Step 5: Commit** — `git add src/ai/columnNotes.ts src/analysis/planFacts.ts src/app/sharePolicy.ts src/automation/handlers.ts scripts/test-copilot.ts scripts/test-planFacts.ts scripts/test-automationTools.ts` · "Tell the Assistant and MCP what a column's codes mean"

### Task 7: The chart engine draws labels; every click still sends the raw value

**Files:** Modify `web/src/charts/types.ts:40-53` (`ChartDataShape.valueLabels?`), `web/src/charts/build.ts:126` (word-cloud return), `:146-170` (`label_asc`/`label_desc` compare shown text), `:206` (after `fmtResolve`: `labels = shownText(labels, data.valueLabels?.category)`, series names likewise — colours, custom order and `hiddenSeries` already resolved on raw), `web/src/charts/Chart.tsx:154`, `web/src/charts/table.ts:22` (`tableModel`), `web/src/features/visuals/ChartControls.tsx:56-61` (`dataToTsv`), `web/src/features/analyses/VisualTile.tsx:58-63` (`serverLabel(labels, shown, pairs?)`), `:226-247`, `web/src/features/analytics/explain/pointAt.ts:21-41` (`pointAt(chart, e, serverLabels, pairs?)`), `web/src/features/visuals/Stage.tsx:64-70` (drill target through `rawOf`). Test: `web/src/charts/valueLabels.test.ts`.
**Interfaces:** Consumes `shownText`, `rawOf`, `ValueLabelPairs` from `src/analysis/valueLabels.ts` (imported as `../../../src/analysis/valueLabels.ts`, like `figureAsk`).

- [ ] **Step 1: Write the failing test** — `valueLabels.test.ts` (the canvas stub of `web/src/charts/fmt.test.ts:21`): `buildChart(canvasStub(), { labels: ['EU', 'NA'], series: [{ name: 'sum', values: [2, 1] }], valueLabels: { category: [['EU', 'Europe']] } }, 'column')` (kind `chartjs`) has `config.data.labels` `['Europe', 'NA']`; with `{ sort: 'custom', sortOrder: ['NA', 'EU'] }` it is `['NA', 'Europe']` (the stored order is raw); `serverLabel(['EU', 'NA'], 'Europe', [['EU', 'Europe']]) === 'EU'`; `pointAt` on a hit drawn as `Europe` returns `{ bucket: 'EU' }`, and a split drawn as `Europe` returns `series: 'EU'`; `tableModel(...)` rows read `Europe`; `dataToTsv(...)` second line starts `Europe\t`; with no `valueLabels` every output equals today's, and every `web/src/**/__golden__` test passes unchanged.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- valueLabels` → `expected [ 'EU', 'NA' ] to deeply equal [ 'Europe', 'NA' ]`.
- [ ] **Step 3: Implement** — month formatting first, then `shownText`; never a label in a stored override, a filter step, a drill mark or an annotation.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm --prefix web run size` (≤ 300 KB), `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/charts/types.ts web/src/charts/build.ts web/src/charts/Chart.tsx web/src/charts/table.ts web/src/features/visuals/ChartControls.tsx web/src/features/analyses/VisualTile.tsx web/src/features/analytics/explain/pointAt.ts web/src/features/visuals/Stage.tsx web/src/charts/valueLabels.test.ts` · "Draw value labels on charts while clicks filter by the stored value"

### Task 8: The value labels editor, and pickers that show labels

**Files:** Create `web/src/features/data/ValueLabelsDialog.tsx`, `web/src/features/data/ValueLabelsDialog.test.tsx`. Modify `web/src/features/data/api.ts:136-145` (`ColumnDoc.values?`), `web/src/features/data/ColumnsTab.tsx` (a "Value labels" cell on text columns), `web/src/features/live/distinct.ts:26` (`DistinctValues.valueLabels?`), `web/src/features/analyses/editor/ValuePicker.tsx:~42`, `web/src/features/visuals/filters/FilterDialog.tsx:~56`, `web/src/features/dashboards/ControlsExtras.tsx:~74`, `web/e2e/data.e2e.ts`.
**Interfaces:** Consumes `catalog:setColumn { values }`, `dataset:distinct` (`limit: 500` for "Fill from the data"), `shownText`. Produces `<ValueLabelsDialog projectId datasetId column values readOnly />`.

- [ ] **Step 1: Write the failing test** — `ValueLabelsDialog.test.tsx`: a text column's cell reads `Add labels`, or `2 labels` once set; the dialog lists value / label rows, `Fill from the data` adds one row per distinct value not yet listed, `Save` sends `catalog:setColumn` with `{ values: [{ value: 'EU', label: 'Europe' }] }` (rows with an empty label left out), the server's refusal sentence shows in the dialog and keeps the rows; a number column has no cell; a viewer reads the list with no controls; a Live column with no profile shows the server's sentence for `Fill from the data`. Picker tests (existing files' style): an option reads `Europe` and picking it sends `value: 'EU'`. `data.e2e.ts`: label `region` on the sample dataset, reopen the tab and see `2 labels`; screenshots in both themes; RPC budget unchanged.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- ValueLabelsDialog` → "Cannot find module './ValueLabelsDialog'".
- [ ] **Step 3: Implement** — `useWrite('catalog:setColumn', ['catalog:columns', 'visual:data', 'visual:dataBatch', 'dataset:distinct'], { quiet: true })`; designed empty ("No labels yet — fill them from the data or add one"), loading and error states.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm --prefix web run e2e -- data`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/data/ValueLabelsDialog.tsx web/src/features/data/ValueLabelsDialog.test.tsx web/src/features/data/api.ts web/src/features/data/ColumnsTab.tsx web/src/features/live/distinct.ts web/src/features/analyses/editor/ValuePicker.tsx web/src/features/visuals/filters/FilterDialog.tsx web/src/features/dashboards/ControlsExtras.tsx web/e2e/data.e2e.ts` · "Edit a column's value labels, and show them in filter pickers"

## Existing tests that must stay green

`test-catalog`, `test-columnNames`, `test-vizData`, `test-vizCategory`, `test-viz-filter`, `test-captions`, `test-chartShapes`, `test-publishSite`, `test-publishCombos`, `test-publishMemo`, `test-embedLock`, `test-liveRoute`, `test-liveRouteAnswers`, `test-liveSafetyNet`, `test-liveProfile`, `test-liveCopy`, `test-rowPolicy`, `test-rowPolicySafetyNet`, `test-rowPolicyLabels`, `test-copilot`, `test-planFacts`, `test-automationTools`, `test-numberAudit`, `test-asyncReach`, `test-i18n`, `test-file-size`, `check-contracts`; web `data.test.tsx`, chart and dashboard Vitest suites, `data.e2e.ts`, `charts.e2e.ts`, every `__golden__` fixture (never re-recorded).
