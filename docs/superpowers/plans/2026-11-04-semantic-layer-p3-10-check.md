# Semantic layer part 3, step 10: Check the Assistant — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor presses **Check the Assistant · 12 of 14** on the Assistant tab. The app asks the project's own model each working verified question once, leaving that question out of its own examples and match. It judges each reply's spec with 07's `judgeSpec` and shows which questions the Assistant gets right. It never asks more than 50 questions, and on Live it runs no warehouse query.
**Architecture:**
- **The run** goes on the in-process job queue, `src/app/jobs.ts` `submit` (`:223-258`). The Postgres runner in `src/server/jobs/` only runs recurring schedules: it has no enqueue and no result column, and adding them needs a migration (index call 1).
- **`verified:check`** submits the job and replies at once with a run id, so the 60 s RPC timeout never applies. The request's abort signal does not fire once its reply is written (`src/server/app.ts:358-364`).
- **The record.** The run writes its progress and result after every question to one project record, `projects/<id>/assistant-check.json` (`recordFs`, atomic), so any pod can read it.
- **A pod that dies mid-run** leaves a stale heartbeat, and readers then treat the run as stopped.
- **The web** re-reads the record when its own tab's `jobs:changed` and `jobs:finished` pushes arrive (`src/server/sse.ts:342-362`).

**Tech Stack:** `src/app/jobs.ts`, `src/ipc`, `recordFs`, zod contracts, React (`web/src/features/model/assistant/`), Vitest.
**Spec:** docs/semantic-layer/03-ai.md D13 (3); Q3 · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p3-00-index.md
**Branch and PR:** `feat/semantic-p3-10-check` off `origin/develop` after 09 merges, one PR to `develop`.

## Global Constraints

- **What is asked (Q3).**
  - Only working, visible questions (05's `verifiedStates`, as the starting editor), newest first, at most `CHECK_MAX = 50`.
  - Each is asked once, by its question text. Phrasings are live mode's (index call 15).
  - `skipped` counts the questions past the cap.
- **One run per project at a time.** A start is refused while the record says `running` and its `heartbeatAt` is less than `CHECK_STALE_MS = 120_000` old.
- **No model, no check.** `executionReady()` false refuses with a sentence, and the button is disabled with the same words. There is no model budget to charge (index call 2). The confirm dialog says what it costs: "This asks the model {n} questions, one each."
- **Each question goes through the same steps:**
  1. Facts: `buildFacts(projectId, {})`, the project inventory, built once per run. That is metadata, plus 04's index values.
  2. Guidance: `askGuidance(projectId, { kind: '' }, 'project', q.question, { exclude: q.id })`.
  3. The call: `askCopilot([], [facts.text, guided.text].filter(Boolean).join('\n\n'), q.question)`.
  4. A reply whose `suggestedAction.kind === 'answer'` goes to `judgeSpec(projectId, q, spec)`. Any other reply is `refused` with `checkNoChart()` or the model's error.

  On Live, `judgeSpec` compares specs only, and `refused` and `differs` are decided without the warehouse.
- **The record** (`CheckRun`):
  - `{ runId, state: 'running' | 'done' | 'stopped' | 'error', startedBy, startedAt, heartbeatAt, finishedAt?, total, asked, matched, skipped, results: { id, outcome, reason? }[], error? }`.
  - A cancel or a drain (`JobCancelled`, `interrupted`) writes `stopped`.
  - A throw writes `error` with its message, cut to 300 characters.
  - The record holds no spec, no figure and no prompt.
- **Access.**
  - `verified:check` is `write`.
  - `verified:checkResult` is `read`, REDACT. A caller `closedToCaller` on a result's dataset gets that result without `reason`, because a refusal can quote a value the model wrote.
  - Both are project-scoped.
- **The job kind.** `'assistant-check'` joins `JobKind` and `KINDS` (`src/app/jobs.ts:45-47,110-113`). The label is `t('Checking the Assistant')`, the job is `cancellable`, and the queue is per pod (`MAX_RUNNING` 3).
- Sentences go in `src/ipc/assistantCheckMessages.ts` (`MAIN_FILES`).
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **The RPC returns before the model calls finish.** → Task 1, with a gated stub.
- **Leave-one-out in every prompt.** A question's own text is never an example, and an exact hit never short-circuits the check, because `askCopilot` is called directly and never `copilot:ask`. → Task 1.
- **The cap and Live.** 55 questions ask 50. A Live question adds no `fake.calls`. → Task 1.
- **A dead pod's run** reads as `stopped` and does not block the next start. → Task 2.
- **A restricted reader of someone else's run** gets outcomes, and no reasons on a closed dataset. → Task 2, with the safety net.

## Rolling deploys

- **`assistant-check.json`:** a new file that older pods never read. It is in no bundle (`bundleRules.ts` has no rule for it, and export skips unknown names, `bundle.ts:203`).
- **The job kind:** it never leaves its pod.
- **A P3-A pod given `verified:check`:** it answers 404, and the button shows the server's error with Retry.

---

### Task 1: The run

**Files:**
- Create `src/ipc/assistantCheck.ts`, `src/ipc/assistantCheckMessages.ts` and `scripts/test-assistantCheck.ts`.
- Modify `src/app/jobs.ts:45-47,110-113` and `scripts/i18n-extract.ts`.

**Interfaces:** Consumes `verifiedStates` (05), `askGuidance` (03/06), `buildFacts`, `analyze.askCopilot`, `judgeSpec` (07), `jobs.submit`, `recordFs` and `osUser`. Produces:
```ts
export const CHECK_MAX = 50, CHECK_STALE_MS = 120_000;
export interface CheckRun { … as above }
export async function readCheck(projectId: string): Promise<CheckRun | null>; // a stale `running` reads as `stopped`
export async function startCheck(projectId: string): Promise<{ ok: true; runId: string; done: Promise<unknown> } | { ok: false; error: string }>;
// messages
checkNoModel() "Connect a model to check the Assistant."
checkRunning() "A check is already running for this project."
checkNothing() "There are no working verified questions to check."
checkNoChart() "The Assistant did not answer with a chart."
```
- [ ] **Step 1: Write the failing test** — `scripts/test-assistantCheck.ts`, with the temp dir harness of `test-verifiedAsk.ts`, the sample seeded, and `analyze.askCopilot` stubbed per question (Revenue → its exact spec; Profit → a wrong measure; Top 5 → prose only):
  ```ts
  let release!: () => void; const gate = new Promise<void>((r) => (release = r)); const prompts: string[] = [];
  (analyze as any).askCopilot = async (_p: unknown, facts: string, q: string) => { prompts.push(facts); await gate; return REPLY[q]; };
  const s = await C.startCheck(P);
  ok('it starts and replies before any answer', s.ok && (await C.readCheck(P))!.state === 'running');
  ok('a second start is refused while it runs', ((r) => !r.ok && r.error === msg.checkRunning())(await C.startCheck(P)));
  release(); await (s as any).done;
  const run = (await C.readCheck(P))!;
  ok('outcomes', run.state === 'done' && outcome(run, 'Revenue by region') === 'match' && outcome(run, 'Profit by category') === 'differs' && outcome(run, 'Top 5 states by revenue') === 'refused');
  ok('counts are the server\'s', run.total === 4 && run.asked === 4 && run.matched === 1);
  ok('leave-one-out in every prompt', SAMPLE_QUESTIONS.every((q, i) => !prompts[i].includes(`"${q}" →`)));
  ok('no figure and no spec in the record', !/"(labels|series|spec|measures)"/.test(rawCheck(P)));
  await plant(P, 55); ok('at most 50 a run', ((r) => r.asked === 50 && r.skipped > 0)(await runToEnd(P)));
  ok('Live: no warehouse statement', await noStatements(() => runToEnd(P_LIVE)));
  (execConfig as any).executionReady = async () => false; ok('no model, no check', ((r) => !r.ok && r.error === msg.checkNoModel())(await C.startCheck(P)));
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-assistantCheck.js` → module missing.
- [ ] **Step 3: Implement** — as in Interfaces:
  - Write the record before `submit`, then after each question with `heartbeatAt`, `asked` and `matched`.
  - Call `jc.checkCancelled()` between questions.
  - Report `jc.progress(asked / total)`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-assistantCheck.js`, `node scripts/test-jobs.js`, `node scripts/test-verifiedEval.js`, `node scripts/test-asyncReach.js`, `node scripts/test-i18n.js`.
- [ ] **Step 5: Commit** — `git add src/ipc/assistantCheck.ts src/ipc/assistantCheckMessages.ts src/app/jobs.ts scripts/i18n-extract.ts src/i18n/*.json scripts/test-assistantCheck.ts` · "Check the Assistant on the project's verified questions as a job, one model call each"

### Task 2: The two channels

**Files:**
- Modify:
  - `src/api/verified.ts` (05): append two contracts;
  - `src/ipc/verified.ts` (05): two handlers;
  - `scripts/rowPolicyReaders.ts`: `'verified:checkResult': 'REDACT', // reasons can quote a value`;
  - `scripts/columnAccessReaders.ts` (part 4 p4-06's `COLUMN_TREATMENT`, merged earlier in release B): `'verified:checkResult': 'REDACT'` (a result whose question names a hidden column comes without `reason`);
  - `scripts/test-rowPolicySafetyNet.ts`.
- Test: extend `scripts/test-assistantCheck.ts`.

**Interfaces:** Produces:
```ts
'verified:check':       rpc({ access: 'write', input: z.strictObject({ projectId: Uuid }), project: byProjectId }), // → { ok: true; runId } | { ok: false; error }
'verified:checkResult': rpc({ access: 'read',  input: z.strictObject({ projectId: Uuid }), project: byProjectId }), // → { ok: true; run: CheckRun | null }
```
- [ ] **Step 1: Write the failing test**
  - `test-assistantCheck.ts` §2:
    - `verified:check` returns `{ ok: true, runId }` while the stub is still gated;
    - `verified:checkResult` returns the same `runId`;
    - a record written `running` with `heartbeatAt` 3 minutes old reads `state: 'stopped'`, and a new start is allowed;
    - a viewer's `verified:check` is 403 before the handler runs.
  - `test-rowPolicySafetyNet.ts`: `boss` runs a check with a refused question on Orders whose reason quotes `${W_CANARY}_1`. Then:
    - `ok('redact: verified:checkResult — east reads outcomes, no reason', !H.leaks(east.text) && east.body.run.results.every((r) => !('reason' in r) || r.dataset !== ORDERS))`;
    - NEGATIVE CONTROL: the editor reads the reason.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-assistantCheck.js` → `No handler for verified:check`. `check-contracts` lists two unresolved.
- [ ] **Step 3: Implement** — as above. `checkResult` resolves each result's dataset from `verifiedStates` (05), using metadata only.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-assistantCheck.js`, `node scripts/check-contracts.js`, `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js`, `node scripts/test-server-boot.js`.
- [ ] **Step 5: Commit** — `git add src/api/verified.ts src/ipc/verified.ts scripts/rowPolicyReaders.ts scripts/test-rowPolicySafetyNet.ts scripts/test-assistantCheck.ts` · "Start a check of the Assistant and read its result from any pod"

### Task 3: The button and the per-question results

**Files:**
- Create `web/src/features/model/assistant/CheckAssistant.tsx` and `check.test.tsx`.
- Modify `VerifiedList.tsx` (05): the button in its head, and each row's result.
- Modify `api.ts`: `useCheckResult(projectId)`, key `['verified:checkResult', projectId]`.
- Modify part 1's `web/e2e/model.e2e.ts`.

**Interfaces:**
- **The button.** `CheckAssistant({ projectId, working })` is for editors only.
  - It reads "Check the Assistant", then "· {matched} of {total}" when a `done` run exists.
  - It confirms first: "Check the Assistant on {n} verified questions? It asks the model once per question (at most 50)." `n` is the server's count of working rows.
  - While running it reads "Checking… {asked} of {total}" with a spinner. It re-reads on `onServerEvent('jobs:changed')` and `'jobs:finished'`, with no polling.
  - With no model (`ai:status`) it is disabled with the title "Connect a model to check the Assistant."
  - A `stopped` or `error` run reads "The last check stopped before the end." with its `asked` count.
- **The rows.** Each `VerifiedList` row gets:
  - `match`: "✓ The Assistant gets this";
  - `differs`: "✗ The Assistant answers it differently";
  - `refused`: "✗ The Assistant could not answer it", with `reason` when present.

  A question added after the run shows nothing.

- [ ] **Step 1: Write the failing test** — `check.test.tsx`:
  - a `done` run `{ matched: 12, total: 14 }` reads "Check the Assistant · 12 of 14";
  - confirming posts `verified:check`;
  - a `running` run reads "Checking… 3 of 14" and refetches on a `jobs:changed` event;
  - row results read their sentences;
  - with `ai:status { ready: false }` the button is disabled with its title;
  - a viewer sees no button (negative control);
  - a 404 shows the error with Retry.

  `model.e2e.ts`, `data model: assistant`: with no model the button is disabled and shows its title. Shots are unchanged.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- check` → module missing.
- [ ] **Step 3: Implement** — as in Interfaces. Use tokens only, in both themes.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run build:web && npm --prefix web run e2e -- model`, `npm --prefix web run size`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/model/assistant web/e2e/model.e2e.ts` · "Show Check the Assistant and which verified questions it gets right"

## Existing tests that must stay green

`test-assistantCheck`, `test-jobs`, `test-verified`, `test-verifiedEval`, `test-verifiedAsk`, `test-rowPolicySafetyNet` (with `DATABASE_URL`), `test-server-boot`, `test-asyncReach`, `test-i18n`, `test-file-size`, `check-contracts`; web `verified.test.tsx`, `testChat.test.tsx`, `model.test.tsx`, `model.e2e.ts`; every `__golden__` fixture (never re-recorded).
