# Semantic layer part 8, step 00a: keep Live calculated fields, refuse them — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one release in which every pod keeps a Live dataset's stored calculated fields through every writer and refuses, with a typed sentence, every question, schema sync, copy and switch to extract on a dataset that has them. Step 04 (which computes them) then never meets a pod that would skip a filter on one or copy the dataset without them.
**Architecture:** Part 1's 08a pattern, verbatim. A top-level record key `calculated` (never inside `live`, which every Live writer rebuilds from `sanitizeLive`), read into `meta.live.calculated` by `applyLive` (in memory only), one guard line in `liveTarget` and two in `src/ipc/liveDatasets.ts`. No contract and no editor: nothing can write the key in this release.
**Tech Stack:** `src/data/liveDataset.ts`, `src/engine/live/liveSpec.ts`, `liveTarget.ts`, `src/ipc/liveDatasets.ts`, self-checks on `scripts/liveRouteHarness.ts` and the fake warehouse (`scripts/liveFakeConnector.ts`).
**Spec:** docs/semantic-layer/08-engine.md (D1, D6; Constraints "Live") · precedent: docs/superpowers/plans/2026-11-03-semantic-layer-p1-08-live-base-filters.md Task 0 · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p8-00-index.md
**Branch and PR:** `feat/semantic-p8-00a-live-calc-guard` off `origin/develop`. It needs nothing from part 1 beyond 08a, which is in develop. One PR. Step 04 must not reach a release before this one is on every pod (release 8A).

## Global Constraints
- Every dataset without the key answers byte-identically: `test-liveCompile`, `test-liveRoute`, `test-liveBaseFilters` and `test-liveSafetyNet` stay green untouched (except `all` in test-liveCompile, below).
- Never skip, never drop. A stored list this pod can't read in full refuses exactly as a readable one does (`calculatedUnreadable`, the `baseFiltersUnreadable` pattern in `applyLive`, `src/data/liveDataset.ts:193-203`).
- Calc columns are NOT appended to `meta.columns` here: this pod can't compute them, so pickers must not offer them. Step 04 appends them.
- Size: `liveTarget.ts` 122, `liveDatasets.ts` 298, `liveDataset.ts` 290 lines. One-line edits there; new logic in `src/data/liveCalcs.ts` (PURE, < 80 lines).
- Sentence through `t()` in `src/engine/liveRefusals.ts` (already in `MAIN_FILES`), then `node scripts/i18n-extract.js`; copy the generated key into `MESSAGES`. Never hand-edit `en.json`.
- If part 1 step 08 Task 3 has already replaced the 08a refusal in `liveTarget` with `liveBaseOf`, put this guard right after that call. If this PR merges first, step 08's implementer keeps this line (resolve conflicts keeping both sides).

## Old pods (rolling deploy and rollback)
**Where it is stored:** `calculated: { name, expression, type }[]` at the TOP LEVEL of the dataset record, beside `baseFilters` and `rowPolicy`. `bumpEpoch`, `setMaxCacheAge`, `stampSyncAttempt` and `writeSchemaSync` (the scheduler runs the last two) rebuild `raw.live` from `sanitizeLive` and would erase a key inside it; `serialized` (`src/data/datasetRecord.ts`) leaves other top-level keys alone. Calc columns are never written into `raw.columns` (step 04 appends them when the record is read), so a schema sync, which rewrites `raw.columns` from the warehouse, cannot lose or duplicate them.
- **A pod older than 00a** ignores the key. Once step 04 has written one, that pod refuses a chart that names a calc (`unknownColumn`, loud), but SKIPS a filter on a calc column with "Filter skipped: unknown column" (a wider figure). Its "Make a copy" and "Copy the data instead" also make extracts without the calcs. The second is permanent: from then on that dataset's calc filters skip. This release exists for that reason.
- **An 00a pod** keeps the key and refuses (`live_refused`, reason `calculated`) every Live question, sync, copy and switch to extract on that dataset. It is loud for the length of the rollout and never wrong.
- **A 04 pod** computes them.
- **Residual risk:** an upgrade from an image older than 00a straight to 04, or a `helm rollback` below 00a after a calc was saved. Task 2 writes it into `docs/server/upgrade.md`, with the remedy: delete the calculated fields on the dataset's Schema tab before rolling back below 00a.

## Review Focus
- An unreadable entry (an unknown `type`, a 5 KB expression, a NUL in a name) must refuse the same as a readable list. It must never read as "no calcs". → Task 1
- The scheduler's daily sync on a dataset with calcs: refused, typed, and the record unchanged. It must not write a `missingColumns` that names the calcs. → Task 1
- A dataset with BOTH base filters and calcs: one refusal or the other, never an answer. → Task 1

---

### Task 1: read the key, keep it, refuse
**Files:** Create `src/data/liveCalcs.ts`, `scripts/test-liveCalcGuard.ts`. Modify:
- `src/data/liveDataset.ts`: `LiveSettings` (:33-58) gains `calculated?` and `calculatedUnreadable?`; `applyLive` (:193-203) reads `data.calculated`.
- `src/engine/live/liveSpec.ts`: `LiveRefusalCode` (:121) gains `'calculated'`; `MESSAGES` (:149) gains its entry with `param: 'column'`.
- `src/engine/liveRefusals.ts`: append `liveCalculatedRefused(column)`.
- `src/engine/live/liveTarget.ts`: one line after :84.
- `src/ipc/liveDatasets.ts`: `calcRefusal(meta)` beside `baseFilterRefusal` (:171), called right after :207 and :265.
- `scripts/test-liveCompile.ts:273`: `'calculated'` joins `all`.

**Interfaces:** Produces
```ts
// src/data/liveCalcs.ts — PURE
export type LiveCalcType = 'number' | 'text';
export interface LiveCalc { name: string; expression: string; type: LiveCalcType }
export const MAX_LIVE_CALCS = 50;
export const MAX_CALC_EXPRESSION = 4_000;
export const MAX_CALC_NAME = 200;
/** Rebuilt as {name, expression, type}: name trimmed, 1–200 chars, no NUL; expression 1–4,000 chars, no NUL; type number|text. First 50 kept. */
export function sanitizeLiveCalcs(raw: unknown): LiveCalc[];
/** Some it read, or a stored list it could not read in full. The ONE test every guard shares. */
export function hasLiveCalcs(live: { calculated?: readonly unknown[]; calculatedUnreadable?: true } | undefined): boolean;
```
- `LiveSettings.calculated?: LiveCalc[]` and `LiveSettings.calculatedUnreadable?: true`, both in memory only.
- 00a's wording of the sentence: "This dataset's calculated fields can't be computed by this server, so it answers nothing. Ask your admin to finish upgrading Ordinate." Step 04 rewrites it for a calc that no longer runs.

- [ ] **Step 1: Write the failing test.** `scripts/test-liveCalcGuard.ts`, on `./liveRouteHarness` (`H.setupOrg(ORG_A)` → `P`, `L`, a second Live `L2` and a third `L3`), shaped like `scripts/test-liveBaseFilters.ts`. Plant the key with `serialized(datasetFilePath(P, id), (raw) => { raw.calculated = list; })`. End on `finish()`.
  ```ts
  const CALCS = [{ name: 'Margin', expression: '[amt] - [qty]', type: 'number' }, { name: 'Band', expression: "IF [amt] > 10 THEN 'big' ELSE 'small' END", type: 'text' }];
  ok('sanitize rebuilds the three keys and drops what it cannot read', show(sanitizeLiveCalcs([{ ...CALCS[0], extra: 1 }, { name: 'x\u0000', expression: '1', type: 'number' }, { name: 'y', expression: '1', type: 'date' }, 7])) === show([CALCS[0]]));
  ok('sanitize caps at 50', sanitizeLiveCalcs(Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, expression: '1', type: 'number' }))).length === 50);
  const before = (await meta(L)).columns;
  await plant(L, CALCS);
  ok('meta.live.calculated comes from the top-level key; meta.columns is unchanged', show((await meta(L)).live.calculated) === show(CALCS) && show((await meta(L)).columns) === show(before));
  for (const [name, write] of WRITERS) { await write(); ok(`${name} keeps raw.calculated, and writes it into neither raw.live nor raw.columns`, show((await raw(L)).calculated) === show(CALCS) && !('calculated' in (await raw(L)).live) && !(await raw(L)).columns.some((c: Reply) => c.name === 'Margin')); }
  for (const [label, call] of DOORS) { const n = H.fake.calls.length; const r = await call(L);
    ok(`${label}: refused typed (calculated), no warehouse call`, r.ok === false && r.code === 'live_refused' && r.reason === 'calculated' && H.fake.calls.length === n, show(r)); }
  ok('the daily sync is refused and leaves missingColumns alone', !('missingColumns' in (await raw(L)).live));
  ok('Make a copy refuses and saves nothing', !(await post('dataset:copyLive', { projectId: P, datasetId: L })).value.ok && (await count()) === n0);
  ok('Copy the data instead refuses; the record stays Live and keeps the key', !(await post('dataset:setMode', { projectId: P, datasetId: L, mode: 'extract' })).value.ok && isLive(await meta(L)) && show((await raw(L)).calculated) === show(CALCS));
  await plant(L3, [...CALCS, { name: 'z', expression: 'x'.repeat(5_000), type: 'number' }]);
  ok('a list with one unreadable entry refuses the same', (await chartOn(L3)).reason === 'calculated');
  ok('base filters and calcs together: refused, never answered', (await withBaseFilters(L, () => chartOn(L))).ok === false);
  ok('NEGATIVE CONTROL: the same doors on Live L2, which has no key, answer', (await chartOn(L2)).ok === true);
  ```
  - `WRITERS`: `bumpEpoch`, `setMaxCacheAge(60)`, `stampSyncAttempt`, `writeSchemaSync` (exports of `liveDataset.ts`), and `setBaseFilters` once part 1 step 08 has merged.
  - `DOORS`: `visual:data`, `dashboard:metric`, `answer:card` and `syncLiveSchema` (08a's four).
  - `withBaseFilters` plants `raw.baseFilters` as 08a's test does.
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-liveCalcGuard.js` → tsc fails on the missing `../src/data/liveCalcs`.
- [ ] **Step 3: Implement.**
  - `applyLive`: `const calculated = sanitizeLiveCalcs(data.calculated); if (calculated.length) live.calculated = calculated; if (Array.isArray(data.calculated) && data.calculated.length !== calculated.length) live.calculatedUnreadable = true;`.
  - `liveTarget`: `if (hasLiveCalcs(meta.live)) return { ok: false, kind: 'refused', refusal: refuse('calculated', meta.live.calculated?.[0]?.name) };`.
  - `calcRefusal` answers `{ ok: false, code: 'live_refused', reason: 'calculated', error: liveCalculatedRefused(name) }` before `fetchSelection`.
  - Then `node scripts/i18n-extract.js`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-liveCalcGuard.js && for t in liveCompile liveDataset liveBaseFilters liveRoute liveRouteAnswers liveSafetyNet liveCopy liveProfileSync i18n file-size; do node scripts/test-$t.js || break; done` → all green; `npm run lint` → 0.
- [ ] **Step 5: Commit.** `git add src/data/liveCalcs.ts src/data/liveDataset.ts src/engine/live/liveSpec.ts src/engine/liveRefusals.ts src/engine/live/liveTarget.ts src/ipc/liveDatasets.ts src/i18n scripts/test-liveCalcGuard.ts scripts/test-liveCompile.ts` · "Keep a Live dataset's calculated fields and refuse its figures until this pod can compute them"

### Task 2: the upgrade note
**Files:** Modify `docs/server/upgrade.md` (the section 05a added, "Filters a newer release writes are kept": one new bullet).
- [ ] **Step 1: Write the failing test.** None new: `node scripts/test-serverDocs.js` must stay green. The gap is held by the owner's release rule and step 04's merge gate.
- [ ] **Step 2: Run it.** Nothing to fail; this is documentation.
- [ ] **Step 3: Implement.** The bullet: "**Live calculated fields (part 8).** This release keeps a Live dataset's calculated fields and refuses its figures. The release that computes them needs this one on every pod first. Once a Live dataset has a calculated field, never `helm rollback` below this release: an older pod skips a filter on one and copies the dataset without them. Delete them on the dataset's Schema tab first."
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-serverDocs.js` → ok.
- [ ] **Step 5: Commit.** `git add docs/server/upgrade.md` · "Document the release Live calculated fields need first"

**Existing tests that must stay green:** test-liveCompile, test-liveDataset, test-liveBaseFilters, test-liveRoute, test-liveRouteAnswers, test-liveSafetyNet, test-liveCopy, test-liveProfileSync, test-liveQuery, test-rowPolicyLive, test-i18n, test-file-size, test-serverDocs, check-contracts (no new contract).

**Not in this step:** any way to write `calculated` (step 04's `live:setCalculated`), appending calc columns to `meta.columns` (step 04), lineage of Live calcs (step 01 reads `meta.live.calculated`).
