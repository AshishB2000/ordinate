# Semantic layer part 6, step 03: Explore drills, and nests its field list — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Explore, a click on a bar of a drillable chart asks the server for the drill and pushes the drilled question onto the URL, so Back goes up. Crumbs drawn from the question's structure go back up a text hierarchy. The field list nests each hierarchy's levels. On a phone a tap offers the drill in a sheet.
**Architecture:** Explore's question already is the URL (`useExploreSpec` pushes a history entry per edit), so a drill is one more edit: `visual:drillDown` (step 02) answers the encoding and the steps, and `setQuestion({ ...q, encoding, filters: [...q.filters, ...steps] })` pushes it. Crumbs are a pure function of the question and the dataset's hierarchies (`model:navigation`, read on load). Nothing on the page computes a figure.
**Tech Stack:** React 19, TanStack Query, React Router 7 (search params), Vitest, Playwright.
**Spec:** docs/semantic-layer/06-navigation.md (D6 Explore row, D8, D9, D10) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p6-00-index.md
**Branch and PR:** `feat/semantic-p6-03-explore-drill` off `origin/develop` after step 02 merges, one PR.

## Global Constraints

- Drillable means: the chart drawn (`current`) is in `DRILL_CHART_TYPES`, and either the server bucketed the axis by date (`reply.category.kind === 'date'`) at a grain with a next one in `dateLadder`, or `nextLevel(hierarchies, category)` finds the next level. Anything else keeps today's inert click.
- The mark sent is the server's label (`serverLabel`, `web/src/features/analyses/VisualTile.tsx:60`, with part 1 step 06's value-label pairs), never the drawn text.
- A refusal shows its sentence as an info toast. A failed or missing `visual:drillDown` (an older pod) shows "This chart could not drill down. Try again." and leaves the question as it is.
- Crumbs (my call, the index explains why): text hierarchies only, read as `Geography › East · by state`. Date drills have no crumbs; Back goes up, and the period step shows as an ordinary Filters pill.
- `model:navigation` is one extra RPC per Explore load (RPC budget 25 holds). Its failure means no hierarchies: no nesting, no text drill. Date drills still work: they need no hierarchy, the ladder falls back to `dateLadder(false)` for the sheet's words, and the server picks the real next grain.
- Live drills like an extract (D11): each level is one warehouse statement through `visual:data`.
- `web/src/features/explore/Answer.tsx` (161) and `Explorer.tsx` (143) stay under 250 lines: the drill logic goes in new files.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **The URL is the state.** A drill pushes exactly one history entry; a crumb click pushes one; nothing uses `replace`. → Task 2.
- **Crumbs never claim a path the filters do not hold.** Every level above the group-by needs exactly one `=` step on it, else no crumbs. → Task 1's negative control.
- **A kept step (a term) is never read as a crumb**, and survives a drill and an Up. → Task 1.
- **Value labels.** The crumb shows the stored value, as the Filters pill does; the click sends the raw value. → Task 2.

## Rolling deploys

No stored field. A question saved from a drilled Explore ("Save as visual") stores plain `=` and `custom` period steps, which every release reads.

---

### Task 1: Crumbs and Up, from the question's structure

**Files:** Create `web/src/features/explore/drillCrumbs.ts`, `drillCrumbs.test.ts`.
**Interfaces:** Consumes `levelOf` (step 01, `src/analysis/drillLevels.ts`, imported as `../../../../src/analysis/drillLevels.ts`), `isKeptStep`, `Question`. Produces
```ts
export interface DrillCrumb { label: string; to: Question | null } // null: the current level
export function crumbsOf(q: Question, list: readonly NavHierarchy[]): DrillCrumb[] | null;
export function upTo(q: Question, h: NavHierarchy, index: number): Question; // group by levels[index]; drop the = steps on levels[index..k-1]
```
`crumbsOf` returns null unless the group-by is level `k ≥ 1` of a usable hierarchy and each level above holds exactly one non-kept `=` step. The list is the hierarchy's name (to `upTo(q, h, 0)`), then each value above, each to `upTo(q, h, j + 1)`, then the last value with `to: null`. The component adds "· by state".
- [ ] **Step 1: Write the failing test** —
  ```ts
  const Q = { chartType: 'column', encoding: { category: 'state', values: [REV] }, filters: [TERM, { type: 'filter', column: 'region', op: '=', value: 'East' }] };
  expect(crumbsOf(Q, [GEO])!.map((c) => c.label)).toEqual(['Geography', 'East']);
  expect(crumbsOf(Q, [GEO])![0].to).toEqual({ ...Q, encoding: { category: 'region', values: [REV] }, filters: [TERM] });
  expect(upTo({ ...Q, encoding: { ...Q.encoding, category: 'city' }, filters: [...Q.filters, { type: 'filter', column: 'state', op: '=', value: 'Ohio' }] }, GEO3, 1).filters).toEqual(Q.filters);
  expect(crumbsOf({ ...Q, filters: [TERM] }, [GEO])).toBeNull();                                                          // NEGATIVE CONTROL: no step on region
  expect(crumbsOf({ ...Q, filters: [...Q.filters, { type: 'filter', column: 'region', op: '=', value: 'West' }] }, [GEO])).toBeNull(); // two steps: not one path
  expect(crumbsOf(Q, [{ ...GEO, missing: ['state'] }])).toBeNull();
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- drillCrumbs` → "Cannot find module './drillCrumbs'".
- [ ] **Step 3: Implement** — pure; the chart type is kept on every move.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web -- drillCrumbs`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/explore/drillCrumbs.ts web/src/features/explore/drillCrumbs.test.ts` · "Draw Explore's drill crumbs from the question itself"

### Task 2: A click drills; crumbs and Up; the phone's sheet

**Files:** Create `web/src/features/visuals/drill/drillApi.ts` (shared with step 04), `web/src/features/explore/useExploreDrill.ts`, `web/src/features/visuals/drill/DrillCrumbs.tsx` and its `DrillCrumbs.module.css` (shared with step 04; tokens only), `web/src/features/explore/exploreDrill.test.tsx`. Modify `web/src/features/explore/Answer.tsx:128-137` (`ChartStage` gets `onMark` when drillable; the crumb row above the chart), `web/src/features/explore/Explorer.tsx` (one `useNavigation`; hierarchies of the dataset into `Answer` and `FieldList`).
**Interfaces:** Consumes `useNavigation`/`navFor` (step 01, `web/src/features/model/navigation.ts`), `markAt` (`web/src/features/visuals/drill/mark.ts`), `serverLabel`, `PointSheet` (`web/src/features/dashboards/phone/PointSheet.tsx`), `PHONE_QUERY` (`web/src/ui/Dialog.tsx:33`), `DRILL_CHART_TYPES`, `nextLevel`, `nextGrain`, `grainWord`, `toast`. Produces
- `drillDown(input: RpcInput<'visual:drillDown'>): Promise<DrillDownReply | { ok: false; error: string }>` — never throws; an RPC error becomes `{ ok: false, error }`.
- `drillableAxis({ chartType, encoding, category, hierarchies, ladder }): { next: string; word: string } | null` — what the menu and the sheet say ("by state", "by month").
- `useExploreDrill({ projectId, datasetId, question, reply, chartType, hierarchies, ladder, onChange }): { onMark?: PanelMark; sheet: ReactNode }` — `onMark` is undefined when not drillable. On a phone (`matchMedia(PHONE_QUERY)`) a tap opens `PointSheet` with one action, `Drill into <shown> · by <next>`. Elsewhere a click drills at once.
- `DrillCrumbs({ crumbs, by, onUp }: { crumbs: { label: string; go?: () => void }[]; by: string; onUp: () => void })` — a `nav` `aria-label="Drill path"`: a button for each crumb with a `go`, the current one (no `go`) as text, "· by state" muted, and an "Up" `Button` (icon `arrow-up`). It wraps at 375 px with no sideways scroll.
- [ ] **Step 1: Write the failing test** — `exploreDrill.test.tsx` (`renderApp` + a `serve()` as `explore.test.tsx` does), on `/explore?project=P&dataset=D&q=<by region>` with `model:navigation` answering Geography `region › state`:
  - `useExploreDrill`'s `onMark` on a hit `East` sends `visual:drillDown` with `mark: { category: 'East' }` and `encoding.category === 'region'`; the location's `q` then decodes to `category: 'state'` with filters `[…, region = East]`, and `history.length` grew by one.
  - The crumb row reads `Geography › East · by state`; "Up" and the "Geography" crumb each push the by-region question back.
  - A reply `{ available: false, reason: 'state is the last level of Geography.' }` shows that toast and keeps `q`.
  - A month chart (`category.kind: 'date'`, `grain: 'month'`) is drillable with no hierarchy; a `day` chart is not (negative control); a scatter is not; `category` with no hierarchy is not.
  - `visual:drillDown` answering 404 toasts "This chart could not drill down. Try again." and keeps `q`; `model:navigation` answering 404 leaves the date drill working.
  - With `matchMedia(PHONE_QUERY)` true, a tap opens the sheet "Drill into East · by state" and does not drill until it is pressed.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- exploreDrill` → "Cannot find module './useExploreDrill'".
- [ ] **Step 3: Implement** — the drilled question keeps `chartType`; its filters are `[...question.filters, ...reply.steps]` (the question's own steps unchanged, kept steps included).
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run lint`, `npm --prefix web run size`.
- [ ] **Step 5: Commit** — `git add web/src/features/visuals/drill/drillApi.ts web/src/features/explore` · "Drill in Explore with a click, and go back up by Back or the crumbs"

### Task 3: The field list nests each hierarchy's levels

**Files:** Modify `web/src/features/explore/FieldList.tsx` (the Dimensions group), `Explore.module.css`. Test: `web/src/features/explore/explore.test.tsx`.
**Interfaces:** `FieldList` gains `hierarchies?: readonly NavHierarchy[]`. Under Dimensions, each usable hierarchy whose levels are all in the list comes first, as a sub-heading "Geography" over its levels in order, indented, each the same field button as today. The other dimensions follow. A search matches level names and keeps a hierarchy's sub-heading over any level it matches. The `Field`s and `onPick` are unchanged.
- [ ] **Step 1: Write the failing test** — with Geography `region › state`, the Dimensions group's text reads `Geography`, `region`, `state`, then `customer_segment`. Searching `sta` shows `Geography` and `state` only. A hierarchy with `missing` is not nested (negative control). Clicking `state` still sends the same `withField` edit.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- explore` → no `Geography` heading.
- [ ] **Step 3: Implement** — a `group` with `aria-label="Geography"` inside the Dimensions section.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web -- explore`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/explore` · "Nest a hierarchy's levels in Explore's field list"

### Task 4: One e2e for the screen

**Files:** Modify `web/e2e/explore.e2e.ts` (the "editor takes a suggestion" test, `:141`), `web/e2e/fixtures.ts` (export `clickUntil`, moved from `web/e2e/dashboards.e2e.ts:278`), `web/e2e/dashboards.e2e.ts` (import it).
**Interfaces:** The test seeds Product `category › sub_category` on the sample's Retail orders through `catalog:setTable` (the e2e's `rpc` helper), opens Explore by category, clicks a bar until the crumb row shows, reads `Product › <category> · by sub_category`, checks the drilled bars against `visual:data` asked directly with the same encoding and filters (labels and values `Object.is`), then `page.goBack()` and sees the by-category answer again. The field list shows the `Product` sub-heading. Shot `explore-drill`, both themes. RPC budget 25 per load.
- [ ] **Step 1: Write the failing test** — as above.
- [ ] **Step 2: Run it to see it fail** — `npm run build:web && npm --prefix web run e2e -- explore` → no crumb row.
- [ ] **Step 3: Implement** — the helper move only.
- [ ] **Step 4: Run it to see it pass** — `npm --prefix web run e2e -- explore dashboards`; look at `web/e2e/__screens__/explore-drill-*.png` in both themes.
- [ ] **Step 5: Commit** — `git add web/e2e` · "Cover Explore's drill end to end"

## Existing tests that must stay green

Web `explore.test.tsx`, `spec.test.ts`, `Question.test.tsx`, `dockRoute.test.tsx`, every `__golden__` test; e2e `explore`, `dashboards`, `live`; `npm --prefix web run size`.
