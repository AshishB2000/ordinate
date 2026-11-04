# Semantic layer part 3, step 09: MCP tools for verified questions and instructions — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents on `POST /api/mcp` read what the team signed off, as the token's user. Three read-only tools do this:
- `list_verified_questions`;
- `answer_verified_question`, whose figures come from the engine through `computeCard` and the Share policy's export path;
- `get_instructions`.

No tool writes or verifies. The `answer-data-questions` skill checks verified questions first.

**Architecture:**
- **Registration.** Three entries are appended to `COMMANDS` (`src/automation/registry.ts:152-307`). `SERVER_COMMANDS` (`src/automation/serverMcp.ts:37`) serves them with no other wiring.
- **Bodies.** They live in a new `src/automation/verifiedTools.ts`, re-exported from `handlers.ts` (as `creators.ts` is at `handlers.ts:45`).
- **Figures.** They are `computeCard`'s, under the token user's row lock, then `sharePolicy.applyToChart(…, 'export')` (`src/app/sharePolicy.ts:241`), exactly as `aggregate` shapes its reply (`src/automation/creators.ts:95-118`).
- **Visibility.** It is 05's `verifiedStates`, so D5 holds here as in the app.

**Tech Stack:** `src/automation`, `docs/automation.md` (generated), `plugins/ordinate/skills/answer-data-questions/SKILL.md`, self-checks.
**Spec:** docs/semantic-layer/03-ai.md D5, D12 · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p3-00-index.md
**Branch and PR:** `feat/semantic-p3-09-mcp` off `origin/develop` after 08 merges, one PR to `develop`. It needs 07's sample set, which `test-pluginSkills` builds against.

## Global Constraints

- **The three tools.** Each has `readOnly: true` and takes the standard `project` argument (`registry.ts:105`). Names match `/^[a-z]+(_[a-z]+)*$/` (`scripts/test-automation.ts:137`). The non-read-only set at `:145-146` stays unchanged.
- **`list_verified_questions`** lists every question and returns, per item:
  - `id`, `question`, `phrasings`, `dataset` (name), `verifiedBy`, `verifiedAt`, `runs`, and `problem?`;
  - `aggregate?`, which is `{ dataset, encoding, filters }` in `aggregate`'s argument shape (`registry.ts:110-148`).

  `aggregate` is present only when the spec is fully expressible there and D5 allows it. That means no `period`, no `top` and no term, since `aggregate`'s `FILTERS` cannot say them, and not hidden. Otherwise the item carries `aggregate` absent and the line "Use answer_verified_question for its figures."
- **`answer_verified_question { question }`** takes an id, or the question or one of its phrasings, matched on `questionKey` (05).
  - A hidden question or an unknown one refuses: "No verified question “{question}” in this project." Hiding never says "hidden".
  - A broken one refuses with its `problem`.
  - It returns `{ id, question, dataset, labels, series: [{ name, values }], headline?, asOf?, verifiedBy, verifiedAt, note?, notes? }`. `notes` is the card's `notes` when non-empty, so part 4's retired-metric sentence (`retiredNotes`, cross-part check item 8) reaches an agent too; a question on a retired metric still answers.
  - `headline` (`{ label, value, display }[]`, `src/ai/answerFacts.ts:79-83`) is included only when the Share policy left `labels` and series names unchanged. A masked label must not leave inside a headline.
  - A policy refusal is the `aggregate` sentence (`creators.ts:108`).
- **`get_instructions`** returns `{ framing: GUIDANCE_FRAMING, instructions: [{ text, updatedBy, updatedAt }] }`. A text holding the fence (03) is left out, as in the block. `GUIDANCE_FRAMING` is the block's header, exported from `src/ai/guidanceFacts.ts`.
- **Figures are never stored**, never taken from a model, and never re-rounded. Each one is the engine's value from `card.data`.
- `src/automation/registry.ts` (394 lines) gets +21. `src/automation/mcp.ts:68-71` (initialize instructions) gets one sentence. `docs/automation.md` is regenerated, never hand-edited.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Figures agree.** `answer_verified_question` must equal `answer:card` for the same spec (`Object.is`). `aggregate` called with a listed `aggregate` must give the same label → value pairs. → Task 2.
- **The export path.** A sensitive category leaves masked, with no headline. → Task 2.
- **A restricted token.** It gets locked figures, no `aggregate` args for a value-filtered question, and "No verified question" for a hidden one, while the editor control gets all. → Task 2.
- **The skill's example runs** against the sample. → Task 3.

## Rolling deploys

Tools are listed by the pod that answers `tools/list`. During a rollout, an agent may be told of a tool by one pod and get "unknown tool" from another, which it can retry. That is the same behaviour every earlier tool addition had. Nothing is stored.

---

### Task 1: The three tools

**Files:**
- Create `src/automation/verifiedTools.ts`.
- Modify:
  - `src/automation/handlers.ts:45`: `export * from './verifiedTools'`;
  - `src/automation/registry.ts`: three `COMMANDS` entries after `metric_value` (`:212-218`);
  - `src/ai/guidanceFacts.ts` (03): `export const GUIDANCE_FRAMING`;
  - `src/automation/mcp.ts:68-71`: add "Before answering a data question, call get_instructions and list_verified_questions.";
  - `scripts/test-automation.ts:139-141`: the `want` list.
- Test: extend `scripts/test-automationTools.ts`.

**Interfaces:** Consumes `verifiedStates`, `questionKey`, `computeCard`, `sharePolicy.applyToChart`, `listInstructions`, `FENCE_RE`, `AutomationError` and `Ctx`. Produces:
```ts
export async function listVerifiedQuestions(ctx: Ctx): Promise<{ questions: McpVerified[] }>;
export async function answerVerifiedQuestion(ctx: Ctx, question: string): Promise<McpVerifiedAnswer>;
export async function getInstructions(ctx: Ctx): Promise<{ framing: string; instructions: { text: string; updatedBy: string; updatedAt: string }[] }>;
```
Registry entries:
- `{ tool: 'list_verified_questions', readOnly: true, summary: "The project's verified questions: answers the team signed off, each a spec the app computes. Never a stored figure.", args: {}, run: (_a, ctx) => h.listVerifiedQuestions(ctx) }`;
- `answer_verified_question`: `args: { question: { type: 'string', description: 'A verified question\'s id, or its wording or one of its phrasings.' } }`, `required: ['question']`;
- `get_instructions`: `args: {}`.

The encoding passed to `applyToChart` is `{ category: spec.category, values: spec.measures, series?, grain? }`. Its reply argument is `{ ok: true, data: card.data, warnings: [], recommendedShape: 'categorical', category: undefined }`.

- [ ] **Step 1: Write the failing test** — `test-automationTools.ts`, over the seeded sample (07):
  ```ts
  const list = (await call('list_verified_questions', {})).questions;
  ok('lists the sample\'s set', list.length === 4 && list.every((q: any) => q.runs));
  ok('aggregate args only where aggregate can say it', !!byQ(list, 'Revenue by region').aggregate && !byQ(list, 'Top 5 states by revenue').aggregate && !byQ(list, 'Revenue by month last year').aggregate);
  const ans = await call('answer_verified_question', { question: 'revenue BY region?' });
  const card = await computeCard(P, specOf('Revenue by region'));
  ok('figures are answer:card\'s', 'card' in card && ans.labels.every((l: any, i: number) => Object.is(l, card.card.data.labels[i])) && ans.series[0].values.every((v: number, i: number) => Object.is(v, card.card.data.series[0].values[i])));
  const agg = await call('aggregate', byQ(list, 'Revenue by region').aggregate);
  ok('aggregate agrees, label by label', ans.labels.every((l: string, i: number) => Object.is(agg.series[0].values[agg.labels.indexOf(l)], ans.series[0].values[i])));
  ok('who verified it, and as-of', ans.verifiedBy.length > 0 && !!ans.asOf);
  ok('an unknown question refuses', (await refusal('answer_verified_question', { question: 'revenue by planet' })).message === 'No verified question “revenue by planet” in this project.');
  ok('instructions, with the framing', ((r) => r.instructions.length === 3 && r.framing.startsWith('GUIDANCE FROM THIS PROJECT\'S EDITORS'))(await call('get_instructions', {})));
  ```
  In the Share policy block (`:251-273`), with `region` marked personal and the export action `mask`:
  - `answer_verified_question`'s `labels` are tokens and it has no `headline`;
  - `!JSON.stringify(ans).includes('West')`;
  - NEGATIVE CONTROL: unmarked, both are present.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-automationTools.js` → `unknown tool list_verified_questions`.
- [ ] **Step 3: Implement** — as in Interfaces.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-automationTools.js`, `node scripts/test-automation.js` (the schema checks; the docs check fails until Task 3).
- [ ] **Step 5: Commit** — `git add src/automation src/ai/guidanceFacts.ts scripts/test-automationTools.ts scripts/test-automation.ts` · "Let agents read verified questions and instructions, and answer a verified question from the engine"

### Task 2: As the token's user, under row rules

**Files:** Extend `scripts/test-rowPolicyFanOut.ts` §7 (`:332-342`, its `tool()` helper on `/api/mcp`; needs `DATABASE_URL`).

**Interfaces:** None new.

- [ ] **Step 1: Write the failing test** — `boss` saves "Revenue by region" (no value filter) and "West customers" (`customer = ${W_CANARY}_1`) on Orders. Then:
  ```ts
  const eastList = await tool('east', 'list_verified_questions', {});
  ok('mcp: east lists the value-filtered question without aggregate args', !('aggregate' in byQ(eastList.questions, 'West customers')) && !H.leaks(JSON.stringify(eastList)));
  ok('mcp: east cannot answer it', /No verified question/.test((await toolError('east', 'answer_verified_question', { question: 'West customers' })).message));
  ok('mcp: east\'s figures are locked — equal to east\'s answer:card', sameFigures(await tool('east', 'answer_verified_question', { question: 'Revenue by region' }), await H.call('east', 'answer:card', { projectId: P, spec: REV })));
  ok('NEGATIVE CONTROL: the editor gets the args, the answer, and more rows', !!byQ((await tool('ed', 'list_verified_questions', {})).questions, 'West customers').aggregate);
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && DATABASE_URL=… node scripts/test-rowPolicyFanOut.js`. This fails if Task 1 skipped `hidden`; otherwise record that it passes.
- [ ] **Step 3: Implement** — nothing beyond Task 1, unless the test finds a gap.
- [ ] **Step 4: Run it to see it pass** — `DATABASE_URL=… node scripts/test-rowPolicyFanOut.js`, `DATABASE_URL=… node scripts/test-tokens-db.js`.
- [ ] **Step 5: Commit** — `git add scripts/test-rowPolicyFanOut.ts` · "Hold MCP's verified-question tools to the token user's row rules"

### Task 3: Docs and the skill

**Files:**
- Modify `docs/automation.md`: regenerate it with `npm run build:ts && node scripts/gen-automation-docs.js`.
- Modify `plugins/ordinate/skills/answer-data-questions/SKILL.md`:
  - the table at `:12-21` gains three rows;
  - a new section, "Check what the team signed off first", goes before "An ambiguous question" (`:47`).
- Modify `plugins/ordinate/README.md:10-13`: one line on verified questions.
- Modify `scripts/test-pluginSkills.ts:104-115`.

**Interfaces:** The skill section says:
1. Call `get_instructions` and follow it.
2. Call `list_verified_questions`. When one *is* the question, call `answer_verified_question` and say it is verified, and by whom. Quote its figures as returned.
3. A question that is only *near* a verified one is not that question. Answer it with `aggregate`, and say it is not a verified answer.

Its example line is ``- `answer_verified_question`: `{ "question": "Revenue by region" }` ``.

- [ ] **Step 1: Write the failing test** — `test-pluginSkills.ts`:
  ```ts
  const vArgs = JSON.parse(/- `answer_verified_question`: `(\{.*\})`/.exec(answer)![1]!);
  const v = await call('answer_verified_question', vArgs);
  const byRegion = await call('aggregate', { dataset: 'Retail orders', encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } });
  ok('answer-data-questions: the verified example answers, and agrees with aggregate', Object.is(v.series[0].values[v.labels.indexOf('West')], byRegion.series[0].values[byRegion.labels.indexOf('West')]) && v.verifiedBy.length > 0);
  ```
  `test-automation.ts` §7 (`:306-313`) holds the regenerated doc to `generateDocs(COMMANDS)`.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-pluginSkills.js` → `TypeError: Cannot read properties of null (reading '1')`, because there is no example yet.
- [ ] **Step 3: Implement** — the skill text and the README line, then regenerate the docs.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-pluginSkills.js`, `node scripts/test-automation.js`, `node scripts/test-automationTools.js`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add docs/automation.md plugins/ordinate scripts/test-pluginSkills.ts` · "Teach the answer-data-questions skill to check verified questions first"

## Existing tests that must stay green

`test-automation`, `test-automationTools`, `test-pluginSkills`, `test-rowPolicyFanOut` (with `DATABASE_URL`), `test-tokens-db` (with `DATABASE_URL`), `test-mcpPublish-db` (with `DATABASE_URL`), `test-verified`, `test-file-size`, `check-contracts`; every `__golden__` fixture (never re-recorded).
