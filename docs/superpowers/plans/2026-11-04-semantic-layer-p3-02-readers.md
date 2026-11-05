# Semantic layer part 3, step 02: Keep what part 3 will store — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After this release, every pod keeps three things through each of its own writes, backups and imports. They are the catalog's `instructions`, an assistant turn's `guidance` and `verified/<id>.json` records. Release P3-B's pods can then write them while older pods still serve requests. This PR has no feature, no channel and no UI.
**Architecture:** Readers only. The catalog sanitizer keeps a new optional `instructions` section, read by a new `sanitizeInstructions`. `normalizeTurns` and `appendTurn` keep a new optional `guidance` on assistant turns, read by a new `sanitizeGuidance`. The bundle whitelist admits `verified/<uuid>.json`. Each reader is pinned by a "re-save keeps it" test and a negative control.
**Tech Stack:** `src/app/catalog.ts`, `src/ai/copilot.ts`, `src/app/bundleRules.ts`, self-checks.
**Spec:** docs/semantic-layer/03-ai.md D1, D7, D11, and the brief's rolling-deploy rule · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p3-00-index.md
**Branch and PR:** `feat/semantic-p3-02-readers` off `origin/develop`, one PR to `develop`, release P3-A. It needs part 1 01a merged (release 1): its `tables` line in `sanitizeCatalog` and `test-tableDocs` are what Task 1 builds on. Nothing from part 1's release 2.

## Global Constraints

- **Shapes:** these are binding on 03, 05 and 08, and part 7 reads them.
  - `Instruction { id: string /* UUID */; text: string /* one line, ≤ 300 */; updatedBy: string /* ≤ 80 */; updatedAt: string /* ≤ 40 */ }`.
  - `CatalogFile.instructions?: Instruction[]`: at most 40, in stored order, present only when non-empty.
  - `TurnGuidance { verifiedId?: string /* UUID */; instructions: number /* integer 0..40 */; examples: string[] /* UUIDs, ≤ 5 */ }`. It holds ids and counts only, and never text.
- **Readers clip, never refuse.** A malformed entry is dropped and the rest are kept. A text with line breaks is collapsed to one line, because a stored file is untrusted. Fence-marker handling is the prompt builder's job (03); the reader keeps the text.
- **Byte-identical when absent.** A catalog with no instructions writes no `instructions` key, and a turn with no guidance has no `guidance` key. `test-catalog` and `test-copilot-threads` stay green unchanged.
- `src/app/catalog.ts` (428 lines): no more than +3 lines. `src/ai/copilot.ts` (554 lines): no more than +8 lines. The sanitizers live in new files.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **One shared file per project.** `copilot.json` holds every member's threads, so one member's append rewrites them all. The test re-saves through **another** member's thread.
- **The bundle rule must remap ids.** Bundle import swaps every UUID in a JSON body (`bundleImport.ts:224-243`), so a verified spec's `datasetId` follows its dataset. The test asserts it.
- **The manifest count `verified`.** Export counts by rule (`bundle.ts:212`) and import compares counts (`bundleImport.ts:217-219`), so both sides learn the key in the same PR.

## Rolling deploys

This PR *is* the rolling-deploy step. A pod older than it drops `instructions` and `guidance` on re-save, and drops `verified/` from bundles. Nothing writes those yet, so nothing is lost while this rolls out. Release P3-B must not reach a pod before this one has (the merge gate for 03 in the index).

---

### Task 1: The catalog keeps `instructions`

**Files:**
- Create `src/app/instructions.ts` and `scripts/test-instructions.ts`.
- Modify `src/app/catalog.ts`:
  - `:42` (import);
  - `:74-81` (`CatalogFile.instructions?: Instruction[]`);
  - `:225-226` (after `tables`: `const instructions = sanitizeInstructions(raw.instructions); if (instructions.length) out.instructions = instructions;`).

**Interfaces:**

Produces from `src/app/instructions.ts` (pure apart from types):
- `export interface Instruction`
- `export const MAX_INSTRUCTIONS = 40`
- `export const MAX_INSTRUCTION_LEN = 300`
- `export function sanitizeInstructions(raw: unknown): Instruction[]`:
  - keeps array entries with a UUID `id` that has not been seen yet;
  - `text` is whitespace-collapsed, trimmed and cut at 300 (never inside a surrogate pair);
  - an empty text drops the entry;
  - `updatedBy` and `updatedAt` are clipped;
  - stops at 40.

- [ ] **Step 1: Write the failing test** — `scripts/test-instructions.ts` (temp `ORDINATE_LOCAL_DIR`, a project created with `projects.createProject`):
  ```ts
  const I1 = { id: U1, text: 'Revenue means net_amount unless they say gross.', updatedBy: 'priya@x', updatedAt: '2026-10-12T00:00:00.000Z' };
  writeRawCatalog(P, { schemaVersion: 1, tags: {}, records: {}, columns: {}, instructions: [I1, { id: 'nope', text: 'x' }, { id: U2, text: 'a\nb' }] });
  await catalog.setColumn(P, DS, 'region', { description: 'Sales region' }); // an old-path write
  const back = rawCatalog(P);
  ok('an old-path write keeps instructions', back.instructions.length === 2 && back.instructions[0].text === I1.text);
  ok('a bad id is dropped, a line break collapsed', !back.instructions.some((i: any) => i.id === 'nope') && back.instructions[1].text === 'a b');
  ok('at most 40', sanitizeInstructions(Array.from({ length: 41 }, (_, k) => ({ id: uuid(k), text: `t${k}` }))).length === 40);
  ok('absent → no key', !('instructions' in catalog.sanitizeCatalog({ schemaVersion: 1 })));
  ok('NEGATIVE CONTROL: a non-array is no list', sanitizeInstructions('Revenue means net').length === 0);
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-instructions.js` → tsc "Cannot find module '../src/app/instructions'".
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-instructions.js`, `node scripts/test-catalog.js`, `node scripts/test-tableDocs.js`, `node scripts/test-columnNames.js`.
- [ ] **Step 5: Commit** — `git add src/app/instructions.ts src/app/catalog.ts scripts/test-instructions.ts` · "Keep a project's Assistant instructions through every catalog write"

### Task 2: Turns keep `guidance`

**Files:**
- Create `src/ai/turnGuidance.ts`.
- Modify `src/ai/copilot.ts`:
  - `:51-68`: `CopilotTurn.guidance?: TurnGuidance`;
  - `:101-108`: `NewCopilotTurn.guidance?`;
  - `:204-226`: `normalizeTurns`, assistant turns only: `const g = role === 'assistant' ? sanitizeGuidance(t.guidance) : undefined; if (g) turn.guidance = g;`;
  - `:442-453`: `appendTurn` does the same from `turn.guidance`.

Test: extend `scripts/test-copilot-threads.ts`.

**Interfaces:** Produces:
- `export interface TurnGuidance`
- `export function sanitizeGuidance(raw: unknown): TurnGuidance | undefined`:
  - an object only;
  - `instructions` must be an integer in 0..40, or the whole value is undefined;
  - `examples` keeps UUID strings, at most 5;
  - `verifiedId` is kept only when it is a UUID.

- [ ] **Step 1: Write the failing test** — in `test-copilot-threads.ts`, with two members, A and B (as its existing owner tests do):
  ```ts
  writeRawThreads(P, [{ owner: 'a@x', turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'r', guidance: { verifiedId: V, instructions: 3, examples: [E1, 'bad'] } }] }]);
  await as('b@x', () => copilot.appendTurn(P, { role: 'user', text: 'hello' }));          // B's append rewrites the file
  const a = rawThreads(P).find((t: any) => t.owner === 'a@x').turns[1];
  ok('another member\'s append keeps guidance', a.guidance.verifiedId === V && a.guidance.instructions === 3 && a.guidance.examples.join() === E1);
  ok('a user turn never carries guidance', (await copilot.appendTurn(P, { role: 'user', text: 'x', guidance: G } as any))!.at(-1)!.guidance === undefined);
  ok('appendTurn keeps it on an assistant turn', (await copilot.appendTurn(P, { role: 'assistant', text: 'y', guidance: G }))!.at(-1)!.guidance!.instructions === G.instructions);
  ok('NEGATIVE CONTROL: an unknown turn key is still dropped', !('foo' in (await reloadTurn(P, { role: 'assistant', text: 'z', foo: 1 }))));
  ok('a bad count drops it whole', sanitizeGuidance({ instructions: 41, examples: [] }) === undefined);
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-copilot-threads.js` → `FAIL another member's append keeps guidance`.
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-copilot-threads.js`, `node scripts/test-copilot.js`, `node scripts/test-askFollowUp.js`.
- [ ] **Step 5: Commit** — `git add src/ai/turnGuidance.ts src/ai/copilot.ts scripts/test-copilot-threads.ts` · "Keep how an Assistant answer was guided on its stored turn"

### Task 3: Bundles and backups carry `verified/`

**Files:**
- Modify `src/app/bundleRules.ts:40`: after `metrics/`, `{ re: new RegExp(`^verified/${UUID}\\.json$`, 'i'), count: 'verified' },`.
- Test: extend `scripts/test-bundle.ts`.

**Interfaces:** Produces the rule. Part 7 reads it.

- [ ] **Step 1: Write the failing test** — in `test-bundle.ts`:
  1. Plant `projects/<P>/verified/<V>.json` holding `{ id: V, projectId: P, question: 'Revenue by region', spec: { datasetId: D, … } }` beside a dataset D.
  2. Export: the zip has `verified/<V>.json`, and the manifest has `counts.verified === 1`.
  3. Import into a second org where D's id is taken: the imported record's `spec.datasetId` equals the remapped dataset's id.
  4. Negative control: a bundle holding `verified/not-a-uuid.json` is refused whole, as any off-whitelist name is.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-bundle.js` → `FAIL the bundle carries verified questions`.
- [ ] **Step 3: Implement** — the one rule line.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-bundle.js`, `node scripts/test-backups.js`, `node scripts/test-bundleMemory.js`.
- [ ] **Step 5: Commit** — `git add src/app/bundleRules.ts scripts/test-bundle.ts` · "Carry verified questions in bundles and backups"

### Task 4: The upgrade note

**Files:** Modify `docs/server/upgrade.md`. Add a section after "Filters a newer release writes are kept (`05a`)" named "Assistant guidance a newer release writes is kept (`p3-02`)". It says:
- The release that adds Assistant instructions and verified questions needs this one on every pod first.
- What an older pod would drop: instructions on its next catalog write, how an answer was guided on its next conversation write, and verified questions in its backups.
- Helm, Compose and ECS take one rolling step through this release.

- [ ] **Step 1: Write the failing test** — `node scripts/test-serverDocs.js` only needs to stay green, because no env var is added. Instead, the review checks the section exists and names `p3-02`.
- [ ] **Step 2: Run it** — `node scripts/test-serverDocs.js`.
- [ ] **Step 3: Implement** — the section, in the doc's existing voice.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-serverDocs.js`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add docs/server/upgrade.md` · "Say which release must roll out before Assistant guidance"

## Existing tests that must stay green

`test-catalog`, `test-tableDocs`, `test-columnNames`, `test-copilot`, `test-copilot-threads`, `test-askFollowUp`, `test-bundle`, `test-bundleMemory`, `test-backups`, `test-serverDocs`, `test-file-size`, `check-contracts`; every `__golden__` fixture (never re-recorded).
