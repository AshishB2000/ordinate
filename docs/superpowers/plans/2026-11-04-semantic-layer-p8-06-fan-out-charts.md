# Semantic layer part 8, step 06: fan-out for charts — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chart on the one side of a relationship (Customers) can show measures from its many sides (Orders, Returns). Each number equals the same measure on its own table's chart by that category. Today's refusal becomes an answer only when the answer is unambiguous; every other case keeps refusing with a sentence. No chart that answers today changes.
**Architecture:** Drill-across (approach A).
- A pure planner splits the chart into one question per table its measures live on: P's own measures stay P's question, and each many side M gets a question on M by the same category.
- Each question is phrased in the **public** encoding fields: `categoryDatasetId` plus `categoryVia`, and a filter's `via` (part 1 step 09). The planner proves, with step 09's `viaPath`, that each phrasing resolves to exactly D10's pinned path (M→J, then P's path from J). A phrasing that would resolve otherwise is refused, so no internal field and no cache-key gap exist.
- Every question goes through `vizDataFor` (row access, Live, the answer cache, resident or JS).
- Replies line up by label, with the first reply's auto grain pinned on the rest (as `metricMeasureData` does).
- The tile gets `notes` (part 1 05b) saying which measures count their own rows and which filters narrow only some measures.
**Tech Stack:** `src/analysis/joinPlan.ts` (step 09's `viaPath`, `reachable`, `findPath`, `resolveColumnOwner`), new `src/analysis/fanOutPlan.ts`, new `src/ipc/vizFanOut.ts` and `src/ipc/lineUp.ts`, `src/ipc/visuals.ts`, `src/ipc/relationships.ts`, `src/ipc/rowDoors.ts`.
**Spec:** docs/semantic-layer/08-engine.md (D9–D11, D13–D15; Tests "Fan-out"; owner's answers 2 and 3) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p8-00-index.md
**Branch and PR:** `feat/semantic-p8-06-fan-out-charts` off `origin/develop`, after part 1's step 09 (labelled joins) and step 05b (`notes`) merge. One PR. Independent of steps 00a–05.

## Global Constraints
- **Unchanged:** every `test-joins` and `test-joinsVia` case byte for byte. `resolveVizJoin`, `findPath`, `planPaths`, `joinJs` and `joinResident` are not edited. A chart with no many-side measure never reaches the planner: `planFanOut` returns null, and today's path runs, refusal included.
- **No new math.** The line-up only places figures the door returned; it never sums, averages or rounds.
- **Owner's answer 2:** an M row matching no P row falls in the blank category, exactly as on a chart built on M.
- **Owner's answer 3:** a filter only a many side has narrows that side's measures, and the tile says so.
- **Still refused, each with its own sentence** (D13):
  - a category or split from a many side with a one-side measure;
  - a category not on P's path through J;
  - a folded text axis (over 50 values) or bins across questions (`measureNeedsOneAxis`'s rule);
  - pivot, cohort, funnel, facet and map;
  - a Live dataset anywhere in the chart (D15).
- **Row access, D14:** no new refusal and no new opening.
  - A caller locked on P is refused by the OUTER gate, because the measure names its dataset (`values[].datasetId` → `namedDatasets` → `reachesOther`).
  - Each sub-question is gated by its own door.
  - `chartReads` learns every table of every question, so `relatedClosed` and the publish scopes check and record them all.
- **Size:** `src/ipc/visuals.ts` is 773 lines: two lines (→ 775). `src/ipc/relationships.ts` is 314: one export and one call. `src/ipc/rowDoors.ts` is 280: one test seam. Everything else goes in new files under 300 lines.
- Sentences go through `t()` in a new `src/analysis/fanOutMessages.ts`, appended to `MAIN_FILES`. Names are formatted before `t()`: quoted and comma-joined, with no locale-built lists (my call).

## Old pods (rolling deploy and rollback)
No stored field. A chart with a many-side measure saves today in the same shape, and today it is refused (`findPath`'s sentence). During the rollout one pod refuses that tile and another draws it: loud, never a wrong figure. Each sub-question uses the existing answer-cache keys of a plain chart on M (or P), so pods of both versions share them safely. `notes` exists since part 1 05b, so every browser draws it.

## Review Focus
- Orders reaches Regions two ways (by ship region directly; by customer region through Customers). "Revenue by region" on Customers must use the customer's region. A plain chart on Orders by Regions takes the ship region (breadth-first). → Task 1
- A bare filter `region = 'West'`, where both Customers and Orders have a `region` column: Orders' question must filter Customers.region (pinned with `via`), never Orders' own column. → Task 1
- A dashboard date control on Orders.order_date over a Customers tile narrows Revenue only. The Customers count is unaffected, and the note says so. → Task 2
- An analyst locked on Customers is refused before any sub-question runs, because a sub-question inside Customers' lock scope would read Orders unchecked (`closedReason`, `scope.locked === id`). → Task 3
- An Orders row with a null or unknown customer_id appears under the blank label, and is counted once. → Task 2

---

### Task 1: the planner (pure)
**Files:** Create `src/analysis/fanOutPlan.ts`, `src/analysis/fanOutMessages.ts`, `scripts/fanOutFixture.ts` and `scripts/test-fanOut.ts` (§ plan). Modify `scripts/i18n-extract.ts:346`.
**Interfaces:** Consumes `reachable`, `findPath`, `viaPath`, `resolveColumnOwner`, `Hop` and `DsInfo` (`src/analysis/joinPlan.ts`, as step 09 leaves it). Produces:
```ts
export interface FanQuestion { datasetId: string; encoding: VizEncoding; filters: FilterStep[]; measures: number[] } // measures: indexes into the chart's values
export type FanNote = { kind: 'ownRows'; measures: number[] } | { kind: 'narrows'; column: string; measures: number[] };
export interface FanOutPlan { questions: FanQuestion[]; notes: FanNote[] }
/** null: no measure sits on a many side, so today's path answers (or refuses) as it always has. */
export function planFanOut(primary: string, encoding: VizEncoding, filters: FilterStep[], rels: Relationship[], infos: Map<string, DsInfo>): { ok: true; plan: FanOutPlan } | { ok: false; error: string } | null;
```
**The rules:**
1. **What is a many side.** A measure whose `datasetId` D has `findPath(P, D)` ok belongs to P's question. It is a forward join, as today. If any measure's D is unrelated, return null (today's sentence). If any measure's D is reachable only against an arrow, it is a many side M, and the planner takes the chart.
2. **J and M→J.**
   - With a measure `via`, that relationship must have `from.datasetId === M` (one hop M→J), else refuse. My call: a multi-hop many side uses M's default path.
   - Without `via`, J is the first table in `[P, ...reachable(P).keys()]` that `reachable(M)` holds. M→J is `reachable(M).get(J)`.
3. **The category C** (`categoryDatasetId ?? P`, with step 09's `categoryVia`):
   - P's path to C must pass through J. Otherwise refuse with D13 row 2's sentence.
   - The pinned path is `R = M→J ++ (P's path from J to C)`. M's question gets `categoryDatasetId: C` and `categoryVia: last(R).relId`, but only when `viaPath(M, last(R).relId)` equals R hop for hop. When R is M's default path to C, `categoryVia` is left out, so the cache key equals a plain chart on M. When `viaPath` gives anything else, refuse (D13 row 2).
   - A C on a many side (not on P's tree) is refused with D13 row 1's sentence.
   - The split (`series`) follows the same rule.
4. **Filters** (D11), each in turn, its owner O being `f.datasetId` (05b), else `viaPath(P, f.via)`'s end, else `resolveColumnOwner(P, f.column)`:
   - **O on P's path through J:** P's question keeps f, and M's gets `{ ...f, via: last(R_O).relId }`, verified as in rule 3. The `via` is always set, so M's own same-named column is never read.
   - **O on P's tree but not through J:** P keeps f, and M's question doesn't get it. Note `narrows` (f.column, the measures it reaches).
   - **No owner from P, and `resolveColumnOwner(M, column) === M`:** only M's question gets f, bare. P's question drops it, so it does NOT skip with "unknown column". Note `narrows`.
   - **Neither:** every question keeps f, and each skips it with today's warning.
5. **What else is refused:** `pivot`, `cohort`, `eventFunnel`, `facet`, `geo` and `drivers` with a many-side measure (D13 row 4).
6. **Order and notes.** P's question comes first when P has measures. Then one question per (M, M→J) in measure order. Add `ownRows` when any M question exists.
- [ ] **Step 1: Write the failing test.** `scripts/fanOutFixture.ts`, written with `pqSync` as `test-joins.ts:30` does:
  - **Customers:** `id`, `segment`, `region`, `tier`, `signup` (date). It has a duplicate `id` (Rule 2).
  - **Orders:** `order_id`, `customer_id` (some null, some unknown), `ship_region`, `region`, `amount` (multiples of 0.25, so every sum is exact), `order_date`.
  - **Returns:** `customer_id`, `refund`.
  - **Regions:** `region`, `zone`.
  - **The relationships, in this order:** `R_OC` Orders.customer_id → Customers.id, `R_OR` Orders.ship_region → Regions.region, `R_RC` Returns.customer_id → Customers.id, `R_CR` Customers.region → Regions.region.

  ```ts
  const p = plan({ category: 'zone', categoryDatasetId: REGIONS, values: [M('id', 'count'), { ...M('amount', 'sum'), datasetId: ORDERS }, { ...M('refund', 'sum'), datasetId: RETURNS }] }, [F('region', '=', 'West'), F('order_date', '>=', '2024-01-01')]);
  ok('three questions: Customers, Orders, Returns', show(p.questions.map((q) => q.datasetId)) === show([CUSTOMERS, ORDERS, RETURNS]));
  ok("Orders' question reaches zone through Customers (R_CR), pinned, never ship_region", p.questions[1].encoding.categoryVia === R_CR);
  ok("the bare region filter reaches Orders as Customers.region (via R_OC), never Orders.region", show(p.questions[1].filters[0]) === show({ ...F('region', '=', 'West'), via: R_OC }));
  ok('order_date narrows Revenue only: Orders gets it, Customers and Returns do not, and the note says so', ...);
  ok('NEGATIVE CONTROL: a chart with only forward measures is not planned', planFanOut(ORDERS, { category: 'zone', categoryDatasetId: REGIONS, values: [M('amount', 'sum')] }, [], RELS, INFOS) === null);
  for (const [why, enc] of REFUSED) ok(`refused, with its sentence: ${why}`, ((r) => r && !r.ok && r.error === SENTENCE[why])(planFanOut(CUSTOMERS, enc, [], RELS, INFOS)));
  ```
  `REFUSED`: a category from Orders with a Customers count; a category on Regions reached only from Orders; a facet; a pivot; a map.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-fanOut.js` → module not found.
- [ ] **Step 3: Implement** the rules above. Then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-fanOut.js` (§ plan) and `node scripts/test-joins.js`, `node scripts/test-joinsVia.js` (untouched, green).
- [ ] **Step 5: Commit.** `git add src/analysis/fanOutPlan.ts src/analysis/fanOutMessages.ts scripts/i18n-extract.ts src/i18n scripts/fanOutFixture.ts scripts/test-fanOut.ts` · "Plan a chart with many-side measures as one question per table, on pinned paths"

### Task 2: the line-up, the door, the differential
**Files:**
- Create `src/ipc/lineUp.ts`, a pure move of `metricMeasureData`'s label line-up (`src/ipc/vizMetricMeasures.ts:83-104`, the `labels`, `rowOf` and `cell` part), and `src/ipc/vizFanOut.ts`.
- Modify `src/ipc/vizMetricMeasures.ts` (it uses `lineUp`), `src/ipc/visuals.ts` (two lines in `vizDataForUnlocked`, between the Live branch :472-473 and `ensureFresh` :474), and `src/ipc/relationships.ts` (export `projectModel`).

Test: `scripts/test-fanOut.ts` § answers.
**Interfaces:**
```ts
// src/ipc/lineUp.ts
export function lineUp(replies: Ok[]): { labels: (string | number)[]; keys: string[]; cell(reply: number, series: Series | undefined, key: string): number | null };
// src/ipc/relationships.ts
export async function projectModel(projectId: string, primary: string): Promise<{ rels: Relationship[]; infos: Map<string, DsInfo> }>; // listRelationships + modelInfos + live()
// src/ipc/vizFanOut.ts
export async function fanOutVizData(projectId: string, datasetId: string, encoding: VizEncoding, filters: FilterStep[],
  ask: (datasetId: string, e: VizEncoding, f: FilterStep[]) => Promise<VizDataReply>): Promise<VizDataReply | null>;
```
- `fanOutVizData` returns null when `planFanOut` does.
- It asks the questions: the first alone, then the rest with its auto grain pinned (`encoding.grain = first.category.grain`).
- More than one reply with `category.note` or `binned` is refused with the fold sentence.
- Labels line up first-seen across replies. With a split, series line up by name per question, as the split branch of `metricMeasureData` does.
- Series go in the chart's measure order. `warnings`, `fx` and `asOf` merge as `metricMeasureData` merges them.
- `notes` holds `fanOutOwnRows(names)` and one `fanOutNarrows(column, names)` per `narrows` note. The names are the replies' series names.
- The visuals.ts lines: `const fanned = await fanOutVizData(projectId, datasetId, encoding, filters, (d, e, f) => vizDataFor(projectId, d, e, f, opts));` and `if (fanned) return fanned;`. They sit after the Live branch, so a Live P refuses `related` as today. They sit before `ensureFresh` and the answer cache, so P's cache never holds an answer that M's data can change.
- [ ] **Step 1: Write the failing test.** The fixture is saved as datasets with relationships in a local project (`ORDINATE_LOCAL_DIR`, as `test-liveParity.ts` does).
  - Every case runs three ways, compared under `Object.is` (labels by `===`):
    - **resident-forced:** each question through `jr.joinedAggregateResident`, or `residentVizData` when it has no join;
    - **JS-forced:** `js.joinedVizDataJs` or `buildVizData`;
    - **brute force:** a plain loop over the fixture arrays that groups and aggregates with no engine code.
  - **The cases:**
    - measures on P, on one many side, and on two;
    - sum, avg, count, min and max, and part 5's `countd` (step 02 merges earlier in release B; cross-part check item 12): a distinct count of `customer_id` on Orders by Customers' `tier`;
    - a category on P, on J and on a forward table (Regions via Customers);
    - filters on P, J and a forward table, and one only Orders has;
    - an auto-grained date category (`signup`);
    - a split by `tier`;
    - orphans; an empty many side under a filter; the repeated customer id.
  ```ts
  for (const c of CASES) {
    const [res, js, brute] = [await viaAsk(c, residentAsk), await viaAsk(c, jsAsk), bruteForce(c)];
    ok(`${c.label}: resident === JS === brute force`, same(res, js) && same(js, brute), diff(res, brute));
    ok(`${c.label}: each series equals its own table's chart`, c.series.every((s, i) => same(seriesOf(res, i), seriesOf(await ownChart(c, i), 0))));
  }
  ok('orphans: the blank label holds Orders with no customer, counted once', blankRevenue(res) === bruteBlank);
  ok("NEGATIVE CONTROL: Orders' question asked without categoryVia (breadth-first, ship region) disagrees with brute force", !same(await askWithoutVia(ZONE_CASE), bruteForce(ZONE_CASE)));
  ok('the door: visual:data answers the same reply, with the notes', same(await post('visual:data', DOOR_CASE), res) && reply.notes!.length === 2);
  ok('NEGATIVE CONTROL: every test-joins case still refuses or answers as before', joinsUnchanged);
  ```
- [ ] **Step 2: Run it to see it fail.** → `visual:data` answers with `findPath`'s fan-out sentence.
- [ ] **Step 3: Implement.** Move the line-up first and run `node scripts/test-metricMeasures.js && node scripts/test-visualsServer.js` green (metric measures unchanged). Then add the fan-out.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-fanOut.js && for t in joins joinsVia visualsServer visuals metricMeasures dashboardFilters file-size; do node scripts/test-$t.js || break; done`.
- [ ] **Step 5: Commit.** `git add src/ipc/lineUp.ts src/ipc/vizFanOut.ts src/ipc/vizMetricMeasures.ts src/ipc/visuals.ts src/ipc/relationships.ts scripts/test-fanOut.ts` · "Answer a chart's many-side measures by drill-across through the chart door"

### Task 3: row access learns every question
**Files:** Modify `src/ipc/relationships.ts` (`chartReads` :104-107: when the join is refused, the union of `fanOutReads`), `src/ipc/vizFanOut.ts` (append `fanOutReads`), and `src/ipc/rowDoors.ts` (a seam beside `setRelatedGateForTest` :68). Test: `scripts/test-rowPolicyFanOutJoins.ts` (new, on `scripts/rowPolicyHarness.ts`).
**Interfaces:**
- `fanOutReads(projectId, datasetId, encoding, filters): Promise<string[]>` gives every question's dataset plus each question's own `chartReads`, each dataset once.
- `setNamedDatasetsCheckForTest(on: boolean)` (rowDoors.ts): off, `namedDatasets` ignores `values[].datasetId`. It exists only for the negative control.
- [ ] **Step 1: Write the failing test.**
  ```ts
  ok('locked on Customers: refused related, before any sub-question', H.refused(await asLocked('visual:data', FAN), 'related') && subQuestions === 0);
  ok('restricted on Orders: refused', H.refused(await asOrdersRestricted('visual:data', FAN), 'related'));
  ok('a publish of a fan-out tile records Customers, Orders, Returns and Regions', show(recorded(await publish(DASH)).sort()) === show([CUSTOMERS, ORDERS, REGIONS, RETURNS].sort()));
  ok('chartReads names every table of every question', show((await chartReads(P, CUSTOMERS, FAN.encoding, FAN.filters)).sort()) === show([ORDERS, REGIONS, RETURNS].sort()));
  setRelatedGateForTest(false); ok('NEGATIVE CONTROL: with the related gate off, a caller closed on Returns gets a figure', !H.refused(await asReturnsClosed('visual:data', FAN), 'related')); setRelatedGateForTest(true);
  setNamedDatasetsCheckForTest(false); ok('NEGATIVE CONTROL: without the datasetId check in reachesOther, the locked caller gets a figure', !H.refused(await asLocked('visual:data', FAN), 'related')); setNamedDatasetsCheckForTest(true);
  // part 4 column rules on a many side (cross-part check item 6): Returns' `amount` hidden from `east` by `columnAccess`
  ok('a many-side measure on a column hidden from the caller: refused hidden', H.refused(await asEast('visual:data', FAN), 'hidden'));
  ok('NEGATIVE CONTROL: the named team gets the figure', !H.refused(await asHr('visual:data', FAN)));
  ```
- [ ] **Step 2: Run it to see it fail.** → `chartReads` returns `[]` for a fan-out chart.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `DATABASE_URL=… node scripts/test-rowPolicyFanOutJoins.js && for t in rowPolicy rowPolicyFanOut rowPolicySidePaths rowPolicyLabels embedLock figureDatasets liveRoute; do DATABASE_URL=… node scripts/test-$t.js || break; done`.
- [ ] **Step 5: Commit.** `git add src/ipc/relationships.ts src/ipc/vizFanOut.ts src/ipc/rowDoors.ts scripts/test-rowPolicyFanOutJoins.ts` · "Gate and record every table a fan-out chart's questions read"

**Existing tests that must stay green:** test-joins, test-joinsVia, test-visuals, test-visualsServer, test-metricMeasures, test-metrics, test-dashboardFilters, test-rowPolicy, test-rowPolicyFanOut, test-rowPolicySidePaths, test-rowPolicyLabels, test-embedLock, test-figureDatasets, test-liveRoute, test-liveCompile, test-i18n, test-file-size; web VisualTile.test.tsx (it draws `notes`).

**Not in this step:** KPIs, formula metrics and the builder's pickers (step 07). Until step 07, a fan-out chart comes from the API, MCP or the Assistant. Live joins (D15). Grouping one-side rows by a many-side field (D13).
