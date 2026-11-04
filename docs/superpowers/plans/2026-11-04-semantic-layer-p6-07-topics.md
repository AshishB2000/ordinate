# Semantic layer part 6, step 07: Topics — the record, `topic:*`, and the Data model's picker and drawer — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A topic ("Sales") is a named, ordered short list of a project's datasets (each with an optional field subset), metrics and terms. Editors write it in a drawer on the Data model section; a picker in that section's header narrows its four tabs; and it never limits access to anything.
**Architecture:** A new project record kind `topic` (`src/analysis/topics.ts`), stored like part 1's terms: recordFs, the edit-conflict tag (`SaveKind 'topic'`), Trash, the bundle. Readers get the topic with stale members dropped (`topicForReaders`), never an error. `model:navigation` (step 01) gains `topics`, so the header picker costs no extra read. No figure path reads a topic.
**Tech Stack:** recordFs, zod contracts, `src/app` (record kinds, Trash, bundle rules), React (Data model section), Vitest, Playwright.
**Spec:** docs/semantic-layer/06-navigation.md (D14, D15, D16 Data model row; owner's answer 3) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p6-00-index.md
**Branch and PR:** `feat/semantic-p6-07-topics` off `origin/develop` after step 06 merges, one PR.

## Global Constraints

- Shape exactly D14: `{ id, projectId, name, description?, datasets: { id, fields? }[], metricIds, termIds, updatedBy, updatedAt, schemaVersion: 1 }`. Name 1–80 characters, trimmed, unique case-insensitively in the project. Description ≤ 500. At most 12 datasets (the Assistant's cap), each listed once, with at most 500 fields; at most 100 metric ids and 100 term ids; at most 50 topics per project. No `fields` means all fields.
- **A topic is never access control (D15).** No door reads a topic, and no reply is narrowed by one except the lists it orders. The copy never says hidden, restricted or private. "All datasets", "Show all" and "Other fields" are always one click away.
- Save refuses a member that does not exist (the editor only offers existing ones). Reading drops a member that has gone, counts it in `stale`, and never errors or writes on read.
- Editing needs project `write`; reading is any project reader's (`topic:get` and `model:navigation` are `META`).
- `updatedBy` is stamped in main (`osUser()`), never read off the payload.
- The last pick is remembered per browser and project in `localStorage` key `ordinate.topic:<projectId>`, every access in try/catch, like `ordinate.dockProject` (`web/src/features/assistant/dockState.ts:29`).
- Sentences in new `src/analysis/topicMessages.ts` (added to `MAIN_FILES`). `src/api/index.ts` is append-only. `'../ipc/topics'` joins the array at `src/server/app.ts:570`.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Mistaken for access control.** A dataset outside every topic answers `visual:data` byte-identically before and after a topic exists. → Task 2 pins it.
- **Stale members.** A deleted dataset, metric or term, or a field dropped by a refresh, disappears from the topic for readers and is counted for the editor. → Task 1.
- **Two editors.** The second save with a stale base is a 409 `record_changed`, shown by the house conflict banner. → Tasks 1, 3.
- **Old pods.** They never read `topics/`. Their bundle export leaves topics out, and their import refuses a bundle that holds them. → documented in Task 2.

## Rolling deploys

| New record | A pod of the previous release | Why it is safe |
|---|---|---|
| `topics/<id>.json` | never reads or writes it; Trash lists skip the type (`trashStore.listEntries` → `isRecordType`); a bundle export leaves it out; a bundle import refuses a bundle holding it (`bundleRules.ts` whitelist) | no figure reads a topic; the bundle gap is one line in `docs/server/upgrade.md` |

---

### Task 1: The topic record, its Trash and its bundle entry

**Files:** Create `src/analysis/topics.ts`, `src/analysis/topicMessages.ts`, `scripts/test-topics.ts` (temp `DATA_DIR`, the `handlers` map, as part 1's `test-terms`). Modify:
- `src/app/recordKinds.ts:15-26` (`'topic'`, `RECORD_DIR.topic = 'topics'`); `src/server/admin/auditNames.ts` (whatever `tsc` asks for the new kind);
- `src/api/trash.ts:5` (the enum);
- `src/app/bundleRules.ts:31-62` (`topics/<uuid>.json`, count `topics`);
- `src/analysis/recordDiff.ts:42-59` (`SaveKind` + `SAVE_KEYS.topic = ['name', 'description', 'datasets', 'metricIds', 'termIds']`);
- `web/src/features/editConflicts/useEditGuard.ts:15` (`GuardType` + `'topic'`);
- `web/src/features/projects/api.ts`, `web/src/features/projects/TrashPage.tsx:24` (`topic: { word: 'Topic', icon: 'layers' }`);
- `scripts/i18n-extract.ts` (`MAIN_FILES`).

**Interfaces:** Produces, mirroring part 1's `src/analysis/terms.ts`:
```ts
export interface Topic { id: string; projectId: string; name: string; description?: string; datasets: { id: string; fields?: string[] }[]; metricIds: string[]; termIds: string[]; updatedBy: string; updatedAt: string; schemaVersion: 1 }
export interface TopicInput { name: string; description?: unknown; datasets: unknown; metricIds?: unknown; termIds?: unknown }
export async function listTopics(projectId: string): Promise<Topic[]>;                      // by name, locale-aware; corrupt ones skipped
export async function readTopic(projectId: string, id: string): Promise<Tagged<Topic> | null>;
export async function saveTopic(projectId: string, input: TopicInput): Promise<Topic>;
export async function updateTopic(projectId: string, id: string, input: TopicInput, base?: unknown): Promise<Topic | null>; // lockedUpdate('topic', …)
export async function topicProblem(projectId: string, input: TopicInput, exceptId?: string): Promise<{ field: 'name' | 'datasets' | 'metricIds' | 'termIds'; error: string } | null>;
export async function topicForReaders(projectId: string, t: Topic): Promise<{ topic: Topic; stale: number }>; // gone members dropped, in order
```
Sentences: `topicNameTaken(name)` "This project already has a topic called “{name}”.", `topicTooManyDatasets(n)` "A topic holds at most {n} datasets.", `tooManyTopics(n)` "A project holds at most {n} topics.", `topicMemberGone()` "Something in this topic no longer exists. Reopen it and save again."
- [ ] **Step 1: Write the failing test** — `scripts/test-topics.ts`:
  ```ts
  const t = await topics.saveTopic(P, { name: ' Sales ', datasets: [{ id: ORDERS, fields: ['region', 'revenue'] }, { id: REGIONS }], metricIds: [REV], termIds: [] });
  ok('saved, trimmed, ordered', t.name === 'Sales' && t.datasets.map((d) => d.id).join() === `${ORDERS},${REGIONS}` && t.schemaVersion === 1);
  ok('a name is unique, ignoring case', (await topics.topicProblem(P, { name: 'sales', datasets: [] }))!.error === topicNameTaken('sales'));
  ok('thirteen datasets are refused', (await topics.topicProblem(P, { name: 'Big', datasets: THIRTEEN }))!.field === 'datasets');
  ok('a member that does not exist is refused on save', (await topics.topicProblem(P, { name: 'X', datasets: [{ id: uuid(999) }] }))!.error === topicMemberGone());
  await datasets.deleteDataset(P, REGIONS); await metrics.deleteMetric(P, REV);
  await reimportWithout(P, ORDERS, 'region'); // the column gone from the dataset, as part 1's test-tableDocs drops its key column
  const r = await topics.topicForReaders(P, (await topics.readTopic(P, t.id))!.rec);
  ok('stale members drop on read, counted, in order', r.stale === 3 && stableStringify(r.topic.datasets) === stableStringify([{ id: ORDERS, fields: ['revenue'] }]) && r.topic.metricIds.length === 0);
  ok('NEGATIVE CONTROL: reading wrote nothing', stableStringify((await topics.readTopic(P, t.id))!.rec) === stableStringify(t));
  ok('a stale base is a 409', isRecordChanged(await caught(() => topics.updateTopic(P, t.id, { ...IN, name: 'Y' }, 'stale'))));
  ok('Trash: delete → listed → restore → readable', await trashRoundTrip(P, 'topic', t.id));
  ok('the bundle carries topics', ruleFor(`topics/${t.id}.json`)?.count === 'topics');
  ```
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-topics.js` → "Cannot find module '../src/analysis/topics'".
- [ ] **Step 3: Implement** — the metric store's id guards, atomic write and skip-corrupt behaviour. `normalize` dedupes dataset ids (first wins) and clips every list to its cap. Then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-topics.js`, `node scripts/test-trash.js`, `node scripts/test-bundle.js`, `node scripts/test-editConflicts.js`, `node scripts/test-i18n.js`, `npm run test:web -- editors TrashPage`.
- [ ] **Step 5: Commit** — `git add src/analysis/topics.ts src/analysis/topicMessages.ts src/app/recordKinds.ts src/server/admin/auditNames.ts src/api/trash.ts src/app/bundleRules.ts src/analysis/recordDiff.ts web/src/features/editConflicts web/src/features/projects scripts/i18n-extract.ts src/i18n scripts/test-topics.ts` · "Add the topic record: a team's ordered short list of the project's data"

### Task 2: `topic:get`, `topic:save`, `topic:delete`, and topics in `model:navigation`

**Files:** Create `src/api/topics.ts`, `src/ipc/topics.ts`. Modify `src/api/index.ts` (append), `src/server/app.ts:570`, `src/ipc/modelNavigation.ts` (step 01: `topics`), `scripts/rowPolicyReaders.ts` (`'topic:get': 'META'`), `scripts/columnAccessReaders.ts` (part 4 p4-06's `COLUMN_TREATMENT`, merged earlier in release B) (`'topic:get': 'META'`), `scripts/test-rowPolicySafetyNet.ts`, `docs/server/upgrade.md` (the bundle line). Test: extend `scripts/test-topics.ts`, `scripts/test-modelNavigation.ts`.
**Interfaces:** Produces (zod, project scope):
- `topic:get` (read `{ projectId, id }`) → `{ ok: true; topic: Topic; tag: string; stale: number } | { ok: false; error }`. The topic comes back as stored: the editor removes what is stale and says so.
- `topic:save` (write `{ projectId, id?: Uuid, base?: Base, topic: { name: z.string().min(1).max(80), description: z.string().max(500).optional(), datasets: z.array(z.strictObject({ id: Uuid, fields: z.array(z.string().min(1).max(256)).max(500).optional() })).max(12), metricIds: z.array(Uuid).max(100), termIds: z.array(Uuid).max(100) } }`). It creates without `id` and updates with one. The reply is `{ ok: true; topic; tag } | { ok: false; error; field }`, and a stale base is the route's 409.
- `topic:delete` (write `{ projectId, id }`) → to Trash.
- `model:navigation` gains `topics: NavTopic[]` with `export interface NavTopic { id; name; description?; datasets: { id: string; fields?: string[] }[]; metricIds: string[]; termIds: string[] }`, each through `topicForReaders`, in `listTopics` order.
- [ ] **Step 1: Write the failing test** — `test-topics.ts` § channels: save → get gives `tag` and `stale: 0`; an update with that tag succeeds and one with the old tag is refused 409; delete → `model:navigation` no longer lists it. D15 pinned: `visual:data` on a dataset in no topic, asked before any topic exists and again after two exist, is `Object.is`-equal cell by cell. `test-modelNavigation.ts`: `topics[0].datasets` drops a deleted dataset. `test-rowPolicySafetyNet.ts`: the restricted viewer `east` reads `topic:get` and `model:navigation`'s topics; its `topic:save` is 403 (NEGATIVE CONTROL: the editor's is 200).
- [ ] **Step 2: Run it to see it fail** — `npm run build:ts && node scripts/test-topics.js` → `No handler for topic:save`; `node scripts/check-contracts.js` lists three unresolved.
- [ ] **Step 3: Implement** — handlers as `src/ipc/terms.ts` (part 1 05b) has them: `topicProblem` first, then save or `updateTopic(…, base)`; `isRecordChanged` rethrown for the route's 409. In `docs/server/upgrade.md`, one line under part 1's 05a section: a server older than this release leaves topics out of a project bundle it exports, and refuses to import one that holds them.
- [ ] **Step 4: Run it to see it pass** — `node scripts/test-topics.js`, `node scripts/test-modelNavigation.js`, `node scripts/check-contracts.js` (0), `DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js`, `node scripts/test-serverDocs.js`, `npm run lint`.
- [ ] **Step 5: Commit** — `git add src/api/topics.ts src/api/index.ts src/ipc/topics.ts src/ipc/modelNavigation.ts src/server/app.ts scripts/rowPolicyReaders.ts scripts/test-rowPolicySafetyNet.ts scripts/test-topics.ts scripts/test-modelNavigation.ts docs/server/upgrade.md` · "Serve topics to every project reader and let editors save them"

### Task 3: The Data model's topic picker and drawer

**Files:** Create `web/src/features/model/topics/api.ts`, `TopicPicker.tsx`, `TopicDrawer.tsx`, `FieldSubset.tsx`, `rememberTopic.ts`, `Topics.module.css`, `topics.test.tsx`. Modify `web/src/features/model/DataModelPage.tsx` (part 1 step 10: the picker in the header; the narrowed topic passed to each tab), `datasets/DatasetsTab.tsx`, `metrics/MetricsTab.tsx`, `terms/GlossaryTab.tsx`, and the Relationships tab's mount (each takes `topic?: NavTopic`).
**Interfaces:** Consumes `useNavigation` (step 01), `topic:get`/`save`/`delete`, `useEditGuard('topic')` + `ConflictBanner`, `useDatasets`, `useDatasetColumns`, `metric:list`, `term:list` (part 1), `useCanEdit`. Produces
- `TopicPicker({ projectId, value, onChange })` — a `Select` labelled "Topic", with "All" first and then the topics. An editor also gets "New topic…" and, with a topic picked, "Edit Sales…". The pick is `?topic=` (set with `replace`), falling back to `rememberTopic.read(projectId)`. A remembered id that no longer exists reads as All.
- Narrowing, each tab drawing the topic's members only, in the topic's order:
  - Datasets: the list (and its strip's items);
  - Metrics: rows in `metricIds`;
  - Glossary: `termIds`;
  - Relationships: edges with both ends in the topic.
  
  Each narrowed tab carries the line `Sales · 3 of 9 metrics · Show all`, where "Show all" sets All.
- `TopicDrawer({ projectId, id?, onClose })` — a side `Sheet` titled "Topic · Sales" (or "New topic"):
  - Name and Description.
  - Datasets: checkboxes in `dataset:list` order, the picked ones orderable with move up and down. It says "up to 12", and the 13th checkbox is disabled with that reason. Each picked dataset has a `FieldSubset` popover, "8 of 12 fields", of column checkboxes; all checked means no `fields`.
  - Metrics and Terms: checkbox lists.
  - The note, verbatim: "Topics tidy what people see first. They don't limit access: anyone who can open this project can still reach every dataset. Use project sharing or row access rules for that."
  - With `stale > 0`, "2 items no longer exist. Saving removes them."
  - Save, which shows the server's sentence under its field, and Delete (confirmed; to Trash).
- States: the picker skeleton while `model:navigation` loads. A failed `model:navigation` hides the picker (the tabs draw unnarrowed) with no error. The drawer has a skeleton, and an `ErrorState` with Retry for `topic:get`. An editor with no topics sees the picker read "All" with "New topic…"; a viewer with none sees no picker.
- [ ] **Step 1: Write the failing test** — `topics.test.tsx` (part 1's `model.test.tsx` `serve()`):
  - picking Sales puts `topic=` in the URL and the Metrics tab lists Revenue and Profit only, with `Sales · 2 of 5 metrics · Show all`; Show all lists five;
  - a reload with no `topic=` reopens Sales from `localStorage`, and a throwing `localStorage` (a stub) still renders All;
  - "New topic…" → name, two datasets, a field subset, Save sends `topic:save` with `datasets[0].fields` of the two checked and no `fields` on the dataset left whole;
  - a 13th dataset checkbox is disabled;
  - the D15 note is present word for word, and no text on the page matches `/hidden|restrict|private/i` (negative control on the copy);
  - `stale: 2` shows the stale line and a save sends the cleaned lists;
  - a 409 shows the conflict banner and keeps the drawer;
  - a viewer sees the picker but no "New topic…" or "Edit";
  - `model:navigation` answering 404 shows no picker and every tab unnarrowed.
- [ ] **Step 2: Run it to see it fail** — `npm run test:web -- topics` → "Cannot find module './topics/TopicPicker'".
- [ ] **Step 3: Implement** — `useWrite('topic:save', ['model:navigation', 'topic:get'])`; tokens only; the drawer stacks to one column at 375 px.
- [ ] **Step 4: Run it to see it pass** — `npm run test:web`, `npm run lint`, `npm --prefix web run size`.
- [ ] **Step 5: Commit** — `git add web/src/features/model` · "Pick a topic in the Data model's header, and write one in its drawer"

### Task 4: One e2e

**Files:** Modify `web/e2e/model.e2e.ts` (part 1): a test `data model: topics`.
**Interfaces:** Create the topic "Sales" from the header (Retail orders with 4 fields, Revenue, one term). Pick it: the Datasets list holds Retail orders only and the Metrics tab Revenue only. Reload: it is still picked. Show all clears it. Delete it: the Trash page (`/trash`) lists it as a "Topic". Shot `model-topic`, both themes; RPC budget 25 per load.
- [ ] **Step 1: Write the failing test** — as above.
- [ ] **Step 2: Run it to see it fail** — `npm run build:web && npm --prefix web run e2e -- model` → no "Topic" select.
- [ ] **Step 3: Implement** — nothing beyond Task 3; fix what the run shows.
- [ ] **Step 4: Run it to see it pass** — `npm --prefix web run e2e -- model`, `DATABASE_URL=… npm --prefix web run e2e -- view-only-routes`; look at both `model-topic` screens.
- [ ] **Step 5: Commit** — `git add web/e2e/model.e2e.ts` · "Cover topics in the Data model end to end"

## Existing tests that must stay green

`test-trash`, `test-bundle`, `test-editConflicts`, `test-terms`, `test-metrics`, `test-modelNavigation`, `test-modelOverview`, `test-rowPolicySafetyNet`, `test-serverDocs`, `test-i18n`, `test-file-size`, `check-contracts`; web `model.test.tsx`, `metrics.test.tsx`, `glossary.test.tsx`, `defaultJoins.test.tsx`, `editors.test.tsx`, `doors.test.tsx`; e2e `model`, `view-only-routes`.
