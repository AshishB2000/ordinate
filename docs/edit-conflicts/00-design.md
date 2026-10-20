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
- **What never trips it:** saving a view, starring a visual, a report's "last generated" stamp,
  renaming from a list — none of those change what the editor holds, so an open editor stays
  current. One person saving twice never conflicts with themself.
- **Automation** (MCP, scripts, anything that does not send a tag) keeps last-writer-wins.

## Decisions (from the plan, not re-litigated)

1. **Compare content, not timestamps.** The tag is sha256 (base64url, 43 characters) of the
   canonical JSON of the record's content keys — `recordDiff.contentOf`, the same per-type list the
   version history uses, extended for the types it lacked. Computed on read from the STORED,
   sanitized record; never stored, so `test-records` byte-identity holds.
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
| `contentTag(type, rec)` | `src/app/editConflict.ts` | sha256 of `canonical(contentOf(type, rec))` |
| `checkBase(type, existing, base)` | same | absent `base` → nothing; a different tag → throws `ERECORDCHANGED` (`tag` = the current one) |
| `lockedUpdate(file, type, base, load, apply)` | same | `recordFs.locked(file)`: load, `checkBase`, apply; after the commit, push `hub:record-saved` if the tag moved |
| `recordChanged(type)` | `src/app/editConflictMessages.ts` | the catalog sentence, one per type |
| the route | `src/server/app.ts` | an uncaught `ERECORDCHANGED` → `409 {error, code: 'record_changed', message, tag}` |
| `Base` | `src/api/contract.ts` | `z.string().min(1).max(64)` — the optional `base` of eight contracts |
| `useEditGuard` | `web/src/features/editConflicts/useEditGuard.ts` | the editor's base, its ONE save queue, the 409 → `changed`, the push |
| `<ConflictBanner>` | `web/src/features/editConflicts/ConflictBanner.tsx` | the banner: per-type wording, Reload, Save mine as a copy (busy and failure states) |

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
- **`CONTENT_KEYS` grew for fields the editors write that the history did not count:** dashboard
  `parameters` (a parameter's "Save as default" writes only them), visual `analytics` (overlays),
  report `discussion` and `viewId`. Without them a second editor's save would drop the first's
  change with matching tags. The history follows: a save that changed only those is now a version,
  its summary says so ("changed the parameters", "changed the analytics", "changed the dashboard
  view", "added/removed the discussion page"), and a restore writes them back. Absent keys read as
  their store's default (`[]`, `[]`, `false`), so old versions do not turn into phantom changes.
  New types: story (`name, blocks`), scorecard (`name, period, rows, description`), scenario
  (`name, baseMetricIds, drivers`). A tree is the metric's `tree` key.
- **The reply's `tag` is a top-level key.** For a wrapped reply (`{ok, analysis, …}`) next to `ok`;
  for a reply that IS the record (`visual:get`, `story:get`/`:update`, `scorecard:get`,
  `scenario:get`) on that object. `metricTree:compute` carries the metric's tag.
- **Saved-view replies are a CHECK, not a refresh.** `analysis:view` returns the record's tag; the
  editor's queue compares it with its base. A view op never changes content, so a different tag can
  only mean another writer — the banner goes up. Adopting it would wave a stale document past the
  compare.
- **Field patches send no `base`:** the dashboard and story renames from their lists, the visual
  gallery's rename and star. They write one field from a fresh list row and never write a document
  back. The scorecard page's name and period ARE its editor and send it.
- **The dashboard's Interactions checkboxes** (`KindProps.tsx`) write the visual's `overrides` from
  the dashboard editor, so they send the visual's tag (from `analysis:open`'s visual defs). A refusal
  is a toast with the server's sentence; the visual is not that editor's document, so no banner.
- **The copy is "<name> (copy)"** for every type, created from what is on screen. A metric copy
  whose name is taken is refused like any duplicate name, and the banner shows that sentence. The
  report and tree copies take two calls (duplicate the stored record, then write the editor's
  document onto the copy, without a base: nobody else can hold it yet).
- **Early warning: built.** `pushToReaders` (`src/server/jobs/schedules.ts:70`, what
  `hub:dataset-refreshed` and comments use) plus `useServerEvent` made it ~20 lines.
  `lockedUpdate` pushes `hub:record-saved` `{projectId, type, id, tag}` to the project's readers
  after the commit, only when the tag moved (a view op, a star, a stamp push nothing). The editor
  shows the banner when the pushed tag is neither its base nor a tag its own saves produced, checked
  after its queued saves land — so its own push never trips it. Ids and a hash only: nothing a
  reader of the project cannot already read. Ceiling: delivery is not ordered against an open, so a
  push for a save made just before this tab opened can raise a false banner (Reload clears it); the
  409 stays the guarantee.

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
  `DATABASE_URL`) on Postgres: open → two callers with the open tag → the first saves, the second is
  `409 record_changed` with the current tag and the record equals the first write; without `base`
  the second overwrites (control); a saved-view op / favourite / report stamp between open and
  save does not conflict; the update reply's tag equals the next get's (no self-conflict); a raw
  session holding the record's advisory key holds the guarded save back until its COMMIT, and the
  write the raw session commits meanwhile is detected (no stale write lands) — control: the same
  interleaving without the lock drops it. Plus: the push goes out when the tag moves and not when
  it does not.
- Vitest: the guard (base sent, reply tag adopted, 409 → paused, a view reply's different tag →
  changed, own push ignored, another's push → changed) and the banner (wording, both actions, no
  dismiss, busy and failure states); the dashboard editor end to end (banner, autosave paused,
  save → view op → save without a conflict).
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
