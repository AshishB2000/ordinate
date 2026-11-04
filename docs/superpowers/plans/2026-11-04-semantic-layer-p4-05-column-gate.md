# Semantic layer part 4, step 05: the column gate at every door, and the net (no setter yet): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dataset record's `columnAccess` is enforced on every reader, for every caller it hides a column from. A question that names a hidden column (or a column computed from one) is refused before the row lock, the answer cache and the Live split. A question that does not name one is answered exactly as for an editor, and a row reader returns no hidden value. Rules are planted by tests only: the setter is step 07.
**Architecture:** Three layers, matching row access's.
1. `src/data/columnAccess.ts` (PURE): the rule shape, the sanitizer, who a column is hidden from, carriers and the `readersHash`, the rule state, and a conservative name matcher.
2. `src/data/columnGate.ts`: the per-request view of a dataset's hidden columns for the caller (or for a fan-out's least-entitled audience), and `columnReason`, which the storage net asks. `src/data/rawRecord.ts` holds the raw-record read moved out of `rowAccess.ts` so both can share it.
3. `src/ipc/columnDoors.ts`: `gateColumns`, called by `lockedViz`, `lockedMetric` and `withLockOf` before anything else. It opens a "checked" scope through which the net lets the gated datasets pass.

01a's coarse `columns` guard is replaced.
**Tech Stack:** `src/data`, `src/ipc/rowDoors.ts`, `src/ipc/datasets.ts`, `src/ipc/visuals.ts`, `src/ipc/visualsServer.ts`, `src/ipc/answers.ts`, `src/ipc/distinctFor.ts`, `src/ipc/datasetViews.ts`, scratch-Postgres suites.
**Spec:** docs/semantic-layer/04-governance.md (D12–D17, D20) · Index: 2026-11-04-semantic-layer-p4-00-index.md
**Branch:** `feat/semantic-p4-05-column-gate` off `origin/develop` after 04 merges. 01a must be released (no pod may still drop `columnAccess`). Part 6 05a (`dataset:distinct.filters`, release A) must be merged: Task 4 gates its parent steps.

## Global Constraints
- **Restricted means what row access means:** `callerOn(projectId).restricted` (`src/server/authz/caller.ts:87`), i.e. a project viewer. Org admins and project editors and admins see every column (D12). Inside `fanOutScope` every ruled column is hidden, which is the least-entitled audience (D17).
- **Fail closed:** a corrupt `columnAccess`, a changed reader pipeline, a rule column the dataset no longer has, an unknown step type after a hidden column, an as-of read, or an upstream dataset that hides a column from the caller: each refuses `columns` for any caller something is hidden from (a corrupt record: every restricted caller).
- **Order at a door:** `expandTerms` → `gateColumns` → the row lock and `relatedClosed` → the Live split and the answer cache. The gate sees the expanded terms. The row lock and Prepare and Live base filters may use a hidden column, because they define the dataset, not the question (D15, D20).
- **Matching is conservative:** a false match refuses, never leaks. A hidden name matches a string of the question that equals it, or that contains it bounded by characters that are not letters, digits or `_`, case-insensitive. That covers `sum(salary)`, `[Salary]` and `{FIXED dept: sum(salary)}`.
- **Names are not secret** (owner's answer 3). Values and figures are. A hidden cell is `null` **in place** and the reply names `hidden: string[]`, so any browser's grid stays aligned.
- Reasons: `hidden` (the question names a hidden column) and `columns`, reworded from 01a. Draft sentences, through `t()` in `src/data/rowAccessMessages.ts`: `hidden`: "This uses a column a project admin has limited to certain people, so it can't be shown here." `columns`: "Some columns of this dataset are limited to certain people, and this can't keep to that, so it is off here." Neither names a column, team or value.
- `src/data/rowAccess.ts` (347): moving `readRaw` out frees about 45 lines, and the column clause is about 10 lines of calls. `src/ipc/rowDoors.ts` (280): calls only. `src/ipc/datasets.ts` (751), `src/ipc/visuals.ts` (773), `src/ipc/answers.ts` (510): one or two lines each.

## Review Focus
- A door that skips the gate: formula and metric re-entry (`vizMetricMeasures` calls `vizDataFor` per leaf), facets, KPI operands, the four `withLockOf` readers. Pinned in Task 4 (every door) and Task 5 (planted readers).
- The cache order. Pinned in Task 5 with the `setColumnGateForTest(false)` seam, as `setRelatedGateForTest` exists (`rowDoors.ts:68-71`).
- Joins: a join through a hidden key runs, and grouping by a related dataset's hidden column is refused (D20). Pinned in Task 4.
- Carriers: `bonus = [salary] * 0.1`, a rename `salary → pay`, an `unpivot` after `salary`. Pinned in Task 1.

---

### Task 1: The pure module
**Files:** Create `src/data/columnAccess.ts` · Test `scripts/test-columnAccess.ts`
**Interfaces:** Produces
```ts
export type Member = { userId: string } | { teamId: string };
export interface ColumnRule { column: string; visibleTo: Member[]; from?: string } // from: a carrier's hidden source (server-set)
export interface ColumnAccess { columns: ColumnRule[]; readersHash: string; updatedBy: string; updatedAt: string }
export const MAX_RULED_COLUMNS = 256;
export function columnAccessFromRecord(raw: unknown): ColumnAccess | 'closed' | null; // null: no key; 'closed': it does not sanitize
export function hiddenFor(access: ColumnAccess, userId: string | null, teamIds: readonly string[]): Set<string>;
export function everyRuled(access: ColumnAccess): Set<string>;
export function carriersOf(steps: readonly TransformStep[], sourceColumns: readonly string[], finalColumns: readonly string[], hidden: readonly string[]):
  { carriers: Map<string, string>; readers: TransformStep[]; unknown: boolean };
export function buildColumnAccess(raw: Record<string, unknown>, rules: Array<{ column: string; visibleTo: Member[] }>, by: string, at: string): ColumnAccess; // adds carrier rules (inheriting visibleTo) + readersHash
export type AccessState = 'ok' | 'pipeline' | 'gone';
export function accessState(raw: Record<string, unknown>, access: ColumnAccess): AccessState;
export function mentionsHidden(question: unknown, hidden: ReadonlySet<string>): boolean;
export function nullHidden(rows: Cell[][], columns: readonly { name: string }[], hidden: ReadonlySet<string>): Cell[][];
export function withoutColumns<T extends { columns: ParsedColumn[]; rows: Cell[][] }>(t: T, hidden: ReadonlySet<string>): T;
```
`carriersOf` is the algorithm the tests pin, and it is conservative.
- First, add to `hidden` every `from` of a `rename_column` whose `to` is hidden, until nothing changes: the same values under an earlier name.
- Then walk the steps with `before`/`after` column lists from `applyPipeline({ columns: source, rows: [] }, steps.slice(0, i + 1))`. Add the comment `// shortcut: one empty fold per step prefix, O(n²) over ≤ 50 steps; fold once with per-step schemas if a profile shows it`.
- A step whose type is not in `STEP_TYPES` (`src/data/transforms.ts:164`) after a hidden column exists sets `unknown`.
- `filter`/`dedupe`/`dedupe_key` that name a hidden column are readers and make no carrier.
- A step in `UNNAMED_WRITERS` (`src/data/rowPolicy.ts:114`, exported for this) is a reader whenever any column is hidden. Every final column not in `before` is its carrier.
- Any other step that names a hidden column (`mentions`, `rowPolicy.ts:116`) or refers to one in a formula (`compile(expression).refs`, `src/formula/formula.ts:38`) is a reader. Every column of `after` that it names, or that is new in `after`, is a carrier whose `from` is the first hidden column it read. Carriers join `hidden` for the steps after them.

`readersHash` is `pipelineHash(readers)`. `accessState` gives `gone` when a non-carrier rule column is missing from `raw.columns`, or listed in a Live record's `live.missingColumns`. It gives `pipeline` when the recomputed readers hash differs or `unknown` is set.
- [ ] **Step 1: Write the failing test**
```ts
const S = [{ type: 'calculated_field', name: 'bonus', expression: '[salary] * 0.1' }, { type: 'rename_column', from: 'bonus', to: 'bonus_pct' }];
ok('a formula over salary carries it, and a rename walks it on', stableStringify([...carriersOf(S, SRC, FINAL, ['salary']).carriers]) === stableStringify([['bonus', 'salary'], ['bonus_pct', 'salary']]));
ok('an unpivot after salary hides every column it makes', carriersOf([UNPIVOT], SRC, [...SRC_NO_SALARY, 'attribute', 'value'], ['salary']).carriers.has('value'));
ok('a filter on salary is a reader, not a carrier', ((r) => r.carriers.size === 0 && r.readers.length === 1)(carriersOf([{ type: 'filter', column: 'salary', op: '>', value: 1 }], SRC, FINAL, ['salary'])));
ok('a rename ONTO the hidden name hides its source too', carriersOf([{ type: 'rename_column', from: 'sal', to: 'salary' }, CALC_FROM_SAL_BEFORE], SRC2, FINAL2, ['salary']).carriers.has('calc'));
ok('an unknown step after salary: unknown', carriersOf([{ type: 'future_x' } as never], SRC, FINAL, ['salary']).unknown);
ok('state: a new step reading salary is pipeline; one that does not is ok', accessState(withStep(RAW, CALC_SALARY2), A) === 'pipeline' && accessState(withStep(RAW, CALC_DEPT), A) === 'ok');
ok('state: the source column renamed away is gone', accessState(withColumns(RAW, NO_SALARY), A) === 'gone');
ok('corrupt is closed, absent is none', columnAccessFromRecord({ columnAccess: 'x' }) === 'closed' && columnAccessFromRecord({}) === null);
ok('allow-list: a team member sees it, someone added later does not', !hiddenFor(A, U_HR, [HR]).has('salary') && hiddenFor(A, U_NEW, []).has('salary'));
ok('matcher: inside a formula and an LOD, bounded', mentionsHidden({ v: '{FIXED dept: sum(salary)}' }, H) && mentionsHidden(['[Salary]'], H) && !mentionsHidden(['salary_band'], H));
ok('NEGATIVE CONTROL: a question naming nothing hidden passes', !mentionsHidden({ category: 'dept', values: [{ column: 'headcount', aggregation: 'count' }] }, H));
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` fails, because the module is missing.
- [ ] **Step 3: Implement** as specified. Export `UNNAMED_WRITERS` and `mentions` from `rowPolicy.ts` with no behaviour change.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-columnAccess.js && node scripts/test-rowPolicy.js && node scripts/test-transforms.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src/data/columnAccess.ts src/data/rowPolicy.ts scripts/test-columnAccess.ts` · "Model column access rules, the columns computed from a hidden one, and when the rules still hold"

### Task 2: The view per caller, and the net's column clause
**Files:** Create `src/data/rawRecord.ts` (move `textOrNull`, `CORRUPT`, `memoOf`, `readRaw` from `src/data/rowAccess.ts:93-147`, unchanged, as `readRawRecord`), `src/data/columnGate.ts` · Modify `src/data/rowAccess.ts`: remove 01a's `columns` Effective kind and `hasColumnRules`; add `checked?: ReadonlySet<string>` to `Scope` (`:49-53`); keep `checked` in `withRowLock` (`:64-67`); add `withColumnsChecked(ids, fn)`; export `refuseInScope(reason)` (the private `refuse`, `:57-61`); in `closedReason` (`:234-253`) return `columnReason(projectId, id, scope?.checked, out?.kind)` where it returns null for `eff.kind === 'none'`; export `hiddenColumnsFor(projectId, id)` (a wrapper choosing the audience by `inFanOut()`) · `src/data/rowPolicyError.ts`, `src/data/rowAccessMessages.ts` (`hidden`; `columns` reworded) · Test `scripts/test-columnAccess.ts` (part 2: `policyClosed` is rows-only again; the moved reader is unchanged by `test-rowPolicy*`)
**Interfaces:** Produces
```ts
export type Audience = 'caller' | 'fanout';
export async function columnView(projectId: string, id: string, audience: Audience): Promise<{ hidden: ReadonlySet<string>; state: 'ok' | 'columns' }>; // memo per request
export async function upstreamHides(projectId: string, id: string, audience: Audience): Promise<boolean>; // upstreamIds (src/data/upstream.ts) over readRawRecord
export async function columnReason(projectId: string, id: string, checked: ReadonlySet<string> | undefined, out: 'fanout' | 'export' | undefined): Promise<RowPolicyReason | null>;
```
For an unrestricted caller outside a fan-out, `columnView` returns the empty view with no record read. `'closed'` gives the state `columns`. Hidden but not `ok` gives `columns`. `columnReason`: state `columns` or `upstreamHides` → `'columns'`; nothing hidden → null; an export scope → `'export'`; `checked.has(id)` → null; else `'columns'` (a whole-table reader outside a gated door). `columnGate.ts` imports nothing from `rowAccess.ts`. `rowAccess.ts` imports it, so there is no cycle.
- [ ] **Step 1: Write the failing test.** Through `rowAccess` with a restricted caller (the DB part of `scripts/test-columnDoors.ts`, Task 4): `closedToCaller(P, STAFF)` is true for east and false for an HR viewer. Inside `withColumnsChecked(new Set([STAFF]), …)` it is false for east. `policyClosed(P, STAFF)` is false (rows only), the negative control.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` fails, because `columnGate` is missing.
- [ ] **Step 3: Implement** as specified. Then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-columnAccess.js && node scripts/test-rowPolicy.js && DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js && DATABASE_URL=… node scripts/test-rowPolicySidePaths.js && node scripts/test-file-size.js && node scripts/test-i18n.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src/data scripts/test-columnAccess.ts src/i18n` · "Close a dataset to whole-table readers for a caller it hides a column from"

### Task 3: `gateColumns`, and the doors call it first
**Files:** Create `src/ipc/columnDoors.ts` · Modify `src/ipc/rowDoors.ts:128-155` (`lockedViz`: after `expandTerms`, the rest runs inside `gateColumns(projectId, datasetId, chartReadsOf(...), [encoding, filters], …)`, and a gate refusal becomes `rowPolicyRefusal(reason)`), `:158-175` (`lockedMetric`: the same with `metricReads` and `[spec.column, filters]`, and it throws), `:178-181` (`withLockOf(projectId, datasetId, body: (lock, hidden) => …, question: unknown = [])`)
**Interfaces:** Produces
```ts
export async function gateColumns<T>(projectId: string, datasetId: string, reads: () => Promise<string[]>, question: unknown, fn: (hidden: ReadonlySet<string>) => Promise<T>): Promise<T>;
export function setColumnGateForTest(on: boolean): void;
```
For a caller that is not restricted, outside fan-out and export scopes, `fn(EMPTY)` runs with no reads. Otherwise, for each of `[datasetId, ...await reads()]`, `refuseInScope` refuses in this order:
1. `columns` when `columnView(...).state === 'columns'` or `upstreamHides`.
2. `columns` for an as-of read (`asOfIso()`) when something is hidden.
3. `export` in an export scope when something is hidden.
4. `hidden` when `mentionsHidden(question, view.hidden)`.

Then `withColumnsChecked(new Set(ids), () => fn(viewOf(datasetId).hidden))`.
- [ ] **Step 1: Write the failing test.** This is Task 4's suite, so write Tasks 3 and 4 together.
- [ ] **Step 2–4:** see Task 4.
- [ ] **Step 5: Commit** together with Task 4.

### Task 4: Every door and row reader, over the real route
**Files:** Modify `src/ipc/answers.ts:146-148` (`computeCard` passes `spec` as the question; `computeCardWith` takes `hidden` and reads `withoutColumns(lockedTable(stored, lock), hidden)`), `src/ipc/datasets.ts:198-213` (`pageFor`: the question `{ filters: req.filters, sortColumn: req.sortColumn }`; a `search` with anything hidden refuses `hidden`; the reply cells pass through `nullHidden` and the reply gains `hidden?: string[]` when non-empty; the logic is `pageWithoutHidden` in `columnDoors.ts`, so `datasets.ts` gains two lines), `src/ipc/visuals.ts:703-712` (`visual:rows` passes `hidden` on), `src/ipc/visualsServer.ts:79-85` (`visual:rowsDownload` drops the hidden columns from `shaper.columns` and `shaper.row`), `src/ipc/distinctFor.ts:17` (the question `[column, req.filters]`: part 6 05a's parent steps name columns too, and a parent step on a hidden column would otherwise let a caller probe its values), `src/ipc/datasetViews.ts:115` (the question `[name]`) · Create `scripts/columnAccessHarness.ts`, `scripts/test-columnDoors.ts`
**Interfaces:** The harness builds on `rowPolicyHarness.world()`. It adds team HR with viewer `hr`, and a dataset **Staff** (`dept`, `salary` number, `ssn` text holding `SSN_CANARY_<i>`, `employee_id`) with the Prepare step `bonus = [salary] * 0.1`. It adds a relationship Orders.`customer` → Staff.`employee_id` (many-to-one). It plants `columnAccess = buildColumnAccess(raw, [{ column: 'salary', visibleTo: [{ teamId: HR }] }, { column: 'ssn', visibleTo: [{ teamId: HR }] }], 'boss', now)` through `serialized`, the same builder 07's setter calls.
- [ ] **Step 1: Write the failing test**
```ts
const REFUSE: Array<[string, string, object]> = [
  ['category salary', 'visual:data', viz({ category: 'salary', values: [COUNT] })], ['sum(salary)', 'visual:data', viz({ category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] })],
  ['the carrier bonus', 'visual:data', viz({ category: 'dept', values: [{ column: 'bonus', aggregation: 'avg' }] })], ['a filter on ssn', 'visual:data', viz(BY_DEPT, [{ type: 'filter', column: 'ssn', op: 'not_empty' }])],
  ['an LOD over salary', 'visual:data', viz({ category: 'dept', values: [{ column: '{FIXED dept: sum(salary)}', aggregation: 'sum' }] })], ['a formula metric over salary (re-entry)', 'visual:data', viz({ category: 'dept', values: [{ metricId: PAYROLL_PER_HEAD, column: 'x', aggregation: 'sum' }] })],
  ['a term on salary', 'visual:data', viz(BY_DEPT, [{ type: 'term', term: HIGH_EARNERS }])], ['KPI', 'dashboard:metric', kpi('salary', 'sum')], ['metric:value', 'metric:value', { projectId: P, id: PAYROLL }],
  ['answer card', 'answer:card', { projectId: P, spec: spec({ measures: [{ column: 'salary', aggregation: 'sum' }] }) }], ['joined: Orders by Staff.salary', 'visual:data', vizOn(ORDERS, { category: 'salary', categoryDatasetId: STAFF, values: [COUNT] })],
  ['grid sort', 'dataset:page', page({ sortColumn: 'salary' })], ['grid search', 'dataset:page', page({ search: 'x' })], ['distinct', 'dataset:distinct', { projectId: P, datasetId: STAFF, column: 'ssn' }], ['distinct narrowed by salary', 'dataset:distinct', { projectId: P, datasetId: STAFF, column: 'dept', filters: [{ type: 'filter', column: 'salary', op: '>', value: 0 }] }], ['profile', 'dataset:profile', { projectId: P, datasetId: STAFF, column: 'salary' }],
];
for (const [what, ch, body] of REFUSE) {
  ok(`east: ${what} is refused, typed hidden`, H.refused(await W.call('east', ch, body), 'hidden'));
  ok(`NEGATIVE CONTROL: hr gets ${what}`, !H.refused(await W.call('hr', ch, body)));
}
ok('no figure moves: headcount by dept for east is Object.is-equal to the editor\'s', sameFigure(await W.call('east', 'visual:data', viz(BY_DEPT)), await W.call('ed', 'visual:data', viz(BY_DEPT))));
ok('a join through the hidden key runs: Orders by Staff.dept', !H.refused(await W.call('east', 'visual:data', vizOn(ORDERS, { category: 'dept', categoryDatasetId: STAFF, values: [COUNT] }))));
const g = await W.call('east', 'dataset:page', page({}));
ok('the grid: hidden cells are null in place, and named', g.body.hidden.join() === 'salary,ssn,bonus' && !g.text.includes('SSN_CANARY') && g.body.rows[0].length === COLS.length);
ok('NEGATIVE CONTROL: the editor\'s grid carries the canary', (await W.call('ed', 'dataset:page', page({}))).text.includes('SSN_CANARY'));
ok('the net: dataset:stats refuses east, typed columns', H.refused(await W.call('east', 'dataset:stats', { projectId: P, datasetId: STAFF }), 'columns'));
ok('fail closed: a later step reading salary closes Staff to east', await afterStep(CALC_SALARY2, async () => H.refused(await W.call('east', 'visual:data', viz(BY_DEPT)), 'columns')));
ok('NEGATIVE CONTROL: a later step not reading salary keeps it open', await afterStep(CALC_DEPT, async () => !H.refused(await W.call('east', 'visual:data', viz(BY_DEPT)))));
ok('fail closed: a corrupt rule closes it', await withCorrupt(async () => H.refused(await W.call('east', 'visual:data', viz(BY_DEPT)), 'columns')));
ok('fail closed: a SQL dataset over Staff is closed to east, open to hr', H.refused(await W.call('east', 'dataset:page', pageOf(SQL_OVER_STAFF)), 'columns') && !H.refused(await W.call('hr', 'dataset:page', pageOf(SQL_OVER_STAFF))));
ok('Live: refused before compile; one not naming it compiles', await liveCase());
```
`liveCase` plants the same rule on a Live dataset over `liveFakeConnector`. It counts `fake.calls`: no new statement for the refused chart, one for the answered one.
- [ ] **Step 2: Run it to see it fail.** `DATABASE_URL=… node scripts/test-columnDoors.js` fails, because east gets `sum(salary)`.
- [ ] **Step 3: Implement** Tasks 3 and 4.
- [ ] **Step 4: Run it to see it pass.** `DATABASE_URL=… node scripts/test-columnDoors.js && DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js && DATABASE_URL=… node scripts/test-rowPolicyLabels.js && DATABASE_URL=… node scripts/test-rowPolicyFanOut.js && node scripts/test-liveSafetyNet.js && node scripts/test-termDoors.js && node scripts/test-visualsServer.js && node scripts/test-drillScope.js && node scripts/test-asyncReach.js && npm run lint` all report `ok`, and lint 0.
- [ ] **Step 5: Commit.** `git add src/ipc scripts/columnAccessHarness.ts scripts/test-columnDoors.ts` · "Refuse a question that names a hidden column at every door, and null hidden cells in the grid"

### Task 5: Planted readers, and the cache order
**Files:** Modify `scripts/test-columnDoors.ts`
- [ ] **Step 1: Write the failing test**
```ts
await W.call('ed', 'visual:data', viz(SUM_SALARY_BY_DEPT)); // the editor's answer is now cached
ok('cache order: east is refused the cached sum(salary)', H.refused(await W.call('east', 'visual:data', viz(SUM_SALARY_BY_DEPT)), 'hidden'));
setColumnGateForTest(false);
try { ok('NEGATIVE CONTROL: with the gate off, east would get the editor\'s cached answer', sameFigure(await W.call('east', 'visual:data', viz(SUM_SALARY_BY_DEPT)), await W.call('ed', 'visual:data', viz(SUM_SALARY_BY_DEPT)))); } finally { setColumnGateForTest(true); }
ok('a planted getDataset reader is refused by the net', H.refused(await plantedRead(() => datasets.getDataset(P, STAFF)), 'columns'));
ok('a planted tablePath reader is caught by the leak check', (await plantedRead(() => readParquetByPath(P, STAFF))).text.includes('SSN_CANARY') /* the reason REDACT/SKIP rows exist (06) */);
```
- [ ] **Step 2: Run it to see it fail.** With the gate turned off in the code under test, the first `ok` fails.
- [ ] **Step 3: Implement.** Only fix what fails: the seam was added in Task 3.
- [ ] **Step 4: Run it to see it pass.** `DATABASE_URL=… node scripts/test-columnDoors.js` reports `ok`.
- [ ] **Step 5: Commit.** `git add scripts/test-columnDoors.ts` · "Prove the column gate runs before the answer cache"

Not in this step: the REDACT rows, Assistant and MCP dropping, fan-out and `/p/`, the read-contract inventory (06), the setter and the web (07). Until 06, a dataset-context Assistant question is refused for east (`gateRows`, `columns`), and `visualForCaller` drops labels on every Staff chart for east. Both fail closed.
