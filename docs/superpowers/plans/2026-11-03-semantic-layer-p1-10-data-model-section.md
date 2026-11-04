# Semantic layer part 1, step 10: The Data model section — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A top-level **Data model** section (`/model`, `/model/:projectId`) shows what the project's data means on one screen, in four tabs: Datasets (a "To fill in next" strip, a dataset list, and the picked dataset's Overview · Fields · Guide · Lineage), Metrics (moved from `/data/metrics`), Glossary, and Relationships (moved from Data).
**Architecture:** Two new reads and one new reply field, all built on the server. `model:overview` returns, for every dataset, its role, key state, description, always-applied filters and calculated fields, plus the ranked strip, from metadata only. `term:usage` gives the Glossary's "Used by". `metric:table` rows gain `additivity`. The web reuses the editors the earlier steps built (step 01's table fields and guide, `ColumnsTab` with step 06's value labels, `MetricEditor`, step 05b's `TermsList`/`TermDialog`, `RelationshipsTab`) and only lays them out.
**Tech Stack:** zod contracts (`src/api/`), handlers (`src/ipc/`), self-checks; React 19, React Router 7, TanStack Query, CSS Modules, Vitest, Playwright.
**Spec:** docs/semantic-layer/00-design.md ("What you will see", "The name and where it sits", the Datasets-tab layout the owner picked, "Its sections", D4, D13, D14, D15, D16) · Index: docs/superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md
**Branch and PR:** `feat/semantic-p1-10-data-model-section` off `origin/develop` (after step 09 merges), one PR to `develop`.

## Global Constraints

- `web/src/app/nav.ts`, `web/src/app/routes.tsx` and `src/api/index.ts` are append-only: one line at the end of each list. `navGroups.ts` places `/model` right after `/data` in Build, and `navGroups.test.ts` passes unchanged.
- The prototype (`web/src/features/model/prototype/`, its route, its nav entry and the `Graph` export in `LineageDrawer.tsx`) exists only uncommitted on `docs/semantic-layer-design`. The feat branch is cut from `origin/develop`, which has none of it. Copy no file from it: its styles are the visual reference, its sample values are fake.
- The UI never derives a figure. Repeat counts, `more`, additivity and usage counts all come from the server, formatted with `formatNumber` only.
- Every list and panel has a designed empty state, a skeleton while loading and an `ErrorState` with Retry, in both themes, from `web/src/theme.css` tokens only.
- The page header holds at most one primary (`PageHead` logs a console error on two, and the e2e harness fails on any console error). "New metric" is the primary, "New term" is secondary, and both are for editors only. One door, never none (`web/src/app/doors.test.tsx`): an empty Metrics or Glossary tab does not repeat the header's button.
- RPC budget: 25 per page load (`rpcBudget`). Over budget means batching into `model:overview`, never raising the budget. Initial JS stays ≤ 300 KB gzip: both routes are `page()` lazy chunks.
- A Live dataset's panel never calls a row channel: no `dataset:page`, `dataset:stats`, `dataset:profile` or `prepare:get` (`.claude/rules/live-data.md`).
- `model:overview` reads metadata only (`getDatasetMeta`, the catalog file), never `getDataset`, and is REDACT for a caller `closedToCaller` (`src/data/rowAccess.ts:268`). `term:usage` is META.
- No stored field, no migration, no dependency, no server sentence. Strip items are structured kinds, and the (English-only) React UI words them.
- File caps: `src/server/app.ts` is 644 lines, so the module goes inside the existing array at `:561` (0 new lines). `src/ipc/analysesServer.ts` (235) and `web/e2e/data.e2e.ts` (432) get small edits. Every new file stays under 300 lines.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A restricted viewer reads another team's filter value or key counts through `model:overview`.** Prepare filter steps, base filters and calculated-field formulas can quote values. → Task 1, safety-net canary plus negative control.
- **`model:overview` hydrates a dataset or queries a warehouse.** → Task 1, `hydrates` spy and `fake.calls`.
- **The strip goes stale after an edit in the panel.** Saving a role, key, guide or description must refetch `model:overview`. → Task 5.
- **Old pod, new browser.** An unknown `model:overview` must show the error state with Retry, not a blank tab. A `metric:table` without `additivity` must read "—", not "No". A failing `term:usage` must leave the glossary readable. → Tasks 4, 6, 7.
- **A formula metric with a `[[parameter]]` reads "can't be added up".** Without parameters it is unknown, so it reads "—". → Task 3.
- **The redirects drop context.** `/data/metrics?project=P&tag=finance` must keep `tag`. `/data?tab=relationships`, which names no project, must still land on Relationships. → Tasks 6, 8.
- **The "default" line names the wrong relationship.** The planner takes the first relationship in list order (`reachable`, `src/analysis/joinPlan.ts:67-80`). → Task 8.
- **Two "New metric" buttons on an empty Metrics tab** (doors.test). → Task 6.

## Rolling deploys

No stored field changes, so nothing can be lost. The new channels are `model:overview` and `term:usage`, plus a reply field `metric:table.rows[id].additivity`.
- **A new browser hits an old pod.** `model:overview` and `term:usage` are unknown there and the RPC route refuses them. The Datasets tab shows its `ErrorState`, and Retry reaches a new pod. The Glossary list still draws and its Used by column reads "—". A `metric:table` reply without `additivity` reads "—" in Adds up.
- **An old browser on a new pod.** It has no Data model entry. Its `/data/metrics` page and Data's Relationships tab call channels that still exist, unchanged, until it reloads.

---

### Task 1: `model:overview` — the Datasets tab's one read

**Files:** Create `src/api/model.ts`, `src/ipc/modelOverview.ts`, `scripts/test-modelOverview.ts` (on `scripts/liveRouteHarness.ts`). Modify `src/api/index.ts` (append `import { model } from './model'` and `...model`), `src/server/app.ts:561` (add `'../ipc/modelOverview'` to the Data section's array), `scripts/rowPolicyReaders.ts` (`'model:overview': 'REDACT'`), `scripts/test-rowPolicySafetyNet.ts`.
**Interfaces:** Consumes `TableDoc`, `TableRole` and `CatalogFile.tables` (step 01), `catalog.load` (`src/app/catalog.ts:254`), `datasets.listDatasets`/`getDatasetMeta`, `meta.live.baseFilters` and `redactBaseFilters(steps, closed)` (step 08, `src/data/liveBaseFilters.ts`), `restrictedOn`/`closedToCaller`. Produces:
```ts
// src/api/model.ts
'model:overview': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId })
// src/ipc/modelOverview.ts
export type TodoKind = 'key_repeats' | 'no_key' | 'no_guide' | 'no_description' | 'no_role'; // also the rank, first wins
export interface TodoItem { datasetId: string; kind: TodoKind; repeats?: number } // repeats = keyCheck.repeatedKeys
export interface ModelTable {
  datasetId: string; role: TableRole; key: string;
  keyState: '' | 'unchecked' | 'unique' | 'repeats';            // '' = no key; unchecked = no keyCheck (or hidden)
  description: string;                                          // the catalog record doc's (`dataset:<id>`)
  alwaysApplied: { kind: 'prepare' | 'live'; steps: FilterStep[] }; // copies: Prepare `filter` steps; Live: base filters
  calculated: { name: string; formula: string }[];             // copies: Prepare `calculated_field` steps (D15)
  valuesHidden?: true;                                          // closed caller: steps are {type,column,op}, formulas ''
}
export interface TodoRow { datasetId: string; role: TableRole; key: string; repeatedKeys: number | null; hasGuide: boolean; description: string }
export const TODO_SHOWN = 4;
export function todoOf(rows: TodoRow[]): { todo: TodoItem[]; more: number }
// reply: { ok: true; tables: ModelTable[]; todo: TodoItem[]; more: number } | { ok: false; error: string }
```
- `todoOf` gives each row its gaps: a key with `repeatedKeys > 0`, an empty key, an empty guide, an empty description, an empty role. It sorts them by `TodoKind` rank, then by row order, keeps the first `TODO_SHOWN` and counts the rest in `more`.
- `tables` is in `listDatasets` order.
- `closed` is `await restrictedOn(p) && await closedToCaller(p, id)`, so an unrestricted caller makes no per-dataset policy read. A closed caller gets no `keyCheck` (so `keyState: 'unchecked'` and no `key_repeats` item). That is the same rule as step 01's `readableTableDoc`.

- [ ] **Step 1: Write the failing test** — `scripts/test-modelOverview.ts`:
  ```ts
  const { projectId: P, extractId: X, liveId: L } = await H.setupOrg(H.ORG_A);
  const ov = async () => (await post('model:overview', { projectId: P })).value;
  const ids = ((await post('dataset:list', { projectId: P })).value as Reply[]).map((d) => d.id);
  const a = await ov();
  ok('every dataset, in dataset:list order', JSON.stringify(a.tables.map((t: Reply) => t.datasetId)) === JSON.stringify(ids));
  ok('nothing filled in', a.tables.every((t: Reply) => t.role === '' && t.key === '' && t.keyState === '' && t.description === ''));
  ok('four by rank, then how many more', JSON.stringify(a.todo.map((i: Reply) => i.kind)) === '["no_key","no_key","no_guide","no_guide"]' && a.more === 4);
  await post('catalog:setTable', { projectId: P, datasetId: X, patch: { role: 'fact', key: 'region', guide: '# Fixture' } });
  await post('catalog:set', { projectId: P, ref: `dataset:${X}`, patch: { description: 'The parity fixture' } });
  const stored = (await post('catalog:getTable', { projectId: P, datasetId: X })).value.table.keyCheck.repeatedKeys;
  const b = await ov();
  const tag = (i: Reply) => [i.datasetId === X ? 'X' : 'L', i.kind];
  ok('a repeating key leads, with the stored count', JSON.stringify(b.todo.map(tag)) === '[["X","key_repeats"],["L","no_key"],["L","no_guide"],["L","no_description"]]' && Object.is(b.todo[0].repeats, stored) && b.more === 1);
  ok('X reads fact, repeats, described', ((t) => t.role === 'fact' && t.keyState === 'repeats' && t.description === 'The parity fixture')(b.tables.find((t: Reply) => t.datasetId === X)));
  await post('dataset:addStep', { projectId: P, datasetId: X, step: { type: 'filter', column: 'region', op: '=', value: 'North' } });
  await post('dataset:addStep', { projectId: P, datasetId: X, step: { type: 'calculated_field', name: 'double', formula: '[amt] * 2' } });
  await post('live:setBaseFilters', { projectId: P, datasetId: L, filters: [{ type: 'filter', column: 'region', op: '=', value: 'North' }] });
  const calls0 = H.fake.calls.length;
  const hx = await hydrates(X, ov); const hl = await hydrates(L, ov); const c = hx.value;
  const row = (id: string) => c.tables.find((t: Reply) => t.datasetId === id);
  const meta = await H.as(H.ORG_A, () => H.datasets.getDatasetMeta(P, X));
  ok('a copy: its Prepare filter steps as stored', JSON.stringify(row(X).alwaysApplied) === JSON.stringify({ kind: 'prepare', steps: meta!.steps!.filter((s) => s.type === 'filter') }));
  ok('a copy: its calculated field with its formula', JSON.stringify(row(X).calculated) === '[{"name":"double","formula":"[amt] * 2"}]');
  ok('Live: its base filters', row(L).alwaysApplied.kind === 'live' && row(L).alwaysApplied.steps[0].value === 'North');
  ok('metadata only: nothing hydrated, no warehouse statement', !hx.hydrated && !hl.hydrated && H.fake.calls.length === calls0);
  ok('NEGATIVE CONTROL: todoOf with everything filled in', JSON.stringify(todoOf([{ datasetId: X, role: 'fact', key: 'k', repeatedKeys: 0, hasGuide: true, description: 'd' }])) === '{"todo":[],"more":0}');
  ```
  `scripts/test-rowPolicySafetyNet.ts`: `boss` adds a Prepare filter on Orders with value `` `${H.W_CANARY}_m` `` and sets and checks Orders' key (step 01's seed does the latter). Then:
  - `ok('redact: model:overview — east reads no value and no key count', !H.leaks(east.text) && !east.body.todo.some((i) => i.kind === 'key_repeats') && east.body.tables.find((t) => t.datasetId === ORDERS).valuesHidden === true)`
  - `NEGATIVE CONTROL`: the editor's reply includes the canary and Orders' `keyState` is not `'unchecked'`.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-modelOverview.js` → `No handler for model:overview`; `node scripts/check-contracts.js` lists it unresolved.
- [ ] **Step 3: Implement** — `todoOf` as specified. The handler wraps the build in try/catch → `{ ok: false, error: err?.message || 'The data model could not be read.' }`, as `catalog:list` does (`src/ipc/catalog.ts:62-72`).
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-modelOverview.js`, `node scripts/check-contracts.js` (0 unresolved), `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js`, `node scripts/test-server-boot.js`, `node scripts/test-asyncReach.js`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add src/api/model.ts src/api/index.ts src/ipc/modelOverview.ts src/server/app.ts scripts/rowPolicyReaders.ts scripts/test-modelOverview.ts scripts/test-rowPolicySafetyNet.ts` · "Read every dataset's semantics and what is left to fill in, from metadata only"

### Task 2: `term:usage` — where each glossary term is used

**Files:** Create `src/analysis/termUsage.ts`. Modify `src/api/terms.ts` (step 05b: append `term:usage`), `src/ipc/terms.ts` (step 05b: its handler), `scripts/rowPolicyReaders.ts` (`'term:usage': 'META'`). Test: extend `scripts/test-terms.ts` (part "usage").
**Interfaces:** Consumes `TermStep` (05b), `UUID_RE`, the stores `metricUsage` reads (`src/analysis/metricUsage.ts:84-140`) plus `scorecards.listScorecards`/`getScorecard`. Produces:
```ts
'term:usage': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }) // → { ok: true; usage: Record<termId, TermUsage> }
export type TermUsageKind = 'visual' | 'dashboard' | 'metric' | 'alert' | 'scorecard' | 'report';
export interface TermUsage { total: number; summary: string; refs: { kind: TermUsageKind; id: string; name: string }[] }
export function termIdsIn(value: unknown): Set<string>   // every { type: 'term', term: <UUID> } at any depth, iterative walk
export async function termUsage(projectId: string): Promise<Record<string, TermUsage>> // null-prototype; terms with ≥ 1 ref only
```
A whole record is walked: a visual, a dashboard (sheets, cards, controls and saved views all live on the analysis record), a metric, an alert rule and a scorecard. A report counts when its analysis uses the term, as in `metricUsage`. Each store is read in its own `try`, so the function never throws. `summary` is worded like `metricUsage.summarize`: "1 visual, 1 dashboard and 2 metrics".
- [ ] **Step 1: Write the failing test** — a term `West` (and `Unused`) on dataset D. A visual and a metric with `filters: [{ type: 'term', term: T }]`. A dashboard whose first sheet's filters hold it, built as `scripts/test-publishMemo.ts:22-38` builds one, and a report over that dashboard. A plain visual filtered by `region = 'West'`.
  ```ts
  const u = (await call('term:usage', { projectId: P })).usage;
  ok('usage: each record once, worded', u[T].summary === '1 visual, 1 dashboard, 1 metric and 1 report' && u[T].total === 4);
  ok('NEGATIVE CONTROL: the same filter written inline is not a use', !u[T].refs.some((r) => r.id === plainVisual.id));
  ok('a term nothing uses is absent', !(UNUSED in u));
  ok('termIdsIn: nested, and never a look-alike', [...termIdsIn({ a: [{ type: 'term', term: T }], b: { type: 'filter', term: T2 }, c: { type: 'term', term: 'x' } })].join() === T);
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-terms.js` → tsc "Cannot find module '../src/analysis/termUsage'".
- [ ] **Step 3: Implement** — the signatures above.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-terms.js`, `node scripts/check-contracts.js`, `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js` (classification present), `npm run lint`.
- [ ] **Step 5: Commit** — `git add src/analysis/termUsage.ts src/api/terms.ts src/ipc/terms.ts scripts/rowPolicyReaders.ts scripts/test-terms.ts` · "List where each glossary term is used"

### Task 3: `metric:table` says whether each metric can be added up

**Files:** Modify `src/analysis/additivity.ts` (step 02), `src/ipc/analysesServer.ts:205-225`. Test: extend `scripts/test-additivity.ts` (section "metric:table"; register `src/ipc/analysesServer` beside `ipcVisuals` in its setup).
**Interfaces:** Consumes `additivityOf` and `Additivity` (step 02), `metrics.metricsByName`/`getMetric`. Produces `metricAdditivity(projectId: string, id: string, byName: Map<string, Metric>): Promise<Additivity | null>`. It returns null for a metric that is gone and for a formula naming a `[[parameter]]` (unknown without a dashboard's values). It reads `getDatasetMeta(...).columns` for formulas only. `metric:table`'s handler reads `byName` once and sets `rows[id].additivity` (`.catch(() => null)`).
- [ ] **Step 1: Write the failing test** — over the section "doors" fixture (`Revenue`, `Profit`, `Per unit`, `Scaled`):
  ```ts
  const t = await call('metric:table', { projectId: pid }); const byName = await metrics.metricsByName(pid);
  for (const m of [revenue, profit, perUnit]) {
    const want = A.additivityOf((await metrics.getMetric(pid, m.id))!, meta.columns, byName);
    ok(`metric:table: ${m.name} is the rule's own answer`, Object.is(t.rows[m.id].additivity.categories, want.categories) && Object.is(t.rows[m.id].additivity.time, want.time));
  }
  ok('a ratio cannot be added up', t.rows[perUnit.id].additivity.categories === false);
  ok('a formula with a parameter is unknown, not "no"', t.rows[scaled.id].additivity === null);
  ok('NEGATIVE CONTROL: a sum adds up across time', t.rows[revenue.id].additivity.time === true);
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-additivity.js` → `TypeError: Cannot read properties of undefined (reading 'categories')`.
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-additivity.js scripts/test-analysesServer.js scripts/test-metrics.js scripts/test-file-size.js` (each with `node`).
- [ ] **Step 5: Commit** — `git add src/analysis/additivity.ts src/ipc/analysesServer.ts scripts/test-additivity.ts` · "Say on the metrics table whether each metric can be added up"

### Task 4: The section, its nav entry, the dataset list and the strip

**Files:** Modify `web/src/app/nav.ts` (append `{ to: '/model', label: 'Data model', icon: 'layers' },` as the last entry), `web/src/app/navGroups.ts:15` (Build: `['/data', '/model', '/connections', …]`), `web/src/app/routes.tsx` (append `page('/model', () => import('../features/model/DataModelPage'))` and `page('/model/:projectId', …same…)` with one comment line), `web/src/features/assistant/dockRoute.ts:15` (`'/model'` in `BEFORE_PROJECT`; `dockRoute.test.tsx` walks every route). Create `web/src/features/model/DataModelPage.tsx`, `api.ts`, `Model.module.css`, `datasets/DatasetsTab.tsx`, `datasets/TodoStrip.tsx`, `model.test.tsx`.
**Interfaces:** Consumes `model:overview`, `useDatasets`, `useCurrentProject`/`useAdoptProject`, `useCanEdit`, `useMe`, `NoProject`. Produces:
- `DataModelPage`, the default export.
  - At `/model`, it resolves the current project exactly as `DataPage.tsx` does, then `<Navigate to={`/model/${id}${search}`} replace />`. Pending, error and no-project states use `why="The data model belongs to a project."`.
  - At `/model/:projectId`, it calls `useAdoptProject`. `?tab=` is one of `TABS`, default `datasets`, set with `replace` as `DataSection` does. Each later task appends to `TABS`.
  - Title "Data model". Sub: "What your data means: datasets, fields, metrics and business terms. Every chart, the Assistant and agents use it."
- `api.ts`:
  - `useModelOverview(projectId)` (key `['model:overview', projectId]`, `okOr` as in `web/src/features/data/api.ts:196-200`), with types mirrored from Task 1.
  - `todoText(item: TodoItem, name: string): string`, worded: `Orders: 12 keys repeat` / `Orders: 1 key repeats`, `Set a key on Orders`, `Write a guide for Orders`, `Describe Orders`, `Set a role for Orders`.
  - `todoPanel(kind): 'overview' | 'guide'` (`no_guide` → guide).
- `DatasetsTab({ projectId })`:
  - First, the calendar line: "Calendar and fiscal year are workspace settings." For an org admin (`useMe().data?.user?.role === 'admin'`, as `SettingsPage.tsx:82`) it is followed by a link "Workspace settings" to `/admin?tab=workspace`.
  - `TodoStrip` comes next, for editors only and only when `todo` is non-empty. It is a `region` "To fill in next" holding one button per item and the text `+{more} more` when `more > 0`. A click sets `?dataset=<id>&panel=<todoPanel>`.
  - Then the split: a list `nav` "Datasets", grouped under captions **Facts**, **Dimensions** and **Role not set** in `dataset:list` order. Each item shows a `cloud` (Live) or `database` icon, the name, and a warn `Badge` "key repeats" when `keyState === 'repeats'`. The picked item is `?dataset=`, else the first, and carries `aria-current="true"`.
  - Beside the list, the panel `section` `aria-label="About <name>"`. Its head holds an h2 with the name, a role `Badge`, a Live `Badge`, the description (or muted "No description yet"), `RecordDetails` (`web/src/features/data/Details.tsx:115`, trigger "Details") and a link "Open dataset". Task 5 fills the body.
  - States:
    - Loading: `SkeletonRows` in the list and a `SkeletonBlock` labelled "Loading the data model" in the panel.
    - Error (either read fails): `ErrorState heading={3}` "The data model could not be loaded", whose Retry refetches both.
    - No datasets: `EmptyState icon="database"` "No datasets to describe yet". An editor gets an "Import file" link to `/data/import?project=`. A viewer reads "An editor of this project can bring data in."
- `Model.module.css`:
  - Tokens only. The rules come from the prototype's layout-A, strip and detail rules (`Proto.module.css` `.split .list .item .itemOn .strip .stripItem .detail .dHead .dRow`), renamed `split list item itemOn groupCap strip chip panel panelHead row`.
  - Under `@media (max-width: 900px)` the split stacks into one column, with no sideways scroll at 375 px.
- [ ] **Step 1: Write the failing test** — `model.test.tsx` uses `renderApp` and a `serve()` like `data.test.tsx:28-45`. Orders is a fact that repeats, Regions a dimension.
  - `/model` lands on `/model/${P}`.
  - The captions read `['Facts', 'Dimensions']`, and Orders carries "key repeats".
  - With `todo` holding 4 items and `more: 3`, the strip has 4 buttons and the text `+3 more`. The first reads `Orders: 12 keys repeat`.
  - Clicking `Write a guide for Regions` puts `dataset=R&panel=guide` in the location and shows h2 "Regions".
  - The strip is absent with `todo: []`, and absent for a viewer even with items (negative control).
  - `model:overview` answering `{ status: 404 }` shows "The data model could not be loaded". Retry calls it a second time.
  - `dataset:list: []` shows "No datasets to describe yet".
  - `todoText` reads each kind's sentence.
  - `navGroups.test.ts` and `dockRoute.test.tsx` pass unchanged.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- model navGroups dockRoute` → "Cannot find module './DataModelPage'", and `/model is in no group` once nav.ts has the line.
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web -- model navGroups dockRoute`, `npm run lint`, `npm --prefix web run size` (≤ 300 KB).
- [ ] **Step 5: Commit** — `git add web/src/app/nav.ts web/src/app/navGroups.ts web/src/app/routes.tsx web/src/features/assistant/dockRoute.ts web/src/features/model` · "Add the Data model section with its dataset list and what to fill in next"

### Task 5: The dataset panel — Overview, Fields, Guide, Lineage

**Files:** Create `web/src/features/model/datasets/DatasetPanel.tsx`, `OverviewPanel.tsx`, `FieldsPanel.tsx`, `web/src/features/model/panel.test.tsx`. Modify:
- `web/src/features/data/AboutTab.tsx` (step 01): export `RoleField`, `KeyField`, `GrainField` and `TableGuide`, each `({ projectId, datasetId, header })`. AboutTab composes them; split them out if step 01 wrote one body. `AboutTab.test.tsx` stays unchanged and green.
- `web/src/features/data/tableApi.ts` (step 01): add `'model:overview'` to the refresh lists of `catalog:setTable` and `catalog:checkKey`.
- `web/src/features/data/Details.tsx`: `RecordFields`' `catalog:set` write refreshes `'model:overview'`.
- `web/src/features/data/LineageDrawer.tsx:170-202`: the drawer's body becomes `export function LineageView({ projectId, id, type = 'dataset' })`, which the drawer renders. `Graph` stays private.

**Interfaces:** Consumes `useTableDoc` (step 01), `ColumnsTab` (`web/src/features/data/ColumnsTab.tsx:126`, with step 06's Value labels cell), `useDatasetColumns`, `useQualityRules`, `useColumnDocs`, `useLineage` + `usedInText`, `useCan(projectId)('admin')`, `FilterSummary` (`web/src/features/visuals/filters/FilterRows.tsx:19`). Produces `DatasetPanel({ projectId, dataset, table })` with tabs in `?panel=` (`overview` default, `fields`, `guide`, `lineage`; icons `info columns file-text lineage`). Its tabs:
- **Overview**: a `dl` of rows, in this order.
  - **What one row is**: `GrainField`.
  - **Role**: `RoleField`.
  - **Key**: `KeyField`, which carries the check line and Check now.
  - **Always applied**:
    - Each step is a `FilterSummary`. With `valuesHidden` it reads `<column> · values hidden by row access rules`. With no steps it reads "None".
    - A copy links "Open Prepare" to `/data/P/D/prepare`. A Live dataset links "Open the Schema tab" to `/data/P/D?tab=schema` (step 08's panel).
  - **Quality**:
    - No rules: "No checks yet".
    - Scoped (`dataset.scoped`): "Hidden by row access rules".
    - No `latest`: "Not run yet".
    - Otherwise: a warn `Badge` `N failing` (`dataset.qualityFailing`) or an ok `Badge` `N checks pass` (`rules.length`).
    - Every case links to `?tab=quality`.
  - **Access**:
    - A project admin gets the link "Row access rules" to `?tab=access`.
    - A scoped caller reads "Row access rules limit what you see here".
    - Everyone reads "Personal: a, b · Financial: c" from the column docs, or "No column is marked personal or financial".
  - **Used by**: `usedInText(g.usedIn)`, or "Nothing is built on it yet", plus a button "See lineage" that switches to the Lineage tab.
- **Fields**:
  - First a "Calculated in Prepare" list (name, mono formula, or "formula hidden"), when `table.calculated` is non-empty.
  - Then `<ColumnsTab header={header} live={header.mode === 'live'} />` over `useDatasetColumns`, with that read's own skeleton and error.
- **Guide**: `TableGuide`, with the line "Last edited by {updatedBy}, {date}" from the table doc. The stamp covers the whole table doc. An editor with no guide gets the empty state "Write this dataset's guide" and the button "Write guide". A viewer reads "No guide yet."
- **Lineage**: `<LineageView projectId={projectId} id={dataset.id} />`.
- [ ] **Step 1: Write the failing test** — `panel.test.tsx`:
  - The Overview row labels equal `['What one row is', 'Role', 'Key', 'Always applied', 'Quality', 'Access', 'Used by']`.
  - A copy whose step is `{ type: 'filter', column: 'is_test', op: '=', value: true }` shows its `FilterSummary`, and "Open Prepare" has href `/data/P/D/prepare`.
  - A Live dataset links to `?tab=schema`.
  - With `valuesHidden`, the text "values hidden by row access rules" shows and the value does not.
  - Lineage `usedIn: { visual: 3, dashboard: 1 }` reads `Used in 3 visuals · 1 dashboard`.
  - Fields shows the region "Column notes" and the calculated field `double`.
  - Guide `# Orders` renders the heading "Orders". A viewer sees no "Edit" or "Write guide" button.
  - Lineage shows the group "Lineage graph".
  - Saving a role (`catalog:setTable`) is followed by a second `model:overview` call.
  - On a Live dataset, the calls include none of `dataset:page`, `dataset:stats`, `dataset:profile` or `prepare:get`. NEGATIVE CONTROL: the copy's Fields tab does call `dataset:stats`.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- panel` → "Cannot find module './datasets/DatasetPanel'".
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web` (all, including `AboutTab`, `data.test`), `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/model web/src/features/data/AboutTab.tsx web/src/features/data/tableApi.ts web/src/features/data/Details.tsx web/src/features/data/LineageDrawer.tsx` · "Show a dataset's overview, fields, guide and lineage in the Data model"

### Task 6: The Metrics tab, moved from `/data/metrics`

**Files:** Create `web/src/features/model/metrics/MetricsTab.tsx` and `metrics.test.tsx`. Modify:
- `web/src/features/analyses/metrics/MetricsPage.tsx`: lines 31-268 move to `MetricsTab`. The `Page` wrapper goes, and its count chip becomes the list bar's "N metrics". The default export becomes `ProjectGate` → `<Navigate to={`/model/${id}?${q}`} replace />`, where `q` is the search minus `project` plus `tab=metrics`. The route line is unchanged.
- `DataModelPage.tsx`: append `'metrics'` to `TABS` and add the tab (icon `target`). Add the header's primary "New metric" (editors), which opens `MetricEditor` with `existing={{}}`. Its `onSaved` invalidates `metric:table` and `metric:list` and sets `?tab=metrics`.
- `web/src/features/analyses/metrics/tree/MetricTreePage.tsx:155`: back crumb `{ to: `/model/${projectId}?tab=metrics`, label: 'Data model' }`.
- `web/src/features/projects/VersionsPage.tsx:30`: the same crumb.
- `web/src/features/data/DataSection.tsx:56`: the "Metrics" link goes to `/model/${projectId}?tab=metrics`.

**Interfaces:** Consumes `MetricSummary.timeColumn` (step 04), `definition.snapshot` (step 07), `rows[id].additivity` (Task 3), the "N charts changed" badge (step 03, moved with the table). Two columns go after Definition:
- **Counts by**: `timeColumn` in mono, or muted "Any date". A snapshot adds a neutral `Badge` "Snapshot" and "last of <column>" / "first of <column>".
- **Adds up**: an ok `Badge` "Yes" for both true. A warn `Badge` "Not over time" for categories only, with title "A snapshot: it adds up across categories, not across dates." A warn `Badge` "No" for neither, with title "It can't be added up, so a total of it would be wrong." "—" when absent or null.

The empty state keeps "Suggest metrics from my columns" and drops its own "New metric".
- [ ] **Step 1: Write the failing test** — `metrics.test.tsx` renders `/model/${P}?tab=metrics` with a `metric:table` stub:
  - Revenue `timeColumn: 'ship_date'`, additivity both true → "ship_date", "Yes".
  - Stock `snapshot: { column: 'day', take: 'last' }`, `{ categories: true, time: false }` → "Snapshot", "last of day", "Not over time".
  - Avg `{ false, false }` → "No".
  - A row with no `additivity` key (an old pod) → "—".
  - With `metrics: []`, exactly one "New metric" button (the header's) and "Suggest metrics from my columns".
  - The header's "New metric" opens the dialog "New metric".
  - `/data/metrics?project=${P}&tag=finance` lands on `/model/${P}?tab=metrics&tag=finance`.
  - These keep passing through the redirect with their URLs and assertions untouched: `viewer.test.tsx`, `analyses.test.tsx` "Metrics list", and `doors.test.tsx` "Metrics shows New metric once when there are none".
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- metrics` → no tab "Metrics" on the Data model.
- [ ] **Step 3: Implement** — as in Files and Interfaces.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web -- metrics viewer analyses doors MetricTree Versions data`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/model web/src/features/analyses/metrics/MetricsPage.tsx web/src/features/analyses/metrics/tree/MetricTreePage.tsx web/src/features/projects/VersionsPage.tsx web/src/features/data/DataSection.tsx` · "Move the metrics list into the Data model, with each metric's date and whether it adds up"

### Task 7: The Glossary tab

**Files:** Create `web/src/features/model/terms/GlossaryTab.tsx` and `glossary.test.tsx`. Modify:
- `web/src/features/model/terms/TermsList.tsx` (05b): a `usage?: Record<string, TermUsage>` prop and a "Used by" column. Its own "New term" button goes, because the header holds it.
- `web/src/features/model/terms/api.ts` (05b): `useTermUsage(projectId)`, key `['term:usage', projectId]`.
- `DataModelPage.tsx`: append `'glossary'` to `TABS` (icon `list`). Add the header's secondary "New term" (editors), which opens `TermDialog({ projectId, onClose })` and then sets `?tab=glossary`.
- 05b's Glossary section on the Metrics page goes away with Task 6's redirect: delete its mount.

**Interfaces:** Consumes `term:list`, `term:usage` (Task 2), `TermsList`, `TermDialog`. The Used by cell shows `summary` with `title` set to the names joined by ", ", or "Not used yet" for a term absent from `usage`. When `term:usage` errored or answered nothing, the cell reads "—".
- [ ] **Step 1: Write the failing test** — `glossary.test.tsx`:
  - EMEA used by two visuals and a dashboard reads `2 visuals and 1 dashboard`, with the names in its title.
  - A term absent from `usage` reads "Not used yet".
  - `term:usage` answering 404 (old pod) leaves both terms listed with "—" (negative control).
  - An empty glossary shows one "New term" button. The header's "New term" opens TermDialog.
  - A viewer sees no "New term".
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- glossary` → no tab "Glossary".
- [ ] **Step 3: Implement** — as above.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/model` · "Give the glossary its own tab, with where each term is used"

### Task 8: The Relationships tab, moved from Data, and the default join

**Files:** Create `web/src/features/model/relationships/DefaultJoins.tsx` and `defaultJoins.test.tsx`. Modify:
- `DataModelPage.tsx`: append `'relationships'` to `TABS` (icon `link`), rendering `<RelationshipsTab/>` then `<DefaultJoins/>`.
- `web/src/features/data/DataSection.tsx`: delete the Relationships `Tab`/`TabPanel` and its `SUB` entry. `'relationships'` stays in `TABS`, so `?tab=relationships` renders `<Navigate to={`/model/${projectId}?tab=relationships`} replace />`. Catalog stays here.
- `web/src/features/data/DataPage.tsx:27`: `<Navigate to={`/data/${cur.projectId}${useLocation().search}`} replace />`, so `/data?tab=relationships` reaches DataSection with its tab.

**Interfaces:** Consumes `useRelationships`, `useDatasets`, `Relationship.label` (step 09), `Relationship.warning` and `relWarningText` (step 01, already drawn inside `RelationshipsTab`). Produces `defaultJoinLines(rels: Relationship[], name: (id: string) => string): string[]`.
- For each `from.datasetId → to.datasetId` pair that has two or more relationships, the line reads `Charts use <first> unless they pick <the rest, joined " or ">.`
- A relationship's name is `r.label ?? `${name(r.to.datasetId)} (${r.from.column})``, step 09's own fallback.
- "First" is `relationship:list` order: the planner's `reachable` takes the first walk (`joinPlan.ts:67-80`), and 09a keeps the order on re-save.
- `DefaultJoins` renders the lines as a `role="note"` list. It renders nothing when there are none.
- [ ] **Step 1: Write the failing test** — `defaultJoins.test.tsx`:
  - Two relationships Sales→Dates labelled "Order date" and "Ship date" give `['Charts use Order date unless they pick Ship date.']`.
  - Unlabelled, they give `Dates (order_date)`.
  - One relationship, or two between different pairs, gives `[]` (negative control).
  - Rendered on `/model/P?tab=relationships` with step 01's `warning: { kind: 'repeats', repeats: 2 }`, the warning sentence and the "Order date" label show.
  - `/data/P?tab=relationships` and `/data?tab=relationships` both land on `/model/P?tab=relationships`.
  - Data's tab list is `['Datasets', 'Captures', 'Catalog']`.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- defaultJoins` → module not found.
- [ ] **Step 3: Implement** — as above.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web` (`data.test.tsx` keeps `laneLayout` and the Metrics link anchor), `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/model web/src/features/data/DataSection.tsx web/src/features/data/DataPage.tsx` · "Move relationships into the Data model and say which one charts use by default"

### Task 9: One e2e for the screen, the viewer walk, and the release note

**Files:**
- Create `web/e2e/model.e2e.ts`.
- Modify `web/e2e/fixtures.ts`: export `screensInPlace`, moved from `analyses.e2e.ts:20`.
- Modify `web/e2e/analyses.e2e.ts`: its `metrics:` test (`:299-344`) and 05b's term test move to `model.e2e.ts`.
- Modify `web/e2e/data.e2e.ts:249`: `page.goto(`/model/${pid}?tab=relationships`)` instead of the tab click.
- Modify `web/e2e/data.e2e.ts:411`: the same for the empty project.
- Modify `web/e2e/viewerRoutes.ts`: add the cases below.
- Modify `CHANGELOG.md` (`[Unreleased]`: `### Data model`).

**Interfaces:** These are the `model.e2e.ts` tests, each ending in `screens(page, 'model-…')`, which writes light and dark shots:
1. **`data model: datasets`**
   - Go to `/model/${pid}` and see the h1 "Data model". The nav link "Data model" is current.
   - The strip "To fill in next" has 1–4 buttons. Clicking `Set a key on Retail orders` shows the panel h2 "Retail orders".
   - Pick role Fact and key `state`. The key line shows the server's repeat count (`/\d[\d,]* values? repeats?/`), and after the refetch the strip leads with `Retail orders:`.
   - In Guide, write `## How to query it` and save, then see the rendered heading.
   - Fields: region "Column notes". Lineage: group "Lineage graph".
   - Shots `model-datasets` and `model-guide`.
2. **`data model: metrics`** is the moved test, starting at `/model/${pid}?tab=metrics`.
   - Plus: `page.goto('/data/metrics?project=…')` then `waitForURL(/\/model\/[^/]+\?tab=metrics/)`.
   - The Revenue row's Adds up cell reads "Yes".
3. **`data model: glossary`** is 05b's moved term test, starting at `?tab=glossary`. After the term is used on a visual, Used by reads "1 visual".
4. **`data model: an empty project`** creates a project as `data.e2e.ts:400-405` does.
   - Datasets shows "No datasets to describe yet". Metrics shows "No metrics yet". Glossary shows the 05b empty heading. Relationships shows "Relate two datasets".
   - Shot `model-empty`.

Every load stays within `rpcBudget` 25. A load over it means folding the read into `model:overview`, not raising the budget.

`viewerRoutes.ts` cases (the `open` helpers return the tabpanel, as `columns` does at `:112`):
- `{ pattern: '/model', url: (s) => `/model?project=${s.pid}`, editor: { role: 'button', name: 'New metric' } }`
- `/model/:projectId` at `?dataset=${s.did}` with editor `New term` and `open: modelOverview` (tabpanel "Overview", role and key fields read-only for a viewer)
- the same pattern at `?dataset=${s.did}&panel=fields` with `open: modelFields`
- `&panel=guide`, with step 01's guide edit button as the editor control
- `?tab=metrics` → `New metric`, `?tab=glossary` → `New term`, `?tab=relationships` → `New relationship`

The existing `/data/metrics` and `/data/:projectId?tab=relationships` cases stay as they are: they now walk the redirects.
- [ ] **Step 1: Write the failing test** — `model.e2e.ts` as above. The `uncovered()` test in `view-only-routes.e2e.ts` lists `/model` and `/model/:projectId` until `viewerRoutes.ts` has them.
- [ ] **Step 2: Run it to see it fail** — `npm run build:web && npm --prefix web run e2e -- model view-only-routes` → the moved metrics test fails on the old URL's first assertion, and `uncovered` names `/model`.
- [ ] **Step 3: Implement** — move the tests, add the cases, and write the CHANGELOG lines:
  - Data model is a new section after Data.
  - Metrics and Relationships moved there, and their old links redirect.
  - The "To fill in next" strip.
  - Each metric's "Counts by" and "Adds up".
- [ ] **Step 4: Run it to see it pass** — `npm --prefix web run e2e -- model data analyses metricTree edit-conflicts`, `DATABASE_URL=… npm --prefix web run e2e -- view-only-routes`, `npm --prefix web run size`, `npm run lint`. Look at every `web/e2e/__screens__/model-*` in both themes against the house polish bar.
- [ ] **Step 5: Commit** — `git add web/e2e CHANGELOG.md` · "Cover the Data model end to end and in the viewer walk"

## Existing tests that must stay green

`test-catalog`, `test-tableDocs`, `test-terms`, `test-additivity`, `test-analysesServer`, `test-metrics`, `test-lineage`, `test-liveBaseFilters`, `test-rowPolicySafetyNet`, `test-liveSafetyNet`, `test-server-boot`, `test-asyncReach`, `test-file-size`, `test-i18n`, `check-contracts`; web `navGroups.test.ts`, `dockRoute.test.tsx`, `doors.test.tsx`, `backLinks.test.ts`, `data.test.tsx`, `AboutTab.test.tsx`, `ValueLabelsDialog.test.tsx`, `viewer.test.tsx`, `analyses.test.tsx`, `baseFilters.test.tsx`; e2e `data`, `analyses`, `metricTree`, `edit-conflicts`, `live`, `view-only-routes`; every `__golden__` fixture (never re-recorded).
