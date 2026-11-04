# Semantic layer part 6, step 04: Dashboard tiles drill — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a dashboard's view page and in Present, a drillable tile offers "Drill into East · by state" beside "Show the rows behind East": in the point menu a plain click opens, in the right-click menu, and in the phone's tap sheet. The drilled tile shows crumbs and Up; every ⋯ action acts on what the tile shows; nothing else on the sheet changes; a reload starts at the saved level.
**Architecture:** A tile's drill is reader view state beside `tileSteps` in `useViewer` (never saved, never in the URL, a saved view or a subscription). `tileFilters` (`web/src/features/dashboards/CardRuntime.tsx:70-74`) appends the drill's steps, and `drilledDef` swaps in the drilled encoding, so the tile, the rows drawer, Explain and the ⋯ menu all read one drilled definition. A drill asks `visual:drillDown` (step 02) and then the ordinary tile batch. `model:navigation` loads on the first mark click, so a dashboard's page load makes no new RPC.
**Tech Stack:** React 19, TanStack Query, the chart engine's hit tests (`markAt`, `pointAt`), Vitest, Playwright.
**Spec:** docs/semantic-layer/06-navigation.md (D5, D6, D7, D9, D10, D11; owner's answers 1 and 2) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p6-00-index.md
**Branch and PR:** `feat/semantic-p6-04-dashboard-drill` off `origin/develop` after step 03 merges, one PR.

## Global Constraints

- A plain click keeps its order (D7): 1. the tile's click actions; 2. click-to-filter when `clickFilterOn` (`web/src/features/analyses/editor/filters.ts:80`); 3. on a drillable mark, the point menu (Drill into, Show the rows behind, and Explain on a time axis); 4. otherwise the rows drawer, as today. **Code note:** new dashboards and new sheets are saved with click-to-filter on (`src/analysis/analysis.ts:375`, `web/src/features/analyses/editor/Head.tsx:104`), so on them a plain click still filters and drilling is the right-click menu's and the phone sheet's. This plan follows D7; the owner is told.
- Drill only where the dashboard is read: `ed.viewing || ed.view.presenting`. The editor's canvas and the builder have none (D6). Published `/p/` pages and embeds have their own renderer and fetch nothing: unchanged (answer 2).
- Drillable is step 03's `drillableAxis`: the type is in `DRILL_CHART_TYPES` (so no map, table, grid, scatter, KPI or waterfall), and either the axis is a date with a next grain or a text level with a next level. A tile whose category comes from a related dataset is refused by the server (step 02 Task 0).
- A drill never filters other tiles. While a tile is drilled, its click-to-filter is off and its comment pins are hidden, because pins name points at the saved level (D7, D5).
- `visualId` stays on the drilled tile request: only a waterfall reads it (`storedFigureAsk`, `src/ipc/rowDoors.ts:252`), and a waterfall never drills.
- RPC budget: a dashboard's page load is unchanged. The first drill adds three reads (`model:navigation`, `visual:drillDown`, one tile read), and Up is a cached tile.
- `CardRuntime.tsx` (315 lines) grows by under 40: the drill logic lives in new `useTileDrill.tsx`. `useViewer.ts` (207) grows by under 25.
- `scripts/termSites.ts`: re-count the web files whose `mergeFilters(` or `type === 'filter'` matches change.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **The drawer and the drill read one definition.** After a drill, "Show the rows", Explain and the right-click entries read the drilled encoding and the drilled filters. → Task 2 asserts the `visual:rows` payload.
- **Other tiles are untouched**, and so is a saved view: applying one (`restore`) clears every drill. → Task 1.
- **A phone** gets the entry in its existing sheet, not a new gesture. → Task 3.
- **An older pod**: `model:navigation` or `visual:drillDown` answering 404 leaves today's click (the drawer). → Task 2.

## Rolling deploys

No stored field: drill state is the reader's, in memory. A release-A pod 404s both new reads, which the tile treats as "not drillable".

---

### Task 1: Drill state beside `tileSteps`

**Files:** Create `web/src/features/dashboards/tileDrill.ts`, `tileDrill.test.ts`. Modify `web/src/features/dashboards/useViewer.ts:45-75` (the `Viewer` interface) and `:168-207` (the memo), `web/src/features/dashboards/CardRuntime.tsx:70-74` (`tileFilters` appends the drill's steps).
**Interfaces:** Consumes `DrillCrumb` (step 02's reply type, mirrored in `web/src/features/visuals/drill/drillApi.ts`). Produces
```ts
export interface TileDrillLevel { encoding: Encoding; steps: Step[]; crumb: { label: string; next: string; word: string } }
export interface TileDrill { root: string; levels: TileDrillLevel[] }           // root: the hierarchy's name, or "All dates"
export function drilledDef<D extends { encoding: Encoding }>(def: D, drill: TileDrill | undefined): D; // the last level's encoding
export function drillSteps(drill: TileDrill | undefined): Step[];               // every level's steps, in order
// Viewer
drills: ReadonlyMap<string, TileDrill>;
drillInto(cardId: string, root: string, level: TileDrillLevel): void;
drillUp(cardId: string, keep: number): void;                                    // keep 0 = the saved level
```
- [ ] **Step 1: Write the failing test** — `tileDrill.test.ts`: `drilledDef(def, undefined) === def` (the same object); after two levels, `drilledDef(def, d).encoding === d.levels[1].encoding` and `drillSteps(d)` is both levels' steps in order. A `renderHook(useViewer)`: `drillInto('A', 'Geography', L1)` leaves `tileSteps('B')` and `drills.get('B')` empty; `drillUp('A', 0)` deletes A's entry; `restore([], new Map(), null)` clears every drill. `tileFilters(ed, 'A')` ends with A's drill steps and `tileFilters(ed, 'B')` is unchanged (negative control).
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- tileDrill` → "Cannot find module './tileDrill'".
- [ ] **Step 3: Implement** — `tileFilters` becomes `[...own, ...narrow, ...drillSteps(ed.view.drills.get(cardId))]` (unchanged when there is no drill).
- [ ] **Step 4: Run it to see it pass** — `npm run test:web -- tileDrill dashboards`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/dashboards/tileDrill.ts web/src/features/dashboards/tileDrill.test.ts web/src/features/dashboards/useViewer.ts web/src/features/dashboards/CardRuntime.tsx` · "Keep a tile's drill as reader view state beside its narrowing"

### Task 2: The point menu, the right-click entry, crumbs and Up

**Files:** Create `web/src/features/dashboards/useTileDrill.tsx`, `web/src/features/dashboards/tileDrillMenu.test.tsx`. Modify `web/src/features/dashboards/CardRuntime.tsx`: `drillTarget` and `explainTarget` (`:36-63`) take the drilled def; `menu` (`:116-159`) reads `drilledDef(def, ed.view.drills.get(card.id))`; and in `VisualCard` (`:187-301`) the `mark` fallback (`:266-268`) runs D7's order, `pointItems` (`:239-245`) gains "Drill into", the pins (`:208`) are `[]` while drilled, and the crumb row draws above `VisualTileBody`. Also modify `web/src/features/analyses/VisualTile.tsx:224-243` (the click passes `{ shown, time, grain }` as `onMark`'s fourth argument: the drawn label, and the server's `category.kind` and `grain`).
**Interfaces:** Consumes `loadNavigation`/`navFor` (step 01), `drillDown`, `drillableAxis` (step 03, `web/src/features/visuals/drill/drillApi.ts`), `DrillCrumbs` (step 03), `levelOf`, `PointMenu`. Produces `useTileDrill(ed, card, def): { def: VisualDef; drilled: boolean; crumbs: ReactNode | null; offer(at: { category: string | number; series?: string; shown: string; time: boolean; grain?: DateGrain }): Promise<MenuEntry | null>; }`.
- `offer` returns null when the tile cannot drill: not reading, a type outside the list, no navigation (any failure), no next level. Otherwise it returns the entry `Drill into <shown> · by <word>`. Its `onSelect` asks `visual:drillDown` with the tile's drilled encoding, `mergeFilters(tileFilters(ed, card.id), def.filters)`, `ed.params` and the mark. Then:
  - available → `ed.view.drillInto(card.id, root, { encoding, steps, crumb })`, where `root` is the hierarchy's name (`levelOf`) or "All dates";
  - refused → an info toast with the server's sentence;
  - failed → "This chart could not drill down. Try again."
- The plain click (D7 step 3): when `offer` gives an entry, the point menu opens at the click with `[entry, Show the rows behind <shown>, Explain this change (time axes, as today)]`; when it gives null, `setDrill(...)` opens the drawer as today.
- The crumb row: `DrillCrumbs` with `root` (to `drillUp(id, 0)`), then each level's `crumb.label` (to `drillUp(id, i + 1)`), the last one as text, `by` = the last level's `crumb.word`, and Up = `drillUp(id, levels.length - 1)`.
- [ ] **Step 1: Write the failing test** — `tileDrillMenu.test.tsx` renders a view-page `VisualCard` with a stubbed chart hit (as the existing `CardRuntime` tests do) and `serve()` answering `model:navigation` with Geography `region › state`:
  - A plain click on `East`, with click-to-filter off, opens a menu whose items read `['Drill into East · by state', 'Show the rows behind East']`. "Drill into" sends `visual:drillDown`, then the tile asks `analysis:tiles` with `encoding.category === 'state'` and filters ending in `region = East`.
  - The crumbs read `Geography › East · by state`; Up asks nothing (cached) and draws by region.
  - After the drill, "Show the rows" from ⋯ sends `visual:rows` with the drilled encoding and the region step. A plain click on a child opens the menu without a Drill entry at the last level (negative control: `Show the rows behind Ohio` only, then the drawer as today).
  - With click-to-filter on, a plain click filters (the sheet's chips), and the right-click menu holds `Drill into East · by state`.
  - On the editor's canvas (`viewing: false`) a click opens the drawer and never asks `model:navigation`.
  - `model:navigation` answering 404 → the drawer, as today. `visual:drillDown` answering 404 → the error toast, and the tile is unchanged.
  - While drilled, the tile draws no comment pin, and a click does not filter.
  - A month line chart with no hierarchy offers `Drill into Mar 2024 · by day`.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- tileDrillMenu` → "Cannot find module './useTileDrill'".
- [ ] **Step 3: Implement** — the right-click's `pointItems` put the drill entry first when `offer` gives one; `onPinAt` is off while drilled.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run lint`, `npm --prefix web run size`.
- [ ] **Step 5: Commit** — `git add web/src/features/dashboards web/src/features/analyses/VisualTile.tsx scripts/termSites.ts` · "Drill into a dashboard tile from its point menu, and back up by its crumbs"

### Task 3: The phone's sheet

**Files:** Modify `web/src/features/dashboards/CardRuntime.tsx:247-265` (`tapActions` puts the drill entry first). Test: extend `tileDrillMenu.test.tsx`; `web/e2e/phone.e2e.ts` (the point sheet test, `:173`).
**Interfaces:** The sheet entry reads `Drill into <shown>` with hint `By <word>, on this chart only`. The sheet loads `model:navigation` when it opens, so its entry list is async. It shows a one-row skeleton until the read settles, then the entry or nothing.
- [ ] **Step 1: Write the failing test** — with `size: 'phone'`, a tap on `East` opens `PointSheet` whose first button is `Drill into East`; pressing it drills as on desktop. With no hierarchy the sheet is today's list, unchanged (negative control). e2e `phone.e2e.ts`: after seeding Product `category › sub_category` (`catalog:setTable`), the sheet on "Revenue by category" shows `Drill into …`; pressing it shows the crumb row at 375 px with no sideways scroll; shot `phone-drill`.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- tileDrillMenu` → the sheet's first button is `Filter to “East”`.
- [ ] **Step 3: Implement** — `tapActions` awaits nothing: `offer` runs when the tap opens the sheet, and the result lands in state.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run build:web && npm --prefix web run e2e -- phone`.
- [ ] **Step 5: Commit** — `git add web/src/features/dashboards web/e2e/phone.e2e.ts` · "Offer the drill in the phone's point sheet"

### Task 4: The view page end to end, and no drill on `/p/`

**Files:** Modify `web/e2e/dashboards-view.e2e.ts`, `web/e2e/published-access.e2e.ts`.
**Interfaces:** `dashboards-view.e2e.ts`, on the sample's Retail overview view page after seeding Product `category › sub_category`:
- Right-click a "Revenue by category" bar, then `Drill into <category> · by sub_category`.
- The crumb row reads `Product › <category> · by sub_category`. The tile's bars equal `visual:data` asked directly with the drilled encoding and filters (labels and values `Object.is`), and the other tiles' requests are unchanged.
- Up redraws by category.
- RPC accounting: the page load equals the count before this step; the first drill adds exactly `model:navigation`, `visual:drillDown` and one `analysis:tiles`; Up adds none. Log `rpc: dashboard drill <n>`.
- Shot `tile-drilled` in both themes.

`published-access.e2e.ts`: a click on a `/p/` chart bar makes no `/api/rpc/` request.
- [ ] **Step 1: Write the failing test** — as above.
- [ ] **Step 2: Run it to see it fail** — `npm run build:web && npm --prefix web run e2e -- dashboards-view` → no "Drill into" item.
- [ ] **Step 3: Implement** — nothing beyond Tasks 1–3; fix only what the run shows. Before calling it done, grep `web/e2e` for plain clicks on a view-page tile whose axis is a date: that click now opens the point menu. Update any such step to pick "Show the rows behind …".
- [ ] **Step 4: Run it to see it pass** — `npm --prefix web run e2e -- dashboards-view published-access phone explainChange dashboards saved-views`; look at every `tile-drilled-*` and `phone-drill-*` screen.
- [ ] **Step 5: Commit** — `git add web/e2e` · "Cover the tile drill on the view page, and its absence on published pages"

## Existing tests that must stay green

Web dashboard and analyses Vitest suites (`CardRuntime`, `VisualTile`, `tileActions`, `filters`, `useViewer`), `doors.test.tsx`; e2e `dashboards`, `dashboards-view`, `phone`, `explainChange`, `saved-views`, `published-access`, `embed`, `liveTiles`; `npm --prefix web run size`; `test-termSites`.
