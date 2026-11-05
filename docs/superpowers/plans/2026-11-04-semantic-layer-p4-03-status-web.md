# Semantic layer part 4, step 03: badges, picker order, captions and the admin's review in the web: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A metric, term or dataset shows its status wherever it is named. Pickers put certified items first and fold retired ones away with their replacement. A chart or KPI on a retired metric says so, and an editor can switch it. Saving a certified metric or term warns first. A project admin reviews what changed and certifies, retires or clears from the Data model section.
**Architecture:** All of it reads 02's `status` field. One pure module, `web/src/features/model/status/status.ts`, owns order, wording and the fields that move a pin. Two components draw it: `StatusBadge` and `StatusActions` (admin only). The review dialog reuses `VersionCompare` (`web/src/features/projects/VersionCompare.tsx:175`) for the diff.
**Tech Stack:** React 19, TanStack Query, `web/src/ui` (`Badge`, `Dialog`, `Button`, `Field`), Vitest, Playwright.
**Spec:** docs/semantic-layer/04-governance.md ("What you will see", D5, D7, D8) · Index: 2026-11-04-semantic-layer-p4-00-index.md
**Branch:** `feat/semantic-p4-03-status-web` off `origin/develop` after 02 merges.

## Global Constraints
- The web never computes a figure or a status. It draws `status.state` as the server sent it. The save warning (D5) is a hint whose truth lives on the server. Its field list (`PIN_FIELDS`) mirrors 01's pin tables and says so in a comment.
- Badges carry a word and an icon, never colour alone (`ui/Badge.tsx`): certified `circle-check` "Certified" (tone `ok`), needs review `alert` "Changed since certified" (tone `warn`), retired `archive` "Retired" (tone `neutral`). The `title` reads "Certified by ana@acme.com · Nov 3 · note".
- Only `useCan(projectId)('admin')` (`web/src/features/projects/api.ts:120`) shows Certify, Retire and Clear. An editor sees the badges and the save warning. A viewer sees badges only.
- RPC budget 25 per page load: status rides on lists the page already fetches. `model:review` is called only when the dialog opens. Initial JS ≤ 300 KB gzip: the dialogs are lazy (`page()` chunks or `React.lazy`).
- House polish bar: real empty and error states, both themes, tokens only.

## Review Focus
- Every picker reads one order (`pickerOrder`). The measure picker and Add KPI fold retired items. Other pickers sort them last with the badge (Task 2).
- "Switch to Net revenue" is an ordinary `visual:update` / dashboard save, offered only to editors, and never automatic (Task 3).
- A stale review (the item moved while the dialog was open) shows the server's 409 sentence and reloads the diff. It never certifies what the admin did not see (Task 4).

---

### Task 1: The status module and the badge
**Files:** Create `web/src/features/model/status/status.ts`, `StatusBadge.tsx`, `Status.module.css`, `status.test.tsx` · Modify the reply types: `web/src/features/analyses/metrics/api.ts:19` (`MetricSummary.status?`), `web/src/api/datasets.ts` (the `dataset:list` item), part 1's `web/src/features/model/terms/api.ts` (term summary), part 1's `web/src/features/model/api.ts` (`review?` on the overview)
**Interfaces:** Produces
```ts
export type StatusState = 'certified' | 'needs_review' | 'retired';
export interface StatusView { state: StatusState; by: string; at: string; note: string; versionKey?: string; replacedBy?: { ref: string; name: string } }
export const STATUS_RANK: Record<StatusState | 'none', number>;   // certified 0, none 1, needs_review 1, retired 2
export function pickerOrder<T extends { name: string; status?: StatusView }>(items: T[]): { main: T[]; retired: T[] }; // stable within a rank
export const PIN_FIELDS: { metric: readonly string[]; term: readonly string[] }; // mirrors src/analysis/statusPin.ts
export function movesPin(kind: 'metric' | 'term', patch: object): boolean;
export function StatusBadge({ status, compact }: { status?: StatusView; compact?: boolean }): JSX.Element | null;
```
- [ ] **Step 1: Write the failing test.** `expect(pickerOrder([R, N, C]).main.map(n)).toEqual(['C', 'N'])`; `expect(pickerOrder([R, N, C]).retired.map(n)).toEqual(['R'])`; `needs_review` ranks with none. `movesPin('metric', { description: 'x' })` is false and `movesPin('metric', { filters: [] })` is true. `StatusBadge` renders nothing for `undefined`, the words above for each state, and a `title` naming `by`. A retired badge with `replacedBy` reads "Retired · use Net revenue".
- [ ] **Step 2: Run it to see it fail.** `npm run test:web` fails, because the module is missing.
- [ ] **Step 3: Implement.** Use `Badge` from `ui/Badge.tsx`.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web` is green.
- [ ] **Step 5: Commit.** `git add web/src/features/model/status web/src/features/analyses/metrics/api.ts web/src/api/datasets.ts web/src/features/model` · "Draw a metric's, term's or dataset's status as a badge"

### Task 2: Pickers: certified first, retired folded
**Files:** Modify `web/src/features/visuals/EncodingForm.tsx:82` (measure picker), `web/src/features/analyses/editor/AddKpi.tsx:42`, `web/src/features/analytics/grids/MetricPicker.tsx:24`, `web/src/features/analytics/grids/PivotShelves.tsx:62`, `web/src/features/reports/stories/Choosers.tsx:98`, `web/src/features/reports/scorecards/RowsEditor.tsx:70`, part 1's term picker in `web/src/features/visuals/filters/FilterRows.tsx` ("Add term"), the dataset pickers `web/src/features/visuals/NewVisualDialog.tsx`, `web/src/features/explore/ExplorePage.tsx`, `web/src/features/assistant/ContextPicker.tsx` · Test Vitest next to each one changed (EncodingForm, AddKpi, FilterRows at least)
**Interfaces:** Consumes `pickerOrder`, `StatusBadge`. EncodingForm and AddKpi draw `main`, then a closed disclosure "Retired (n)" whose rows read "Gross revenue · use Net revenue". The other pickers draw `[...main, ...retired]`, each row with `StatusBadge compact`.
- [ ] **Step 1: Write the failing test.** EncodingForm with metrics `[Gross (retired→Net), Net (certified), Plain]` lists `Net, Plain` and then a button "Retired (1)". After clicking it, "Gross revenue · use Net revenue" shows. AddKpi does the same. FilterRows' term menu puts a certified term first. As a negative control, with no statuses the order equals today's (by name).
- [ ] **Step 2: Run it to see it fail.** `npm run test:web` fails, because Gross is first.
- [ ] **Step 3: Implement.** Make one `pickerOrder` call per picker, and put the disclosure in a shared `RetiredGroup` in `web/src/features/model/status/`.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web` is green.
- [ ] **Step 5: Commit.** `git add web/src/features` · "Put certified metrics, terms and datasets first in every picker and fold retired ones"

### Task 3: Captions on retired metrics, and "Switch to"
**Files:** Modify `web/src/features/analyses/VisualTile.tsx` (the caption area), `web/src/features/analyses/editor/MetricCard.tsx:54` (`MetricBody`), `web/src/features/explore/Answer.tsx` (answer card measures), the chart builder's measure chip in `EncodingForm.tsx` · Create `web/src/features/model/status/switchTo.ts` · Test `VisualTile.test.tsx`, `MetricCard` test, `switchTo.test.ts`
**Interfaces:** Produces
- `retiredMeasures(encoding, metrics: MetricSummary[]): Array<{ index: number; metric: MetricSummary }>` reads each `values[i].metricId` whose metric's `status.state === 'retired'`.
- `switchTo(encoding, index, replacement: MetricSummary): VizEncoding` sets the measure's `metricId`, plus `column`/`aggregation` from a simple replacement's definition (the stored copy part 1 D16 keeps). Nothing else changes.
- The tile draws as before, with the muted line "Retired metric: Gross revenue". For an editor (`useCanEdit`) a "Switch to Net revenue" button saves through the tile's existing save path (`visual:update` with the editor's `base`). A KPI card with a retired `metricId` reads the same, and its switch writes the card's `metricId`.
- [ ] **Step 1: Write the failing test.** A tile whose measure is retired renders the line and, for an editor, the button. Clicking it calls the save once with `switchTo(...)`. A viewer sees the line and no button. A tile on a certified metric renders no line, which is the negative control. `switchTo` changes only `values[index]`.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web` fails, because the line is missing.
- [ ] **Step 3: Implement.** Read `useMetricList` (already cached by every page that draws tiles: check with `grep -rn useMetricList web/src/features/analyses`). Add no new RPC per tile.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web` is green.
- [ ] **Step 5: Commit.** `git add web/src/features` · "Say when a chart or KPI uses a retired metric, and let an editor switch it"

### Task 4: Review, certify, retire, clear; and the save warning
**Files:** Create `web/src/features/model/status/StatusActions.tsx`, `ReviewDialog.tsx`, `RetireDialog.tsx`, `SaveWarning.tsx`, `api.ts` · Modify part 1's Data model section: `web/src/features/model/datasets/DatasetPanel.tsx` (Overview: badge + actions), the Metrics tab (a filter `All · Certified · Retired`, a badge column, actions in the row menu), the Glossary tab (`TermsList`: badge + actions), `web/src/features/model/datasets/TodoStrip.tsx` (draws `review` items after `todo`: "Revenue changed since certified", "Gross revenue is retired, used by 6"; a click opens the item), `web/src/features/analyses/metrics/MetricEditor.tsx` and part 1's `TermDialog.tsx` (the save warning), the Prepare page of a certified dataset (a standing banner "Certified by … — changes here need a project admin to certify it again") · Test Vitest next to each
**Interfaces:** Consumes `model:review|certify|retire|clearStatus` (01), `versions:list`/`versions:diff`, `metric:usage`, part 1's `term:usage`. Produces:
- `useStatusActions(projectId)` gives the four mutations. Each invalidates `metric:list`, `term:list`, `dataset:list`, `catalog:list`, `model:overview`.
- `ReviewDialog({ projectId, ref, name })` calls `model:review` on open. With `status.versionKey` and `newestKey` it shows `VersionCompare` from one to the other. With an empty diff it says "The definition is unchanged. Something it uses changed: a metric or term it names, or its dataset." It has a note field and **Certify**, which sends `base: pin`. A 409 shows the server's `message`, calls `model:review` again and keeps the dialog open.
- `RetireDialog` picks a replacement of the same kind, never itself or a retired one, and has a note. A server `{ ok:false, field }` sentence shows under that field.
- `SaveWarning({ status, usage, onConfirm })`: when the item is `certified` and `movesPin(kind, patch)`, the editor's Save first shows "Revenue is certified by ana@acme.com. Saving changes 31 charts and needs a project admin to certify it again." with **Save anyway** / **Cancel**. Any other save goes straight through.
- [ ] **Step 1: Write the failing test.** ReviewDialog with a mocked `model:review` (`versionKey` K1, `newestKey` K2) renders `VersionCompare` with `from=K1 to=K2`. Certify posts `{ base: PIN }`. A 409 reply shows its message and refetches review. StatusActions renders nothing for an editor, which is the negative control, and three buttons for an admin. The MetricEditor save of a filter change on a certified metric shows the warning with "31 charts". The same save of a description change does not. The Metrics tab filter "Retired" shows only retired rows. TodoStrip draws a `review` item after the `todo` items.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web` fails, because the modules are missing.
- [ ] **Step 3: Implement.** Reuse `ui/Dialog`, `ui/Field`, `ui/Button`, `ui/Choice` and the metric editor's dialog primitive.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run size && npm run lint` are green, size ≤ 300 KB, and lint 0.
- [ ] **Step 5: Commit.** `git add web/src/features` · "Let project admins review and certify, retire or clear, and warn before a certified definition changes"

### Task 5: One e2e for the status screens
**Files:** Create `web/e2e/governance.e2e.ts` (step 07 adds its column part) · Read the `e2e-run` skill first
- [ ] **Step 1: Write the test.** As the admin on the sample project, open `/model/<pid>?tab=metrics`. Certify Revenue through Review, and the row reads "Certified". Edit Revenue's filters in the metric editor: the warning names the admin and the usage, Save anyway, and the row reads "Changed since certified". Retire Gross revenue for Net revenue, open a visual on Gross: the tile reads "Retired metric", and "Switch to Net revenue" redraws it with Net's figure. The measure picker lists Net first and Gross under "Retired (1)". Take a screenshot of the Metrics tab in light and in dark. Then, as a viewer, there is no Certify button and the badges are visible. Every load stays within the RPC budget of 25. Clean up: clear both statuses and restore Revenue's filters (the `smoke-sections-restore-sample` memory).
- [ ] **Step 2: Run it.** `npm run build:web && npm --prefix web run e2e -- governance` passes. Look at both screenshots.
- [ ] **Step 3: Commit.** `git add web/e2e/governance.e2e.ts` · "Walk certify, the save warning and retire through the browser"

Not in this step: the Assistant and MCP (04), anything about columns (05–07).
