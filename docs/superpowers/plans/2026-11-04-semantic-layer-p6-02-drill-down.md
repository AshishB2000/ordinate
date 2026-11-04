# Semantic layer part 6, step 02: `visual:drillDown` and the date ladder — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One read channel that turns a clicked mark into the exact filter steps behind it and the next level's encoding (a hierarchy's next text column, or the date ladder's next grain), refusing with the rows panel's own sentence whenever the mark cannot be resolved exactly. Server only.
**Architecture:** `src/ipc/drillScope.ts` splits into `drillInputs` (sanitize, bind parameters, a metric's filters, the chart's grain) and `drillFilters` (= `resolveDrill` over those inputs, unchanged for `visual:rows`). The new `src/ipc/drillDown.ts` calls `drillInputs` with the Live grain lookup on, resolves the mark on the encoding **without its split**, finds the next level with `drillLevels.ts` (step 01), and answers `{ encoding, steps, crumb }`. The browser then asks `visual:data` / `analysis:tiles` with that encoding and `filters + steps`: nothing new computes a figure.
**Tech Stack:** `src/ipc`, `src/analysis/driverScope.ts` (`bucketRange`, `periodStep`, `rangeLabel`), the Live executor, self-checks.
**Spec:** docs/semantic-layer/06-navigation.md (D3, D4, D5, D10, D11; Tests) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p6-00-index.md
**Branch and PR:** `feat/semantic-p6-02-drill-down` off `origin/develop` after step 01 merges, one PR. Precondition: the `resolveDrill` joined-category fix from the other session. If it has not merged, Task 0 here carries it.

## Global Constraints

- `visual:rows` and `visual:rowsDownload` answer byte-identically after the split (`test-drillScope`, `test-visual-rows` unchanged).
- Drill and the rows panel resolve through the same `drillInputs` → `resolveDrill`, so a refusal is the same sentence (D5). New sentences only for what is drill-specific (no hierarchy, last level, finest date, a chart that does not drill), in new `src/ipc/drillMessages.ts` through `t()`.
- A split chart drills its axis and keeps every series: the mark is resolved on `withoutSplit(enc)` with no `series`; the drilled encoding keeps `series`.
- The grain lookup asks `vizDataFor` with the chart's FULL encoding and filters (split included), so it is the tile's own question and hits the answer cache (extract) or the Live executor's cache. On Live it runs too (D4), counted against `LIVE_DAILY_QUERY_LIMIT` when it misses.
- A failed grain lookup with a `code` (Live refused, timed out, row policy, term) is answered as that failure, typed, never as the "rolled up to a period" sentence.
- Drill steps are plain `type: 'filter'` steps (`=` or a `custom` period), never `fromControl` (part 1 D9).
- `src/ipc/visuals.ts` (773) takes at most the 3 lines of Task 0; the handler, its messages and its types live in new files. `'../ipc/drillDown'` joins the array at `src/server/app.ts:602`.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A child counted under two parents** ("Springfield" in two states). Every drill carries the whole path. → Task 3's negative control.
- **A drilled chart that disagrees with its bar.** → Task 3's walk: each parent bar equals the sum of its children, and each child equals the rows behind it.
- **A joined category drilled through a same-named main-table column** (today's rows-panel bug). → Task 0.
- **Live cost.** The grain lookup must be a cache hit after the tile was drawn. → Task 3 counts `fake.calls`.
- **The retail calendar.** Its months are periods that hold whole weeks, so month → week → day; a Gregorian week drills to days, because it can straddle two months. → Task 3, both calendars.

## Rolling deploys

No stored field. During the rollout a release-A pod 404s `visual:drillDown`: the web (steps 03, 04) shows a toast and today's rows drawer.

---

### Task 0 (only if the fix has not merged): the rows panel refuses a joined category

**Files:** Modify `src/ipc/visuals.ts:201-205` (`resolveDrill`, after the category check). Test: extend `scripts/test-visual-rows.ts`.
**Interfaces:** `resolveDrill` refuses when `encoding.categoryDatasetId` is set, or when the chart splits and `encoding.seriesDatasetId` is set, with the literal "“{column}” comes from a related dataset, so the rows behind this mark cannot be listed here." (`resolveDrill`'s sentences are literals, as its siblings are).
- [ ] **Step 1: Write the failing test** — Orders and Customers both hold `region`, related many-to-one. `visual:rows` with `{ category: 'region', categoryDatasetId: CUST, values: [sum amount] }` and mark `{ category: 'West' }` → `available === false` with that sentence. NEGATIVE CONTROL: the same mark without `categoryDatasetId` answers rows.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-visual-rows.js` → the rows of Orders' own `region = 'West'` come back.
- [ ] **Step 3: Implement** — two lines.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-visual-rows.js`, `node scripts/test-drillScope.js`, `node scripts/test-file-size.js`.
- [ ] **Step 5: Commit** — `git add src/ipc/visuals.ts scripts/test-visual-rows.ts` · "Refuse the rows behind a mark whose category comes from a related dataset"

### Task 1: Split the drill scope into its inputs and its resolution

**Files:** Modify `src/ipc/drillScope.ts:36-63`. Test: `scripts/test-drillScope.ts` and `scripts/test-visual-rows.ts` run unchanged.
**Interfaces:** Produces
```ts
export interface DrillInputs { columns: ParsedColumn[]; enc: VizEncoding; filters: FilterStep[]; mark?: DrillMark; grain?: DateGrain }
export type DrillInputsResult = { ok: true; inputs: DrillInputs } | { ok: false; reason: string } | { ok: false; failure: Extract<VizDataReply, { ok: false }> };
export async function drillInputs(projectId: string, datasetId: string, meta: { columns: ParsedColumn[]; mode?: unknown }, req: DrillRequest, opts?: { liveGrain?: boolean }): Promise<DrillInputsResult>;
export async function drillFilters(projectId, datasetId, meta, req): Promise<DrillResolution>; // unchanged signature: drillInputs, then resolveDrill
```
`failure` is set only when the grain lookup's reply is `ok: false` with a `code`; `drillFilters` ignores it (today's behaviour: no grain, so resolveDrill's own sentence).
- [ ] **Step 1: Write the failing test** — a pure-module check in `scripts/test-drillScope.ts`: `drillInputs` on a dated mark returns `inputs.grain === 'month'` (the chart's grain), and with `{ liveGrain: true }` on the suite's Live-free fixture it returns the same (negative control: on an extract the option changes nothing).
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-drillScope.js` → "has no exported member 'drillInputs'".
- [ ] **Step 3: Implement** — move the body; the `isLive(meta)` skip becomes `isLive(meta) && !opts?.liveGrain`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-drillScope.js`, `node scripts/test-visual-rows.js`, `node scripts/test-liveSafetyNet.js` (all unchanged and green).
- [ ] **Step 5: Commit** — `git add src/ipc/drillScope.ts scripts/test-drillScope.ts` · "Split the rows-behind-a-mark scope into its inputs and its resolution"

### Task 2: `visual:drillDown`

**Files:** Create `src/ipc/drillDown.ts`, `src/ipc/drillMessages.ts`, `scripts/test-drillDown.ts` (harness of `scripts/test-drillScope.ts`: temp `ORDINATE_LOCAL_DIR`, the `handlers` map). Modify `src/api/visuals.ts:108-118` and `:192` (the contract after `visual:rows`), `src/server/app.ts:602` (`'../ipc/drillDown'` in the array), `scripts/rowPolicyReaders.ts` (`'visual:drillDown': 'DOOR'`), `scripts/test-liveSafetyNet.ts:144-219` (a row reader, routed), `scripts/i18n-extract.ts` (`MAIN_FILES`), `scripts/termSites.ts` (classify `drillDown.ts`'s `sanitizeFilters(` site as `keeps`).
**Interfaces:** Consumes `drillInputs`, `resolveDrill`, `nextLevel`/`levelOf`/`nextGrain`/`dateLadder`/`navHierarchies` (step 01), `getTableDoc` (part 1), `activeWeekCal`, `rangeLabel` (`src/analysis/driverScope.ts:190`), `labelPairsForValues` (part 1 step 06, `src/ipc/valueLabelReplies.ts`). Produces
```ts
// src/api/visuals.ts — the Drill shape without metricId; the mark is required
'visual:drillDown': rpc({ access: 'read', input: z.strictObject({ ...DrillShape, mark: z.strictObject({ category: Cell, series: Cell.optional() }) }), project: byProjectId })
// src/ipc/drillDown.ts
export interface DrillCrumb { column: string; label: string; next: string } // label: the mark as people read it; next: a column name or a grain
export type DrillDownReply =
  | { ok: true; available: true; encoding: VizEncoding; steps: FilterStep[]; crumb: DrillCrumb }
  | { ok: true; available: false; reason: string }
  | { ok: false; error: string; code?: string; reason?: string };
export async function drillDown(projectId: string, datasetId: string, req: DrillRequest): Promise<DrillDownReply>;
```
The algorithm, in this order:
1. No dataset → `{ ok: false, error: 'Dataset not found' }`. An encoding with `pivot`, `cohort`, `eventFunnel`, `drivers` or `facet` → `drillNotThisChart()` "This chart does not drill down. ⋯ → Show the rows lists what is behind it."
2. `drillInputs(…, { liveGrain: true })`. A `reason` → `available: false` with it; a `failure` → that reply as it is (typed).
3. `resolveDrill(columns, withoutSplit(enc), filters, { category: mark.category }, grain)`. Not available → its `reason` (the rows panel's own sentence: map, raw points, number axis, blank, Other, a related dataset). `withoutSplit` drops `series` and `seriesDatasetId`.
4. The next level. A date category: `nextGrain(dateLadder(!!activeWeekCal()), grain)`, null → `drillFinestDate()` "A day is the finest level a date drills to." A text category: `nextLevel(navHierarchies(doc.hierarchies ?? [], columns), enc.category)`; null → `drillLastLevel(column, name)` "{column} is the last level of {name}." when `levelOf` finds it, else `drillNoHierarchy(column)` "{column} is not a level of a hierarchy. An editor can add one on the Data model's Fields tab."
5. `steps` = the resolution's filters after the request's own. Encoding: text → `{ ...enc, category: next }` with no `grain`, `bins` or `overlay`; date → `{ ...enc, grain: next }`.
6. `crumb.label`: text → the value's label from `labelPairsForValues`, else `String(value)`; date → `rangeLabel({ from, to })` of the period step.
- [ ] **Step 1: Write the failing test** — `scripts/test-drillDown.ts` § shape, on a fixture with the sample's columns (`region`, `state`, `city`, `category`, `sub_category` text; `order_date` date; `revenue` whole numbers) and Geography `region › state › city` saved through `catalog:setTable`:
  ```ts
  const r = await call('visual:drillDown', { projectId: P, datasetId: D, encoding: BY_REGION, mark: { category: 'East' } });
  ok('region East → by state, one = step', r.available && r.encoding.category === 'state' && stableStringify(r.steps) === stableStringify([{ type: 'filter', column: 'region', op: '=', value: 'East' }]) && r.crumb.label === 'East' && r.crumb.next === 'state');
  ok('a split chart keeps its split and drills its axis', ((s) => s.available && s.encoding.series === 'category' && s.steps.length === 1)(await call('visual:drillDown', { …BY_REGION_SPLIT, mark: { category: 'East', series: 'Furniture' } })));
  ok('the last level says so', (await drill(BY_CITY, 'Springfield')).reason === drillLastLevel('city', 'Geography'));
  ok('a month drills to days, with the exact range', ((m) => m.encoding.grain === 'day' && m.steps[0].op === 'period' && m.steps[0].period.from === '2024-03-01' && m.steps[0].period.to === '2024-03-31' && m.crumb.label === 'Mar 2024')(await drill(BY_MONTH, '2024-03')));
  ok('a Gregorian week drills to days', (await drill(BY_WEEK, '2024-03-04')).encoding.grain === 'day');
  ok('a day is the finest', (await drill(BY_DAY, '2024-03-04')).reason === drillFinestDate());
  ok('a pivot does not drill', (await drill(PIVOT, 'East')).reason === drillNotThisChart());
  for (const [label, enc, mark] of REFUSALS) { // blank label, 'Other', a number axis, raw points, a map, a related category
    ok(`refusal (${label}) is the rows panel's sentence`, (await drill(enc, mark)).reason === (await call('visual:rows', { projectId: P, datasetId: D, encoding: enc, mark: { category: mark } })).reason);
  }
  ok('NEGATIVE CONTROL: a column in no hierarchy', (await drill(BY_CATEGORY, 'Furniture')).reason === drillNoHierarchy('category'));
  ```
  `test-liveSafetyNet.ts`: `['drill down', 'visual:drillDown', { projectId: P, datasetId: d, encoding: { category: 'day', values: [{ column: 'sales', aggregation: 'sum' }] }, mark: { category: '2024-01' } }]` in `ROW_READERS` and `'drill down'` in `ROUTED`: on Live it answers through the warehouse (the grain lookup); with the connection gone it is a typed failure.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-drillDown.js` → `No handler for visual:drillDown`; `node scripts/check-contracts.js` lists it unresolved.
- [ ] **Step 3: Implement** — as above. The handler is a try/catch around `drillDown` → `{ ok: false, error: err?.message || 'The drill could not be worked out.' }`, as `visual:rows` has (`src/ipc/visuals.ts:713-715`). A typed refusal (Live, row access, term) arrives as the grain lookup's reply (algorithm step 2), never as a throw, so nothing typed is lost there. Then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-drillDown.js`, `node scripts/check-contracts.js` (0), `node scripts/test-liveSafetyNet.js`, `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js`, `node scripts/test-termSites.js`, `node scripts/test-i18n.js`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add src/ipc/drillDown.ts src/ipc/drillMessages.ts src/api/visuals.ts src/server/app.ts scripts/rowPolicyReaders.ts scripts/test-liveSafetyNet.ts scripts/i18n-extract.ts scripts/termSites.ts src/i18n scripts/test-drillDown.ts` · "Turn a clicked mark into the exact steps behind it and the next level"

### Task 3: The differential walk, Springfield, both calendars, Live and row access

**Files:** Extend `scripts/test-drillDown.ts` (§ walk, § live, § calendar); `scripts/test-rowPolicySafetyNet.ts`.
**Interfaces:** Consumes `visual:data`, `visual:rows`, `scripts/liveRouteHarness.ts` (`post`, `hydrates`, `H.fake.calls`), the parity fixture's extract X and Live L (text `cat`, `region`; date `d`).
- [ ] **Step 1: Write the failing test** — § walk: for every bar of `BY_REGION`, drill, draw the drilled chart (`visual:data` with `filters: [...f, ...steps]`), and for every child bar fetch its rows with `visual:rows` and sum `revenue` in JS:
  ```ts
  ok(`${region}: the children add up to the bar`, Object.is(sum(child.values), parentValue));
  ok(`${region} › ${state}: the child is exactly its rows`, Object.is(jsSum(rowsOf(child)), childValue));
  ok(`${region}: the steps are the rows panel's`, stableStringify(r.steps) === stableStringify((await rows(BY_REGION, region)).filters)); // the parent chart has no filters of its own
  ```
  The same walk down `order_date` from year to day, then again with the workspace calendar on 4-5-4 (`month` → `week` → `day`). Fixture: at most 50 children per parent, so no Other bucket. § Springfield: `city = 'Springfield'` planted under two states; drilled under Ohio, the Springfield bar equals the Ohio rows only, and NEGATIVE CONTROL: the same chart without the `state` step draws a bigger Springfield. § live: draw L by `d` (one statement), then drill a month: `fake.calls` grows by 0 (the grain lookup is the tile's cached question); the drilled chart adds 1; `hydrates(L, …)` is false throughout; labels and values `Object.is` X's same drilled chart (parity). If the drill costs a statement, find why the two questions differ (most likely `params` or the encoding's sanitized form) and make them one; a measured remaining cost goes in the PR description. `test-rowPolicySafetyNet.ts`: `east` drills Orders by region; east's drilled chart equals east's own `visual:data` for the same encoding and filters built by hand, cell by cell with `Object.is`; NEGATIVE CONTROL: the editor's drilled chart differs.
- [ ] **Step 2: Run it to see it fail** — `node scripts/test-drillDown.js`. A failure here is a real bug in Tasks 1–2. If every walk passes at once, prove the walk can fail: make `nextGrain` skip `week` by hand, see § calendar fail, and restore it.
- [ ] **Step 3: Implement** — only what the failures show; no new production module.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-drillDown.js`, `node scripts/test-retailCalendar.js`, `node scripts/test-liveParity.js`, `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js`.
- [ ] **Step 5: Commit** — `git add scripts/test-drillDown.ts scripts/test-rowPolicySafetyNet.ts` (and any fix) · "Prove a drill selects exactly its bar's rows, on every level, both calendars and Live"

## Existing tests that must stay green

`test-drillScope`, `test-visual-rows`, `test-visualsServer`, `test-vizData`, `test-retailCalendar`, `test-liveSafetyNet`, `test-liveRoute`, `test-liveParity`, `test-rowPolicySafetyNet`, `test-rowPolicy`, `test-termSites`, `test-termDoors`, `test-asyncReach`, `test-i18n`, `test-file-size`, `check-contracts`; every golden fixture.
