# Explore: ask a question, no model needed

## What you will see

Open **Explore** in the left nav and you are in a full-width workbench on the current project:

- **The fields of a dataset, on the left**: a dataset picker, a search box, then the dataset's
  fields in three groups by their DECLARED type — **Dimensions** (text, and numbers that are ids,
  codes, years or coordinates), **Dates**, **Measures** (numbers, the money ones first). A field in
  the question is marked. Click a measure to add it, a dimension or a date to group by it; click it
  again to take it out.
- **The question, in four wells** along the top: SHOW ([Sum ▾ | revenue ×] [+ Measure]), GROUP BY
  ([region ×], and [Month ▾] when it is a date), SPLIT BY and FILTERS ([order_date in Last 12 months
  ×] [+ Filter]). Every pill opens the field list, the aggregate menu (Sum, Average, Count, Min,
  Max), the time grain (Auto, Day, Week, Month, Quarter, Year) or the filter dialog the builder
  already uses (values, ranges, relative periods). Clear question starts over.
- **The answer under it**: a title the question words ("Total revenue by region"), the chart-type
  chips the answer suits (+ More for every other chart), how fresh the figures are, any note the
  server attached ("Showing the top 50 of 312"), the chart, and **the same answer as a table**
  under it, its row labels pinned while it scrolls sideways.
- **Before any question**: the wells wait, empty, and the main area offers **suggested questions**
  for the dataset — cards with a live thumbnail of each answer, "Total revenue by region", "Total
  revenue by month of order_date", "Total profit by region"… Click one and it is the question.
- **The question is the URL.** Copy link (everyone has it) and whoever opens it, with access to the
  project, sees the same question; Back and Forward step through your edits.
- **An editor** also gets **Save as visual** (named, then it is in Visuals, ready for any dashboard)
  and **Open in the builder** (the builder, prefilled with the question, for everything Explore does
  not do: styling, analytics, pivots). **A viewer sees neither** — and still asks, answers and
  shares, with no AI model anywhere.
- **With an AI model set up**, a slim ask box sits above the question: plain words go to the
  Assistant, which answers with the app's figures. Without a model there is no box at all; the page
  is complete without it.
- **The states are designed**, in both themes: no project; no datasets (an editor gets the import
  and connect doors, a viewer reads "An editor of this project can bring in data. You have
  view-only access."); a skeleton while the fields load; a question half-asked ("Add a measure, and
  the answer appears here.");
  a figure a Live dataset cannot give (the server's sentence, and Make a copy for an editor); an
  error with Try again; and a question no row answers ("No rows match this question", with Clear
  filters).
- **On a phone** the field list moves into a bottom sheet (#299's `Sheet`, opened by **Fields**),
  the four wells become four compact rows (the label beside its pills), the chart-type chips are one
  line that scrolls sideways, the chart is phone height and full width, and the table scrolls
  sideways with its first column pinned. The app's own top bar and rail stay: Explore has no back
  button of its own.

## Decisions (from the plan; not re-litigated)

- `/explore` is a full-width question builder for everyone; the browser computes nothing.
- Suggestions come from the server, through a new `read` contract `explore:suggest` (project
  scoped), from `starterPlan.ts`'s ranking over the dataset's DECLARED columns. Encodings only,
  never a figure. No second heuristic in the browser.
- The question lives in the URL as a compact encoded spec, re-validated by `VizDataInput` on every
  read.
- Editors get Save as visual (`visual:save`) and Open in the builder; viewers see neither (hidden,
  never disabled — #307). No add-to-dashboard channel.
- With an AI model ready, an ask box hands the question to the existing ask flow (`openDockWith`,
  Home's `AskBar`). Without one, no box.
- One lazy chunk; `nav.ts` and `routes.tsx` untouched; the placeholder copy deleted.

## Decided here, where the plan left room

| Question | Decision | Why |
|---|---|---|
| Which read door answers a question? | **`visual:data`**, through `web/src/api/visuals.ts loadVizData` (a lone request is `visual:data`; the suggestion thumbnails asked in one tick go out as one `visual:dataBatch`). Not `visual:preview`. | Both take an unsaved encoding over `VizDataInput` and both run `vizDataFor`. The difference is that `visual:preview` may answer a big non-resident table on a stratified **sample** — right for a builder's draft, wrong for an answer that is shared by link and saved as a visual: the link, the saved visual and a dashboard tile must show the same figures. A resident aggregate costs ~6 ms; the hydrate fallback is the ~1.2 s per 1M rows `visual:data` already accepts for one chart someone is looking at. |
| What does `explore:suggest` read? | **Metadata only** — `datasets.getDatasetMeta` (one record read). No column summaries, no geo sample, never a row, for an extract exactly as for a Live dataset. | The plan says "over the dataset's declared columns". `starterPlan.categoryColumns` already states the rule for no summaries: every text column stays eligible ("a wide axis is ugly, never wrong, and never worth hydrating a table to avoid"). It keeps the reply instant, identical on Live and extract, and leaves item 5's row policy nothing to restrict here: the suggestions carry column names, never a value or a count. A place column is still offered a map — by the answer's own `geoSuggest`, as in the builder. |
| The reply | `{ok: true, dimensions: [{name, type}], dates: [{name}], measures: [{name, aggregation}], suggestions: [{chartType, encoding}]}` — order is the ranking; **no number anywhere** (no row count, no rank, no `bins`). A missing dataset is `{ok: false, error}` with the catalog's "This dataset no longer exists." | The field list and a click's default aggregate (`aggregationFor`: a price or a rate is averaged, never summed) are starterPlan's too, so the browser holds no word list. |
| The suggestion ladder | Over `rankedMeasures` (starterPlan's money → counts → rest, ids out) and `categoryColumns`: m0 by c0 (column); m0 by the first date at month grain (line); m1 by c0 (column); m0 by c1 (bar); m1 by month (area); m0 by c2 (bar) — the first six that exist, deduplicated. No measure: the count of rows by c0 and by month. No text column: the date stands in, as in `buildStarterPlan`. | Deterministic, explainable, and a date grain is now a real `encoding.grain`, so "by month" no longer needs starterPlan's calculated field. A split-by suggestion needs a cardinality the metadata does not have, so none is made (a 50-series stack is a barcode). |
| Who names a question? | The web, from the encoding (`questionTitle`): "Total revenue by region", "Average discount by month of order_date". Words only, like the builder's `suggestName`. | Naming is not ranking; the server returns structure only. The React UI is English-only. |
| The URL | `/explore?project=<id>&dataset=<id>&q=<spec>`, `q` = base64url of UTF-8 JSON `{t: chartType, e: encoding, f: filters}`. `project=` is the app's existing deep-link convention (`features/projects/current.tsx`). Each edit **pushes** a history entry; filling in a missing project or dataset **replaces**. A `q` that does not decode, or is not the right shape, is ignored (the page opens on its suggestions). | The browser only shape-checks so the page cannot crash; the server is the validator: `VizDataInput` (zod: UUIDs, `category` ≤ 512, ≤ 64 measures with an enum aggregate, ≤ 200 filter steps) then `sanitizeEncoding` / `sanitizeFilters` whitelists, on every read. A crafted link can only ask a read question of a project the opener may already read. `chartType` never leaves the browser; an unknown one falls back to the first the answer suits. |
| Chart types offered | Every chart, map and the table, from the answer's shape (`eligibility.ts`, as the builder does). **Not** pivot, cohort and event funnel. | Those three are not a chart of a question but their own shelves; "Open in the builder" is their door. |
| Drawing | The builder's `ChartStage` (charts, maps, the table) and `DataTable`, with the answer as the server sent it. | One drawer: when item 1 adds the server's `figures` block to the payload, Explore draws from it with no change here. |
| Thumbnails on the suggestions | Drawn from one `visual:dataBatch` — **extract datasets only**. A Live dataset's cards keep their chart glyph. | A Live question is a warehouse statement against `LIVE_DAILY_QUERY_LIMIT` and, on BigQuery, billed bytes. Six statements for questions nobody clicked would be a surprise bill. |
| Phone | Under 900 px the rail is not drawn; a **Fields** button opens it in `Sheet`. Under 600 px the chart is 300 px tall. No `data-phone` attribute: that hides the shell for a dashboard, which has its own back button; Explore does not. The table pins its first column with a new `pinLabels` prop on `DataTable`. | |
| A field in use | Clicking a used field takes it out. A question without a measure or a group-by says which is missing rather than drawing nothing. | |
| The chart when the question changes shape | A picked chart type is kept until the answer changes SHAPE: the group-by changes kind (text ↔ date), the measures go from one to several (or back), or a split is added or removed. Then it goes back to the first type the new answer suits (`spec.ts groupBy` / `withValues` / `withSplit`). | A column chart picked for regions is not what a run of months, or two measures, asks for; a swap of one measure for another keeps the pick. |
| Save on a refused answer | "Save as visual" is not offered while the answer is refused or failed; Open in the builder stays (the builder says why). | A visual that cannot draw is a trap in the gallery. |
| A Live dataset's suggestion cards | The chart glyph and a "Asked live when opened" note, no thumbnail. | See the thumbnail decision above. |
| The colour map | Read (`format:colors:get`), never dealt: exploring writes nothing, for an editor either. | A viewer's question, and an editor's passing one, must not change the project's stored colours. |
| Types the e2e can import | The encoding and filter types moved from `visuals/api.ts` to a dependency-free `visuals/encoding.ts` (re-exported, so no importer changed); `spec.ts` imports only those, so the e2e builds links with the page's own encoder. | |
| Saving | The name defaults to the question's title. An "Auto" time grain is saved as the grain the server chose (`category.grain`), exactly as the builder's Save does, so the saved visual draws the same axis. After the save a toast offers **Open in Visuals**; the page stays on the question. | |
| AI hand-off | `pickDockProject(projectId)` then `openDockWith(text)`: the dock asks in Explore's project. | The dock does not follow the switcher off a project's own route (`dockState.ts`). |

## Item 5 relies on this: every Explore figure goes through `vizDataFor`

Explore draws a figure from one place: `useExploreAnswer` and the suggestion thumbnails, both
`loadVizData` (`web/src/api/visuals.ts`), which sends `visual:data` or `visual:dataBatch`. On the
server both handlers are the one closure `vizData` (`src/ipc/visuals.ts:603`, registered at `:636`
and `:640`), which sanitizes the input and calls `vizDataFor` (`:437`) — the door that sends a
Live dataset to its warehouse (`:449`), holds the answer cache, and where item 5 appends its lock
step. No other figure channel is called by the page (`explore.test.tsx` lists every channel it
sends and fails on any other), and `scripts/test-exploreSuggest.ts` sends Explore's request
through the real route on a Live dataset and gets the warehouse's answer without a hydrate, which
only `vizDataFor`'s Live branch gives. `explore:suggest` reads no row (spied), so a row policy has
nothing to cover there.

## Steps

1. `explore:suggest`: the contract in `src/api/explore.ts` (appended to `src/api/index.ts`), the
   handler in `src/ipc/explore.ts`, the pure ladder in `src/analysis/exploreSuggest.ts`;
   `starterPlan.ts` exports `rankedMeasures` and `categoryColumns` (its `kpiColumns` becomes
   `rankedMeasures(ds).slice(0, 4)`, so every starter is unchanged).
2. `web/src/features/explore/`: `spec.ts` (URL ⇄ question, the edits a click makes, the title —
   pure), `useExploreSpec.ts`, `api.ts`, `ExplorePage.tsx` (the gates and states), `Explorer.tsx`
   (the workbench), `FieldList.tsx`, `Question.tsx` (the wells), `Answer.tsx`, `AnswerActions.tsx`,
   `Suggestions.tsx`, `AskBox.tsx`, `Explore.module.css`.
3. Editor actions: Save as visual (`NameDialog`, `saveVisual`), Open in the builder (BuilderPage
   takes `filters` from the navigation state too).
4. The AI ask box.
5. Tests, the e2e and its screenshots; the viewer walk (`viewerRoutes.ts`) learns the page.

## Caller inventory

| What changes | Callers checked |
|---|---|
| `starterPlan.ts`: `rankedMeasures`, `categoryColumns` exported; `kpiColumns` = `rankedMeasures().slice(0, MAX_KPIS)` | `buildStarterPlan` ← `templates.ts`, `sampleProject.ts`, `ipc/analyses.ts`; `metricAuto.ts` (imports `aggregationFor`, `measureRank`, unchanged); `templateRoles.ts`, `userTemplate.ts` (`words`). Same order, same slice: `test-starterPlan` stays green. |
| `src/api/index.ts` | Append-only: one import, one spread. |
| `src/server/app.ts registerHandlers` | One more module in the Visuals line. |
| `BuilderPage.tsx`: `location.state.filters` | `VisualsPage.go` and `AnalyticsPage` send `{encoding?, chartType}` — no `filters`, so they read `[]` as today. |
| `DataTable`: optional `labelHeader`, `pinLabels` | `AnswerCard`, `VisualTile` ×2, `ChartStage`, `NewVisualDialog`, `ChartsGallery`: none passes them; unchanged. |
| `Thumb.tsx`: `ChartThumb` exported | Used as before by `Thumb`. |
| `web/e2e/viewerRoutes.ts` `/explore` | The viewer walk: walked on a question link now; an editor control (Save as visual), the exploration names the write pattern would count (Add measure, Remove measure, Remove group by, Add filter), and what a viewer must keep (Copy link). |
| `visuals/api.ts` encoding types | Moved to `visuals/encoding.ts` and re-exported from `api.ts`: every importer unchanged. |
| `FilterRows.tsx` | Its step summary exported as `FilterSummary` (Explore's filter pills); FilterRows itself unchanged. |
| `routes.tsx`, `nav.ts` | Untouched: both entries exist. |

## Out

Saving an exploration as a dashboard (next: through the new-dashboard wizard); fields from related
datasets (joins); a question history; the rows behind a mark; pivots, cohorts, funnels, small
multiples, analytics overlays and "As of" (all in the builder, one click away for an editor).

## Tests

- `scripts/test-exploreSuggest.ts`: no number anywhere in the reply (a walk of every value), the
  ranking against `starterPlan`'s own functions, the ladder on edge datasets (no measure, no text,
  no date, one column), a Live dataset answered from its declared columns with `getDataset` and
  `residentSource` spied (never asked — for the extract too), a project viewer admitted by
  `authorize` on the real contract (NEGATIVE CONTROL: no grant → refused), another project's
  dataset refused, and Explore's `visual:data` request on a Live dataset answered by its warehouse
  without a hydrate (the routing proof above).
- Vitest `explore.test.tsx`: a viewer sees no Save as visual or Open in the builder (CONTROL: an
  editor does); the URL round-trips and Back restores the last question; a refusal renders
  `<LiveRefusal>` (CONTROL: an ordinary failure is an error with Try again); no ask box without AI
  (CONTROL: with AI ready it shows and hands the words to the dock); every channel the page sends
  is on the read list. `spec.test.ts`: encode/decode, junk, unicode, the title.
- e2e `web/e2e/explore.e2e.ts`, as an editor (everywhere) and as a viewer (with Postgres, like the
  other viewer specs): pick the sample dataset, take a suggestion, change the group-by; the table's
  figures equal the server's reply to the same request; a reload of the URL gives the same chart;
  the editor saves a visual and it is in Visuals; ≤ 25 RPCs per load; screenshots `explore-empty`,
  `explore-question`, `explore-viewer`, `explore-phone`, light and dark.

## Measured

- `explore:suggest` through the real route (Fastify inject, records as files): **0.57 ms** median of
  50 — one metadata read; no summary pass, no sample.
- RPCs per page load in the e2e (budget 25): the start page **8** (one `visual:dataBatch` carries
  all six thumbnails), a question **9–10**, the empty project **5**.
- Explore's answer on a resident extract is the `visual:data` fast path (no hydrate); on a Live
  dataset it is one warehouse statement, cached by `vizDataFor` like any tile's.
