# Semantic layer part 1 — implementation plan index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan below task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implement the plans in the order of the table below, one PR each.

**Goal:** Build part 1 of Ordinate's own semantic layer: checked dataset keys and guides, value labels, metrics that know whether they add up and which date they count by, snapshot metrics, charts that follow their metric, glossary terms, always-applied filters on Live datasets, one table joined two ways, and the Data model section that shows it all.

**Architecture:** Extend the stores that exist (catalog, metric records, relationships, the Live dataset record) and add one record kind (terms); every figure still comes from the existing doors (`vizDataFor`, `computeCardMetric`, `computeCard`) and engines, with JS references and resident twins held to `Object.is`, and Live either compiling or refusing with a typed sentence. Every new stored field first ships in a "keep what's coming" release, so pods of the previous release never drop or misread it.

**Tech Stack:** TypeScript server (`src/`), DuckDB resident queries, the Live compiler (`src/engine/live/`), React 19 web app (`web/`), self-check suites (`scripts/test-*.ts`), Vitest, Playwright.

**Spec:** [docs/semantic-layer/00-design.md](../../semantic-layer/00-design.md) (approved 2026-11-03).

## The PR chain

Part 1 ships in two of the three combined releases (see [Combined release order](#combined-release-order)). **Release A ("keep what's coming", formerly release 1)** holds only readers and guards: after it, every pod keeps the new fields verbatim and refuses, with a sentence, anything it can't yet apply. Besides part 1's seven PRs below, release A also carries the other parts' readers and guards, merged after part 1's before the owner cuts it: p2-01, p2-02, p3-01, p3-02, p4-01a, p6-01a, p6-05a, p8-00a, p8-02 and p8-03. **Release B (formerly release 2)** holds part 1's features. The owner cuts both; release A must be deployed on every pod before any release-B PR reaches a release (`docs/server/upgrade.md` says so after 05a).

| # | PR branch | Plan | Needs merged first | Release |
|---|---|---|---|---|
| 1 | `feat/semantic-p1-09a-via-guard` | [09 Task 0](2026-11-03-semantic-layer-p1-09-labelled-joins.md) | — | A |
| 2 | `feat/semantic-p1-08a-base-filter-guard` | [08 Task 0](2026-11-03-semantic-layer-p1-08-live-base-filters.md) | — | A |
| 3 | `feat/semantic-p1-01a-readers` | [01 Task 1](2026-11-03-semantic-layer-p1-01-tables.md) | — | A |
| 4 | `feat/semantic-p1-04a-time-column-reader` | [04 Task 1](2026-11-03-semantic-layer-p1-04-time-column.md) | 09a | A |
| 5 | `feat/semantic-p1-02a-snapshot-reader` | [02 Task 1](2026-11-03-semantic-layer-p1-02-additivity.md) | — | A |
| 6 | `feat/semantic-p1-05a-unknown-steps-kept` | [05a](2026-11-03-semantic-layer-p1-05a-unknown-steps-kept.md) | 09a, 04a | A |
| 7 | `feat/semantic-p1-r1-review-fixes` | The whole-release review fixes (no plan file) | 05a | A |
| | **then the other parts' release-A PRs (p2-01, p2-02, p3-01, p3-02, p4-01a, p6-01a, p6-05a, p8-00a, p8-02, p8-03); the owner cuts release A, and it rolls out everywhere** | | | |
| 8 | `feat/semantic-p1-01-tables` | [01 Tasks 2–7](2026-11-03-semantic-layer-p1-01-tables.md) | 01a | B |
| 9 | `feat/semantic-p1-02-additivity` | [02 Tasks 2–5](2026-11-03-semantic-layer-p1-02-additivity.md) | 01, 02a | B |
| 10 | `feat/semantic-p1-03-charts-follow-metric` | [03](2026-11-03-semantic-layer-p1-03-charts-follow-metric.md) | 02 | B |
| 11 | `feat/semantic-p1-04-time-column` | [04 Tasks 2–8](2026-11-03-semantic-layer-p1-04-time-column.md) | 03, 04a | B |
| 12 | `feat/semantic-p1-05b-terms` | [05b](2026-11-03-semantic-layer-p1-05b-terms.md) | 04, 05a released | B |
| 13 | `feat/semantic-p1-06-value-labels` | [06](2026-11-03-semantic-layer-p1-06-value-labels.md) | 05b, 01a released | B |
| 14 | `feat/semantic-p1-07-snapshot` | [07](2026-11-03-semantic-layer-p1-07-snapshot.md) | 06, 02a released | B |
| 15 | `feat/semantic-p1-08-live-base-filters` | [08 Tasks 1–7](2026-11-03-semantic-layer-p1-08-live-base-filters.md) | 07, 08a released | B |
| 16 | `feat/semantic-p1-09-labelled-joins` | [09 Tasks 1–5](2026-11-03-semantic-layer-p1-09-labelled-joins.md) | 08, 09a released | B |
| 17 | `feat/semantic-p1-10-data-model-section` | [10](2026-11-03-semantic-layer-p1-10-data-model-section.md) | 09 | B |

The order differs from the plans' own "after" lines in three places, all to fit release A: 04a no longer waits for step 03 (Task 1 touches only the metric sanitizer, the filter-step sanitizer and `recordDiff`); 02's Task 1 ships on its own as 02a; and 05a needs 04a, not all of step 04 (if 05a turns out to need step 04's exported `stepKey`, move that export into 04a).

## Combined release order

All eight parts ship in three releases, **A**, **B** and **C**, in the merge order set by [the cross-part check](2026-11-04-semantic-layer-cross-part-check.md#c-combined-release-order) (section (c)). Part 1: its seven release-1 PRs (the six above plus `feat/semantic-p1-r1-review-fixes`) open release A, followed by the other parts' readers and guards; steps 01–10 open release B. Nothing of part 1's is in C. A writer never reaches a release before the reader of its field is rolled out on every pod; the owner may cut extra releases inside a gate, never fewer. `src/ipc/visuals.ts` is projected at about 790 of its 800 lines once parts 1, 4, 5, 6 and 8 have touched it: every PR that edits it states the file's line count in its body, and a PR that would take it past 795 splits `vizDataForUnlocked` out first.

## Global Constraints

- No push, `gh pr create` or release on weekdays 08:00–18:00 local time (the owner's global rule, enforced by a hook).
- One worktree per PR off `origin/develop` (`feature-branch-workflow` skill); never commit to `develop`; never `git checkout` or `git switch` in the shared clone.
- No `Co-Authored-By` or any AI co-author trailer on any commit.
- No release, `v*` tag or image push without the owner. Release A is fully rolled out before a release-B PR ships (05b's merge gate checks it with `git tag`).
- No new runtime dependency. No migration: everything is records or catalog JSON with additive optional fields.
- File caps: 500 soft, 800 hard. Near the cap today: `src/data/datasets.ts` 799, `src/data/transforms.ts` 795 (09a and 05a move its sanitizers out), `src/ipc/visuals.ts` 769, `src/ipc/datasets.ts` 748, `src/analysis/alertStore.ts` 633, `src/ai/answerSpec.ts` 632. New logic goes in new files.
- `src/api/index.ts`, `web/src/app/routes.tsx` and `web/src/app/nav.ts` are append-only.
- Golden fixtures are never re-recorded to make a test pass. A project that fills in nothing new draws byte-identically.
- Required checks on every PR: `smoke (all shards)` and `oxlint (blocking)`. `npm run lint` reports zero; `node scripts/check-contracts.js` reports 0 unresolved; new `read` contracts are classified in `scripts/rowPolicyReaders.ts`.

## Review Focus

Cross-cutting failure modes no single plan's happy path covers; each line names the plan whose tests must pin it. A reviewer of that PR checks the test exists.

1. **A dataset refreshed with a changed schema.** A key column, `timeColumn`, snapshot column, value-labelled column, a term's column or a base filter's column is renamed or removed. Expected: a visible flag or a typed refusal, never a silently different figure. Owners: 01 (key check: column gone), 04 (`timeColumn` no longer a date counts as unset and is flagged), 05b (`column_gone`), 06 (labels for a missing column ignored and flagged), 07 (`snapshotProblem`), 08 (a base filter on a missing column refuses every Live statement).
2. **Mixed versions during a rolling upgrade.** An older pod or an older browser tab reads and re-saves a record holding a new field. Expected: release-A pods keep it and refuse; nothing is dropped. Owners: 01a, 02a, 04a, 05a, 08a, 09a (each has a "re-save keeps it" test and a negative control).
3. **Row-restricted viewers.** Term filter values, a column's value list, key-check counts, version diffs of a term. Expected: none of these reach a viewer restricted by row access rules. Owners: 05b, 06, 01.
4. **Live datasets.** Each new figure path either compiles (with base filters in every statement and values bound) or refuses with a typed sentence; extra statements count against `LIVE_DAILY_QUERY_LIMIT`. Owners: 03 (one statement per metric filter list), 07 (refusal), 08 (every builder, by source-scan count), 01 (`compileKeyCheck` takes base filters once 08 lands).
5. **Old content stays exactly as it was.** Saved charts, dashboards, published pages and alerts with no new field set. Expected: byte-identical replies. Owners: 03, 04, 06, 09 (each compares against today's reply or the golden fixtures).

## Calls made while planning (the owner's recommended answers applied; listed so a reviewer knows they are deliberate)

- **Two releases** (now A and B of the combined order) as above, because the catalog, metric, relationship and dataset sanitizers whitelist their fields today, so a pod of the current release would erase guides, labels, `timeColumn`, snapshots, labels and `via` on its next write.
- **Explore's default date axis (D9) is dropped from part 1:** Explore carries no metric measure (`decodeQuestion` drops `metricId`), so there is nothing to attach it to.
- **No calc picker to grey (D7):** the desktop's `calcMenu.ts` was deleted; the refusal shows where the figure would be. **The metric-tree `sum` guard (02 Task 5) is dropped:** the tree already shows a "Not explained by its parts" row instead of a wrong total, and the guard would block a valid sum of averages over the same rows.
- **Alerts:** they evaluate a stored `{column, aggregation}` copy, so D8's "through the existing doors" was wrong; 07 Task 6 makes an alert with a `metricId` read its metric's snapshot.
- **Value labels travel beside raw values** (`data.valueLabels` raw→label pairs), applied at the reply edges and in the browser through one pure module, because cross-filter, drill, colours and six server callers key by the raw label. Maps, pivots, cohort and funnel grids, facets, tree splits, scorecard breakdowns and driver text keep raw values in part 1.
- **Terms expand before the row-access gates** (the spec said after the lock): the gates read the filters, so a term could otherwise reach a closed related dataset. The lock still ends up first in the list.
- **Restricted viewers** get no key-check counts (as `quality:list` already hides results).
- **Tile captions** ("counts by Order date") appear on live dashboard tiles, not on `/p/` pages.
- **Relationship warnings are stored as data** (`{ kind: 'repeats'; repeats } | { kind: 'not_key'; key }`) and worded by the web, so the sentence follows the reader's language.

## Execution

Implement in the table's order. For each PR: create its worktree off `origin/develop`, implement the plan's tasks with their tests, run the listed suites, push and open the PR outside work hours, wait for CI and the owner's merge, then start the next. Each plan names the existing suites it must keep green.
