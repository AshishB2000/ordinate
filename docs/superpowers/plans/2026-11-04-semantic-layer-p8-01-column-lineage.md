# Semantic layer part 8, step 01: column lineage on the server — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lineage traces one column through Prepare into calculated fields, metrics, terms, charts, dashboards and alerts, from the records alone, and answers two new reads that step 08 draws: one column's graph, and a dataset's "Used by" per field and per column-making step.
**Architecture:**
- `buildGraph(input)` keeps today's picture for `lineage:get`, `src/app/pipelineView.ts` and `src/server/subscriptions/figureDatasets.ts`, with three fixes: related fields hang off their own dataset (D19), metric formulas are read by the parser instead of a regex (D17), and a connection source never names its table (D20).
- A second pass, `addColumnNodes(graph, input)` (new file), adds `column` and `term` nodes. Only the two new contracts call it.
- Prepare's effect on columns is a pure fold over a table keyed by every `STEP_TYPES` member (D18).
**Tech Stack:** `src/analysis/lineage.ts`, new `src/analysis/lineageFlow.ts` and `src/analysis/lineageColumns.ts`, `src/ipc/lineage.ts`, `src/api/lineage.ts`, self-checks.
**Spec:** docs/semantic-layer/08-engine.md (D16–D20, Tests "Lineage") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p8-00-index.md
**Branch and PR:** `feat/semantic-p8-01-column-lineage` off `origin/develop` after part 1's step 10 merges (it reads terms (05b), `timeColumn` (04) and `snapshot` (07)). One PR.

## Global Constraints
- **Names only.** A node carries a record's or a column's name, never a formula, a filter value, a table, a path, a URL or SQL. A term node is its name. A calc node's `sub` is "Calculated field".
- `lineage:get` changes ONLY by D17, D19 and D20. `test-lineage`, `test-figureDatasets` and `test-pipelines` stay green with their assertions untouched.
- Column edges stop at the dataset for `sql`, `composed` and `combined` origins. SQL is not parsed.
- Every encoding field and every step type is classified. A new one fails a test (Task 1) or `tsc` (Task 2) until someone classifies it.
- Size: `lineage.ts` is 413 lines; at most 25 lines change there. `ipc/lineage.ts` is 87. The new files stay under 300 lines each.
- Both contracts are `read`, project-scoped, with zod inputs. Both are classified `META` in `scripts/rowPolicyReaders.ts`, as `lineage:get` is (:92). They register inside `src/ipc/lineage.ts`'s existing `register()`, so `src/server/app.ts` gets no line. `src/api/index.ts` already spreads `lineage`.

## Old pods (rolling deploy and rollback)
No stored field. The two channels are new: a new browser on an old pod gets 404, and step 08's UI shows its error state with Retry. An old browser never calls them. `lineage:get` gains edges and loses the "Table …" sub line. An old browser draws whatever it is given.

## Review Focus
- D19 changes which datasets a visual hangs off. `figureDatasets` walks that graph to decide which datasets a send reads (row access). It must only GROW, never lose a dataset. → Task 2
- An approximate step (a pivot, a union) must still lead to the consumer: every output from every input, marked approximate, never "unused". → Task 1
- A rename chain (`amt` → `amount` → `revenue`) is one column with "was amt, amount", not three. → Task 1
- The origin canary must cover `lineage:column`: its source nodes pass `redactSources` too. → Task 4

---

### Task 1: the column flow through Prepare
**Files:** Create `src/analysis/lineageFlow.ts`, `scripts/test-lineageColumns.ts` (§ flow).
**Interfaces:** Consumes `STEP_TYPES` (`src/data/transforms.ts:164`), `TransformStep`, `compile` (`src/formula/formula.ts`). Produces:
```ts
export type FlowRule = 'calc' | 'conditional' | 'rename' | 'drop' | 'in_place' | 'masked' | 'aggregate' | 'lookup' | 'rows' | 'approximate';
/** One entry per STEP_TYPES member — the test holds the key sets equal. */
export const FLOW_RULES: Readonly<Record<string, FlowRule>>;
export interface FlowColumn {
  key: string;                 // identity: the column's final name, or its last name when a step drops it
  was: string[];               // earlier names, oldest first
  from: string[];              // identities it was computed from ([] for a source column)
  how: 'source' | 'calc' | 'in_place' | 'masked' | 'aggregate' | 'lookup' | 'approximate';
  dropped?: true;
  lookup?: { datasetId: string; column: string };
}
export function columnFlow(source: string[], steps: readonly TransformStep[]): FlowColumn[];   // first-seen order
```
- The rules, from D18:
  - `calculated_field` and `conditional_column`: `calc`. The inputs are `compile(expression).fn.refs`, LOD dimensions included. A conditional's inputs are its condition columns.
  - `rename_column` follows the name. `drop_column` ends the column (`dropped`).
  - `fill_empty`, `trim`, `replace_values` and `parse_date` are `in_place`. `mask_hash`, `mask_redact` and `mask_generalize` are `masked`.
  - `group_aggregate`: each output from its own column; the group-by columns pass through.
  - `lookup_join`: each added column comes `lookup` from the other dataset's column.
  - `filter`, `dedupe` and `dedupe_key` change rows only (`rows`, no edge).
  - Everything else (`split_column`, `unpivot`, `pivot`, `union`, `window`, `spatial_join`, `segment`, `text_terms`, `text_sentiment`, `keyword_rules`) is `approximate`: every output from every input.
  - An unknown step type (05a keeps them) reads `approximate`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  ok('FLOW_RULES names every STEP_TYPES member, and nothing else', show(Object.keys(FLOW_RULES).sort()) === show([...STEP_TYPES].sort()));
  const f = columnFlow(['amt', 'cost', 'region'], [R('amt', 'amount'), CALC('Margin', '[amount] - [cost]'), CALC('Margin %', '[Margin] / [amount]'), R('amount', 'revenue'), DROP('cost')]);
  ok('a rename chain is one column', show(at(f, 'revenue')) === show({ key: 'revenue', was: ['amt', 'amount'], from: [], how: 'source' }));
  ok('calc over calc', show(at(f, 'Margin %').from) === show(['Margin', 'revenue']));
  ok('a dropped input still feeds the calc that read it', at(f, 'cost').dropped === true && at(f, 'Margin').from.includes('cost'));
  ok('group_aggregate: each output from its column, group-by passes through', ...);
  ok('lookup_join: an added column names the other dataset', at(lk, 'tier').lookup!.datasetId === TIERS);
  ok('a pivot is approximate: every output from every input', at(pv, 'East').how === 'approximate' && at(pv, 'East').from.length === 3);
  ok('NEGATIVE CONTROL: a filter step adds no edge', show(columnFlow(['a'], [F('a', '=', 1)])) === show(columnFlow(['a'], [])));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-lineageColumns.js` → module not found.
- [ ] **Step 3: Implement** `columnFlow` as a fold over a `Map<currentName, identity>`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-lineageColumns.js` (§ flow green).
- [ ] **Step 5: Commit.** `git add src/analysis/lineageFlow.ts scripts/test-lineageColumns.ts` · "Fold a dataset's Prepare steps into column-level edges"

### Task 2: what each consumer reads, on its own dataset
**Files:** Create `src/analysis/lineageColumns.ts` (consumer half). Modify `src/analysis/lineage.ts`:
- `LineageInput` (:70-80) gains `terms?: Rec[]` and `relationships?: Relationship[]`.
- The visual loop (:276-286) links through `consumerColumns(v, input)` per dataset (D19).
- The metric loop (:256-273) reads formulas through `compileMetricFormula` (`src/analysis/metricFormula.ts:169`), and `formulaRefs` (:110-114) is deleted (D17).
- The connection `sub` (:187) becomes `c && c.kind ? c.kind : 'Connection'` (D20).

Test: `scripts/test-lineageColumns.ts` § consumers.

**Interfaces:** Produces:
```ts
/** Every VizEncoding key, classified — tsc fails when a key is added without a line here. */
export const ENCODING_FIELDS: Readonly<Record<keyof VizEncoding, 'column' | 'columns' | 'dataset' | 'none'>>;
/** Columns a visual reads, by the dataset each is on (categoryDatasetId, seriesDatasetId, values[].datasetId, a filter's datasetId (05b) or owner). */
export function consumerColumns(v: Rec, input: LineageInput): Map<string, string[]>;
/** The same for a metric: definition.column or the formula's aggregates, filters, timeColumn, snapshot.column. */
export function metricColumns(m: Rec, input: LineageInput): Map<string, string[]>;
/** Join keys a figure crosses: both ends of every hop findPath takes from the primary to each other dataset it reads. */
export function keyColumns(primary: string, others: string[], input: LineageInput): Map<string, string[]>;
```
- The fields that name columns: `category`, `series`, `values[].column` (no `metricId`), `pivot.rows/columns/values`, `geo.lat/lon/lat2/lon2/from/to/color/property`, `cohort.entity/date/value`, `eventFunnel.entity/event/time`, `drivers` (its metric column and path columns), `facet.rowField/colField`, and every filter's `column`.
- A bare filter column takes `resolveColumnOwner(primary, column, rels, infos)` (`src/analysis/joinPlan.ts`); `infos` are built from `input.datasets`.
- **D20 and part 2.** Part 2's PR 1 (`2026-11-04-semantic-layer-p2-01-viewer-source-names.md`, Task 2) trims `origin.table` in `loadInput` for viewers only. Its negative control asserts that an EDITOR still reads "Table public.canary_tbl_9f3" in `lineage:get`. D20 drops the table for every reader, editors and `pipelines:get` included. If that PR has merged, change its control in `scripts/test-sourceNamesHidden.ts` to "the editor reads the connector kind too", and keep its trim: it still guards `pipelines:get`'s other fields. This is the approved D20, not a regression.
- `visualColumns` (:97) stays as it is: `src/analysis/liveDependents.ts` and `src/engine/live/liveMissing.ts` share it for Live datasets, which have no joins.
- `metricColumns` passes `compileMetricFormula(formula, own + reachable columns)`: `aggregates[].column` are columns, `metricRefs` are metric names, and an LOD aggregate's columns are `compile(column).fn.refs`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const v = { id: V, datasetId: ORDERS, encoding: { category: 'region', categoryDatasetId: CUSTOMERS, values: [{ column: 'amount', aggregation: 'sum' }] }, filters: [F('segment', '=', 'SMB')] };
  ok('D19: Customers.region hangs off Customers, not Orders', show([...consumerColumns(v, input)]) === show([[ORDERS, ['amount']], [CUSTOMERS, ['region', 'segment']]]));
  ok('every column-naming encoding field is read', namesOf(consumerColumns(FULL, input)).length === DISTINCT_NAMES_IN_FULL); // FULL sets every field to its own name
  ok('D17: a formula naming a metric and a column', show(metricColumns({ datasetId: ORDERS, definition: { formula: 'sum(amount) / [Units]' } }, input)) === show([[ORDERS, ['amount']]]));
  ok('timeColumn and snapshot.column are read', ...);
  ok('lineage:get: the related visual now has an edge from Customers', edgesInto(buildGraph(input), `visual:${V}`).includes(`dataset:${CUSTOMERS}`));
  ok('D20: a connection source never names its table', !buildGraph(withTable('secret_tbl')).nodes.some((n) => /secret_tbl/.test(n.sub)));
  ok('NEGATIVE CONTROL: the old regex reading of `sum(amount) / [Units]` is not what the graph now holds', ...); // keep the regex inline in the test
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-lineageColumns.js` → `consumerColumns` missing.
- [ ] **Step 3: Implement.** `buildGraph`'s visual loop: `for (const [ds, cols] of consumerColumns(v, input)) for (const src of inputsFor(ds, cols)) link(src, id);`. The metric loop uses `metricColumns`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-lineageColumns.js && node scripts/test-lineage.js && node scripts/test-figureDatasets.js && node scripts/test-pipelines.js` → all green.
- [ ] **Step 5: Commit.** `git add src/analysis/lineageColumns.ts src/analysis/lineage.ts scripts/test-lineageColumns.ts` (and `scripts/test-sourceNamesHidden.ts` once part 2's PR 1 has merged) · "Attribute each field a figure reads to its own dataset and read metric formulas by the parser"

### Task 3: column and term nodes
**Files:** Modify `src/analysis/lineageColumns.ts` (append `addColumnNodes`) and `src/analysis/lineage.ts` (`LineageKind` :32 gains `'column' | 'term'`; `KIND_RANK` :61 gains `column: 3, term: 4`). Test: `scripts/test-lineageColumns.ts` § nodes.
**Interfaces:**
- Produces `addColumnNodes(g: LineageGraph, input: LineageInput): LineageGraph`. It is pure and returns a new graph.
- Node ids:
  - `column:<datasetId>:<key>`, with name = the column's final name and sub "Column", "Renamed from amt", "Masked" or "Approximate".
  - A calc (a Prepare `calculated_field`, or a Live dataset's `meta.live.calculated`, which 00a fills) keeps today's `calc:<datasetId>:<name>`.
  - `term:<id>`, with its name and sub "Glossary term".
- Edges:
  - the dataset's output node → each column it has;
  - a column (or calc) → each calc, metric, term, visual, control, alert that reads it, and → the column a lookup adds on the other dataset;
  - a term → each visual, metric, dashboard and alert whose filters hold `{ type: 'term', term: id }`.
- Only columns something reads get a node, and a column a renamed key leads to.
- A dataset whose origin is `sql`, `composed` or `combined` gets column nodes but no upstream column edge.
- [ ] **Step 1: Write the failing test.** Fixture: Orders, with Prepare steps rename `amt`→`amount`, calc `Margin = [amount] - [cost]`, and lookup `tier` from Tiers. Customers. A relationship Orders.customer_id → Customers.id. Metric `Revenue = sum(amount)` with `timeColumn: 'order_date'`. Metric `Margin % = sum(Margin) / sum(amount)`. Term `West` on Customers (`region = 'West'`). Four visuals, one of which uses the term and a Customers category. A dashboard and an alert. Then:
  ```ts
  const g = addColumnNodes(buildGraph(input), input); const f = focus(g, `column:${ORDERS}:amount`);
  ok('amount feeds Margin (calc), Revenue and Margin %', ['calc:' + ORDERS + ':Margin', 'metric:' + REV, 'metric:' + MPCT].every((id) => f.nodes.some((n) => n.id === id)));
  ok('the rename is one column, named by its final name', node(g, `column:${ORDERS}:amount`).sub === 'Renamed from amt');
  ok('the join key Orders.customer_id is used by the related visual', downstream(g, `column:${ORDERS}:customer_id`).includes(`visual:${VREL}`));
  ok('a term node, by name only, between its column and the visual', node(g, `term:${WEST}`).name === 'West' && !JSON.stringify(g).includes("'West'"));
  ok('a Live calc reads its inputs', downstream(g, `column:${LIVE}:amt`).includes(`calc:${LIVE}:Margin`));
  // Differential: lineage's term usage === part 1's termUsage (src/analysis/termUsage.ts), kind by kind.
  for (const k of ['visual', 'dashboard', 'metric', 'alert', 'report'] as const) ok(`term usage agrees with termUsage: ${k}`, Object.is(focus(g, `term:${WEST}`).usedIn[k] ?? 0, countOf(await termUsage(P), WEST, k)));
  ok('lineage:get draws no column or term node', !buildGraph(input).nodes.some((n) => n.kind === 'column' || n.kind === 'term'));
  ok('NEGATIVE CONTROL: a column nothing reads has no node', !g.nodes.some((n) => n.id === `column:${ORDERS}:unused`));
  ```
- [ ] **Step 2: Run it to see it fail.** → `addColumnNodes` missing.
- [ ] **Step 3: Implement**, reusing Task 1's `columnFlow` (from `meta.sourceColumns ?? columns`) and Task 2's consumer functions.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-lineageColumns.js && node scripts/test-lineage.js && node scripts/test-terms.js`.
- [ ] **Step 5: Commit.** `git add src/analysis/lineage.ts src/analysis/lineageColumns.ts scripts/test-lineageColumns.ts` · "Add column and term nodes to the lineage graph"

### Task 4: `lineage:column` and `lineage:fields`
**Files:** Modify:
- `src/api/lineage.ts`: append two contracts.
- `src/ipc/lineage.ts`: `loadInput` (:29-52) also reads `terms.listTerms` → `getTerm` and `relationships.listRelationships`; two handlers inside `register()` (:84).
- `scripts/rowPolicyReaders.ts`: two `META` entries.
- `scripts/test-rowPolicySafetyNet.ts`: both in its META walk.

Test: `scripts/test-lineageColumns.ts` § channel (on `scripts/liveRouteHarness.ts`).
**Interfaces:**
```ts
'lineage:column': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, column: z.string().min(1).max(1_000) }), project: byProjectId }),
'lineage:fields': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
type UsedIn = Partial<Record<LineageKind, number>>;
// lineage:column → (FocusedLineage & { upstream: number }) | null — focus on column:<d>:<key> or calc:<d>:<name>, through redactSources
// lineage:fields → { ok: true; fields: Record<string, { usedIn: UsedIn }>; steps: { index: number; produces: string[]; usedIn: UsedIn }[] }
```
- `fields` is a null-prototype record. It holds a column only when something reads it, and a Live dataset's calcs appear in it.
- `steps` lists each Prepare step that makes a column (`calc`, `conditional`, `rename`, `aggregate`, `lookup`, `approximate`). Its `usedIn` is everything downstream of the columns it produces, counted once each.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const c = (await post('lineage:column', { projectId: P, datasetId: ORDERS, column: 'amount' })).value;
  ok('lineage:column: focused on the column, used by 2 metrics', c.focus === `column:${ORDERS}:amount` && c.usedIn.metric === 2);
  const fl = (await post('lineage:fields', { projectId: P, datasetId: ORDERS })).value;
  ok('lineage:fields: amount is used, the calc step reports what it feeds', fl.fields.amount.usedIn.metric === 2 && fl.steps.find((s: Reply) => s.produces.includes('Margin')).usedIn.metric === 1);
  ok('ORIGIN CANARY: a planted path, keyed URL, table and SQL reach neither reply', [c, fl, await getLineage()].every((r) => !/secret_dir_7q|key=secret_7q|secret_tbl_7q|SELECT secret_7q/.test(JSON.stringify(r))));
  ok('a calc name or an unknown column answers null, not an error', (await post('lineage:column', { projectId: P, datasetId: ORDERS, column: 'nope' })).value === null);
  ok('NEGATIVE CONTROL: the canary is in the stored records', JSON.stringify(await rawRecords()).includes('secret_tbl_7q'));
  ```
- [ ] **Step 2: Run it to see it fail.** → 404 (no contract); `node scripts/check-contracts.js` lists both unresolved.
- [ ] **Step 3: Implement** both handlers on `addColumnNodes(buildGraph(await loadInput(p)), input)`, then `focus` and `redactSources`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-lineageColumns.js && node scripts/check-contracts.js && DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js && node scripts/test-server-boot.js && node scripts/test-asyncReach.js && node scripts/test-liveSafetyNet.js`, then `npm run lint` → 0.
- [ ] **Step 5: Commit.** `git add src/api/lineage.ts src/ipc/lineage.ts scripts/rowPolicyReaders.ts scripts/test-rowPolicySafetyNet.ts scripts/test-lineageColumns.ts` · "Add lineage:column and lineage:fields"

**Existing tests that must stay green:** test-lineage, test-figureDatasets, test-pipelines, test-liveProfile (it covers `missingDependents`, which shares `visualColumns`), test-terms, test-metrics, test-rowPolicySafetyNet, test-liveSafetyNet, test-server-boot, test-asyncReach, test-file-size, check-contracts.

**Not in this step:** the UI (step 08); lineage inside SQL datasets or source tables (part 2's `sourceTable:lineage` builds on these column nodes later).
