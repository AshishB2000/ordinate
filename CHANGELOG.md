# Changelog

All notable changes to Ordinate are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning per
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** the project was renamed from **Screenchart** to **Ordinate**. Releases up to and
> including 0.1.0 shipped under the Screenchart name; entries below use the current name.

## [Unreleased]

### Added
- **The app is no longer empty on first launch.** A bundled sample project — 5,000 rows of generated
  retail orders across two years, five regions and twenty-five US states — arrives with a dashboard
  already built: revenue, profit, units and order-count KPIs, revenue by month, revenue by category,
  and a profit-by-state map. It is pinned to Home, so Starred and Recent have something in them, and
  the ask bar suggests questions written for it. The data is generated, not real; there is a planted
  bad month for anomaly detection to find. A **Delete sample project** button on its notes card
  removes it completely, and it is never re-created afterwards. Your own work goes into a separate
  empty project that is selected by default, so the sample never collects it.

- **Dashboard starter layouts that actually build something.** "KPIs + chart" and "Two-up" used to
  drop in a note reading *"Add metric cards here"* and then ask which already-saved visual belonged
  in the slot — on a new project that meant one text card. They now build real tiles from the
  dataset you pick: a KPI row totalling its numeric columns (revenue/sales/amount and friends
  first), a chart over the first column narrow enough to read as an axis, and, when there is a date
  column, the same measure by month. Both the empty-state buttons and the create-a-dashboard wizard
  use them, and the tiles are made by the same code path the Assistant's dashboards go through.

### Changed
- **New tiles fill the row.** Adding a visual, metric, control or note now drops it in the first
  free space on the grid instead of always starting a new row in column 0 — four KPIs sit in one
  row, and notes run the full width.
- **Drag and resize are visible.** Dashboard tiles could always be dragged to move and dragged by
  their right/bottom edge to resize; the handles simply drew nothing. They now appear on hover, and
  the tile header shows a grip. Narrow windows put one tile per row.
- **Present mode fills the window.** It hides both rails and the page tabs (it hid neither before —
  the rule named an element that is not the rail), and scales the tiles so the sheet fills the
  screen instead of leaving a band of empty background below the last row.
- **Chart controls left the plot.** The "Values" and "⋯" buttons moved out of the top-right of the
  chart — where they covered its own data labels — into the tile header and the visual builder's
  toolbar. Maps keep their existing overlay.

- **Change a dashboard by asking.** With a dashboard open, tell the Assistant what you want —
  "add a line chart of amount by month", "make the region chart a bar", "add a filter for channel",
  "rename page 1 to Overview" — and it proposes the change as a plain diff: what it would add,
  change and remove, with a real preview of any new tile and a list of anything it refused. Nothing
  moves until you press Apply, and one Undo puts the whole thing back, including the charts it
  retyped and any it created. It names tiles by their titles, and refuses rather than guessing when
  a name could mean two of them.
- **Dashboard styles — pick how a dashboard looks.** Four app-owned presets: **Clean** (the look
  that shipped), **Executive** (muted paper palette, serif KPI figures, cards that lift off the
  page), **Dense** (tighter grid and smaller type) and **Dark** (dark surface, same accent). Choose
  one from **Style…** in a dashboard's ⋯ menu — four live thumbnails of *your* grid, previewed
  instantly and undoable until you Apply — or before you build, from the strip on the Assistant's
  dashboard proposal. The Assistant understands "make it dark", "make it denser" and "executive
  style", and hands you the same one-click confirm. A style travels with the dashboard: it is saved
  on the record and carried into shared HTML, PDF and PNG exports, so a snapshot looks like what its
  author saw. Charts re-skin with the sheet. Nothing moves: every preset keeps the same twelve
  columns, so a restyle never repositions a card. The Assistant only ever names one of the four
  presets — it never writes CSS or picks a colour.
- **Ask the Assistant to build you a dashboard.** Say "build me a sales dashboard for Adidas US
  Sales" in the Assistant or the Home ask bar and you get a proposal you can look at — its name, why
  it was proposed, each chart drawn with your real numbers, and a plain list of anything the app
  refused to accept — with **Build dashboard** and **Adjust…** underneath. Follow-ups refine the same
  proposal rather than starting over. Every figure in it is computed by Ordinate; the Assistant only
  proposes the structure, and anything it gets wrong is shown to you rather than quietly dropped. An
  empty Dashboards page now suggests build requests over the datasets you actually have.
- **Explore — ask a question about your data.** A page of its own, above Home and on the Home
  screen: pick a dataset, ask in plain language, and get an answer built from figures the app
  computed — with chips saying which dataset and columns they came from. Where the question suits
  one, a real chart appears under the answer, drawn from the app's own numbers and saveable as a
  visual or added straight to an analysis. Conversations are kept per project, so you can leave one
  and come back to it, and start a fresh one whenever. The old Copilot panel is gone; this replaces
  it, and everything still works with no model connected — the AI on/off switch came with it.
- **Dashboards can carry live filter controls.** Add a dropdown, multi-select or date-range card and
  every other card on the sheet filters along with it — no editing, no republish. A reader's picks
  live only in the open window: they are never written to the saved dashboard, so two people looking
  at the same published dashboard can filter it differently without either one moving the file the
  other is looking at. Controls work on a published, read-only dashboard exactly as they do on a
  draft, and stay usable in Present mode — filtering is a read, same as drilling into a chart already
  was. An author can set a control's default from the dialog or by trying it on the sheet and saving
  the current pick; a reader can always get back to that default with the sheet's **Reset controls**
  button, which appears only once a control has moved off it. Drill-down chips and the exported
  summary both reflect a control's current selection; the export itself never carries a live widget,
  only the plain-text value it was set to.
- **Datasets can refresh themselves.** Set a dataset to re-fetch Hourly, Daily or Weekly and Ordinate
  keeps it current. It is honest about what that means: schedules run while Ordinate is open, and
  anything that came due while it was closed catches up when the app launches — the setting says so.
  A master toggle in Settings turns the whole thing off.
- **The app tells you when something changed or broke.** A failed refresh notifies you with the
  reason; a row count that moves more than ±20% notifies you with both numbers. A refresh that went
  as expected stays silent — the `Data as of` line already says it happened, and it updates in place
  without the list jumping under you.
- **Watch a dataset for anomalies.** Turn it on beside the schedule and Ordinate tells you when a
  refresh brings *new* anomalies — never the same ones twice, and never one that has been resolved
  and come back unnoticed. The count is computed by the app; no model is involved anywhere in this
  path. Explaining an anomaly with AI is still something you ask for.
- **The sidebar's search box works.** It always promised "datasets, analyses, dashboards and
  connectors" and did nothing at all. Type and it finds them by name — plus visuals — with arrow
  keys, Enter to open, and Escape to dismiss. It searches names, not row contents.
- **Creating a dataset is a page, not a dialog.** Picking any source opens the **composer**: the
  tables you are combining sit on a canvas with visible join links, the result previews live
  underneath, and the preview's own header row is where you rename, retype and drop columns. Import
  is now: pick a source → composer → Save.
- **Combine as many tables as you like**, not two. Drag or click a saved dataset onto the canvas to
  chain it on; each link has its own join type and key pair.
- **Left joins.** A join can now keep every row on the left and leave blanks where there is no
  match, instead of only keeping rows that match on both sides. Click a join badge to switch between
  Inner, Left and Append and watch the row count change.
- **Field mapping is reversible.** Renames and drops land as ordinary prepare steps, so a composed
  dataset opens in the explorer with its pipeline visible and every mapping removable — exactly like
  a step added later. A dropped column collapses to a restore stub rather than vanishing.
- **A composed dataset refreshes.** Re-fetching it refreshes every table it was built from and
  re-runs the combination over the fresh rows, keeping your prepare pipeline. If one of those tables
  has been deleted it refuses, says which, and leaves the stored data exactly as it was.
- **See the rows behind any number.** Click a bar, a slice or a point — or pick
  `⋯ → Show underlying rows` on any visual — and a panel slides over showing exactly the rows that
  produced it, paged, searchable and sortable. The filters that define the set are listed as chips,
  so you can see what you are looking at. Search and paging run against the stored data, so this
  works the same on a million rows as on a hundred. Available everywhere a visual renders, including
  a published, read-only dashboard: drilling only ever reads.
- **When the exact rows cannot be identified, the panel says so.** A map region, a chart that plots
  raw rows rather than groups, a category that is not a stored column, or a mark with a blank label
  (a missing value and an empty one are different rows) all get a plain sentence explaining why
  instead of an approximate row set that would quietly contradict the figure above it.
- **Export the drilled rows to CSV** — exactly the set on screen, with the same filters, search and
  sort. Plain RFC-4180 text, written straight to the file you pick.
- **Datasets can be refreshed.** A CSV, an Excel sheet, a URL, a database connection and a combined
  dataset can all be re-fetched from where they came from — not just connections, as before. A
  refresh keeps your prepare pipeline: the fresh rows become the new source and every step is
  re-applied.
- **Every dataset says how old its data is.** The Data section shows `Data as of <time>` per dataset
  with a `↻ Refresh` button, plus `Refresh all`. A dataset with no re-fetchable source (pasted text,
  a screenshot capture, or anything imported before this release) says `Imported <time>` and
  explains that re-importing the file makes it refreshable.
- **Analyses and published dashboards show their data's age** in the header, taken from the *oldest*
  of the datasets they read — a sheet is only as fresh as its stalest input — with a
  `↻ Refresh data` action that refreshes exactly those datasets and redraws.
- **A failed refresh never touches your data.** If the file has moved or the source is unreachable,
  the stored table is left exactly as it was, the reason is shown inline next to the dataset, and a
  warning dot stays until the next successful refresh.
- **Visuals is a gallery.** Saved visuals are cards showing the chart type, name and last-updated
  time, instead of a list of rows. Each card has a star and a `⋯` menu: Open, Rename, Duplicate,
  Add to analysis, Export, Delete.
- **Favourite a visual** to pin it to the front of the gallery.
- **Export a single visual** on its own — PDF, PPTX, DOCX, HTML or PNG — through the same export
  dialog the capture result surface uses, carrying the styling the builder saved.
- **Add a visual straight to an analysis** from its card, into an existing analysis or a new one,
  without leaving the gallery.
- **"+ New visual" asks first**: which dataset, then whether to describe what you want or open the
  builder yourself.
- **The AI proposes several charts and draws them**, so you pick from real charts instead of
  accepting one sight-unseen. Every figure on screen is computed by the app from your data — the
  model contributes the structure and a short caption, and never a number. Nothing is saved for
  you: picking one opens the builder, and you still review and save it.

### Changed
- **Adding to an analysis is one dialog, not a chain.** A metric used to be four modals in a row
  (dataset → column → aggregation → label); it is now a single form with a **live preview of the
  number** the card will show, computed by the app exactly as the card computes it. Adding a visual
  is a gallery of your saved visuals rather than a list of names — and it carries `+ New visual` and
  `✨ Suggest with AI`, so you can make one **without leaving the analysis**. With nothing saved yet,
  those two are the whole dialog: no more dead end.
- **Selecting a card opens its Properties.** Editing the card is why you clicked it. Deselecting
  (Escape, or a click on empty canvas) closes the panel again — unless you opened it yourself from
  the rail, in which case it stays. The field list no longer moves between panels: it lives beside
  the wells, and the Data panel has its own browse copy.
- **An empty sheet now says what a sheet is for**, offering Add a visual / Add a metric / Add text
  above the two starter layouts, instead of a blank grid.
- **A selected card shows its outline and controls**; unselected cards show them on hover, so a
  sheet at rest reads as content rather than a wall of buttons.
- **The analysis header shows its publish state as a pill** — Draft, Published, or Unpublished
  changes — instead of hiding it in a tooltip.
- **The Analyses list is painted like the rest of the app**: a proper header with a count and
  right-aligned actions, the shared table treatment, and one status pill carrying all three states
  (it used to say "Published" beside a separate "Unpublished changes" badge).
- **The Data section is three jobs in three places.** It was one scroll of twelve blocks that
  interleaved importing, exploring and preparing, with the saved datasets — the thing the section is
  for — last, under all of it. Now: your datasets are a table at the top (Name, Rows, Source, Data as
  of), importing is a dialog, and opening a dataset takes the whole panel with a `← Back to datasets`,
  the same way the Visuals gallery and builder swap.
- **A dataset's views are tabs: Data, Prepare and Quality.** Quality used to be a strip above the
  toolbar that nobody scrolled to, and says "no quality issues found" when there is nothing to
  report. Prepare is a workbench — the steps on the left, the live grid on the right — so you can
  see what a step does to your data while you edit it.
- **Combine datasets moved out of Prepare** and into its own action in the Data header — and is now
  the composer, not a dialog of four selects. There is one flow for making a dataset, not two.
- **The Visuals builder is a two-pane workbench, not one long scroll.** Building a chart used to mean
  a single column — encoding form above, chart squeezed below it — so seeing what a change drew meant
  scrolling past Category/Measures/Filters first. Now: a header carries Back, the visual's name,
  Dataset, Suggest chart and Save; a fixed-width panel on the left holds the encoding form; and the
  chart fills the stage beside it in its own card, the same head-and-rail shape as the Prepare tab.
- **Internal: the ten biggest source files are split by job**, and a CI check now keeps them that
  way — no source file may exceed 800 lines, against an allowlist that can only shrink. Pure code
  movement, no behaviour change: `hub.ts` 2051 → 422, `dashboards.ts` 2340 → 269, and `authoring`,
  `datasets`, `visuals`, `analyses`, `connections` and `formula` likewise.
- Renamed the project from Screenchart to Ordinate. Screenchart is now the name of one data source
  (screenshot capture) rather than the product. The application bundle and `userData` directory are
  unchanged pending a migration.
- The AI chart suggestion may now propose any of the 25 chart types the app can draw, up from seven.

### Fixed
- The Data section's paste box, sheet picker, warnings, preview, save bar, prepare panel and quality
  strip were on screen permanently — each set a CSS `display`, which overrides the `hidden`
  attribute, so they never went away no matter what the app asked for. Closing an open dataset also
  left it on screen under the list, for the same reason.
- First-run capture no longer shows a redundant "Capture failed" card window before macOS
  Screen Recording permission is granted.
- Multi-step modal dialogs no longer let the keyboard focus trap land on a control in a hidden step,
  which stranded focus outside the dialog.
- A dashboard-level filter and a card-level filter using `in`/`not in` on the same column could
  collide and one would silently drop the other, from a dedup key that ignored the values being
  filtered on. Fixed before it could bite a real user: it only started mattering once a control card
  could itself emit an `in` filter.

## [0.1.0] — 2026-07-XX <!-- TODO(ashish): set release date -->

Initial public release.

### Added
- Global-hotkey capture (default ⌘⌥S, user-configurable): drag a box around any chart, table,
  or on-screen data from any app.
- Plain-English AI analysis of the captured region.
- Visualizations rendered from the captured data.
- Bring-your-own-key providers: Anthropic, OpenAI, Gemini, and gateway (any OpenAI-compatible
  endpoint, e.g. OpenRouter / Ollama / custom).
- Local CLI-agent execution path as an alternative to BYOK.
- Local capture history (`userData/history/<threadId>/`).
- Map visualizations (tiles fetched from OpenStreetMap on render).
- macOS build (packaged with electron-builder).

### Known issues
- Unsigned build → macOS Gatekeeper shows "Apple could not verify" on first launch (see
  QUICKSTART for the dismissal steps).
- Some CLI agents (e.g. Cursor) trigger a macOS Automation prompt that is safe to deny.
- API keys are stored in plaintext on disk (not encrypted) — see PRIVACY.md.

<!-- [Unreleased]: https://github.com/AshishB2000/ordinate/compare/v0.1.0...HEAD
     [0.1.0]: https://github.com/AshishB2000/ordinate/releases/tag/v0.1.0 -->
