# Semantic layer part 1, step 09: One table joined two ways — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chart can name the relationship it joins through (`via`), so "Order date" and "Ship date" can be read from one Dates table. Every reference without `via` keeps resolving through the first relationship, byte for byte.
**Architecture:** `JoinPlan.tables` is keyed by the hop path (relationship ids), not by dataset, so one dataset can appear twice. A `via` reference plans the default path to the relationship's near side plus that one hop. The JS reference (`joinJs.ts`) and the resident twin (`joinResident.ts`) find a hop's parent table by index instead of by dataset id. A guard PR (09a) ships first: it keeps the new fields through every sanitizer and refuses `via`, so an older pod never answers through the wrong relationship.
**Tech Stack:** `src/analysis/joinPlan.ts`, `joinJs.ts`, `relationships.ts`, `visuals.ts`, `src/engine/joinResident.ts`, `src/ipc/relationships.ts`, `src/data/transforms.ts`, the relationship screens and the visual builder in `web/`.
**Spec:** docs/semantic-layer/00-design.md (D14; Anti-goals "a number that changes silently"; Constraints "Two implementations agree", "Live") · Index: docs/superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md
**Branch and PR:** two PRs. **09a** `feat/semantic-p1-09a-via-guard` off `origin/develop` at the HEAD of the chain (it depends on nothing; merge it before step 01). **09** `feat/semantic-p1-09-labelled-joins` off `origin/develop` after step 08 merges.

## Global Constraints
- Without `via`, results are byte-identical: golden `scripts/fixtures/golden/joinsNoVia.json` is recorded from today's code (Task 1) before the planner changes, and is never re-recorded.
- JS and resident agree under `Object.is` (`test-joins`, `test-joinsVia`). Rule 2 (the first row per key) and Rule 3 (no fan-in) are unchanged.
- Fan-out refusals are unchanged: a hop against a many-to-one is refused with `findPath`'s sentence (`joinPlan.ts:113–121`). Row access gates every dataset in the plan (`chartReads`, `metricReads`). Live joins stay off (`liveSpec.ts:316`, `:322`).
- A `via` reference that cannot resolve (the relationship is deleted, it is not walkable from the chart's dataset, or it leads elsewhere) is an error, never a fallback to the first relationship or to a same-named column.
- `via` is UUID-shaped only, as `datasetId` is (`visuals.ts:312`). `label` is trimmed, 1–60 characters, and has no control characters.
- `src/data/transforms.ts` is 795 lines (cap 800). 09a first moves the `filter` case of `sanitizeStep` (:714–739) into a new file, which also leaves room for steps 04 and 05. `visuals.ts` is 702: at most 6 lines added. `ipc/relationships.ts` 311 and `joinPlan.ts` 265: new pure code goes in joinPlan (< 500 after).
- Join error sentences are plain English literals, as joinPlan's siblings are (`joinPlan.ts:117`, `:228`); joinPlan is not in `MAIN_FILES`.

## Old pods (rolling deploy and rollback)
- **`Relationship.label`** (relationships.json). A pod older than 09a drops it on read, and `writeAll` (`relationships.ts:106`) rewrites the whole list on ANY relationship save or delete, so every label in the project is lost. That is no figure change (references are by id), but the user's names fall back to "Dates (ship_date)". 09a's sanitizer keeps it. The 09a contract does not accept it yet, so no label is written until 09.
- **`via` on a measure, `categoryVia` on the encoding, `via` on a filter step** (visual, dashboard and metric records). A pod older than 09a drops them in `sanitizeEncoding` and `sanitizeStep`, then resolves through the FIRST relationship: Order date instead of Ship date, which is a wrong figure. A re-save drops them for good. A 09a pod keeps them on every load and save and refuses the chart, typed ("…finish upgrading Ordinate"). A 09 pod resolves them.
- **Order of relationships.** "First" is load-bearing from 09 on. Today `saveRelationship` (:126–133) moves a re-saved edge to the END, and saving an identical edge gives it a new id. 09a replaces in place and keeps the existing id. Step 01, which re-checks relationship warnings after a refresh, must write through it.
- **Why this is enough:** 09a merges first and is in every `:edge` image built during steps 01–08. **The residual risk:** an upgrade from an image older than 09a straight to 09, or a rollback past 09a, draws `via` charts through the first relationship on those pods and loses labels and `via` on their writes. It goes into `docs/server/upgrade.md`'s limits list and the release note (Task 3).

## Review Focus
- Order date and Ship date on one chart: two Dates tables, one row per primary row, the fan-in mask per table. → Task 2
- A `via` naming the default relationship must be the SAME table as a reference without `via` (one table, the same names). → Task 2
- A `via` filter whose column the primary also has (`year`) must never filter the primary's column. → Tasks 0, 2
- A `via` filter on a KPI in a project with NO relationships left must not fall through to the single-dataset path and be skipped silently. → Tasks 0, 3
- Deleting the Ship date relationship refuses its charts rather than redrawing them through Order date. → Task 2
- A user template copied to another project carries a `via` that does not exist there (`userTemplateRefs.ts:47` does not rebind it). That is refused, not resolved through the first relationship. → Task 2
- Re-saving the first relationship must not make the second one the default. → Task 0

---

### Task 0 (PR 09a): keep `label` and `via` everywhere; refuse `via`
**Files:** Create `src/data/filterStepSanitize.ts`, `scripts/joinsViaFixture.ts` and `scripts/test-joinsVia.ts`. Modify `src/data/transforms.ts` (`FilterStep` :85–107, `sanitizeStep` :714–739 becomes a call, `stepFilter` :367), `src/analysis/relationships.ts` (`Relationship` :33–40, `sanitizeRelationship` :58–75, `saveRelationship` :126–133), `src/analysis/visuals.ts` (`VizMeasure` :71, `VizEncoding` :113, `sanitizeEncoding` :312, :321), `src/analysis/joinPlan.ts` (`resolveVizJoin` :210), `src/ipc/relationships.ts` (`vizJoin` :97, `metricJoin` :137), `src/engine/residentFilter.ts:60`, `src/ipc/visualsResident.ts:56`, `src/engine/joinResident.ts:106`, `src/engine/live/liveSpec.ts:233`, `src/api/datasets.ts:41` (`via: Uuid.optional()`).
**Interfaces:** Produces `FilterStep.via?: string`, `VizMeasure.via?: string` (kept only beside `datasetId`), `VizEncoding.categoryVia?: string` (kept only beside `categoryDatasetId`), `Relationship.label?: string`, `sanitizeFilterStep(o: Record<string, unknown>): FilterStep | null` (a pure move of today's case, plus `via`), `hasVia(encoding: VizEncoding, filters: FilterStep[]): boolean` in joinPlan.ts, and `VIA_UNSUPPORTED = 'This chart joins a table through a named relationship, which this server cannot do yet. Ask your admin to finish upgrading Ordinate.'`
**Fixture** (`scripts/joinsViaFixture.ts`, new; Parquet written with `pqSync.writeTable` as `test-joins.ts:30` does). It exports `SALES`, `DATES`, `RETURNS`, `R_ORDER`, `R_SHIP`, `R_RET`, `RELS`, `infos`, `tables` and `sourceOf(id)`:
- **Sales:** `sale_id` text, `region` text, `amount` number, `order_date` date, `ship_date` date, `year` number. 40 rows over 2024; `ship_date = order_date + (i % 3) * 20 days`.
- **Dates:** `date` date, `month` text `YYYY-MM`, `quarter` text `Q1`…`Q4`, `year` number. One row per day from 2024-01-01 to 2025-02-28, plus a second `2024-03-01` row (Rule 2).
- **Returns:** `sale_id` text, `refund` number.
- **The relationships, in this order:** `R_ORDER` Sales.order_date → Dates.date (label "Order date"), `R_SHIP` Sales.ship_date → Dates.date (label "Ship date"), `R_RET` Returns.sale_id → Sales.sale_id.
- [ ] **Step 1: Write the failing test** (`scripts/test-joinsVia.ts`, § guard, ending on `finish()`):
  ```ts
  const viaStep = { ...F('year', '=', 2024), via: R_SHIP };
  ok('sanitizeSteps keeps a UUID via on a filter step, drops another', show(sanitizeSteps([viaStep, { ...viaStep, via: '../x' }])) === show([viaStep, F('year', '=', 2024)]));
  ok('sanitizeEncoding keeps categoryVia and a measure via only beside their datasetId', e.categoryVia === R_SHIP && e.values[0].via === R_SHIP && sanitizeEncoding({ ...enc, categoryDatasetId: undefined }).categoryVia === undefined);
  ok('sanitizeRelationship keeps a label, trimmed; drops one over 60', sanitizeRelationship({ ...r, label: '  Ship date ' })!.label === 'Ship date' && sanitizeRelationship({ ...r, label: 'x'.repeat(61) })!.label === undefined);
  ok('09a: a chart with via is refused, never drawn through the first relationship', show(jp.resolveVizJoin(SALES, viaEnc, [], RELS, infos)) === show({ ok: false, error: jp.VIA_UNSUPPORTED }));
  const t = applyPipeline(salesTable, [viaStep]);
  ok('a via filter reaching applyPipeline skips with the unknown-column warning; the primary\'s own `year` is NOT filtered', t.rowCount === salesTable.rows.length && show(t.warnings) === show(['Filter skipped: unknown column "year"']));
  ok('resident declines it so JS answers with the warning', filterPredicate(salesCols, viaStep, []) === null && !filterCannotWarn(viaStep, new Set(['year'])));
  ok('Live refuses a via filter (related)', (spec.adaptFilter(viaStep, LIVE_COLS, {}, []) as LiveRefusal).code === 'related');
  await rels.saveRelationship(P, RELS[0]); await rels.saveRelationship(P, RELS[1]); await rels.saveRelationship(P, { ...RELS[0], cardinality: 'one_to_one' });
  ok('re-saving the first relationship keeps it first', (await rels.listRelationships(P))[0].id === R_ORDER);
  ok('saving an identical edge again keeps the existing id', (await rels.saveRelationship(P, { ...RELS[1], id: undefined }))!.id === R_SHIP);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-joinsVia.js`: `via` is dropped by the sanitizers.
- [ ] **Step 3: Implement.** Move the `filter` case unchanged first (`node scripts/test-transforms.js` green), then add `via`. In `stepFilter`, `if (s.via) return skip(t, \`Filter skipped: unknown column "${s.column}"\`)`. In `filterPredicate`, `if (s.via) return null`. Both `cannotWarn` functions return false for `f.via`. `adaptFilter` refuses `related` for `s.via`. `resolveVizJoin` refuses on `hasVia` before anything else. `vizJoin` and `metricJoin` no longer return null early when a filter has `via`. `saveRelationship` replaces at the existing index (by id, else by `sameEdge`, keeping that entry's id).
- [ ] **Step 4: Run it to see it pass.** `for t in joinsVia joins transforms visuals visualsServer rowPolicyFanOut liveRoute embedLock dashboardFilters file-size; do node scripts/test-$t.js || break; done`, all green; `npm run lint` reports 0.
- [ ] **Step 5: Commit.** `git add src/data/filterStepSanitize.ts src/data/transforms.ts src/analysis/relationships.ts src/analysis/visuals.ts src/analysis/joinPlan.ts src/ipc/relationships.ts src/engine/residentFilter.ts src/ipc/visualsResident.ts src/engine/joinResident.ts src/engine/live/liveSpec.ts src/api/datasets.ts scripts/joinsViaFixture.ts scripts/test-joinsVia.ts` with the message "Keep relationship labels and via references through every sanitizer, and refuse via".

### Task 1: record today's answers for a table joined twice
**Files:** Create `scripts/fixtures/golden/joinsNoVia.json`. Modify `scripts/joinsViaFixture.ts` (add `noViaAnswers`) and `scripts/test-joinsVia.ts` (§ golden).
**Interfaces:** Consumes Task 0's fixture. Produces `noViaAnswers(): Promise<unknown>`. For NV1 (category `month` from Dates + sum(amount)), NV2 (count(quarter) from Dates by region), NV3 (bare filter `quarter = 'Q1'`, category region) and NV4 (the KPI sum(amount) where `quarter = 'Q2'`), it returns `{ label, tables: plan.tables.map((t) => [t.datasetId, t.via ? t.via.relId : null]), columns: layout.columns, data, warnings, category }` from the JS reference, and the KPI value.
- [ ] **Step 1: Write the failing test.** `ok('no-via answers are byte-identical to the recording made before the planner changed', wire.encode(await fx.noViaAnswers()) === fs.readFileSync(GOLDEN, 'utf8'))`.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-joinsVia.js`: ENOENT for `joinsNoVia.json`.
- [ ] **Step 3: Record ONCE, on today's planner (before Task 2).** `npm run build:ts && node -e "const w=require('./src/server/wire');require('./scripts/joinsViaFixture.js').noViaAnswers().then((a)=>require('fs').writeFileSync('scripts/fixtures/golden/joinsNoVia.json',w.encode(a)))"`. Check by hand that NV1's months are the ORDER months (the first relationship).
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-joinsVia.js` (§ golden green).
- [ ] **Step 5: Commit.** `git add scripts/joinsViaFixture.ts scripts/fixtures/golden/joinsNoVia.json scripts/test-joinsVia.ts` with the message "Record today's join answers for a table related twice, before via".

### Task 2: plan by relationship path, in both engines
**Files:** Modify `src/analysis/joinPlan.ts` (`JoinPlan` :34–37, `planTables` :126–144, `mergedLayout` :146–165, `resolveVizJoin` :203–251, plus the new functions), `src/analysis/joinJs.ts:68`, `src/engine/joinResident.ts:72`. Test: `scripts/test-joinsVia.ts` (§ via replaces 09a's refusal check).
**Interfaces:**
```ts
export interface PlanTable { key: string; datasetId: string; via: Hop | null; parent: number; label?: string } // [0]: key '', via null, parent -1
export interface JoinPlan { tables: PlanTable[] }
export function pathKey(hops: readonly Hop[]): string;                     // relIds joined by '>'
export function viaPath(primary: string, relId: string, rels: Relationship[], nameOf?: (id: string) => string): Result<Hop[]>;
export function planPaths(primary: string, paths: Hop[][], rels: Relationship[]): JoinPlan; // dedupes by key; sets parent and label
export interface MetricJoin { plan: JoinPlan; layout: JoinLayout; column: string; table: number; filters: FilterStep[] }
export function planMetricJoin(primary: string, column: string, filters: FilterStep[], rels: Relationship[], infos: Map<string, DsInfo>): Result<MetricJoin> | null;
```
- **`viaPath`.** The near side is the relationship's `from` if that is the primary or default-reachable; otherwise, for a `one_to_one`, its `to`. The path is `reachable(primary).get(near) ?? []` plus that hop. A missing id gives "A relationship this chart joins through no longer exists." Walking a many-to-one backwards gives `findPath`'s fan-out sentence. A near side that cannot be reached gives `findPath`'s own error.
- **`label`.** It is set only when a table's key differs from its dataset's default path key: `rel.label ?? \`${toName} (${hop.from.column})\``. `mergedLayout` prefixes with `t.label ?? info.name`, so default tables keep `Dates.month`.
- **`resolveVizJoin`.** A reference with `via` must reach its own `categoryDatasetId` or `datasetId`; otherwise the error is "<label> does not lead to <dataset>." Resolved steps lose `via`. `planTables` becomes `planPaths` over `findPath`, with the same signature and output.
- **The twins.** Both `joinTables` and `joinRelationSql` take `ft = plan.tables[t].parent`.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const V = { // each: JS reference vs joinedAggregateResident over plan.tables.map((t) => sourceOf(t.datasetId))
    ship: { category: 'month', categoryDatasetId: DATES, categoryVia: R_SHIP, values: [M('amount', 'sum')] },
    both: { category: 'month', categoryDatasetId: DATES, values: [M('amount', 'sum'), { column: 'quarter', aggregation: 'count', datasetId: DATES, via: R_SHIP }] },
    shipFilter: [{ category: 'region', values: [M('amount', 'sum')] }, [{ ...F('quarter', '=', 'Q1'), via: R_SHIP }]],
    defaultNamed: { category: 'month', categoryDatasetId: DATES, categoryVia: R_ORDER, values: [M('amount', 'sum')] },
  };
  for (const c of cases) ok(`${c.label}: labels and every value SQL === JS (Object.is)`, same(await jr.joinedAggregateResident(...), js.joinedVizDataJs(...)));
  ok('both: two Dates tables, each one row per sale', plan.tables.map((t) => t.key).join() === `,${R_ORDER},${R_SHIP}` && js.joinTables(...).rows.length === 40);
  ok('ship: its column is named by the label', layout.columns.some((c) => c.name === 'Ship date.month'));
  ok('NEGATIVE CONTROL: Ship date by month differs from Order date by month', show(shipData) !== show(golden.NV1.data));
  ok('defaultNamed: the same table and the same answer as no via (NV1)', show(defaultNamedData) === show(golden.NV1.data) && planOf(defaultNamed).tables.length === 2);
  ok('KPI: planMetricJoin with a Ship-date filter — joinedMetricJs === joinedMetricResident', Object.is(jsKpi, sqlKpi));
  ok('via through R_RET from Sales (the one side): refused, many side', /many side/.test(err(viaRet)));
  ok('a deleted relationship id (a template from another project): refused, never the first', /no longer exists/.test(err({ ...V.ship, categoryVia: ID(999) })));
  ok('via R_SHIP with categoryDatasetId = RETURNS: refused, does not lead', /does not lead/.test(err({ ...V.ship, categoryDatasetId: RETURNS })));
  ok('the golden (no via) is still byte-identical', wire.encode(await fx.noViaAnswers()) === fs.readFileSync(GOLDEN, 'utf8'));
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-joinsVia.js`: the via cases get `VIA_UNSUPPORTED`.
- [ ] **Step 3: Implement** as in Interfaces. Remove `VIA_UNSUPPORTED` and its `hasVia` refusal.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-joinsVia.js && node scripts/test-joins.js`, green, with the golden byte-identical.
- [ ] **Step 5: Commit.** `git add src/analysis/joinPlan.ts src/analysis/joinJs.ts src/engine/joinResident.ts scripts/test-joinsVia.ts` with the message "Key join plans by relationship path so one table can be joined twice".

### Task 3: the server reaches it (doors, pickers, labels)
**Files:** Modify `src/ipc/relationships.ts` (`chartReads` :104–107 dedupes, `metricJoin`/`metricReads`/`joinedMetricFor` :135–192 call `planMetricJoin`, `save` :259–273 rejects a label clash), `src/analysis/joinPlan.ts` (`relatedColumnGroups` :254–265), `src/analysis/relationships.ts` (append `labelClash`), `src/api/relationships.ts:14` (`label: z.string().max(60).optional()`), `docs/server/upgrade.md:97–106`. Test: `scripts/test-joinsVia.ts` § server.
**Interfaces:**
- `relatedColumnGroups` returns `{ datasetId; name; columns; via?: string }[]`. The default groups come first, unchanged. Then comes one group per walkable relationship whose hop is not its dataset's default hop: `name` is the label (or `"<Dataset> (<from column>)"`) and `via` is the relationship id.
- `labelClash(list: Relationship[], rel: Relationship): string | null` returns the clashing label (case-insensitive, either direction, the same two datasets, another id). `save` then answers `Another relationship between these two datasets is already called “${label}”.`
- `chartReads` and `metricReads` return each dataset once.
- [ ] **Step 1: Write the failing test.**
  ```ts
  const g = jp.relatedColumnGroups(SALES, RELS, infos);
  ok('pickers: Dates once by default, then a "Ship date" group carrying its via', show(g.map((x) => [x.name, x.via ?? null])) === show([['Dates', null], ['Ship date', R_SHIP]]));
  ok('labels: a second "ship date" between Sales and Dates clashes; another pair does not', rels.labelClash(RELS, { ...RELS[0], id: ID(77), label: 'ship date' }) === 'Ship date' && rels.labelClash(RELS, { ...RELS[2], label: 'Ship date' }) === null);
  ok('row access reads each dataset once', show(datasetsRead(planOf(V.both))) === show([DATES]));
  ok('a via filter on a KPI with the relationship deleted: no figure (null), never the unfiltered total', (await kpiAfterDelete()).value === null);
  ```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-joinsVia.js`: the groups have no `via`.
- [ ] **Step 3: Implement.** Add the residual risk (Old pods, above) to `docs/server/upgrade.md`.
- [ ] **Step 4: Run it to see it pass.** `for t in joinsVia joins rowPolicyFanOut rowPolicySidePaths embedLock liveRoute figureDatasets; do node scripts/test-$t.js || break; done && node scripts/check-contracts.js`, all green.
- [ ] **Step 5: Commit.** `git add src/ipc/relationships.ts src/analysis/joinPlan.ts src/analysis/relationships.ts src/api/relationships.ts docs/server/upgrade.md scripts/test-joinsVia.ts` with the message "Offer each labelled relationship's columns and save relationship labels".

### Task 4: the relationship editor gets a label
**Files:** Create `web/src/features/data/RelationshipLabelDialog.tsx`. Modify `web/src/features/data/api.ts:166–173` (`label?: string`), `RelationshipDialog.tsx` (a "Label" `Input` under Kind; sent at :104), `RelationshipsTab.tsx` (the label under One side's `End`; menu item "Rename…" before Delete at :295), `web/src/features/data/data.test.tsx`, and `web/e2e/data.e2e.ts` § 4 (:234–271).
**Interfaces:** Produces `RelationshipLabelDialog({ projectId, rel, onClose }: { projectId: string; rel: Relationship; onClose: () => void })`. It sends `relationship:save` with `{ id, from, to, cardinality, label }`, an empty label is sent as no label, and the server's sentence is shown inline. The Label field's hint is "Names this join in charts, e.g. Ship date. Optional."
- [ ] **Step 1: Write the failing test.** In `data.test.tsx`: the dialog sends `label: 'Ship date'`; Rename… prefills the label and saves `{ id, …, label: 'Order date' }`; a clash reply shows "Another relationship between these two datasets is already called “Ship date”." and keeps the dialog open; a viewer has no Rename…. In e2e § 4: add a second relationship on another key pair with the label "Ship date"; the row shows "Ship date"; `screens(page, 'data-relationships-labelled')`.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- data`: no Label field.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run e2e -- data && npm run lint`: green, light and dark screens written.
- [ ] **Step 5: Commit.** `git add web/src/features/data/RelationshipLabelDialog.tsx web/src/features/data/api.ts web/src/features/data/RelationshipDialog.tsx web/src/features/data/RelationshipsTab.tsx web/src/features/data/data.test.tsx web/e2e/data.e2e.ts` with the message "Label a relationship in its dialog and rename it from the list".

### Task 5: the builder picks a field through a labelled relationship
**Files:** Modify `web/src/features/visuals/encoding.ts` (`Measure.via?`, `Encoding.categoryVia?`), `web/src/features/visuals/api.ts` (`RelatedCol` :62–69 gains `via?`; `useRelated` :236–252 maps `g.via`), `web/src/features/visuals/model.ts` (`fieldKey`/`parseKey` :103–113, `measureFrom` :116–122, `fitEncoding` :83–101, `categoryType` :126–129), `web/src/features/visuals/EncodingForm.tsx` (`relatedOptions` :39–51 groups by `datasetId` + `via`; `pickCategory` :113–116 sets `categoryVia`; `seriesOpts` :106 leaves out `via` groups), and `web/src/features/visuals/visuals.test.tsx:76`.
**Interfaces:** The key becomes `@<datasetId>~<relId>/<column>` (`REL = /^@([0-9a-f-]{36})(?:~([0-9a-f-]{36}))?\/([\s\S]*)$/i`). Produces `fieldKey(column: string, datasetId?: string, via?: string): string` and `parseKey(value: string): { column: string; datasetId?: string; via?: string }`. Keys without `via` are unchanged.
- [ ] **Step 1: Write the failing test** (extend visuals.test.tsx:76):
  ```ts
  expect(parseKey(fieldKey('month', REL, VIA))).toEqual({ column: 'month', datasetId: REL, via: VIA });
  expect(parseKey(fieldKey('tier', REL))).toEqual({ column: 'tier', datasetId: REL });
  expect(fitEncoding({ category: 'month', categoryDatasetId: REL, categoryVia: VIA, values: [m] }, cols, related).categoryVia).toBe(VIA);
  expect(fitEncoding({ category: 'month', categoryDatasetId: REL, categoryVia: GONE, values: [m] }, cols, related).categoryVia).toBeUndefined();
  ```
  And a render case: with groups `[Dates, Ship date (via)]`, picking "month · Ship date" posts `visual:preview` with `categoryVia: VIA`, and the Split by list has no "Ship date" options.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- visuals`: `via` is undefined.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run size && npm run lint`: green, initial JS ≤ 300 KB.
- [ ] **Step 5: Commit.** `git add web/src/features/visuals/encoding.ts web/src/features/visuals/api.ts web/src/features/visuals/model.ts web/src/features/visuals/EncodingForm.tsx web/src/features/visuals/visuals.test.tsx` with the message "Pick a related field through a labelled relationship in the builder".

**Existing tests that must stay green:** test-joins, test-transforms, test-visuals, test-visualsServer, test-dashboardFilters, test-rowPolicy, test-rowPolicyFanOut, test-rowPolicyLabels, test-rowPolicySidePaths, test-embedLock, test-figureDatasets, test-liveRoute, test-liveCompile, test-file-size, test-i18n, check-contracts; web visuals.test.tsx, liveBuilder.test.tsx, calcMeasure.test.tsx, data.test.tsx; e2e data, visuals.

**Not in this step:** `via` on the series shelf (the spec names measure, category and filter; the Split by picker hides `via` groups). A picker for `via` filters: visual filters only list the dataset's own columns today (`FilterRows`, `Editor.tsx:162`), so `via` filters come from the API, MCP and the Assistant until a later step. The Data model's "which relationship is the default" line is step 10's.
