# Semantic layer part 8, step 07: fan-out for KPIs, formula metrics and the builder's pickers — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A KPI or saved metric on Customers over a many-side column (`amount`, on Orders) is that measure on Orders, with Customers' filters reaching it by step 06's pinned paths.
- A formula metric may name many-side columns (`sum(amount) / count(customer_id)`), as a KPI and as a chart measure.
- The chart builder offers many-side columns as measures.
- A caller locked on Customers is refused all of it by the outer gate.
**Architecture:**
- **KPIs.** `metricFor` (`src/ipc/dashboards.ts:222`) gets one call before `joinedMetricFor`: `fanOutMetricFor`. When the metric's bare column is on no forward table but on exactly one many side M, it asks `computeCardMetric(projectId, M, spec, filtersFor(M))` through the door, with step 06's filter rules.
- **Formula metrics.** Their leaves carry a `datasetId` (own, forward or many side), so a chart's formula measure plans through `vizDataFor` and step 06's fan-out.
- **Names.** `relatedColumnNames` keeps meaning forward hops only. Its callers (row access, Live's pre-refusal, scenarios, the metric checks) rely on that. Many sides get their own list, `manySideColumnNames`, which the metric compilers and the KPI gate read too.
**Tech Stack:** `src/analysis/fanOutPlan.ts` (step 06), new `src/ipc/metricFanOut.ts`, `src/ipc/dashboards.ts`, `src/ipc/relationships.ts`, `src/ipc/rowDoors.ts`, `src/analysis/metricMeasures.ts`, `src/ipc/metrics.ts`, `src/ipc/metricCheck.ts`, and the web visual builder.
**Spec:** docs/semantic-layer/08-engine.md (D11, D12, D14; owner's answer 3) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p8-00-index.md
**Branch and PR:** `feat/semantic-p8-07-fan-out-kpis` off `origin/develop`, after step 06 merges. One PR.

## Global Constraints
- **A metric names columns bare** (no dataset), so a many-side owner is resolved by uniqueness. Own columns win, then the nearest forward table (today's rule, unchanged), then the ONE many side that has the column. Two many sides with it is refused, naming both: "“amount” is on Orders and on Returns. Chart one of them instead." (my call).
- **No figure that answers today changes.**
  - A KPI over a column on its own or a forward table resolves as before.
  - Today, a many-side bare column resolves to nothing, and the KPI is null ("—"). Now it is a figure.
  - A chart's formula measure naming a related column does not compile today ("Unknown function: sum", `metricMeasures.ts:104-111` passes own columns only), so it is refused. Now it draws. Both changes are refused → answered, and the release note lists them.
- **D14, the KPI trap:** `reachesOther` (`src/ipc/rowDoors.ts:57-65`) decides "reaches another dataset" from forward names only (`relatedColumnNames`). A KPI over a many-side bare name must count too, or a caller locked on Customers would have Orders computed inside Customers' lock scope.
- `src/ipc/metrics.ts` is 563 lines and `src/ipc/dashboards.ts` 288: one line each. `metricMeasures.ts` (167) takes the leaf change. `EncodingForm.tsx` (307) takes small edits.
- Sentences go through `t()` in `src/analysis/fanOutMessages.ts` (step 06).

## Old pods (rolling deploy and rollback)
No stored field. The metric record is unchanged in shape: a many-side column is stored bare, as any column is today.
- **An old pod** computes such a KPI as null ("—") and refuses such a formula measure on a chart (it doesn't compile). Loud, never a different number.
- **`relationship:related`'s reply** gains `manyGroups`. An old browser ignores it. A new browser on an old pod gets no `manyGroups` and offers no many-side columns.

## Review Focus
- Locked on Customers, a KPI `sum(amount)` (amount only on Orders): refused `related` by the outer gate, never computed. → Task 2
- A dashboard date control on Orders.order_date over a Customers KPI of `count(id)`: unaffected, with a note. The same control over `sum(amount)`: narrowed. → Task 2
- `sum(amount) / count(customer_id)` on a chart by segment: each leaf is a question on its own table, lined up by segment. The blank segment holds the orphan orders' amount and no customer count. The formula is null there, never Infinity. → Task 3
- The builder never offers a many-side column as the category or the split (D13 row 1). → Task 4

---

### Task 1: the many sides' column list
**Files:** Modify `src/analysis/fanOutPlan.ts` (append `manySideColumnGroups` and `manySideOwner`), `src/ipc/relationships.ts` (append `manySideColumnNames`; the `relationship:related` handler (:304-313) adds `manyGroups`), and `src/api/visuals.ts:187` (unchanged input; the reply is documented in its comment). Test: `scripts/test-fanOut.ts` § names.
**Interfaces:**
```ts
export function manySideColumnGroups(primary: string, rels: Relationship[], infos: Map<string, DsInfo>): { datasetId: string; name: string; columns: ParsedColumn[] }[];
// each dataset that reaches a table on primary's forward tree (or primary) forward, and that primary can't reach forward; nearest first
export function manySideOwner(primary: string, column: string, rels: Relationship[], infos: Map<string, DsInfo>): { ok: true; datasetId: string } | { ok: false; error: string } | null;
export async function manySideColumnNames(projectId: string, datasetId: string): Promise<string[]>;
// relationship:related → { ok: true; groups: …(unchanged); manyGroups: { datasetId; name; columns }[] }
```
- [ ] **Step 1: Write the failing test.**
  ```ts
  ok('Customers: Orders and Returns are its many sides', show(manySideColumnGroups(CUSTOMERS, RELS, INFOS).map((g) => g.name)) === '["Orders","Returns"]');
  ok('amount is owned by Orders; customer_id by both, so refused naming both', manySideOwner(CUSTOMERS, 'amount', RELS, INFOS)!.ok && /Orders and on Returns/.test((manySideOwner(CUSTOMERS, 'customer_id', RELS, INFOS) as { error: string }).error));
  ok('relatedColumnNames is unchanged: forward only', show(await relatedColumnNames(P, CUSTOMERS)) === show(before));
  ok('NEGATIVE CONTROL: from Orders, Customers is forward, never a many side (Returns is one, through Customers)', show(manySideColumnGroups(ORDERS, RELS, INFOS).map((g) => g.name)) === '["Returns"]');
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-fanOut.js` → `manySideColumnGroups` is missing.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-fanOut.js && node scripts/test-joins.js`.
- [ ] **Step 5: Commit.** `git add src/analysis/fanOutPlan.ts src/ipc/relationships.ts src/api/visuals.ts scripts/test-fanOut.ts` · "List the columns a dataset's many sides offer"

### Task 2: KPIs — the door, the gate, the notes
**Files:** Create `src/ipc/metricFanOut.ts`. Modify:
- `src/ipc/dashboards.ts`: one call in `metricFor` before :233.
- `src/ipc/relationships.ts`: `metricReads` (:153-156) learns M and M's own reads.
- `src/ipc/rowDoors.ts`: `reachesOther` (:63) adds many-side names to `related`.
- The KPI reply's `notes` (part 1 05b).

Test: `scripts/test-fanOut.ts` § kpi, and `scripts/test-rowPolicyFanOutJoins.ts` § kpi.
**Interfaces:**
```ts
export async function fanOutMetricFor(projectId: string, datasetId: string, spec: { column: string; aggregation: MetricAggregation }, filters: FilterStep[]):
  Promise<{ ok: boolean; value: number | null; notes?: string[]; fx?: unknown; asOf?: unknown } | null>; // null: not a many-side column
```
- It applies step 06's filter rules, with M's KPI as the one question:
  - P's filters through J reach M pinned with `via`;
  - a filter on a column only M has applies;
  - any other filter leaves the KPI unaffected and adds a `narrows` note.
- Its figure is `computeCardMetric(projectId, M, spec, mFilters)` (the door: M's row access rules, Live, the answer cache). A Live P or M refuses as step 06 does.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const v = await kpi(CUSTOMERS, { column: 'amount', aggregation: 'sum' }, [F('segment', '=', 'SMB')]);
  ok("a KPI on Customers over amount is Orders' sum for SMB customers", Object.is(v.value, bruteSum((o) => segmentOf(o) === 'SMB')));
  ok('…and equals the same KPI asked on Orders with the pinned filter', Object.is(v.value, (await kpi(ORDERS, { column: 'amount', aggregation: 'sum' }, [{ ...F('segment', '=', 'SMB'), via: R_OC }])).value));
  ok('an order_date control narrows sum(amount) and says nothing; over count(id) it is unaffected and noted', …);
  ok('locked on Customers: the KPI is refused related, before Orders is read', H.refused(await asLocked('dashboard:metric', KPI), 'related') && ordersReads === 0);
  ok('NEGATIVE CONTROL: before the gate change (relatedColumnNames alone), reachesOther says false', !(await reachesOtherForwardOnly()));
  ok('a column on two many sides: refused, naming both', /Orders and on Returns/.test((await kpi(CUSTOMERS, { column: 'customer_id', aggregation: 'count' }, [])).error));
  ```
- [ ] **Step 2: Run it to see it fail.** → `value` is null.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-fanOut.js && DATABASE_URL=… node scripts/test-rowPolicyFanOutJoins.js && for t in analysesServer dashboardFilters metrics embedLock rowPolicy liveRoute; do node scripts/test-$t.js || break; done`.
- [ ] **Step 5: Commit.** `git add src/ipc/metricFanOut.ts src/ipc/dashboards.ts src/ipc/relationships.ts src/ipc/rowDoors.ts scripts/test-fanOut.ts scripts/test-rowPolicyFanOutJoins.ts` · "Compute a KPI over a many-side column on its own table, and refuse it to a caller locked on the one side"

### Task 3: formula metrics name many-side columns
**Files:** Modify:
- `src/analysis/metricMeasures.ts`: `Leaf` (:38) gains `datasetId?`; `build` (:97-124) compiles against own + related + many-side names and resolves each leaf's owner; the `run` in `vizMetricMeasures.ts` (`bare`) keeps a leaf's `datasetId`.
- `src/ipc/metrics.ts:145`: `.concat(await manySideColumnNames(...))`.
- `src/ipc/metricCheck.ts:74`: `related` adds many-side names.

Test: `scripts/test-fanOut.ts` § formula.
**Interfaces:**
- A `Leaf`'s `datasetId` is unset for an own column. For a forward one it is `resolveColumnOwner`'s; for a many-side one, `manySideOwner`'s.
- An ambiguous many-side name is a `PlanError` with step 06's sentence.
- The KPI path needs no change beyond the names: `resolveDefinition` (`src/ipc/metrics.ts:121-171`) already sends each aggregate through `computeCardMetric`, which Task 2 covers.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const m = await saveMetric(CUSTOMERS, 'Revenue per customer', 'sum(amount) / count(id)');
  ok('KPI: the formula over two tables', Object.is((await metricValue(m)).value, bruteSum() / customerCount));
  const c = await post('visual:data', { projectId: P, datasetId: CUSTOMERS, encoding: { category: 'segment', values: [{ column: '', aggregation: 'sum', metricId: m.id }] } });
  ok('chart: per segment, each leaf on its own table, lined up', same(c.value.data, brute.perSegment));
  ok('the blank segment: no customer count, so the formula is null, never Infinity', c.value.data.series[0].values[blankAt] === null);
  ok('metric:check accepts sum(amount) on Customers', (await post('metric:check', { projectId: P, datasetId: CUSTOMERS, expression: 'sum(amount) / count(id)' })).value.valid);
  ok('NEGATIVE CONTROL: with own columns only (today), the chart formula is refused as not compiling', /Unknown function/.test(await todayPlanError()));
  ```
- [ ] **Step 2: Run it to see it fail.** → `metric:check` answers "Unknown function: sum".
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-fanOut.js && for t in metricMeasures metrics metricCheck scenarios visualsServer; do node scripts/test-$t.js || break; done`. `test-scenarios` stays unchanged: scenarios keep `relatedColumnNames` (forward).
- [ ] **Step 5: Commit.** `git add src/analysis/metricMeasures.ts src/ipc/vizMetricMeasures.ts src/ipc/metrics.ts src/ipc/metricCheck.ts scripts/test-fanOut.ts` · "Let a formula metric total a many-side column, on its own table"

### Task 4: the builder offers many-side measures
**Files:** Modify:
- `web/src/features/visuals/api.ts`: `RelatedCol` (:62-69) gains `many?: true`; `useRelated` (:236-252) maps `manyGroups`.
- `web/src/features/visuals/EncodingForm.tsx`: the measure options (:103) include `many` groups, each group captioned "<Dataset> · counts its own rows"; category (:96) and series (:106-109) exclude them.
- `web/src/features/visuals/visuals.test.tsx`.
- `web/e2e/visuals.e2e.ts`.
- `CHANGELOG.md`.

**Interfaces:** A many-side option's key is step 09's `@<datasetId>/<column>`, so picking it sets `values[i].datasetId`, as a forward one does.
- [ ] **Step 1: Write the failing test.**
  - `visuals.test.tsx`: with `manyGroups: [Orders]`, the Measure select lists "amount · Orders · counts its own rows". The Category and Split selects do not list it. Picking it posts `visual:preview` with `values[0].datasetId === ORDERS`.
  - A reply whose `notes` holds two sentences draws both under the chart.
  - e2e: on a Customers chart, add the measure "amount · Orders"; the chart draws, and the note line "“Sum of amount” … count the rows of their own tables" is visible. Then `screens(page, 'visual-fan-out')`. The RPC budget stays ≤ 25.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- visuals` → no many-side option.
- [ ] **Step 3: Implement.** CHANGELOG `[Unreleased]`:
  - charts and KPIs can use measures from a dataset's many sides;
  - formula metrics can total related and many-side columns;
  - the refusals that remain.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run e2e -- visuals && npm --prefix web run size && npm run lint` → green, light and dark screens written, initial JS ≤ 300 KB.
- [ ] **Step 5: Commit.** `git add web/src/features/visuals web/e2e/visuals.e2e.ts CHANGELOG.md` · "Offer a dataset's many-side columns as chart measures"

**Existing tests that must stay green:** test-joins, test-joinsVia, test-fanOut, test-rowPolicyFanOutJoins, test-metrics, test-metricCheck, test-metricMeasures, test-scenarios, test-analysesServer, test-dashboardFilters, test-visualsServer, test-embedLock, test-rowPolicy, test-rowPolicySidePaths, test-liveRoute, test-i18n, test-file-size; web visuals.test.tsx, calcMeasure.test.tsx, VisualTile.test.tsx; e2e visuals, analyses.

**Not in this step:** the metric editor's column picker. It lists the dataset's own columns, so many-side metrics come from formulas, the API, MCP and the Assistant. Part 5's distinct counts across fan-out: the planner passes any aggregation the door supports; step 06's differential carries the `countd` case (cross-part check item 12).
