# Deep research for the Assistant

Feature 4 of the 10 Lightdash-parity AI features. Agreed with the owner on 2026-11-20. The explainer page
with the questions and answers is at https://claude.ai/artifact/TzzvdgsZy8pmFzHjZT5ezd.

## What it is and why

You ask one big question ("why did churn rise in the West last quarter?"). The Assistant breaks it into
small questions and the engine answers each one, one step at a time. After each computed result the model
chooses the next step or stops. Then it writes a report: findings around live charts, plus caveats. The
model only chooses steps and puts computed figures into words. **The engine computes every number**
(AGENTS.md core principle).

Lightdash's version (docs.lightdash.com/agents/deep-research):
- a background run with a progress card, Stop, and resume;
- default limits of 16 model steps, 24 tool calls, 15 warehouse queries and 10 minutes;
- a report document with chart-led findings and caveats;
- private to its creator until saved to a space;
- started only by developers and admins, and not available in Slack.

## Decided by the owner

1. **The report is a draft Story:** text plus live chart blocks. Ordinate's Stories already store chart
   ids, never figures (`src/analysis/storyModel.ts`).
2. **Editors and admins** may start a run (write access on the project). Viewers read reports once they
   have been added to the project.
3. **Private to its starter until "Add to project".** A finished report belongs to the run, and only its
   starter can open it. "Add to project" turns it into an ordinary Story with saved charts.
4. **Limits: 8 steps, 12 engine queries, 10 minutes.** An org admin can change them in Admin → AI,
   within hard ceilings. Stop works at any time.
5. **OPEN: what happens to the written findings on "Add to project".** The charts recompute for each
   viewer, under that viewer's access. The prose does not: it holds figures (and statements) computed
   under the *starter's* row rules, hidden columns and folders, and it goes stale beside live charts.
   This is the same problem as Slack's case A/B. Proposed (pick): keep the prose as written only when no
   cited step's dataset is restricted, using `restricted()` in `src/server/slack/check.ts` (row rules,
   column rules, a folder not open to everyone). Otherwise the Story gets the headings and the charts,
   and each section's prose is a fixed line saying the full text is in the starter's report. Either
   way, every section carries "Written on <date> from the data then". **Do not build before the owner
   answers.**

## Calls made in the design (shown to the owner as settled unless he objects)

- **What a step may do:** exactly what the person's Assistant can already do. That means an answer spec
  (`src/ai/answerSpec.ts`, computed by `computeCard` in `src/ipc/answers.ts`), a key-drivers request
  (`drivers:explain`, `src/ipc/drivers.ts`), and an `sql` answer (`src/ai/answerSql.ts`) only where the
  ask would allow that person one. Nothing new can compute a figure.
- **It runs as the starter:** their row rules, hidden columns, team folders, and the chosen agent's
  scope, instructions and (after feature 3) knowledge documents, through `askGuidance`. Access is
  re-read before every step. A starter who lost write access, or the project, stops the run.
- **Every written section goes through the number audit** against the ledgers of the steps it cites,
  plus the guidance ledger.
- **Any pod, survives a restart:** a run is a Postgres row with a lease and a heartbeat. A retake never
  re-runs a finished step.
- **Not in Slack, not over MCP**, in this version.
- **Built after feature 3 is pushed**, so two builders never share the one local Postgres and
  `node_modules` at the same time.
- **Saved charts land where Save as visual puts them.** "Add to project" saves each chart through
  `answer:saveVisual`'s path, so it lands with its dataset under the team-folder rules (D18). Each one
  is named `<report title> · <section heading>` so they group in lists. On the explainer page this was
  "a folder named after the report". A new folder would cut across the team-folder rule that a record
  follows its dataset, so that is dropped. Say so in the PR body.

## The run

States: `queued` → `running` → `writing` → `done`. Also `partial` (stopped by a limit or a failed
write with usable steps), `failed`, and `stopped` (by the user).

1. **Start.** The dock's composer gets a **Deep research** toggle, shown only to editors and admins (Q2)
   and only when AI is ready. A message sent with it on starts a run (`research:start`) in place of
   `copilot:ask`. The conversation gets a research turn that holds the run id, and that turn renders as
   the run card. The chosen agent is the conversation's agent, as for an ask.
2. **Plan.** One model call writes 3 to 6 sub-questions in words, shown on the run card. It uses the
   ask's facts for the question (`buildFacts` and the inventory) and the guidance block. The plan holds
   no figure.
3. **Steps, up to the step limit.** Each iteration is one model call. It receives the question, the
   plan, the guidance, and the facts of every step so far, each with its number and status. It returns
   exactly one action line:
   - `{"kind":"answer","spec":…}`, `{"kind":"sql",…}`, or `{"kind":"drivers","request":…}`. The app
     parses it with the existing whitelist parsers (`suggestedAction`, `answerSql`, the `DriversRequest`
     zod) and checks it with the existing gates. A rejected step is recorded with the app's reason and
     counts toward the step limit, but not toward the query limit. It is never repaired.
   - `{"kind":"done"}` ends the loop.

   An accepted step is computed by the engine and **counts as one query**. Its facts block and ledger
   are stored on the run (the facts the existing builders make: `answerFacts`, `driversFacts`), along
   with its spec, so the chart can be redrawn live. A step on a Live dataset goes through the live
   budget, like any other live read. A failed computation is recorded as a failed step.
4. **Write.** One model call receives every step's facts, numbered, and returns JSON:
   `{ title, summary, sections: [{ heading, text, steps: [n…] }], caveats: [string], conclusion }`.
   Validation:
   - Every cited step must be a computed step. An uncited or invalid one drops that citation.
   - At most 6 sections.
   - All text is cut to fixed lengths and kept on one line per paragraph.
   - **The audit:** each section's text is audited (`auditNumbers`) against the ledgers of the steps it
     cites. The summary and conclusion are audited against all steps. A violation adds the guard's note
     to that section, exactly as `guardAnswer` does. Caveats hold no figures, so a caveat with a
     figure-like token (`FIGURE_RE`) is dropped.
   - If the write call fails, the run ends `partial`, with the steps kept and a report made only of
     charts.
5. **Stop.** `research:stop` sets a flag on the row. The worker checks it before every model call and
   every step, and the step already running finishes first. The time limit is checked in the same
   places.
6. **Resume.** A `partial` or `failed` run can be resumed (`research:resume`). It continues from the
   stored steps, re-runs none of them, and gets a fresh time allowance. The step and query counts stay.

**The worker.** A run is a row in `research_runs`, claimed by any pod with `FOR UPDATE SKIP LOCKED` and
a lease plus heartbeat. The lease and fence work as in `src/server/jobs/runner.ts`, but the run does not
take that runner's single serial slot: a run lasts minutes. Each pod runs at most 2 runs at once. The
worker runs the run as its starter through the request context (`runInContext`, as the Slack worker
and reports do). It loads their identity fresh, with role, teams and the AI budget. Model calls count
against the person's AI budget, as asks do. A run past its lease after a crash is retaken by any pod.
Progress goes out over the existing push channel (SSE, `/api/events`) to the starter only.

**Code to follow.**
- A step's computation is `computeCard(projectId, spec)` in `src/ipc/answers.ts`. It returns `Built`:
  `{ card, factsText, ledger, provenance }` or a `Failure` with its reason. Store `factsText` and
  `ledger` per step, and drop the card. Drivers go through `src/ipc/drivers.ts` and their facts through
  `src/ai/driversFacts.ts`.
- Running as a person without a request: `src/server/slack/ask.ts` (`runInContext(who, requestId, …)`,
  `authorize()` on the contract and project first, the per-user budget, an `AbortController` time limit
  joined to the lease signal).
- The claim loop: `src/server/slack/worker.ts`.

**Cost per run:** at most 1 plan call + 8 step calls + 1 write call, and at most 12 engine queries.

## The research turn

- `research:start` appends ONE assistant turn to the conversation, after the user's question turn, with
  a new key, `research: { runId }`.
  - Add the key to the turn sanitizer (`normalizeTurns` / `appendTurn` in `src/ai/copilot.ts`), which
    keeps only known keys.
  - Its `text` is a fixed sentence with no figure ("Deep research on this question; the report opens
    from here").
  - When the run finishes, the run writes the turn's `factsFrom`: the dataset ids of every computed
    step. So `shows()` in `src/ipc/turnsOpen.ts` hides the turn, with its question, from a caller who
    cannot open one of them, as for any answer. Nothing else on the turn changes later.
- A later ask in the same conversation replays only that fixed sentence. The model never sees a step's
  facts through the replay.
- `turnsForBrowser` passes `research.runId` through. The card reads everything else from `research:get`.

## Limits (Admin → AI)

| Limit | Default | Ceiling |
|---|---|---|
| Steps (model calls in the loop) | 8 | 20 |
| Engine queries | 12 | 30 |
| Minutes | 10 | 30 |
| Runs at once per pod | 2 | not a setting |
| Running or queued runs per person | 1 | not a setting; a second start is refused with a sentence |

Store the limits with the org's AI settings in Postgres (`src/server/aiConfig.ts`). Only an org admin may
change them.

## The report

- **While private** (Q3), the run row holds the report: title, summary, sections (heading, text, and
  cited step numbers), caveats, conclusion, and every step with its spec, status and reason. The report
  page (`/research/<projectId>/<runId>`, appended to `routes.tsx`) draws each section's charts **live**:
  the browser asks for each step's card through the same server path `answer:card` uses, under the
  starter's access. The page shows a "How this was made" list of every step and its status. Only the
  starter can open the run, its report and its charts. Every `research:*` contract checks that the
  caller is the starter.
- **"Add to project"** (`research:addToProject`, write access) does three things:
  1. It saves each cited chart: an answer step through `answer:saveVisual`'s path, a drivers step
     through `drivers:addTile`'s path, and an sql step through the path the dock's Save uses for it,
     only if one exists. Otherwise the step stays out, with a caveat line.
  2. It creates a Story with `stories.saveStory`. The blocks are a text summary; then, per section, a
     text heading, its visual blocks and a text block for the prose; then the caveats as a `callout`
     (warning), a divider, and the conclusion. What prose goes in follows the owner's answer to
     question 5. The test of that rule is whether a viewer with different access can read a figure from
     the starter's view, never "no figure is stored".
  3. It records the story id on the run. A second press opens the same story, and never makes a second
     copy.

  From then on, the Story is an ordinary Story: folder rules, edits and sharing apply as usual. The run
  and its private report stay with the starter.
- **A run whose starter is removed from the org** is deleted by the per-org sweep. Runs older than 90
  days that were never added are deleted by the sweep too. The Story, once added, is not affected.

## Storage

**`0043_research.sql`**. Develop has 0041 (Slack); feature 3's branch adds 0042. **Merge order: #3, then
this.** The PR body says so, and develop is merged in after #3 lands.

- `research_runs`: `org_id`, `project_id`, `id` (uuid), `started_by`, `agent_id` (null for the
  default Assistant), `thread_id`, `question`, `state`, `plan jsonb`, `steps jsonb`, `report jsonb`,
  `story_id`, `stop_requested`, the counts (`steps_used`, `queries_used`), `started_at`,
  `deadline_at`, `finished_at`, `lease_owner`, `lease_until`, `error_code`.
- Forced RLS through `current_setting('ordinate.org')`, as 0041 and 0042 do. The worker's claim runs
  in a system scope, the way Slack's does.
- No figure is stored except inside step facts and ledgers, which never reach a browser. The report's
  charts are recomputed from specs.

## Contracts (`src/api/research.ts`, appended to `src/api/index.ts`)

| Channel | Access | What |
|---|---|---|
| `research:start` | write | `{ projectId, threadId?, agentId?, question }` → run id; refuses when AI is not ready, when one is already running for this person, or for a viewer |
| `research:get` | read | the run's state, plan, counts, steps (spec, status, reason; never facts or ledgers) and report; starter only |
| `research:stop` | write | starter only |
| `research:resume` | write | starter only; `partial` or `failed` runs only |
| `research:addToProject` | write | starter only; idempotent |
| `research:list` | read | the caller's own runs in a project (for History) |
| `research:limits` / `research:setLimits` | admin (org) | Admin → AI |

Every input is a strict zod schema. Classify the reads in `scripts/rowPolicyReaders.ts` and the
folder and column-access safety nets as feature 3 did. Server sentences go through `t()`.

## Screens

- **Composer:** the Deep research toggle with one line of help ("Runs several steps and writes a
  report. Up to 10 minutes."). It is disabled with a reason when AI is not ready or a run is in progress.
- **Run card** (in the conversation, live over push):
  - while running: the question, the plan, a step meter (step n of the limit, queries n of the limit,
    elapsed time), the step list (✓ done, ✗ refused or failed with its reason, … running), and
    **Stop research**;
  - when finished: **Open report**, or **Resume** for a partial or failed run.
- **Report page:** the title, the summary, and the sections with live charts (the existing answer card
  chart component) and prose. Caveats are in a warning callout. Then "How this was made", and **Add to
  project** (it becomes **Open story** once added). The page shows a "Only you can see this report"
  line until the report is added.
- **Admin → AI:** the three limits with their ceilings.
- Meet the polish bar: real empty and error states, light and dark, no centred boxes.

## Tests (every guard with a negative control)

- `test-researchLoop` (pure, fake deps):
  - the state machine;
  - limits stop the loop at exactly 8 steps or 12 queries, and a rejected step counts toward steps but
    not queries;
  - `done` ends the loop;
  - stop before the next model call;
  - the deadline;
  - resume re-runs no finished step.
- `test-researchActions`: the action-line parser takes each of the three kinds plus `done`, and refuses
  anything else, two actions, prose, or a figure where a name goes.
- `test-researchWrite`: report validation; each section audited against its cited steps only (a figure
  from an uncited step gets the note); caveats with figures dropped; a failed write gives a `partial`
  charts-only report.
- `test-researchStore` (DB): forced RLS as an ordinary role (the `notifyHarness.ordinaryRole`
  pattern: a password, a per-pid role); the lease, the heartbeat and the fence (a retake after an
  expired lease, and a late finish from the old owner applies nothing); 2 runs per pod; 1 per person;
  the sweep.
- `test-researchAccess` (DB): a viewer cannot start one; another user cannot get, stop, resume or add
  someone else's run; an agent the starter may not use is refused; a run whose starter lost write
  access stops at the next step.
- `test-researchRun`: an end-to-end run through the real `computeCard` and drivers with a stub
  provider scripted step by step. It writes a report and adds it to the project: the visuals are saved,
  the Story blocks point at them, and the question-5 rule holds (a restricted dataset's figures never
  reach the Story's prose; an unrestricted one's prose carries its date). Also: a second Add to project is
  the same story, and a crash mid-run is retaken on "another pod" (a second worker instance) without
  repeating finished steps.
- Vitest for the toggle, the run card states, the report page and the admin limits.
- Playwright `web/e2e/research.e2e.ts`: start a run with the stub provider, watch the card advance,
  stop one run, open the report of another, add it to the project, and open the Story.
- The full gates: build, lint, contracts, `npm test` with and without a database, `test:web`, web
  build and size, the new e2e plus `dock` and `home`.

## Not in this version

- Slack and MCP.
- Steps that build data (prepare steps, calculated fields).
- Follow-up questions that update a report (Lightdash has the same gap).
- Org admins reading other people's private runs.
- Scheduling a research run.
