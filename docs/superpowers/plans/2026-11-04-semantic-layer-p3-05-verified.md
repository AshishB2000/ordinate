# Semantic layer part 3, step 05: Verified questions — the record, the broken check, the mark — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team can sign off a question ("Revenue by region last quarter") as a stored **spec, never a figure**. Editing a question keeps who verified it. Each read works out whether it still runs, and one that doesn't says why without ever being repaired. Any answer card whose spec is a working verified one shows "✓ Verified · <who>". That mark is computed at every draw and never stored.
**Architecture:**
- **The record kind** is `verified`, stored like metrics: `recordFs`, the edit-conflict tag, Trash.
  - `src/analysis/verifiedRules.ts` (pure) holds the type, the caps, the question key and visibility.
  - `src/analysis/verifiedQuestions.ts` is the store.
  - `src/ipc/verifiedState.ts` holds "does it still run", worked out against metadata only.
- **Three channels** live in `src/ipc/verified.ts`. `verified:save` re-validates the spec with `validateAnswerSpec`, draws it once through `computeCard` (row lock, Live door), and stores the card's spec without `matched` or `title`.
- **The mark** comes from `src/ipc/verifiedMark.ts`, hooked into `answer:card` with one spread. It compares specs with `sameChart` (`src/ai/answerRefine.ts:142`), also ignoring `chartType`.
- **Broken questions** count in part 1's "To fill in next" strip.

**Tech Stack:** record stores, `src/app/editConflict.ts`, `src/app/trash.ts`, zod contracts, React (`web/src/features/model/assistant/`, `web/src/features/assistant/AnswerCard.tsx`).
**Spec:** docs/semantic-layer/03-ai.md D5, D7, D9 · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p3-00-index.md
**Branch and PR:** `feat/semantic-p3-05-verified` off `origin/develop` after 04 merges, one PR to `develop`. Precondition: part 1 step 05b (terms: `SpecTerm`, `listTerms`) is merged. The bundle rule shipped in 02.

## Global Constraints

- **Shape (D7).** `VerifiedQuestion { id; projectId; question /* ≤ 300, one line */; phrasings: string[] /* ≤ 8, each ≤ 300, one line */; spec: AnswerSpec /* no `matched`; title = question */; note?: string /* ≤ 500 */; verifiedBy; verifiedAt; createdAt; updatedAt; schemaVersion: 1 }`.
  - Periods stay relative (`{ column, period }`).
  - A term stays a reference (`{ term: <id> }`), so an edited term changes its answer.
- **Unique per project.** A question or a phrasing must not share `questionKey` (`squash(oneLine(s))`, `src/app/columnNames.ts:17`) with any other question or phrasing in the project.
- **Every save restamps `verifiedBy` (`osUser()`) and `verifiedAt`.** Whoever saves vouches for what the record now says.
- **"No longer runs"** means one of these, worked out on each read from metadata and the catalog (never `getDataset`, never a warehouse):
  - the dataset is gone;
  - a name in `answerNames(spec)` (`src/engine/live/liveMissing.ts:35`) is not a column;
  - a term id is gone;
  - `validateAnswerSpec(refineSpec(spec, {}, ds), [ds], { metrics, terms })` refuses (the check `previousAnswer` already makes, `src/ipc/answers.ts:299-301`).

  A broken question is shown with its reason. It is never repaired, matched, marked or used as an example.
- **D5.** A question is **hidden** for a caller when `closedToCaller(projectId, spec.datasetId)` and its spec has a value filter: an op with `value` or `values`. A term reference, a period or a valueless op is no value filter. For a hidden question:
  - `verified:list` sends the question text with no `spec`, and its filter words read "values hidden by row access rules" (REDACT);
  - it gives no mark.
- **The mark (D9)** compares `{ ...spec, chartType: '' }` with `sameChart`, against working, visible records only. It is added to the `answer:card` reply only. It is never stored on a turn and never read from input: `sanitizeStoredSpec` already drops an unknown `verified` key.
- **Access.** `verified:list` is `read`, REDACT. `verified:save` and `verified:delete` are `write`. All three are project-scoped. `verified:save` joins `scripts/test-liveSafetyNet.ts` as ROUTED.
- Sentences go in `src/analysis/verifiedMessages.ts` (`MAIN_FILES`). `src/ipc/answers.ts` takes +0 lines, because the spread joins the existing return at `:431`.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A stored figure.** The record holds no number of the card. When the rows change, the verified answer's figure changes. → Task 3.
- **A mark the app did not earn.** `"verified": true` sent by a client, a spec one filter off, or a broken one gets no mark. An identical spec gets it, even with another chart type. → Task 4.
- **A broken question that silently "works".** A dropped column stops it, and restoring the column brings it back. → Task 2.
- **A restricted viewer reads a value through a verified spec.** → Task 3, with a safety-net canary.
- **The strip reads metadata only.** → Task 5, with the `hydrates` spy.

## Rolling deploys

- **`verified/<id>.json`:** P3-A pods never read it, but they back it up and import it (02).
- **`trash/verified/`:** hidden in a P3-A pod's Trash, and its `trash:restore` refuses `type: 'verified'` at input validation (`src/api/trash.ts:5`). Harmless; a new pod restores it.
- **The `verified_broken` strip item:** a P3-A browser tab draws an unlabelled chip until it reloads.
- **The `verified` mark on `answer:card`:** an old tab ignores the unknown field.

---

### Task 1: The record kind and its store

**Files:**
- Create `src/analysis/verifiedRules.ts`, `src/analysis/verifiedQuestions.ts`, `src/analysis/verifiedMessages.ts` and `scripts/test-verified.ts`.
- Modify:
  - `src/app/recordKinds.ts:15-26`: `'verified'` in `RecordType` and `RECORD_TYPES`, plus `RECORD_DIR.verified = 'verified'`.
  - `src/api/trash.ts:5`.
  - `src/app/trash.ts:99,135`: a record without `name` is named by `question`. Check that `trashStore.listEntries` (`:108-143`) shows the same name.
  - `src/analysis/recordDiff.ts:42,50-59`: `SaveKind` `'verified'`, `SAVE_KEYS.verified = ['question','phrasings','note','spec']`.
  - `src/app/editConflictMessages.ts:10-31`: a `verified` case.
  - `scripts/test-editConflicts.ts` (`Chan`).
  - `web/src/features/projects/api.ts:39` and `web/src/features/projects/TrashPage.tsx:20-27,78`: `verified: { word: 'Verified question', icon: 'circle-check' }`.
  - `scripts/i18n-extract.ts`.

**Interfaces:** Produces:
```ts
// verifiedRules.ts (pure)
export const MAX_QUESTION = 300, MAX_PHRASINGS = 8, MAX_NOTE = 500;
export interface VerifiedQuestion { … as above }
export function questionKey(s: string): string;
export function sanitizeVerified(raw: unknown): VerifiedQuestion | null; // spec via sanitizeStoredSpec, `matched` dropped, `title` := question
export function keyClash(list: VerifiedQuestion[], texts: string[], exceptId?: string): string | null; // the text already taken
export function hasValueFilter(spec: AnswerSpec): boolean;
// verifiedQuestions.ts (mirrors src/analysis/metrics.ts:126-475)
export function listVerified(projectId: string): Promise<VerifiedQuestion[]>; // newest updatedAt first; a corrupt file skipped
export function readVerified(projectId: string, id: string): Promise<Tagged<VerifiedQuestion> | null>;
export function getVerified(projectId: string, id: string): Promise<VerifiedQuestion | null>;
export function writeVerified(projectId: string, q: VerifiedQuestion, base?: unknown): Promise<VerifiedQuestion>; // new: atomic write; existing: lockedUpdate('verified', …)
```
- [ ] **Step 1: Write the failing test** — `scripts/test-verified.ts` §1, in a temp `ORDINATE_LOCAL_DIR`:
  ```ts
  const q = R.sanitizeVerified({ id: V, projectId: P, question: ' Revenue by\nregion ', phrasings: ['revenue per region'], spec: { ...SPEC, matched: [{ column: 'region', said: 'west', value: 'West' }] }, verifiedBy: 'a', verifiedAt: T, createdAt: T, updatedAt: T, schemaVersion: 1 })!;
  ok('one line, spec without matched, title is the question', q.question === 'Revenue by region' && !('matched' in q.spec) && q.spec.title === 'Revenue by region');
  ok('the key squashes', R.questionKey('Revenue by region?') === R.questionKey('revenue  BY region'));
  ok('a clash is found across phrasings', R.keyClash([q], ['Revenue per region!']) === 'Revenue per region!');
  ok('a term or a period is no value filter', !R.hasValueFilter({ ...SPEC, filters: [{ term: TERM }, { column: 'order_date', period: 'last_quarter' }, { column: 'region', op: 'not_empty' }] }) && R.hasValueFilter({ ...SPEC, filters: [{ column: 'region', op: '=', value: 'West' }] }));
  await S.writeVerified(P, q);
  ok('Trash: delete → listed under its question → restore', await trashRoundTrip(P, 'verified', V, 'Revenue by region'));
  ok('a stale base refuses (409 record_changed)', isRecordChanged(await caught(() => S.writeVerified(P, { ...q, note: 'x' }, 'stale'))));
  ok('a corrupt file is skipped', (await corruptOne(P), (await S.listVerified(P)).length === 1));
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-verified.js` → module missing.
- [ ] **Step 3: Implement** — copy the metric store's id guards, atomic write and skip-corrupt behaviour.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verified.js`, `node scripts/test-trash.js`, `node scripts/test-editConflicts.js`, `node scripts/test-bundle.js`, `npm run test:web -- Trash`.
- [ ] **Step 5: Commit** — `git add src/analysis/verifiedRules.ts src/analysis/verifiedQuestions.ts src/analysis/verifiedMessages.ts src/app src/api/trash.ts src/analysis/recordDiff.ts web/src/features/projects scripts/test-verified.ts scripts/test-editConflicts.ts scripts/i18n-extract.ts src/i18n/*.json` · "Add the verified question record"

### Task 2: Whether it still runs, and who may see its spec

**Files:** Create `src/ipc/verifiedState.ts`. Test: `scripts/test-verified.ts` §2.

**Interfaces:** Consumes `specDatasets`, `specMetrics` (`src/ipc/answers.ts:242,251`), `listTerms` (05b), `answerNames`, `refineSpec`, `validateAnswerSpec`, `closedToCaller`. Produces:
```ts
export interface VerifiedEnv { datasets: SpecDataset[]; metrics: SpecMetric[]; terms: SpecTerm[] }
export async function verifiedEnv(projectId: string): Promise<VerifiedEnv>;          // metadata + catalog + term records
export function verifiedProblem(q: VerifiedQuestion, env: VerifiedEnv): string | null; // a catalog sentence, or null
export interface VerifiedState { q: VerifiedQuestion; problem: string | null; hidden: boolean }
export async function verifiedStates(projectId: string): Promise<VerifiedState[]>;   // one env, one closedToCaller per dataset
```
Term filters are validated by name: `{ term: id }` becomes `{ term: <its name> }` before `validateAnswerSpec`.

The sentences are:
- `verifiedDatasetGone()`: "The dataset this question was verified on no longer exists."
- `verifiedColumnGone(column, dataset)`: "“{column}” is no longer a column of {dataset}."
- `verifiedTermGone()`: "A glossary term this question uses was deleted."

- [ ] **Step 1: Write the failing test** — §2:
  ```ts
  ok('a working question has no problem', V.verifiedProblem(q, await V.verifiedEnv(P)) === null);
  await reimportWithout(P, D, 'region');
  ok('a dropped column: no longer runs, with the reason', V.verifiedProblem(q, await V.verifiedEnv(P)) === msg.verifiedColumnGone('region', 'Orders'));
  await reimportWith(P, D, 'region');
  ok('restored, it runs again', V.verifiedProblem(q, await V.verifiedEnv(P)) === null);
  ok('a deleted term: no longer runs', (await deleteTerm(P, TERM), V.verifiedProblem(qTerm, await V.verifiedEnv(P))) === msg.verifiedTermGone());
  ok('metadata only: nothing hydrated', !(await hydrates(D, () => V.verifiedStates(P))).hydrated);
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-verified.js` → module missing.
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verified.js`, `node scripts/test-asyncReach.js`.
- [ ] **Step 5: Commit** — `git add src/ipc/verifiedState.ts scripts/test-verified.ts` · "Say whether a verified question still runs, from metadata, and never repair it"

### Task 3: `verified:list`, `verified:save`, `verified:delete`

**Files:**
- Create `src/api/verified.ts` and `src/ipc/verified.ts`.
- Modify:
  - `src/api/index.ts` (append);
  - `src/server/app.ts:592` (add `'../ipc/verified'` to the AI modules' array: 0 new lines);
  - `scripts/rowPolicyReaders.ts` (`'verified:list': 'REDACT', // D5: no spec with a value filter on a closed dataset`);
  - `scripts/test-liveSafetyNet.ts` (`ROW_READERS` and `ROUTED`, `:144-220`);
  - `scripts/test-rowPolicySafetyNet.ts`;
  - `src/ai/previousAnswer.ts:27` (export `filterWords`).

**Interfaces:** Produces:
```ts
const Spec = z.looseObject({ datasetId: Uuid }); // sanitizeStoredSpec whitelists the rest
const Input = z.strictObject({ question: z.string().trim().min(1).max(300), phrasings: z.array(z.string().max(300)).max(8).optional(), note: z.string().max(500).optional(), spec: Spec });
'verified:list':   rpc({ access: 'read',  input: z.strictObject({ projectId: Uuid, datasetId: Uuid.optional() }), project: byProjectId }),
'verified:save':   rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid.optional(), base: z.string().max(128).optional(), input: Input }), project: byProjectId }),
'verified:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
// list → { ok: true; broken: number; questions: VerifiedRow[] }
interface VerifiedRow { id: string; question: string; phrasings: string[]; note?: string; datasetId: string; datasetName: string;
  describe: string /* describeAnswer(spec) */; filters: string[] /* filterWords; values hidden when hidden */; spec?: AnswerSpec /* absent when hidden */;
  verifiedBy: string; verifiedAt: string; runs: boolean; problem?: string; tag: string }
// save → { ok: true; question: VerifiedRow } | { ok: false; error: string; field?: 'question' | 'phrasings' | 'spec' }
// The handler's body, exported for the sample seed (07):
export async function saveVerifiedQuestion(projectId: string, input: z.infer<typeof Input>, at?: { id: string; base?: string }): Promise<{ ok: true; q: VerifiedQuestion } | { ok: false; error: string; field?: string }>;
```
- **Order:** `datasetId`'s questions first, then newest. A chip row reads the first 4 that run and have a spec (06).
- **Save does, in order:**
  1. `sanitizeStoredSpec`.
  2. `verifiedProblem`, refusing with its sentence and `field: 'spec'`.
  3. `keyClash`, refusing `verifiedTaken(text)` with `field`.
  4. `computeCard(projectId, spec)`: a `Failure` refuses `verifiedDoesNotDraw(reason)`, "This answer cannot be verified: {reason}".
  5. Store `{ ...card.spec }` without `matched`, with `title := question`.

  With `id`, it reads the tagged record, and a `base` that does not match throws 409 `record_changed`. Delete calls `trash.trashRecord(projectId, 'verified', id)`.

- [ ] **Step 1: Write the failing test** — §3, over `handlers`:
  ```ts
  const s = await call('verified:save', { projectId: P, input: { question: 'Revenue by region', spec: SPEC } });
  ok('saved: the card\'s spec, no figure', s.ok && !/\b(data|headline|bullets)\b/.test(JSON.stringify(rawRecord(P, s.question.id))));
  const f1 = await cardFigure(P, s.question.id); await refreshRows(P, D, MORE_ROWS);
  ok('no stored figure: new rows, new figure', !Object.is(f1, await cardFigure(P, s.question.id)));
  ok('a spec that does not draw cannot be verified', (await call('verified:save', { projectId: P, input: { question: 'x', spec: { ...SPEC, category: 'nope' } } })).field === 'spec');
  ok('a taken question is refused', (await call('verified:save', { projectId: P, input: { question: 'revenue by REGION?', spec: SPEC } })).error === msg.verifiedTaken('revenue by REGION?'));
  ok('edit with a stale tag is 409', (await callStatus('verified:save', { projectId: P, id: s.question.id, base: 'stale', input: { question: 'Revenue by region', spec: SPEC } })) === 409);
  ok('list: describe, runs, who', ((r) => r.runs && r.describe.length > 0 && r.verifiedBy === TEST_USER)((await call('verified:list', { projectId: P })).questions[0]));
  ok('delete goes to Trash', (await call('verified:delete', { projectId: P, id: s.question.id })).ok && (await trashList(P)).some((e) => e.type === 'verified'));
  ```
  In `test-liveSafetyNet.ts`, add `['verified save', 'verified:save', { projectId: P, input: { question: 'Sales by region', spec: { datasetId: d, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [] } } }]` to `ROW_READERS`, with the label in `ROUTED`.

  In `test-rowPolicySafetyNet.ts`, `boss` saves "West customers" on Orders with `customer = ${W_CANARY}_1`, then:
  - `ok('redact: verified:list — east reads the question, no spec, no value', …!H.leaks(east.text) && !('spec' in row) && row.question === 'West customers')`;
  - NEGATIVE CONTROL: the editor's row has the spec and the canary.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-verified.js` → `No handler for verified:save`. `node scripts/check-contracts.js` lists three unresolved.
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verified.js`, `node scripts/test-liveSafetyNet.js`, `node scripts/check-contracts.js`, `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js`, `node scripts/test-server-boot.js`, `node scripts/test-i18n.js`.
- [ ] **Step 5: Commit** — `git add src/api/verified.ts src/api/index.ts src/ipc/verified.ts src/server/app.ts src/ai/previousAnswer.ts scripts/rowPolicyReaders.ts scripts/test-liveSafetyNet.ts scripts/test-rowPolicySafetyNet.ts scripts/test-verified.ts src/analysis/verifiedMessages.ts src/i18n/*.json` · "Save, list and delete verified questions, drawing each once before it is kept"

### Task 4: The mark on answer cards

**Files:**
- Create `src/ipc/verifiedMark.ts` and `web/src/features/assistant/verifiedMark.test.tsx`.
- Modify `src/ipc/answers.ts:431`: `return { ...built.card, ...(taught …), ...(kept …), ...(await verifiedMark(projectId, built.card.spec)) };`.
- Modify `web/src/features/assistant/AnswerCard.tsx`: `:37-56`, `Card.verified?`; `:118-128`, the badge in `s.meta`.

**Interfaces:** Produces `verifiedMark(projectId: string, spec: AnswerSpec): Promise<{ verified?: { id: string; question: string; by: string; at: string } }>`. It looks at working, not hidden states only. The badge reads `✓ Verified · {by}`, with `title="Verified {date}: {question}"`.

- [ ] **Step 1: Write the failing test** — §4:
  ```ts
  const card = (spec: unknown) => call('answer:card', { projectId: P, spec });
  ok('the identical spec is marked', (await card(SPEC)).verified?.id === V);
  ok('another chart type is still that answer', (await card({ ...SPEC, chartType: 'bar' })).verified?.id === V);
  ok('a client cannot claim it', !(await card({ ...OTHER, verified: { id: V } })).verified);
  ok('one filter off is not marked', !(await card({ ...SPEC, filters: [...SPEC.filters, { column: 'region', op: '=', value: 'West' }] })).verified);
  await reimportWithout(P, D, 'segment_used_by_V');
  ok('broken: no mark', !(await card(SPEC)).verified);
  ```
  `verifiedMark.test.tsx`: an `answer:card` stub with `verified: { by: 'priya@x', … }` shows "✓ Verified · priya@x" in the card head, and without it shows no badge.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-verified.js` → `FAIL the identical spec is marked`.
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verified.js`, `node scripts/test-answerFacts.js`, `node scripts/test-askFollowUp.js`, `npm run test:web -- assistant didYouMean freshness verifiedMark`.
- [ ] **Step 5: Commit** — `git add src/ipc/verifiedMark.ts src/ipc/answers.ts web/src/features/assistant scripts/test-verified.ts` · "Mark an answer verified only when its spec is a working verified one"

### Task 5: Broken questions in "To fill in next"

**Files:**
- Modify part 1's `src/ipc/modelOverview.ts`: `TodoKind` gains `'verified_broken'`, ranked after `'key_repeats'`, and `TodoItem.count?: number`. `todoOf(rows, brokenVerified = 0)` adds one item `{ datasetId: '', kind: 'verified_broken', count }`, which the handler fills from `verifiedStates`.
- Modify part 1's `web/src/features/model/api.ts` `todoText`: "1 verified question no longer runs" or "{n} verified questions no longer run". Its click sets `?tab=assistant`.
- Test: extend part 1's `scripts/test-modelOverview.ts` and `web/src/features/model/model.test.tsx`.

**Interfaces:** As above.

- [ ] **Step 1: Write the failing test** — `test-modelOverview.ts`:
  - after a dropped column, `todo[0..1]` holds `{ kind: 'verified_broken', count: 1 }`;
  - `hydrates` still false;
  - NEGATIVE CONTROL: `todoOf(rows, 0)` adds none.

  `model.test.tsx`: the chip reads "1 verified question no longer runs", and its click lands on `?tab=assistant`.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-modelOverview.js` → `FAIL a broken verified question is in the strip`.
- [ ] **Step 3: Implement** — as above.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-modelOverview.js`, `npm run test:web -- model`.
- [ ] **Step 5: Commit** — `git add src/ipc/modelOverview.ts web/src/features/model scripts/test-modelOverview.ts` · "List verified questions that no longer run in what to fill in next"

### Task 6: The verified list on the Assistant tab

**Files:**
- Create in `web/src/features/model/assistant/`: `VerifiedList.tsx`, `VerifiedDialog.tsx`, `verified.test.tsx`.
- Modify `AssistantTab.tsx` (03) and `api.ts`: `useVerified(projectId, datasetId?)`, key `['verified:list', projectId, datasetId ?? '']`.

**Interfaces:** `VerifiedList({ projectId })`:
- **Head:** "Verified questions" with the count, and, when `broken > 0`, a warn `Badge` "⚠ {broken} no longer runs".
- **Rows:** each row shows:
  - the question;
  - `describe` · `filters.join(' · ')` in muted text;
  - "✓ {verifiedBy} · {date}", or, when `!runs`, "⚠ {problem}" in place of the tick;
  - for editors, Edit (`VerifiedDialog`: question, phrasings one per line, note; it sends `verified:save` with `id` and `base: tag`, and a 409 shows "Someone else changed this question. Reload to see it.") and Delete (`verified:delete`, toast "Moved to Trash").
- **States:** skeleton, `ErrorState` with Retry, and the empty state "No verified questions yet. A verified question is answered the team's way every time, by the app, without a model."
- **Old pods:** on a 404 from an old pod, the section shows its error state while Instructions still draws.

- [ ] **Step 1: Write the failing test** — `verified.test.tsx`:
  - two rows, one broken, show "⚠ 1 no longer runs" and its problem sentence;
  - Edit sends `verified:save` with `base`, and a 409 shows the sentence;
  - Delete sends `verified:delete`;
  - a viewer sees no Edit or Delete (negative control);
  - a hidden row (no `spec`) reads its question and "values hidden by row access rules".
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- verified` → module missing.
- [ ] **Step 3: Implement** — as in Interfaces. Use tokens only, in both themes.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run lint`, `npm --prefix web run size`.
- [ ] **Step 5: Commit** — `git add web/src/features/model/assistant` · "Show verified questions on the Assistant tab, with the ones that no longer run"

## Existing tests that must stay green

`test-verified`, `test-trash`, `test-editConflicts`, `test-bundle`, `test-answerFacts`, `test-askFollowUp`, `test-askDidYouMean`, `test-liveSafetyNet`, `test-liveRouteAnswers`, `test-modelOverview`, `test-rowPolicySafetyNet` (with `DATABASE_URL`), `test-server-boot`, `test-asyncReach`, `test-i18n`, `test-file-size`, `check-contracts`; web `TrashPage`, `didYouMean.test.tsx`, `assistant.test.tsx`, `model.test.tsx`, `freshness.test.tsx`; every `__golden__` fixture (never re-recorded).
