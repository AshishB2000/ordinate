# Semantic layer part 7, step a3: apply an import, and the Import dialog — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor uploads model files, reads the dry run, picks a side for each conflict and applies it: every change goes through the editor's own save, in order, refused whole if the project moved since the dry run, and undoable.
**Architecture:** `model:importApply` takes the zip again (tokens are single-use), re-plans with a2's `planImport`, refuses a different hash, then writes item by item through the existing stores (one locked catalog write, `setLiveBaseFilters`, the relationship save, the term and metric saves with their edit tags). Before the first write it exports the project's current model and returns it as a download, because the catalog and relationships keep no versions. The Data model page gets **Import…** and its dry-run dialog (mockups first).
**Tech Stack:** `src/app`, `src/ipc`, `src/api`, React (`web/src/features/model`), self-checks, Vitest, Playwright.
**Spec:** docs/semantic-layer/07-portability.md ("What you will see", D4, D5, D6, D7) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-a3-import-apply` off `origin/develop` after a2 merges. One PR. Release 1.

## Global Constraints

- **Hash first.** `importApply` re-plans from the uploaded file and the stores. `plan.hash !== planHash` → `{ ok: false, code: 'plan_changed', error: modelPlanChanged() }` ("This project changed since the dry run. Check again."), nothing written.
- **Write order (my call; D6 said relationships last):** table and field docs → Live base filters → relationships → terms → metrics. Relationships move ahead of terms and metrics because a filter step's `via` (part 1 D14) names a relationship, and a metric's filter may name a term.
- **Each item through its own save** (D5, D6):
  - Catalog items: ONE `mutateCatalog` write (part 1 step 01 exports it from `src/app/catalog.ts:275`) for every table and field change, each item compare-and-set inside the lock against its `hereHash`; a moved item fails `moved`, the rest still land. `updatedBy: osUser()`, `updatedAt` now.
  - Base filters: `setLiveBaseFilters` (part 1 step 08 Task 6), one per dataset.
  - Relationships: the save `relationship:save` runs (`src/ipc/relationships.ts:286`, exported as `saveRelationshipChecked`), so `verified` and `warning` are recomputed from the tables, never copied from a file.
  - Terms and metrics: `saveTermChecked` / `updateTermChecked` and a2's `src/ipc/metricSave.ts` gaining `saveMetricChecked(projectId, input)` / `updateMetricChecked(projectId, id, patch, base)`, the bodies of `metric:save`/`metric:update` (`src/ipc/metrics.ts:468-501`) moved verbatim, versions included. The handlers call them. `base` is the item's `hereHash` (a content tag), so `lockedUpdate` (`src/app/editConflict.ts:76`) refuses an object edited between the dry run and the write: that item fails `moved`.
  - An update patches only the fields model files carry, so a metric's `tree` and anything a later format adds survive.
- **New objects get fresh ids** (`randomUUID`), never the file's: the bundle import keeps ids unique across a pod's projects (`src/app/bundleImport.ts:19-22`). References from other new objects in the same import are rewritten to the fresh ids before their write.
- **Choices.** `choices: Record<itemKey, 'file' | 'here'>` for conflict items only; a missing choice is `'here'` (D4). A choice on a non-conflict key is ignored.
- **Partial failure.** No multi-record transaction. The reply lists `written` and `failed` (`{ key, error }`); a re-run re-plans, and what landed is now unchanged.
- **Undo.** Metrics and terms keep their last version (`versions.record`). Catalog docs and relationships have none (`src/app/recordKinds.ts:15-26`), so before the first write the handler zips `exportModel(projectId)` and returns `before: { downloadToken }` ("the model as it was"). Importing that file is the undo. Not written when nothing would change.
- **Nothing to do, no write.** A plan with no `updated`, `renamed`, `new` or file-chosen `conflict` writes nothing at all (no catalog write, no `before` file).
- Access: `write`, project scope, `restrictedOn` refused, as a2. No new read contract.
- **UI (house bar).** Mockups first (light and dark), then build. The dialog follows the spec's sketch: one row per status with the names, a "Keep this project's ▾ / Use the file's" select per conflict, skipped rows with their reason, "Only here: not in the files. An import never deletes.", and **Apply N changes** (disabled with "Nothing to apply" at 0). Loading skeleton, error state with Retry, both themes, tokens from `web/src/theme.css` only. The React UI is English-only; the server's sentences are shown as sent.
- Sentences in `src/app/modelFileMessages.ts`; `node scripts/i18n-extract.js`. No dependency, no migration, no stored field.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **Stale plan.** An edit on another pod between dry run and apply: `plan_changed`, zero writes. Task 1.
- **Moved mid-apply.** A metric edited after the hash check but before its write: that item fails `moved`, the others land, the reply says which. Task 1.
- **Round trip writes nothing.** Export → import into the same project: zero record writes, no `before` file. Task 1.
- **Byte-identical round trip into a clone.** Export, import into a clone with the same datasets, export again: identical files except ids and `base`. Task 2.
- **Recomputed, never copied.** An imported relationship's `verified` comes from the tables. Task 1.

---

### Task 1: `model:importApply`
**Files:** Create `src/app/modelApply.ts` · Modify `src/ipc/metricSave.ts`, `src/ipc/metrics.ts:468-501`, `src/ipc/relationships.ts:286` (export the body as `saveRelationshipChecked`), part 1's `src/ipc/terms.ts` (the same lift, if 05b kept the bodies inline), `src/ipc/modelFiles.ts`, `src/api/model.ts` (append) · Test `scripts/test-modelApply.ts` (on `scripts/modelFixture.ts`)
**Interfaces:** Produces
- `applyImport(projectId: string, file: ParsedModel, planHash: string, choices: Record<string, 'file' | 'here'>): Promise<{ ok: true; written: string[]; failed: Array<{ key: string; error: string }>; before?: { downloadToken: string } } | { ok: false; code: 'plan_changed'; error: string }>`.
- `'model:importApply': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, fileToken: FileToken, planHash: z.string().max(64), choices: z.record(z.string().max(400), z.enum(['file', 'here'])).optional() }), project: byProjectId })`.
- [ ] **Step 1: Write the failing test.**
```ts
const files = (await exportModel(P)).files;
const w0 = writes();
const same = await apply(P, files, (await plan(P, files)).hash);
ok('round trip: zero writes, no before file', same.ok && same.written.length === 0 && writes() === w0 && same.before === undefined);
const edited = editFile(files, REV, { description: 'from git' });
const p1 = await plan(P, edited);
await post('metric:update', { projectId: P, id: AVG, patch: { description: 'another pod' } });
ok('stale hash: refused, nothing written', (await apply(P, edited, p1.hash)).code === 'plan_changed' && writes() === w0 + 1);
const r = await apply(P, edited, (await plan(P, edited)).hash);
ok('an update lands through the metric save, with a version', r.ok && (await metrics.getMetric(P, REV))!.description === 'from git' && (await versions.list(P, 'metric', REV)).length === v0 + 1);
ok('a before file is offered', typeof r.before?.downloadToken === 'string');
ok('a conflict defaults to keep this project\'s', (await conflictCase(undefined)).description === 'here');
ok('… and takes the file when asked', (await conflictCase('file')).description === 'file');
ok('a metric tree survives an imported update', (await metrics.getMetric(P, TREE_METRIC))!.tree !== undefined);
const moved = await applyWithHook(P, edited, () => post('metric:update', { projectId: P, id: REV, patch: { description: 'mid' } }));
ok('moved between hash and write: that item fails, others land', moved.failed.some((f) => f.key === `metric:${REV}`) && moved.written.length > 0);
const nr = await apply(CLONE, withNewTermAndMetricUsingIt(files), hashOf);
ok('a new term and a new metric filtering on it: fresh ids, the reference follows', newMetric(nr).filters[0].term === newTerm(nr).id && newTerm(nr).id !== FILE_TERM_ID);
ok('a relationship\'s verified is recomputed, never the file\'s', (await rels.listRelationships(CLONE)).find((x) => x.label === 'Ship date')!.verified.matched === MATCHED_FROM_ROWS);
ok('write order: relationships before terms before metrics', order(trace) === 'catalog,baseFilters,relationship,term,metric');
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-modelApply.js` → no `applyImport`.
- [ ] **Step 3: Implement.** `applyWithHook` is a test seam: `applyImport` takes an optional `onBeforeWrite(key)` used only by the test.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-modelApply.js && node scripts/test-metrics.js && node scripts/test-terms.js && node scripts/test-joins.js && node scripts/test-catalog.js && node scripts/check-contracts.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add src/app/modelApply.ts src/ipc src/api/model.ts scripts/test-modelApply.ts` · "Apply a model import through each store's own save, refusing a stale plan"

### Task 2: The two round trips
**Files:** Test `scripts/test-modelApply.ts` (§ round trips)
- [ ] **Step 1: Write the failing test.**
```ts
const a = await exportModel(P); await applyAll(CLONE, a.files); const b = await exportModel(CLONE);
ok('export → import into a clone → export: the same files, ids and bases aside', stableStringify(stripIds(a.files)) === stableStringify(stripIds(b.files)));
ok('NEGATIVE CONTROL: one differing description shows', stableStringify(stripIds(a.files)) !== stableStringify(stripIds(editFile(b.files, CLONE_REV, { description: 'x' }))));
ok('the golden still matches (never re-recorded)', goldenMatches((await exportModel(P)).files, 'scripts/fixtures/golden/modelFiles'));
```
`stripIds` replaces each id by its object's slug path and drops `base`.
- [ ] **Step 2: Run it to see it fail.** A field the apply forgets (for example `timeColumn`) differs.
- [ ] **Step 3: Implement** whatever the diff shows is missing from Task 1.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-modelApply.js` → all `ok`.
- [ ] **Step 5: Commit.** `git add scripts/test-modelApply.ts src/app/modelApply.ts` · "Pin the model round trip into a clone, byte for byte"

### Task 3: Mockups for the Import dialog
**Files:** Create `docs/semantic-layer/mockups/p7-import-dry-run.png` and `-dark.png` (from a throwaway HTML page, not committed as code)
- [ ] **Step 1:** Draw the dry run of the spec's sketch with real states: all unchanged (Apply disabled), a mix with one conflict and two skips, a refused file, an expired upload, a stale plan.
- [ ] **Step 2:** Show the owner and wait for a yes before Task 4. Record the answer in the PR description.

### Task 4: Import… and the dry-run dialog
**Files:** Create `web/src/features/model/ImportDialog.tsx`, `ImportDialog.module.css`, `importDialog.test.tsx` · Modify `web/src/features/model/DataModelPage.tsx` (Import… beside Export ▾), `web/src/features/model/api.ts`
**Interfaces:** Consumes `upload` (`web/src/api/client.ts`), `model:importPlan`, `model:importApply`, `startDownload`, `Dialog`, `Select`, `States`. Produces `ImportDialog({ projectId, onClose })`. The picked `File` is kept in state and uploaded again for the apply.
- [ ] **Step 1: Write the failing test.** A stub plan with every status renders one row per status with the names (`14 unchanged`, `1 conflict`…), a conflict select defaulting to "Keep this project's", the skipped reasons in words, the only-here note; Apply says "Apply 6 changes" and sends `{ planHash, choices: { [conflictKey]: 'file' } }` after the select is switched; a `plan_changed` reply shows its sentence with **Check again**, which re-plans; an all-unchanged plan disables Apply with "Nothing to apply"; the result offers "Download the model as it was before"; a viewer sees no Import button.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web -- importDialog` → no dialog.
- [ ] **Step 3: Implement** against the approved mockup.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run size && npm run lint` → green.
- [ ] **Step 5: Commit.** `git add web/src/features/model docs/semantic-layer/mockups` · "Add Import… with its dry run to the Data model page"

### Task 5: The screen's e2e
**Files:** Modify `web/e2e/model.e2e.ts` (part 1 step 10)
- [ ] **Step 1: Write the check.** Export the seeded project's model, import the same file: the dry run says every object is unchanged and Apply is disabled; edit one description in the zip in the test, import again: one updated, Apply 1 change, the description shows on the Datasets tab. Screens light and dark. Within the RPC budget (25).
- [ ] **Step 2: Run it.** `npm run build:web && npm --prefix web run e2e -- model` → green; look at the screens.
- [ ] **Step 3: Commit.** `git add web/e2e/model.e2e.ts` · "Walk an import through the Data model page end to end"

**Before the PR:** `npm test`, `npm run test:web`, `npm run lint`, `node scripts/check-contracts.js`, `node scripts/test-file-size.js`.
