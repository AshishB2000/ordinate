# Semantic layer part 4 (governance): implementation plan index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan below task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implement the plans in the order of the table below, one PR each.

**Goal:** Certified and retired status on metrics, glossary terms and datasets, pinned to content so an edit visibly undoes certification. Admin-set column access rules that hide a column's values, and every figure computed from it, from project viewers who are not named, on every reader.

**Architecture:** Status is a new `status` section of the project catalog (`src/app/catalog.ts`). Each entry holds a hash (`pinOf`) of everything the figure depends on, and a moved hash reads as `needs_review`. Status is read per request and attached to the replies that list items. It is never part of a figure or a cache key. Column rules are a raw `columnAccess` key on the dataset record, beside `rowPolicy`, and the row-access machinery enforces them. A gate (`gateColumns`) runs at the figure doors and at `withLockOf` before the row lock, the answer cache and the Live split. The storage net (`closedReason`) closes a dataset that hides a column from the caller to every reader outside a gated door. Inside a gated door, the reader returns no hidden values.

**Spec:** [docs/semantic-layer/04-governance.md](../../semantic-layer/04-governance.md) (approved 2026-11-03; the Owner's answers are binding). It builds on part 1 ([index](2026-11-03-semantic-layer-p1-00-index.md)) and on row access ([docs/row-policy/00-design.md](../../row-policy/00-design.md)).

## The PR chain

| # | PR branch | Plan | Needs merged first | Release |
|---|---|---|---|---|
| 1 | `feat/semantic-p4-01a-readers` | [01a](2026-11-04-semantic-layer-p4-01a-readers.md) | part 1 01a (release 1: `tableDocs.ts`, whose style and `sanitizeCatalog` line Task 1 builds on) | A |
| | **the owner cuts release A (with part 1's release-A PRs and the other parts' readers), and it rolls out on every pod** | | | |
| 2 | `feat/semantic-p4-01-status-store` | [01](2026-11-04-semantic-layer-p4-01-status-store.md) | 01a **released**; part 1 05b (terms) | B |
| 3 | `feat/semantic-p4-02-status-replies` | [02](2026-11-04-semantic-layer-p4-02-status-replies.md) | 01; part 1 10 (Data model section) | B |
| 4 | `feat/semantic-p4-03-status-web` | [03](2026-11-04-semantic-layer-p4-03-status-web.md) | 02 | B |
| 5 | `feat/semantic-p4-04-status-assistant` | [04](2026-11-04-semantic-layer-p4-04-status-assistant.md) | 02 | B |
| 6 | `feat/semantic-p4-05-column-gate` | [05](2026-11-04-semantic-layer-p4-05-column-gate.md) | 01a released, 04 | B |
| 7 | `feat/semantic-p4-06-column-everywhere` | [06](2026-11-04-semantic-layer-p4-06-column-everywhere.md) | 05 | B |
| 8 | `feat/semantic-p4-07-column-setter` | [07](2026-11-04-semantic-layer-p4-07-column-setter.md) | 06 (the setter merges last) | B |

**Release A** is the combined release A (see [Combined release order](#combined-release-order)): 01a rides in it with part 1's release-A PRs. **Release B** is the combined release B: 01–06 merge right after part 1's release-B chain and before parts 2, 3, 6 and 8's release-B PRs, and 07 merges last in B. Release B is cut only after PR 8 merges. 01's merge gate checks that 01a has been released: `git tag --contains <01a merge sha>` must list a `v*` tag (the same check as part 1 05b's Task 8). 02–07 are chained in this order because they share `rowDoors.ts`, `rowAccess.ts`, `ipc/metrics.ts` and the web pickers. The owner merges fast, so push them as an ordered chain, never as parallel PRs.

## Rolling deploys: what an older pod does with each new thing

| New stored thing | A pod older than release A | A release-A pod | Covered by |
|---|---|---|---|
| catalog `status` section | Drops it on the next catalog write (any tag or note edit), and every certification is lost | Keeps it verbatim and shows no badge, which fails safe | 01a Task 1 |
| dataset record `columnAccess` | Drops it on the next data write (`writeRecordKeepingPolicy` copies only `rowPolicy`), and **serves the hidden values** | Keeps it on every writer and copy. A restricted caller, and every fan-out, is refused that dataset (`columns`) | 01a Tasks 2–3 |
| version events `certified`/`retired`/`cleared` | Shows the stored `summary` ("Certified"). Version files are append-only and never re-saved | same | nothing needed |
| reasons `hidden`, `columns` | never sees them | `columns` only | web `refusalOf` shows the server's sentence for any `row_policy` reason |
| reply fields `status`, `hidden`, `hiddenColumns`, `review` | n/a | n/a | additive. An old browser tab ignores them. A hidden cell arrives as `null` in place, so old tabs never misalign a grid (05) |

The setter for column rules ships in the same release B as enforcement. That is safe because release A pods fail closed on any `columnAccess`. Never `helm rollback` below release A once rules exist (01a Task 4 says so in `docs/server/upgrade.md`).

## Combined release order

All eight parts ship in three releases, **A**, **B** and **C**, in the merge order set by [the cross-part check](2026-11-04-semantic-layer-cross-part-check.md#c-combined-release-order) (section (c)). Part 4: 01a is in release A; 01–06 are in release B right after part 1's release-B chain, so `COLUMN_TREATMENT` and the prompt canaries bind every later release-B PR; 07, the setter, is the last PR of release B. Nothing of part 4's is in C. A writer never reaches a release before the reader of its field is rolled out on every pod; the owner may cut extra releases inside a gate, never fewer. `src/ipc/visuals.ts` is projected at about 790 of its 800 lines once parts 1, 4, 5, 6 and 8 have touched it: every PR that edits it states the file's line count in its body, and a PR that would take it past 795 splits `vizDataForUnlocked` out first.

## Global Constraints

- No remote access of any kind on weekdays 08:00–18:00 local time, not even a read (the owner's global rule, enforced by a hook). Refreshing `origin/develop`, the merge-gate tag check, pushing and opening PRs all happen outside that window. No release, `v*` tag or image push without the owner.
- One worktree per PR off `origin/develop` (`feature-branch-workflow` skill). Never commit to `develop`, never `git checkout`/`git switch` in the shared clone, and no `Co-Authored-By` or AI trailer on any commit.
- No new runtime dependency, no SQL migration, no env var. Everything is catalog JSON or raw record keys.
- `src/api/index.ts`, `web/src/app/routes.tsx` and `web/src/app/nav.ts` are append-only. Six new channels (`model:review`, `model:certify`, `model:retire`, `model:clearStatus`, `dataset:columnAccess`, `dataset:setColumnAccess`), all `access: 'admin'`, project scope, zod input. No new `read` contract, but every existing `read` contract gets a `COLUMN_TREATMENT` (06).
- File caps 500/800. These are near the cap, so their changes are calls only (new logic goes in new files): `src/engine/datasetPage.ts` 794, `src/ipc/visuals.ts` 773, `src/ipc/datasets.ts` 751, `src/ipc/copilot.ts` 605, `src/ai/copilotFacts.ts` 577, `src/ipc/metrics.ts` 563, `src/ipc/answers.ts` 510, `src/app/sharePolicy.ts` 432, `src/app/catalog.ts` 428, `src/data/rowAccess.ts` 347. Part 1 grows some of them. Re-measure before each PR.
- Sentences go through `t()` in a file listed in `MAIN_FILES` (`scripts/i18n-extract.ts:375`), then `node scripts/i18n-extract.js`. Never hand-edit `en.json`. A refusal sentence names no team, no user and no value (row-policy D15).
- Engines do the math. Status and column rules refuse or label a figure, never change one. A question that reads no hidden column gets a reply `Object.is`-equal to the editor's, and a project with no status and no rules gets byte-identical replies.
- Golden fixtures are never re-recorded. `npm run lint` 0, `node scripts/check-contracts.js` 0 unresolved, required checks `smoke (all shards)` + `oxlint (blocking)`.

## Review Focus

1. **Fail open on a writer or a copy.** `columnAccess` must survive every dataset-record writer and every copy (01a's writer walk, 07's refresh-racing-setter test).
2. **A door path that skips the gate.** Every figure must pass `gateColumns`: the three doors, the four `withLockOf` readers, and formula and metric re-entry. The net must refuse the rest (05's planted readers, 06's canaries in every prompt).
3. **Gate after cache.** The gate runs before `queryCache.through`. 05's seam test proves a viewer would otherwise get the editor's cached `sum(salary)`.
4. **A badge that lies.** Restore, duplicate, bundle import, a term or metric edit and a dataset Prepare edit must each read `needs_review` or carry no status (01's pin table and its `Record<keyof …>` exhaustiveness).
5. **Fan-out over-refusal or under-refusal.** A publish that does not read `salary` must still publish. A site built before the rules must stop being served (06).

## Calls made while planning (the owner's recommended answers applied, plus code facts)

- **Two releases (A readers, B features).** Like part 1: an older pod would drop `status` and `columnAccess` and serve hidden values.
- **Status has its own kinds** (`metric|term|dataset`, `src/app/statusDocs.ts`). D2's "`'term'` joins `CATALOG_KINDS` and the catalog `Ref` regex" is not needed. Status lives in its own section, so the catalog's `records`, `catalog:list` kinds and tag index stay as they are.
- **`model:certify` takes the pin as its base**, not the edit-conflict tag D3 names. A dataset has no content tag (`SaveKind`, `src/analysis/recordDiff.ts:42`), and a term edit moves a metric's pin without moving the metric's tag. An admin gets the pin from a fourth status channel, **`model:review`** (admin; six new channels in all), opened by the Review dialog, which also gives the newest version key for `versions:diff`. No list reply carries a pin: a hash of a term's values would confirm a guessed value to a restricted viewer.
- **A dataset's pin hashes its whole sanitized origin**, which is wider than D4's "kind and connection". A changed SQL text, table or URL changes the figure, and origins hold no volatile fields (`src/data/datasetOrigin.ts:36-92`).
- **Picker order is done in the browser** by one pure helper. The server list order stays by name (byte-identical). No Assistant matcher picks among metrics by similarity today (names are unique and matched exactly: `answerSpec.resolveMeasure`, `automation/resolve.pick`). So D9's ranking is the vocabulary order in `factMetrics`/`specMetrics`, certified first.
- **Two new row-policy reasons, not four.** `hidden` (the question names a hidden column) and `columns` (the rules no longer hold: the pipeline changed, a column is gone, a record is corrupt, an as-of read, or a whole-table reader). D14's `pipeline`/`gone` already carry row-rule sentences.
- **Fixed refusal sentences.** The mockup's "uses salary, which only HR can see" would name a team, and `tagRowPolicyRefusals` matches exact sentences. The grid's note and the Fields tab's lock say which columns are hidden.
- **Hidden grid cells are nulled in place, not removed** (D16). An old tab's header would otherwise misalign. Grid search is refused while a column is hidden from the caller: `datasetPage.ts` is at 794 lines and cannot take a per-column search without a split.
- **A `/p/` site stops being served by timestamp** (rules `updatedAt` > `publishedAt`), not by widening `policyClosed`. That would refuse every publish of such a dataset at the send points.
- **Column rules travel in bundles.** Dataset records are exported raw, as `rowPolicy` is today. Foreign user and team ids name nobody, so an import fails closed. Stripping the rules would open the columns. Part 7's "column rules never leave" is about definition files.
- **The edit warning (D5) lives in the metric editor and the term dialog.** A certified dataset's Prepare shows a standing banner instead of a confirm on every step.

## Interfaces other parts consume

`StatusDoc`, `sanitizeStatus`, `parseStatusRef`, `STATUS_KINDS` (`src/app/statusDocs.ts`). `statusFor(projectId)` → `(ref) => Promise<StatusView | null>` and `StatusView` (`src/analysis/statusStore.ts`). `pinOf(projectId, ref)` (`src/analysis/statusPin.ts`). `hiddenColumnsFor(projectId, datasetId)`, `hiddenAnywhere(projectId)` (`src/data/rowAccess.ts`). `columnView`, `columnReason` (`src/data/columnGate.ts`). `gateColumns` (`src/ipc/columnDoors.ts`). `metricHidden`, `termHidden` (`src/analysis/columnHidden.ts`). `mentionsHidden`, `carriersOf`, `buildColumnAccess`, `columnAccessFromRecord` (`src/data/columnAccess.ts`). The reasons `hidden` and `columns` (`src/data/rowPolicyError.ts`). `COLUMN_TREATMENT` (`scripts/columnAccessReaders.ts`). No part 3 plan consumes `statusFor`: a verified question on a retired metric keeps running and carries `retiredNotes` (p3-05, p3-09; cross-part check item 8). Part 7 does not export `StatusDoc` in model files formatVersion 1 (design 07: "later, under a `formatVersion` bump"; item 10). No part 8 plan uses `carriersOf` (item 11). Parts 3, 6, 7 and 8 classify their new `read` contracts in `COLUMN_TREATMENT` and drop hidden columns from their prompts (item 6).

## Execution

Implement in the table's order. For each PR: create its worktree off `origin/develop`, implement the plan's tasks with their tests, run the listed suites (DB suites with `DATABASE_URL`: see the `local-postgres-for-db-suites` memory), do every remote step (refreshing `origin/develop`, pushing, opening the PR) outside weekdays 08:00–18:00, wait for CI and the owner's merge, then start the next.
