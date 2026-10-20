# Two editors never overwrite each other

Built on `fix/edit-conflicts`. Every whole-document editor sends the **content tag** its document
was built on; the server compares it with the stored record inside the record's lock and refuses a
save made from a stale copy. Nothing is merged and nothing is overwritten.

## What you will see

- **Two people (or two tabs) on one dashboard.** A edits; B, who opened it before A's save, edits
  too. B's autosave is refused, and a banner fills the top of B's editor: "This dashboard was
  changed in another tab or by someone else." with "Your changes since then are not saved." It has
  no close button. Autosave stops — nothing B does is sent until B picks one of:
  - **Reload** — B's unsaved change is dropped and the dashboard opens again as it is now, with A's
    change.
  - **Save mine as a copy** — B's document is created as a new dashboard, "<name> (copy)", through
    the ordinary create door, and it opens.
- **Usually sooner.** When A's save lands, B's open editor is told at once (a server push), so the
  banner appears before B types more, not on B's next save.
- **The same for every editor**, worded for what is open: a visual, a metric, a metric tree, a
  report, a story, a scorecard, a scenario. A page editor shows the banner at the top of the page; a
  dialog editor (a metric, a calculated measure, a tree, a scorecard's rows) shows it inside the
  dialog, above its Save.
- **What never trips it:** saving a view, starring a visual, a report's "last generated" stamp or
  its Pipelines schedule, the tree editor saving a metric's tree while its metric dialog is open (and
  the other way round) — none of those change what that editor's save writes. One person saving
  twice never conflicts with themself, and reopening an editor always starts from what is stored now.
- **While B's banner is up**, Publish… does not go ahead (it says why and points at the banner),
  and closing the tab or leaving the page with edits the server does not have asks first.
- **Automation** (MCP, scripts, anything that does not send a tag) keeps last-writer-wins.

## Decisions (from the plan, not re-litigated)

1. **Compare content, not timestamps.** The tag is sha256 (base64url, 43 characters) of the
   canonical JSON of the keys that channel's save writes (`recordDiff.SAVE_KEYS`, below), read from
   the record AS STORED. Computed on read, never stored, so `test-records` byte-identity holds.
2. **Each whole-document update contract gains an optional `base`.** The compare happens inside
   `recordFs.locked` on the record's own path, so it is atomic across pods. A mismatch refuses with
   **409 `record_changed`**, a catalog sentence and the current tag; the record is untouched.
3. **No `base` = last-writer-wins** (MCP and automation; documented ceiling). The web always sends it
   from its editors.
4. **Every open/get reply and every successful update reply carries the current `tag`.** The
   editor's save queue adopts the tag from its own update replies, so a tab never conflicts with
   itself.
5. **On a 409 autosave stops and a banner that cannot be dismissed offers Reload and Save mine as a
   copy.** Never auto-overwrite.
6. **One server helper, one web hook, one banner.** No per-editor copies.
7. No migration, no new record field, no dependency.

## The pieces

| Piece | Where | Job |
|---|---|---|
| `SAVE_KEYS`, `savedPart(kind, rec)` | `src/analysis/recordDiff.ts`, beside `CONTENT_KEYS` | what each channel's save writes |
| `contentTag(kind, rec)` | `src/app/editConflict.ts` | sha256 of `canonical(savedPart(kind, rec))` |
| `readTagged(kind, file, normalize)` | same | ONE read: the store's normalized record AND the tag of the bytes as stored. Each store exports its `readX` (`readAnalysis`, `readVisual`, `readMetric(…, kind)`, `readReport`, `readStory`, `readScorecard`, `readScenario`); the open replies and the compare use it |
| `lockedUpdate(kind, {projectId, id, file}, base, read, apply)` | same | `recordFs.locked(file)`: `read`, refuse a different `base` with `ERECORDCHANGED` (`tag` = the stored one), apply; after the commit, push `hub:record-saved` to the project's WRITERS if the tag moved. Each store's update function is this, on its own record path |
| `recordReply(t)` | same | a reply that IS the record (`visual:get`, `story:get`, …) with its `tag` on it |
| `recordChanged(type)` | `src/app/editConflictMessages.ts` | the catalog sentence, one per type |
| the route | `src/server/app.ts` | an uncaught `ERECORDCHANGED` → `409 {error, code: 'record_changed', message, tag}` |
| `Base` | `src/api/contract.ts` | `z.string().min(1).max(64)` — the optional `base` of eight contracts |
| `useEditGuard` | `web/src/features/editConflicts/useEditGuard.ts` | the editor's base, its ONE save queue, the 409 → `changed`, view replies checked, the push |
| `useReload` | same | a page's Reload: refetch the record, then bump the editor's `key` so a NEW editor mounts on it |
| `useDropOnLeave` | same | an editor page's open query is removed when the page is left: every open reads afresh |
| `<LeaveGuard>` | `ConflictBanner.tsx` | while a conflicted editor holds unsaved edits, an in-app navigation away asks first |
| `<ConflictBanner>` | `web/src/features/editConflicts/ConflictBanner.tsx` | the banner: per-type wording, Reload, Save mine as a copy (busy and failure states); `compact` inside a dialog; scrolls itself into view |

## Inventory (b5377dd2)

Every whole-document update channel, its store and lock path, its web editor and save path, its
open/get reply, and the door "Save mine as a copy" goes through.

| Channel | Contract | Handler → store update | Lock path (`projects/<p>/…`) | Web editor: save | Autosave / queue | Open/get reply (tag) | Copy door |
|---|---|---|---|---|---|---|---|
| `analysis:update` | `src/api/analyses.ts:91` | `src/ipc/analyses.ts:102` → `src/analysis/analysis.ts:286` | `analyses/<id>.json` | `web/src/features/analyses/editor/Editor.tsx:67` | 600 ms debounce, ONE queue shared with `analysis:view` (`Editor.tsx:49-112`, `dashboards/views/useSavedViews.ts:22`) | `analysis:open` `src/ipc/analysesServer.ts:75` (web `analyses/api.ts:161`) | `analysis:create` `src/ipc/analyses.ts:75` → `/analyses/<p>/<id>` |
| `visual:update` | `src/api/visuals.ts:142` | `src/ipc/visuals.ts:564` → `src/analysis/visuals.ts:611` | `visuals/<id>.json` | builder `web/src/features/visuals/builderState.ts:150-184` (overrides autosave + Save); dashboard Interactions `analyses/editor/KindProps.tsx:184` | 300 ms overrides debounce + explicit Save | `visual:get` `src/ipc/visuals.ts:552` (web `visuals/api.ts:133`); `analysis:open`'s visual defs | `visual:save` `src/ipc/visuals.ts:554` → `/visuals/<p>/<id>` |
| `metric:update` | `src/api/metrics.ts:46` | `src/ipc/metrics.ts:488` → `src/analysis/metrics.ts:375` | `metrics/<id>.json` | `analyses/metrics/parts.tsx:71` from `MetricEditor.tsx:114` and `calc/MeasureForm.tsx:95` | explicit Save (dialogs) | `metric:get` `src/ipc/metrics.ts:465` | `metric:save` `src/ipc/metrics.ts:471` (dialog: the host's `onSaved`) |
| `metricTree:save` | `src/api/metricTree.ts:63` | `src/ipc/metricTree.ts:386` → `metrics.updateMetric` | `metrics/<id>.json` (the tree is in the metric) | `metrics/tree/api.ts:101` from `TreeEditor.tsx:257` and `MetricTreePage.tsx:45` | explicit Save | `metricTree:compute` `src/ipc/metricTree.ts:404` | `metric:duplicate` then `metricTree:save` on the copy → `/data/metrics/<p>/<id>/tree` |
| `reports:update` | `src/api/reports.ts:55` | `src/ipc/reports.ts:68` → `src/analysis/reportSpec.ts:455` | `reports/<id>.json` | `reports/builder/ReportBuilder.tsx:85` | explicit Save (+ before Generate) | `reports:open` `src/ipc/reportsServer.ts:198` | `reports:duplicate` then `reports:update` on the copy → `/reports/<p>/<id>` |
| `story:update` | `src/api/reports.ts:77` | `src/ipc/stories.ts:85` → `src/analysis/stories.ts:148` | `stories/<id>.json` | `reports/stories/StoryPage.tsx:79` | 600 ms debounce, NO queue (overlapping saves) | `story:get` `src/ipc/stories.ts:74` | `story:create` `src/ipc/stories.ts:76` → `/stories/<p>/<id>` |
| `scorecard:update` | `src/api/reports.ts:97` | `src/ipc/scorecards.ts:443` → `src/analysis/scorecards.ts:134` | `scorecards/<id>.json` | `reports/scorecards/ScorecardPage.tsx:200` (name, period), `RowsEditor.tsx:69` (rows dialog) | per field / explicit; reply ignored, refetch | `scorecard:get` `src/ipc/scorecards.ts:438` | `scorecard:create` `src/ipc/scorecards.ts:439` → `/scorecards/<p>/<id>` |
| `scenario:update` | `src/api/analytics.ts:131` | `src/ipc/scenarios.ts:49` → `src/analysis/scenarios.ts:128` | `scenarios/<id>.json` | `analytics/scenarios/ScenarioPage.tsx:77` | 600 ms debounce, NO queue | `scenario:get` `src/ipc/scenarios.ts:44` | `scenario:create` `src/ipc/scenarios.ts:45` → `/analytics/scenarios/<p>/<id>` |
| notebook save | — | `src/analysis/notebook/store.ts:119` (`updateNotebook`) | — | **none** | — | — | — |

**The notebook has no save door.** `notebook:update` was deleted with the desktop app (T8.1,
8b50c184); `updateNotebook` is called only by `scripts/test-notebooks.ts` and
`scripts/recordsScenario.ts`, and the web has no notebook editor. No contract, no channel — it moves
to Out until a web editor exists.

### Other writers of these records

The compare only protects a save if every other writer of the record waits for the same lock, so
`lockedUpdate` sits INSIDE each store's update function, not in the handler: every caller of
`updateAnalysis`, `updateVisual`, `updateMetric`, `updateReport`, `updateStory`,
`updateScorecard` and `updateScenario` now holds the record while it reads and writes.

| Writer | What it writes | Content? |
|---|---|---|
| `analysis:rename` `src/ipc/analyses.ts:89`, gallery rename `visuals/VisualsPage.tsx:161`, story rename `stories/StoryList.tsx:44` | the name only | yes — open editors go stale; no `base` (a field patch from a list, never a stale document written back) |
| `analysis:view` `src/ipc/analyses.ts:123` | views, default view | no |
| gallery star `visuals/VisualsPage.tsx:79` | `favorite` | no |
| `reports:generated` `src/ipc/reportsServer.ts:222` | `lastRunAt` | no |
| pipelines report schedule `src/ipc/pipelines.ts:136` | `schedule` | yes (the version history counts it) |
| `versions:restore` `src/ipc/versions.ts:69` | the version's content | yes |
| catalog description `src/app/catalogIndex.ts:302` | a metric's description | yes |
| AI style step `src/ai/planExec.ts:242`, sample seed `src/app/sampleProject.ts:237` | style; sheets | yes |
| tree card `src/ipc/metricTreeCard.ts:32`, stats card `src/ipc/stats.ts:235` | sheets **built from their own earlier read** | yes — the read moves inside `lockedAnalysis`, or it can drop an editor's save |

## Calls made where the plan left room

- **The lock is in the store, not the handler.** Same `lockedAnalysis` pattern one level down, so
  the eleven other writers above serialize with the editors too. Two of them (`metricTreeCard`,
  `stats`) patched from a read taken before the update; they now read inside the hold. Update
  functions can now refuse with `ERECORDBUSY` after the 15 s wait, which every caller already
  handles (a catch, or the route's 409 `record_busy`).
- **The tag covers what the channel's save writes, no more** (`SAVE_KEYS`, review fix 5). A save
  is replace-or-keep, so a key it never sends cannot be overwritten by it, and a change to that key
  by someone else must not make the editor stale:

  | Channel | `SAVE_KEYS` | Left out, and who writes it |
  |---|---|---|
  | `analysis:update` (dashboard) | name, sheets, filters, style, parameters | views (`analysis:view`) |
  | `visual:update` (visual) | name, chartType, encoding, overrides, filters, analytics | favorite (the star) |
  | `metric:update` (metric) | name, definition, filters, format, description, direction | tree (`metricTree:save`) |
  | `metricTree:save` (metricTree) | tree | the metric's fields (`metric:update`) |
  | `reports:update` (report) | name, format, pages, cover, paper, includeFilters, narrative, discussion, viewId | schedule (Pipelines), analysisId, lastRunAt |
  | `story:update` | name, blocks | — |
  | `scorecard:update` | name, period, rows, description | — |
  | `scenario:update` | name, baseMetricIds, drivers | — |

  A metric therefore has two tags, its fields' and its tree's; the push says which (`type`
  `metric` or `metricTree`).
- **The tag is of the stored bytes** (review fix 2). Several read sanitizers repair a record with a
  fresh random id (an invalid parameter id, a duplicate block or card id), so a record stored
  un-normalized — a bundle import, `import-desktop` — normalized differently on every read, and its
  tag with it: every autosave was refused. Hashing the parsed stored JSON (the smaller change than
  making those ids deterministic, which would touch eight sanitizers shared with the write paths)
  keeps one tag per stored state. The open reply and the compare each take record and tag from ONE
  read, and a save's reply tag is the record exactly as it was written. `metricTree:compute` takes
  its tag from the same read its tree came from (review fix 1): from a second read, a save landing
  in between paired an old tree with a newer tag, and the editor's next save overwrote it.
- **`CONTENT_KEYS` (the version history) grew** for fields the editors write that the history did
  not count: dashboard `parameters`, visual `analytics`, report `discussion` and `viewId`. A save
  that changed only those is now a version, its summary says so ("changed the parameters",
  "changed the analytics", "changed the dashboard view", "added/removed the discussion page"), and
  a restore writes them back. Absent keys read as their store's default (`[]`, `[]`, `false`, `''`),
  so old versions do not turn into phantom changes.
- **The reply's `tag` is a top-level key.** For a wrapped reply (`{ok, analysis, …}`) next to `ok`;
  for a reply that IS the record (`visual:get`, `story:get`/`:update`, `scorecard:get`,
  `scenario:get`) on that object. `metricTree:compute` carries the tree's tag. `analysis:open`'s
  visual defs carry theirs (the Interactions checkboxes send it); the gallery's previews do not
  (review fix 9).
- **Saved-view replies are a CHECK, not a refresh.** `analysis:view` returns the record's tag; the
  editor's queue compares it with its base. A view op never changes content, so a different tag can
  only mean another writer — the banner goes up. Adopting it would wave a stale document past the
  compare.
- **Field patches send no `base`:** the dashboard and story renames from their lists, the visual
  gallery's rename and star. They write one field from a fresh list row and never write a document
  back. The scorecard page's name and period ARE its editor and send it.
- **The dashboard's Interactions checkboxes** (`KindProps.tsx`) write the visual's `overrides` from
  the dashboard editor, so they send the visual's tag (from `analysis:open`'s visual defs). The
  visual is not that editor's document, so no banner: a refusal reads the visual again (its
  settings and its tag), says so in a toast, and the next click works from there (review fix 7).
- **The copy is "<name> (copy)"** for every type, created from what is on screen. A metric copy
  whose name is taken is refused like any duplicate name, and the banner shows that sentence. The
  report and tree copies take two calls (duplicate the stored record, then write the editor's
  document onto the copy, without a base: nobody else can hold it yet).
- **Early warning: built.** `pushToReaders`'s delivery (`src/server/jobs/schedules.ts`, what
  `hub:dataset-refreshed` and comments use) plus `useServerEvent` made it ~20 lines.
  `lockedUpdate` pushes `hub:record-saved` `{projectId, type, id, tag}` after the commit, only when
  the tag moved (a view op, a star, a stamp push nothing), and only to the project's WRITERS
  (`pushToWriters` → `authz.writerEmails`: org admins, and grants of editor or admin, a user's own or
  a team's — review fix 6); a viewer cannot have an editor open. Its cost: one writers query and one
  push per writer (fanned out across pods over Postgres `NOTIFY`) for each save that changed what an
  editor holds — at most one every 600 ms per open autosaving editor. The editor
  shows the banner when the pushed tag is neither its base nor a tag its own saves produced, checked
  after its queued saves land — so its own push never trips it. Ids and a hash only: nothing a
  reader of the project cannot already read. Ceiling: delivery is not ordered against an open, so a
  push for a save made just before this tab opened can raise a false banner (Reload clears it); the
  409 stays the guarantee.

### Built, editor by editor

| Editor | Base from | Saves through the guard | Banner | Reload | Save mine as a copy |
|---|---|---|---|---|---|
| Dashboard (`analyses/editor/Editor.tsx`) | `analysis:open` `tag` | the autosave and the saved-view ops, one queue | under the head; the save chip says "Not saved" | `AuthoringPage` `useReload` | `analysis:create` (the contract now takes `style`) → the copy's editor |
| Interactions checkboxes (`KindProps.tsx`) | the visual def's `tag` (`analysis:open`) | `visual:update` with `base` | a toast with the server's sentence (not this editor's record) | — | — |
| Visual builder (`visuals/builderState.ts`) | `visual:get` `tag` | the styling autosave and Save | above the head; Save off | `BuilderPage` `useReload` | `visual:save` → `/visuals/<p>/<id>` |
| Metric dialog (`metrics/MetricEditor.tsx`) | `metric:get` `tag` (each of its 3 hosts) | `saveMetric(…, guard)` | inside the dialog; Save off | the dialog re-reads and remounts its body | `metric:save` "(copy)" → the host's `onSaved` |
| Measure dialog (`calc/MeasureForm.tsx`) | `metric:get` `tag` — "edit measure" now reads the record first (one more RPC on that click) | `saveMetric(…, guard)` | inside the dialog | `EncodingForm` reopens it (`gen` key) | `metric:save` "(copy)" |
| Tree editor (`metrics/tree/TreeEditor.tsx`) | `metricTree:compute` `tag` at the editor's open | `saveTree(…, base)` | inside the dialog | the page refetches, new editor key | `metric:duplicate` + `metricTree:save` → the copy's tree page |
| Tree one-click start (`MetricTreePage.tsx`) | the same `tag` | `saveTree(…, base)` | a toast, and the tree is read again — nothing typed is lost | — | — |
| Report builder (`reports/builder/ReportBuilder.tsx`) | `reports:open` `tag` | Save, and Generate's save | under the head; Save off | `useReload` | `reports:duplicate` + `reports:update` → `/reports/<p>/<id>` |
| Story (`reports/stories/StoryPage.tsx`) | `story:get` `tag` | the autosave — now one at a time | under the head; status "Not saved" | `useReload` | `story:create` → `/stories/<p>/<id>` |
| Scorecard (`reports/scorecards/ScorecardPage.tsx`, `RowsEditor.tsx`) | `scorecard:get` `tag` | name, period and the rows dialog, one guard | under the head, and inside the rows dialog | `useReload` | `scorecard:create` (with the dialog's rows when it was refused) |
| Scenario (`analytics/scenarios/ScenarioPage.tsx`) | `scenario:get` `tag` | the autosave — now one at a time | under the head | `useReload` | `scenario:create` → its page |

**Every open reads afresh** (review fix 4). `reports:open` and `scenario:get` were `staleTime:
Infinity` and kept after the page was left, and `scorecard:get` showed its cached copy before
refetching: a reopen started from an old read — content and tag that someone else's save has since
replaced, so a false banner, or an editor on stale content. Like the dashboard (`removeQueries` on
leave) these pages and the story now drop their open query when left (`useDropOnLeave`; `gcTime: 0`
alone loses a quick back-and-forth) and never refetch under an open editor.

**While conflicted, nothing leaves quietly** (review fix 3). The dashboard's Publish… wrote "what is
on screen" (a no-op once paused) and opened the viewer on the OTHER writer's version; it now stops
and says why. `beforeunload` warns, and `<LeaveGuard>` asks before an in-app navigation, while the
editor holds edits no save landed. **The scorecard's copy** is built from the page's own draft —
the period picked here and the rows as last saved here or in the refused rows dialog — not from the
server's record (review fix 8).

**Reload is a new editor, not a reset query.** Resetting the open query was enough in theory (the
page shows its skeleton, then a new editor), but a fast reply lands before React renders the
skeleton, and the old editor — its document and its paused guard — stays. `useReload` refetches and
then bumps the editor's `key`.

## Measured

A 60-card dashboard, 200 sequential `updateAnalysis` per run, median of 5 runs, b5377dd2 (built from
`git archive`) and this branch back to back, local Postgres 17 (scratchpad bench, not committed):

| | b5377dd2 | this branch, no `base` | this branch, with `base` |
|---|---|---|---|
| Files | 0.57 ms | 0.77 ms | 0.82 ms |
| Postgres | 0.96 ms | 1.13 ms | 1.17 ms |
| One `contentTag` of that dashboard | — | 87 µs | 87 µs |

A save pays ~0.2 ms: the record lock (a transaction and an advisory key on Postgres, the in-process
queue on files) and two hashes (before and after; the reply's tag is a third). Against the 600 ms
autosave debounce it is noise.

## Steps

1. This doc.
2. Server: `recordDiff` keys (+ history clauses and restore), `editConflict.ts` + messages, the
   eight contracts, the stores' `lockedUpdate`, the handlers' `base`/`tag`, the route's 409, the
   two read-then-patch writers, the push.
3. `scripts/test-editConflicts.ts`: every channel, files and Postgres.
4. Web: `useEditGuard`, `<ConflictBanner>`, then each editor.
5. Vitest, `web/e2e/edit-conflicts.e2e.ts`, screenshots.
6. Docs: record-locks Out list, CHANGELOG, docs/README.md.

## Tests

- `scripts/test-editConflicts.ts`, for each of the eight channels, on files and (with
  `DATABASE_URL`) on Postgres: (a) open → two callers with the open tag → the first saves, the second
  is `409 record_changed` with the current tag and the record equals the first write; (b) the update
  reply's tag is the next open's (no self-conflict); (c) a write the channel does not make — a view,
  a star, a report's stamp and Pipelines schedule, the metric's tree for the dialog and its fields
  for the tree editor — does not conflict; (d) without `base` the stale save lands; (e) a raw session
  holding the record's advisory key holds the guarded save back until its COMMIT, and the write it
  commits meanwhile is refused over — NEGATIVE CONTROL: b5377dd2's unguarded update does not wait for
  the held lock and is then lost to the holder's save; (f) the push goes to writers, never to
  readers. Then (g) a tree save landing between compute's read and its reply leaves the reply's tag
  stale, so a save from it is refused — CONTROL: a second read's tag lets it overwrite; (h) a record
  stored un-normalized (parameter id "p1", duplicate story block ids) keeps one tag across reads and
  saves from it — CONTROL: the reads' repaired ids differ; (i, DB) writers are the editor and the org
  admin, not the viewer.
- Vitest (`editConflicts.test.tsx`, `editors.test.tsx`): the guard (base sent, reply tag adopted,
  409 → paused, a view reply's different tag → changed, own push ignored, another's push → changed)
  and the banner (wording, both actions, no dismiss, busy and failure states); the dashboard editor
  end to end (banner, autosave paused, save → view op → save without a conflict; while conflicted
  Publish… stays and says why, a tab close and an in-app navigation with unsaved edits ask —
  CONTROL: without a conflict Publish… leaves and nothing asks); a report, a scenario and a
  scorecard reopened after someone else's save show it and save from its tag (a NEGATIVE CONTROL run
  without the fix fails); the Interactions checkbox re-reads the visual on a 409 and the next click
  sends the new tag (CONTROL: another failure re-reads nothing); a scorecard's copy carries the
  refused period pick.
- `web/e2e/edit-conflicts.e2e.ts`: two pages on one dashboard; edit in A, then in B → B's banner;
  Reload shows A's change; Save mine as a copy opens a copy holding B's change; light and dark
  screenshots.

## Out, and where each goes next

- **Dialog saves of one small object:** `alerts:save`, `quality:save`, `relationship:save`,
  `events:save`, `input:save`, `subscription:save` (item 4 owns subscriptions) — short-lived forms
  that re-read on open.
- **The notebook** — no save channel since T8.1 (above). Next: when a web notebook editor lands, its
  update takes `base` through `lockedUpdate` like the others.
- **Merging.** A conflict is refused, never merged; field-level merge of two editors' changes is a
  later decision.
- **Automation without a tag** keeps last-writer-wins. Next: `base` on the MCP tools' arguments.
