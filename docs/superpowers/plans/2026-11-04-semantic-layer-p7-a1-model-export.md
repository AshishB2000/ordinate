# Semantic layer part 7, step a1: export the model as files — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor downloads the project's definitions (table and field docs, value labels, metrics, terms, relationships, Live base filters) as a zip of sorted JSON files plus a markdown guide per dataset, byte-identical when nothing changed, holding no row, origin, rule or secret.
**Architecture:** One pure module owns the format (`src/app/modelFormat.ts`: shapes, slugs, the JSON writer, `base` hashes, the zip whitelist a2 reads with). One collector reads the existing stores into those shapes, metadata only (`src/app/modelExport.ts`). `model:export` zips the files with a pinned timestamp and hands back a download token, exactly as `projects:export` does (`src/ipc/projects.ts:152-191`). The Data model page gains **Export ▾ → Model files**.
**Tech Stack:** `src/app` (zip writer, catalog, records), `src/ipc`, `src/api` (zod), React (`web/src/features/model`), self-checks, Vitest.
**Spec:** docs/semantic-layer/07-portability.md (D1, D2, D3, D7, Tests "Round trip", "Leaks") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-a1-model-export` off `origin/develop`, after part 1's last PR (`feat/semantic-p1-10-data-model-section`) merges. One PR to `develop`. Release 1 of part 7.

## Global Constraints

- Format id `MODEL_FORMAT = 'ordinate-model'`, `MODEL_VERSION = 1`; layout exactly D2 (`model.json`, `datasets/<slug>.json`, `datasets/<slug>.md`, `metrics/<slug>.json`, `terms/<slug>.json`, `relationships.json`).
- Every JSON file is written by `modelJson(v)`: keys sorted, 2-space indent, `\n` at the end. **No object in a model file is keyed by user text** (my call): fields, value labels, aliases and relationships are arrays sorted by a fixed key. A JS object orders integer-like keys first, so a column named `2024` would break a sort-by-key writer.
- A key is written only when it holds something: no description → no `description`. A project that filled in nothing exports each dataset as `{ base, id, name }`, so a later field never churns old files.
- **Travels (D3):** table doc `role`, `key`, `grain` (the `guide` is the `.md`); field docs `name`, `description`, `displayName`, `aliases`, `example`, `sensitivity` (only when not `none`), `values`; metric `id`, `name`, `dataset`, `definition` (its `snapshot` inside, part 1 D8), `filters`, `format`, `description`, `direction`, `timeColumn`; term `id`, `name`, `dataset`, `aliases`, `description`, `filters`; relationship `id`, `from`, `to`, `cardinality`, `label`; a Live dataset's `baseFilters`.
- **Never:** `keyCheck`, a relationship's `verified` and `warning` (derived from rows; they would churn on every refresh), `updatedBy`, `updatedAt`, `createdAt`, a metric's `tree` (not in formatVersion 1: a2 updates never touch it), any origin (path, table, SQL, URL, `connId`), connections, `rowPolicy`, privacy salt, secrets, rows. (External metrics do not exist yet; b2 keeps them out of model files, because the layer owns them, D13.)
- References are ids resolved through the export's own files (`dataset`, a term step's `term`, a step's `via`, and a part 5 period metric's `definition.base`). Formula metrics keep naming metrics (`[Profit]`).
- **Not carried by formatVersion 1** (cross-part check item 10; design 07 adds them later under a `formatVersion` bump): hierarchies (part 6), topics (part 6), certified status (part 4), instructions and verified questions (part 3), Live calculated fields (part 8), source-table notes (part 2), a metric's `target` (part 5). The export reply lists the ones this project has (`notCarried: string[]`, fixed kind words, no names), and the Export menu shows that line.
- `base` = `objectBase(o)`: sha256 (base64url) of `stableStringify(o)` without `base` (`src/engine/queryCache.ts:89`). It includes `id`, so a base matches only inside the project it came from (a2's three-way rule relies on this).
- Slugs (my call): lower-case runs of `[a-z0-9]` joined by `-`, at most 60 characters, `untitled` when empty; a clash takes `-2`, `-3`… in id order. Ids and names never reach a path unslugged.
- The zip: `writeZipAsync(entries, MODEL_ZIP_TIME)` (`src/app/bundle.ts:64`), `MODEL_ZIP_TIME = new Date(1980, 0, 1)` (the DOS time floor), entries in path order: the zip is byte-identical too, not only the files. `appVersion` moves each release, so identity holds within one release (the doc says so).
- Access (D7): `model:export` is `write`, project scope; a caller `restrictedOn(projectId)` (`src/data/rowAccess.ts:274`) is refused `modelRestricted()`. Nothing new to classify in `scripts/rowPolicyReaders.ts` (no `read` contract).
- Sentences: new `src/app/modelFileMessages.ts`, appended to `MAIN_FILES` (`scripts/i18n-extract.ts:346`), then `node scripts/i18n-extract.js`. Never hand-edit `en.json`.
- No dependency, no migration, no stored field: nothing for an older pod to read. `src/api/index.ts` is append-only; `src/api/model.ts` exists from part 1 step 10 and gains an entry.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Leaks.** A fixture with a planted connection secret, a source table name, a defining SQL string, a row-policy value and the privacy salt: none in any exported byte. A canary planted in a guide is found by the same grep (negative control). Task 2.
- **Live.** A Live dataset exports `baseFilters` and not one byte of its origin. Task 2.
- **Stability.** Two exports of an unchanged project are byte-identical (files and zip); one edited description changes one file. Task 3.
- **Who.** A viewer gets 403; an editor restricted on any dataset gets `modelRestricted()`. Task 3.

---

### Task 1: The format module
**Files:** Create `src/app/modelFormat.ts`, `src/app/modelFileMessages.ts`, `scripts/test-modelFormat.ts` · Modify `scripts/i18n-extract.ts:346`
**Interfaces:** Produces
- `MODEL_FORMAT`, `MODEL_VERSION`, `MODEL_ZIP_TIME`.
- `interface ModelField { name: string; description?: string; displayName?: string; aliases?: string[]; example?: string; sensitivity?: 'personal' | 'financial'; values?: ValueLabel[] }`.
- `interface ModelDataset { id: string; name: string; base: string; role?: 'fact' | 'dimension'; key?: string; grain?: string; fields?: ModelField[]; baseFilters?: FilterStep[] }` (guide lives in the `.md`).
- `interface ModelMetric { id; name; dataset: string; base; definition: MetricDefinition; filters?: FilterStep[]; format: MetricFormat; description?; direction?; timeColumn? }`, `interface ModelTerm { id; name; dataset; base; aliases?: string[]; description?; filters: FilterStep[] }`, `interface ModelRelationship { id; base; from: { dataset: string; column: string }; to: { dataset: string; column: string }; cardinality: Cardinality; label?: string }`, `interface ModelManifest { format; formatVersion; appVersion; project: { name: string }; calendar: CalendarPrefs }`.
- `type ModelFiles = Map<string, string>` (path → text).
- `modelJson(v: unknown): string`; `objectBase(o: object): string`; `slugsFor(items: readonly { id: string; name: string }[]): Map<string, string>` (id → slug).
- `MODEL_POLICY: ZipPolicy` (`src/app/zipReader.ts:57`): `refuseName` allows only the D2 names (lower case, slug charset) else `modelEntryRefused(name)`; `capOf` 32 KiB for `.md` (8,000 characters of UTF-8), `OTHER_RECORD_MAX_BYTES` (`src/app/bundleRules.ts`) for `.json`; `maxEntries` 20,000; `maxTotal` 256 MiB.
- Sentences: `modelRestricted()` "Your access to this project is limited by row access rules, so its definitions can't be exported or imported.", `modelEntryRefused(name)`.
- [ ] **Step 1: Write the failing test.**
```ts
ok('keys sorted, 2 spaces, trailing newline', modelJson({ b: 1, a: { d: [2], c: null } }) === '{\n  "a": {\n    "c": null,\n    "d": [\n      2\n    ]\n  },\n  "b": 1\n}\n');
ok('same object, other key order: same bytes', modelJson({ x: 1, y: 2 }) === modelJson({ y: 2, x: 1 }));
const s = slugsFor([{ id: U2, name: 'Avg basket' }, { id: U1, name: 'avg  Basket!' }, { id: U3, name: '' }, { id: U4, name: 'Ünïcode 2024' }]);
ok('clash: id order decides who gets -2', s.get(U1) === 'avg-basket' && s.get(U2) === 'avg-basket-2');
ok('empty → untitled; accents folded (NFD), the rest dropped', s.get(U3) === 'untitled' && s.get(U4) === 'unicode-2024');
ok('base ignores its own key and follows content', objectBase({ id: U1, name: 'A', base: 'x' }) === objectBase({ name: 'A', id: U1 }) && objectBase({ id: U1, name: 'A' }) !== objectBase({ id: U1, name: 'B' }));
ok('whitelist: D2 names pass', ['model.json', 'datasets/orders.json', 'datasets/orders.md', 'metrics/revenue-2.json', 'terms/emea.json', 'relationships.json'].every((n) => MODEL_POLICY.refuseName(n) === null));
ok('NEGATIVE CONTROL: anything else is refused', ['datasets/Orders.json', 'datasets/a/b.json', 'secrets.json', '../x.json', 'datasets/x.parquet'].every((n) => MODEL_POLICY.refuseName(n) !== null));
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` fails: `modelFormat` missing.
- [ ] **Step 3: Implement.** `modelJson` = `JSON.stringify(sortKeys(v), null, 2) + '\n'`, where `sortKeys` rebuilds plain objects with sorted keys and drops `undefined`. The slug rule is the one in Global Constraints (NFD-normalize first, then drop what is not `[a-z0-9]`).
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-modelFormat.js && node scripts/i18n-extract.js && node scripts/test-i18n.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/app/modelFormat.ts src/app/modelFileMessages.ts scripts/i18n-extract.ts src/i18n scripts/test-modelFormat.ts` · "Add the model files format: sorted JSON, slugs, base hashes and the entry whitelist"

### Task 2: Collect the stores into files
**Files:** Create `src/app/modelExport.ts`, `scripts/modelFixture.ts` (a project with two extract datasets and one Live dataset over `scripts/liveFakeConnector.ts`, every kind filled in, plus the planted secrets), `scripts/test-modelExport.ts`
**Interfaces:** Consumes `datasets.listDatasets`/`getDatasetMeta` (`src/data/datasets.ts:389/438`), `catalog.load` (`src/app/catalog.ts:262`), `metrics.listMetrics`/`getMetric`, part 1's `listTerms`/`getTerm` (`src/analysis/terms.ts`), `listRelationships` (`src/analysis/relationships.ts:112`), `meta.live.baseFilters` (part 1 step 08), `getCalendar`. Produces `exportModel(projectId: string): Promise<{ files: ModelFiles; counts: { datasets: number; metrics: number; terms: number; relationships: number } }>`. Every dataset is listed (references resolve); `getDataset` is never called.
- [ ] **Step 1: Write the failing test.**
```ts
const { files } = await H.as(ORG_A, () => exportModel(P));
const all = [...files.values()].join('\n');
for (const [what, needle] of PLANTED) ok(`no ${what} in any exported byte`, !all.includes(needle)); // secret, 'live_fake_orders', 'SELECT secret_col', rule value, salt
ok('NEGATIVE CONTROL: the guide canary is found', all.includes(GUIDE_CANARY));
const live = JSON.parse(files.get(`datasets/${liveSlug}.json`)!);
ok('Live: base filters travel, no origin key', stableStringify(live.baseFilters) === stableStringify(BASE) && !('origin' in live) && !/connId|table|sql/i.test(Object.keys(live).join()));
ok('no derived or stamp keys anywhere', !/"(keyCheck|verified|warning|updatedAt|updatedBy|createdAt|tree)"/.test(all));
ok('guide is its own .md file, verbatim', files.get(`datasets/${ordersSlug}.md`) === GUIDE);
ok('fields are an array sorted by name', JSON.parse(files.get(`datasets/${ordersSlug}.json`)!).fields.map((f: { name: string }) => f.name).join() === 'amount,region');
ok('a metric references its dataset by id and keeps its snapshot', (() => { const m = JSON.parse(files.get('metrics/stock-on-hand.json')!); return m.dataset === ORDERS && m.definition.snapshot.take === 'last'; })());
ok('getDataset never ran', hydrations() === 0);
ok('an unfilled dataset is exactly { base, id, name }', Object.keys(JSON.parse(files.get(`datasets/${bareSlug}.json`)!)).join() === 'base,id,name');
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-modelExport.js` → `exportModel` is not a function.
- [ ] **Step 3: Implement.** Map each store's record to its shape by an explicit whitelist (never spread a record). Relationships: `relationships.json` = `{ relationships: [...] }` sorted by id. Term and metric `filters` go out as stored (term steps and `via` included).
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-modelExport.js && node scripts/test-liveSafetyNet.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/app/modelExport.ts scripts/modelFixture.ts scripts/test-modelExport.ts` · "Collect a project's definitions into model files, metadata only"

### Task 3: `model:export`, its golden and the stability checks
**Files:** Create `src/ipc/modelFiles.ts`, `scripts/fixtures/golden/modelFiles/` (recorded once in this task) · Modify `src/api/model.ts` (append), `src/server/app.ts:570` (add `'../ipc/modelFiles'` inside the existing Data module array: 0 new lines), `scripts/test-modelExport.ts`
**Interfaces:** Produces `'model:export': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid }), project: byProjectId })` → `{ ok: true; downloadToken: string; counts; notCarried: string[] } | { ok: false; error: string }`. The handler zips through `writeZipAsync(sorted entries, MODEL_ZIP_TIME)`, writes to `appPaths.temp()` and calls `offerDownload(path, '<safe project name>-model.zip')`, as `projects:export` does.
- [ ] **Step 1: Write the failing test.**
```ts
const a = await zipOf(await post('model:export', { projectId: P })); const b = await zipOf(await post('model:export', { projectId: P }));
ok('unchanged project: the zip is byte-identical', a.equals(b));
await catalog.setColumn(P, ORDERS, 'region', { description: 'Sales region' });
const changed = diffNames(await filesOf(P), before);
ok('one edit changes exactly one file', changed.join() === `datasets/${ordersSlug}.json`);
ok('the fixture export equals the golden, byte for byte', goldenMatches(await filesOf(P), 'scripts/fixtures/golden/modelFiles'));
ok('a viewer is refused 403', (await decide(VIEWER, 'model:export')).status === 403);
ok('an editor restricted on one dataset is refused, with the sentence', (await asRestrictedEditor(() => post('model:export', { projectId: P }))).error === modelRestricted());
ok('NEGATIVE CONTROL: an unrestricted editor gets a token', typeof (await post('model:export', { projectId: P })).downloadToken === 'string');
```
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-modelExport.js` → no `model:export` handler.
- [ ] **Step 3: Implement.** Record the golden ONCE from the fixture after the byte-identity check passes (`node -e` writing each file under `scripts/fixtures/golden/modelFiles/`). Look at it by hand before committing. It is never re-recorded to make a test pass.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-modelExport.js && node scripts/check-contracts.js && node scripts/test-file-size.js` → all `ok`, 0 unresolved.
- [ ] **Step 5: Commit.** `git add src/ipc/modelFiles.ts src/api/model.ts src/server/app.ts scripts/test-modelExport.ts scripts/fixtures/golden/modelFiles` · "Add model:export, a byte-stable zip of the model files"

### Task 4: Export ▾ on the Data model page
**Files:** Modify `web/src/features/model/DataModelPage.tsx` (part 1 step 10; header actions), `web/src/features/model/api.ts` · Create `web/src/features/model/ExportMenu.tsx`, `web/src/features/model/exportMenu.test.tsx`
**Interfaces:** Consumes `model:export`, `startDownload` (`web/src/api/files.ts:7`), `Menu` (`web/src/ui/Menu.tsx`), `useCanEdit`. Produces `ExportMenu({ projectId })`: a secondary button **Export ▾** with one item **Model files** (g1 adds **Ossie**). Editors only. The page header keeps one primary (`PageHead`).
- [ ] **Step 1: Write the failing test.** Clicking Model files calls `model:export` with `{ projectId }` and `startDownload` with the token; an `ok: false` reply toasts the server's sentence and starts no download; a viewer sees no Export button; the page still has exactly one primary button.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- exportMenu` → no Export button.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run size && npm run lint` → green, initial JS ≤ 300 KB, lint 0.
- [ ] **Step 5: Commit.** `git add web/src/features/model` · "Add Export ▾ Model files to the Data model page"

**Before the PR:** `npm test`, `npm run test:web`, `npm run lint`, `node scripts/check-contracts.js`. Extend the Data model e2e (`web/e2e/model.e2e.ts`, part 1 step 10) by one check that Export ▾ opens, within its RPC budget.
