# Semantic layer part 7, step b3: semantic layers in the web app — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People see and use a company's semantic layer: under **Connections** a layer connection lists its models with **Add as dataset**; on a semantic dataset the measure picker offers the layer's metrics ("Defined in Snowflake: edit it there", "can be added up"), the date picker offers the layer's grains, the Data model marks mirrors, and what a layer cannot draw says so where the figure would be.
**Architecture:** Two small server additions give the browser what it needs without an origin: `semantic: { layer }` on a dataset's list entry and header, and `grains` on the Live schema reply. The rest is web: the picker, the metric editor's read-only state, the Data model Metrics tab badges, the Connections models list, and the Live "off" screens naming the layer. Mockups first.
**Tech Stack:** React 19, TanStack Query, CSS Modules (`web/src/theme.css` tokens), Vitest, Playwright; a few lines in `src/ipc`.
**Spec:** docs/semantic-layer/07-portability.md ("What you will see", D11, D13, D14, D16) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-b3-semantic-web` off `origin/develop` after b2 merges. One PR. Release 2.

## Global Constraints

- **Mockups first** (house rule, `docs/semantic-layer` mockups folder): the measure picker on a semantic dataset, the metric editor of a mirror, the Data model Metrics tab with mirrors, the Connections models list, and a refused chart. Light and dark. The owner says yes before Task 3.
- **No origin reaches a browser.** The dataset carries `semantic: { layer }` (the backend id) only, never the model, view, environment or URL. The models list is shown only inside a connection's own page, where the caller already holds `write` (the listing contract's access).
- **The UI never derives a figure** and never decides additivity: "can be added up" reads `metric:table`'s `additivity` (part 1 step 10), which b2 derives from the layer.
- **The picker writes what b2 reads:** a measure `{ column: '', aggregation: 'sum', metricId }` for a mirror. On a semantic dataset there are no column measures and no "Auto" grain; a date axis defaults to the layer's `month` if listed, else its first grain.
- **Mirrors are read-only here:** the metric editor shows the definition and filters as text with "Defined in {Layer}: edit it there.", and never sends `definition` or `filters` for a mirror; format, name, description and direction stay editable.
- "Make a copy" / "Copy the data instead" are hidden on a semantic dataset (`web/src/features/live/offFeatures.ts`), and the "off" screens (`LiveOff.tsx`) say "{Dataset} comes from {Layer}, which returns totals, not rows."
- Every list and panel: designed empty, loading (skeleton) and error state, both themes. Page headers keep one primary. Initial JS ≤ 300 KB gzip; RPC budget 25 per page load.
- Layer names shown to people: Snowflake, Cube, dbt (the product's own spelling).
- No dependency, no migration. One small server change, no new contract.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **An old browser tab** on a semantic dataset: the server refuses its column measures (`columnOnLayer`) with a sentence; nothing breaks silently. Task 3's test with a pre-b3 encoding.
- **No model name in the DOM** of any screen outside the connection's page. Task 5 (e2e grep).
- **The editor does not erase a mirror.** Saving a mirror's format sends no `definition`. Task 3.

---

### Task 1: What the browser needs, from the server
**Files:** Modify `src/data/datasets.ts` (`DatasetSummary`/meta header: `semantic?: { layer }`; ≤ 1 line: the file is at 799 and `test-file-size` fails above 800, so the projection goes in `src/data/semanticDataset.ts` and is spread in; if the type needs a second line, put the field on the reply at `src/ipc/datasets.ts` instead), `src/ipc/liveProfile.ts:168` (`LiveSchemaView.grains?: Array<{ column; grains }>`) · Test `scripts/test-semanticDatasets.ts` (§ replies)
- [ ] **Step 1: Write the failing test.** `dataset:list` and `dataset:liveSchema` for the semantic dataset carry `semantic: { layer: 'fake' }` and the grains; `JSON.stringify` of both has no model name (planted) and no connection value; an extract's and a plain Live dataset's replies are byte-identical to before (no `semantic` key).
- [ ] **Step 2–4:** red → implement → `node scripts/test-semanticDatasets.js && node scripts/test-file-size.js` green.
- [ ] **Step 5: Commit.** `git add src/data src/ipc/liveProfile.ts scripts/test-semanticDatasets.ts` · "Tell the browser a dataset comes from a semantic layer, and its grains"

### Task 2: Mockups
**Files:** Create `docs/semantic-layer/mockups/p7-semantic-*.png` (light and dark)
- [ ] **Step 1:** Draw the five screens in Global Constraints with real states, including the picker's empty state ("Sales has no metrics yet. Sync it after adding them in Snowflake.") and a `metricMissing` tile.
- [ ] **Step 2:** The owner approves; record it in the PR description.

### Task 3: The measure picker, the grain picker and the metric editor
**Files:** Modify `web/src/features/visuals/EncodingForm.tsx` (307 lines: the semantic branch goes in a new `SemanticMeasures.tsx`), `web/src/features/analyses/metrics/MetricEditor.tsx` (297) · Create `web/src/features/visuals/SemanticMeasures.tsx`, `web/src/features/visuals/semanticMeasures.test.tsx`, `web/src/features/analyses/metrics/mirror.test.tsx`
**Interfaces:** Produces `SemanticMeasures({ projectId, datasetId, layer, value, onChange })`: a list headed "METRICS FROM {LAYER} · {dataset}", one row per mirror with its name, "can be added up" / "can't be added up" and "Defined in {Layer}: edit it there" in its tooltip.
- [ ] **Step 1: Write the failing test.** On a dataset with `semantic`, the picker lists only mirrors (no columns), and picking one calls `onChange` with `{ column: '', aggregation: 'sum', metricId }`; the grain select offers exactly the schema's grains, no "Auto", defaulting to `month`; on an extract the picker is unchanged (snapshot of the existing test); the mirror's editor shows the definition as text with the sentence, and Save after a format change sends a patch without `definition` or `filters`.
- [ ] **Step 2–4:** red → implement → `npm run test:web -- semanticMeasures mirror && npm run lint` green.
- [ ] **Step 5: Commit.** `git add web/src/features/visuals web/src/features/analyses/metrics` · "Pick a semantic layer's metrics and grains, and keep its definitions read-only"

### Task 4: Data model badges, Connections models, and the off screens
**Files:** Modify `web/src/features/model/metrics/MetricsTab.tsx` (part 1 step 10), `web/src/features/connections/SchemaTree.tsx` (175) or `WorkbenchPage.tsx` (350: the list goes in a new `SemanticModels.tsx`), `web/src/features/connections/api.ts`, `web/src/features/live/LiveOff.tsx`, `web/src/features/live/offFeatures.ts` · Create `web/src/features/connections/SemanticModels.tsx`, `semanticModels.test.tsx`, `web/src/features/live/semanticOff.test.tsx`
**Interfaces:** Consumes `connection:semanticModels`, `connection:addSemanticDataset`, the catalog's `semantic` flag. Produces `SemanticModels({ projectId, connId, layer })`: the models with their description and **Add as dataset** (name prefilled, editable), a skeleton, an empty state ("No semantic views in this database yet." for Snowflake, "No models in this deployment yet." otherwise) and an error state with Retry.
- [ ] **Step 1: Write the failing test.** A Snowflake connection's tree shows "Semantic views" beside its tables; a Cube or dbt connection shows models only; Add as dataset sends `{ projectId, connId, model, name }` and opens the new dataset; the Metrics tab marks each mirror "Defined in Snowflake" with no definition text and a "Missing in Snowflake" badge for a mirror the sync no longer finds; on a semantic dataset the off screen says the layer sentence and has no Make a copy button; on a plain Live dataset it does (negative control).
- [ ] **Step 2–4:** red → implement → `npm run test:web && npm run build:web && npm --prefix web run size && npm run lint` green.
- [ ] **Step 5: Commit.** `git add web/src/features` · "Show a semantic layer's models under Connections and mark its metrics in the Data model"

### Task 5: End to end
**Files:** Modify `src/server/main.ts` (under `ORDINATE_TEST_LIVE_FAKE=1` only: also register b1's `semantic-fake` connector and its adapter, as the Live fake is), `web/e2e/seed.ts` (a fake layer connection), `web/e2e/connections.e2e.ts`, `web/e2e/live.e2e.ts`
- [ ] **Step 1: Write the checks.** Connections: open the fake layer connection, see its models, Add as dataset. Live: on the new dataset, build a column chart from a mirror at month grain and see bars; pick a pivot and see the layer's refusal sentence where the chart would be; the page's DOM never contains the planted model name. Screens light and dark, within the RPC budget.
- [ ] **Step 2: Run them.** `npm run build:web && npm --prefix web run e2e -- connections live` → green; look at the screens.
- [ ] **Step 3: Commit.** `git add src/server/main.ts web/e2e` · "Walk a semantic layer from Connections to a chart end to end"

**Before the PR:** `npm test`, `npm run test:web`, `npm run lint`, `npm --prefix web run size`.
