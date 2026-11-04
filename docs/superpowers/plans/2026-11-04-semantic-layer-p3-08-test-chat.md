# Semantic layer part 3, step 08: The test chat and Save as verified — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Data model's Assistant tab, an editor tries questions in their own "Data model test" conversation. Beside each answer it says **how it was answered**: a verified question with no model call, or the model with N instructions and which examples. It also gives the spec in words, and its JSON folded. **Save as verified** turns a good answer into a verified question. The same button then joins answer cards in the dock.
**Architecture:**
- **Server.** The only server change is storing the `guidance` the reply already carries (06) on the assistant turn, so a reload still says how it answered. 02 shipped the reader, so P3-A pods keep the field.
- **Web.** The test chat is a new component over the existing pieces: `useHistory`, `Transcript` (`web/src/features/assistant/Transcript.tsx:66`, which gains an optional `aside`), `ask()` (`assistant/api.ts:183`) and `answer:rerun`. Its thread is found by title through the existing `copilot:threads`, `copilot:newThread` and `copilot:renameThread`, with no new channel.
- **Save as verified** sends a turn's stored spec and its question to `verified:save` (05). There is no hand-edited JSON. A wrong answer is fixed with a follow-up first, then saved.

**Tech Stack:** `src/ipc/copilot.ts`, `src/ipc/answers.ts`, `src/ipc/verifiedAsk.ts`; React (`web/src/features/model/assistant/`, `web/src/features/assistant/`), Vitest, Playwright.
**Spec:** docs/semantic-layer/03-ai.md D11; Q1, Q2 · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p3-00-index.md
**Branch and PR:** `feat/semantic-p3-08-test-chat` off `origin/develop` after 07 merges, one PR to `develop`.

## Global Constraints

- **Who sees the test chat.** Editors only (`useCanEdit(projectId)`), because it is "the editor's own thread". Viewers see Instructions and Verified questions. A viewer's tab makes no `copilot:*` call (asserted).
- **The thread.**
  - It is the caller's thread titled exactly `Data model test`.
  - It is created lazily, on the first ask: `copilot:newThread`, then `copilot:renameThread`. Opening the tab never writes.
  - If it is renamed, the next ask makes a new one.
  - It shows in the dock's thread list, like any thread (index call 8).
- **Asking.** `copilot:ask { context: { kind: '' }, threadId }` is the project context, the same facts Home's ask bar gets.
  - The composer is usable on the dock's rule (06): a model, or at least one working verified question. Otherwise it reads "Connect a model to try questions."
  - Chips and "Did you mean" go through `answer:rerun` with the test thread's id.
- **"How it was answered"** is worded by the web from `turn.guidance`, which holds ids and counts only:
  - with `verifiedId`: "A verified question — no model call." It is followed by that question's text, from `verified:list`, or "a verified question since removed".
  - with no `verifiedId`: "The model, with {n} instructions and {k} verified examples." It is followed by the examples' questions, read from `verified:list` by id.
  - with no `guidance` (a chip, a follow-up, or an older turn): nothing.
- **The spec in words** (dataset · measures · by · split · filters · period · top) comes from a pure web helper over the stored spec. These are words, not figures. The folded JSON is `JSON.stringify(turn.answer, null, 2)` in a `<details>`. It is the editor's own turn, and the browser already holds it.
- **Save as verified.**
  - Editors only. The question is prefilled with the turn's preceding user text (≤ 300). Phrasings are entered one per line, and a note is optional.
  - The server's refusal sentence shows in the dialog and keeps the input.
  - It is hidden on a card that already carries `verified` (05's mark).
- `src/ipc/copilot.ts` gets +1 line and `src/ipc/answers.ts` gets +1 line (`appendAnswer`'s optional `guidance`). `web/src/features/assistant/AnswerCard.tsx` (200 lines) gets +6 lines, and `Transcript.tsx` (124 lines) gets +4 lines.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A reload loses "how".** The stored turn carries `guidance` through `copilot:history`. → Task 1.
- **The test chat leaks into nobody else's view.** Threads are per owner (`src/ai/copilot.ts:341`). A second editor's tab shows their own thread, or none. → Task 2.
- **Save as verified saves what was drawn.** It sends the stored spec of that turn, never a client-edited one. The server re-validates and draws it anyway (05). → Task 3.
- **The RPC budget of the Data model page.** The Assistant tab adds `catalog:instructions`, `verified:list`, `copilot:threads` and, once there is a thread, `copilot:history`. → Task 4 asserts it is still within 25.

## Rolling deploys

`CopilotTurn.guidance` is kept by every P3-A pod (02 Task 2). A P3-A pod given a P3-B ask stores no `guidance`, so that turn shows no "how" line. That is cosmetic.

---

### Task 1: Store how an answer was guided on its turn

**Files:**
- Modify `src/ipc/copilot.ts:553-560`: add `guidance: guided.used` to the assistant turn.
- Modify `src/ipc/answers.ts:393-401`: `appendAnswer(…, learn?, guidance?)` passes it to the assistant turn.
- Modify `src/ipc/verifiedAsk.ts` (06): pass `{ verifiedId, instructions: 0, examples: [] }`.
- Modify `web/src/features/assistant/api.ts:54-68`: `Turn.guidance?`.
- Test: extend `scripts/test-verifiedAsk.ts`.

**Interfaces:** `NewCopilotTurn.guidance` (02). There is no new export.

- [ ] **Step 1: Write the failing test**
  ```ts
  await ask(P, { kind: '' }, 'Revenue by region', T);
  ok('a verified answer remembers how', (await call('copilot:history', { projectId: P, threadId: T })).turns.at(-1).guidance.verifiedId === V);
  await askWithModel(P, { kind: '' }, 'profit by state', T);
  ok('a model answer remembers its counts and examples', ((g) => g.instructions === 3 && g.examples.length > 0 && !('verifiedId' in g))((await history(P, T)).turns.at(-1).guidance));
  ok('a chip rerun stores none', !('guidance' in (await rerun(P, T, SPEC)).turns.at(-1)));
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-verifiedAsk.js` → `FAIL a verified answer remembers how`.
- [ ] **Step 3: Implement** — as in Files.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-verifiedAsk.js`, `node scripts/test-copilot-threads.js`, `node scripts/test-askFollowUp.js`.
- [ ] **Step 5: Commit** — `git add src/ipc/copilot.ts src/ipc/answers.ts src/ipc/verifiedAsk.ts web/src/features/assistant/api.ts scripts/test-verifiedAsk.ts` · "Keep how each Assistant answer was guided on its turn"

### Task 2: The test chat

**Files:**
- Create in `web/src/features/model/assistant/`: `TestChat.tsx`, `HowAnswered.tsx`, `specWords.ts`, `testChat.test.tsx`.
- Modify `AssistantTab.tsx` (03). It gets a third section, "Try a question", for editors.
- Modify `web/src/features/assistant/Transcript.tsx:66-102`: an optional `aside?: (t: Turn, asked?: Turn) => ReactNode`, rendered after the provenance line.

**Interfaces:** Produces:
- `specWords(spec, datasetName): string`. For example, "Orders · sum of net_amount by region · split by channel · order_date last quarter · top 5". A term reads as its name when the glossary is loaded, else "a glossary term".
- `TestChat({ projectId })`:
  - **Reading:** `copilot:threads`, then `useHistory(projectId, testThreadId)`.
  - **Asking:** a one-line `Textarea` with an Ask button. It sends `ask(projectId, { kind: '' }, q, tid, askId)`, shows a pending bubble, and on `notReady` shows "Connect a model to ask anything else." and keeps the text.
  - **Clearing:** "Clear" calls `copilot:deleteThread` on the test thread after a confirm.
  - **States:** a skeleton, an `ErrorState` with Retry, and the empty state "Ask the way your team does. Each answer says how it was found, and a good one can be saved as verified."
- `HowAnswered({ turn, asked, verified })`: the lines in Global Constraints, then "Spec: {specWords}", then `<details><summary>Spec as JSON</summary>`.

- [ ] **Step 1: Write the failing test** — `testChat.test.tsx`:
  - An editor's tab shows "Try a question".
  - A first ask posts `copilot:newThread`, then `copilot:renameThread { title: 'Data model test' }`, then `copilot:ask` with that `threadId`.
  - With an existing thread of that title, no `newThread` call is made.
  - A turn with `guidance.verifiedId` reads "A verified question — no model call." and the question text.
  - A turn with `{ instructions: 3, examples: [E] }` reads "The model, with 3 instructions and 1 verified examples." followed by E's question.
  - "Spec: Orders · sum of net_amount by region" shows, and the JSON is folded.
  - A viewer sees no "Try a question" and makes no `copilot:` call (negative control).
  - `notReady` shows the hint.
  - `specWords` is unit-tested over periods, `in`, a term and `top`.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- testChat` → module missing.
- [ ] **Step 3: Implement** — as in Interfaces. Use tokens only, in both themes. Under 900 px the aside stacks under the answer.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web -- testChat assistant didYouMean`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add web/src/features/model/assistant web/src/features/assistant/Transcript.tsx` · "Try questions on the Data model page and see how each was answered"

### Task 3: Save as verified, in the test chat and on dock cards

**Files:**
- Create `web/src/features/assistant/SaveAsVerified.tsx` and `web/src/features/assistant/saveAsVerified.test.tsx`.
- Modify:
  - `web/src/features/assistant/AnswerCard.tsx`: a `question?: string` prop, and the button in the actions row beside `SaveAsVisual` (`:170-178`), hidden when `card.verified`;
  - `Transcript.tsx`: pass `question` as the preceding user turn's text;
  - `HowAnswered.tsx`: the same button;
  - `VerifiedList.tsx` (05): its empty line gains "Try a question below and save a good answer as verified."

**Interfaces:**
- `SaveAsVerified({ projectId, spec, question })` follows `SaveAsVisual.tsx:31`'s pattern: `useCanEdit`, then idle, saving, saved or error.
- The dialog fields are "Question", "Other ways people ask it" (one per line, up to 8) and "Why this is the answer" (optional, ≤ 500).
- It sends `verified:save { projectId, input: { question, phrasings, note, spec } }`.
- On `ok` it shows "Saved as verified" and invalidates `['verified:list', projectId]` and `['answer:card']`, so the mark appears.
- On `ok: false` the dialog shows `error` under its `field`.

- [ ] **Step 1: Write the failing test** — `saveAsVerified.test.tsx`:
  - An editor's dock card shows "Save as verified".
  - The dialog is prefilled with "revenue by region last quarter".
  - Saving posts `verified:save`, with the card's stored spec and the phrasings split by line.
  - A refusal `{ ok: false, error: '“Revenue by region” is already a verified question.', field: 'question' }` shows under Question and keeps the input.
  - A card with `verified` shows no button.
  - A viewer sees none (negative control).
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- saveAsVerified` → module missing.
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run lint`, `npm --prefix web run size`.
- [ ] **Step 5: Commit** — `git add web/src/features/assistant web/src/features/model/assistant` · "Save a good Assistant answer as a verified question, from the test chat or the dock"

### Task 4: One e2e for the tab's chat

**Files:** Modify part 1's `web/e2e/model.e2e.ts`, in the no-`DATABASE_URL` mode with no model.

**Interfaces:** Test `data model: assistant test chat`:
1. Go to `/model/${pid}?tab=assistant`. The sample ships "Revenue by region" (07).
2. Type `revenue by region` and Ask. A card with "✓ Verified" shows, and beside it "A verified question — no model call."
3. Click the card's follow-up chip "Split by category" (`answer:rerun`). A second card shows, with no "how" line.
4. Click "Save as verified" on it, with Question "Revenue by region and category". Save. The Verified questions list now holds it.
5. Reload. The test chat still shows both answers and the "how" line.
6. Take the shots `model-assistant-chat` (light and dark).

Every load stays within `rpcBudget` 25.

- [ ] **Step 1: Write the failing test** — the spec above.
- [ ] **Step 2: Run it to see it fail** — `npm run build:web && npm --prefix web run e2e -- model` → no "Try a question" (before Task 2), or it passes once Tasks 1–3 are in.
- [ ] **Step 3: Implement** — nothing beyond Tasks 1–3. Fix what the e2e finds.
- [ ] **Step 4: Run it to see it pass** — `npm --prefix web run e2e -- model dock`, `DATABASE_URL=… npm --prefix web run e2e -- view-only-routes`. Look at `web/e2e/__screens__/model-assistant-chat-*` in both themes against the house polish bar.
- [ ] **Step 5: Commit** — `git add web/e2e/model.e2e.ts` · "Cover the Assistant tab's test chat end to end, with no model"

## Existing tests that must stay green

`test-verifiedAsk`, `test-copilot-threads`, `test-askFollowUp`, `test-askDidYouMean`, `test-verified`, `test-file-size`; web `assistant.test.tsx`, `didYouMean.test.tsx`, `dockScreens.test.tsx`, `testChat.test.tsx`, `saveAsVerified.test.tsx`, `verified.test.tsx`, `model.test.tsx`, `doors.test.tsx`; e2e `model`, `dock`, `home`, `view-only-routes`; every `__golden__` fixture (never re-recorded).
