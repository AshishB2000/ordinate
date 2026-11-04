# Semantic layer part 4, step 01: the status store, the pin and the four status channels: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project admin can review, certify, retire ("use X instead") and clear the status of a metric, term or dataset. A certification is pinned to a hash of everything the figure depends on, so any later change reads `needs_review` until an admin certifies again. Every status change is a version event.
**Architecture:** 01a's `catalog.status` section is the store, written under the catalog's lock (`mutate`). `pinOf` (`src/analysis/statusPin.ts`) hashes a record's in-pin fields plus the pins of what it names, recursively and with a bound. `statusFor` (`src/analysis/statusStore.ts`) reads the section once per request and compares pins lazily. Four admin channels sit in `src/api/governance.ts` / `src/ipc/governance.ts`: `model:review` hands the admin the pin of what they are looking at, and `model:certify` takes it back as its base.
**Tech Stack:** `src/analysis`, `src/app/catalog.ts`, `src/app/versions.ts`, `src/api`, `src/ipc`, `src/server/app.ts`.
**Spec:** docs/semantic-layer/04-governance.md (D1–D6, D11, D23) · Index: 2026-11-04-semantic-layer-p4-00-index.md
**Branch:** `feat/semantic-p4-01-status-store` off `origin/develop`. **Merge gate:** `git tag --contains <01a merge sha>` lists a `v*` tag. If it does not, stop and ask the owner to release 01a first. Part 1 05b (terms: `getTerm`, `isTermStep`, version type `term`) must be merged.

## Global Constraints
- Only the server stamps `by` (`catalog.osUser()`, `src/app/catalog.ts:286`) and `at`. Status is never content: `setDoc`, `setColumn`, a restore, a duplicate and a record save never write it.
- No edit is refused because of status (D5). Status changes no figure, no cache key and no reply of a figure door.
- A pin reaches a browser only through `model:review` (admin). It is never in a list reply: a hash of a term's values would confirm a guessed value to a restricted viewer (the reason `tagForCaller` exists, `rowDoors.ts:242`).
- Sentences go in a new `src/analysis/statusMessages.ts`, appended to `MAIN_FILES` (`scripts/i18n-extract.ts:375`).
- `src/app/catalog.ts` (428) takes one exported writer, `updateStatus`, about 8 lines. Everything else lives in new files.

## Review Focus
- The pin tables are `Record<keyof Metric | keyof Term | keyof DatasetMeta, 'pin' | 'out'>`, so a new field fails `tsc` until it is classified. The runtime control (Task 1) proves the check can fail.
- A term edit, or an edit of a metric that a formula names, moves the dependent metric's pin (Task 1).
- A restore, a duplicate or a bundle import never adds status. A restore to different content reads `needs_review` (Task 3).
- `model:certify` with a stale `base` is refused 409 `record_changed` and carries the current pin as `tag` (Task 3).

---

### Task 1: `pinOf`, per kind
**Files:** Create `src/analysis/statusPin.ts` · Test `scripts/test-governanceStatus.ts` (part 1, temp `DATA_DIR`)
**Interfaces:** Consumes `metrics.getMetric`/`metricsByName` (`src/analysis/metrics.ts:321/343`), `compileMetricFormula` (`src/analysis/metricFormula.ts:169`), `getTerm` and `isTermStep` (part 1 05b, `src/data/termStep.ts`), `datasets.getDatasetMeta`, `sanitizeOrigin` (`src/data/datasetOrigin.ts`), `pipelineHash`/`stableStringify` (`src/engine/queryCache.ts:89/104`). Produces:
```ts
export const METRIC_PIN: Record<keyof Metric, 'pin' | 'out'>;   // pin: name datasetId definition filters format timeColumn (snapshot rides in definition)
export const TERM_PIN: Record<keyof Term, 'pin' | 'out'>;       // pin: name datasetId filters
export const DATASET_PIN: Record<keyof DatasetMeta, 'pin' | 'out'>; // pin: steps (pipelineHash), origin (whole, sanitized), mode, columns ([name,type]), live (baseFilters only)
export function unclassified(table: Record<string, string>, keys: readonly string[]): string[];
export async function pinOf(projectId: string, ref: string): Promise<string | null>; // null: the item is gone; else 43-char base64url sha256
```
The algorithm is not determined by the tests. Hash `stableStringify({ kind, own, deps })`. `own` holds the in-pin fields, with `undefined` kept out. `deps` maps a ref to its pin, or to `'missing'` or `'cycle'`. A metric's deps are every metric its formula names (`compileMetricFormula(text, columns).program.metricRefs` resolved by lowercase name through `metricsByName`) and every `term:` its filters name. A term has no deps. A dataset's deps are none: its upstream is not its definition. Recurse with a visited set and `MAX_DEPTH = 10` (`metricMeasures.ts:35`). A formula that does not compile hashes its text and `'uncompiled'`. Memoise per call tree. Use metadata reads only: a Live dataset never reaches `getDataset`.
- [ ] **Step 1: Write the failing test.** Table-driven over a fixture `Metric` with every field set:
```ts
for (const [field, kind] of Object.entries(METRIC_PIN)) {
  const before = await pinOf(P, `metric:${M}`); await rewriteMetricField(P, M, field, ALT[field]); const after = await pinOf(P, `metric:${M}`);
  ok(`metric.${field} is ${kind}: the pin ${kind === 'pin' ? 'moves' : 'stays'}`, (before !== after) === (kind === 'pin'));
}
// the same loops for TERM_PIN over a term, and DATASET_PIN over an extract and a Live record (live.epoch and schemaSyncedAt stay; baseFilters move it)
ok('editing the EMEA term moves "EMEA revenue"', await movesAfter(`metric:${EMEA_REV}`, () => terms.updateTerm(P, EMEA, { filters: [NARROWER] })));
ok('editing [Revenue] moves the formula metric that names it', await movesAfter(`metric:${MARGIN}`, () => metrics.updateMetric(P, REV, { filters: [F0] })));
ok('a refresh (rows, updatedAt, lastRefreshedAt) does not move a dataset', !(await movesAfter(`dataset:${D}`, () => refreshWithSameSchema(P, D))));
ok('a formula naming itself through another stops (cycle), stable', (await pinOf(P, `metric:${LOOP_A}`)) === (await pinOf(P, `metric:${LOOP_A}`)));
ok('a deleted metric has no pin', (await pinOf(P, `metric:${GONE}`)) === null);
ok('NEGATIVE CONTROL: a planted unclassified field is reported', JSON.stringify(unclassified(METRIC_PIN, [...Object.keys(METRIC_PIN), 'planted'])) === '["planted"]');
ok('every key a stored metric carries is classified', unclassified(METRIC_PIN, Object.keys(await metrics.getMetric(P, FULL)!)).length === 0);
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts` fails, because `statusPin` is missing.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-governanceStatus.js` reports `ok` for every line.
- [ ] **Step 5: Commit.** `git add src/analysis/statusPin.ts scripts/test-governanceStatus.ts` · "Pin a metric, term or dataset to everything its figure depends on"

### Task 2: The store, `statusFor`, and version events
**Files:** Create `src/analysis/statusStore.ts`, `src/analysis/statusMessages.ts` · Modify `src/app/catalog.ts` (export `updateStatus`), `src/app/versions.ts:51-52` (`VersionEvent` adds `'certified' | 'retired' | 'cleared'`, `EVENT_SUMMARY` adds `Certified`, `Retired`, `Status cleared`), `scripts/i18n-extract.ts:375` (append `src/analysis/statusMessages.ts`) · Test `scripts/test-governanceStatus.ts` (part 2)
**Interfaces:** Produces
```ts
// src/app/catalog.ts: the section under the catalog's lock; fn is sync and may throw (nothing written).
export function updateStatus<T>(projectId: string, fn: (status: Record<string, StatusDoc>) => T): Promise<T>;
// src/analysis/statusStore.ts
export type StatusState = 'certified' | 'needs_review' | 'retired';
export interface StatusView { state: StatusState; by: string; at: string; note: string; versionKey?: string; replacedBy?: { ref: string; name: string } }
export function statusFor(projectId: string): (ref: string) => Promise<StatusView | null>; // memo per request (WeakMap on ctx())
export async function certify(projectId: string, ref: string, base: string, note: string): Promise<StatusView>;
export async function retire(projectId: string, ref: string, replacedBy: string | undefined, note: string): Promise<StatusView>;
export async function clearStatus(projectId: string, ref: string): Promise<null>;
export class StatusError extends Error { readonly field: 'ref' | 'replacedBy' }
```
- `statusFor`: one `catalog.load` per request. `certified` with `doc.pin === await pinOf(ref)` gives `certified`. Any other pin, or the item gone, gives `needs_review`. `replacedBy.name` is the record's current name, and when that record is gone the field is omitted.
- `certify`: `pinOf` must equal `base`. Otherwise throw `Object.assign(new Error(statusChanged()), { code: 'ERECORDCHANGED', tag: current })`, the shape the route already answers 409 (`src/server/app.ts:504-508`). Record the event with `versions.record(projectId, type, rec, { event: 'certified' })`. `rec` is the stored metric or term. A dataset uses `{ id, steps }` from its meta, or `versionRecordOf(await getDataset)` for an input table (`src/data/inputTable/store.ts:102`). Then `updateStatus` writes `{ status:'certified', by, at, note, pin: base, versionKey }`.
- `retire`: `replacedBy` must parse to the same kind, exist, differ from `ref`, and not be retired. Inside `updateStatus`, refuse when another entry already names `ref` as its `replacedBy`, because retiring `ref` would make a chain. Each refusal is a `StatusError` with a `statusMessages` sentence. The event is `retired`. `clearStatus` deletes the entry, and its event is `cleared`.
- Sentences: `statusChanged()` "This changed since you reviewed it. Review it again, then certify.", `replacementKind()`, `replacementSelf()`, `replacementRetired(name)`, `replacementMissing()`, `wouldChain(name)` "{name} is the replacement for another item. Point that item somewhere else first.", `notFound()`.
- [ ] **Step 1: Write the failing test**
```ts
const pin = (await pinOf(P, REF))!;
const v = await certify(P, REF, pin, 'checked');
ok('certified, stamped by the server', v.state === 'certified' && v.by === EMAIL && (await catalog.load(P)).status![REF].pin === pin);
ok('the event is a version, even with no content change', (await versions.list(P, 'metric', M))[0].event === 'certified');
await metrics.updateMetric(P, M, { filters: [F0] });
ok('an edit reads needs_review, with the stored by kept', (await statusFor(P)(REF))!.state === 'needs_review');
ok('a stale base is refused with the current pin', await rejectsWith(() => certify(P, REF, pin, ''), (e) => e.code === 'ERECORDCHANGED' && e.tag === (await pinOf(P, REF))));
ok('retire: another kind is refused', await rejectsStatus(() => retire(P, `metric:${A}`, `term:${T}`, '')));
ok('retire: a retired replacement is refused', await rejectsStatus(() => retire(P, `metric:${A}`, `metric:${RETIRED}`, '')));
ok('retire: retiring a replacement would chain: refused', await rejectsStatus(() => retire(P, `metric:${NET}`, `metric:${OTHER}`, '')) /* GROSS.replacedBy = NET */);
ok('clear: the entry is gone and the event recorded', (await clearStatus(P, REF)) === null && !(REF in ((await catalog.load(P)).status ?? {})));
ok('NEGATIVE CONTROL: nothing certified, nothing read', (await statusFor(P)(`metric:${PLAIN}`)) === null);
```
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-governanceStatus.js` fails, because `statusStore` is missing.
- [ ] **Step 3: Implement** as specified. Every check that only reads (pins, existence, names) runs before `updateStatus`. The chain check runs inside it.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-governanceStatus.js && node scripts/test-versionHistory.js && node scripts/test-catalog.js && node scripts/i18n-extract.js && node scripts/test-i18n.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src/analysis/statusStore.ts src/analysis/statusMessages.ts src/app/catalog.ts src/app/versions.ts scripts/i18n-extract.ts src/i18n scripts/test-governanceStatus.ts` · "Store certified and retired status pinned to content, with version events"

### Task 3: The four channels, and what never certifies
**Files:** Create `src/api/governance.ts`, `src/ipc/governance.ts` · Modify `src/api/index.ts` (append `import { governance } from './governance'` and `...governance,`), `src/server/app.ts:570` (add `'../ipc/governance'` to the Data section's modules) · Test `scripts/test-governanceStatus.ts` (part 3) and a DB part on `scripts/rowPolicyHarness.ts` (skipped without `DATABASE_URL`, as `test-rowPolicySafetyNet` does)
**Interfaces:** Produces (zod, `access: 'admin'`, `project: byProjectId`; the route audits admin calls):
```ts
const StatusRef = z.string().regex(/^(metric|term|dataset):[0-9a-fA-F-]{36}$/);
'model:review':      { projectId: Uuid, ref: StatusRef } → { ok: true, pin: string, status: StatusView | null, newestKey?: string } | { ok: false, error }
'model:certify':     { projectId: Uuid, ref: StatusRef, base: Base, note?: z.string().max(500) } → { ok: true, status: StatusView }
'model:retire':      { projectId: Uuid, ref: StatusRef, replacedBy?: StatusRef, note?: z.string().max(500) } → { ok: true, status: StatusView } | { ok: false, error, field }
'model:clearStatus': { projectId: Uuid, ref: StatusRef } → { ok: true, status: null }
```
The handlers turn a `StatusError` into `{ ok: false, error, field }` and rethrow `ERECORDCHANGED`. `model:review` is `access: 'admin'` too, so it is not a `read` contract and needs no `TREATMENT`. Its `newestKey` is `versions.list(...)[0]?.key`. The web diffs `status.versionKey → newestKey` with the existing `versions:diff`.
- [ ] **Step 1: Write the failing test**
```ts
ok('restore never certifies: an uncertified metric restored has no status', (await restore(P, 'metric', PLAIN, OLD_KEY), (await statusFor(P)(`metric:${PLAIN}`)) === null));
ok('restore of a certified metric to other content reads needs_review', (await restore(P, 'metric', M, PRE_EDIT_KEY), (await statusFor(P)(REF))!.state === 'needs_review'));
ok('a duplicate carries no status', (await statusFor(P)(`metric:${(await metrics.duplicateMetric(P, M))!.id}`)) === null);
ok('a bundle round trip keeps by but reads needs_review (ids remapped, the pin moved)', ((s) => s!.state === 'needs_review' && s!.by === EMAIL)(await importedStatus()));
ok('review returns the pin certify takes', (await call('model:review', { projectId: P, ref: REF })).pin === (await pinOf(P, REF)));
ok('the four channels are admin and project-scoped', ['model:review', 'model:certify', 'model:retire', 'model:clearStatus'].every((c) => contracts[c].access === 'admin' && typeof contracts[c].project === 'function'));
// DB part:
ok('an editor is 403', (await W.call('ed', 'model:certify', body)).status === 403);
ok('a viewer is 403', (await W.call('east', 'model:retire', { projectId: P, ref: REF })).status === 403);
ok('NEGATIVE CONTROL: the admin certifies', (await W.call('boss', 'model:certify', body)).body.ok === true);
ok('a stale base is 409 record_changed with the current pin', ((r) => r.status === 409 && r.body.code === 'record_changed' && r.body.tag === CURRENT)(await W.call('boss', 'model:certify', stale)));
```
`importedStatus()` uses the bundle export→import helpers `scripts/test-bundle.ts` already drives.
- [ ] **Step 2: Run it to see it fail.** `node scripts/check-contracts.js` reports `model:*` unresolved.
- [ ] **Step 3: Implement.** Follow `src/ipc/rowPolicy.ts` for shape.
- [ ] **Step 4: Run it to see it pass.** These must report 0 unresolved and `ok` everywhere: `node scripts/check-contracts.js && node scripts/test-governanceStatus.js && DATABASE_URL=… node scripts/test-governanceStatus.js && node scripts/test-bundle.js && node scripts/test-server-boot.js && node scripts/test-rowPolicySafetyNet.js` (coverage: no new `read` contract) `&& npm run lint`.
- [ ] **Step 5: Commit.** `git add src/api src/ipc/governance.ts src/server/app.ts scripts/test-governanceStatus.ts` · "Let project admins review, certify, retire and clear a metric, term or dataset"

Not in this step: status in any reply (02), any web (03), the Assistant and MCP (04).
