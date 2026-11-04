# Semantic layer part 4, step 02: status in the replies that list metrics, terms and datasets: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everyone who reads the project sees each item's status (`certified`, `needs_review`, `retired`) in the replies that already list it. The Data model section's reply also carries what needs an admin's attention.
**Architecture:** One helper, `withStatus`, adds `status` to the items of a list. It goes in `metric:list` (and so `metric:table`), `dataset:list`, `catalog:list`, `term:list`, and `model:overview` (which gains `review`). Each attach goes through 01's `statusFor`, once per request. An item with no status gets no key, so a project without status replies byte-identically.
**Tech Stack:** `src/analysis/statusStore.ts`, `src/ipc/metrics.ts`, `src/ipc/datasets.ts`, `src/ipc/catalog.ts`, `src/app/catalogIndex.ts`, part 1's `src/ipc/terms.ts` and `src/ipc/modelOverview.ts`.
**Spec:** docs/semantic-layer/04-governance.md (D1, D7, D8) · Index: 2026-11-04-semantic-layer-p4-00-index.md
**Branch:** `feat/semantic-p4-02-status-replies` off `origin/develop` after 01 merges and part 1 step 10 (Data model section) merges.

## Global Constraints
- No figure door, no answer cache and no published page reads status in this step.
- `needs_review` is shown to viewers too (D7). No list reply carries a pin (01's `model:review` is the only way to get one).
- `src/ipc/datasets.ts` is 751 lines and `src/ipc/metrics.ts` 563: one call each. The mapping lives in `statusStore.ts`.
- `model:overview` keeps its part-1 shape. The new attention list is a new key `review`, never new `TodoKind`s, so an older browser tab, which words `todo` kinds through a fixed map, never meets one it doesn't know.

## Review Focus
- Byte-identical replies when nothing has status (Task 1's negative control).
- `review` counts uses only for retired items, so a large project does not run `metricUsage` for every metric (Task 2).

---

### Task 1: `withStatus` on every list reply
**Files:** Modify `src/analysis/statusStore.ts` (add `withStatus`), `src/ipc/metrics.ts:413-424` (`decorate`), `src/ipc/datasets.ts:361-372` (`dataset:list`, both branches), `src/app/catalogIndex.ts:188-226` (`CatalogRow.status?`, set in `listRows` for `metric:`/`dataset:` refs), part 1's `src/ipc/terms.ts` (`term:list`) · Test `scripts/test-governanceReplies.ts` (temp `DATA_DIR`, the handlers through `require('../src/server/rpc').handlers` as `scripts/test-askDidYouMean.ts:37` does) and a DB part on `scripts/rowPolicyHarness.ts`
**Interfaces:** Consumes `statusFor`, `StatusView` (01). Produces:
```ts
export async function withStatus<T extends { id: string }>(projectId: string, kind: StatusKind, items: T[]): Promise<Array<T & { status?: StatusView }>>;
```
It returns the same objects, unchanged, when the catalog has no `status` section, and does no pin work in that case.
- [ ] **Step 1: Write the failing test**
```ts
const before = await lists(P); // metric:list, metric:table, dataset:list, catalog:list, term:list
ok('NEGATIVE CONTROL: nothing has status, so no reply carries a status key', !anyStatusKey(before));
await certifyNow(P, `metric:${REV}`); await certifyNow(P, `term:${EMEA}`); await statusStore.retire(P, `dataset:${OLD}`, `dataset:${NEW}`, 'use New');
const after = await lists(P);
ok('metric:list and metric:table: Revenue certified', itemOf(after['metric:list'], REV).status.state === 'certified' && itemOf(after['metric:table'].metrics, REV).status.state === 'certified');
ok('term:list: EMEA certified', itemOf(after['term:list'].terms, EMEA).status.state === 'certified');
ok('dataset:list: Old retired, use New by name', ((s) => s.state === 'retired' && s.replacedBy.name === 'New')(itemOf(after['dataset:list'], OLD).status));
ok('catalog:list rows carry it too', rowOf(after['catalog:list'], `dataset:${OLD}`).status.state === 'retired');
ok('items without status are unchanged', stableStringify(itemOf(after['metric:list'], OTHER)) === stableStringify(itemOf(before['metric:list'], OTHER)));
await terms.updateTerm(P, EMEA, { filters: [NARROWER] });
ok('a term edit turns the certified term needs_review in term:list', itemOf((await lists(P))['term:list'].terms, EMEA).status.state === 'needs_review');
// DB part:
ok('a viewer (east) sees the state and who certified it', ((s) => s.state === 'certified' && s.by === BOSS_EMAIL)(itemOf((await W.call('east', 'metric:list', { projectId: P })).body.metrics, REV).status));
ok('no list reply carries a pin, for anyone', !/"pin"/.test((await W.call('ed', 'metric:list', { projectId: P })).text) && !/"pin"/.test((await W.call('east', 'term:list', { projectId: P })).text));
```
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-governanceReplies.js` fails, because Revenue has no `status`.
- [ ] **Step 3: Implement.** For `dataset:list`, apply `withStatus` to `list` before the restricted branch maps it, so `scoped` and `status` both apply.
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-governanceReplies.js && DATABASE_URL=… node scripts/test-governanceReplies.js && node scripts/test-metrics.js && node scripts/test-catalog.js && node scripts/test-terms.js && DATABASE_URL=… node scripts/test-rowPolicySafetyNet.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src/analysis/statusStore.ts src/ipc/metrics.ts src/ipc/datasets.ts src/app/catalogIndex.ts src/ipc/terms.ts scripts/test-governanceReplies.ts` · "Say each metric's, term's and dataset's status in the lists that name them"

### Task 2: `model:overview` says what needs review
**Files:** Create `src/analysis/statusReview.ts` · Modify part 1's `src/ipc/modelOverview.ts` (the reply gains `review`) · Test `scripts/test-modelOverview.ts` (part 1's suite, extended)
**Interfaces:** Consumes `metricUsage` (`src/analysis/metricUsage.ts`), part 1's `termUsage` (`src/analysis/termUsage.ts`), `catalogIndex.usageCounts` (`src/app/catalogIndex.ts:142`). Produces:
```ts
export interface ReviewItem { ref: string; name: string; kind: 'needs_review' | 'retired_used'; uses?: number }
export async function reviewItems(projectId: string): Promise<ReviewItem[]>; // needs_review first, then retired with uses > 0 (most used first); at most 8
```
`model:overview`'s reply adds `review: ReviewItem[]`, and omits the key when the list is empty. Only items the catalog lists in `status` are looked at, and only retired ones are counted.
- [ ] **Step 1: Write the failing test**
```ts
ok('NEGATIVE CONTROL: no status, no review key', !('review' in (await ov())));
await certifyNow(P, `metric:${REV}`); await metrics.updateMetric(P, REV, { filters: [F0] });
await statusStore.retire(P, `metric:${GROSS}`, `metric:${NET}`, ''); // GROSS is on two cards
const r = (await ov()).review;
ok('changed since certified leads, then retired and used', stableStringify(r.map((i: ReviewItem) => [i.ref, i.kind, i.uses ?? null])) === stableStringify([[`metric:${REV}`, 'needs_review', null], [`metric:${GROSS}`, 'retired_used', 2]]));
ok('a retired item nobody uses is not listed', !r.some((i: ReviewItem) => i.ref === `metric:${UNUSED_RETIRED}`));
```
- [ ] **Step 2: Run it to see it fail.** `node scripts/test-modelOverview.js` fails, because `review` is undefined.
- [ ] **Step 3: Implement.** `uses` is `metricUsage(...).total`, `termUsage(...)[id]?.total` or `usageCounts(...).get('dataset:' + id)`, each in a `try` that leaves `uses` undefined (an unknown count never reads as 0).
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-modelOverview.js && node scripts/test-governanceReplies.js && node scripts/test-asyncReach.js` all report `ok`.
- [ ] **Step 5: Commit.** `git add src/analysis/statusReview.ts src/ipc/modelOverview.ts scripts/test-modelOverview.ts` · "List what changed since it was certified and what is retired but still used"

Not in this step: any web (03), the Assistant and MCP (04), or a status filter on `metric:list` (the Metrics tab filters in the browser).
