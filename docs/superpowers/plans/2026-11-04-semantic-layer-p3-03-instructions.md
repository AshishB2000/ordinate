# Semantic layer part 3, step 03: Instructions, the guidance block, and the Settings relabel — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editors write a short list of project instructions ("Revenue means net_amount unless they say gross."). Every Assistant ask, every narration and every dashboard draft then reads them in one fenced guidance block in the user turn, beside the table guides. Admin's "Assistant rules" becomes "Screenshot analysis rules", because that is all it reaches.
**Architecture:**
- **Store:** the instruction list lives in the catalog (`CatalogFile.instructions`, whose reader shipped in 02). It changes one item at a time under the catalog's file lock, so two editors never lose each other's edit.
- **Block:** `src/ai/guidanceFacts.ts` (pure) builds the block.
- **Loader:** `src/ipc/guidance.ts` (`askGuidance`, `instructionsGuidance`) reads the catalog once per ask.
- **Hooks:** one each, in `copilot:ask` (`src/ipc/copilot.ts:514-518`), `narrate` (`src/ipc/answers.ts:227-232`) and the draft (`src/analysis/planFacts.ts`, `src/ipc/draftFacts.ts`).
- **Guides:** part 1's guide leaves "Table notes" and moves into the block.
- **Web:** the Data model page gains the **Assistant** tab, which here holds only the instructions.

**Tech Stack:** catalog JSON, zod contracts, `src/ai`, `src/ipc`, `src/analysis/planFacts.ts`, React (`web/src/features/model/assistant/`, `web/src/features/settings/WorkspaceTab.tsx`), Vitest, Playwright.
**Spec:** docs/semantic-layer/03-ai.md D1, D2, D3 (fence), D14, D15; Q1 · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p3-00-index.md
**Branch and PR:** `feat/semantic-p3-03-instructions` off `origin/develop`, one PR to `develop`. It needs 02 in a deployed release (the index's merge gate), plus part 1 step 10 (`DataModelPage`, `TABS`) and step 01 (`TableDoc.guide`, `tableNoteLines`).

## Global Constraints

- **Caps (D1, D15).**
  - Store: at most 40 instructions, each at most 300 characters on one line.
  - Block: instruction lines until 4,000 characters, then `- (more not shown)`.
  - Guide: 2,000 characters for the open dataset or visual's dataset. In the project context, 200 for each of the first 12 datasets (the order and cut of `buildFacts:375`).
  - Other contexts (dashboard, capture, stats, drivers, scorecard, scenario) get instructions only.
- **The fence (D3).** A save is refused when the text contains `<<<` or the capitalised word `GUIDANCE` (`/<<<|\bGUIDANCE\b/`). A stored instruction or guide that holds it is left out of the block, never erased.
- **The figure warning (D2)** is never a refusal. The reply flags each instruction matching `/[$€£¥]\s?\d|\d\.\d|\d{1,3}(?:,\d{3})+|\d\s?%/` (`figure: true`), and the web words it "Figures belong in metrics."
- **Prompt order (D2):** app facts, guidance, previous answer, then the question as its own argument. Joined with `\n\n`, skipping empty parts. With nothing filled in, the string handed to `askCopilot` is `Object.is`-equal to today's.
- The system prompt, `CHAT_SYSTEM_PROMPT` and `src/ai/analyze.ts` (851, allowlisted) are not touched.
- Guidance never holds a connection, a source-table note (part 2) or SQL. `askGuidance` reads the catalog only.
- **Access:**
  - `catalog:instructions` is `read` and META in `scripts/rowPolicyReaders.ts`: editor prose, which a restricted viewer reads too (D5).
  - `catalog:setInstructions` is `write`.
  - Both are project-scoped.
- **Line budgets:**
  - `src/ipc/copilot.ts` (605): +2 lines.
  - `src/ipc/answers.ts` (510): +2.
  - `src/app/catalog.ts` (428): untouched. Part 1 step 01 already exports `mutate` as `mutateCatalog` (p1-01 Task 4).
  - `web/src/features/settings/WorkspaceTab.tsx` (412): label edits and one link only.
- Sentences go in `src/app/instructionMessages.ts` (added to `MAIN_FILES`), then `node scripts/i18n-extract.js`.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **An empty project is byte-identical.** No block, no blank lines added. → Task 3, `Object.is` on the captured `askCopilot` argument.
- **The guide moves, it is not doubled.** Part 1's `- Guide:` line is gone from Table notes. → Task 3.
- **Lost updates.** Two editors adding at once both land: ops, not whole-list replace. → Task 1.
- **The block cannot be closed from inside.** `<<<GUIDANCE` and `GUIDANCE` are refused on save and skipped on read. → Tasks 1, 2.
- **No digit in the frame text.** The block is audited against its own ledger, and `sealLedger` adds 0 on digit-free fixtures. → Task 2.

## Rolling deploys

`CatalogFile.instructions` is kept by every P3-A pod (02 Task 1). During this PR's rollout, an older pod answers the two new channels 404, and the Assistant tab shows its error state with Retry. The older pod also asks without the block. That is a prompt difference only.

---

### Task 1: The store and its two channels

**Files:**
- Modify `src/app/instructions.ts` (02); `src/api/catalog.ts` (append two contracts); `src/ipc/catalog.ts` (two handlers); `scripts/rowPolicyReaders.ts`; `scripts/i18n-extract.ts`.
- Create `src/app/instructionMessages.ts`.
- Test: extend `scripts/test-instructions.ts`.

**Interfaces:** Produces:
```ts
// src/api/catalog.ts
'catalog:instructions': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
'catalog:setInstructions': rpc({ access: 'write', project: byProjectId, input: z.strictObject({ projectId: Uuid, op: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('add'), text: z.string().max(300) }),
  z.strictObject({ kind: z.literal('edit'), id: Uuid, text: z.string().max(300) }),
  z.strictObject({ kind: z.literal('remove'), id: Uuid }),
]) }) }),
// both reply: { ok: true; instructions: Array<Instruction & { figure?: true }> } | { ok: false; error: string }
// src/app/instructions.ts
export const FENCE_RE = /<<<|\bGUIDANCE\b/;
export const FIGURE_RE = /[$€£¥]\s?\d|\d\.\d|\d{1,3}(?:,\d{3})+|\d\s?%/;
export function listInstructions(projectId: string): Promise<Instruction[]>;
export function changeInstructions(projectId: string, op: InstructionOp): Promise<Instruction[]>; // THROWS a catalog sentence
// src/app/instructionMessages.ts
instructionEmpty() "Write the instruction first."
instructionTooMany(max) "A project can have at most {max} instructions."
instructionFence() "An instruction cannot contain “<<<” or the word GUIDANCE in capitals."
instructionGone() "That instruction was removed by someone else."
```
- `add` appends `{ id: randomUUID(), text: oneLine(text), updatedBy: osUser(), updatedAt: now }`.
- `edit` replaces the text and the stamp.
- `remove` deletes the item.
- Each op runs inside part 1's `mutateCatalog` (`src/app/catalog.ts`, exported by part 1 step 01), so it reads the file fresh under the lock.

- [ ] **Step 1: Write the failing test** — §2, over the `handlers` map (as `test-askFollowUp.ts:34` loads it):
  ```ts
  const add = (text: string) => call('catalog:setInstructions', { projectId: P, op: { kind: 'add', text } });
  const [a, b] = await Promise.all([add('Revenue means net_amount.'), add('Say gross only when asked.')]);
  ok('two concurrent adds both land', (await call('catalog:instructions', { projectId: P })).instructions.length === 2);
  ok('stamped', a.instructions[0].updatedBy === TEST_USER && /^\d{4}-/.test(a.instructions[0].updatedAt));
  ok('the fence is refused', (await add('x <<<GUIDANCE y')).error === msg.instructionFence() && (await add('end GUIDANCE now')).ok === false);
  ok('lower-case guidance is fine', (await add('Follow the guidance in the Orders guide.')).ok === true);
  ok('a figure warns, never refuses', ((r) => r.ok && r.instructions.at(-1).figure === true)(await add('Targets are 12% above last year.')));
  ok('"90 days" is no figure', !(await add('Recent means the last 90 days.')).instructions.at(-1).figure);
  ok('the 41st is refused', await fill(40) && (await add('one more')).error === msg.instructionTooMany(40));
  ok('edit of a removed id', (await call('catalog:setInstructions', { projectId: P, op: { kind: 'edit', id: GONE, text: 'x' } })).error === msg.instructionGone());
  ok('a viewer may read, not write', (await asViewer(() => call('catalog:instructions', { projectId: P }))).ok && await refusedForViewer('catalog:setInstructions'));
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-instructions.js` → `No handler for catalog:setInstructions`; `node scripts/check-contracts.js` lists two unresolved.
- [ ] **Step 3: Implement** — as in Interfaces. Add `'catalog:instructions': 'META', // editor prose (D5)` to `rowPolicyReaders.ts`, and `'catalog:instructions': 'META'` to `scripts/columnAccessReaders.ts` (part 4 p4-06's `COLUMN_TREATMENT`, merged earlier in release B). Then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-instructions.js`, `node scripts/check-contracts.js` (0 unresolved), `node scripts/test-i18n.js`, `node scripts/test-catalog.js`.
- [ ] **Step 5: Commit** — `git add src/app/instructions.ts src/app/instructionMessages.ts src/app/catalog.ts src/api/catalog.ts src/ipc/catalog.ts scripts/rowPolicyReaders.ts scripts/i18n-extract.ts src/i18n/*.json scripts/test-instructions.ts` · "Let editors keep a project's Assistant instructions, one at a time"

### Task 2: The guidance block (pure)

**Files:** Create `src/ai/guidanceFacts.ts` and `scripts/test-guidance.ts`. Modify `scripts/test-numberAudit.ts` to add the block to its digit-free fixtures.

**Interfaces:** Consumes `oneLine` (01), `harvestAppNumbers`, `sealLedger`. Produces:
```ts
export const INSTRUCTIONS_BLOCK_MAX = 4000, GUIDE_OPEN_MAX = 2000, GUIDE_INVENTORY_MAX = 200;
export interface GuidanceInput { instructions: string[]; guides?: { dataset: string; text: string; max: number }[]; examples?: string[] /* step 06 */ }
export interface Guided { text: string; ledger: LedgerEntry[]; used: TurnGuidance } // TurnGuidance from 02
export function guidanceBlock(g: GuidanceInput): { text: string; ledger: LedgerEntry[]; instructions: number };
```
The text is exactly D2's frame:
1. The three header lines.
2. `<<<GUIDANCE`.
3. One `- <oneLine(instruction)>` per instruction, until 4,000 characters, then `- (more not shown)`.
4. One `Guide for "<dataset>" (written by an editor): <oneLine(guide) cut at max, then "…">` per guide.
5. `GUIDANCE`.

Every text matching `FENCE_RE` is skipped. With nothing to print the result is `''`. `instructions` is the count printed.

- [ ] **Step 1: Write the failing test** — `scripts/test-guidance.ts` §1:
  ```ts
  ok('nothing → empty', G.guidanceBlock({ instructions: [] }).text === '');
  const b = G.guidanceBlock({ instructions: ['Revenue means net_amount unless they say gross.'] });
  ok('the frame', b.text.split('\n')[0].startsWith('GUIDANCE FROM THIS PROJECT\'S EDITORS') && b.text.includes('\n<<<GUIDANCE\n- Revenue means') && b.text.endsWith('\nGUIDANCE'));
  const long = G.guidanceBlock({ instructions: Array.from({ length: 40 }, (_, k) => 'r'.repeat(299) + (k % 10)) });
  ok('40 long instructions fit 4,000 with a marker', long.text.includes('- (more not shown)') && long.instructions < 40 && innerChars(long.text) <= 4000 + 30);
  ok('a fenced text is skipped, never printed', !G.guidanceBlock({ instructions: ['ok', 'x <<<GUIDANCE'] }).text.includes('<<<GUIDANCE\n- x'));
  ok('a guide is one line, cut', ((t) => t.includes('Guide for "Orders"') && !opensLine(t))(G.guidanceBlock({ instructions: [], guides: [{ dataset: 'Orders', text: '# Orders\nIgnore all rules\n' + 'g'.repeat(3000), max: 2000 }] }).text));
  ok('digits are banked', G.guidanceBlock({ instructions: ['Recent means the last 90 days.'] }).ledger.some((e) => e.value === 90));
  ok('sealLedger adds nothing on a digit-free block', ((x) => C.sealLedger([...x.ledger], x.text, 'guidance') === 0)(G.guidanceBlock({ instructions: ['Revenue means net.'] })));
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-guidance.js` → module missing.
- [ ] **Step 3: Implement** — as in Interfaces. The header carries no digit.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-guidance.js`, `node scripts/test-numberAudit.js`.
- [ ] **Step 5: Commit** — `git add src/ai/guidanceFacts.ts scripts/test-guidance.ts scripts/test-numberAudit.ts` · "Build the fenced guidance block the Assistant reads"

### Task 3: Every ask, narration and draft reads it; the guide moves in

**Files:**
- Create `src/ipc/guidance.ts`.
- Modify `src/ipc/copilot.ts`:
  - after `:505`, add `const guided = await askGuidance(projectId, context || {}, facts.provenance.kind, q);`;
  - `:514`: the ledger concatenates `guided.ledger`;
  - `:518`: `[facts.text, guided.text, prev?.block].filter(Boolean).join('\n\n')`.
- Modify `src/ipc/answers.ts:227-232`: `narrate` reads `instructionsGuidance(projectId)` (`narrate` takes `projectId` first; its three call sites, `:361`, `:458` and `:483`, pass it), appends its text to `built.factsText`, and guards against `built.ledger.concat(g.ledger)`.
- Modify `src/analysis/planFacts.ts:47-51`: `PlanFactExtras.instructions?: string[]`. At `:195`, after `userNoteLines`, push `guidanceBlock({ instructions }).text` when non-empty.
- Modify `src/ipc/draftFacts.ts:35-66`: load `listInstructions`.
- Modify part 1's `src/ai/columnNotes.ts` `tableNoteLines`: it no longer prints `- Guide:`, and `GUIDE_FACT_MAX` is deleted. Also modify part 1's `src/app/tableDocs.ts` `tableFacts`: it no longer fills `guide`.
- Test: extend `scripts/test-guidance.ts`, `scripts/test-planFacts.ts`, and part 1's `scripts/test-copilot.ts` guide assertion (on purpose: the guide is now in guidance).

**Interfaces:** Produces:
```ts
export async function askGuidance(projectId: string, context: { kind?: string; id?: string }, factsKind: string, question = '', opts: { exclude?: string } = {}): Promise<Guided>;
export async function instructionsGuidance(projectId: string): Promise<Guided>;
```
- **`askGuidance`** does one `catalog.load(projectId)`. Then:
  - Guides come from `file.tables?.[id]?.guide`.
  - `factsKind === 'dataset'` uses `context.id`.
  - `'visual'` uses `(await visuals.getVisual(projectId, context.id)).datasetId`.
  - `'project'` uses the first 12 of `datasets.listDatasets(projectId)`.
  - Any other kind gets instructions only.
  - Dataset names come from `getDatasetMeta` (metadata).
  - `question` and `opts` are unused until 06.
- **`used`** is `{ instructions: <count printed>, examples: [] }`.
- **Neither function throws.** A catalog that cannot be read gives `{ text: '', ledger: [], used: { instructions: 0, examples: [] } }`.

- [ ] **Step 1: Write the failing test** — §2, through the real `copilot:ask` with `analyze.askCopilot` stubbed (`test-askFollowUp.ts:93-101` style) and `executionReady → true`:
  ```ts
  const seen: string[] = []; (analyze as any).askCopilot = async (_p: unknown, facts: string) => { seen.push(facts); return { ok: true, text: 'ok', suggestedAction: NONE }; };
  await ask(P, { kind: 'dataset', id: D }, 'how many rows');
  ok('unchanged with nothing filled in', Object.is(seen[0], (await ipcCopilot.buildFacts(P, { kind: 'dataset', id: D })).text));
  await addInstruction(P, 'Revenue means net_amount.'); await setGuide(P, D, '# Orders\nUse net_amount.');
  await askInThreadWithPreviousAnswer(P, T, 'and by region');
  const s = seen.at(-1)!;
  ok('order: facts, guidance, previous answer', s.indexOf('Dataset: "Orders"') < s.indexOf('<<<GUIDANCE') && s.indexOf('GUIDANCE\n\nPREVIOUS ANSWER') > 0);
  ok('the guide moved: in guidance, not in Table notes', s.includes('Guide for "Orders" (written by an editor): # Orders Use net_amount.') && !/^- Guide:/m.test(s));
  ok('project context: 200 per guide', guideLen(await promptFor(P, { kind: '' })) <= 200 + 1);
  ok('a dashboard context: instructions, no guide', ((t) => t.includes('- Revenue means') && !t.includes('Guide for'))(await promptFor(P, { kind: 'analysis', id: A })));
  ok('narration reads the instructions', (await rerunNarrationFacts(P, SPEC)).includes('- Revenue means net_amount.'));
  ok('the draft reads them before the request', ((t) => t.indexOf('<<<GUIDANCE') < t.indexOf('<<<USER REQUEST'))(PF.buildFactsText(ctx, 'sales overview', { instructions: ['Revenue means net_amount.'] })));
  ok('NEGATIVE CONTROL: a draft without instructions is byte-identical', Object.is(PF.buildFactsText(ctx, 'x', {}), PF.buildFactsText(ctx, 'x', { instructions: [] })));
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-guidance.js` → `FAIL order: facts, guidance, previous answer`.
- [ ] **Step 3: Implement** — as in Files and Interfaces.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-guidance.js`, `node scripts/test-copilot.js`, `node scripts/test-planFacts.js`, `node scripts/test-askFollowUp.js`, `node scripts/test-ask-activity.js`, `node scripts/test-answerFacts.js`, `node scripts/test-numberAudit.js`, `node scripts/test-asyncReach.js`.
- [ ] **Step 5: Commit** — `git add src/ipc/guidance.ts src/ipc/copilot.ts src/ipc/answers.ts src/analysis/planFacts.ts src/ipc/draftFacts.ts src/ai/columnNotes.ts src/app/tableDocs.ts scripts/test-guidance.ts scripts/test-planFacts.ts scripts/test-copilot.ts` · "Give every Assistant ask, narration and draft the project's instructions and guides"

### Task 4: The Assistant tab with the instructions, and the Admin relabel

**Files:**
- Create in `web/src/features/model/assistant/`: `AssistantTab.tsx`, `InstructionsList.tsx`, `api.ts`, `Assistant.module.css`, `assistant.test.tsx`.
- Modify part 1's `web/src/features/model/DataModelPage.tsx`: append `'assistant'` to `TABS` (icon `sparkles`, label "Assistant").
- Modify `web/src/features/settings/WorkspaceTab.tsx:347-382` (the relabel), `web/src/features/settings/settings.test.tsx`, and part 1's `web/e2e/model.e2e.ts`.

**Interfaces:**
- `useInstructions(projectId)`: key `['catalog:instructions', projectId]`.
- `useChangeInstruction(projectId)`, which invalidates it.
- `InstructionsList({ projectId })`:
  - **Head:** "Instructions" with the count, and the framing line "Everyone in this project, and their Assistant, reads these."
  - **Rows:** each shows its text, then "{updatedBy} · {date}", then for editors Edit (inline, ≤ 300, Enter saves) and Remove.
  - **Add:** an editor's "+ Instruction".
  - **Flags:** a `figure` row shows the warn note "Figures belong in metrics."
  - **Refusals:** the server's sentence shows inline and keeps the typed text.
  - **States:** a skeleton while loading. An `ErrorState` "The instructions could not be loaded" with Retry. Empty: "No instructions yet. Write the rules your team follows, like “Revenue means net_amount unless they say gross”, and every Assistant answer follows them." Editors get "+ Instruction"; a viewer reads "An editor of this project can add instructions."
- `WorkspaceTab`'s `Assistant` group:
  - The title is "Screenshot analysis rules".
  - The description is "Fixed instructions added to every screenshot analysis the Assistant writes for this organization. The required output format wins if they conflict."
  - A line follows: "What the Assistant should know when it answers questions is set per project:", with the link "Data model → Assistant" to `/model?tab=assistant`. Part 1's `/model` keeps the search.
  - The textarea `aria-label` is "Screenshot analysis rules".

- [ ] **Step 1: Write the failing test** — `assistant.test.tsx`, with `renderApp` and a `serve()` stub as in part 1's `model.test.tsx`:
  - `/model/P?tab=assistant` shows the h2 "Instructions" and two rows.
  - An editor's "+ Instruction", given text and Enter, sends `catalog:setInstructions { op: { kind: 'add', text } }` and refetches.
  - A `figure: true` row shows "Figures belong in metrics."
  - A refusal shows `instructionFence`'s sentence and keeps the text.
  - A viewer sees no button (negative control).
  - A 404 shows the error state, and Retry calls the read again.

  `settings.test.tsx`: the group reads "Screenshot analysis rules", and the link's href is `/model?tab=assistant`.

  `model.e2e.ts`, test `data model: assistant`: add `Revenue means the revenue column.`, reload, see it, then shots `model-assistant` (light and dark). RPC budget unchanged.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- assistant settings` → no tab "Assistant".
- [ ] **Step 3: Implement** — as in Interfaces. Use tokens only, in both themes. Under 900 px the rows stack.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run build:web && npm --prefix web run e2e -- model settings`, `npm --prefix web run size`, `npm run lint`. Look at `web/e2e/__screens__/model-assistant-*` in both themes.
- [ ] **Step 5: Commit** — `git add web/src/features/model web/src/features/settings web/e2e/model.e2e.ts` · "Add the Data model's Assistant tab with the project's instructions, and call the org rules what they are"

## Existing tests that must stay green

`test-instructions`, `test-guidance`, `test-catalog`, `test-tableDocs`, `test-copilot`, `test-copilot-analysis-facts`, `test-planFacts`, `test-analysisPlan`, `test-askFollowUp`, `test-askDidYouMean`, `test-ask-activity`, `test-answerFacts`, `test-numberAudit`, `test-number-fidelity`, `test-rowPolicySafetyNet` (with `DATABASE_URL`), `test-asyncReach`, `test-i18n`, `test-file-size`, `check-contracts`; web `model.test.tsx`, `settings.test.tsx`, `model.e2e.ts`, `settings.e2e.ts`; every `__golden__` fixture (never re-recorded).
