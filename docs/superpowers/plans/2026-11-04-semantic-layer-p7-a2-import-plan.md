# Semantic layer part 7, step a2: the import dry run and its merge matrix — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `model:importPlan` reads an uploaded model zip and says, object by object, what an import would do (unchanged, updated, renamed, new, conflict, skipped with why, only here) with a field-level diff and a hash of the plan, writing nothing and keeping nothing in memory.
**Architecture:** Three new pure-ish modules in `src/app/`: `modelRead.ts` (zip or inline files → whitelisted shapes, through a1's `MODEL_POLICY` and `parseBounded`), `modelMatch.ts` (datasets by id then exact name, everything else by id then exact name, and the id map between file and project), `modelPlan.ts` (the three-way rule, the editor's own gates, the hash). The project side is read with a1's `exportModel`, so both sides are compared in one shape. The handler joins `src/ipc/modelFiles.ts`.
**Tech Stack:** `src/app`, `src/ipc`, `src/api` (zod), self-checks.
**Spec:** docs/semantic-layer/07-portability.md (D4, D5, D7, Tests "Merge matrix", "Leaks") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-a2-import-plan` off `origin/develop` after a1 merges. One PR. Release 1.

## Global Constraints

- **Stateless (any pod).** The plan is computed from the upload and the stores on every call; nothing is cached. `resolveUpload` (`src/server/files.ts:132`) tokens are single-use, so a3's apply uploads the zip again.
- **Reading.** `openZip({ file }, MODEL_POLICY)` (`src/app/zipReader.ts:107`); each JSON entry through `parseBounded` (`src/app/jsonBudget.ts:86`). A refused name, a size past its cap, an unreadable `model.json`, `format !== 'ordinate-model'` or `formatVersion > MODEL_VERSION` refuses the whole file with a sentence. One malformed object (a metric file that is not an object, a bad id) is a `skipped: invalid` item, never a whole-file refusal.
- **Matching (D4).** Datasets: by id, then exact name. A file dataset with no match is skipped (`dataset_missing`) together with every object that references it, each listed (`depends_on_skipped`); datasets are never created or deleted. Terms, metrics, relationships: by id, then exact name (relationships: by id, then the same `from`/`to` pair through `sameEdge`, `src/analysis/relationships.ts:101`). Field docs: by column name inside a matched dataset; a column the target lacks is `column_missing`.
- **The three-way rule (my calls, refining D4).** Compare the file object `F` and the project object `P` in a1's export shape, with `F`'s references mapped into the project's ids.
  - `F` equals `P`: **unchanged**.
  - Matched **by id** and `F.base` is a valid hash: `fileEdited = objectBase(F as written) !== F.base`, `hereEdited = objectBase(P as exported) !== F.base`. Both → **conflict** (default `keep this project's`). File only → **updated** (or **renamed** when the name changed). Here only → **unchanged** with `newerHere: true`: the file is older than the project, so nothing is written.
  - Matched **by name** (another id: the promotion case) or no `base`: there is no shared base, so every difference is **updated**, shown as a diff.
  - Project objects absent from the file: **onlyHere**, never deleted (datasets, terms, metrics, relationships; not field docs).
- **Sensitivity rises, never falls (my call on "falls").** Only `none → personal | financial` applies. Any change away from a mark (to `none` or to the other mark) is skipped `sensitivity_lowered` and shown.
- **Same gates as the editor (D5).** Each object is checked by the function its save path uses, and refused with that function's sentence (`skipped: invalid`, `error`): table docs by `catalog:setTable`'s checks (part 1 step 01: guide ≤ 8,000 is refused, not clipped), field docs by `valueLabelProblem` (step 06) and `sanitizeAliases`/`aliasCollision` (`src/app/columnNames.ts:38/71`), terms by `termProblem` (step 05b; a term inside a term is `termInTerm()`), metrics by a new `metricProblem` lifted out of `metric:save`/`metric:update` (`src/ipc/metrics.ts:468-501`) so both share it (name taken by a metric or a term, `timeColumn` and `snapshot` checks of steps 04 and 07, formulas compiled by `checkMetricFormula`, `src/analysis/metricCheck.ts`), base filters by `liveBaseOf` (step 08) and only onto a Live target (`not_live`). Names of terms and metrics are checked against the **post-import set**: two file objects that would collide with each other are refused too.
- **Plan hash.** `sha256(stableStringify({ v: 1, items: items.map((i) => [i.key, i.status, i.fileHash, i.hereHash]) }))`, base64url. `hereHash` is `contentTag(kind, P)` (`src/app/editConflict.ts:41`) for metric and term records and `objectBase(P)` for catalog parts and relationships, so any edit to a target between plan and apply moves it. Choices are not in the hash.
- **Access (D7).** `write`, project scope, and refused `modelRestricted()` for a caller `restrictedOn(projectId)`: the plan shows the project's own term values and value labels in its diffs.
- **No secrets, origins or rule values in a plan reply.** Diffs carry definitions only (a1's whitelist). Calendar is ignored.
- Sentences in `src/app/modelFileMessages.ts`; `node scripts/i18n-extract.js`. No dependency, no migration, no stored field. `src/ipc/metrics.ts` is 563 lines: the lifted checks leave it smaller.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Promotion across projects.** Same dataset names, other ids: every difference is an update that keeps the target's ids, never a "new" duplicate. Task 3.
- **A stale file never reverts newer work.** Exported, then edited here only: unchanged, `newerHere`. Task 3.
- **Dependents of a skip.** A metric on a missing dataset, a term step naming a skipped term, a `via` naming a skipped relationship: each skipped and named. Task 3.
- **Gates.** Each negative control is refused with the same sentence the editor gives. Task 4.

---

### Task 1: Read a model zip (or inline files) into shapes
**Files:** Create `src/app/modelRead.ts`, `scripts/test-modelRead.ts`
**Interfaces:** Consumes `MODEL_POLICY`, the shapes of a1. Produces
- `interface ParsedModel { manifest: ModelManifest; datasets: ModelDataset[]; guides: Map<string, string>; metrics: ModelMetric[]; terms: ModelTerm[]; relationships: ModelRelationship[]; invalid: Array<{ path: string; error: string }> }` (`guides`: dataset id → text, ≤ 8,000 characters or invalid).
- `readModelZip(file: string): Promise<ParsedModel | { refused: string }>` and `readModelFiles(files: ReadonlyMap<string, string>): Promise<ParsedModel | { refused: string }>` (a4's inline path; same whitelist, caps and value budget). Each object goes through a whitelist reader: unknown keys dropped, wrong types → `invalid`.
- [ ] **Step 1: Write the failing test.**
```ts
const back = await readModelFiles((await exportModel(P)).files);
ok('a1 export reads back to the same shapes', stableStringify(back.metrics) === stableStringify(exported.metrics) && back.invalid.length === 0);
ok('an unknown entry refuses the whole file', 'refused' in (await readModelFiles(withEntry(files, 'notes.txt', 'x'))));
ok('formatVersion 2 refuses', 'refused' in (await readModelFiles(withManifest(files, { formatVersion: 2 }))));
ok('a broken metric file is one invalid item, not a refusal', (await readModelFiles(withEntry(files, 'metrics/bad.json', '7')) as ParsedModel).invalid[0].path === 'metrics/bad.json');
ok('a 9,000-character guide is invalid', (await readModelFiles(withEntry(files, `datasets/${slug}.md`, 'x'.repeat(9000))) as ParsedModel).invalid.length === 1);
ok('a zip with a data descriptor or an encrypted entry is refused by the reader', 'refused' in (await readModelZip(FORGED)));
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` fails: `modelRead` missing.
- [ ] **Step 3: Implement.** `readModelZip` opens, reads every entry (`reader.read(e)`), closes in `finally`, then shares the parse with `readModelFiles`.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-modelRead.js && node scripts/test-bundleMemory.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/app/modelRead.ts scripts/test-modelRead.ts` · "Read model files from a zip or inline, through the whitelist and the value budget"

### Task 2: Match and map ids
**Files:** Create `src/app/modelMatch.ts`, `scripts/test-modelMatch.ts`
**Interfaces:** Produces `interface ModelMatch { datasets: Map<string, string | null>; terms: Map<string, string | null>; metrics: Map<string, string | null>; relationships: Map<string, string | null>; how: Map<string, 'id' | 'name'> }` (file id → target id, `null` = no match, keyed `kind:id` in `how`); `matchModel(file: ParsedModel, here: ParsedModel): ModelMatch`; `mapRefs<T>(o: T, m: ModelMatch): { value: T; missing: string[] }`, which rewrites `dataset`, `from.dataset`, `to.dataset`, term steps' `term`, steps' `via` and a part 5 period metric's `definition.base` (a metric id), and lists every reference it could not map. A metric whose `definition.base` cannot be mapped is skipped `depends_on_skipped`, never written with a dangling id. The dry run also states a1's fixed list of kinds model files never carry, so the person knows an import leaves those as they are here.
- [ ] **Step 1: Write the failing test.** Same id → `how 'id'`; other id, same name → `how 'name'` and the target id; a name differing only in case is **not** a match; `mapRefs` of a metric whose filter holds `{ type: 'term', term: T_FILE }` gives `T_HERE`; a `via` to an unmatched relationship is listed in `missing`.
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-modelMatch.js` → missing module.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-modelMatch.js` → `ok`.
- [ ] **Step 5: Commit.** `git add src/app/modelMatch.ts scripts/test-modelMatch.ts` · "Match model objects by id then name and map their references"

### Task 3: The plan and the merge matrix
**Files:** Create `src/app/modelPlan.ts`, `scripts/test-modelPlan.ts` (on `scripts/modelFixture.ts`)
**Interfaces:** Produces
- `type PlanStatus = 'unchanged' | 'updated' | 'renamed' | 'new' | 'conflict' | 'skipped' | 'onlyHere'`; `type SkipReason = 'dataset_missing' | 'column_missing' | 'depends_on_skipped' | 'sensitivity_lowered' | 'not_live' | 'invalid' | 'external'`.
- `interface PlanItem { key: string; kind: 'table' | 'field' | 'baseFilters' | 'term' | 'metric' | 'relationship' | 'dataset'; name: string; status: PlanStatus; targetId?: string; changes?: Array<{ field: string; here?: unknown; file?: unknown }>; newerHere?: true; reason?: SkipReason; error?: string; fileHash: string; hereHash: string }`. `key` is `kind:fileId` (`kind:fileId:column` for a field), or `kind:here:targetId` for only-here.
- `interface ImportPlan { hash: string; items: PlanItem[]; counts: Record<PlanStatus, number>; source: { appVersion: string; project: string } }`.
- `planImport(projectId: string, file: ParsedModel): Promise<ImportPlan>` (reads `exportModel(projectId)` for the project side, `matchModel`, then the rules in Global Constraints; items sorted by kind in write order, then name).
- [ ] **Step 1: Write the failing test.** Each case builds files by editing a1's export of the fixture:
```ts
ok('round trip: every item unchanged', (await plan(P, filesOf(P))).items.every((i) => i.status === 'unchanged' || i.status === 'onlyHere'));
ok('same id, new name: renamed', itemOf(await plan(P, rename(files, 'Avg basket', 'Average basket')), 'metric', AVG).status === 'renamed');
const c = await plan(CLONE, filesOf(P)); // a clone with the same dataset NAMES and other ids
ok('across projects: an update keeps the target id', itemOf(c, 'metric', REV_P).status === 'updated' && itemOf(c, 'metric', REV_P).targetId === REV_CLONE);
await editHere(P, REV, { description: 'here' }); const both = await plan(P, editFile(files, REV, { description: 'file' }));
ok('edited here and in the file: conflict', itemOf(both, 'metric', REV).status === 'conflict');
ok('edited here only: unchanged, newer here', (() => { const i = itemOf(await plan(P, files), 'metric', REV); return i.status === 'unchanged' && i.newerHere === true; })());
const s = await plan(P, withDataset(files, RETURNS_FILE, { metric: REFUNDS_FILE }));
ok('a missing dataset and its metric are both listed', itemOf(s, 'dataset', RETURNS_FILE).reason === 'dataset_missing' && itemOf(s, 'metric', REFUNDS_FILE).reason === 'depends_on_skipped');
ok('only here is listed and never a delete', itemOf(await plan(P, without(files, 'terms/emea.json')), 'term', EMEA).status === 'onlyHere');
ok('sensitivity personal → none is skipped', itemOf(await plan(P, sensitivity(files, 'email', undefined)), 'field', `${ORDERS}:email`).reason === 'sensitivity_lowered');
ok('NEGATIVE CONTROL: none → financial applies', itemOf(await plan(P, sensitivity(files, 'amount', 'financial')), 'field', `${ORDERS}:amount`).status === 'updated');
ok('a field doc for a missing column is skipped', itemOf(await plan(P, field(files, 'gone_col')), 'field', `${ORDERS}:gone_col`).reason === 'column_missing');
ok('base filters onto an extract: not_live', itemOf(await plan(P, baseFilters(files, ORDERS)), 'baseFilters', ORDERS).reason === 'not_live');
ok('the hash moves when a target moves', (await plan(P, files)).hash !== (await (async () => { await editHere(P, EMEA, { description: 'x' }); return (await plan(P, files)).hash; })()));
const reply = JSON.stringify(await plan(P, files));
ok('no planted secret, table name, SQL or rule value in the reply', PLANTED.every(([, n]) => !reply.includes(n)));
ok('NEGATIVE CONTROL: the guide canary is in it', reply.includes(GUIDE_CANARY));
```
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-modelPlan.js` → `planImport` missing.
- [ ] **Step 3: Implement.** `objectBase(F as written)` is taken on the file's own form, before `mapRefs`; `P as exported` is a1's projection of the project, so a round trip hashes equal.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-modelPlan.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/app/modelPlan.ts scripts/test-modelPlan.ts` · "Plan a model import: id then name, three-way conflicts, skips with their dependents"

### Task 4: The editor's gates, shared
**Files:** Create `src/ipc/metricSave.ts` · Modify `src/ipc/metrics.ts:468-501` (handlers call it), `src/app/modelPlan.ts` · Test `scripts/test-modelPlan.ts` (§ gates), `scripts/test-metrics.js` stays green
**Interfaces:** Produces `metricProblem(projectId: string, input: { name?: unknown; datasetId: string; definition?: unknown; filters?: unknown; timeColumn?: unknown }, exceptId?: string, taken?: ReadonlySet<string>): Promise<{ field: 'name' | 'definition' | 'filters' | 'timeColumn'; error: string } | null>` (`taken`: the post-import names, lower-cased). `metric:save` and `metric:update` call it first and reply `{ ok: false, error, field }` exactly as today.
- [ ] **Step 1: Write the failing test.**
```ts
const NEG: Array<[string, ModelFiles, string]> = [
  ['a duplicate value label', valueLabels(files, 'region', [{ value: 'EU', label: 'Europe' }, { value: 'EE', label: 'Europe' }]), labelShared('Europe', 'EU', 'EE')],
  ['a term inside a term', termFilters(files, EMEA, [{ type: 'term', term: ENTERPRISE }]), termInTerm()],
  ['a metric named like a term', rename(files, 'Revenue', 'EMEA'), termNameTaken('EMEA', 'term')],
  ['two new metrics with one name', twoNew(files, 'Margin'), nameTakenMessage('Margin')],
  ['a formula that does not compile', formula(files, REV, '[Revenue] +'), FORMULA_ERROR],
];
for (const [what, f, sentence] of NEG) ok(`${what}: skipped with the editor's sentence`, invalidItem(await plan(P, f)).error === sentence);
ok('NEGATIVE CONTROL: the same files without the defect plan clean', (await plan(P, files)).items.every((i) => i.status !== 'skipped'));
ok('metric:save still refuses a taken name with field "name"', (await post('metric:save', { projectId: P, input: { ...REV_INPUT } })).field === 'name');
```
The unknown zip entry and the oversized guide are pinned in Task 1.
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-modelPlan.js` → the gates do not run (a duplicate label plans as `updated`).
- [ ] **Step 3: Implement.** Move the checks out of the two handlers verbatim; the handlers keep their reply shapes.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-modelPlan.js && node scripts/test-metrics.js && node scripts/test-terms.js && node scripts/test-file-size.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/ipc/metricSave.ts src/ipc/metrics.ts src/app/modelPlan.ts scripts/test-modelPlan.ts` · "Hold imported objects to the editor's own checks"

### Task 5: `model:importPlan`
**Files:** Modify `src/api/model.ts` (append), `src/ipc/modelFiles.ts` · Test `scripts/test-modelPlan.ts` (§ route)
**Interfaces:** `'model:importPlan': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, fileToken: FileToken }), project: byProjectId })` → `{ ok: true; plan: ImportPlan } | { ok: false; error: string }`. An expired token answers `modelUploadExpired()`; the upload's `done()` runs in `finally`.
- [ ] **Step 1: Write the failing test.** Upload a1's zip through `POST /api/files`, call the route: `ok: true`, `plan.hash` equals `planImport` over the same files; a reused token → `modelUploadExpired()`; a viewer → 403; a restricted editor → `modelRestricted()`; `fs` shows no file left in the org's staging area afterwards.
- [ ] **Step 2: Run it to see it fail.** No handler.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-modelPlan.js && node scripts/check-contracts.js && npm run lint` → all `ok`, 0 unresolved, lint 0.
- [ ] **Step 5: Commit.** `git add src/api/model.ts src/ipc/modelFiles.ts src/app/modelFileMessages.ts src/i18n scripts/test-modelPlan.ts` · "Add model:importPlan, the dry run of a model import"
