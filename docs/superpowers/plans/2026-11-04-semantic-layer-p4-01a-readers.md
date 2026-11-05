# Semantic layer part 4, step 01a: keep status and column rules, refuse what can't be applied (release A): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one release in which every pod keeps the catalog's `status` section and a dataset record's `columnAccess` key through every write and copy. A pod refuses a restricted caller, and every fan-out build, on a dataset that carries `columnAccess` it cannot apply. Release B can then add status and column rules without an older pod erasing them or serving hidden values.
**Architecture:** One new pure module `src/app/statusDocs.ts`, which `sanitizeCatalog` calls. `writeRecordKeepingPolicy` and the first-write store generalise from `rowPolicy` to a list of kept keys. In `src/data/rowAccess.ts`, a fourth `Effective` kind `columns` refuses with the new reason `columns`.
**Tech Stack:** `src/app`, `src/data`, `src/ipc/liveDatasets.ts`, `docs/server/upgrade.md`.
**Spec:** docs/semantic-layer/04-governance.md (D2, D13, D17) · Index: 2026-11-04-semantic-layer-p4-00-index.md
**Branch:** `feat/semantic-p4-01a-readers` off `origin/develop`. Needs part 1 01a merged (release 1: `src/app/tableDocs.ts` and the `tables` reader in `sanitizeCatalog`, which Task 1 copies and sits beside). Needs nothing from part 1 release 2. Release A is the first release that contains it.

## Global Constraints
- Nothing in this PR writes `status` or `columnAccess`. It only reads, keeps and refuses. A project without them behaves byte-identically. The negative controls prove that.
- The kept `status` is **sanitized, not opaque**: the shape below, so a hand-edited or corrupt entry is dropped rather than shown later as a badge. `columnAccess` is kept **raw**, exactly as `rowPolicy` is (a pod that cannot read it must not "repair" it). Its mere presence (`hasOwnProperty`) closes the dataset.
- Only restricted callers (`callerOn(...).restricted`) and fan-out builds are refused. Editors, admins and the jobs' system identity read as before.
- `src/data/rowAccess.ts` is 347 lines: about 10 more. `src/app/catalog.ts` 428: 3 more.

## Review Focus
- Every dataset-record writer keeps `columnAccess`: `persist` (save, refresh, step edits, input tables), the `serialized` metadata writers, `dataset:setRowPolicy`, Trash and restore, Live writers, and the three copy paths (`savedFrom`, `copyLive`, `rulesForCopyOf`). Pinned in Task 2.
- A dataset built from one with `columnAccess` is closed too (the upstream walk). Pinned in Task 3.
- The new reason never fires for a dataset without the key. That is the negative control in Task 3.

---

### Task 1: The catalog keeps a `status` section
**Files:** Create `src/app/statusDocs.ts` · Modify `src/app/catalog.ts:74-81` (`CatalogFile.status?`), `:198-228` (`sanitizeCatalog`: `const status = sanitizeStatus(raw.status); if (Object.keys(status).length) out.status = status;`) · Test `scripts/test-governanceReaders.ts` (part 1)
**Interfaces:** Produces
```ts
export const STATUS_KINDS = ['metric', 'term', 'dataset'] as const;
export type StatusKind = typeof STATUS_KINDS[number];
export interface StatusDoc {
  status: 'certified' | 'retired';
  by: string; at: string;            // ≤ 80 / ≤ 40 chars, as catalog stamps
  note: string;                      // ≤ 500
  pin?: string;                      // certified only: 43-char base64url
  versionKey?: string;               // certified only: versions KEY_RE shape
  replacedBy?: string;               // retired only: a ref of the same kind
}
export function parseStatusRef(ref: unknown): { kind: StatusKind; id: string } | null; // `${kind}:${uuid}`
export function sanitizeStatus(raw: unknown): Record<string, StatusDoc>; // null-prototype; bad ref or bad doc → entry dropped
```
Rules: a `certified` entry without a pin string is dropped (a badge must have something to check against). A `retired` entry's `replacedBy` is kept only when `parseStatusRef` gives the same kind and an id that is not its own. Otherwise the field is dropped and the entry stays retired.
- [ ] **Step 1: Write the failing test**
```ts
const M = `metric:${U1}`, T = `term:${U2}`, D = `dataset:${U3}`;
const RAW = { schemaVersion: 1, tags: {}, records: {}, columns: {}, status: {
  [M]: { status: 'certified', by: 'ana@acme.com', at: '2026-11-03T10:00:00.000Z', note: 'ok', pin: 'p'.repeat(43), versionKey: '2026-11-03T10-00-00-000Z' },
  [T]: { status: 'retired', by: 'a', at: 'b', note: '', replacedBy: `term:${U4}` },
  [D]: { status: 'retired', by: 'a', at: 'b', note: '', replacedBy: `metric:${U4}` },
  [`visual:${U5}`]: { status: 'certified', by: 'a', at: 'b', note: '', pin: 'x' },
  [`metric:${U6}`]: { status: 'certified', by: 'a', at: 'b', note: '' },
} };
const out = catalog.sanitizeCatalog(RAW);
ok('keeps a certified metric and a retired term verbatim', stableStringify(out.status![M]) === stableStringify(RAW.status[M]) && out.status![T].replacedBy === `term:${U4}`);
ok('a replacement of another kind is dropped, the retirement kept', out.status![D].status === 'retired' && !('replacedBy' in out.status![D]));
ok('a kind status does not cover, and a certified entry with no pin, are dropped', !(`visual:${U5}` in out.status!) && !(`metric:${U6}` in out.status!));
await withDataDir(async () => { await writeRaw(P, RAW); await catalog.setDoc(P, `dataset:${U3}`, { description: 'x' });
  ok('an unrelated catalog write keeps the section', stableStringify((await catalog.load(P)).status![M]) === stableStringify(RAW.status[M])); });
ok('NEGATIVE CONTROL: no section in, none out (byte-identical catalog)', !('status' in catalog.sanitizeCatalog({ ...RAW, status: undefined })));
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` fails, because the `statusDocs` module is missing.
- [ ] **Step 3: Implement.** Copy `tableDocs.ts`'s style: `clip`, null-prototype dict, no throw.
- [ ] **Step 4: Run it to see it pass.** `npm run build:ts && node scripts/test-governanceReaders.js && node scripts/test-catalog.js` all report `ok`. `test-catalog` also covers 01a's `tables` reader.
- [ ] **Step 5: Commit.** `git add src/app/statusDocs.ts src/app/catalog.ts scripts/test-governanceReaders.ts` · "Keep the catalog's status section through every catalog write"

### Task 2: Every dataset writer and copy keeps `columnAccess`
**Files:** Modify `src/data/datasetRecord.ts:270-323`, `src/data/rowAccess.ts:331-347` (`rulesForCopyOf`, `savedFrom`), `src/ipc/liveDatasets.ts:223-224` · Test `scripts/test-governanceReaders.ts` (part 2)
**Interfaces:** Produces
- `export const KEPT_RECORD_KEYS = ['rowPolicy', 'columnAccess'] as const;` `export type KeptRules = Partial<Record<typeof KEPT_RECORD_KEYS[number], unknown>>;`
  Beside it, a comment: the Live-only top-level keys `baseFilters` (part 1 08), `calculated` (part 8) and `semantic` (part 7) are deliberately NOT kept. The only `persist` of a Live record is `toExtractRecord`, which folds base filters and calcs into Prepare steps or is refused (semantic datasets; calcs on an 8A pod), so keeping them would leave stale Live keys on an extract. Never widen this list to "every unknown key".
- `writeRecordKeepingPolicy(file, obj)`: `delete next[k]` for each kept key. Then each key the **stored** record has is copied from it. Otherwise, on a first write, each key the first-write store has is copied from there.
- `withFirstWritePolicy(rules: KeptRules, fn)` (was `rowPolicy: unknown`). `storedRules(projectId, id): Promise<KeptRules>` replaces `storedRowPolicy`: only the keys the record has. ENOENT gives `{}`, any other failure throws, as today.
- `rulesForCopyOf(projectId, sourceId): Promise<KeptRules | undefined>`. Undefined when the source is neither `policyClosed` nor carrying `columnAccess`. Otherwise `{ ...storedRules }`, plus the closed row policy `{ column: '', rules: [], stepsHash: '' }` for a source closed only by something upstream (as today). `savedFrom` and `copyLive` pass the result through.
- [ ] **Step 1: Write the failing test.** In a temp `DATA_DIR`, as `test-rowPolicy.ts` sets up its store:
```ts
const CA = { columns: [{ column: 'salary', visibleTo: [TEAM] }], readersHash: 'h', updatedBy: 'boss@x', updatedAt: '2026-11-04T00:00:00.000Z' };
const plant = (id: string) => serialized(datasetFilePath(P, id), (raw) => { raw.columnAccess = CA; return true; });
const kept = async (id: string) => stableStringify((await raw(P, id)).columnAccess) === stableStringify(CA);
await plant(D); await datasets.updateSteps(P, D, [{ type: 'filter', column: 'dept', op: 'not_empty' }]);
ok('a data write (persist) keeps columnAccess', await kept(D));
for (const [name, write] of WRITERS) { await write(D); ok(`${name} keeps columnAccess`, await kept(D)); }
// WRITERS: markRefresh, setAutoRefresh, writeQuality, writeIncremental, setRowPolicy's serialized save, trash → restore, datasets.saveDataset over an existing id (re-import)
// LIVE_WRITERS, on a Live record LV with columnAccess planted: bumpEpoch, writeSchemaSync
for (const [name, write] of LIVE_WRITERS) { await plant(LV); await write(LV); ok(`Live: ${name} keeps columnAccess`, await kept(LV)); }
await plant(LV); const liveCopy = await copyLive(P, LV); ok('a copyLive copy is born with the source\'s columnAccess', await kept(liveCopy!.id));
const copy = await savedFrom(P, D, () => datasets.saveDataset(P, { name: 'copy', sourceKind: 'combined', columns: COLS, rows: ROWS }));
ok('a copy is born with the source\'s columnAccess (first write)', await kept(copy!.id));
ok('a copy of a source with no rules carries none', !('columnAccess' in (await raw(P, (await savedFrom(P, PLAIN, saveOther))!.id))));
ok('NEGATIVE CONTROL: the old one-key rule would drop it', !('columnAccess' in oldKeepRowPolicyOnly(await raw(P, D), { id: D })));
```
`oldKeepRowPolicyOnly` is the pre-change merge, copied into the test. It shows that the assertion can fail.
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-governanceReaders.js` fails at "a data write (persist) keeps columnAccess".
- [ ] **Step 3: Implement.** Make the loop change in `writeRecordKeepingPolicy` and rename the store field `{ rules: KeptRules }`. `liveDatasets.ts:223` becomes `const rules = await rulesForCopyOf(projectId, id)`. Note that this also closes a copy of a Live dataset whose upstream is closed, which today copies only `storedRowPolicy`. Update every importer of `storedRowPolicy`/`withFirstWritePolicy`: `grep -rn "storedRowPolicy\|withFirstWritePolicy" src`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-governanceReaders.js && node scripts/test-rowPolicy.js && node scripts/test-liveBaseFilters.js && node scripts/test-datasets.js` all report `ok`. Then `DATABASE_URL=… node scripts/test-rowPolicySidePaths.js` (copies and Trash keep `rowPolicy`) reports `ok`.
- [ ] **Step 5: Commit.** `git add src/data/datasetRecord.ts src/data/rowAccess.ts src/ipc/liveDatasets.ts scripts/test-governanceReaders.ts` · "Keep a dataset's column access rules through every write and copy"

### Task 3: A dataset with column rules this pod can't apply is closed (reason `columns`)
**Files:** Modify `src/data/rowPolicyError.ts:10-23` (`'columns'` in `RowPolicyReason` and `SENTENCES`), `src/data/rowAccessMessages.ts` (`rowColumnsMessage`), `src/data/rowAccess.ts:95` (`Effective` adds `{ kind: 'columns' }`), `:149-162` (`effectiveUncached`), `:217-231` (`rowLockFor`), `:234-253` (`closedReason`) · Test `scripts/test-governanceReaders-db.ts` (on `scripts/rowPolicyHarness.ts`)
**Interfaces:** Produces the reason `'columns'`. For now its sentence is "Some columns of this dataset are limited to certain people by rules this version of Ordinate can't apply yet, so it is closed to you. Ask your admin to finish upgrading Ordinate." Step 05 rewords it.
- `hasColumnRules(raw: Raw): boolean` is the own-property test, in `rowAccess.ts`. The `effectiveUncached` upstream loop treats a parent with `policyFromRecord(r) || hasColumnRules(r)` as `derived`. A dataset with no row policy but the key gives `{ kind: 'columns' }`. One with both gives `own` (the row rules already close it to restricted callers).
- `rowLockFor`: after the fan-out `refuse('fanout')`, `if (eff.kind === 'columns') refuse('columns')`, for restricted callers and fan-out alike. `closedReason` returns `'columns'` for that kind. `policyClosed` is true for it, so `/p/`, embeds and sends refuse during the rollout.
- [ ] **Step 1: Write the failing test.** `H.world()` returns null without `DATABASE_URL`, and the suite then finishes:
```ts
await plantColumnAccess(W, W.plain); // serialized, as Task 2
const enc = { category: 'customer', values: [{ column: 'sales', aggregation: 'sum' }] };
ok('east is refused a chart on it, typed columns', H.refused(await W.call('east', 'visual:data', { projectId: P, datasetId: W.plain, encoding: enc }), 'columns'));
ok('…its grid and its stats (the net)', H.refused(await W.call('east', 'dataset:page', page(W.plain)), 'columns') && H.refused(await W.call('east', 'dataset:stats', { projectId: P, datasetId: W.plain }), 'columns'));
ok('a dataset built from it is closed to east too', H.refused(await W.call('east', 'dataset:page', page(builtFromPlain)), 'derived'));
ok('a publish reading it refuses for everyone', H.refused(await W.call('boss', 'publish:plan', planOver(W.plain))));
ok('NEGATIVE CONTROL: the editor reads it as before', (await W.call('ed', 'visual:data', { projectId: P, datasetId: W.plain, encoding: enc })).body.ok === true);
await removeColumnAccess(W, W.plain);
ok('NEGATIVE CONTROL: without the key east is answered again', (await W.call('east', 'visual:data', { projectId: P, datasetId: W.plain, encoding: enc })).body.ok === true);
```
- [ ] **Step 2: Run it to see it fail.** `DATABASE_URL=… node scripts/test-governanceReaders-db.js` fails, because east is answered.
- [ ] **Step 3: Implement** as specified. Then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `DATABASE_URL=… node scripts/test-governanceReaders-db.js && DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js && DATABASE_URL=… node scripts/test-rowPolicyFanOut.js && node scripts/test-i18n.js && node scripts/test-file-size.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src/data scripts/test-governanceReaders-db.ts src/i18n` · "Close a dataset whose column access rules this pod cannot apply"

### Task 4: Say how the release gap is held
**Files:** Modify `docs/server/upgrade.md`. Add a section after `## Filters a newer release writes are kept (\`05a\`)` (`:119`).
- [ ] **Step 1: Check.** `node scripts/test-serverDocs.js` must stay green. This task is documentation and adds no new check.
- [ ] **Step 2: Implement.** Add the section "Certification and hidden columns a newer release writes are kept (`p4-01a`)". This release keeps a metric's, term's or dataset's certified or retired status, and a dataset's column access rules. A dataset with column rules is closed to project viewers, and to published pages, embeds, subscriptions and alerts, until every pod runs the release that applies the rules. **The release that adds certification and column rules needs this release on every pod first.** Use the same two ways through as the 05a section ("Go through this release" / "Stop every pod"): link that section's steps, do not repeat them. **Never roll back below this release once column rules exist.** An older pod drops them on its next refresh and shows the hidden values.
- [ ] **Step 3: Run it to see it pass.** `node scripts/test-serverDocs.js` reports `ok`.
- [ ] **Step 4: Commit.** `git add docs/server/upgrade.md` · "Document the reader release certification and column rules need first"

Not in this step: any status read, badge, pin or channel (01–04), and any precise column gate (05).
