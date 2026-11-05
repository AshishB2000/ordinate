# Semantic layer part 8, step 08: lineage in the Data model section — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before changing a column, a person sees what moves.
- The Data model's Lineage tab traces one column ("Trace a column: [amount ▾]").
- The Fields tab says what uses each field.
- Removing a Prepare step that makes a column, or a Live calculated field, asks first and names what it feeds: `Delete "Margin"? It feeds 1 metric, 3 charts.`

Every count comes from the server.
**Architecture:**
- The web reads step 01's two channels: `lineage:column` for the traced graph, and `lineage:fields` once per dataset for the "Used by" cells and the delete confirmations.
- The existing `LineageView` (part 1 step 10, `web/src/features/data/LineageDrawer.tsx`) draws either graph.
- `ConfirmDelete` (`web/src/ui/ConfirmDelete.tsx`) asks.
- No server change.
**Tech Stack:** React 19, TanStack Query, CSS Modules, Vitest, Playwright; `web/src/features/model/` (part 1 step 10), `web/src/features/prepare/`, `web/src/features/data/`.
**Spec:** docs/semantic-layer/08-engine.md (D21, the "What you will see" lineage block) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p8-00-index.md
**Branch and PR:** `feat/semantic-p8-08-lineage-ui` off `origin/develop`, after steps 01 and 04 and part 1's step 10 merge. One PR.

## Global Constraints
- **The UI never derives a count.** "Used by" and "It feeds" come from `lineage:fields`, formatted with `formatNumber`. A step's own `usedIn` is the server's (step 01). The web does not add up columns.
- **No confirmation when nothing is fed.** A step whose `usedIn` is empty removes at once, as today (`StepList.tsx:52`). The confirmation is only for a step that feeds something. So one click stays one click for most steps, and `prepare.test.tsx` keeps passing unchanged.
- **RPC budget 25 per page load** (`rpcBudget`). The Fields tab adds one `lineage:fields`. The Lineage tab adds `lineage:column` only once a column is picked. Prepare adds one `lineage:fields`.
- **States:** a skeleton while loading, `ErrorState` with Retry, and designed empty states, in both themes, from `web/src/theme.css` tokens only.
  - A failing `lineage:fields` (an old pod: 404) leaves the Fields tab readable, with "Used by" reading "—".
  - With `lineage:fields` failing, delete removes without asking. That is today's behaviour, never a block.
- **A Live dataset's panel calls no row channel** (`.claude/rules/live-data.md`). Both lineage channels read records only.
- File caps: `LineageDrawer.tsx` 202, `StepList.tsx` 59, `PreparePage.tsx` 282, `ColumnsTab.tsx` 211: small edits. New components go in new files.

## Old pods (rolling deploy and rollback)
No stored field. A new browser on an old pod gets 404 from both channels: the traced graph shows its `ErrorState` with Retry, "Used by" reads "—", and removes don't ask. An old browser on a new pod has none of this UI.

## Review Focus
- A rename step (`amt` → `amount`) "makes" `amount`. Removing it breaks what reads `amount`, so it asks. → Task 3
- A Live calc that another calc reads (`Margin %` reads `Margin`): deleting `Margin` names the calc too ("1 calculated field"). → Task 3
- The traced graph must not show a source's table, path or URL: step 01's `redactSources` covers the reply; the web adds nothing. → Task 1

---

### Task 1: trace a column in the Lineage tab
**Files:** Create `web/src/features/model/lineage/ColumnLineage.tsx` and `web/src/features/model/lineage/columnLineage.test.tsx`. Modify:
- `web/src/features/data/LineageDrawer.tsx`: `KIND` (:24-37) gains `column` (icon `columns`) and `term` (icon `list`); `LineageView` takes an optional `graph` (an already-fetched reply).
- `web/src/features/model/datasets/DatasetPanel.tsx` (part 1 step 10): the Lineage tab renders `ColumnLineage`.
- `web/src/features/model/api.ts`: `useColumnLineage` and `useLineageFields`.

**Interfaces:**
```ts
export function useColumnLineage(projectId: string, datasetId: string, column: string | null); // key ['lineage:column', projectId, datasetId, column]; skipToken when null
export function useLineageFields(projectId: string, datasetId: string);                         // key ['lineage:fields', projectId, datasetId]
export function usedByText(usedIn: Partial<Record<string, number>>): string; // "Used by 2 metrics · 6 visuals · 1 term"; '' when empty
export function ColumnLineage({ projectId, datasetId, columns }: { projectId: string; datasetId: string; columns: { name: string }[] }): JSX.Element;
```
- `ColumnLineage` has a `Select` labelled "Trace a column", whose options are the dataset's columns, calcs included.
- With no column picked, it draws today's dataset graph, `<LineageView projectId id={datasetId} />`, unchanged.
- With one picked, it draws that column's graph from `lineage:column`, and the line `usedByText(reply.usedIn)` under it.
- The pick lives in `?column=`. A column nothing reads (the reply is `null`) shows the empty state "Nothing reads “<column>” yet."
- [ ] **Step 1: Write the failing test.**
  - Picking `amount` calls `lineage:column` with `{ projectId, datasetId, column: 'amount' }`, and the graph shows the nodes "Margin" (Calculated field), "Margin %" and "Revenue".
  - The line reads "Used by 2 metrics · 4 visuals · 2 dashboards".
  - `?column=amount` restores the pick.
  - A `null` reply shows "Nothing reads “amount” yet."
  - A 404 shows "The lineage could not be loaded", and Retry calls it again.
  - NEGATIVE CONTROL: with no column picked, no `lineage:column` call is made.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- columnLineage` → the module is not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `npm run test:web -- columnLineage panel model && npm run lint`.
- [ ] **Step 5: Commit.** `git add web/src/features/model web/src/features/data/LineageDrawer.tsx` · "Trace one column in the Data model's Lineage tab"

### Task 2: "Used by" on every field
**Files:** Modify `web/src/features/model/datasets/FieldsPanel.tsx` (part 1 step 10) and `web/src/features/data/ColumnsTab.tsx` (:126, an optional `usedBy?: Record<string, string>` prop drawn as a "Used by" column; absent means no column, so the Data page's Columns tab is unchanged). Test: `web/src/features/model/panel.test.tsx` (extend).
**Interfaces:** `FieldsPanel` reads `useLineageFields` and passes `usedBy[name] = usedByText(fields[name].usedIn)`. A field absent from `fields` reads "Not used yet". A failed or pending read reads "—". The "Calculated in Prepare" list (part 1 step 10) and step 04's Live calcs get the same cell.
- [ ] **Step 1: Write the failing test.**
  - `amount` reads "Used by 2 metrics · 6 visuals".
  - `region` (absent) reads "Not used yet".
  - A 404 reads "—" in every row, and the column notes stay editable (negative control: the tab stays readable).
  - The Data page's Columns tab has no "Used by" header.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- panel` → no "Used by" header.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `npm run test:web -- panel data AboutTab && npm run lint`.
- [ ] **Step 5: Commit.** `git add web/src/features/model web/src/features/data/ColumnsTab.tsx` · "Say what uses each field in the Data model"

### Task 3: ask before removing what something reads
**Files:** Create `web/src/features/prepare/RemoveStepConfirm.tsx`. Modify:
- `web/src/features/prepare/PreparePage.tsx` (:193): `onRemove` asks first when the step feeds something.
- `web/src/features/data/CalculatedFieldsPanel.tsx` (step 04): Delete asks the same way.
- `web/src/features/prepare/prepare.test.tsx` and `web/src/features/data/calculatedFields.test.tsx`.

**Interfaces:**
```ts
export function feedsText(usedIn: Partial<Record<string, number>>): string; // "1 metric, 3 charts" (visual → chart, as the mock says); '' when empty
export function RemoveStepConfirm({ name, usedIn, onConfirm, onClose }: { name: string; usedIn: Partial<Record<string, number>>; onConfirm: () => void; onClose: () => void }): JSX.Element;
```
- `RemoveStepConfirm` is `<ConfirmDelete title={`Delete “${name}”?`} description={`It feeds ${feedsText(usedIn)}. They will show an error until it is put back or they are changed.`} confirm="Delete" />`. It is undoable from the pipeline (a removed step recomputes from source), so there is no `typeToConfirm`.
- For a Prepare step, `name` is the step's first produced column (`lineage:fields.steps[i].produces[0]`) and `usedIn` is that step's own. For a Live calc, `name` is the calc's and `usedIn` is `fields[name].usedIn`.
- [ ] **Step 1: Write the failing test.**
  - Removing step 2 (`calculated_field` "Margin", whose `usedIn` is `{ metric: 1, visual: 3 }`) shows "Delete “Margin”?" and "It feeds 1 metric, 3 charts." `dataset:removeStep` is sent only after Delete is pressed.
  - Removing a rename step that feeds something asks too.
  - Removing a filter step (no `produces`) sends `dataset:removeStep` at once. This is the negative control: no dialog.
  - With `lineage:fields` answering 404, every remove is immediate.
  - On a Live dataset, deleting `Margin`, which `Margin %` reads, says "1 calculated field" among what it feeds, and on Delete sends `live:setCalculated` without `Margin`.
  - e2e (`web/e2e/model.e2e.ts`, part 1 step 10's file):
    - trace `Retail orders.amount`, then `screens(page, 'model-lineage-column')`;
    - open Prepare, add `Margin = [sales] - [cost]` and a metric `sum(Margin)`, remove the step, see "It feeds 1 metric", cancel, then `screens(page, 'prepare-remove-confirm')`;
    - the RPC budget stays ≤ 25.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- prepare calculatedFields` → the step is removed with no dialog.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run e2e -- model prepare && npm --prefix web run size && npm run lint` → green, light and dark screens written, initial JS ≤ 300 KB.
- [ ] **Step 5: Commit.** `git add web/src/features/prepare web/src/features/data/CalculatedFieldsPanel.tsx web/src/features/data/calculatedFields.test.tsx web/e2e/model.e2e.ts` · "Ask before removing a step or a Live calculated field that something reads, and say what"

**Existing tests that must stay green:** web model.test.tsx, panel.test.tsx, prepare.test.tsx, pipelines.test.tsx, calculatedFields.test.tsx, data.test.tsx, AboutTab.test.tsx, doors.test.tsx, viewer.test.tsx; e2e model, prepare, data, live, view-only-routes; server test-lineageColumns, test-lineage (no server change).

**Not in this step:** confirmations for renaming or dropping a column in the Columns tab (`updateDataset` makes a `rename_column` step: a follow-up); lineage inside SQL datasets (D20) or source tables (part 2).
