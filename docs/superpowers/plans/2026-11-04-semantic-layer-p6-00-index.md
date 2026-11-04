# Semantic layer part 6 (navigation) — implementation plan index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan below task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implement the PRs in the order of the table below, one PR each.

**Goal:** Hierarchies of a dataset's text columns (and dates, implicitly) that people drill down and back up on dashboard tiles and in Explore, filter pickers that narrow a lower level by the level above it, and topics: a team's short list of datasets, fields, metrics and terms for Explore, the Assistant, MCP and the Data model section.

**Architecture:** A drill is a new question. `visual:drillDown` (new, `src/ipc/drillDown.ts`) runs the rows panel's own resolver (`drillScope` → `resolveDrill`) on the clicked mark and answers the exact filter steps plus the next level's encoding; the browser then asks `visual:data` / `analysis:tiles` as for any chart, so no new figure path exists. Hierarchies live on part 1's `TableDoc` (`catalog:setTable`); topics are a new project record kind like terms. `model:navigation` returns both, plus the calendar's date ladder, in one metadata-only reply. Pure ladder rules (`src/analysis/drillLevels.ts`) are shared by the server and the web.

**Tech Stack:** TypeScript server (`src/`), RPC contracts (zod), recordFs, the Live executor, React 19 + TanStack Query (`web/`), self-check suites, Vitest, Playwright.

**Spec:** [docs/semantic-layer/06-navigation.md](../../semantic-layer/06-navigation.md) (approved 2026-11-03; its Owner's answers are binding). Builds on part 1 ([index](2026-11-03-semantic-layer-p1-00-index.md)): `TableDoc`/`catalog:setTable` (01), value labels (06), the Data model section and `src/api/model.ts` (10), terms (05b).

## The PR chain

Two releases. **Release A** holds what an older pod must already understand before any browser or pod writes it: the hierarchies reader (a pre-part-6 pod's `sanitizeTableDoc` would erase every hierarchy of a project on its next catalog write) and the server half of the cascading picker (so a release-B browser never meets a pod that refuses `dataset:distinct.filters`, or one that ignores it on Live without saying so). Release A needs nothing from part 1 beyond release 1, so if both PRs merge before the owner cuts part 1's release 2, they ride in it. **Release B** holds the features.

| # | PR branch | Plan | Needs merged first | Release |
|---|---|---|---|---|
| 1 | `feat/semantic-p6-01a-hierarchies-reader` | [01 Task 1](2026-11-04-semantic-layer-p6-01-hierarchies.md) | part 1 01a (in a release) | A |
| 2 | `feat/semantic-p6-05a-distinct-filters` | [05 Task 1](2026-11-04-semantic-layer-p6-05-cascading-pickers.md) | p6-01a | A |
| | **owner cuts release A (or it rides in part 1's release 2), and it rolls out everywhere** | | | |
| 3 | `feat/semantic-p6-01-hierarchies` | [01 Tasks 2–5](2026-11-04-semantic-layer-p6-01-hierarchies.md) | part 1 step 10 (`src/api/model.ts`, the Data model page); p6-01a released | B |
| 4 | `feat/semantic-p6-02-drill-down` | [02](2026-11-04-semantic-layer-p6-02-drill-down.md) | 01; the `resolveDrill` joined-category fix (else 02 Task 0 carries it) | B |
| 5 | `feat/semantic-p6-03-explore-drill` | [03](2026-11-04-semantic-layer-p6-03-explore-drill.md) | 02 | B |
| 6 | `feat/semantic-p6-04-dashboard-drill` | [04](2026-11-04-semantic-layer-p6-04-dashboard-drill.md) | 03 (shares `web/src/features/visuals/drill/drillApi.ts`) | B |
| 7 | `feat/semantic-p6-05-cascading-pickers` | [05 Tasks 2–3](2026-11-04-semantic-layer-p6-05-cascading-pickers.md) | 04 (`useNavigation` on dashboards); p6-05a released | B |
| 8 | `feat/semantic-p6-06-next-level-chip` | [06](2026-11-04-semantic-layer-p6-06-next-level-chip.md) | 05 (chain order only; it needs 01) | B |
| 9 | `feat/semantic-p6-07-topics` | [07](2026-11-04-semantic-layer-p6-07-topics.md) | 06 | B |
| 10 | `feat/semantic-p6-08-topics-readers` | [08](2026-11-04-semantic-layer-p6-08-topics-readers.md) | 07; part 1 05b (`list_terms`, `term:list`) | B |

PRs are chained, never parallel: 04, 05 and 07 touch the same dashboard and Data model files, and the owner merges fast.

## Rolling deploys (every new stored field and record kind)

| What is stored | A pod of the previous release reads and re-saves it | Handled by |
|---|---|---|
| `TableDoc.hierarchies` (catalog.json) | **Dropped** on its next catalog write (any tag, note or table doc): `sanitizeTableDoc` whitelists its fields (`src/app/tableDocs.ts:45-56`) | p6-01a ships the reader in release A; the writer (01) ships in B |
| `topic` records (`topics/<id>.json`) | Never read (no store reads `topics/`). Trash skips the type (`trashStore.listEntries` → `isRecordType`). Bundle export leaves them out and import refuses a bundle holding them (whitelist `bundleRules.ts:31`) | Safe: no figure reads a topic. 07 documents the bundle gap in `docs/server/upgrade.md` |
| Drill state, cascade steps, `topic=` in Explore's URL, the remembered topic | Browser only (view state, URL, localStorage) | Nothing to keep |
| Drill steps saved from Explore ("Save as visual") | Plain `type: 'filter'` steps (`=` or a `custom` period), never `fromControl` | Every release reads them |

New channels (`model:navigation`, `visual:drillDown`, `topic:*`) 404 on a release-A pod during release B's rollout. The web treats a failed `model:navigation` as "no hierarchies, no topics" (today's screens) and a failed drill as a toast plus today's rows drawer.

## Global Constraints

- No push, `gh pr create` or release on weekdays 08:00–18:00 local time (the owner's global rule, enforced by a hook). No release, `v*` tag or image push without the owner.
- One worktree per PR off `origin/develop` (`feature-branch-workflow` skill); never commit to `develop`; never `git checkout`/`git switch` in the shared clone. No `Co-Authored-By` or AI trailer on any commit.
- Engines do the math: a drill re-asks `visual:data`; crumbs, nesting and the cascade come from structure. The web never sums, derives or rounds a figure.
- `src/ipc/visuals.ts` (773 lines) and `src/ipc/datasets.ts` (751) take at most 3 lines each; `src/ai/answerSpec.ts` (639) and `src/ipc/copilot.ts` (605) a few lines each; `src/server/app.ts` (652) none (modules join existing arrays at `:570` and `:602`). New logic goes in new files.
- `src/api/index.ts`, `web/src/app/routes.tsx` and `web/src/app/nav.ts` are append-only (part 6 appends nothing to routes or nav).
- Every new `read` contract is classified in `scripts/rowPolicyReaders.ts`; every new row-reading channel joins `scripts/test-liveSafetyNet.ts`; `node scripts/check-contracts.js` reports 0 unresolved; `npm run lint` reports 0.
- Server sentences through `t()` in new message files added to `MAIN_FILES` (`scripts/i18n-extract.ts`), then `node scripts/i18n-extract.js`. The React UI is English-only.
- `scripts/termSites.ts` (05a's ratchet) is re-counted for every file whose filter-site matches change: classify each new site, never just bump a count.
- No new runtime dependency, no migration. Golden fixtures are never re-recorded. RPC budget 25 per load; initial JS ≤ 300 KB gzip (the drill UI lives in the dashboards and Explore chunks).

## Review Focus

1. **A drilled figure that disagrees with its bar**, or a child counted under two parents: 02's differential test (rows behind the mark vs rows behind the drilled chart) and its planted-Springfield negative control.
2. **Two meanings of a click**: drill and the rows panel must resolve through the same `drillInputs` → `resolveDrill`, and refuse with the same sentence (02).
3. **Live**: a drill's grain lookup is the tile's own cached question (0 extra statements, 02 pins it); a Live picker says "not narrowed" (05a).
4. **A topic mistaken for access control**: every reader answers a dataset outside the topic (07, 08 pin it); the copy never says hidden or restricted.
5. **Old pods**: 01a's "an old-path write keeps hierarchies" test; a failed `model:navigation` leaves today's screens (03, 04, 05, 07).

## Calls made while planning (the owner's recommended answers applied; listed so a reviewer knows they are deliberate)

- **Click-to-filter is on for every new dashboard and sheet** (`src/analysis/analysis.ts:375`, `web/src/features/analyses/editor/Head.tsx:104`), not "off unless the sheet turns it on" as D7 says. Following D7's order, a plain click on those sheets still filters; drill is then the right-click menu's and the phone sheet's. Reported to the owner; the plain-click menu (answer 1) applies on sheets with click-to-filter off.
- **The rows panel resolves a joined category to a main-table column of the same name** (`resolveDrill`, `src/ipc/visuals.ts:229`, never reads `categoryDatasetId`/`seriesDatasetId`): the bug is real. 02 builds on the fix and carries it as Task 0 if the other session has not landed it.
- `visual:drillDown` takes the `Drill` shape without `metricId` (a KPI does not drill) and without `asOf`, because the rows panel's contract has none either (its handler reads `asOf`, but the strict contract never lets it through: a gap of its own, out of scope).
- `visualId` stays on a drilled tile's request: only a waterfall reads it (`storedFigureAsk`, `src/ipc/rowDoors.ts:252`), and waterfalls never drill.
- Crumbs read the hierarchy's name ("Product › Technology · by sub_category"), because "All regions" needs a plural of a column name. Explore draws crumbs for text levels only; a date drill there is undone by Back, since a period step alone does not say which grain it came from. Dashboard tiles keep an explicit stack and show date crumbs.
- The differential tests run on a fixture with the sample's columns and whole-number amounts, so `Object.is` holds whatever the summation order.
- Caps: 2–6 levels, 10 hierarchies per dataset, 50 topics per project, 12 datasets per topic, 500 fields per topic dataset, 100 metrics and 100 terms per topic.
- `topic:save` both creates and updates (with the edit-conflict `base`); the list rides `model:navigation`; `topic:get` gives the editor its tag and its stale count. Topics keep no version history (the spec asks for Trash and the conflict tag only).

## Execution

Implement in the table's order. For each PR: create its worktree off `origin/develop`, implement the plan's tasks with their tests, run the listed suites, push and open the PR outside work hours, wait for CI and the owner's merge, then start the next. UI PRs post their light and dark e2e screenshots in the PR body: the owner's look at them is the mockup gate the spec asks for.
