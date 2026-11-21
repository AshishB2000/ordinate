# Evaluation suites for the Assistant

Feature 5 of the 10 Lightdash-parity AI features. The owner's plan page is https://claude.ai/artifact/AG1ZHfz1g6tY3asUAGQQtm.
Four phases in one branch and one PR: thumbs, suites and cases, the batch run, the judge and the results page.

## What it is and why

A suite is a saved list of test questions for one Assistant (an agent, or the Project assistant). After an editor changes the
agent's instructions, its documents or its model, they press Run: every case goes through the real ask path and the app checks
what came back. **The engine checks every figure; a model never does.** A judge model only scores the words ("says that revenue is
net of refunds"), and only for cases that carry such words.

Lightdash's version: a list of prompts per agent, run as a batch, a second AI scoring each reply for correctness and relevance,
prompts pulled from real chats including thumbs-down ones. Ordinate differs on purpose: the expected answer is *what to compute*,
and the app compares the computed answer itself.

## Decided by the owner

1. **Q1: editors see the question text of a thumbs-down, never the answer.** A thumbs-down copies the question text, the agent and the
   reason into an editors' inbox. The person sees "Editors will see this question" **before** it is sent: pressing the thumbs-down
   opens a small panel (reason chips, the notice, Send); nothing is recorded until Send. A thumbs-up shares nothing (no question copy).
2. **Q2: the expected answer is *what to compute*, checked by the engine, plus optional words for the judge.** A case is a question and
   one of: a computed answer spec, "should refuse", or only words. Words may ride along with a spec.
3. **Q3: run by hand.** Plus a "Run tests" prompt on the agent's page after its instructions, documents or model change (the server
   compares a version stamp, below). Nothing runs by itself.
4. **Q4: a Judge model setting in Admin → AI**, defaulting to the Assistant's own model. The results page says which judged.

## Calls made in the plan (settled unless the owner objects)

- Results are split by access: every editor sees each case's pass, fail and score; reply text and figures only the person who ran it.
- A run never changes anything: no saved visuals, no History entry, no learning. Read-only apart from its own rows.
- Both sides computed now: the "same figure" check computes the expected spec and the answer's spec in the same run and compares with
  `Object.is`, so a data refresh cannot fail a correct answer.
- Editors and admins make suites and start runs. Viewers can thumbs up and down.
- Migration **0045** (this PR). Merge order: after the PR holding 0044 (Autopilot phase 1).

## Phase 1: thumbs

- Under every assistant answer (not a research card, not an out-of-scope reply): thumbs up, thumbs down. Down opens the panel with
  reason chips (Wrong number, Wrong data, Didn't answer, Other) and the notice; Send records it. A second press on the same thumb
  clears it. The state is on the turn (`feedback: { value, reason? }`, a sanitized key of the turn body, so it reloads with the
  conversation), and, with a database, a row in `assistant_feedback`.
- `feedback:rate` (access `read`: whoever may ask may rate, and only their own conversation's turn: the store acts on the caller's
  own threads, as `answer:saveVisual` does). The handler reads the question from the stored user turn before the answer; the browser
  never sends it. A thumbs-up row has no question copy; a thumbs-down row has the question text.
- **The table** `assistant_feedback` (0045), one row per rated turn, built for the issues board (#8) to count per project and week:
  `org_id, project_id, turn_id, thread_id, owner, agent_id, value, reason, question, created_at, updated_at, handled_at, handled_by`,
  index `(org_id, project_id, created_at)`. Never the answer text or a figure. Forced RLS on `ordinate.org`.
- **Retention:** when the conversation is deleted (the person, retention, a project clear) the per-org sweep sets `question` to null
  for its rows: the counts stay, the text goes with the conversation. A person who left the org: the same.
- **The inbox** (`feedback:inbox`, editors): thumbs-down rows of the project with a question, not handled: question, agent, reason, date.
  Not the asker. "Add to tests" makes a case from one (typed shape: question + what to say or refuse) and marks it handled;
  "Dismiss" marks it handled.
- **Desktop / file mode (no DATABASE_URL)** follows threads: the thumbs live on the turn in `copilot.json` and nothing else (no
  inbox, no suites: those need Postgres, as deep research does). The Tests section says so.

## Phase 2: suites and cases

- `eval_suites(org_id, project_id, id, name, agent_id null = Project assistant, created_by, created_at, updated_at)`.
- `eval_cases(org_id, project_id, suite_id, id, position, question, expect jsonb, source, created_by, created_at)`;
  `expect = { compute?: AnswerSpec, refuse?: true, say?: string }`, at least one, `compute` and `refuse` exclusive, `say` ≤ 500 chars.
  **At most 100 cases per suite** (counted under the suite row's lock; a 101st is refused with a sentence).
- Where cases come from:
  - a **verified question** (one click; its spec is the answer; its question and phrasings stay as they are);
  - **any answer you can see** ("Add to tests" on an answer card: the stored answer spec of the caller's own turn, with the question
    before it). Refused when the spec's dataset is in a folder closed to the caller;
  - the **thumbs-down inbox** (a typed-shape case: the question, plus what the editor says it should say or that it should refuse);
  - **typed**: a question and expected words, or "should refuse".
  A hand-typed *compute spec* has no UI in this version (see Open points).
- Access: every `eval:*` channel except the judge setting is `write` (editors and admins) on the project. An agent the caller may
  not use cannot own a suite they create. Suites are project-wide to its editors (like verified questions).
- Contracts in `src/api/evals.ts`, appended to `src/api/index.ts`. The reads are classified in `scripts/rowPolicyReaders.ts`,
  `scripts/columnAccessReaders.ts` and `scripts/folderReaders.ts`; `eval:caseFrom` and `eval:runStart` join the folder write net lists.

## Phase 3: the batch run

A run is a row in `eval_runs` claimed by any pod (`FOR UPDATE SKIP LOCKED`, lease, heartbeat, owner fence), as in deep research
(`src/server/research/`), under its own system scope `ordinate.evals_scope`. One run per project at a time (unique partial index on
`(org_id, project_id) WHERE state IN ('queued','running')`); at most 2 runs per pod. `case_ids` are snapshotted at start; a result
row is written per case, fenced by the lease, so a retake after a crash continues from the first case with no result and **never
re-asks a finished one**.

For each case, as the runner (`runInContext`, identity loaded fresh, `mayRun` re-checked before every case):

1. wait for the per-person model-call cap (`underBudget`, the one deep research uses: poll up to 60 s, then the run ends `partial`
   with code `limited`, resumable);
2. create a **throwaway conversation** with the suite's agent, marked hidden (below), and call the registered `copilot:ask`
   handler in it with `context.noSources` (as Slack and research do), under the Slack ask time limit joined to the lease;
3. read the stored turn, run the **checks**, call the judge when the case has words, store the result, **delete the conversation**
   (in a `finally`; the sweep deletes any left by a crash).

**Hidden conversation.** `copilot.createThread(projectId, agentId, { hidden: true })` titles the thread with a reserved marker
(`EVAL_THREAD_TITLE`); `copilotRows` leaves it out of `listThreads`, `listPage` and out of "the caller's latest" (`target()`),
unless it is named by id. So it is never in History, and a question the runner asks in another tab never lands in it.

**The checks** (pure, `src/ai/evalChecks.ts`; each is `{ id, ok, code? }`):

| Check | When | Passes when |
|---|---|---|
| `answered` | compute or refuse | compute: the turn has a computed answer (chart spec or SQL). refuse: it has none (a refusal, a "needs", a prose reply) |
| `question` | compute | the answer's spec is the expected spec's question: `sameChart` with chart type and title set equal (dataset, category, measures, split, filters, period, top, grain) |
| `figure` | compute | `computeCard(expected)` and `computeCard(answer)` both computed now, and their chart data are equal by `Object.is` leaf by leaf |
| `audit` | every case | the ask's number audit found no figure the engine did not compute |

An SQL answer fails `question` (an expected spec is a chart spec; an SQL answer is not comparable) and is reported as such.
A case passes only when every check that applies passes **and**, when it has words, the judge scored it ≥ 4.

**The judge** (`src/ai/evalJudge.ts`): one call per case with words: it gets the question, the reply text and the expected words, and
returns `{"score":1..5,"why":"..."}`. The parser is strict; a missing, non-integer, out-of-range or unreadable reply is `not_scored`,
**never a pass**. A case whose exact checks pass but whose judge is not scored is `not_scored` (neither pass nor fail). Outcomes:
`pass | fail | not_scored | error`. The judge model is the org's `Judge model` setting (`org_eval_settings`, Admin → AI), else the
agent's own model, else the runner's: its effective `provider/model` is recorded on the run, with a flag saying whether it was the
Assistant's own, and the results page says so. The judge call uses `analyze.dispatch` with `prose: true`, counts against the cap,
and sees reply text only (never a ledger or a figure beyond what the reply says).

**Model calls counted:** a case's ask is 1 call, 2 when it wrote SQL, 0 when a verified question answered it with no model; plus 1
for the judge. The run row holds the total (the "cost in model calls"). Live datasets: the ask and both `computeCard` calls go
through the live budget like any read.

**Version stamp.** At start the server records `version = { instructions, documents, model, topic }`: short hashes of the project's
and agent's instruction texts, of the project's and agent's document ids and edit times, the agent's model, and its topic id. A suite's
`stale` flag is true when its last finished run's stamp differs from now: that is the "Run tests" prompt. The comparison view says
which part changed ("Instructions changed").

**Stop and resume** as in deep research: stop is a flag read before every case (any editor may stop, it exposes nothing); a stop
ends the run `stopped`; `partial` (cap or 30-minute limit) and `failed` runs resume from their first unfinished case, with a fresh
time allowance, by the runner only. A retaken lease is handled as in research.

## Phase 4: the judge and the results page

- `eval:runGet`: per case: question, outcome, score, checks (pass/fail per check with a code), judged state; the run's counts,
  calls, state, version, judge label; and the **comparison with the previous finished run of the suite**: per case `better | worse |
  same | new`, and the totals ("3 better, 1 worse, 46 the same"). Rank is pass > not_scored > fail/error, then a higher judge
  score. The comparison is labelled when the judge model or the agent version differs.
- **What each viewer gets.** Everyone with write on the project: the above. Only `startedBy`: `reply` (the answer's words) and `why`
  (the judge's line), and only while no dataset the answer used is closed to them (`levelsOf`, the rule of `shows()`); `answerSpec`
  words for the case detail go to the runner only too. Never a ledger, a card or a figure beyond the reply text.
- Results page `/evals/:projectId/:runId` (appended to `routes.tsx`); the suites live in the Assistant tab of the Data model
  (Project assistant) and on each agent's page, as a "Tests" section, with the run card (cases done, passed, failed, model calls,
  Stop), the inbox, "Run tests" prompts, and the Judge model card in Admin → AI.

## Storage (migration 0045)

`assistant_feedback`, `eval_suites`, `eval_cases`, `eval_runs`, `eval_results`, `org_eval_settings`; forced RLS through
`current_setting('ordinate.org')`, plus `ordinate.evals_scope = 'system'` for the worker's claim and the sweeps (the shape of 0043).
`eval_results` keeps `reply` and `why` (runner-only on read) and the dataset ids the answer used; no ledger, no card, no row.
Additive only.

## Code map

- `src/ai/evalChecks.ts` (expect shape, `sameQuestion`, `sameFigures`, verdict, comparison), `src/ai/evalJudge.ts` (prompt, parser),
  `src/ai/feedback.ts` (the turn key's sanitizer).
- `src/server/evals/db.ts` (rows, lease, results), `suites.ts` (suites and cases), `feedback.ts`, `ask.ts` (one case's ask),
  `run.ts`, `worker.ts`, `sweep.ts`, `rpc.ts`, `version.ts`; `src/server/evalMessages.ts` (every server sentence, `t()`).
- Web: `web/src/features/assistant/Thumbs.tsx`, `web/src/features/model/assistant/tests/*` (suites section, inbox, add-to-tests
  dialog), `web/src/features/evals/ResultsPage.tsx`, `web/src/features/admin/JudgeModelCard.tsx`.

## Contracts (`src/api/evals.ts`)

`feedback:rate` (read), `feedback:inbox`, `feedback:dismiss`, `eval:suites`, `eval:suiteSave`, `eval:suiteDelete`, `eval:cases`,
`eval:caseSave`, `eval:caseDelete`, `eval:caseFrom`, `eval:runStart`, `eval:runGet`, `eval:runStop`, `eval:runResume`, `eval:runList`
(all `write`, scoped by project), `eval:judge` and `eval:setJudge` (admin, org). Every input a strict zod schema.

## Tests (each guard has a negative control)

- `test-evalChecks`: the checks, with a wrong dataset, a wrong filter and a made-up figure each failing, and a right one passing;
  `sameFigures` by `Object.is` (NaN equals NaN, -0 differs from 0); verdict and comparison.
- `test-evalJudge`: the parser (bad or missing score is not scored, never a pass; 0, 6, 3.5, "4", prose, two JSONs).
- `test-evalStore` (DB): forced RLS as an ordinary role; the 100-case cap; one run per project; the lease, heartbeat and fence; a
  late finish from an old owner applies nothing; the feedback table and its sweep.
- `test-evalAccess` (DB): viewers cannot create or run; another org sees nothing; reply text only for the runner; an inbox that never
  holds an answer; thumbs only on one's own turn.
- `test-evalRun` (DB): a scripted model; a case that passes, one that fails, one that should refuse; the wrong dataset, wrong
  filter and made-up figure fail; the throwaway conversation is gone and never listed; a crash retaken without re-asking; stop; the
  cap; the comparison with the previous run.
- Vitest for the thumbs, the Tests section, the results page and the judge card; Playwright `web/e2e/evals.e2e.ts` runs a 3-case suite.

## Open points

1. **No hand-typed compute spec.** The plan says "typed" cases; a compute spec is a structured object with no typed form in the
   product. Typed cases therefore carry words or "should refuse"; a compute expectation comes from a verified question or an answer.
   Safest reading that keeps the plan's intent (the engine checks figures).
2. **A verified question answers with no model**, word for word. A case made from one tests that path (the real ask), which is what
   people get; it costs no model call. Say so on the case ("Answered by a verified question").
3. **The cap's window is per minute per pod** (`underBudget`), so a 100-case run is paced, not refused.
