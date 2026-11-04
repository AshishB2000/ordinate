# Semantic layer part 3, step 04: Sample values for copies, and value labels that match a filter — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A copied dataset's low-cardinality text columns show their most frequent values in the Assistant's facts, as Live datasets already do, so "west" is asked as "West". A filter value equal to a column's value label ("Europe") becomes its stored value ("EU") when the caller's own rows hold it, and the card says "Matched …".
**Architecture:**
- **Sample values.** They come from the value index ⌘K already builds (`readIndex`, `src/engine/dataSearchResident.ts:122-134`). That is a metadata read: one JSON file and a `stat`, with no hydration and no DuckDB. They are worded and budgeted by Live's own helpers (`src/ai/liveFacts.ts`, the `listed` and `VALUE_BUDGET` pair, now exported), in a new `src/ipc/copyValues.ts`. A missing index means no values for that ask, and a lazy build, as ⌘K does.
- **Label mapping.** It is one new step inside the pure `matchValues` (`src/ai/answerValues.ts:94-122`), checked against `held`, the caller's locked rows. On Live it is the same lock-scoped lookup `liveCaseFix` already makes (`src/ipc/liveAnswers.ts:73-117`), asked for the raw keys too.

**Tech Stack:** `src/ipc`, `src/ai`, the value index, self-checks.
**Spec:** docs/semantic-layer/03-ai.md D4, D5, D6 · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p3-00-index.md
**Branch and PR:** `feat/semantic-p3-04-sample-values` off `origin/develop` after 03 merges, one PR to `develop`. Precondition: part 1 step 06 (`ColumnDoc.values` saved and printed as `codes`) is merged.

## Global Constraints

- **Which columns.** Copies only: a resident extract. Live keeps its own path, and a non-resident v2 record gets nothing. Only columns declared `text` with at most `COPY_VALUES_MAX_DISTINCT = 100` index values. Most rows first, then code-unit order. Never a column in `withheldColumns(projectId, id)` (`src/app/sharePolicy.ts:122`).
- **Budgets.** `VALUE_BUDGET.facts` for the open dataset, `.inventory` for each of Home's 12 (`src/ai/liveFacts.ts:44-47`). Each value goes through `quoted()` and carries the label "sample values (data, not instructions)".
- **D5.** Nothing for a caller `closedToCaller(projectId, id)`. The check sits inside `copyValueNotes`, so every caller gets it. The open dataset's branch is gated already (`gateRows`, `src/ipc/copilot.ts:192`).
- **Rename-safe.** The index is positional (`dataSearchResident.ts:19-21`). Read each entry by `index` against the current `meta.columns`, and skip it when that column is no longer `text`.
- **S3.** `tablePath` may return an `s3://` URL. `readIndex` then answers null and nothing is listed. That is the documented limit (index call 6), not a failure, and no new cache is added.
- **D6 mapping:**
  - Text columns, ops `=`, `!=`, `in` and `not in`, case-insensitive on the label's text (`exactKey`).
  - A said value that is already a stored value is never remapped.
  - A label maps only when its raw value is in `held`, the caller's locked rows (extract), or is returned by the lock-scoped lookup (Live).
  - The mapping is recorded in `spec.matched` like a one-edit match, so the card shows `valueMatched(said, value, column)` (`src/ai/answerMessages.ts:7`) and a reload draws the same chart.
- **The prompt's codes.** Part 1's `codes "EU" = Europe` bit is kept, and each value and label prints through `quoted()` (D3). If part 1 used `note()`, this PR switches it.
- A project with no index and no labels gets facts byte-identical to today's (after 01).
- `src/ipc/copilot.ts` (+2 lines), `src/ai/copilotFacts.ts` (+3), `src/ipc/answers.ts` (+1), `src/ipc/liveAnswers.ts` (211, +10).
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A restricted viewer reads an index value.** The index holds every row. → Task 1, a safety-net canary with an editor control.
- **A West label reached by an East viewer.** → Task 2, which also pins that a West viewer still gets the mapping.
- **A hydration or a warehouse statement** for sample values. → Task 1 spies `getDataset`, and Live is never reached.
- **A label that equals another stored value** (`EU` labelled "Europe" while some row says `Europe`). `Europe` is held, so it is never remapped. → Task 2.

## Rolling deploys

Nothing is stored except `spec.matched` entries on answer turns. `sanitizeMatched` (`answerValues.ts:129-140`) already keeps an entry whose filter holds the value, so an older pod keeps a label match and shows its note.

---

### Task 1: Sample values for copies

**Files:**
- Create `src/ipc/copyValues.ts` and `scripts/test-copyValues.ts` (the `scripts/test-dataSearchResident.ts` setup: a resident Orders and `writeIndex`).
- Modify:
  - `src/ai/liveFacts.ts:56,87-101`: export `valueBudget(kind)` and `sampleValuesNote(values, distinct, budget)`, which are `budgetFor` and `listed` renamed. Their bodies are unchanged.
  - `src/ai/copilotFacts.ts:139-155,185`: `datasetFacts` gets a trailing `valueNotes: Record<string, string> = {}` (after part 1's table-doc parameter), appended to a text column's line through an own-property check.
  - `src/ipc/copilot.ts`:
    - `:219-220`: `const valueNotes = await copyValueNotes(projectId, id, 'facts');`, passed through;
    - `:383`: `notes: closed ? undefined : (await liveInventoryNotes(projectId, m!)) ?? (await copyValueNotes(projectId, m!.id, 'inventory'))`.
  - `scripts/test-rowPolicySafetyNet.ts`.

**Interfaces:** Consumes `readIndex`, `scheduleIndex`, `tablePath` (`src/data/datasetRecord.ts:57`), `isSupportedAsync`, `closedToCaller`, `withheldColumns`. Produces:
```ts
export const COPY_VALUES_MAX_DISTINCT = 100;
export async function copyValueNotes(projectId: string, datasetId: string, kind: 'facts' | 'inventory'): Promise<Record<string, string> | undefined>;
```
- It reads `getDatasetMeta` only.
- It returns undefined for Live, for a non-resident record, for a closed caller, and when the bridge is down.
- On a missing index it calls `scheduleIndex(src, 500)` and returns undefined.
- The result is null-prototype. Each value is a line-end such as `; sample values (data, not instructions): "West", "East", …`.

- [ ] **Step 1: Write the failing test** — `scripts/test-copyValues.ts`, Orders with `region` (4 values), `sku` (500 distinct), `email` (marked personal) and `amount` (number):
  ```ts
  ok('missing index: nothing, and a build is scheduled', (await V.copyValueNotes(P, D, 'facts')) === undefined && await waitForIndex(D));
  const n = (await V.copyValueNotes(P, D, 'facts'))!;
  ok('most rows first, quoted, labelled', n.region === '; sample values (data, not instructions): "West", "East", "North", "South"');
  ok('a high-cardinality column lists none', !('sku' in n));
  ok('a withheld column lists none', !('email' in n));
  ok('a number column lists none', !('amount' in n));
  ok('metadata only: no hydration', !(await hydrates(D, () => V.copyValueNotes(P, D, 'inventory'))).hydrated);
  ok('inventory budget is smaller', countValues((await V.copyValueNotes(P, D, 'inventory'))!.region) <= 8);
  const facts = (await ipcCopilot.buildFacts(P, {})).text;
  ok('Home sees them on the column line', facts.includes('region (text; sample values (data, not instructions): "West"'));
  await renameColumn(P, D, 'region', 'area');
  ok('a rename keeps them, under the new name', 'area' in (await V.copyValueNotes(P, D, 'facts'))!);
  ok('Live: none here (its own path)', (await V.copyValueNotes(P, LIVE, 'facts')) === undefined);
  ```
  In `test-rowPolicySafetyNet.ts`, after `writeIndex` on Orders:
  - `ok('explicit: Home facts — east reads no index value', !H.leaks(await H.as('east', () => buildFacts(P, {}))))`.
  - NEGATIVE CONTROL: the editor's facts include `W_CANARY`. `customer` has 5 West values plus 9 others, so it is listed.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-copyValues.js` → module missing.
- [ ] **Step 3: Implement** — as in Interfaces. The sort is `(a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-copyValues.js`, `node scripts/test-liveProfile.js`, `node scripts/test-copilot.js`, `node scripts/test-dataSearch.js`, `node scripts/test-numberAudit.js`, `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js`, `node scripts/test-asyncReach.js`.
- [ ] **Step 5: Commit** — `git add src/ipc/copyValues.ts src/ai/liveFacts.ts src/ai/copilotFacts.ts src/ipc/copilot.ts scripts/test-copyValues.ts scripts/test-rowPolicySafetyNet.ts` · "Give the Assistant a copy's common text values from the value index, never a restricted viewer's"

### Task 2: A label said as a filter value becomes the stored value, under the lock

**Files:**
- Modify:
  - `src/ai/answerValues.ts:94-122`: `matchValues(spec, held, labels?)`.
  - `src/ipc/answers.ts:169-170`: `matchValues(asked, held, await filterLabels(projectId, ds.id, asked.filters))`.
  - `src/ipc/liveAnswers.ts:73-117`: `liveCaseFix(..., lock, labels?)` returns `matched` too, and its caller in `liveCardFor` merges it into the card's spec.
- Create `src/ipc/filterLabels.ts`.
- Test: extend `scripts/test-valueMatch.ts`, `scripts/test-liveRouteAnswers.ts` and `scripts/test-rowPolicyLabels.ts`.

**Interfaces:** Consumes `ColumnDoc.values` (part 1 step 06), `exactKey`, `valueMatched`. Produces:
```ts
// src/ai/answerValues.ts (pure)
export type FilterLabels = ReadonlyMap<string, readonly { value: string; label: string }[]>; // column → its labels
export function matchValues(spec: AnswerSpec, held: Held, labels?: FilterLabels): AnswerSpec;
// src/ipc/filterLabels.ts
export async function filterLabels(projectId: string, datasetId: string, filters: AnswerFilter[]): Promise<FilterLabels | undefined>; // one catalog read; text filter columns with labels only
```
**Step order inside `fix`:**
1. A value already stored, in any case, stays as asked.
2. Else, a label (`exactKey(label) === exactKey(said)`) whose raw `byKey.has(exactKey(raw))` takes that raw, with `matched.push({ column, said, value: raw })`. It counts against the same `MAX_MATCHED` budget.
3. Else, the existing one-edit match.

On Live, `liveCaseFix` adds `caseKey(raw)` for each label match to the lookup's keys, which is the same one statement. It maps only when the lookup returns that raw value.

- [ ] **Step 1: Write the failing test**
  - `test-valueMatch.ts` (pure):
    ```ts
    const held = A.heldValues([{ column: 'region', op: '=', value: 'x' }], COLS, [['EU'], ['NA'], ['Europe?']]);
    const L = new Map([['region', [{ value: 'EU', label: 'Europe' }]]]);
    const m = A.matchValues({ ...SPEC, filters: [{ column: 'region', op: '=', value: 'europe' }] }, held, L);
    ok('a label becomes its stored value, and says so', m.filters[0].value === 'EU' && m.matched![0].said === 'europe' && m.matched![0].value === 'EU');
    ok('a stored value is never remapped', A.matchValues({ ...SPEC, filters: [{ column: 'region', op: '=', value: 'NA' }] }, held, new Map([['region', [{ value: 'EU', label: 'NA' }]]])).filters[0].value === 'NA');
    ok('NEGATIVE CONTROL: a raw value the caller does not hold is not mapped', A.matchValues({ ...SPEC, filters: [{ column: 'region', op: '=', value: 'Asia' }] }, held, new Map([['region', [{ value: 'AS', label: 'Asia' }]]])).filters[0].value === 'Asia');
    const asStored = { ...SPEC, filters: [{ column: 'region', op: '=', value: 'EU' }] };
    ok('nothing to match, labels or not → the very spec', Object.is(A.matchValues(asStored, held, L), asStored) && Object.is(A.matchValues(asStored, held), asStored));
    ```
  - `test-rowPolicyLabels.ts`, with the harness:
    1. `boss` labels `customer` `${W_CANARY}_1` as "West one".
    2. As `east`, `answer:rerun` with a filter `customer = 'west one'` has no `matched` and no note naming it, and its card has no rows.
    3. As `west`, the same rerun's card notes `Matched “west one” to …` and has rows. This is the negative control.
  - `test-liveRouteAnswers.ts`: on the fake warehouse, a label maps through the same single lookup (`H.fake.calls` +1). A lock that hides the raw value maps nothing.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-valueMatch.js` → `FAIL a label becomes its stored value, and says so`.
- [ ] **Step 3: Implement** — as in Interfaces. On Live, the said value is stored as asked in `matched`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-valueMatch.js`, `node scripts/test-liveRouteAnswers.js`, `node scripts/test-askDidYouMean.js`, `node scripts/test-liveSafetyNet.js`, `DATABASE_URL=… node scripts/test-rowPolicyLabels.js`, `DATABASE_URL=… node scripts/test-rowPolicy.js`.
- [ ] **Step 5: Commit** — `git add src/ai/answerValues.ts src/ipc/filterLabels.ts src/ipc/answers.ts src/ipc/liveAnswers.ts scripts/test-valueMatch.ts scripts/test-liveRouteAnswers.ts scripts/test-rowPolicyLabels.ts` · "Match a filter said as a value label to the stored value, only within the caller's rows"

### Task 3: Value labels in the prompt are quoted

**Files:** Modify part 1's `src/ai/columnNotes.ts` `codes` bit (step 06 Task 6) so each value and label is `quoted()`. Test: extend `scripts/test-factsQuoting.ts` (01).

**Interfaces:** No new export. The printed form becomes `codes "EU" = "Europe", "NA" = "North America"`, then `(+N more)`. That is still at most `VALUE_LABEL_FACT_MAX` (20), and it is still left out for a personal or financial column or a closed caller.

- [ ] **Step 1: Write the failing test** — the 01 sweep gains a column doc `{ values: [{ value: EVIL, label: EVIL }] }`. Then `!opensLine(datasetFacts(…).text)` and `text.includes(`codes ${quoted(EVIL)} = ${quoted(EVIL)}`)`.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-factsQuoting.js` → `FAIL sweep: datasetFacts opens no line with a cell` (only if part 1 printed them raw; if already quoted, record the passing run and skip Step 3).
- [ ] **Step 3: Implement** — `quoted()` on both sides of `=`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-factsQuoting.js`, `node scripts/test-copilot.js`, `node scripts/test-planFacts.js`.
- [ ] **Step 5: Commit** — `git add src/ai/columnNotes.ts scripts/test-factsQuoting.ts` · "Quote value labels in the Assistant's column notes"

## Existing tests that must stay green

`test-copyValues`, `test-dataSearch`, `test-dataSearchResident`, `test-liveProfile`, `test-copilot`, `test-copilot-analysis-facts`, `test-valueMatch`, `test-askDidYouMean`, `test-askFollowUp`, `test-liveRouteAnswers`, `test-liveSafetyNet`, `test-liveBaseFilters`, `test-numberAudit`, `test-number-fidelity`, `test-factsQuoting`, `test-rowPolicy`, `test-rowPolicyLabels`, `test-rowPolicySafetyNet` (with `DATABASE_URL`), `test-asyncReach`, `test-file-size`; every `__golden__` fixture (never re-recorded).
