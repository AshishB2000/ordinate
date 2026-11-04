# Semantic layer part 3, step 06: Exact matches, verified examples and chips — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A question typed exactly as a verified question or one of its phrasings is answered by the app, with no model call deciding anything. That holds with no model connected too. Any other question sends up to 5 verified questions to the model as examples. The empty dock and Home's ask bar offer up to 4 as chips, which run with no model. With no model, the rest are told "Connect a model to ask anything else."
**Architecture:**
- **Picking (pure).** `src/ai/verifiedPick.ts` decides the exact hit and ranks the examples. The ranking reuses `answerSuggest`'s `words` (`src/ai/answerSuggest.ts:39`, now exported).
- **The exact hit.** `src/ipc/verifiedAsk.ts` runs before `buildFacts` in `copilot:ask`, as one hook line. It draws the hit with `computeCard`, narrates it only when a model is ready (`narrate`, exported from `answers.ts`), and stores the turn with its spec (`appendAnswer`, exported).
- **Examples.** They join 03's block through `askGuidance(…, question)`.
- **The reply.** It gains `guidance` (ids and counts). Storing it on the turn is 08's.
- **The web.** The dock and Home read `verified:list` (05) for chips. The dock's composer is enabled when the project has a working verified question, even with no model.

**Tech Stack:** `src/ai`, `src/ipc`, React (`web/src/features/assistant/`, `web/src/features/home/`), Vitest, Playwright.
**Spec:** docs/semantic-layer/03-ai.md D5, D8, D10; Q2 · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p3-00-index.md
**Branch and PR:** `feat/semantic-p3-06-exact-match` off `origin/develop` after 05 merges, one PR to `develop`.

## Global Constraints

- **Exact only (D8).** A hit is a working (`problem === null`), not hidden (D5) question whose `questionKey` equals the asked question's key, or one of whose phrasings' keys does. "Revenue by region?" and "revenue BY region" are the same question. "revenue by region last year" is a different one.
- **What a hit does.**
  - It never calls `askCopilot` to decide a spec. `narrate` calls it only when `executionReady()` is true, as `answer:rerun` already does (`src/ipc/answers.ts:227-232,476-492`).
  - A hit whose card fails (for example a Live outage) answers `{ ok: false, error: reason }`. The thread is left unchanged, and the question does not fall through to the model, because a model's guess at a verified question is worse than the reason.
- **Examples (D10, D15).**
  - At most 5. A line over 600 characters is skipped, and lines stop before 3,000 characters in all.
  - The order is: the context's dataset first, then the most shared `words` with the question, then the newest `updatedAt`.
  - Only working and visible questions. A question whose spec has a value filter on a column in `withheldColumns` (personal or financial) is never an example.
  - Each example prints inside the fence as `- "<question>" → <spec>`. Both sides go through `promptJson` (01), and the spec is written by name in the action line's shape (`src/ai/suggestedAction.ts:192-196`): dataset name, column names, `{"term":"<name>"}`, `chartType`, `top`, `grain`. A filter value is a value the editor verified, and its digits are banked like the rest of the block.
- **Chips (D10).**
  - Up to 4: the first rows of `verified:list { projectId, datasetId: <context dataset> }` that have `runs` and a `spec`.
  - A click calls `answer:rerun { spec, label: question, threadId }`. That call always passes the shown thread, because without it the server picks the most recent one (`src/ai/copilot.ts:459`).
- **No model (Q2).**
  - The dock's composer is `usable` when `pid && enabled && !pending && (ready || chips.length > 0)`.
  - With no model, the placeholder reads "Ask a verified question, or connect a model to ask anything else."
  - A `notReady` reply shows the hint "Connect a model to ask anything else.", keeps the text, and still invalidates `['ai:status']`.
  - The Assistant switched off (`copilotEnabled === false`) still disables everything.
- `src/ipc/copilot.ts` gets 2 lines: the hook after `:502`, and `guidance` in the reply at `:566-576`. `src/ipc/answers.ts` gets `export` on `narrate` and `appendAnswer`. `web/src/features/assistant/Dock.tsx` (412 lines) gets at most +15, and the chips go in a new file.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A near miss answered as verified.** → Task 2, which pins "…last year" going to the model and a missing phrasing not matching.
- **A model reached on a match**, or a model needed for one. → Task 2 spies `analyze.askCopilot` and `analyze.dispatch`, with `executionReady → false`.
- **A restricted viewer answered, offered or shown a value-filtered question.** → Task 2 and Task 3, with safety-net cases.
- **Leave-one-out works** (07 relies on it). `opts.exclude` removes a question from the match and from the examples alike. → Tasks 1, 3.
- **The no-model dock doesn't become a broken dock.** With no verified questions it is exactly today's disabled state. → Task 4, negative control.

## Rolling deploys

Nothing new is stored: turns hold the spec as answers already do. A P3-A pod given a P3-B browser's question answers it the old way, so with no model it returns `notReady` and the hint shows. Its `verified:list` 404s, so no chips show.

---

### Task 1: Picking — the exact hit and the examples (pure)

**Files:**
- Create `src/ai/verifiedPick.ts` and `scripts/test-verifiedPick.ts`.
- Modify `src/ai/answerSuggest.ts:39`: `export const words`.

**Interfaces:** Consumes `VerifiedState` (05), `questionKey`, `hasValueFilter`, `promptJson`, `words`. Produces:
```ts
export const MAX_EXAMPLES = 5, EXAMPLE_MAX = 600, EXAMPLES_BLOCK_MAX = 3000;
export function exactHit(states: VerifiedState[], question: string, exclude?: string): VerifiedQuestion | null;
export interface Names { dataset: (id: string) => string; term: (id: string) => string }
export function rawSpec(spec: AnswerSpec, names: Names): Record<string, unknown>;
export function pickExamples(states: VerifiedState[], o: { question: string; datasetId?: string; exclude?: string; withheld: (datasetId: string) => ReadonlySet<string>; names: Names }): { lines: string[]; ids: string[] };
```
- [ ] **Step 1: Write the failing test** — `scripts/test-verifiedPick.ts`:
  ```ts
  ok('exact, squashed', P.exactHit(S, 'revenue BY region?')?.id === REV);
  ok('a phrasing matches', P.exactHit(S, 'Revenue per region')?.id === REV);
  ok('a near miss does not', P.exactHit(S, 'revenue by region last year') === null);
  ok('broken or hidden never match', P.exactHit([{ ...S[0], problem: 'x' }], 'Revenue by region') === null && P.exactHit([{ ...S[0], hidden: true }], 'Revenue by region') === null);
  ok('leave-one-out', P.exactHit(S, 'Revenue by region', REV) === null);
  const ex = P.pickExamples(S, { question: 'profit by region', datasetId: ORDERS, withheld: () => new Set(['email']), names: N });
  ok('context dataset first, then shared words', ex.ids[0] === REV_ORDERS && ex.ids.indexOf(PROFIT_OTHER_DS) > ex.ids.indexOf(REV_ORDERS));
  ok('the action-line shape, by name', ex.lines[0] === '- "Revenue by region" → {"dataset":"Orders","category":"region","measures":[{"column":"net_amount","aggregation":"sum"}],"filters":[{"column":"order_date","period":"last_quarter"}],"chartType":"column"}');
  ok('a term is written by its name', ex.lines.some((l) => l.includes('{"term":"EMEA"}')));
  ok('caps: 5, 600 each, 3,000 in all', ex.ids.length <= 5 && ex.lines.every((l) => l.length <= 600) && ex.lines.join('\n').length <= 3000);
  ok('a withheld column\'s value filter is never an example', !ex.ids.includes(BY_EMAIL));
  ok('exclude removes it from the examples too', !P.pickExamples(S, { question: 'x', exclude: REV_ORDERS, withheld: () => new Set(), names: N }).ids.includes(REV_ORDERS));
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-verifiedPick.js` → module missing.
- [ ] **Step 3: Implement** — as in Interfaces. A tie on shared words goes to `updatedAt`, newest first, then to `id`, so the order is stable.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verifiedPick.js`, `node scripts/test-askDidYouMean.js` (`words` unchanged).
- [ ] **Step 5: Commit** — `git add src/ai/verifiedPick.ts src/ai/answerSuggest.ts scripts/test-verifiedPick.ts` · "Pick a verified question by exact wording, and rank examples for the rest"

### Task 2: An exact match answers without a model

**Files:**
- Create `src/ipc/verifiedAsk.ts` and `scripts/test-verifiedAsk.ts` (the `test-askFollowUp.ts` harness: `handlers`, the stubbed `analyze.askCopilot` and `execConfig.executionReady`).
- Modify:
  - `src/ipc/copilot.ts`: after `:502`, `const hit = await verifiedAsk(projectId, context || {}, q, tid, guardAnswer); if (hit) return hit;`;
  - `src/ipc/answers.ts:227,393`: `export` on `narrate` and `appendAnswer`;
  - `scripts/test-rowPolicySafetyNet.ts`.

**Interfaces:** Produces:
```ts
export async function verifiedAsk(projectId: string, context: { kind?: string; id?: string }, question: string, threadId: string | undefined, guard: Guard):
  Promise<null | { ok: false; error: string } | { ok: true; answer: string; provenance: CopilotProvenance; turns: CopilotTurn[]; threadId: string | null;
    suggestedAction: SuggestedAction; ledger: LedgerEntry[]; numberAudit: NumberAudit; guidance: TurnGuidance }>;
```
It reads `verifiedStates` (05), metadata only. Then:
1. `exactHit`.
2. `computeCard(projectId, hit.spec)`.
3. `narrate(projectId, built, …, guard)`.
4. `appendAnswer(projectId, threadId, question, text, built, built.card.spec)`.

The reply has `guidance: { verifiedId: hit.id, instructions: 0, examples: [] }`, and `suggestedAction` is `NO_ACTION`.

- [ ] **Step 1: Write the failing test** — `scripts/test-verifiedAsk.ts`:
  ```ts
  let calls = 0; (analyze as any).askCopilot = async () => { calls++; return { ok: false, errorType: 'not_ready' }; }; (analyze as any).dispatch = async () => { calls++; throw new Error('no model'); };
  (execConfig as any).executionReady = async () => false;
  const r = await ask(P, { kind: '' }, 'revenue by region?');
  ok('no model, exact match: answered by the app', r.ok && r.guidance.verifiedId === V && calls === 0);
  ok('the turn stores the verified spec', sameChart(r.turns.at(-1).answer, VSPEC));
  ok('control: "…last year" goes to the model', (await ask(P, { kind: '' }, 'revenue by region last year')).notReady === true && calls === 1);
  await reimportWithout(P, D, 'region');
  ok('broken: not matched', (await ask(P, { kind: '' }, 'Revenue by region')).notReady === true);
  (execConfig as any).executionReady = async () => true; (analyze as any).askCopilot = async () => ({ ok: true, text: 'West leads.', suggestedAction: NONE });
  ok('a model narrates a hit, but never picks it', (await ask(P, { kind: '' }, 'Revenue by region')).answer === 'West leads.');
  ```
  In `test-rowPolicySafetyNet.ts`, with the "West customers" question (value filter on Orders) and the model stubbed to `not_ready`:
  - `ok('explicit: east is not answered by a value-filtered verified question', (await eastAsk('West customers')).notReady === true)`;
  - NEGATIVE CONTROL: the editor's ask is answered with `guidance.verifiedId`.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-verifiedAsk.js` → `FAIL no model, exact match: answered by the app`.
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verifiedAsk.js`, `node scripts/test-askFollowUp.js`, `node scripts/test-ask-activity.js`, `node scripts/test-copilot.js`, `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js`.
- [ ] **Step 5: Commit** — `git add src/ipc/verifiedAsk.ts src/ipc/copilot.ts src/ipc/answers.ts scripts/test-verifiedAsk.ts scripts/test-rowPolicySafetyNet.ts` · "Answer a verified question asked word for word, with or without a model"

### Task 3: Verified examples in the guidance block

**Files:**
- Modify:
  - `src/ai/guidanceFacts.ts` (03): `GuidanceInput.examples?: string[]`, printed after the instructions and guides, under the line "Verified questions — when a question means one of these, answer with its spec:";
  - `src/ipc/guidance.ts` (03): `askGuidance` picks with `question`, `context` and `opts.exclude`, and `used.examples = ids`;
  - `src/ipc/copilot.ts:566-576`: `guidance: guided.used` in the reply.
- Test: extend `scripts/test-verifiedAsk.ts` and `scripts/test-guidance.ts`.

**Interfaces:** Consumes `pickExamples`, `verifiedStates`, `withheldColumns`. `askGuidance`'s signature is unchanged from 03.

- [ ] **Step 1: Write the failing test**
  - `test-verifiedAsk.ts`, with the model stub capturing facts:
    - "profit by region" carries `Verified questions — when a question means one of these` and `"Revenue by region" → {"dataset":"Orders"`, inside `<<<GUIDANCE`…`GUIDANCE`;
    - `reply.guidance.examples` is the printed ids, and `instructions` is the count;
    - with no verified questions the prompt equals 03's (`Object.is`).
  - `test-guidance.ts`: digits in an example's filter value are banked, and `sealLedger` adds 0.
  - `test-rowPolicySafetyNet.ts`: east's captured prompt holds no `W_CANARY` example. NEGATIVE CONTROL: the editor's does.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-verifiedAsk.js` → `FAIL examples reach the model`.
- [ ] **Step 3: Implement** — as above.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verifiedAsk.js`, `node scripts/test-guidance.js`, `node scripts/test-numberAudit.js`, `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js`.
- [ ] **Step 5: Commit** — `git add src/ai/guidanceFacts.ts src/ipc/guidance.ts src/ipc/copilot.ts scripts/test-verifiedAsk.ts scripts/test-guidance.ts scripts/test-rowPolicySafetyNet.ts` · "Show the model the team's verified questions as examples"

### Task 4: Chips in the dock and on Home, and asking with no model

**Files:**
- Create `web/src/features/assistant/VerifiedChips.tsx`.
- Modify:
  - `web/src/features/assistant/api.ts`: `useVerifiedChips(projectId, datasetId?)`, the first 4 rows with `runs && spec`;
  - `web/src/features/assistant/Dock.tsx`:
    - `:92-94`: `usable`;
    - `:249`: the `notReady` hint;
    - `:273-277`: the placeholder;
    - `:367-384`: `<VerifiedChips>` above the starter prompts, each chip running `followUp(spec, question)`;
  - `web/src/features/assistant/dockState.ts:70-108`: `openDockWithSpec({ projectId, spec, label })` and `takePendingSpec()`, beside `openDockWith`;
  - `Dock.tsx:150-163`: take a pending spec on open and run it;
  - `web/src/features/home/AskBar.tsx:91,112` and `web/src/features/home/HomePage.tsx:72-89`: chips show with or without a model, and a click calls `openDockWithSpec`.
- Test: `assistant.test.tsx`, `HomePage.test.tsx` and `web/e2e/dock.e2e.ts` (the no-`DATABASE_URL` mode).

**Interfaces:** Produces:
- `VerifiedChips({ chips, onPick })`: the caption "Verified answers", and one button per chip reading `✓ {question}`.
- `useVerifiedChips`: key `['verified:list', pid, datasetId ?? '']`. A 404 (old pod) or an error yields `[]` without an error state, because the chips are an extra.

- [ ] **Step 1: Write the failing test**
  - `assistant.test.tsx`, with `ai:status { ready: false }` and `verified:list` holding one working row with a spec:
    - the composer is enabled, and its placeholder reads "Ask a verified question, or connect a model to ask anything else.";
    - the chip "✓ Revenue by region" posts `answer:rerun` with `{ spec, label: 'Revenue by region', threadId }`;
    - a typed question answered `{ ok: false, notReady: true }` shows "Connect a model to ask anything else." and keeps the text;
    - NEGATIVE CONTROL: with `verified:list → []` the composer is disabled and the notice is today's `AiNotReady`.
  - `HomePage.test.tsx`: with no model, the chip shows, and clicking it opens the dock, which posts `answer:rerun`.
  - `dock.e2e.ts`, test `dock: a verified question answers with no model`:
    1. `verified:save` "Revenue by region" over the sample (by RPC).
    2. Open the dock: the chip shows. Click it: the card with "✓ Verified" shows.
    3. Type "revenue by region": a second card shows.
    4. Type "revenue by state": the hint shows.
    5. Take the shots `dock-verified` (light and dark). The RPC budget stays within 25.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- assistant HomePage` → `Unable to find role "button" with name "✓ Revenue by region"`.
- [ ] **Step 3: Implement** — as in Files and Interfaces.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run build:web && npm --prefix web run e2e -- dock home`, `npm --prefix web run size`, `npm run lint`. Look at `web/e2e/__screens__/dock-verified-*`.
- [ ] **Step 5: Commit** — `git add web/src/features/assistant web/src/features/home web/e2e/dock.e2e.ts` · "Offer verified answers as chips in the dock and on Home, with or without a model"

## Existing tests that must stay green

`test-verifiedPick`, `test-verifiedAsk`, `test-verified`, `test-guidance`, `test-copilot`, `test-askFollowUp`, `test-askDidYouMean`, `test-askRemember`, `test-ask-activity`, `test-numberAudit`, `test-number-fidelity`, `test-liveRouteAnswers`, `test-rowPolicySafetyNet` (with `DATABASE_URL`), `test-asyncReach`, `test-file-size`; web `assistant.test.tsx`, `didYouMean.test.tsx`, `dockRoute.test.tsx`, `dockScreens.test.tsx`, `HomePage.test.tsx`, `dock.e2e.ts`, `home.e2e.ts`; every `__golden__` fixture (never re-recorded).
