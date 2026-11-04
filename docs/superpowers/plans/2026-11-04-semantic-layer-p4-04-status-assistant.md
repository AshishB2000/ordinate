# Semantic layer part 4, step 04: status in the Assistant and MCP: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Assistant and MCP agents prefer certified metrics, terms and datasets, by code. A retired one leaves the model's vocabulary unless the question names it exactly. Then the figure is computed as asked and a server sentence says what replaces it.
**Architecture:** The vocabulary builders read 01's `statusFor` once per request and carry `status`: `factMetrics` (`src/ipc/copilot.ts:152`), part 1's term facts (`src/ai/termFacts.ts`), the plan facts (`src/analysis/planFacts.ts:103`) and `specMetrics` (`src/ipc/answers.ts:251`). They order certified first and drop retired unless named. A small `src/analysis/statusNotes.ts` adds the retired sentence to an answer card's `notes` and to `metric_value`. The MCP list tools return status fields.
**Tech Stack:** `src/ipc/copilot.ts`, `src/ai/copilotFacts.ts`, `src/ipc/answers.ts`, `src/analysis/planFacts.ts`, `src/automation/`, `docs/automation.md`.
**Spec:** docs/semantic-layer/04-governance.md (D9, D10) · Index: 2026-11-04-semantic-layer-p4-00-index.md
**Branch:** `feat/semantic-p4-04-status-assistant` off `origin/develop` after 02 merges (it does not need 03).

## Global Constraints
- **Correctness never rests on the model.** The order and the omission are code. The prompt's "prefer certified" line is a hint on top of them.
- No figure changes: a retired metric still computes everywhere (D6). The note is a server sentence through `t()` (`src/analysis/statusMessages.ts`), never a model's words.
- **No matcher needs ranking.** Metric and term names are unique and matched exactly (`answerSpec.resolveMeasure` `:189-230`, part 1's term match, `automation/resolve.pick` `:29`), and `answerSuggest.candidates` (`:64-76`) offers no metrics. So D9's "rank where code picks" is the vocabulary order only. Re-check this when a fuzzy metric matcher is added.
- `src/ipc/copilot.ts` (605) and `src/ai/copilotFacts.ts` (577) take one-line changes. `src/ipc/answers.ts` (510) takes one call.
- "Names it exactly" means the question contains the metric's name, or one of a term's names or aliases, case-insensitive and bounded by non-letters. It is one pure helper, `namedIn(question, name)`, in `statusNotes.ts`.

## Review Focus
- A retired metric that a question names is still computed, and its card carries the note (Task 2). One that is not named is absent from the facts text (Task 1).
- MCP replies to a project without status are byte-identical, so `docs/automation.md` changes only in descriptions (Task 3).

---

### Task 1: The Assistant's vocabulary carries status
**Files:** Create `src/analysis/statusNotes.ts` · Modify `src/ipc/copilot.ts:152-170` (`factMetrics(projectId, datasetId?, scope?, question?)`), `:177-185` (`buildFacts(projectId, context, emit, question?)`), `:505` (pass `q`), `src/ai/copilotFacts.ts:115-133` (`FactMetric.status?`, `replacedBy?`, one clause in `metricLines`), part 1's `src/ai/termFacts.ts` (`FactTerm.status?`, the same clause), `src/analysis/planFacts.ts:103` (the metric line), `src/ipc/draftFacts.ts:41` (status onto the metrics it reads) · Test `scripts/test-copilot.ts`, `scripts/test-copilot-analysis-facts.ts`
**Interfaces:** Produces
```ts
export function namedIn(question: string | undefined, names: readonly string[]): boolean;
export function vocabularyOrder<T extends { status?: { state: StatusState } }>(items: T[], keepRetired: (t: T) => boolean): T[]; // certified, none/needs_review, then retired that keepRetired allows
export async function retiredNotes(projectId: string, refs: readonly string[]): Promise<string[]>; // "Gross revenue is retired; Net revenue replaces it." / "Gross revenue is retired."
```
`metricLines` writes `- "Revenue" (certified) = …`. A retired one, kept because it was named, gets `(retired; use "Net revenue")`. The header gains "Prefer a certified metric when several fit." `needs_review` adds no clause: it is still the project's definition.
- [ ] **Step 1: Write the failing test**
```ts
await certifyNow(P, `metric:${NET}`); await statusStore.retire(P, `metric:${GROSS}`, `metric:${NET}`, '');
const f = (await buildFacts(P, { kind: 'dataset', id: D }, NO_ACTIVITY, 'how is revenue doing')).text;
ok('certified first in the facts', f.indexOf('"Net revenue" (certified)') > -1 && f.indexOf('"Net revenue"') < f.indexOf('"Plain"'));
ok('a retired metric the question does not name is not in the vocabulary', !f.includes('"Gross revenue"'));
const g = (await buildFacts(P, { kind: 'dataset', id: D }, NO_ACTIVITY, 'what was Gross revenue last month')).text;
ok('named exactly, it is kept and says what replaces it', g.includes('"Gross revenue" (retired; use "Net revenue")'));
ok('NEGATIVE CONTROL: with no status the facts text is byte-identical to before', (await factsWithStatusOff()) === (await factsBaseline()));
ok('the dashboard draft facts mark certified too', (await draftFactsText(P)).includes('(certified)'));
ok('namedIn is bounded by non-letters', !namedIn('Gross revenues', ['Gross revenue']) && namedIn('gross revenue?', ['Gross revenue']));
```
`factsBaseline` is the facts text captured on the fixture before any status write.
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-copilot.js` fails, because there is no `(certified)`.
- [ ] **Step 3: Implement.** `factMetrics` calls `statusFor(projectId)` once and attaches `status` and `replacedBy` (the replacement's name). It then applies `vocabularyOrder(list, (m) => namedIn(question, [m.name]))`. Term facts do the same with `[name, ...aliases]`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-copilot.js && node scripts/test-copilot-analysis-facts.js && node scripts/test-answerFacts.js && node scripts/test-terms.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src/analysis/statusNotes.ts src/ipc/copilot.ts src/ai src/analysis/planFacts.ts src/ipc/draftFacts.ts scripts` · "Give the Assistant certified metrics and terms first, and retired ones only when asked by name"

### Task 2: An answer on a retired metric says what replaces it
**Files:** Modify `src/ai/answerSpec.ts:76-84` (`SpecMetric.status?`), `src/ipc/answers.ts:251-265` (`specMetrics` orders by `vocabularyOrder(list, () => true)`: the validator keeps every metric, because a spec naming a retired one must still compute) and `:202` (the card's `notes` gain `await retiredNotes(projectId, spec.measures.flatMap((m) => m.metricId ? ['metric:' + m.metricId] : []))`) · Test `scripts/test-answerSpec.ts`, `scripts/test-askDidYouMean.ts` (the stubbed model at `analyze.askCopilot`)
**Interfaces:** Consumes `retiredNotes`. The card's `notes` is today's list with the sentences appended. It is unchanged when no measure is retired.
- [ ] **Step 1: Write the failing test**
```ts
const card = await computeCard(P, { ...SPEC, measures: [{ column: 'gross', aggregation: 'sum', metricId: GROSS }] });
ok('the card computes the retired metric as asked', card.ok && sameFigure(card, await computeCard(P, { ...SPEC, measures: [{ column: 'gross', aggregation: 'sum' }] })));
ok('…and says what replaces it, in the app\'s words', card.card.notes.includes(retiredNote('Gross revenue', 'Net revenue')));
ok('NEGATIVE CONTROL: a certified metric adds no note', !(await computeCard(P, specOn(NET))).card.notes.some((n) => /retired/.test(n)));
ok('specMetrics lists certified first and keeps the retired one', stableStringify((await specMetrics(P)).map((m) => m.name)) === stableStringify(['Net revenue', 'Plain', 'Gross revenue']));
```
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-answerSpec.js` fails, because there is no note.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-answerSpec.js && node scripts/test-askDidYouMean.js && node scripts/test-askFollowUp.js && node scripts/test-liveRouteAnswers.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src/ai/answerSpec.ts src/ipc/answers.ts scripts` · "Say on an answer card when its metric is retired and what replaces it"

### Task 3: MCP returns status
**Files:** Modify `src/automation/handlers.ts:68-84` (`datasetsList`), `:91-116` (`datasetsDescribe`), `:189-198` (`metricsList`: status fields, certified first), `:200-209` (`metricValue`: on a retired metric add `status: 'retired'` and `replacedBy`), part 1's `termsList`, `src/automation/registry.ts:159-218` (each tool's description gains one clause, "status: certified, needs_review or retired"), `src/automation/mcp.ts:68-71` (one more sentence in `instructions`), `docs/automation.md` (regenerated), `plugins/ordinate/skills/answer-data-questions/SKILL.md` (one line: prefer certified) · Test `scripts/test-automationTools.ts`, `scripts/test-automation.ts` (`:307-309` compares the committed docs), `scripts/test-pluginSkills.ts`
**Interfaces:** Each item with a status gains `status`, `certifiedBy?`, `certifiedAt?` and `replacedBy?` (a name). Items without a status are unchanged. The `instructions` sentence: "Prefer a metric, term or dataset whose status is certified; a retired one names what replaces it."
- [ ] **Step 1: Write the failing test.**
  - `ok('list_metrics: certified first with who and when', r[0].name === 'Net revenue' && r[0].status === 'certified' && r[0].certifiedBy === EMAIL)`
  - `ok('metric_value on a retired metric: the figure, plus what replaces it', v.value === GROSS_VALUE && v.status === 'retired' && v.replacedBy === 'Net revenue')`
  - `ok('NEGATIVE CONTROL: a project without status lists exactly as before', stableStringify(await tool('list_metrics', P0)) === BASELINE)`
  - `ok('the server instructions mention certified', init.result.instructions.includes('certified'))`
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-automationTools.js` fails, because there is no `status`.
- [ ] **Step 3: Implement.** One `statusFor` per tool call.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/gen-automation-docs.js && node scripts/test-automationTools.js && node scripts/test-automation.js && node scripts/test-pluginSkills.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src/automation docs/automation.md plugins/ordinate scripts` · "Return status from the MCP tools and tell agents to prefer certified items"

Not in this step: hiding metrics that read a hidden column from the Assistant (06), or verified questions citing certified metrics (part 3, which consumes `statusFor`).
