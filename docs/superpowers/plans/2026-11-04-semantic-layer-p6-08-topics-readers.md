# Semantic layer part 6, step 08: Topics in Explore, the Assistant and MCP — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A topic narrows what people and agents see first: Explore's dataset picker and field list (with "Other fields" and "All datasets" one click away), the suggestions, the Assistant's facts and its `@` picker, and MCP's lists. Every figure stays the same with or without one.
**Architecture:** Readers only. Explore carries `topic=` in its URL and passes `topicId` to `explore:suggest`, which keeps suggestions inside the topic's fields. The topic's datasets and fields come from `model:navigation` (step 07). `copilot:ask`'s `Context.kind` gains `'topic'`, answered by new `src/ai/topicFacts.ts`: the topic's datasets in order, with their fields' notes, then its metrics and terms. MCP gains `list_topics` and an optional `topic` on `list_datasets`, `list_metrics`, `list_terms` and `describe_dataset`. `query_sql`, `aggregate` and `metric_value` take no topic, and their docs say so.
**Tech Stack:** zod contracts, `src/ipc`, `src/ai`, `src/automation`, React (Explore, the dock), Vitest, Playwright.
**Spec:** docs/semantic-layer/06-navigation.md (D14 remembering, D15, D16) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p6-00-index.md
**Branch and PR:** `feat/semantic-p6-08-topics-readers` off `origin/develop` after step 07 merges (and part 1 05b, for `list_terms`), one PR.

## Global Constraints

- **No figure changes.** No `visual:data` request carries a topic; Explore's ask with and without `topic=` is the same request. No door, export or SQL path reads a topic (D15).
- **Everything stays reachable.** A dataset outside the topic opens in Explore and answers; a field outside it is listed under "Other fields"; `query_sql` reads any dataset of the project.
- The Assistant's topic facts hold at most the topic's 12 datasets, in topic order, and replace the `dsList.slice(0, 12)` inventory (`src/ipc/copilot.ts:375`) only when a topic is the context. Fields outside the topic are named in one line per dataset, with no notes. No figure, so no ledger entry.
- A topic that is gone (deleted, or another project's id) answers as no topic: Explore shows All with no error, the Assistant falls back to the project inventory, and MCP raises `usage` "No topic called “<ref>”.".
- `src/ipc/copilot.ts` (605) takes at most 3 lines; `src/automation/handlers.ts` (336) and `registry.ts` (394) stay under 450.
- After `npm run build:ts`, run `node scripts/gen-automation-docs.js` (regenerates `docs/automation.md`). The plugin skill gets one row, and `test-pluginSkills` runs its example.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Same figures.** Explore's `visual:data` body is identical with and without `topic=`. → Task 1.
- **Reachability (D15).** `list_datasets` with a topic lists only its datasets, but `query_sql` and `describe_dataset` of a dataset outside it still answer. → Task 3.
- **Restricted callers.** Topic facts reuse the per-dataset column docs path (`catalogColumns`, the Share policy's `assistantColumnDocs`), so a restricted caller gets no value list a topic would otherwise carry. → Task 2.
- **An older pod.** It 400s `explore:suggest.topicId` and `copilot:ask` with `kind: 'topic'` (strict zod). The Explore page then shows its fields error with Retry and the dock its error; a reload reaches a newer pod. Nothing is stored.

## Rolling deploys

No stored field. `topic=` lives in Explore's URL and the remembered pick in `localStorage`; a dock context of `kind: 'topic'` is per tab, as every dock context is.

---

### Task 1: Explore reads the topic

**Files:** Modify:
- `src/api/explore.ts:9` (`topicId: Uuid.optional()`) and `src/ipc/explore.ts:17-21` (suggestions from the topic's fields of this dataset; the field groups unchanged);
- `web/src/features/explore/api.ts` (`useExploreFields(projectId, datasetId, topicId?)`, key + payload);
- `web/src/features/explore/ExplorePage.tsx` (`topic=` param; with no `dataset`, the topic's first dataset; with neither `q` nor `topic`, the remembered pick, set with `replace` as `:68` does);
- `web/src/features/explore/Explorer.tsx` (the Topic `Select` before Dataset; the dataset options are the topic's, plus the open one if it is outside; an "All datasets" link button clears `topic=`);
- `web/src/features/explore/FieldList.tsx` (`topicFields?`: the rest under a collapsed "Other fields (N)" disclosure);
- `web/src/features/explore/AskBox.tsx` (with a topic, `openDockWith(text, { projectId, context: { kind: 'topic', id, label: \`topic · ${name}\`, name } })`).

Test: extend `scripts/test-exploreSuggest.ts`, `web/src/features/explore/explore.test.tsx`, `web/e2e/explore.e2e.ts`.
**Interfaces:** Consumes `topicForReaders` (step 07), `useNavigation`, `rememberTopic` (step 07, `web/src/features/model/topics/rememberTopic.ts`). Produces `explore:suggest { projectId, datasetId, topicId? }` → the same reply shape, `suggestions` built by `exploreSuggest(meta.columns.filter(inTopicFields))` when the topic lists this dataset with `fields`, else unchanged.
- [ ] **Step 1: Write the failing test** — `test-exploreSuggest.ts`: with a topic listing Orders with `['region', 'revenue']`, every suggestion's category and values name only those two, and the `dimensions`, `dates` and `measures` lists equal the reply without a topic (`stableStringify`). A dataset the topic does not list gets the reply without a topic. An unknown `topicId` gets the same. The existing no-number walk passes over both replies. `explore.test.tsx`:
  - `?topic=T` lists the topic's datasets in its order in the Dataset select, and "All datasets" removes `topic=`;
  - the field list shows `region` and `revenue`, then a collapsed "Other fields (6)" that opens to the rest;
  - the `visual:data` payload with `topic=T` deep-equals the payload without it (negative control: dropping a filter changes it);
  - a remembered pick opens with `topic=` set by `replace` (history length unchanged);
  - a topic id `model:navigation` does not list draws as All with no error.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-exploreSuggest.js` → zod refuses `topicId`.
- [ ] **Step 3: Implement** — as in Files; `explore:suggest` stays one metadata read plus one topic read.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-exploreSuggest.js`, `npm run test:web -- explore`, `npm run build:web && npm --prefix web run e2e -- explore` (the e2e: create Sales over Retail orders' four fields through `topic:save`, open `?topic=`, see the four fields and "Other fields", and see a chart answer on a dataset outside the topic; RPC budget 25), `npm run lint`.
- [ ] **Step 5: Commit** — `git add src/api/explore.ts src/ipc/explore.ts scripts/test-exploreSuggest.ts web/src/features/explore web/e2e/explore.e2e.ts` · "Narrow Explore's datasets, fields and suggestions to a topic, with the rest one click away"

### Task 2: The Assistant reads a topic

**Files:** Create `src/ai/topicFacts.ts`. Modify `src/api/assistant.ts:22-28` (`'topic'` in `Context.kind`), `src/ipc/copilot.ts:182-190` (one branch before `kind === 'dataset'`), `web/src/features/assistant/ContextPicker.tsx:21` (`CONTEXT_ICON.topic = 'layers'`) and `:28-37` (a "Topics" group first, from `useNavigation`). Test: extend `scripts/test-copilot.ts`, `web/src/features/assistant/dockScreens.test.tsx`.
**Interfaces:** Consumes `copilot.projectFacts` (`src/ai/copilotFacts.ts:530`), `catalogColumns` and `liveInventoryNotes` (the inventory path at `src/ipc/copilot.ts:375-386`), `closedToCaller`, `describeDefinitionShort`, part 1's `termLines`. Produces `topicFacts(projectId: string, id: string, emit: ActivityEmit): Promise<CopilotFacts | null>` (null: no such topic, so `buildFacts` falls through to the inventory). Its facts are, in order:
1. `projectFacts` over the topic's datasets in topic order, each with the topic's fields (all, without `fields`) and that path's docs and notes;
2. for a dataset with `fields`, one line `- Orders also has, outside this topic: a, b, c`;
3. the topic's metrics, one line each, `- Metric Revenue: <describeDefinitionShort>`;
4. its terms, through `termLines`.

`emit({ kind: 'read', label: 'Read the topic Sales' })` once.
- [ ] **Step 1: Write the failing test** — `test-copilot.ts`, through `buildFacts(P, { kind: 'topic', id: T })`:
  - the schema blocks name Orders then Regions (topic order), and Orders lists `region` and `revenue` only;
  - the "outside this topic" line names the other columns;
  - `Metric Revenue:` and the term's line are present;
  - a 13-dataset project whose topic lists its 12th and 13th datasets carries both, which the inventory's `slice(0, 12)` would miss;
  - a deleted topic gives the inventory facts exactly (`Object.is` on the text);
  - in the suite where part 1 step 06 pinned `assistantColumnDocs` for a caller `closedToCaller` (its value-label canary), topic facts built as that caller hold no withheld value list. NEGATIVE CONTROL: the editor's do.
  
  `dockScreens.test.tsx`: `@` lists a "Topics" group with Sales; picking it sends `copilot:ask` with `context: { kind: 'topic', id: T }`.
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-copilot.js` → `FAIL topic facts: topic order`.
- [ ] **Step 3: Implement** — `if (kind === 'topic' && id) { const f = await topicFacts(projectId, id, emit); if (f) return f; }`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-copilot.js`, `node scripts/test-copilot-analysis-facts.js`, `node scripts/test-numberAudit.js`, `node scripts/check-contracts.js`, `npm run test:web -- assistant dockScreens dockRoute`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add src/ai/topicFacts.ts src/api/assistant.ts src/ipc/copilot.ts scripts/test-copilot.ts web/src/features/assistant` · "Let the Assistant answer about a topic: its datasets in order, their fields, its metrics and terms"

### Task 3: MCP

**Files:** Create `src/automation/topicRef.ts`. Modify `src/automation/registry.ts:159-216` (`list_topics`; a `topic` arg on `list_datasets`, `describe_dataset`, `list_metrics` and part 1's `list_terms`; the `list_topics` summary says what ignores topics), `src/automation/handlers.ts` (`topicsList`; the four handlers take `topic?`), `docs/automation.md` (regenerated), `plugins/ordinate/skills/answer-data-questions/SKILL.md` (one row). Test: extend `scripts/test-automationTools.ts`, `scripts/test-pluginSkills.ts` (the new example).
**Interfaces:** Produces
- `list_topics` (readOnly, no args) → `[{ id, name, description, datasets: [{ name, fields: string[] | null }], metrics: string[], terms: string[] }]`, stale members dropped. Summary: "List the project's topics: each a team's short list of datasets, fields, metrics and terms. A topic orders and narrows lists only; query_sql, aggregate and metric_value read every dataset whatever the topic."
- `topic: { type: 'string', description: 'Topic name or id: list its members only, in its order.' }` on the four tools.
  - `list_datasets`, `list_metrics` and `list_terms` return only the topic's members, in its order.
  - `describe_dataset` returns every column, the topic's fields first, each with `inTopic: boolean`. Without `topic` there is no `inTopic` key, so the reply is byte-identical to today's.
- `resolveTopicRef(projectId, ref): Promise<Topic>` — an id, or a name matched ignoring case; otherwise `AutomationError('usage', 'No topic called "<ref>".')`.
- [ ] **Step 1: Write the failing test** — `test-automationTools.ts`, on the sample with a topic "Sales" over Retail orders' `region`, `state`, `revenue` and the metric Revenue:
  ```ts
  ok('list_topics', (await call('list_topics', {}))[0].datasets[0].fields.join() === 'region,state,revenue');
  ok('list_datasets with a topic lists its datasets only', (await call('list_datasets', { topic: 'sales' })).map((d) => d.name).join() === 'Retail orders');
  ok('list_metrics with a topic', (await call('list_metrics', { topic: 'Sales' })).map((m) => m.name).join() === 'Revenue');
  ok('describe_dataset: topic fields first, nothing left out', ((d) => d.columns.slice(0, 3).every((c) => c.inTopic) && d.columns.length === ALL_COLS)(await call('describe_dataset', { dataset: 'Retail orders', topic: 'Sales' })));
  ok('NEGATIVE CONTROL: without a topic, no inTopic key', !('inTopic' in (await call('describe_dataset', { dataset: 'Retail orders' })).columns[0]));
  ok('D15: query_sql over a column outside the topic answers', (await call('query_sql', { sql: 'SELECT customer_segment, count(*) FROM retail_orders GROUP BY 1', limit: 5 })).rowCount > 0);
  ok('an unknown topic is a usage error', (await refusal('list_datasets', { topic: 'Nope' })).code === 'usage');
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-automationTools.js` → `list_topics` is not a tool.
- [ ] **Step 3: Implement** — then `node scripts/gen-automation-docs.js`. The skill row: "Many datasets? Start with `list_topics`, then `list_datasets` with `topic`. A topic narrows lists only; `query_sql` still reads every dataset."
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-automationTools.js`, `node scripts/test-automation.js`, `node scripts/test-pluginSkills.js`, `node scripts/test-serverDocs.js`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add src/automation docs/automation.md plugins/ordinate scripts/test-automationTools.ts scripts/test-pluginSkills.ts` · "Add list_topics and an optional topic to MCP's lists"

## Existing tests that must stay green

`test-exploreSuggest`, `test-copilot`, `test-copilot-analysis-facts`, `test-numberAudit`, `test-automation`, `test-automationTools`, `test-pluginSkills`, `test-serverDocs`, `test-topics`, `check-contracts`; web `explore.test.tsx`, `spec.test.ts`, `assistant.test.tsx`, `dockScreens.test.tsx`, `dockRoute.test.tsx`; e2e `explore`, `dock`.
