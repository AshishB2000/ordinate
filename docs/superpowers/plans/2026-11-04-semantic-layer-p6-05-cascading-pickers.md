# Semantic layer part 6, step 05: Cascading filter pickers — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a dashboard with Region and State controls, the State picker lists only the states of the picked region, keeps a pick the new region rules out at the top marked "not in West" with Clear, and says so on a Live dataset whose list cannot be narrowed.
**Architecture:** `dataset:distinct` takes optional parent `filters` (at most 6 plain steps). They follow the row lock in the one list both engine twins already take (`DistinctRequest.filters`, `src/engine/datasetPage.ts:656-662`), so there is no new engine code. A Live list is the profile's sample, which cannot be narrowed: the reply says `narrowed: false`. The browser sends only the steps of controls on higher levels of the same hierarchy (`cascade.ts`, pure).
**Tech Stack:** zod contracts, `src/ipc` (`distinctFor`, `liveDistinct`), the resident and JS distinct readers, React (`ValuePicker`), Vitest, Playwright.
**Spec:** docs/semantic-layer/06-navigation.md (D12) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p6-00-index.md
**Branch and PR:** two PRs. **p6-05a** `feat/semantic-p6-05a-distinct-filters` (Task 1) off `origin/develop` after p6-01a, release A. **p6-05** `feat/semantic-p6-05-cascading-pickers` (Tasks 2–3) off `origin/develop` after step 04 merges and p6-05a is in a released, rolled-out build.

## Global Constraints

- Parent steps are plain filter steps only: the contract takes `type: 'filter'`, and the server drops any step with `via` or `datasetId` (a related dataset's step is not a picker's parent). At most 6. Each goes through `sanitizeFilterStep` (`src/data/filterStepSanitize.ts`, part 1 09a). A glossary term cannot ride here: classify the site **B** in `scripts/termSites.ts`.
- **The lock stays first.** `distinctFor` (`src/ipc/distinctFor.ts:18`) today REPLACES the request's filters with the lock's steps, so a restricted caller's parent steps would be dropped without a word. Part 1 step 06 (Task 5) changes it to "lock, then the request's"; if that has not merged, Task 1 makes the one-line change.
- Part 1 step 06's label search (`distinctWithLabels`) asks `read` a second time with an `in` filter. That filter is appended after the parent steps, never in place of them.
- Live: a reply to a request that carried parent steps has `narrowed: false`, and the picker says so (D12). It never pretends to be narrowed.
- Published `/p/` pages and embeds keep their precomputed options (D12): unchanged.
- `src/ipc/datasets.ts` (751) takes at most 3 lines: the sanitizing lives in new `src/ipc/distinctNarrow.ts`. `ValuePicker.tsx` (256) stays under 320: the cascade rules live in new `cascade.ts`.
- "Not in West" is claimed only when the narrowed list is complete (`total === values.length`, no search). On a capped list a pick it lacks is pinned as today, with no claim. The comment says `shortcut: on a capped list a pick it lacks may still exist; ask a pick-check when people meet it`.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A restricted caller's narrowed list.** It lists only their values: parent steps after the lock, never instead of it. → Task 1's row-lock case and its negative control.
- **Two twins.** Resident and JS agree under `Object.is` with parent steps (values and total). → Task 1.
- **Live honesty.** `narrowed: false` on every Live reply that was asked to narrow, and the picker's sentence. → Tasks 1, 2.
- **A pick silently cleared.** A ruled-out pick stays selected and visible until the person clears it. → Task 2.
- **Rolling.** A release-B browser never meets a pod that 400s `filters`, because 05a ships a release ahead. → the index.

## Rolling deploys

No stored field. `dataset:distinct.filters` is a contract field: a pod before 05a refuses it (strict zod), which is why 05a ships in release A, before any browser sends it. Controls, their values and the cascade are view state.

---

### Task 1 (PR p6-05a): `dataset:distinct` narrows by parent steps, after the lock

**Files:** Create `src/ipc/distinctNarrow.ts`, `scripts/test-distinctNarrow.ts` (on `scripts/liveRouteHarness.ts`: the real route, so the contract's refusals are HTTP 400s; the parity fixture's extract X and Live L, text `cat`, `region`, `many`). Modify `src/api/datasets.ts:183-193` (`filters`), `src/ipc/datasets.ts:477-498` (pass `narrowSteps(filters)` into `req`; mark a Live reply), `src/ipc/distinctFor.ts:18` (the lock first, then `req.filters`, unless step 06 did it), `scripts/termSites.ts` (classify the new sites). Test: also extend `scripts/test-rowPolicy.ts`.
**Interfaces:** Consumes `sanitizeFilterStep`, `DistinctRequest.filters`, `distinctValuesPageJs` (`src/engine/datasetPage.ts:770`), `liveDistinct` (`src/ipc/liveProfile.ts:113`). Produces
- Contract: `filters: z.array(z.looseObject({ type: z.literal('filter'), column: z.string().max(512), op: z.string().max(16) })).max(6).optional()`.
- `narrowSteps(raw: unknown): FilterStep[]` — sanitized `type: 'filter'` steps without `via` or `datasetId`, at most 6. A step that does not sanitize is dropped (it narrows less, never more).
- The reply gains `narrowed?: false`, set only on a Live reply to a request whose `narrowSteps` were not empty.
- [ ] **Step 1: Write the failing test** — `scripts/test-distinctNarrow.ts`. `R` is one `region` value of X, and `C` a `cat` value that occurs only outside `R` (both read off X's rows in the test, never typed in):
  ```ts
  const inR = [{ type: 'filter', column: 'region', op: '=', value: R }];
  const res = (await post('dataset:distinct', { projectId: P, datasetId: X, column: 'cat', filters: inR })).value;
  const ds = await H.as(H.ORG_A, () => H.datasets.getDataset(P, X));
  const js = distinctValuesPageJs(ds!.columns, ds!.rows, 'cat', { limit: 200, filters: inR });
  ok('narrowed: resident and JS agree', JSON.stringify(res.values) === JSON.stringify(js.values) && Object.is(res.total, js.total));
  ok('narrowed: C is not in R', !res.values.includes(C));
  ok('NEGATIVE CONTROL: unnarrowed, it is', (await post('dataset:distinct', { projectId: P, datasetId: X, column: 'cat' })).value.values.includes(C));
  ok('a related step is not a parent', (await post('dataset:distinct', { projectId: P, datasetId: X, column: 'cat', filters: [{ ...inR[0], datasetId: OTHER }] })).value.values.includes(C));
  ok('seven steps are refused by the contract', (await post('dataset:distinct', { projectId: P, datasetId: X, column: 'cat', filters: Array(7).fill(inR[0]) })).status === 400);
  ok('a term is refused by the contract', (await post('dataset:distinct', { projectId: P, datasetId: X, column: 'cat', filters: [{ type: 'term', term: U }] })).status === 400);
  ok('Live: the sample list, said to be not narrowed', ((v) => v.narrowed === false && Array.isArray(v.values))((await post('dataset:distinct', { projectId: P, datasetId: L, column: 'cat', filters: inR })).value));
  ```
  (L is profiled first, as `test-liveSafetyNet` does before its `PROFILED` checks; without `filters` its reply has no `narrowed` key.) `test-rowPolicy.ts`, in its `withLockOf` world locked to one `region`: a `filters` step on a second column lists only values inside the lock. NEGATIVE CONTROL: without the lock it lists more.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-distinctNarrow.js` → the route answers 400 for `filters` (`FAIL narrowed: resident and JS agree`).
- [ ] **Step 3: Implement** — the handler builds `req` with `filters: narrowSteps(filters)` when non-empty. In the Live branch, when that list is non-empty: `return 'ok' in live ? live : { ...live, narrowed: false }`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-distinctNarrow.js`, `node scripts/test-datasetDistinct.js`, `DATABASE_URL=… node scripts/test-rowPolicy.js`, `node scripts/test-liveSafetyNet.js`, `node scripts/test-valueLabels.js` (step 06's label search with parent steps), `node scripts/test-termSites.js`, `node scripts/check-contracts.js`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add src/ipc/distinctNarrow.ts src/api/datasets.ts src/ipc/datasets.ts src/ipc/distinctFor.ts scripts/termSites.ts scripts/test-distinctNarrow.ts scripts/test-rowPolicy.ts` · "Narrow a column's values by parent filter steps, after the row lock"

### Task 2: The picker narrows by the levels above it

**Files:** Create `web/src/features/analyses/editor/cascade.ts`, `cascade.test.ts`, `ValuePicker.cascade.test.tsx`. Modify `web/src/features/analyses/editor/ValuePicker.tsx:40-47` (`useDistinct` takes the parent steps and keys on them) and `:150-256` (the narrowed header, the ruled-out rows), `web/src/features/analyses/editor/ControlWidget.tsx:82-87` (passes `siblings`), `web/src/features/analyses/editor/FilterBar.tsx:104` (the sheet's other controls and their values), `web/src/features/live/distinct.ts:14-22` (`narrowed?: false`), `FilterBar.module.css` (tokens only).
**Interfaces:** Consumes `controlSteps` (`web/src/features/analyses/editor/filters.ts:11`), `useNavigation`/`navFor` (step 01), `levelOf`. Produces
```ts
export interface Sibling { control: NonNullable<Card['control']>; value: ControlValue | undefined }
export interface Cascade { steps: Step[]; by: { label: string; summary: string }[] } // nearest parent last
export function cascadeOf(control: NonNullable<Card['control']>, siblings: readonly Sibling[], hierarchies: readonly NavHierarchy[]): Cascade;
```
`cascadeOf` takes only dropdown and multi siblings on the same `datasetId` whose column is a higher level of the hierarchy holding `control.column`, with a value set; their `controlSteps`, in level order. A control on no hierarchy, or at its top level, gets `{ steps: [], by: [] }`.
- `ValuePicker` asks `useNavigation(projectId, open && siblings.length > 0)`, so `model:navigation` loads on the first picker open and never with the page. With a non-empty cascade:
  - the list query sends `filters: cascade.steps`;
  - the popover leads with `Narrowed to Region: West` (parents joined by ` · `);
  - each pick missing from a complete narrowed list sits at the top, tagged `not in West` (`not in this selection` for several parents), with a `Clear` button that removes that pick only.
- A reply with `narrowed: false` leads with `Not narrowed by Region: values come from a sample` and tags nothing.
- [ ] **Step 1: Write the failing test** — `cascade.test.ts`: Region `= West` and State on Geography `region › state` → `{ steps: [region = West], by: [{ label: 'Region', summary: 'West' }] }`; NEGATIVE CONTROL: a Segment control (no hierarchy) gets no steps, and a control of another dataset is never a parent; an unset Region gives none; a multi Region gives `in`. `ValuePicker.cascade.test.tsx`: opening State with Region = West sends `dataset:distinct` with `filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }]`, and the first open also sends `model:navigation`, once. A stored pick `Ohio` absent from a complete list shows `Ohio`, `not in West` and Clear; Clear calls `onChange(undefined)`. A capped list (`total > values.length`) shows Ohio pinned with no tag (negative control). A `narrowed: false` reply shows the sample sentence. The ControlDialog's preview picker (no siblings) never asks `model:navigation`.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- cascade` → "Cannot find module './cascade'".
- [ ] **Step 3: Implement** — the query key is `['dataset:distinct', projectId, datasetId, column, search, cascade.steps]`, so `web/src/api/freshness.ts`' `sameDataset` match still invalidates it.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/analyses/editor web/src/features/live/distinct.ts` · "Narrow a filter picker by the controls on the levels above it"

### Task 3: One e2e

**Files:** Modify `web/e2e/saved-views.e2e.ts` (its dashboard gains Region and State dropdowns), `scripts/termSites.ts` if a web count moved.
**Interfaces:** Seed Geography `region › state` on the sample with `catalog:setTable`. Pick a state, then a region it is not in (read the pair off `visual:data` by region split by state, never hard-coded). Open State: its list equals `dataset:distinct` asked directly with that region's step; the picked state shows `not in <region>`; Clear empties the control. Shot `picker-cascade`, both themes; RPC budget 25.
- [ ] **Step 1: Write the failing test** — as above.
- [ ] **Step 2: Run it to see it fail** — `npm run build:web && npm --prefix web run e2e -- saved-views` → the State list is every state.
- [ ] **Step 3: Implement** — the dashboard setup lines only.
- [ ] **Step 4: Run it to see it pass** — `npm --prefix web run e2e -- saved-views dashboards`; look at both `picker-cascade` screens.
- [ ] **Step 5: Commit** — `git add web/e2e scripts/termSites.ts` · "Cover the cascading picker end to end"

## Existing tests that must stay green

`test-datasetDistinct`, `test-rowPolicy`, `test-rowPolicySafetyNet`, `test-liveSafetyNet`, `test-liveProfile`, `test-valueLabels`, `test-termSites`, `check-contracts`; web `ValuePicker`, `ControlWidget`, `FilterBar`, `filters` and dashboard suites; e2e `saved-views`, `dashboards`, `live`.
