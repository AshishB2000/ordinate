# Autopilot: a weekly cleanup per project

Feature 6 of the 10 Lightdash-parity AI features. Agreed with the owner on 2026-11-21. The plan page with the
questions and answers is https://claude.ai/artifact/SdMH4GtVCYxEv9Dc9a2DXc.

## What it is and why

A weekly job per project, switched on by an admin. It moves charts nobody has opened for a long time to Trash,
repairs charts that a column rename broke, and lists charts that are slow to compute. Everything it does can be undone,
and admins get one short weekly report. **No model is involved**: finding unused, broken and slow charts and the exact
repair are plain app logic (AGENTS.md: engines do the math).

Lightdash's version: a scheduled job that soft-deletes charts nobody viewed in 30 days, fixes or flags charts broken by a
renamed field, flags slow queries, and drafts suggested charts into a folder.

## Decided by the owner

1. **Q1: act on the safe things, suggest the rest.** Trash moves and exact rename repairs are done on its own, each with
   Undo. Other broken charts and slow charts are listed for an admin.
2. **Q2: Autopilot's Trash items stay 90 days.** What people delete themselves keeps the normal 30.
3. **Q3: unused means 90 days unopened by default;** an admin may set 30 to 365. The first cleanup can only happen a full
   window after phase 1 ships.
4. **Q4: no drafted charts in the first version.**
5. Phase 1 ships first, on its own, so the window starts early.

## Calls made in the plan (settled unless the owner objects)

- **Acts as an admin:** the admin who switched it on, with their access checked at every run. If they lose it, it pauses and tells the
  other admins. (Folder writes need a person with Edit; a job has none.)
- **Never touches:** charts on a dashboard or in a Story, certified charts, anything newer than the window.
- **Per item, not per person:** opens are counted per chart per day. Nothing records who opened what.
- **Off by default,** per project.

## The four phases

| # | PR | What |
|---|---|---|
| 1 | this one, `feat/autopilot-usage` | Record opens, compute times and renames. Migration 0044. **Built now.** |
| 2 | second PR | Settings (Admin → project → Autopilot: on or off, window, slow threshold, allowed actions) and the weekly job kind on the jobs table, run once by any server (lease). Migration 0046. |
| 3 | second PR | Clean up, repair and flag: unused to Trash with the reason "Autopilot: not opened in 90 days" and 90-day retention; broken charts found by joining lineage (`visualColumns`) with the datasets' current columns; exact repair from the rename log (old version kept in history); everything else flagged; slow charts flagged with their typical time. |
| 4 | second PR | The weekly report page (every row Undo or Open), the admin notification, the email digest. |

Phases 2 to 4 are designed only in outline here; each gets its detail in the second round's commit to this file.

## Phase 1 in detail

### What is recorded

**`item_usage_daily`**: one row per `(org, project, kind, item, UTC day)`, kind `visual` or `dashboard`.
`opened` (boolean), `computes`, `total_ms`, `max_ms`. "Typical" is `total_ms / computes` (the mean) and "slowest" is `max_ms`.
Count, sum and max are chosen because they merge exactly across pods and across flushes; a median does not.
The time is the server's wall time to answer the request, so a cached answer counts as the fast answer the user got.
There is **no user column**.

**`column_renames`**: `org, seq (identity), project, dataset, edit_id, kind ('source'|'step'), old_name, new_name, at`.
`seq` orders the org's rows, `edit_id` groups one edit, so a swap (a to b and b to a in one edit) and a chain (a to b, later b to c) replay exactly.

### What is an open

The rule: when unsure, count it. A spurious open only delays a cleanup; a missed one could trash a chart somebody uses.

| Where | Counted? | Hook |
|---|---|---|
| `visual:get` (the chart page, the editor's re-read) with a non-null reply | open | `src/ipc/visuals.ts`, `usage.opened` |
| `visual:data` / `visual:dataBatch` / `analysis:tiles` naming a saved visual (`visualId`; the web sends it for every saved chart, and a Story or report page sends it through `pageDeps.vizData`): a dashboard tile, a Story, a scheduled report, a Slack answer | open + a timed compute | `usage.timedViz` around `vizData` |
| the same, when the server's own build path says `publish` or `bundle` | timed compute, **not** an open | same |
| `analysis:open` answering `ok` (an editor's draft, a viewer's published copy, Duplicate) | dashboard open | `src/ipc/analysesServer.ts`, `usage.openWhenOk` |
| `/p/<id>/<page>` for a dashboard page | dashboard open | `src/server/published.ts`, `noteSiteOpen` |
| an embed served (cache hit or not) | dashboard open + timed | `src/server/embed/route.ts` |
| `visual:list`, `visual:thumbs`, `analysis:gallery`, a refused or missing open, the draft branch of `analysis:open` (which returns every chart's definition) | **not** counted | no hook |

No browser request is added: everything is recorded by the server where it already answers. A published page is a snapshot
built at publish time, so what counts is the request for its page.

### How it is written

`src/server/autopilot/usage.ts`. A hook is a synchronous update of an in-memory Map on the pod (`note`): no await, no
query, never a throw, and a no-op when there is no `orgDb()` (desktop and dev file mode, as `readersOf` for 0035). A timer
(10 s, unref'd) on every pod writes the batch as one `INSERT ... ON CONFLICT DO UPDATE` per org, in an `inOrg` transaction
(forced RLS). `opened` merges with OR, `computes` and `total_ms` add, `max_ms` takes the greatest. A failed write puts the
batch back for the next tick. The shutdown flushes the last batch before the Postgres pool ends (`shutdown.ts`, step `usage`;
`preClose` for a test app). The Map holds a write-behind batch only, never something a later request needs: any pod serves any request.
A pod that dies loses at most 10 s of counts.

**A made-up id never becomes a row.** `visualId` is client input. The write joins `records` (`projects/<p>/visuals|analyses/<id>.json`),
so an id that is not a record of the org is dropped there; the Map is capped at 5,000 rows, and an id that is not a UUID is
refused at once.

### Renames

`resolveColumnEdit` (`src/data/columnEdit.ts`) now also returns every rename it made, as `{from, to, kind}`:
`source` when the source column itself was edited, `step` when a `rename_column` step was appended (a step reads the column, or the
column is made by a step). `updateDataset` hands them to `logRenames` **after `persist` succeeded**: a logged rename that never landed would make a
wrong "exact" repair, while a lost entry degrades to "flagged". The write is tracked work, never throws, and does not make the edit wait.
`updateDataset` moved to `src/data/datasetEdit.ts` (re-exported by `datasets.ts`, which was at the 800-line cap), so the hook sits on its own lines. Each row carries the dataset's own `updatedAt` (`dataset_at`); the rows are written on separate connections, so a repair orders by `(dataset_at, seq)`, never by arrival.

### Contracts and screens

None. Phase 1 adds no RPC channel and no screen, so there are no contracts to classify (`rowPolicyReaders`, `folderReaders`) and no new i18n keys.

### Storage

`0044_autopilot_usage.sql`: the two tables, forced RLS through `current_setting('ordinate.org')`. Additive.
Phase 2's job prunes usage rows older than 400 days and rows of deleted items per org; until then growth is one row per item per active day.

### Tests

- `scripts/test-autopilotUsage.ts` (DB): the no-database no-op; opens and timed computes through the real server's channels; one row per day and a new row the next UTC day; forced RLS as an ordinary role with a password (no scope, another org, a write for another org); both rename kinds, a swap, and an edit that renames nothing; negative controls: lists, thumbs and gallery, a draft open, a refused and a missing open, a compute naming no chart, a made-up id, a flood of ids, a publish build; a hung database never makes an open or a tile wait; a failed write is retried.
- `scripts/test-columnEdit.ts` additions: `resolveColumnEdit` returns the renames of both kinds.
- `web/e2e/autopilot.e2e.ts` (Postgres): opening a dashboard makes no request beyond what it did before, and its open lands as a row.
- Gates as in the brief: build, lint, contracts, `npm test` with and without a database, web tests, build and size.

## Open points

1. **No MCP tool reads a saved chart or dashboard by id.** The server's tools (`registry.ts`) list, query and create; `export_dashboard` and `run_report` are desktop-only, and `create_visual` computes the chart it just made, which is not an open. So there is no MCP hook to add. An API token or MCP client that calls the RPC channels (`visual:get`, `visual:data`, `analysis:open`) is counted by the hooks above. If a read-by-id tool is added later, it must call the same channels or `noteOpen`.
2. **Prepare-step renames are logged too** (review). `updateSteps` (the Prepare screen, an AI plan apply, a version restore) diffs the old and new `rename_column` steps after `persist`: an added step is logged as kind `step`, a removed one (an edit, a plan, a restore that goes back) is logged **reversed** (to to from), so a later repair never replays a rename that was undone. The diff is `src/data/stepRenames.ts`.
3. **A dashboard's compute time** is known only where the server builds the whole page (an embed). In the app a dashboard is computed tile by tile, so its slowness is attributed to its charts (which is what Autopilot flags).
4. **Charts drawn only in the builder** (`visual:preview`, which names no saved visual) have no compute figure; their open is the `visual:get`.
5. **A site published before this change** has no page id, so a page of it counts every dashboard of the link (an over-count, the safe side) until it is re-published.
6. **Phase 3 must check before an exact repair** that the rename's `new_name` still exists in the dataset's current columns, and that no later row of the log renames it again: a re-import, a Replace or a Live schema sync can bring an old name back or drop the new one. A rename whose target is gone is flagged, not repaired.
7. **Coverage:** phase 3 must treat the window as covered only from the day after the org's first recorded row (`min(day)`), because a rolling deploy has pods that do not record yet.
