# Dashboard filters on real data, and saved views

## What you will see

- **A dropdown or multi-select control** opens a popover: a search box, then the column's values in
  the order the data first has them. A long column says so — "Showing the first 200 of 725 — search
  to narrow." — and typing searches the whole column on the server, so value 201 and beyond are one
  search away. A dropdown has an "All" row and closes on a pick; a multi-select has checkboxes. A
  value picked earlier that the list does not show (it is past the first 200, or a search hides it)
  stays at the top, picked.
- **Over a Live dataset** the popover says "Values from a sample of N rows", and text the sample
  does not list can be used as typed ("Use “Northeast”"). A Live column with no list at all keeps
  its "Not synced yet" / "Values not sampled" / "Values not listed" box, and its panel has a box to
  type a value into.
- **A date-range control** is a chip named by the server — "Last 30 days", "Year to date",
  "2024-01-01 – 2024-03-31" — that opens the same period picker the visuals use: preset pills
  (Last week / month / quarter / year are the "previous period" ones), Last N units, and a
  Between-dates tab. "All dates" clears it. Compare stays where it was, in the view controls.
- **A Views menu** in the dashboard's header: "As authored" and every saved view, the default
  marked. An editor saves the state on screen as a new view, and on the view on screen can update,
  rename, set or stop it as the default, and delete it (the confirm says subscriptions and reports
  using it fall back to the dashboard as saved). Everyone can apply a view and copy its link,
  `…/analyses/<project>/<dashboard>?view=<id>`. A viewer of a dashboard with no views sees no menu.
- **On a phone** the Filters sheet starts with a "Saved view" select (apply only).
- **⌘K** opens a dashboard hit on the dashboard itself, and a view hit on its dashboard, on the view.
- **Published (`/p/`)**: a view whose value is past the first options is still offered — its value
  is added to the control's options — and a view's date range becomes a date option.

## Decisions

- **No server change to `dataset:distinct`.** It is already bounded (`limit` ≤ 200, `search` ≤ 200
  characters, searched in SQL, the pre-cap `total` returned). The picker never raises the limit; it
  searches. Values arrive in first-seen order and are never sorted or counted in React.
- **One `ValuePicker` for dropdown and multi** (`web/src/features/analyses/editor/ValuePicker.tsx`).
  The search is debounced 250 ms (`useDebounced`) and capped at 200 characters; the last list stays
  up while the next loads (`placeholderData`). The unsearched list still loads on mount, under the
  query key `['dataset:distinct', project, dataset, column, search]` that `freshness.ts` invalidates
  — so opening a dashboard asks exactly what it asked before.
- **Live typed values.** "Use" appears only on an `approximate` reply (a sample) when the typed text
  matches no listed value exactly; an extract's search is exhaustive, so it never does. Typed text is
  not trimmed.
- **Dates**: `PeriodPanel` in a popover; the chip's label is `period:picker`'s
  `current.label` — no client table of preset names. The stored shape is unchanged: `{preset, n}` in
  `sanitizeControlDefault`'s key order, or `{from, to}` — never `{preset:'custom'}`, which is only
  how the panel spells a range while it is picked. `usePeriodPicker(spec, enabled = true)` gained
  the optional flag so a fixed range asks nothing. **Each relative date control adds one
  `period:picker` call on load** (shared by query key: two controls on "Last 30 days" ask once).
- **Views are SHARED, and saving needs project `write`.** A view lives in the dashboard record and
  reaches `/p/`, embeds, subscriptions and reports. Viewers list and apply views, open `?view=`
  links and copy them; the write items are not drawn for them (hidden, never disabled). Personal
  views (a migration plus an RLS table) are deferred.
- **A new channel, `analysis:view`** (`access: 'write'`, scoped by `projectId`), input a
  `strictObject` whose `op` is a discriminated union: `create{name, state}`, `rename{viewId, name}`,
  `update{viewId, state}`, `delete{viewId}`, `default{viewId | ''}`. The handler is
  `getAnalysis → applyViewOp → updateAnalysis({views, defaultViewId})`; the state is re-sanitized
  against the record and **no version is recorded**. `views` never joins `analysis:update`: the
  autosave sends the whole document and `test-analysesServer` pins that 400.
- **What a view holds**: every control's value (null = All), the parameters moved off their saved
  values, the page, the sheet-wide selection, per-tile narrowing, each tabs card's open tab and As
  of. Not click-filters and not Compare.
- **Which view a dashboard opens on**: `?view=`, then the default view, then the dashboard as
  authored. A navigation's sheet, then `?sheet=`, beat the view's page; a navigation's carry merges
  after the view's selection, a step already on staying once. Applying a view replaces `?view=` in
  place (router `navigate` with `replace`); a `?view=` change under the open dashboard (⌘K,
  Back / Forward) is applied by an effect on the router's `view` param — the editor is keyed by
  dashboard id, so it does not remount. Ids are compared case-folded. "As authored" keeps the sheet
  on screen; deleting the applied view clears it and `?view=`; Reset controls goes to the author's
  defaults.
- **Concurrency.** The client's `run()` writes any pending document edit first, and the autosave and
  every view op wait in ONE queue (`useAutosave`'s `queue`), so a document save never re-reads the
  record mid view op and writes the old list back. Across clients, the server holds the analysis
  record for each view op (`recordFs.locked`, every pod — `analysis.lockedAnalysis`), so two view
  edits never drop one; a lock that cannot be had answers with the lock's own sentence. The autosave
  takes no lock — whole documents stay last-writer-wins (docs/record-locks) — so another editor's
  save can still write back the list it read; a `ponytail:` comment names an `updated_at`
  compare-and-swap as the upgrade.
- **`/p/` stays a precomputed snapshot.** No search, no "of N" line (a total would leak counts under
  a lock), no `/p/?view=` deep link. Off a lock only, each view's value for a dropdown (its pick, else
  the author's default) leads that control's options, de-duplicated, so the plan's trim — which cuts
  from the end — keeps it; the default index is computed after. A view's date range becomes a date
  option the same way. With no views the options are exactly what they were.
- **Links**: `${origin}/analyses/<projectId>/<id>?view=<viewId>`. The desktop's `ordinate://`
  `viewLink` / `parseDeepLink` are deleted (only tests called them).
- **Messages** are `src/analysis/savedViewMessages.ts`, through the catalog (`MAIN_FILES`).

## Files

| File | What it does |
|---|---|
| `src/api/analyses.ts`, `src/ipc/analyses.ts` | The `analysis:view` contract and handler. |
| `src/analysis/savedViews.ts`, `savedViewMessages.ts` | The pure view rules (messages through `t()`), `openingView` case-folded; the deep-link half deleted. |
| `src/publish/dashboardData.ts` | Off a lock: views' picks lead a control's options; views' date ranges are date options. |
| `web/src/features/analyses/editor/ValuePicker.tsx` | The popover picker, `useDistinct`, `NoList` and `noListOf` (re-exported from `ControlWidget`). |
| `web/src/features/analyses/editor/DateControl.tsx` | `toSpec`, `fromSpec`, `usePeriodLabel`, the date chip. |
| `web/src/features/analyses/editor/ControlWidget.tsx` | `ParamWidget` and the kind switch; `<select>` remains only in `ParamWidget`. |
| `web/src/features/analyses/editor/Editor.tsx`, `context.ts` | The opening view, `?view=` from the router, `views` (`ViewsApi`), the autosave's `flush` and shared queue. |
| `web/src/features/dashboards/views/viewState.ts` | PURE: `gatherView`, `seedFromView`, `openingView`, the link, the picker's choices. |
| `web/src/features/dashboards/views/useSavedViews.ts`, `ViewsMenu.tsx` | The one door every view edit takes; the header's menu. |
| `web/src/features/dashboards/useViewer.ts` | `opening` (the view's selection, narrowing, As of) and `restore`. |
| `web/src/features/analyses/editor/NameDialog.tsx` | Moved out of `Head.tsx` (the views menu uses it too). |
| `web/src/features/dashboards/phone/FiltersSheet.tsx`, `PhoneHead.tsx` | The phone's "Saved view" select. |
| `web/src/features/palette/records.ts` | ⌘K: a dashboard and a view open in place. |

## Tests

- `scripts/test-savedViewsServer.ts` (new): the lifecycle over HTTP; every failure sentence word for
  word; an unknown op, a stray field and a non-UUID id are 400; a view op leaves the sheets and name
  byte for byte and records no version; an `analysis:update` after it keeps the views — NEGATIVE
  CONTROL: a multi-shaped pick on a dropdown is stripped; two view edits at once both land —
  NEGATIVE CONTROL: the same two through the store without the hold lose one; publish: a view picking value #100 of a
  300-value column makes it an option once though two views pick it, and it survives an
  8-combination trim; DIFFERENTIAL: with no views the options are `dataset:distinct`'s list.
- `test-embedLock`: three views (East, West's only channel, a control the locked bar leaves out):
  under the lock only East is offered and no other view's name is in the page, and no date option
  comes from a dropped view — NEGATIVE CONTROL: unlocked, all three, and the range.
- `test-savedViews`: the deep-link section and its imports deleted; the sentences unchanged.
- `test-analysesServer` Part 2: `analysis:view` — viewer denied, editor and admin allowed.
- Vitest: `valuePicker.test` (250 stubbed values), `controlNoList.test` (the popover; a typed value),
  `dateControl.test`, `views/viewState.test` (DIFFERENTIAL against the compiled `savedViews.js`),
  `views/views.test` (the whole editor), `palette/records.test`.
- e2e `saved-views.e2e.ts` (new): the sample's `order_date` says "first 200 of 725"; 2024-12-30 —
  absent from the server's first 200 — is found by search and the KPI becomes the server's figure
  for it; the date pills and their server label; save, Copy link, the link reopens on the same
  figure; rename; the phone sheet's select; set default; the Subscribe dialog lists it; `/p/` offers
  it, on; delete. Every phase is its own load within the 25-RPC budget. Screens:
  `dashboard-value-picker`, `dashboard-date-presets`, `dashboard-views-menu`, `published-view`,
  `phone-views`. `analyses.e2e` and `liveTiles.e2e` moved to the popover.

## Deferred

- Personal views (a migration and an RLS table).
- A `/p/?view=` deep link, and search in a published page's filter bar.
- A view-scoped "Reset to this view" (Reset goes to the author's defaults).
