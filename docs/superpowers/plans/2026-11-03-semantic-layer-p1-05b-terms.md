# Semantic layer part 1, step 05b: glossary terms — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add glossary terms: named, reusable row filters stored like metrics. Any filter list can reference one as `{ type: 'term', term: <id> }`, and the server expands the reference at the figure doors, so editing a term changes every figure that uses it.
**Architecture:** A `term` record kind (`src/analysis/terms.ts`) has the metric record's guarantees: `recordFs`, edit-conflict tag, Trash and versions. Step 05a's `expandTerms` stub becomes the real expansion, run at the same doors. A term step becomes its filter steps. A step from another dataset carries `datasetId`, which only the join planner may apply: every single-table engine refuses it. The Assistant, MCP and the web read terms. A restricted viewer gets names, aliases and descriptions only.
**Tech Stack:** `src/analysis`, `src/ipc`, `src/api`, `src/app`, `src/ai`, `src/automation`, `src/engine`, `web/src/features/model/terms/`, filter rows, tiles.
**Spec:** docs/semantic-layer/00-design.md (D10, D11, D12) · Index: docs/superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md
**Branch and PR:** `feat/semantic-p1-05b-terms` off `origin/develop` after 05a merges. One PR to `develop`. **Merge gate:** `git tag -l 'v*' --no-contains <05a merge sha>` must print nothing, or a `v*` tag must contain 05a. In other words, no released server that lacks 05a may roll straight into this one (Task 8).

## Global Constraints
- Term shape exactly D10: `{ id, projectId, name, aliases, description?, datasetId, filters, createdAt, updatedAt, schemaVersion: 1 }`. Aliases use `sanitizeAliases` (`src/app/columnNames.ts:38`): at most 8, each 60 characters or fewer. Description is 500 characters or fewer. Filters: 1–50 `type: 'filter'` steps, no term inside a term. `datasetId` is immutable.
- A name or alias is unique across terms AND metric names (`aliasCollision`, `columnNames.ts:71`: case- and punctuation-blind). `metric:save`/`metric:update` refuse a term's name too.
- Expansion order at a door: `expandTerms` first, then the row-lock gates and `withLockSteps`, then the Live split and the answer-cache key (`ipc/visuals.ts:474-481`, `ipc/dashboards.ts:178-182`). The lock stays first in the list.
- Term records are read on every expansion, with no per-pod cache: any pod serves any request, and editing a term must change the next figure on every pod.
- A deleted term is refused, never skipped. An unreachable term on a chart, tile or metric is refused. One from the dashboard scope (`fromControl: true`, step 04) is left out with a visible note.
- Sentences go in `src/data/termMessages.ts` (05a) through `t()`, then `node scripts/i18n-extract.js`. `term:list`/`term:get` are classified `REDACT` in `scripts/rowPolicyReaders.ts`. `node scripts/check-contracts.js` must report 0. `src/api/index.ts` and `nav.ts` are append-only. `src/analysis/metrics.ts` is at 468 lines and takes no term code.
- Old pods: a 05a pod keeps term steps and refuses their figures (`termUnreadable`). It never reads `terms/`, skips a `term` Trash entry (`trashStore.listEntries` → `isRecordType`) and a `history/term/` version (`versions.isVersionType`). A pre-terms pod's bundle import refuses a bundle holding `terms/` (whitelist): this is documented.

## Review Focus
- A term on Customers.`region` applied to an Orders chart where Orders also has `region` must filter Customers' rows. It must never filter Orders'. On a path that cannot join (pivot, cohort, funnel, LOD, facets, parameter replay, FX), it is refused rather than applied to Orders. Pinned in Task 3.
- A restricted caller's chart whose term reaches a closed related dataset is refused `related`. Before this change, `reachesOther` saw only column names. Pinned in Task 5.
- Editing a term on one pod changes a cached figure drawn on another (the cache key holds the expanded steps). Pinned in Task 5.
- `versions:get` / `versions:diff` of a term would hand a restricted viewer its values. Pinned in Task 2.
- A term whose filter column was dropped from its dataset: refused with the column's name, never a wider figure. Pinned in Task 3.
- A term's own dates are a fixed filter. A compare or overlay never shifts them, and step 04 never moves them to a metric's `timeColumn`: expanded steps do not inherit `fromControl`. Pinned in Task 3.

---

### Task 1: The term record, its names, Trash and bundle
**Files:** Create `src/analysis/terms.ts`, `src/analysis/termNames.ts` · Modify `src/data/filterList.ts` (the `term` branch), `src/app/recordKinds.ts:15-26` (`'term'`, `RECORD_DIR.term = 'terms'`), `src/api/trash.ts:5`, `src/app/bundleRules.ts:40` (`terms/<uuid>.json`, count `terms`) and `:44` (`term` in the history regex), `src/analysis/recordDiff.ts:42-58` (`SaveKind` + `SAVE_KEYS.term = ['name','aliases','description','filters']`), `src/ipc/metrics.ts:434-439` (`nameTaken` → a term's name or alias also counts), `web/src/features/projects/api.ts:39`, `web/src/features/projects/TrashPage.tsx:24` (`term: { word: 'Glossary term', icon: 'list' }  // no `tag` icon exists in web/src/ui/icons/paths.ts`) · Test `scripts/test-terms.ts`
**Interfaces:** Produces
- `interface Term` (D10). `interface TermSummary { id; name; aliases: string[]; description?: string; datasetId; updatedAt }`. `interface TermInput { name: string; aliases?: unknown; description?: unknown; datasetId: string; filters: unknown }`.
- In `terms.ts`, mirroring `metrics.ts:213-468`: `listTerms(projectId): Promise<TermSummary[]>` (by name, locale-aware), `readTerm(projectId, id): Promise<Tagged<Term> | null>`, `getTerm(projectId, id): Promise<Term | null>`, `saveTerm(projectId, input: TermInput): Promise<Term | null>`, `updateTerm(projectId, id, patch: Partial<TermInput>, base?: unknown): Promise<Term | null>` (`lockedUpdate('term', …)`), `termProblem(projectId, input, exceptId?): Promise<{ field: 'name' | 'aliases' | 'filters' | 'datasetId'; error: string } | null>`.
- `termNameProblem(projectId, name, aliases, exceptId?): Promise<string | null>` in `termNames.ts`. `sanitizeTermStep(o): TermStep | null` (a UUID `term`, plus `fromControl: true` if set).
- Sentences: `termNameTaken(name, takenBy)`, `termNoFilters()`, `termInTerm()`, `termColumnMissing(column, dataset)`, `termDatasetGone()`.
- [ ] **Step 1: Write the failing test** — `test-terms.ts` part 1, in a temp `DATA_DIR`:
```ts
const t = await terms.saveTerm(P, { name: 'EMEA', aliases: ['Europe, Middle East'], datasetId: CUST, filters: [{ type: 'filter', column: 'region', op: 'in', values: ['EU', 'ME', 'AF'] }] });
ok('saved with sanitized aliases', t!.aliases.join('|') === 'Europe|Middle East' && t!.schemaVersion === 1);
ok('a metric name is taken', (await termNameProblem(P, 'revenue', [], undefined)) === termNameTaken('revenue', 'Revenue'));
ok('an alias another term holds is taken', (await termNameProblem(P, 'Europe area', ['europe'])) !== null);
ok('a term inside a term is refused', (await terms.termProblem(P, { ...IN, filters: [{ type: 'term', term: t!.id }] }))!.error === termInTerm());
ok('a column the dataset lacks is refused', (await terms.termProblem(P, { ...IN, filters: [{ type: 'filter', column: 'nope', op: 'not_empty' }] }))!.field === 'filters');
ok('metric:save refuses a term name', (await call('metric:save', { projectId: P, input: { ...M, name: 'emea' } })).ok === false);
ok('Trash: delete → listed → restore → readable', await trashRoundTrip(P, 'term', t!.id));
ok('a stale base refuses the update (409 record_changed)', isRecordChanged(await caught(() => terms.updateTerm(P, t!.id, { name: 'X' }, 'stale'))));
ok('the bundle carries terms', ruleFor(`terms/${t!.id}.json`)?.count === 'terms');
```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts` → `terms` module missing.
- [ ] **Step 3: Implement** — copy the metric store's id guards, atomic write and skip-corrupt behaviour. `normalize` keeps only `type: 'filter'` steps. Delete goes through `trash.trashRecord(projectId, 'term', id)`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-terms.js && node scripts/test-trash.js && node scripts/test-bundle.js && node scripts/test-metrics.js && node scripts/test-editConflicts.js && npm run test:web` → all `ok`.
- [ ] **Step 5: Commit** — `git add src/analysis/terms.ts src/analysis/termNames.ts src/data src/app src/api/trash.ts src/analysis/recordDiff.ts src/ipc/metrics.ts web/src/features/projects scripts/test-terms.ts src/i18n` · "Add the glossary term record"

### Task 2: Contracts, handlers, versions and what a restricted viewer sees
**Files:** Create `src/api/terms.ts`, `src/ipc/terms.ts` · Modify `src/api/index.ts` (append `...terms`), `src/server/app.ts:561` (add `'../ipc/terms'` to the Data section's modules), `scripts/rowPolicyReaders.ts` (`'term:get': 'REDACT'`, `'term:list': 'REDACT'`), `src/api/versions.ts:5`, `src/app/versions.ts:35`, `src/analysis/recordDiff.ts:24/29-39/313-319` (`DiffType`, `CONTENT_KEYS.term = ['name','aliases','description','filters']`, `diffTerm`), `src/analysis/versionDiffParts.ts:243`, `src/ipc/versions.ts:25-62` (`writeBack` → `updateTerm`) and `:73-84`, `src/ipc/versionDiff.ts:204-217` · Test `scripts/test-terms.ts` part 2, `scripts/test-rowPolicySafetyNet.ts`, `scripts/test-versionHistory.ts`
**Interfaces:** Produces contracts (zod, project scope):
- `term:list` (read `{ projectId }`) → `{ ok: true; terms: Array<TermSummary & { definition: string }> }`.
- `term:get` (read `{ projectId, id }`) → `{ ok: true; term: Term; tag: string }`.
- `term:save` (write `{ projectId, input: { name: 1..200, aliases?: string[] ≤8 of ≤60, description?: ≤500, datasetId: Uuid, filters: Steps.max(50) } }`) → `{ ok: true; term } | { ok: false; error; field }`.
- `term:update` (write `{ projectId, id, base?: Base, patch }`, no `datasetId`).
- `term:delete` (write `{ projectId, id }`, to Trash).
- `termForCaller(projectId, t): Promise<Term & { valuesHidden?: true }>`. A caller `restrictedOn(projectId)` (`src/data/rowAccess.ts:273`) gets every filter step without `value`/`values`, and `valuesHidden: true`. `definition` is `describeTermFilters(term, hide)`, which names the columns and operators and writes "…" for hidden values. The tag is `tagForCaller` (`rowDoors.ts:227`). `versions:get` returns null, and `versions:diff`/`versions:figures` answer `versionGone()`, for a `term` asked by a restricted caller.
- [ ] **Step 1: Write the failing test**
```ts
const east = await W.call('east', 'term:get', { projectId: P, id: T });
ok('redact: east reads the name, aliases and description, but no value', east.body.term.name === 'EMEA' && !east.text.includes(H.W_CANARY) && east.body.term.valuesHidden === true);
ok('NEGATIVE CONTROL: the editor reads the values', (await W.call('ed', 'term:get', { projectId: P, id: T })).text.includes(H.W_CANARY));
ok('east gets no term version content', (await W.call('east', 'versions:get', { projectId: P, type: 'term', id: T, key: K })).body === null);
ok('restore of a term version is a save', (await call('versions:restore', { projectId: P, type: 'term', id: T, key: K0 })).ok === true);
```
- [ ] **Step 2: Run it to see it fail** — `node scripts/check-contracts.js` → `term:*` unresolved.
- [ ] **Step 3: Implement** — follow the handlers in `ipc/metrics.ts:442-511`: `versions.record(projectId, 'term', t)` on save and update.
- [ ] **Step 4: Run it to see it pass** — `node scripts/check-contracts.js && node scripts/test-terms.js && node scripts/test-rowPolicySafetyNet.js && node scripts/test-versionHistory.js && node scripts/test-versionDiff.js` → 0 unresolved, all `ok`.
- [ ] **Step 5: Commit** — `git add src/api src/ipc/terms.ts src/ipc/versions.ts src/ipc/versionDiff.ts src/app/versions.ts src/analysis src/server/app.ts scripts` · "Serve glossary terms, without their values to restricted viewers"

### Task 3: Expansion, and a term only filters its own dataset
**Files:** Modify `src/analysis/termExpand.ts` (the body), `src/data/filterStepSanitize.ts` (09a: keep a UUID `datasetId`), `src/data/transforms.ts` (`FilterStep.datasetId?: string` after `:106`; a guard in `stepFilter` `:367`), `src/engine/residentFilter.ts:61`, `src/engine/live/liveSpec.ts:233`, `src/analysis/joinPlan.ts:185-195` (`resolveColumnOwner(…, pinned?: string)`), `:222-226` and `:249`, `src/ipc/relationships.ts:141-143` and `:176`, `src/ipc/rowDoors.ts:52-60` (`reachesOther`). Scope marking: `src/data/filterList.ts` (`markScopeTerms`), `src/analysis/dashboardFilters.ts:43-56` (the `dashFilters` side), `src/publish/dashboardData.ts:354` (`comboScope`'s `filters`), `src/analysis/reportPages.ts:186` (a report KPI's `scope.filters`), `web/src/features/analyses/editor/Editor.tsx:228` (`ed.filters`, which MetricCard, stats, tree and summary cards send as is), `web/src/features/analyses/VisualTile.tsx:41` (the `dash` side). Step 04's `src/analysis/metricTime.ts` `rewriteControlPeriods` strips `fromControl` from `type: 'filter'` steps only, so a term keeps its mark until `expandTerms` · Test `scripts/test-termExpand.ts`, `scripts/test-joins.ts`, `scripts/test-metricTime.ts`
**Interfaces:** Consumes `FilterStep.fromControl`, `stepKey`, `rewriteControlPeriods` (step 04; it marks only the steps a date control makes). Produces:
- `markScopeTerms(steps: readonly FilterStep[]): FilterStep[]`. Every `TermStep` in a dashboard's scope (its filters, controls and selection) gets `fromControl: true`, and other steps are returned unchanged. The web twin sits in `web/src/features/visuals/encoding.ts`. Like step 04's mark, it is not a security property: it only decides a note rather than a refusal.
- `expandTerms` (05a signature). Each term step becomes `term.filters`, in order, without `fromControl`.
  - Own dataset: steps unchanged.
  - Another dataset reachable by `findPath` (`joinPlan.ts:87`, never on a Live figure): each step gets `datasetId: term.datasetId`.
  - Missing term → `TermNotExpandedError('deleted', termDeleted(nameInTrash) | termPurged())`.
  - Unreachable → `'unreachable'` (`termUnreachable(name, termDs, ds)`).
  - A column no longer there → `'column_gone'` (`termColumnGone(name, column, termDs)`).
  - With `fromControl`, the last two instead push `termNotApplied(name, ds)` to `notes` and leave the term out.
- Sentences: `termDeleted(name)` "{name} was deleted. Remove it from this filter, or restore it from Trash.", `termPurged()`, `termUnreachable`, `termColumnGone`, `termNotApplied`, `termNoJoinHere()`, `termNotHere()`. A scenario driver's target must be ONE step, so `loadInputs` refuses a term target with `termNotHere()`.
- `FilterStep.datasetId`: "set on a term's step from another dataset; only the join planner applies it". The join planner resolves a pinned step to exactly that dataset, or refuses (`termNoJoinHere()`). It strips `datasetId` after renaming. `stepFilter`, `filterPredicate` and `adaptFilter` throw `TermNotExpandedError('unreachable', termNoJoinHere())` on a step still carrying `datasetId`. `reachesOther` returns true for a filter whose `datasetId` ≠ the figure's.
- [ ] **Step 1: Write the failing test** — `test-termExpand.ts` (temp `DATA_DIR`, Orders → Customers many-to-one, both with `region`):
```ts
const e = await expandTerms(P, ORDERS, [F0, { type: 'term', term: EMEA }]);
ok('a Customers term from Orders: pinned steps, after the others', stableStringify(e.steps) === stableStringify([F0, { ...EMEA_F, datasetId: CUST }]));
ok('own-dataset term: plain steps', (await expandTerms(P, CUST, [{ type: 'term', term: EMEA }])).steps[0].datasetId === undefined);
ok('deleted: refused with its name from Trash', (await rejects(expandTerms(P, ORDERS, [TERM_DELETED]))).message === termDeleted('Old term'));
ok('unrelated dataset: refused', (await rejects(expandTerms(P, OTHER, [TERM_EMEA]))).reason === 'unreachable');
ok('unrelated under a control: left out, noted', stableStringify(await expandTerms(P, OTHER, [{ ...TERM_EMEA, fromControl: true }])) === stableStringify({ steps: [], notes: [termNotApplied('EMEA', 'Other')] }));
ok('expanded steps never carry fromControl', !(await expandTerms(P, CUST, [{ ...TERM_RECENT, fromControl: true }])).steps.some((s) => 'fromControl' in s));
ok('step 04\'s rewrite keeps a term\'s mark', (rewriteControlPeriods([{ ...TERM_EMEA, fromControl: true }, CTRL], 'ship_date')[0] as TermStep).fromControl === true);
ok('a dashboard\'s scope marks its terms only', stableStringify(markScopeTerms([F0, TERM_EMEA])) === stableStringify([F0, { ...TERM_EMEA, fromControl: true }]));
```
`test-joins.ts`: an Orders chart by `status`, filtered by the EMEA term. JS (`joinedVizDataJs`) and resident (`joinedAggregateResident`) agree with `Object.is` on every cell. NEGATIVE CONTROL: the same chart with a bare `region in (…)` filter (Orders' own `region`) gives different figures. A pivot of the same chart is refused `termNoJoinHere()`.
- [ ] **Step 2: Run it to see it fail** — `node scripts/test-termExpand.js` → `'unreadable'` from the 05a stub.
- [ ] **Step 3: Implement** — read each term with `getTerm`. A deleted term's name comes from `trashStore.readEntry(projectId, 'term', id)`. Reach uses `rels.listRelationships`, `findPath` and `getDatasetMeta`. Comment `// shortcut: one record read per term per figure, no memo; add a request-scoped memo if traces show it`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-termExpand.js && node scripts/test-joins.js && node scripts/test-termGuards.js && node scripts/test-transforms.js && node scripts/test-file-size.js` → all `ok`.
- [ ] **Step 5: Commit** — `git add src/analysis/termExpand.ts src/data src/engine src/analysis/joinPlan.ts src/ipc scripts/test-termExpand.ts scripts/test-joins.ts src/i18n` · "Expand glossary terms at the doors, each on its own dataset"

### Task 4: The Assistant reads and uses terms
**Files:** Create `src/ai/termFacts.ts` · Modify `src/ai/answerSpec.ts:254-281` (`resolveFilter` takes `{ term }`) and `:312-361` (`opts.terms?: SpecTerm[]`), `src/ipc/answers.ts:142-219` (`computeCard` → `expandAnswerTerms`; `card.steps` keep term steps) and `:245` (`specTerms`), `src/ipc/liveAnswers.ts:162-176` (term steps join `lock`, the never-skip list), `src/ai/copilotFacts.ts:193`, `src/ai/liveFacts.ts:180`, `src/analysis/planFacts.ts:123` (one `termLines` call each), `src/ipc/copilot.ts:151` (`factTerms` beside `factMetrics`), `src/ai/suggestedAction.ts:196` (one sentence) · Test `scripts/test-answerSpec.ts`, `scripts/test-copilot.ts`, `scripts/test-liveRouteAnswers.ts`
**Interfaces:** Produces
- `interface SpecTerm { id: string; name: string; aliases: string[]; datasetId: string }`.
- `interface FactTerm { name: string; aliases: string[]; description?: string; definition: string }`.
- `termLines(lines: string[], terms: FactTerm[]): void`. It writes "Glossary terms — filter by one with {"term":"<name>"}:" and then one line per term, with no figures and so no ledger entry. The facts list the context dataset's own terms. `definition` hides values when the caller is restricted or the column is withheld (`withheldColumns`).
- `expandAnswerTerms` body: an own-dataset term → its steps. Any other → `TermNotExpandedError('unreachable', termOtherDataset(name, termDs, ds))`. Deleted → as in Task 3. `card.steps` holds `{ type: 'term', term }` in place of the expansion, so `answer:saveVisual` (`src/ipc/answerSave.ts:41`, which saves `card.steps`) keeps the reference.
- Prompt sentence: 'A glossary term from the FACTS is the filter {"term":"<term name>"}.'
- [ ] **Step 1: Write the failing test**
```ts
const r = validateAnswerSpec({ ...RAW, filters: [{ term: 'europe' }] }, [CUST_DS], { terms: [{ id: EMEA, name: 'EMEA', aliases: ['Europe'], datasetId: CUST }] });
ok('an alias resolves to the term id', r.ok && stableStringify(r.spec.filters) === stableStringify([{ term: EMEA }]));
ok('a term of another dataset is refused with a reason', !validateAnswerSpec({ ...RAW_ORDERS, filters: [{ term: 'EMEA' }] }, [ORDERS_DS, CUST_DS], OPTS).ok);
ok('the card equals the inline filter and its steps keep the term', sameFigure(cardT, cardInline) && cardT.card.steps.some((s) => s.type === 'term'));
ok('answer:saveVisual stores the term step', saved.filters.some((s) => s.type === 'term' && s.term === EMEA));
ok('facts name the term; a restricted caller\'s facts hold no value', facts.includes('"EMEA"') && !factsEast.includes(H.W_CANARY));
```
- [ ] **Step 2: Run it to see it fail** — `node scripts/test-answerSpec.js` → `{ term }` is an unknown filter.
- [ ] **Step 3: Implement** — match names as `taughtColumn` does (`columnNames.ts:88`): exact ignoring case, then squashed, and only an unambiguous match counts.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-answerSpec.js && node scripts/test-copilot.js && node scripts/test-copilot-analysis-facts.js && node scripts/test-liveRouteAnswers.js && node scripts/test-answerFacts.js && node scripts/test-answerSaveVisual.js` → all `ok`.
- [ ] **Step 5: Commit** — `git add src/ai src/ipc src/analysis/planFacts.ts scripts` · "Let the Assistant read and filter by glossary terms"

### Task 5: Every door, end to end, and the notes on tiles
**Files:** Modify `src/ipc/visuals.ts:397-417` (`VizDataReply` `notes?: string[]`), `src/ipc/dashboards.ts:155` (the KPI reply `notes?: string[]`), `src/ipc/rowDoors.ts:122-160` (`lockedViz`/`lockedMetric` attach `TermExpansion.notes` to an `ok` reply), `src/ipc/analysesServer.ts:132-175` (each item passes `notes` through), `src/publish/dashboardData.ts:456/488` (a published tile keeps `notes`), `scripts/test-termDoors.ts` (05a's), `scripts/termSites.ts` (re-count) · Test `scripts/test-termDoors.ts`
**Interfaces:** Produces `notes?: string[]` on the chart reply, the KPI reply and each `analysis:tiles` item: the sentences of the scope terms left out (`termNotApplied`). Omitted when empty, so every other reply is byte-identical.
- [ ] **Step 1: Write the failing test** — for each 05a `ENTRIES` channel (`answer:card` included), on the extract dataset:
```ts
ok(`${ch}: a term equals its filter written inline`, sameFigure(await call(ch, withTerm(body)), await call(ch, withInline(body))));
ok(`NEGATIVE CONTROL: ${ch}: the term filters something`, !sameFigure(await call(ch, withTerm(body)), await call(ch, unfiltered(body))));
await call('term:update', { projectId: P, id: EMEA, patch: { filters: [NARROWER] } });
ok(`${ch}: editing the term changes the cached figure`, !sameFigure(await call(ch, withTerm(body)), before));
ok(`NEGATIVE CONTROL: ${ch} unedited is a cache hit`, cacheHits() === hits0 + 1);
await call('term:delete', { projectId: P, id: EMEA });
ok(`${ch}: a deleted term is refused with its sentence`, refusedTerm(r) && r.text.includes(termDeleted('EMEA')));
```
Also:
- Live: a term on the Live dataset equals the inline filter (fake warehouse). A Customers term on a Live chart is refused `unreachable`.
- Restricted `east` on Orders (rules), with the Customers term and Customers closed → `row_policy` `related`. NEGATIVE CONTROL: Customers open → answered.
- A dashboard: the EMEA term as a sheet filter, a tile on an unrelated dataset → `analysis:tiles` answers the chart item and the KPI item with `notes[0] === termNotApplied('EMEA', 'Other')`. The same term as the tile's own filter is refused. A published page build (`publish/dashboardData.ts`) does the same.
- A metric whose `filters` hold a term: `metric:value` equals the inline metric.
- [ ] **Step 2: Run it to see it fail** — `node scripts/test-termDoors.js` → the `analysis:tiles` items answer without `notes`.
- [ ] **Step 3: Implement** — the doors hold the expansion's notes and spread `...(notes.length ? { notes } : {})` onto an `ok` reply. `analysis:tiles` copies `r.notes` onto `res`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-termDoors.js && node scripts/test-termSites.js && node scripts/test-liveRoute.js && node scripts/test-rowPolicyFanOut.js && node scripts/test-visualsServer.js` → all `ok`; golden fixtures untouched.
- [ ] **Step 5: Commit** — `git add src/ipc src/publish/dashboardData.ts scripts/test-termDoors.ts scripts/termSites.ts` · "Prove glossary terms at every figure door and note the ones a tile skips"

### Task 6: MCP
**Files:** Modify `src/automation/registry.ts:200-216` (a `list_terms` tool; a `terms` arg on `aggregate` and `metric_value`), `src/automation/handlers.ts:189-209` (`termsList`, `metricValue(ctx, ref, terms?)`), `src/automation/creators.ts:93-99`, `src/automation/resolve.ts` (`resolveTermRef`), `docs/automation.md` (regenerated), `plugins/ordinate/skills/answer-data-questions/SKILL.md:18` (one row) · Test `scripts/test-automationTools.ts`, `scripts/test-automation.ts`, `scripts/test-pluginSkills.ts`
**Interfaces:** Produces
- `list_terms` (readOnly, no args) → `[{ id, name, aliases, description, dataset, definition }]`, as the token's user (redacted like `term:list`).
- `terms: { type: 'array', items: { type: 'string' }, description: 'Glossary term names, aliases or ids; each applies as its filter.' }`.
- `resolveTermRef(projectId, ref): Promise<string>`. An unknown ref throws `AutomationError('usage', 'No glossary term called "<ref>".')`.
- [ ] **Step 1: Write the failing test** — `ok('aggregate with terms:["EMEA"] equals the inline filter', sameSeries(withTerm, inline))`; `ok('metric_value with a term differs from without', a.value !== b.value)`; `ok('list_terms as a restricted token holds no value', !text.includes(H.W_CANARY))`.
- [ ] **Step 2: Run it to see it fail** — `node scripts/test-automationTools.js` → the tool is unknown.
- [ ] **Step 3: Implement** — the handlers append `{ type: 'term', term: id }` to the filters, and the doors do the rest.
- [ ] **Step 4: Run it to see it pass** — `node scripts/gen-automation-docs.js && node scripts/test-automationTools.js && node scripts/test-automation.js && node scripts/test-pluginSkills.js` → all `ok`.
- [ ] **Step 5: Commit** — `git add src/automation docs/automation.md plugins/ordinate scripts` · "Add list_terms and term filters to the MCP tools"

### Task 7: The web: edit terms, pick them, see the notes
**Files:** Create `web/src/features/model/terms/api.ts`, `TermDialog.tsx`, `TermsList.tsx`, `TermChip.tsx`, `Terms.module.css` · Modify `web/src/features/analyses/metrics/MetricsPage.tsx` (a **Glossary** section; step 10 moves it to its tab), `web/src/features/visuals/filters/FilterRows.tsx` (an **Add term** menu, and term rows as `TermChip` + remove), `web/src/features/analyses/VisualTile.tsx` and the KPI card (`notes` as a muted `role="note"` line), `web/src/features/explore/Question.tsx:225-233` (a term pill) · Test Vitest next to each; `web/e2e/analyses.e2e.ts` (the Metrics section at `:301`)
**Interfaces:** Consumes `term:*`. `TermDialog({ projectId, term?, onClose })` has fields Name, Also called (one comma-separated line, as the catalog's column panel), Description, Dataset (create only) and Filters (`FilterRows`). It shows the server's `error` under `field`. `TermsList` has a skeleton while loading, a designed empty state ("No terms yet. A term is a filter with a name — EMEA, Enterprise, Recent order — that every chart and the Assistant can use.") with **New term**, and an error state. All of it works in both themes.
- [ ] **Step 1: Write the failing test** — `TermDialog`: typing "Europe, ME" sends `aliases: ['Europe', 'ME']`, and a `{ ok:false, field:'name' }` reply shows its sentence under Name. `FilterRows`: Add term → EMEA calls `onChange([...f, { type: 'term', term: EMEA }])`, and the term row reads "EMEA". `VisualTile` renders `notes[0]`. e2e: create a term on the Metrics page, add it to a visual's filters, see the chart change. The RPC budget stays ≤ 25.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web` → the modules are missing.
- [ ] **Step 3: Implement** — reuse `ui/Button`, `ui/Select`, the dialog primitive the metric editor uses, and `useTerms` (one `term:list` per page).
- [ ] **Step 4: Run it to see it pass** — `npm run test:web && npm --prefix web run e2e -- analyses visuals && npm --prefix web run size && npm run lint` → green. Look at the light and dark screenshots.
- [ ] **Step 5: Commit** — `git add web` · "Edit glossary terms and use them in filters"

### Task 8: The release gap
**Files:** Modify `docs/server/upgrade.md` (05a's section: name both versions)
- [ ] **Step 1: Check the gate** — `git tag -l 'v*' --no-contains <05a merge sha>` prints nothing, or `git tag --contains <05a merge sha>` lists a `v*` tag. If neither holds, stop and ask the owner to release 05a first (no release without the owner).
- [ ] **Step 2: Implement** — in 05a's section write "Upgrade to the release that adds glossary terms from **v<first tag holding 05a>** or later", or "from any release" when no older server release exists.
- [ ] **Step 3: Run it to see it pass** — `node scripts/test-serverDocs.js` → `ok`.
- [ ] **Step 4: Commit** — `git add docs/server/upgrade.md` · "Name the release glossary terms upgrade from"

Not in this step: a `term:usage` list (step 10's "Used by"), terms in ⌘K search, a save-time check that a metric's term is reachable from the metric's dataset (the door refuses it at draw time), and scenario driver targets as terms (refused with `termNotHere()`).
