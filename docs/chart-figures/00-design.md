# One set of figures — design

A waterfall's running totals, a Pareto's order and cumulative share, a 100%-stacked chart's shares:
until now each was computed three times — in the browser (`web/src/charts/shapes.ts`,
`datasets.ts`), again for the caption (`src/analysis/chartFigures.ts`), and a third time,
differently, by the published page (`src/publish/site/publishCore.ts`). The `/p/` copy was wrong:
it assumed Pareto bars arrive sorted (they never do), let negatives drag the cumulative line, and
ignored Total rows and the two-series bridge. One tile showed three sets of numbers.

## What you will see

- **A Pareto, a waterfall and a 100%-stacked chart read the same everywhere**: in the app, in its
  caption, on its published page at `/p/…` and inside a signed embed. The server computes those
  figures once and every drawer draws them; nothing in the browser adds, accumulates or rounds a
  figure any more.
- **The published Pareto is sorted** and its cumulative line climbs to 100% over the positive bars;
  a **published waterfall** has its Total bars and its last-year → this-year bridge, as the app's has.
- **Shares on a 100%-stacked chart are exact.** The bars are drawn from the server's unrounded shares
  (they used to be rounded to whole percents before being drawn, so a stack could add up to 99% or
  101%); the labels and tooltips format them with the app's number formatter. Each segment is
  labelled with its own figure (on every stacked chart): the running total a segment's label used
  to show was a sum the browser made.
- A chart of one of these types whose figures did not arrive (an old cached reply) shows its
  designed "Nothing to draw" state — in the app and on `/p/` — and never works them out itself.
- **The published page looks like the app**: month axes read "Jan 2023" (not `2023-01-01`), and
  so do captions ("from Jan 2023 to Dec 2024"); bars and lines carry the app's default value labels
  (each series' largest and smallest; a waterfall's totals and its largest rise and fall) and there
  are no vertical gridlines; a KPI tile shows its figure with what it measures under it ("Sum of
  revenue"), left-aligned like the app's, under its title; a scorecard's "3 on track" is the
  server's count; a dashboard styled **Auto** follows the reader's light or dark setting
  (`dashboards-published-dark.png` now differs from the light one).
- A **histogram**'s bins, a **funnel**'s "% of top", a **bullet**'s "% of target" and a
  **calendar**'s days are the server's too; a **stacked** segment's label is its own figure; the
  map's cluster markers no longer add up values they never draw.
- A screen reader hears the drawn figures of these three chart types: each chart carries a hidden
  list of them under the canvas ("Technology +1.3M to 5.4M"), the same text in the app and on `/p/`.
- The Firefox/WebKit nightly is green again.

## Decisions (from the plan — not re-litigated)

1. Nightly first, each failure by its root cause, never a skip.
2. The server computes chart-shape figures once: a pure `chartShapes(type, viz)` in
   `src/analysis/chartShapes.ts` returns a `figures` block beside `{labels, series}`.
3. The reference is today's in-app chart (`shapes.ts`): goldens are recorded from it BEFORE the math
   moves (`web/src/charts/__golden__/shapes.json`, wire-encoded) and never re-recorded.
4. Every drawer reads `figures`: the in-app chart, the caption (`chartFigures.ts` deleted), `/p/` and
   embeds (`publishCore.ts`'s math deleted). React formats with the shared formatter.
5. The sanitizers are security controls: `figures` is whitelisted field by field (numbers, labels,
   one closed enum), never spread; an unknown sibling is stripped.
6. Published-page parity: month labels from the shared formatter, value labels and no vertical
   gridlines on bars, KPI label and subtitle, style `auto` by a static `@media` block (no inline
   style — the page's CSP pins its one stylesheet).
7. `publishClient.ts` is split along its seams first, with no behaviour change.
8. No migration, env var or dependency.

## Decisions made here (where the plan left room)

### Where `figures` is attached — one function, the last step of each door

The plan asked for "the one point every viz payload passes after the extract/Live split (find it
from `vizDataFor`)". Read from `vizDataFor`, there is no single such point that comes **after**
everything that changes a chart's series: `visual:data` runs table calculations, the period overlay,
the Compare series, the **Share policy** (masking) and the analytics overlays on `vizDataFor`'s
answer, and `/p/` runs its own Share policy hook (`outgoing`) in `chartPayload`. A figure computed
inside `vizDataFor` would describe a series the reader never sees — and, under a masking policy,
would leak the masked value through a cumulative percentage or a running total.

So: **one pure function** — `chartShapes(type, data, opts)` — and **one wrapper**,
`withFigures(data, ask)`, which every door calls as the **last** step before its reply leaves, after
the Live/extract split and after every step that changes the series:

| Door | Where | Reaches |
|---|---|---|
| `visual:data` / `visual:dataBatch` | `src/ipc/visuals.ts` `vizData` | dashboard tiles (`analysis:tiles` → `visual:data`), gallery thumbnails (`visual:thumbs`), reports and stories (`reportsServer` `pageDeps.vizData`), the builder under "As of", New visual's suggestions |
| `visual:preview` | `src/ipc/vizSample.ts` | the builder |
| `chartPayload` | `src/publish/dashboardData.ts` | `/p/` dashboards and stories, signed embeds, Export HTML |
| AI answers | `src/ipc/answers.ts`, `src/ipc/liveAnswers.ts` | the Ask card |
| Plan preview | `src/analysis/planPreview.ts` | the Assistant's draft review |
| Capture page | `src/app/captureUpload.ts` `viewOf` | a capture's suggested charts |

A figure is a pure function of the reply's **own** `{labels, series}` — it carries nothing the
series does not. That is the invariant item 5 (row policy) relies on: its lock narrows the filters
at `vizDataFor` and the Share policy shapes the series; whatever narrows the series narrows the
figures, because they are computed from it, last. No door may attach figures before a step that
changes the series; `scripts/test-chartShapes.ts` runs every door and checks its figures equal
`chartShapes` over the reply's own data (with a negative control).

### The request carries the chart type

`visual:data` never knew what it was drawn as. `VizDataInput` (and `analysis:tiles`'s visual item)
gains two optional fields, `chartType` and `waterfallTotals` — sent only for a type that has figures
(`figureAsk(type, overrides)` in `src/analysis/figureAsk.ts`, shared by the server's doors and the
web, holds the list), so a switch between column, bar and line still reuses the cached answer. The
waterfall's named totals change a figure, which is why that one override travels.

### The `figures` block

Keyed by family, so one block can serve every type a capture suggests:

- `waterfall: { from, to, steps: [{ label, start, end, value, kind, src }] }` — `kind` is
  `start | up | down | total | end`; `src` is the step's index into the labels (-1 for the bridge's
  ends and the closing Total), which is how the drawer labels a month step "Jan 2023".
- `pareto: { order, cumPct, count80, total, positives }` — `order` the label indices, sorted
  descending (stable, nulls last); `cumPct` in percent (0–100) over the positive values.
- `sharePct: number[][]` — per series, per label, the share of the label's total, in percent,
  unrounded (the chart's axis is 0–100, so nothing converts it).

Series are taken as the drawer takes them: an empty series is dropped, and a prior-period overlay
series is left out (none of these types draws one).

### Months

`asMonthLabels` moves from `web/src/charts/build.ts` to the shared formatter `src/app/format.ts`
(the survey placed it there already; it was in the chart engine), so the app, `/p/` (which inlines
`format.js` as `OrdFormat`) and captions name a month the same way. Axes use the workspace's format
locale; a caption uses the org's language, formatted BEFORE `t()`.

### `publishClient.ts` and `dashboardExport.ts`

`publishClient.ts` (702 lines) splits into `publishTiles.ts` (tables, pivots, the chart body, a card),
`publishMaps.ts` (the SVG maps) and `publishPages.ts` (story, scorecard, index), each a classic
script inlined after `publishPhone.js`; `publishClient.ts` keeps the header, the dashboard and boot.
`dashboardExport.ts`'s whitelist (the sanitizers, a trust boundary) moves to
`src/analysis/exportSanitize.ts`, re-exported, so the figures whitelist lands in a file with room.

### The screen-reader list, and the parity e2e

The canvas is not text, so "the same figure text in the app and at `/p/`" needs text both pages
render. `figureLines(type, labels, series, figures)` lives in the shared formatter
(`src/app/format.ts`, which the app imports and `/p/` already inlines as `OrdFormat` — a new file
would have needed its own inlined script and CommonJS shim) and turns a `figures` block into lines,
formatted with the workspace's compact format; both drawers put them in a visually hidden list
under the canvas that the canvas names with `aria-describedby`. `web/e2e/figures.e2e.ts` opens the
same Pareto (by a sub-category, so it arrives unsorted) and waterfall (by month) tiles in the app
and at `/p/` and asserts the two lists are equal.

### KPI tiles on `/p/`

The payload gains `subtitle` (whitelisted): what the KPI measures — a column metric's "Sum of
revenue" (catalog sentences, `src/publish/publishMessages.ts`), a saved metric's own definition as
the Metrics table words it — left out when it only repeats the title. The tile reads title (card
head), figure, subtitle, left-aligned as the app's does.

### The rest of the sweep: no figure arithmetic left in the browser

The trace found more than the plan's three: the browser also bins a **histogram** (counts rows of
the series), works out a **funnel**'s "% of top" and a **bullet**'s "% of target", **sums** two
calendar labels that fall on one day, and labels a **stacked** segment with a running total. Each
gets the same treatment, in its own commit after the three: the server's `figures` gains
`histogram` (per series: bin edges and counts), `funnel` (per series: each stage as a percent of the
first) and `bullet` (each row as a percent of its target — `bulletTarget` travels with the request
like `waterfallTotals`), and `calendar` (one value per day); a stacked segment is labelled with its
own figure. Display rounding (`Math.round`, `toFixed`) becomes the shared formatter. What stays is
arithmetic on pixels and colours, never on a figure: canvas geometry, colour ramps, a radar's
per-axis scaling and a bullet's bands (drawn shapes; the tooltips show the raw figure), a funnel's
centring spacer, a slice's share used only to decide whether its name fits, and the Format → Sort
order. The grep and its classified hits are in this item's PR.

## Caller inventory (traced on b5377dd2)

- **Browser math** — `waterfallSteps`, `paretoShape` (`web/src/charts/shapes.ts`): one caller,
  `familiesExtra.ts`; pinned by `shapes.test.ts`. 100%-stacked shares: `datasets.ts`
  `buildBarData`. Stacked value labels' running total: `valueLabels.ts`. All pinned to the desktop's
  configs by `legacy.test.ts` (data arrays compared with `Object.is`).
- **Caption copy** — `waterfallFigures`, `paretoFigures` (`src/analysis/chartFigures.ts`): one
  caller, `captions.ts`; pinned by `test-captions.ts` against the desktop goldens
  (`scripts/fixtures/golden/captions.json`). `tileCaption` callers: `chartPayload`, `answers.ts`,
  `liveAnswers.ts`, `reports:caption` (reports and stories, through `pageDeps.caption`).
- **`/p/` copy** — `pkChartConfig` (`publishCore.ts`): one caller, `pcChartBody`; pinned by
  `test-publishSite.ts` §3.
- **`vizDataFor` callers** (15): the doors above, plus copilot facts, drill scope, drivers point,
  metric-tree splits, insights sparklines, metrics, dataset views, embed lock options and
  automation creators — none of which draws one of these types.
- **`<Chart>` users that may draw these types**: `VisualTile` (tiles, thumbnails), `ChartStage`
  (builder), `NewVisualDialog`, `FacetGrid` (each panel of a faceted visual: `withFigures` covers
  `data.facets` panels too), `AnswerCard`, `CapturePage`, the reports/stories pages, the dev gallery.
  Template thumbnails draw only line, clustered column, funnel, donut, bar and column.
- **Sanitizers** — `sanitizeChartData` (`dashboardExport.ts`, shared by `sanitizeBundle` and
  `src/publish/sanitize.ts` `sanitizePayload`).

## Steps

1. The nightly fixes (done first, four commits).
2. Split `publishClient.ts` and `dashboardExport.ts`, no behaviour change; `test-publishSite` green
   before and after.
3. Goldens from today's `shapes.ts` and `buildChart` (waterfall, Pareto, 100%-stacked), own commit.
4. `chartShapes.ts`, `figureAsk.ts`, `withFigures` at every door; the contracts gain `chartType`
   and `waterfallTotals`.
5. The web drawers read `figures`; the browser copies are deleted.
6. Captions read `figures`; `chartFigures.ts` is deleted; months formatted before `t()`.
7. The sanitizers keep `figures`; `publishCore.ts` draws from it; its math is deleted.
8. The parity items; the screen-reader list; the e2e.
9. The rest of the "no figure arithmetic in the browser" sweep (see below).

## Tests

- `scripts/test-chartShapes.ts` (new): `chartShapes` against the goldens with `Object.is` per number
  (shares: each rounds to the recorded whole percent — the recorded chart rounded before drawing);
  the three `/p/` bugs pinned as fixed; every door's figures equal `chartShapes` over its own reply;
  NEGATIVE CONTROLS: a deliberately wrong reference fails, a door that skips `withFigures` fails.
- `test-captions.ts`: the caption's numbers equal the `figures` block's (differential), and a reply
  without figures falls back to the generic sentence, never recomputes.
- `test-publishSite.ts`: `publishCore` draws exactly the payload's figures; a payload without
  `figures` shows the designed unavailable state; the sanitizer keeps `figures` and strips an
  unknown sibling (control).
- Vitest: the in-app charts render from `figures` (and render nothing without them).
- e2e: `figures.e2e.ts` (app vs `/p/`, the same Pareto and waterfall); the published screenshots,
  light and dark, differ; `phone.e2e.ts` and `rebuild.e2e.ts` on Chromium, Firefox and WebKit.

## Residuals (classified, not figures)

`grep -nE "\+=|-=|reduce\(|Math\.round|toFixed|\bsum\b|\bcum\b|total"` over `web/src/charts/` and
`src/publish/site/` still finds: pixel and canvas geometry (placement, `toFixed` of SVG
coordinates, the word cloud's layout, a map's projection and colour ramp); colour arithmetic
(`palette.ts`, `alphaHex`); selection of an existing figure (min/max for an axis or a ramp, the
largest and smallest bar to label); a slice's share used only to decide whether its name fits
(`valueLabels.ts`, never printed); the funnel's centring spacer; a dragged annotation snapped to a
round value (user input); the phone strip's page dots; and Format → Sort, which orders a chart's
categories by their stack total (`build.ts`) — an order, never a printed figure. Every rounding of
a printed figure goes through the shared formatter.

## Out (next)

- The 8 table-fallback types and word cloud on `/p/` — the same `figures` pattern, per type.
- Server-side PNG export.
