# Semantic layer part 4, step 06: hidden columns on every other reader, the Assistant, MCP and fan-out, with the inventory: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hidden column's values never leave through any reply, push, MCP tool, model prompt, published page, embed, subscription or alert to a caller it is hidden from. Metrics and terms that read it are hidden too. Every `read` contract is classified for columns, so a new one cannot ship unclassified.
**Architecture:**
- The REDACT and MARK rows (D18) each take one call to 05's `hiddenColumnsFor`.
- Metrics and terms are hidden by what they read (D19), through `metricHidden`/`termHidden` (`src/analysis/columnHidden.ts`) over 01's dependency walk.
- The Assistant's facts drop hidden columns at the few places they are built (D21).
- Fan-out uses 05's least-entitled audience, and a `/p/` site or embed built before the rules stops being served (D17).
- `COLUMN_TREATMENT` (`scripts/columnAccessReaders.ts`) is the inventory. `test-columnAccessSafetyNet` proves it with canaries.
**Tech Stack:** `src/ipc`, `src/app/sharePolicy.ts`, `src/ai`, `src/automation`, `src/publish`, `src/analysis`, scratch-Postgres suites.
**Spec:** docs/semantic-layer/04-governance.md (D17–D22) · Index: 2026-11-04-semantic-layer-p4-00-index.md
**Branch:** `feat/semantic-p4-06-column-everywhere` off `origin/develop` after 05 merges.

## Global Constraints
- **Drop, never mask, inside the app.** A hidden column is absent from facts and vocabularies, is marked `hidden: true` in column lists (names are not secret), and has its sample, example, value labels and colours removed. Sensitivity (share policy) is unchanged: it governs how values *leave*. On publish, hidden beats masked (D22): the build is refused before the share policy ever shapes it.
- **Precise where cheap, coarse where not.** `visualForCaller` drops labels only for a visual that names a hidden column. `quality:list`, `dataset:liveSchema`, insights, value search, `dataset:list`'s `scoped`, connections' `lastError` and copilot notes all go through `closedToCaller`, which 05 widened, so they redact the whole dataset for that caller. That is the row-policy treatment (D17).
- **`hiddenAnywhere`** (the union over the project's datasets, for this caller) is conservative on purpose. A metric on Orders that uses its own `salary` is hidden from a viewer whom Staff hides `salary` from. A false hide, never a leak.
- **Fan-out refuses only what reads a hidden column.** A publish of "Headcount by department" still publishes. `policyClosed` stays rows-only: widening it would refuse every send of such a dataset at `assertFanOutAllowed`.
- `src/ipc/copilot.ts` (605), `src/ai/copilotFacts.ts` (577), `src/app/sharePolicy.ts` (432), `src/ipc/answers.ts` (510): calls only. Logic goes in `src/ai/hiddenFacts.ts` and `src/analysis/columnHidden.ts`.

## Review Focus
- Every prompt to the model, for east, holds no canary: the dataset, visual, dashboard and project-inventory contexts, and an answer (Task 4).
- A site published before the rules stops; one republished after them, not reading `salary`, is served (Task 3).
- The inventory's negative control: a planted read contract is reported (Task 4).

---

### Task 1: REDACT and MARK rows, and metrics hidden by what they read
**Files:** Create `src/analysis/columnHidden.ts` · Modify `src/ipc/catalog.ts:33-34` (`catalog:columns`: for a hidden column `example: ''` and no `values`), `src/ipc/format.ts:60-65` (`format:colors:get`: delete each key in `hiddenAnywhere`), `src/ipc/rowDoors.ts:228-235` (`visualForCaller`: rows checked by `closedToCaller(p, ds, { rowsOnly: true })`; then `withoutLabels` plus filter values removed from filters on hidden columns, only when `mentionsHidden(v, hidden)`), `src/data/rowAccess.ts` (`closedToCaller(projectId, id, opts?: { rowsOnly?: boolean })`, `hiddenAnywhere(projectId)`), `src/ipc/datasets.ts:389-394` (`dataset:columns`), `src/ipc/sqlQuery.ts:25-40` (`schemaFor`), `src/automation/handlers.ts:91-116` (`describe_dataset`): `hidden: true` on hidden columns · `src/ipc/metrics.ts:413-424` (`decorate`: `hidden: true`), part 1's `src/ipc/terms.ts` (`term:list`: `hidden: true`), `src/analysis/statusPin.ts` (export `dependencies(projectId, ref)`, the walk `pinOf` already does) · Test `scripts/test-columnRedact.ts` (on `scripts/columnAccessHarness.ts`)
**Interfaces:** Produces
```ts
export async function metricHidden(projectId: string, id: string): Promise<boolean>; // its own and its dependencies' definition, column, formula text and filters (terms expanded) mention hiddenAnywhere
// part 5's kinds (step 01, merged earlier in release B) count as definition: a funnel's entity, event and time columns, a period metric's `base` (walked as a dependency), `snapshot.per`, and a target's plan metric (`target.source.metricId`)
export async function termHidden(projectId: string, id: string): Promise<boolean>;
export async function hiddenAnywhere(projectId: string): Promise<ReadonlySet<string>>; // rowAccess.ts; memo per request; empty for an unrestricted caller
```
- [ ] **Step 1: Write the failing test**
```ts
ok('catalog:columns: no example and no value labels for salary, to east', ((c) => c.salary.example === '' && !('values' in c.ssn))((await W.call('east', 'catalog:columns', cols)).body.columns));
ok('NEGATIVE CONTROL: hr reads the example', (await W.call('hr', 'catalog:columns', cols)).body.columns.salary.example === EXAMPLE);
ok('format:colors:get: no colours of ssn values', !('ssn' in (await W.call('east', 'format:colors:get', { projectId: P })).body));
ok('a visual on dept keeps its custom order for east; one filtered on ssn values loses them', keepsOrder(await visualGet('east', BY_DEPT_V)) && !(await visualGet('east', SSN_FILTERED_V)).text.includes('SSN_CANARY'));
ok('dataset:columns, sql:schema, describe_dataset mark salary hidden: true for east, not for hr', await marksHidden());
ok('metric:list: Payroll is hidden: true for east; Headcount is not', await listFlags('metric:list', { Payroll: true, Headcount: undefined }));
ok('term:list: High earners is hidden: true for east', await listFlags('term:list', { 'High earners': true }));
ok('quality:list and dataset:liveSchema redact Staff for east (closedToCaller)', await redactedForEast());
```
- [ ] **Step 2: Run it to see it fail.** `DATABASE_URL=… node scripts/test-columnRedact.js` fails, because east reads the example.
- [ ] **Step 3: Implement.** One `hiddenColumnsFor` call per handler.
- [ ] **Step 4: Run it to see it pass.** `DATABASE_URL=… node scripts/test-columnRedact.js && DATABASE_URL=… node scripts/test-rowPolicyLabels.js && DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js && node scripts/test-automationTools.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src scripts/test-columnRedact.ts` · "Redact a hidden column's examples, labels and colours, mark it hidden, and hide the metrics that read it"

### Task 2: The Assistant and MCP never see a hidden column
**Files:** Create `src/ai/hiddenFacts.ts` · Modify:
- `src/app/sharePolicy.ts:132-141` (`assistantColumnDocs` leaves hidden columns out; every facts builder reads it)
- `src/ipc/copilot.ts:190-222`, the dataset branch: in place of `gateRows`, call `hiddenColumnsFor(projectId, id)`; with nothing hidden it is unchanged. Otherwise it runs inside `withColumnsChecked(new Set([id]))` over `withoutColumns(ds, hidden)`, with `insights: []`, because insights are computed over every column.
- `copilot.ts:152-170` (`factMetrics` skips `metricHidden`) and `:373-384` (the project inventory's `columns` filtered)
- `src/ipc/liveProfile.ts:72-90` (`liveCopilotFacts`: `columns` and `profile` without hidden columns)
- `src/ipc/answers.ts:242-265` (`specDatasets` columns, `specMetrics` skip hidden)
- part 1's `src/ai/termFacts.ts` (skip `termHidden`), `src/ipc/draftFacts.ts:41` (skip hidden metrics)
- `src/automation/handlers.ts:189-198` (`list_metrics` skips hidden), part 1's `termsList`, `docs/automation.md` (regenerated if a description changed)

Test `scripts/test-columnFacts.ts` (on the harness, the model stubbed at `analyze.askCopilot` as `scripts/test-askDidYouMean.ts:98` does, every prompt recorded).
**Interfaces:** Produces `dropHidden<T extends { name: string }>(cols: T[], hidden: ReadonlySet<string>): T[]`, and `factsVisible(projectId, datasetId): Promise<ReadonlySet<string>>`: the hidden set, or empty when nothing is hidden.
- [ ] **Step 1: Write the failing test**
```ts
const prompts: string[] = []; stubModel((facts, q) => { prompts.push(facts + '\n' + q); return SPEC_REPLY; });
for (const context of [{ kind: 'dataset', id: STAFF }, { kind: 'visual', id: SALARY_V }, { kind: 'visual', id: DEPT_V }, { kind: 'analysis', id: BOARD }, {}]) await W.call('east', 'copilot:ask', { projectId: P, context, q: 'tell me about pay' });
ok('no prompt sent for east carries a hidden value or a figure made from it', prompts.every((p) => !p.includes('SSN_CANARY') && !p.includes(SALARY_TOTAL_TEXT)));
ok('…nor the hidden column\'s name in the dataset facts', !prompts[0].includes('salary'));
ok('NEGATIVE CONTROL: hr\'s prompts carry the canary', (await promptsAs('hr', { kind: 'dataset', id: STAFF })).some((p) => p.includes('SSN_CANARY')));
ok('the dataset facts for east still hold dept and headcount', prompts[0].includes('dept'));
ok('MCP as east: list_metrics leaves Payroll out; aggregate over salary is refused; query_sql over Staff is refused', await mcpAsEast());
```
- [ ] **Step 2: Run it to see it fail.** `DATABASE_URL=… node scripts/test-columnFacts.js` fails: in 05 the dataset context is refused, so there is no "dept".
- [ ] **Step 3: Implement** as listed.
- [ ] **Step 4: Run it to see it pass.** `DATABASE_URL=… node scripts/test-columnFacts.js && node scripts/test-copilot.js && node scripts/test-copilot-analysis-facts.js && node scripts/test-answerSpec.js && node scripts/test-liveRouteAnswers.js && node scripts/test-sharePolicy.js && node scripts/gen-automation-docs.js && node scripts/test-automation.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src scripts/test-columnFacts.ts docs/automation.md` · "Leave hidden columns and the metrics that read them out of everything the Assistant and agents are given"

### Task 3: Fan-out, `/p/` and embeds
**Files:** Modify `src/data/rowAccess.ts` (export `columnRulesSince(projectId, ids, iso): Promise<boolean>`: any id whose raw `columnAccess` is `'closed'` or has `updatedAt > iso`; and `anyColumnRulesSince(projectId, iso)` for a site with no recorded ids), `src/publish/hosted.ts:99-108` (`servable`), `src/publish/embedPage.ts:85-90` (the cache hit: `columnRulesSince(site.projectId, hit.datasets, new Date(hit.at).toISOString())` refuses `fanout`) · Test `scripts/test-columnAccessSafetyNet.ts` (part "fan-out")
- [ ] **Step 1: Write the failing test**
```ts
ok('a publish reading salary refuses', H.refused(await W.call('boss', 'publish:plan', planOf(PAY_BOARD))));
ok('NEGATIVE CONTROL: a publish of headcount by dept publishes', (await publish(W, HEADCOUNT_BOARD)).ok === true);
ok('a site published before the rules is no longer served', await stopsAfterRules(SITE_BEFORE));
ok('…and served again once republished (it reads no hidden column)', await servedAfterRepublish(SITE_BEFORE));
ok('an embed page cached before the rules is refused on the next hit', await embedHitRefusedAfterRules());
ok('a subscription preview and an alert save over salary refuse; over headcount they pass', await sendsCase());
ok('NEGATIVE CONTROL: policyClosed(Staff) is false (rows only), so assertFanOutAllowed lets headcount sends through', !(await asBoss(() => rowAccess.policyClosed(P, STAFF))));
```
- [ ] **Step 2: Run it to see it fail.** `DATABASE_URL=… node scripts/test-columnAccessSafetyNet.js` fails, because the old site is still served.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run it to see it pass.** `DATABASE_URL=… node scripts/test-columnAccessSafetyNet.js && DATABASE_URL=… node scripts/test-rowPolicyFanOut.js && DATABASE_URL=… node scripts/test-embed-db.js && node scripts/test-publishSite.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src/data/rowAccess.ts src/publish scripts/test-columnAccessSafetyNet.ts` · "Stop serving a page built before its datasets hid a column, and refuse a send that reads one"

### Task 4: The inventory, and the safety net in full
**Files:** Create `scripts/columnAccessReaders.ts` · Modify `scripts/test-columnAccessSafetyNet.ts`
**Interfaces:** Produces `export type ColumnTreatment = 'GATE' | 'DROP' | 'NET' | 'REDACT' | 'MARK' | 'FANOUT' | 'EXPORT' | 'SKIP' | 'META';` and `export const COLUMN_TREATMENT: Readonly<Record<string, ColumnTreatment>>`, one entry per `read` contract. Start it from `TREATMENT` (`scripts/rowPolicyReaders.ts`) by this map: DOOR/DOOR+ → GATE, LOCKED → DROP (`dataset:page`, `visual:rows`, `visual:rowsDownload`) or GATE (`dataset:distinct`, `dataset:profile`), NET → NET, EXPLICIT → NET (each goes through `gateRows`), REDACT → REDACT, FANOUT, EXPORT and SKIP unchanged, META → META. Then hand-set the overrides this part made: `catalog:columns` REDACT, `dataset:columns`/`sql:schema` MARK, `metric:list`/`term:list` REDACT, and the D18 rows. Each override gets a trailing comment saying how it is covered.
- [ ] **Step 1: Write the failing test**
```ts
const missing = unclassifiedColumns(api.contracts);
ok('coverage: every read contract has a COLUMN_TREATMENT', missing.length === 0, missing.join(', '));
ok('NEGATIVE CONTROL: a planted read contract is reported', JSON.stringify(unclassifiedColumns({ ...api.contracts, 'columns:planted': { access: 'read' } })) === '["columns:planted"]');
for (const [ch, body] of PAYLOADS) eastTexts.push((await W.call('east', ch, body)).text); // one payload per read contract over Staff (rowPolicySafetyNet's lists, Orders → Staff); META channels with { projectId }
eastTexts.push(...(await mcpTextsAs('east')), ...(await pushTextsAs('east')), ...prompts);
ok('canaries: nothing east is given carries a hidden value', eastTexts.every((t) => !t.includes('SSN_CANARY')), firstLeak(eastTexts));
ok('NEGATIVE CONTROL: hr\'s and the editor\'s replies carry them', (await textsAs('hr')).some(hasCanary) && (await textsAs('ed')).some(hasCanary));
ok('every GATE channel refuses a question naming ssn, and answers one that does not, Object.is-equal to the editor', await gatesHold());
```
`pushTextsAs` subscribes east's SSE client (as the `notifyHarness` suites do) and runs a quality check and a refresh on Staff.
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-columnAccessSafetyNet.js` fails coverage, because the table is missing.
- [ ] **Step 3: Implement** the table, and the test helpers in `scripts/columnAccessHarness.ts`.
- [ ] **Step 4: Run it to see it pass.** `DATABASE_URL=… node scripts/test-columnAccessSafetyNet.js && node scripts/check-contracts.js && npm run lint` report `ok`, 0 unresolved and lint 0.
- [ ] **Step 5: Commit.** `git add scripts/columnAccessReaders.ts scripts/test-columnAccessSafetyNet.ts scripts/columnAccessHarness.ts` · "Classify every read contract for hidden columns and prove none leaks one"

### Task 5: Finding (D22): a mark carried to a calculated column
**Files:** Modify `src/app/sharePolicy.ts:79-93` (`markedLevels`: carry each mark through `carriersOf(steps, sourceColumns, finalColumns, [marked])` in place of the rename-only loop), `CHANGELOG.md` (one line under Unreleased) · Test `scripts/test-sharePolicy.ts`
- [ ] **Step 0: Check first.** A separate session may already have fixed this gap: `git log --oneline -S markedLevels -- src/app/sharePolicy.ts`. If it landed, replace its walk with `carriersOf` (one carrier rule in the app) and keep its tests. If not, do the steps below.
- [ ] **Step 1: Write the failing test.** `ok('a calculated column over a financial column is masked on export', exported(PAY_PLUS_BONUS).bonus === MASK)`. As the negative control, a calculated column over `dept` is not masked.
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-sharePolicy.js` fails, because `bonus` leaves unmasked.
- [ ] **Step 3: Implement.** The rename case must still pass: `carriersOf` covers it.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-sharePolicy.js && node scripts/test-columnFacts.js` report `ok`.
- [ ] **Step 5: Commit** in its own commit. `git add src/app/sharePolicy.ts CHANGELOG.md scripts/test-sharePolicy.ts` · "Mask a column computed from a sensitive one, not only a renamed one"

Not in this step: the setter, the Access tab and the grid's note (07).
