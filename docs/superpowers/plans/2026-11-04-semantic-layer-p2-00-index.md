# Semantic layer part 2 (source tables): implementation plan index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan below task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implement the plans in the order of the table below, one PR each.

**Goal:** Editors document the warehouse tables their datasets are built from (owner, refresh, required filters, a markdown guide), read what the warehouse already knows (comments, keys, partitions, size) on a click, and see it in a **Source tables** tab of the Data model and read-only in each dataset's Guide. Viewers never see a source table's name anywhere, and that starts by closing today's leaks.

**Architecture:** Two new record kinds under each connection (`connections/<connId>.tables.json` is an index, and `connections/<connId>/tables/<docId>.json` is one doc), read per request, never cached. One optional connector method, `tableFacts`, sits behind one new door, `readTableFacts` (SSRF guard, bounds, `safeError`, a cross-pod rate limit). A dataset finds its source tables only from its origin, on the server, plus an editor-set `readsTables` label. Every new channel is `write`, so a viewer gets 403 before a handler runs. The web adds one tab to part 1's Data model, a block to its dataset Guide, and suggested meanings to its Fields.

**Tech Stack:** TypeScript server (`src/`), connector families (`src/connectors/`), records through `recordFs`, zod contracts, self-check suites (`scripts/test-*.ts`), React 19 + TanStack Query + CSS Modules, Vitest, Playwright.

**Spec:** [docs/semantic-layer/02-source-tables.md](../../semantic-layer/02-source-tables.md) (approved 2026-11-03, owner took every recommended answer). Part 1: [00-design.md](../../semantic-layer/00-design.md) and its [plan index](2026-11-03-semantic-layer-p1-00-index.md).

## The PR chain

Part 2 ships in two of the three combined releases (see [Combined release order](#combined-release-order)). **Release A** (formerly release 1) holds the leak fix and the readers. After it, every pod keeps `origin.readsTables` when it re-saves a dataset, imports a bundle that holds source docs, and deletes them with their connection. **Release B** (formerly release 2) holds the store and the features. The owner cuts both releases. Release A must be on every pod before PR 03 reaches a release: an older pod's export would leave the docs out of a backup, and an older pod's re-save would drop `readsTables`.

| # | PR branch | Plan | Needs merged first | Release |
|---|---|---|---|---|
| 1 | `feat/semantic-p2-01-viewer-source-names` | [01](2026-11-04-semantic-layer-p2-01-viewer-source-names.md) | — | A |
| 2 | `feat/semantic-p2-02-readers` | [02](2026-11-04-semantic-layer-p2-02-readers.md) | — | A |
| | **owner cuts release A (with part 1's release-A PRs and the other parts' readers), and it rolls out everywhere** | | | |
| 3 | `feat/semantic-p2-03-store` | [03](2026-11-04-semantic-layer-p2-03-store.md) | 01, 02 released | B |
| 4 | `feat/semantic-p2-04-facts-door` | [04](2026-11-04-semantic-layer-p2-04-facts-door.md) | 03 | B |
| 5 | `feat/semantic-p2-05-sql-readers` | [05](2026-11-04-semantic-layer-p2-05-sql-readers.md) | 04 | B |
| 6 | `feat/semantic-p2-06-http-readers` | [06](2026-11-04-semantic-layer-p2-06-http-readers.md) | 04 (not 05) | B |
| 7 | `feat/semantic-p2-07-tab` | [07](2026-11-04-semantic-layer-p2-07-tab.md) | 04, **part 1 step 10** | B |
| 8 | `feat/semantic-p2-08-lineage-and-links` | [08](2026-11-04-semantic-layer-p2-08-lineage-and-links.md) | 07 | B |
| 9 | `feat/semantic-p2-09-suggestions` | [09](2026-11-04-semantic-layer-p2-09-suggestions.md) | 08, **part 1 step 01** | B |

Releases are separate from part 1's. PRs 01 to 06 need nothing from part 1. PR 07 needs part 1's Data model section (step 10, release B). PR 09 needs `TableDoc.key` and its check (step 01). PRs 01 and 02 ride in release A with part 1's release-A PRs.

The spec's build order has 8 PRs. Its PR 2 is split here: the readers ship ahead, in release A, as PR 02, and the store becomes PR 03. The fake warehouse's reader moves from the spec's PR 5 into PR 04, because PR 04's door tests need a reader that runs with no network.

## Combined release order

All eight parts ship in three releases, **A**, **B** and **C**, in the merge order set by [the cross-part check](2026-11-04-semantic-layer-cross-part-check.md#c-combined-release-order) (section (c)). Part 2: PRs 01 and 02 are in release A; PRs 03–09 are in release B, after part 1's release-B chain and part 4's 01–06. Nothing of part 2's is in C. A writer never reaches a release before the reader of its field is rolled out on every pod; the owner may cut extra releases inside a gate, never fewer. `src/ipc/visuals.ts` is projected at about 790 of its 800 lines once parts 1, 4, 5, 6 and 8 have touched it: every PR that edits it states the file's line count in its body, and a PR that would take it past 795 splits `vizDataForUnlocked` out first.

## Global Constraints

- No remote work of any kind on weekdays 08:00–18:00 local time: no `git push`, `pull`, `fetch` or `clone`, and no `gh` command, not even to read. This is the owner's global rule, enforced by a hook. Branch worktrees off the last fetched `origin/develop` and push after 18:00.
- One worktree per PR off `origin/develop` (`feature-branch-workflow` skill). Never commit to `develop`, and never `git checkout` or `git switch` in the shared clone.
- No `Co-Authored-By` or any AI trailer on any commit. No release, `v*` tag or image push without the owner.
- No new runtime dependency. No migration: these are new records, plus one optional origin field.
- File caps are 500 soft and 800 hard. These files are near the cap and take wiring lines only (at most 3 each): `src/connectors/connectionRun.ts` (500 here, 503 on develop), `src/connectors/postgres.ts` 737, `src/connectors/mssql.ts` 732, `src/connectors/http.ts` 744, `src/data/datasets.ts` 799 (touch nothing), `src/ipc/connections.ts` 503, `src/server/app.ts` 652 (module names go inside the existing array at `:570`). Each family's reader and each new job gets its own file.
- `src/api/index.ts`, `web/src/app/routes.tsx` and `web/src/app/nav.ts` are append-only. The tab is `?tab=sources` on part 1's `/model/:projectId`: no route line, no nav line.
- Every new channel is `write` and project-scoped, with a `z.strictObject` input, so none joins `scripts/rowPolicyReaders.ts`. `node scripts/check-contracts.js` must report 0 unresolved.
- Server sentences go through `t()` in `src/app/sourceTableMessages.ts` (added to `MAIN_FILES`, then `node scripts/i18n-extract.js`). Never hand-edit `en.json`.
- No warehouse call unless an editor clicks: **+ Add**, **Read from warehouse** / **Read again**, or **Link tables**. Opening anything reads records only.
- No table name in a URL under `/model` and nothing from a source doc in a viewer's reply. The Assistant and MCP never read source docs (spec non-goal).
- Required checks on every PR are `smoke (all shards)` and `oxlint (blocking)`. `npm run lint` must report zero. Golden fixtures are never re-recorded.

## Review Focus

1. **A viewer sees a source table's name.** That covers the three D13 replies, `pipelines:get`, refresh error text, any `sourceTable:*` reply, and the dataset Guide. The tests are in 01 (canary + editor control), 03 (403 on every channel) and 07/08 (Vitest + Playwright as a viewer).
2. **A page view costs a warehouse query.** `fake.catalogCalls` must stay flat across list, get, lineage, forDataset and suggestions. The tests are in 04, 07, 08 and 09.
3. **A hostile table name reaches SQL text.** Each reader binds the name or whitelists and quotes it before a socket opens. The tests are in 04, 05 and 06, one per family suite.
4. **A field meaning appears without a click.** The catalog stays byte-identical after a read until **Use**. The test is in 09, with a planted auto-apply as the negative control.
5. **Mixed fleet.** A release-A pod keeps `readsTables`, imports a release-B bundle and deletes docs with the connection. The tests are in 02.

## Calls made while planning (deliberate; a reviewer should not "fix" them)

- **The leaks are wider than D13's three replies.** `pipelines:get` draws its source nodes from the same `buildGraph` input (`src/app/pipelineView.ts` `loadGraph` → `src/ipc/lineage.ts` `loadInput`), so it shows a viewer "Table ANALYTICS.ORDERS" too. A driver's refresh error (`relation "public.orders" does not exist`) reaches viewers through `dataset:list`'s `lastRefreshError` and `pipelines:get`'s runs. PR 01 closes all of them. The trim sits in `loadInput`, so lineage and pipelines share it.
- **`connections:list` for a viewer** returns `{ id, name, connectorId, lastStatus, datasetCount }`. A viewer's web never calls it: both Connections pages are `EditorsOnly` ("Connections are for editors"). So what a viewer sees on `/connections` does not change. PR 01's test checks for missing fields and the canary, not an exact key set, so a parallel session's fix can land first.
- **`tableFacts` replaces `describeTable` for a connector that has it.** Each reader returns columns and types itself, so one read is one connection, and BigQuery makes the one GET the spec asks for. The spec's "run both and merge" would make BigQuery do two. `describeTable` is the fallback for connectors with no reader: Athena and MongoDB (new on develop, not in D7), and the HTTP family's others have neither.
- **No `readsFacts` catalog flag.** `sourceTable:list` carries `readsFacts` and `factsWake` (Databricks) per connection, so the tab needs no `connectors:catalog` call and `test-connectors`' pinned key set stays as it is.
- **Dismissed suggestions are stored in the source doc** (`dismissed[datasetId]`, short hashes). An older pod's `sanitizeColumnDoc` would drop a new catalog field on its next write. Viewers never read source docs, so this needs no reader release.
- **Two channels beyond D14's list:** `catalog:dismissSuggestion` and `dataset:sourceTableChoices`. The second is the link picker: it lists the connection's tables on a click, sorted by the query-word rule on the server, because `origin.sql` never reaches a browser. Both are `write`.
- **An undocumented used table** has no `docId`. It is picked in-page, and its panel shows Overview and **Start its notes** only. The other tabs open once the doc exists. Lineage nodes for it are `source:st:<connId>:u<n>`.
- **Lineage is built beside `buildGraph`** (`src/analysis/sourceLineage.ts` rewrites the `source:conn:*` edges into per-table nodes). `lineage:get` stays byte-identical for an editor.
- **Rate limit:** 60 reads per connection per hour per org, on bucket key `sourceRead:<connId>`. A refused read charges nothing, and a read that fails still counts.
- **Left as is:** the workbench already keeps the selected table in its own URL (`?table=`, `web/src/features/connections/WorkbenchPage.tsx:122-126`). That is an editor-only page, so the no-name rule covers `/model`. A dataset imported from a table is named after the table by default (`importAsDataset`, `src/ipc/connections.ts:224`; `src/ipc/liveDatasets.ts:131`), so a viewer can see that as the dataset's name. Part 2 renames nothing.

## Interfaces other parts consume

- `src/app/sourceTables.ts` (PR 03): `SourceTableDoc`, `listSourceIndex`, `readSourceDoc`, `createSourceDoc`, `saveSourceDoc`, `updateSourceDoc`. No part 7 plan maps dbt `sources:` in v1 (f1 reads `semantic_manifest.json`, which has none; cross-part check item 4); a later part 7 PR may map them onto `createSourceDoc`/`saveSourceDoc` if the owner asks. Part 4 may turn `owner` into a person.
- `src/connectors/tableFacts.ts` (PR 03/04): `TableFacts`, `sanitizeFacts`, `FactsQuery`/`OpenFacts`. `src/connectors/tableFactsRun.ts` (PR 04): `readTableFacts`, the only door. No current consumer: part 8's column lineage (p8-01) is built from records only (cross-part check item 11).
- `src/data/sourceTableOf.ts`: `sourceTablesOf(origin, conn)` (D9). `src/data/sourceNames.ts`: `seesSourceNames(projectId)`, the "can open the connection" rule. Part 7's Ossie export reuses it.
- `src/analysis/sourceLineage.ts`: `perTableGraph` and the node id `source:st:<connId>:<docId|u<n>>`. No current consumer: part 8 excludes lineage inside source tables; column nodes under source tables are a later follow-up (part 8 index, cross-part check item 11).

## Execution

Implement in table order. For each PR: create its worktree off `origin/develop`, run the plan's tasks with their tests, run the listed suites, then push and open the PR outside work hours. Wait for CI and the owner's merge before starting the next. PRs 05 and 06 may run in parallel worktrees after 04 merges.
