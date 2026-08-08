# Changelog

All notable changes to Ordinate are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning per
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** the project was renamed from **Screenchart** to **Ordinate**. Releases up to and
> including 0.1.0 shipped under the Screenchart name; entries below use the current name.

## [Unreleased]

### Added
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
- **Combine datasets moved out of Prepare** and into its own action in the Data header. It creates a
  new dataset rather than transforming one, so it never belonged at the bottom of a pipeline panel,
  and it no longer requires opening some other dataset first to find it.
- **The Visuals builder is a two-pane workbench, not one long scroll.** Building a chart used to mean
  a single column — encoding form above, chart squeezed below it — so seeing what a change drew meant
  scrolling past Category/Measures/Filters first. Now: a header carries Back, the visual's name,
  Dataset, Suggest chart and Save; a fixed-width panel on the left holds the encoding form; and the
  chart fills the stage beside it in its own card, the same head-and-rail shape as the Prepare tab.
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
