# Semantic layer part 1, step 05a: unknown filter steps kept (terms reader) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one release in which every pod and every browser keeps a filter step it cannot read (a glossary term `{ type: 'term', term }` above all) verbatim on re-save and refuses, with a sentence, any figure that would need it, so step 05b's terms can never be silently dropped by an older pod.
**Architecture:** One filter-list sanitizer (`sanitizeFilterList`) replaces the five "keep only `type === 'filter'`" wrappers. Every merge and web save path keeps non-filter steps. Every figure entry calls `expandTerms`, which in this PR refuses any non-filter step with a typed `TermNotExpandedError`. The JS fold, the resident filter compiler and the Live compiler throw on a leaked term step (the second line of defence). Prepare lists (`dataset.steps`) never accept a term.
**Tech Stack:** `src/data`, `src/analysis`, `src/ai`, `src/ipc`, `src/engine`, `src/server/app.ts`, web filter helpers, `docs/server/upgrade.md`.
**Spec:** docs/semantic-layer/00-design.md (D10, D11, D12) · Index: docs/superpowers/plans/2026-11-03-semantic-layer-p1-00-index.md
**Branch and PR:** `feat/semantic-p1-05a-unknown-steps-kept` off `origin/develop` after step 04 merges **and after `feat/semantic-p1-09a-via-guard`** (it moves `sanitizeFilterStep` into `src/data/filterStepSanitize.ts`). One PR to `develop`. Step 05b must not reach a release before this one has (Task 7).

> **Index note (2026-11-03):** this PR is in release 1 and needs 09a and **04a** (step 04's reader), not all of step 04. If it needs step 04's exported `stepKey`, move that export into 04a. See the index.

## Global Constraints
- An OLD pod's `sanitizeStep` returns `null` for `type: 'term'` (`src/data/transforms.ts:702`): on read that widens a figure, on re-save it deletes the reference. This PR is the cure. It ships alone, one release ahead of 05b.
- Never drop and never skip: a step this pod cannot apply refuses the figure (typed `code: 'term'` + a catalog sentence through `t()`), the same pattern as the 08/09 guards. Match their wording style.
- Prepare is unchanged: `sanitizeSteps` still drops unknown types, and `applyPipeline` still skips an unknown Prepare step with a warning (`workspace.md`). Only a `term` step throws there.
- Kept steps are plain JSON only: JSON round-trip (drop on throw: BigInt), at most `MAX_KEPT_STEP_BYTES = 2048` serialized, `type` matching `/^[a-z][a-z0-9_]{0,63}$/`. Anything else is dropped, as today.
- `src/data/transforms.ts` must stay ≤ 800 (`scripts/test-file-size.ts`). It is ~770 after 09a plus step 04's lines; Task 1 moves the rest of the sanitizer out anyway.
- Sentences live in a new `src/data/termMessages.ts`, appended to `MAIN_FILES` (`scripts/i18n-extract.ts:346`), then `node scripts/i18n-extract.js`. Never hand-edit `en.json`.
- Golden fixtures are not re-recorded. Lint 0. `node scripts/check-contracts.js` 0 unresolved (no new contract here).

## Review Focus
- A browser tab still running the pre-05a bundle strips a term in `liveFilters` on save. That is the residual risk; Task 7's upgrade note covers it, and a reload fixes it. Pinned by nothing a test can reach.
- A dashboard KPI whose `metric:value` fails on a term must not fall back to "The metric this card showed was deleted." (`src/ipc/analysesServer.ts:147-152`). Pinned in Task 4.
- `alerts:test` passes unsanitized request filters to `computeCardMetric` today (`src/analysis/alertStore.ts:515`). A `calculated_field` step there runs. The door's refusal closes it. Pinned in Task 4.
- `withLockSteps` drops non-filter steps (`src/data/rowAccess.ts:290`). A term that got past the door there would vanish without a sound. Pinned in Task 2.
- Dedupe must never merge a term step with a filter step: step 04's exported `stepKey` keys a non-filter step by `stableStringify` of the whole step. Pinned in Task 2.
- An unknown step on a `scenario` driver target (`scenarioModel.ts:108`) is ONE step: it is kept as the target and refused at `scenario:card`. Pinned in Task 4.

---

### Task 1: The term step type, its error, and the JS fold's guard
**Files:** Create `src/data/termStep.ts`, `src/data/termMessages.ts`, `src/data/stepSanitize.ts` · Modify `src/data/transforms.ts` (move the `// ── sanitizeSteps` section, `:678`–EOF as it stands after 09a, into `stepSanitize.ts` and re-export `sanitizeSteps`; `foldStep` `:271`; `dispatch` default `:312-313`), `scripts/i18n-extract.ts:346` (append), `src/server/app.ts:480-484` (one branch after `isRowPolicyError`) · Test `scripts/test-termGuards.ts`
**Interfaces:** Produces
- `interface TermStep { type: 'term'; term: string; fromControl?: true }`, `isTermStep(s: unknown): s is TermStep` (type `'term'` and a string `term`).
- `TERM_CODE = 'term'`; `type TermReason = 'not_expanded' | 'unreadable' | 'deleted' | 'unreachable' | 'column_gone'`.
- `class TermNotExpandedError extends Error { readonly code = TERM_CODE; readonly reason: TermReason; constructor(reason: TermReason, message?: string) }`. The message defaults to `termNotExpanded()` / `termUnreadable()` for those two reasons. `isTermNotExpandedError(err): err is TermNotExpandedError`, by class or by `name` + `code`, as `isRowPolicyError` does (`src/data/rowPolicyError.ts:41`).
- `termRefusal(err: TermNotExpandedError): { ok: false; code: 'term'; reason: TermReason; error: string }`.
- `termMessages.ts`: `termUnreadable()` "This figure uses a filter from a newer version of Ordinate. Finish the upgrade, then try again." and `termNotExpanded()` "A glossary term reached the engine without being expanded, so the figure was not computed."
- `app.ts`: `isTermNotExpandedError(err)` → `409 { error: 'term', code: 'term', reason, message }`.
- [ ] **Step 1: Write the failing test** — `test-termGuards.ts`, part 1:
```ts
const T = { type: 'term', term: '7d2c1f4e-1111-4222-8333-444455556666' } as unknown as FilterStep;
let thrown: unknown = null;
try { applyPipeline(SRC, [T]); } catch (e) { thrown = e; }
ok('a term step reaching applyPipeline throws, typed', isTermNotExpandedError(thrown) && (thrown as TermNotExpandedError).reason === 'not_expanded');
const r = applyPipeline(SRC, [{ type: 'nope' } as unknown as TransformStep]);
ok('NEGATIVE CONTROL: an unknown Prepare step still skips with its warning', r.rowCount === SRC.rows.length && r.warnings[0] === 'Unknown step type "nope" skipped');
ok('Prepare never accepts a term', sanitizeSteps([T]).length === 0);
ok('sanitizeSteps is re-exported unchanged', sanitizeSteps([{ type: 'filter', column: 'a', op: '=', value: 1 }]).length === 1);
```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts` fails to compile the new imports (`termStep` missing).
- [ ] **Step 3: Implement** — `dispatch` default: `if ((step as { type?: unknown }).type === 'term') throw new TermNotExpandedError('not_expanded');` before the skip. `foldStep`'s catch rethrows `isTermNotExpandedError(e)` beside `isRowPolicyError(e)`. `stepSanitize.ts` holds `sanitizeSteps`/`sanitizeStep`/`asString`/`isCell` verbatim. Its type helpers come from transforms by type-only import, and `STEP_TYPES` is read at call time, so the import cycle is safe.
- [ ] **Step 4: Run it to see it pass** — `npm run build:ts && node scripts/test-termGuards.js && node scripts/test-transforms.js && node scripts/i18n-extract.js && node scripts/test-i18n.js && node scripts/test-file-size.js` → all `ok`, transforms.ts < 700 lines.
- [ ] **Step 5: Commit** — `git add src/data/termStep.ts src/data/termMessages.ts src/data/stepSanitize.ts src/data/transforms.ts src/server/app.ts scripts/i18n-extract.ts src/i18n scripts/test-termGuards.ts` · "Add the term step type and make the JS fold refuse an unexpanded term"

### Task 2: One filter-list sanitizer that keeps what it cannot read
**Files:** Create `src/data/filterList.ts` (beside 09a's `filterStepSanitize.ts`) · Modify the server sites marked **2** in the inventory below: `visuals.ts:464-466`, `dashboards.ts:644-646`, `metrics.ts:213-215`, `storyModel.ts:67-69`, `scenarioModel.ts:107-109`, `dashboardFilters.ts:33-56`, `cardModel.ts:89-120`, `rowAccess.ts:289-294`, `dashboardDelta.ts:301-307`, `analysisPlan.ts:686-696`, `answerSpec.ts:40-42` and `:412-424`, `answers.ts:363-372` (`tileSpec`), plus each consumer `tsc` names once `AnswerFilter` widens · Test `scripts/test-filterListKept.ts`
**Interfaces:** Consumes `sanitizeFilterStep` (09a), `stepKey` (step 04). Produces
- `sanitizeFilterList(raw: unknown): FilterStep[]`. It keeps, in order, every `type: 'filter'` step `sanitizeFilterStep` accepts and every other step within the kept-step limits, verbatim. The return type is `FilterStep[]`, with the comment `// shortcut: a kept/term step rides in FilterStep[] until expandTerms at the door; widening the type touches ~290 sites — the term-site inventory test is the check`.
- `isKeptStep(s: unknown): boolean`: an object whose `type` is a string other than `'filter'`.
- `AnswerFilter` gains `| { term: string }`. `sanitizeStoredSpec` keeps `{ term }` when it is a UUID, and nothing else of a column-less filter.
- `stepKey`: a kept step's key is `'kept:' + stableStringify(s)` (`src/engine/queryCache.ts:89`).
- `withLockSteps` keeps term steps after the lock (`f.type === 'filter' || isTermStep(f)`).
- `keepFilters` / `validateVisual` pass kept steps through without a column check.
- `tileSpec` maps a term step to `{ term }` and ignores no step.
- [ ] **Step 1: Write the failing test** — for each store: `visuals` (save/get/update name/get), `analysis` (dashboard `filters` + a sheet card's inline `visual.filters`), `metrics`, `stories` (a visual block), `alertStore.saveRule`, `scenarios` (driver `target.filter`), `savedViews`, `publishedCopy`, `copilot.appendTurn` (answer `filters: [{ term: U }]`):
```ts
const TERM = { type: 'term', term: U };
const FUTURE = { type: 'future_x', a: 1, nested: { b: [2] } };
ok(`${store}: a term and a future step survive save → get → unrelated update → get`, stableStringify(got.filters) === stableStringify([F0, TERM, FUTURE]));
ok(`${store}: a 3 KB unknown step is dropped`, !has(gotBig.filters, 'huge'));
ok('merge keeps a term once and never folds it into a filter', stableStringify(mergeDashboardFilters([TERM, F0], [TERM, F0])) === stableStringify([TERM, F0]));
ok('withLockSteps keeps a term after the lock', stableStringify(withLockSteps(LOCK, [TERM])) === stableStringify([...LOCK.steps, TERM]));
ok('NEGATIVE CONTROL: datasets.updateSteps stores no term step', !(await datasets.updateSteps(P, D, [F0, TERM]))!.dataset.steps!.some((s) => s.type === 'term'));
```
- [ ] **Step 2: Run it to see it fail** — `node scripts/test-filterListKept.js` → the term is missing after save.
- [ ] **Step 3: Implement** — each wrapper's body becomes `return sanitizeFilterList(raw);`. Every place `tsc` flags on `f.column` of `{ term }` skips the term: in held values, matching, facts and words it is not a column filter. Each site is listed in the inventory under F.
- [ ] **Step 4: Run it to see it pass** — `npm run build:ts && node scripts/test-filterListKept.js && node scripts/test-visuals.js && node scripts/test-dashboardFilters.js && node scripts/test-metrics.js && node scripts/test-storyModel.js && node scripts/test-scenarios.js && node scripts/test-alerts.js && node scripts/test-answerSpec.js && node scripts/test-answerRefine.js && node scripts/test-copilot.js && node scripts/test-rowPolicy.js` → all `ok`.
- [ ] **Step 5: Commit** — `git add src/data/filterList.ts src/analysis src/ai src/ipc src/data/rowAccess.ts scripts/test-filterListKept.ts` · "Keep filter steps this pod cannot read through every save and merge"

### Task 3: The resident and Live compilers refuse a leaked term
**Files:** Modify `src/engine/residentFilter.ts:61`, `src/engine/live/liveSpec.ts:233` (`adaptFilter`) and `:392-412` (`fromAnswerSpec`), `src/ai/answerSpec.ts:507-510` (`specFilterSteps`) · Test `scripts/test-termGuards.ts` (part 2)
**Interfaces:** Each throws `new TermNotExpandedError('not_expanded')` on `isTermStep(s)` (or `'term' in f` for an `AnswerFilter`) before its existing `type !== 'filter'` → `null`. A resident caller turns any throw into `null`, so the JS fallback throws it again: loud either way.
- [ ] **Step 1: Write the failing test**
```ts
ok('Live chart compile throws on a term', throwsTerm(() => fromVizEncoding(ENC, [T], LIVE_COLS)));
ok('Live KPI compile throws on a term', throwsTerm(() => fromMetric({ column: 'sales', aggregation: 'sum' }, [T], LIVE_COLS)));
ok('Live answer compile throws on a term', throwsTerm(() => fromAnswerSpec({ ...SPEC, filters: [{ term: U }] }, LIVE_COLS)));
ok('resident predicate throws on a term', throwsTerm(() => filterPredicate(COLS, T, [])));
ok('answer steps throw on a term', throwsTerm(() => specFilterSteps({ filters: [{ term: U }] }, COLS, ROWS)));
ok('NEGATIVE CONTROL: an unknown column still skips with its warning', (() => { const w: string[] = []; return adaptFilter({ type: 'filter', column: 'zz', op: '=', value: 1 }, LIVE_COLS, {}, w) === null && w[0] === 'Filter skipped: unknown column "zz"'; })());
```
- [ ] **Step 2: Run it to see it fail** — `node scripts/test-termGuards.js` → `fromVizEncoding` returns ok.
- [ ] **Step 3: Implement** — one guard line per site.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-termGuards.js && node scripts/test-liveParity.js && node scripts/test-liveRoute.js && node scripts/test-liveRouteAnswers.js` → all `ok`.
- [ ] **Step 5: Commit** — `git add src/engine src/ai/answerSpec.ts scripts/test-termGuards.ts` · "Make the resident and Live compilers refuse an unexpanded term"

### Task 4: Every figure entry refuses a step it cannot apply
**Files:** Create `src/analysis/termExpand.ts` · Modify `src/ipc/rowDoors.ts:122-141` (`lockedViz`, first line, before `lockOrRefusal`) and `:144-160` (`lockedMetric`, first line), `src/ipc/answers.ts:142-148` (`computeCard`), `src/ipc/datasets.ts:200` (`pageFor`), `src/ipc/stats.ts:56` (`compute`), `src/ipc/drivers.ts:286` (`driversFor`, over `spec.filters`), `src/analysis/scenarioResolve.ts:145` (`loadInputs`, over `all` and each driver filter), `src/ipc/visuals.ts:417` (`code` += `'term'`), `src/ipc/answers.ts:106` (`Failure.code` += `'term'`), `src/ipc/analysesServer.ts:57-64` (`call` keeps `code`/`reason` of a caught term error) and `:147-152` (return a `code: 'term'` reply as is, never the "deleted" fallback) · Test `scripts/test-termDoors.ts`
**Interfaces:** Produces
- `interface TermExpansion { steps: FilterStep[]; notes: string[] }`.
- `expandTerms(projectId: string, datasetId: string, steps: readonly FilterStep[] | undefined): Promise<TermExpansion>`. In this PR it throws `new TermNotExpandedError('unreadable')` when any step's `type !== 'filter'`, else returns `{ steps: [...steps], notes: [] }`.
- `expandAnswerTerms(projectId: string, spec: AnswerSpec): Promise<{ spec: AnswerSpec; steps: FilterStep[] }>`. In this PR it throws `'unreadable'` on any `{ term }`.
- `lockedViz` returns `termRefusal(err)`. Every other door lets the error throw, as `RowPolicyError` does.
- [ ] **Step 1: Write the failing test** — on the real route in server mode, with the harness of `scripts/test-liveSafetyNet.ts` (an extract dataset plus a Live one over `liveFakeConnector`). Each entry is called with `filters: [F0, TERM]`:
```ts
const ENTRIES: Array<[string, object]> = [
  ['visual:data', viz], ['visual:dataBatch', batch], ['dashboard:metric', kpi], ['metric:value', mv], ['analysis:tiles', tiles /* a visual, a KPI with metricId and no column, a stats tile */],
  ['answer:card', { projectId: P, spec: { ...SPEC, filters: [{ term: U }] } }], ['visual:rows', drill], ['stats:tile', stats], ['drivers:explain', drv], ['scenario:card', scen], ['alerts:test', alert],
];
for (const [ch, body] of ENTRIES) for (const ds of [EXTRACT, LIVE]) {
  const r = await call(ch, at(body, ds));
  ok(`${ch} on ${ds.mode}: refused, typed, with the sentence — never a figure`, refusedTerm(r) && r.text.includes(termUnreadable()) && !hasFigure(r));
  const plain = await call(ch, at(withoutTerm(body), ds));
  ok(`NEGATIVE CONTROL: ${ch} on ${ds.mode} without the term answers`, !refusedTerm(plain));
}
ok('a KPI with no column whose metric:value refused says why, not "deleted"', tilesReply.items[1].code === 'term' && !/was deleted/.test(tilesReply.items[1].error));
ok('alerts:test refuses a raw calculated_field step (it used to run)', refusedTerm(await call('alerts:test', ruleWith([{ type: 'calculated_field', name: 'x', expression: '1' }]))));
```
`refusedTerm(r)`: HTTP 409 `code: 'term'`, or any item `{ ok: false, code: 'term' }`. The Live variant skips `stats:tile`, `drivers:explain`, `scenario:card` and `visual:rows`, which already refuse Live with `live_dataset`.
- [ ] **Step 2: Run it to see it fail** — `node scripts/test-termDoors.js` → `visual:data` answers 200 with a figure.
- [ ] **Step 3: Implement** — call `expandTerms` at each named entry and use its `steps` from there on. `lockedViz` wraps the call in try/catch → `termRefusal`. A door that has a `notes` slot ignores the (empty) notes until 05b.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-termDoors.js && node scripts/test-rowPolicySafetyNet.js && node scripts/test-liveSafetyNet.js && node scripts/test-visualsServer.js && node scripts/test-drillScope.js && node scripts/test-drivers.js && node scripts/test-scenarios.js && node scripts/test-statsVectors.js && node scripts/test-alerts.js` → all `ok`.
- [ ] **Step 5: Commit** — `git add src/analysis/termExpand.ts src/ipc src/analysis/scenarioResolve.ts scripts/test-termDoors.ts` · "Refuse, never skip, a filter step a figure door cannot apply"

### Task 5: The web keeps steps it cannot edit
**Files:** Modify `web/src/features/visuals/encoding.ts:50` (add `KeptStep`), `web/src/features/visuals/filters/filterText.ts:52-63` (`liveFilters`), `web/src/features/analyses/VisualTile.tsx:41-52` (`mergeFilters`), `web/src/features/dashboards/tileActions.tsx:60-76` (`carrySteps`), `web/src/features/explore/spec.ts:67` (`decodeQuestion`), `web/src/features/visuals/filters/FilterRows.tsx:45-68` · Test `filterText.test.ts`, `VisualTile.test.tsx`, `tileActions.test.ts`, `explore/spec.test.ts`, `FilterRows.test.tsx` next to each
**Interfaces:** Produces `interface KeptStep { type: string; [k: string]: unknown }` and `isKeptStep(s): s is KeptStep` (`type` set and not `'filter'`). The four helpers keep a kept step in place, the same object. `mergeFilters` dedupes it by `JSON.stringify(step)`. `FilterRows` draws a kept step as an inert row: "A filter from a newer version" with a remove button, and no column select.
- [ ] **Step 1: Write the failing test** — `expect(liveFilters([F, TERM])).toEqual([F, TERM])`; `expect(mergeFilters([TERM], [TERM, F])).toEqual([TERM, F])`; `expect(carrySteps({ carry: 'all_selection' }, null, [TERM])).toEqual([TERM])`; `expect(decodeQuestion(encodeQuestion({ ...Q, filters: [TERM] }))!.filters).toEqual([TERM])`; FilterRows renders `'A filter from a newer version'`, and its remove button calls `onChange([])`.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web` → `liveFilters` drops the term.
- [ ] **Step 3: Implement** — `if (isKeptStep(st)) { out.push(st); continue; }` ahead of each `type !== 'filter'` / `!f.column` test.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web && npm run build:web && npm run lint` → green, lint 0.
- [ ] **Step 5: Commit** — `git add web/src/features` · "Keep filter steps the web cannot edit when it saves"

### Task 6: The inventory test (a ratchet over every cleanup site)
**Files:** Create `scripts/termSites.ts` (the inventory below as data), `scripts/test-termSites.ts`
**Interfaces:** Produces `TERM_SITES: Readonly<Record<string, { count: number; how: 'keeps' | 'door' | 'throws' | 'prepare' | 'ignores' }>>`, keyed by repo path. The test scans `src/**/*.ts` and `web/src/**/*.ts(x)` (no `.js`, tests or `prototype/`) for `PATTERNS`: `/type\s*[!=]==\s*['"]filter['"]/`, `/\bsanitize(Steps|Filters|DashboardFilters|MetricFilters|FilterList|FilterStep)\(/`, `/\bfiltersOf\(/`, `/\b(liveFilters|mergeFilters|mergeDashboardFilters|carrySteps|withLockSteps|filterPredicates?|adaptFilters?|specFilterSteps|resolveFilterParams)\(/`. It fails when a file's match count differs from its entry, or when a file with matches has no entry. Same ratchet as `scripts/test-file-size.ts`: classify, never just bump.
- [ ] **Step 1: Write the failing test** — `ok(\`${file}: ${n} site(s), classified ${entry?.count}\`, entry && entry.count === n)` for every scanned file. Negative control: a planted temp file `src/__termSiteProbe.ts` holding `x.type === 'filter'` fails the scan, and is deleted in `finally`.
- [ ] **Step 2: Run it to see it fail** — `node scripts/test-termSites.js` → every file is unclassified.
- [ ] **Step 3: Implement** — fill `TERM_SITES` from the scan, with `how` taken from the inventory's letter (A/C → `keeps`, D → `door`, E → `throws`, B → `prepare`, F → `ignores`).
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-termSites.js` → all `ok`.
- [ ] **Step 5: Commit** — `git add scripts/termSites.ts scripts/test-termSites.ts` · "Add the term-site inventory ratchet"

### Task 7: Say how the release gap is held
**Files:** Modify `docs/server/upgrade.md` ("Skipping releases" bullet, and a new section after `## Sticky sessions…`)
- [ ] **Step 1: Write the failing test** — `node scripts/test-serverDocs.js` must stay green. No new check: the gap is held by the owner's rule (no release without approval) and by 05b's merge gate. There is no pod registry to check versions against (`grep -rn heartbeat src/server` finds only job leases).
- [ ] **Step 2: Run it** — nothing to fail. This is documentation.
- [ ] **Step 3: Implement** — the section "Filters a newer release writes are kept (`05a`)". This release keeps any filter step it cannot read and refuses the figure that needs it. **The release that adds glossary terms needs this release (or later) on every pod first.** From an older release, either upgrade through this one or stop all pods before starting the new ones: Compose already does (`up -d` recreates); with Helm, `kubectl -n ordinate scale deploy/ordinate --replicas=0`, then `helm upgrade`. Never `helm rollback` below this release once terms exist: an older pod drops a term from a filter when it saves. Open browser tabs: reload after the upgrade. Edit the "Skipping releases" bullet to "fine for the schema; a section below may name a release to pass through for a rolling update".
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-serverDocs.js` → `ok`.
- [ ] **Step 5: Commit** — `git add docs/server/upgrade.md` · "Document the reader release glossary terms need first"

---

## Inventory: every filter cleanup site (origin/develop `b7f4f41e`; find each by its function after steps 01–04 and 09a)

Letters: **A** filter-list sanitizer (Task 2 → `sanitizeFilterList`). **B** Prepare list: must NOT take a term, unchanged. **C** merge or rewrite before the door: keeps. **D** figure entry: `expandTerms` (Task 4). **E** engine after the door: throws on a term (Tasks 1, 3). **F** reads the shape: no crash, skips or names the term (Task 2 now; 05b names it).

**A.** `src/analysis/visuals.ts:464` sanitizeFilters ← `:488` normalize, `:606` saveVisual, `:644` updateVisual, `ipc/visuals.ts:633` vizData, `ipc/vizSample.ts:33`, `ipc/drillScope.ts:41`, `ipc/driversPoint.ts:66`, `ipc/insights.ts:187`, `ipc/answers.ts:435`, `analysis/dashboardDelta.ts:306`, `analysis/analysisPlan.ts:604`, `automation/creators.ts:69` · `src/analysis/dashboards.ts:644` sanitizeDashboardFilters ← `dashboards.ts:317` sanitizeCardVisual, `analysis.ts:174/376/415`, `publishedCopy.ts:59`, `savedViews.ts:132/150`, `ipc/metrics.ts:264/475/491/517/549`, `ipc/dashboards.ts:273`, `ipc/periods.ts:68`, `ipc/stats.ts:116`, `ipc/scenarios.ts:101`, `ipc/metricTree.ts:325`, `ipc/drivers.ts:441/466`, `ipc/summary.ts:284`, `ipc/versionDiff.ts:283`, `ipc/copilotCards.ts:38` · `src/analysis/metrics.ts:213` sanitizeMetricFilters ← `:229`, `:407` · `src/analysis/storyModel.ts:67` filtersOf · `src/analysis/scenarioModel.ts:108` sanitizeDriver target · `src/analysis/alertStore.ts:154` saveRule (via A); `alerts.ts:256` sanitizeRule and `alertStore.ts:211` restoreRule pass it raw · `src/ai/answerSpec.ts:400` sanitizeStoredSpec ← `ai/copilot.ts:218/450`, `ipc/answers.ts:410/464/485` · `src/ai/answerSpec.ts:254` resolveFilter (model input: 05b resolves `{ term: name }`) · `src/ipc/answers.ts:363` tileSpec (rebuilds at `:372`) · `src/automation/creators.ts:65` filterSteps (05b: `terms` arg) · web `visuals/filters/filterText.ts:52` liveFilters ← `visuals/builderState.ts:97/103/189/212`, `analyses/metrics/MetricEditor.tsx:94/102/137/148`, `analyses/editor/Editor.tsx:228`, `explore/AnswerActions.tsx:43`, `explore/Answer.tsx:53` · web `explore/spec.ts:67` decodeQuestion · `src/analysis/publishedCopy.ts:70` copyOf and `userTemplate.ts:196/275` keep the id (in another project it is a deleted term: refused in 05b).

**B.** `src/data/datasets.ts:327/682/738` · `src/data/inputTable/store.ts:330` · `src/data/rowPolicy.ts:167` · `src/ipc/rowPolicy.ts:111` · `src/ipc/datasets.ts:714` · `src/ipc/segments.ts:140` · `src/ai/planCheck.ts:182` · `src/analysis/params.ts:349/366` (pass-through) · `src/engine/sqlGen.ts:252/562` (not adopted) · web `prepare/drafts.ts:33`.

**C.** `src/analysis/dashboardFilters.ts:52` mergeDashboardFilters + `:33` stepKey ← `reportPages.ts:160/391`, `publish/dashboardData.ts:445/456`, `publish/storyData.ts:70`, `ipc/subscriptionFigures.ts:137` · `src/analysis/cardModel.ts:115` carrySteps · `src/analysis/params.ts:236/247` resolveFilterParams (keeps) · `src/analysis/periodScope.ts:51/85/125/150` (a term's own dates are a fixed filter, never shifted: by design, as a metric's own filters) ← `ipc/visualsOverlay.ts:60/126`, `ipc/periods.ts:75`, `analysis/driverScope.ts:257`, `ipc/metricTree.ts:328-349` · `src/analysis/driverScope.ts:272` withoutDateBounds (keeps) · `src/analysis/savedViews.ts:271` viewScope, `publish/dashboardData.ts:354` comboScope (keep) · `src/analysis/dashboardDelta.ts:301-307` keepFilters · `src/analysis/analysisPlan.ts:686-696` known(column) · `src/ai/answerRefine.ts:116` · `src/ipc/analysesServer.ts:57` call, `:147-152` KPI fallback · KPI scope paths that skip the tile merges (keep, unmarked): web `analyses/editor/AddKpi.tsx:52/116` (MetricCard `ed.filters`), `KindCards.tsx:45`, `metrics/tree/MetricTreeCard.tsx:38`, `dashboards/SummaryBody.tsx:45`, `dashboards/CompareBar.tsx:82`; server `publish/dashboardData.ts:475/483/488/531/557/574` (`scope.filters`) · web `analyses/VisualTile.tsx:45` mergeFilters ← `VisualTile.tsx:191`, `editor/Editor.tsx:228/231/234`, `dashboards/CardRuntime.tsx:42/56/81`, `dashboards/tileActions.tsx:138` · web `dashboards/tileActions.tsx:69` carrySteps ← `:96/:117` · web `dashboards/CardRuntime.tsx:70` tileFilters, `ControlsExtras.tsx:61` upsertFilter (keep).

**D.** `src/ipc/rowDoors.ts:122` lockedViz ← `ipc/visuals.ts:453` vizDataFor (its gates `:133` relatedClosed / `:138` reachesOther read the filters, so expansion goes before them; the lock still lands first) · `rowDoors.ts:144` lockedMetric ← `ipc/dashboards.ts:149` computeCardMetric · `src/ipc/answers.ts:142` computeCard · bypass entries: `src/ipc/datasets.ts:200` pageFor (visual:rows, rowsDownload, drill export), `src/ipc/stats.ts:56` compute, `src/ipc/drivers.ts:286` driversFor, `src/analysis/scenarioResolve.ts:145` loadInputs · not figures, unchanged: `src/ipc/events.ts:27` withEvents (event marks ignore a term), `src/publish/embedLock.ts:54/63` (a pre-check; the door re-gates in fan-out) · `src/data/rowAccess.ts:289` withLockSteps (keeps a term, Task 2) · contract `src/api/datasets.ts:41` refuses a term on `dataset:page` at zod (a grid's own filters: unchanged).

**E.** `src/data/transforms.ts:267/278` foldStep/dispatch (← `analysis/vizData.ts:467`, `stats/vectorsJs.ts:90`, `analysis/driversJs.ts:56`, `analysis/scenarioInputs.ts:32/40`, `engine/datasetPage.ts:245/784`) · `src/engine/residentFilter.ts:60` filterPredicate (← `residentQuery.ts:639`, `pivotResident.ts:123/150/262`, `facetResident.ts:35`, `geoResident.ts:49`, `cohortResident.ts:75`, `funnelResident.ts:68`, `fxResident.ts:183/209`, `statsVectors.ts:48`, `driversResident.ts:47`, `lodResident.ts:73`, `scenarioResident.ts:54/57`, `joinResident.ts:146/188`, `datasetPage.ts:482/711`) · `src/ipc/visualsResident.ts:56`, `src/engine/joinResident.ts:106` (return false → JS fallback, which throws) · `src/engine/live/liveSpec.ts:227` adaptFilter, `:389` fromAnswerSpec · `src/ai/answerSpec.ts:500` specFilterSteps · `src/analysis/lodQuery.ts:44` splitContext (keeps) · `src/analysis/joinPlan.ts:222/249`, `src/ipc/relationships.ts:143/176` (05b pins `datasetId`) · `src/ipc/liveRoute.ts:86/98`, `src/engine/live/liveMissing.ts:30` (column names: after the door, terms are gone).

**F.** `src/analysis/metricFormat.ts:65/101/106` · `src/analysis/versionDiffParts.ts:101/206` · `src/ipc/copilot.ts:298` · `src/ipc/draftFacts.ts:53` (05b checks the term's columns' sensitivity) · `src/ai/answerValues.ts:53/94/129/151`, `answerFacts.ts:36`, `previousAnswer.ts:28`, `answerSuggest.ts:156`, `answerRefine.ts:142` · `src/ipc/answerSave.ts:41` (05b keeps the term step in `card.steps`) · `src/ipc/liveAnswers.ts:75/170`, `src/ipc/answers.ts:158/190` · web `FilterRows.tsx:45-68`, `filterText.ts:32`, `reports/stories/StoryBlock.tsx:148/203`, `visuals/drill/DrillPanel.tsx:142`, `explore/Question.tsx:225-233`, `projects/VersionPreview.tsx:16`, `analyses/editor/Rail.tsx:178/213`.
