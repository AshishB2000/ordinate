# Rebuild a dashboard from a screenshot

**Date:** 2026-10-15 · migration: none · new runtime dependency: none

## What you will see when this is done

1. **Create dashboard → Start from** has a new card, *Rebuild from a screenshot* (beside "Let the
   Assistant design it", disabled with the same not-ready line when no model is set up). Choosing it
   opens a full page, `/analyses/<project>/rebuild`, on the dataset you picked. The Assistant gets
   there too: "rebuild this Tableau dashboard" opens the same page on the dataset in context.
2. **Drop a screenshot** of a Tableau / Power BI / Looker / Metabase dashboard (or paste it). While
   the model reads it, the screenshot is already on the left and the right shows the step list.
3. **The check screen.** Left: the screenshot, each tile the model found outlined and numbered on it.
   Right, top: the dataset (a picker — switching re-matches instantly, no second model call) and a
   sketch of the dashboard that will be built (the same `PlanSketch` the Assistant draft shows).
   Right, below: one card per tile, numbered like the outline —
   - its kind and chart type (a dropdown of Ordinate's chart types, plus *KPI*), its title (editable);
   - each field it appears to use — *Category*, *Value* (with its aggregation), *Split*, or the
     *Filter* column — mapped to a column of your dataset, with a confidence cue
     (Exact / Likely / Guess) and a dropdown to change it. The dropdown lists only the columns that
     fit the role: a sum, average, min or max lists number columns; a count lists every column;
   - when it is ready, a small preview drawn from **your** data by the engine (a chart through
     `vizDataFor`, a KPI through `computeCardMetric`), so you see the real figure before creating;
   - when it cannot be built, why — "No number column like 'Profit'", "Ordinate has no
     'sunburst' chart — pick a type", "sum needs a number column, but 'Region' is text" — and the
     two ways on: fix the field, or **Drop** the tile (and **Restore** it).
   Filters the screenshot shows become filter chips on the built dashboard, listed as their own cards.
4. **Create dashboard** builds a real dashboard through `analysis:buildPlan` — the same door the
   Assistant's drafts and templates use — and opens it: the arrangement (bands of KPIs, charts side by
   side, a chart with KPIs beside it), the chart types, titles, KPIs and filters. Every figure on it
   is computed by the engine from your data.
5. **No model** → the page shows the designed not-ready state pointing to Admin → AI (`AiNotReady`),
   and the wizard card is disabled with the same line.

The model reads **structure only**. Numbers it reads off the screenshot are discarded on the server
before anything reaches the browser; a figure-shaped token in a title ("Total sales $2.4M") is cut.

## Decisions (made without the user, as asked)

| Question | Decision | Why |
|---|---|---|
| Page or dialog? | A page, `/analyses/:projectId/rebuild?dataset=&name=` | Screenshot beside a tile list needs the width; the wizard's dialog is `lg`. Matches the capture page's screenshot-beside layout. |
| Does the model see the dataset's columns? | **No.** It reads the image only. | The brief: matching is deterministic code. It also means switching dataset re-matches with no model call, and a column list can never leak into the reading. |
| Is the screenshot stored? | No record, no migration. | The browser already holds the image; the reading lives in page state. Reload = drop it again. A stored "rebuild" record is a follow-up if people ask for history. |
| Geometry | The model gives each tile a box in percent of the image. App code groups boxes into **bands** (vertical overlap) and writes each band as plan **rows** (`kpis`, `charts`, `spotlight`, `annotated`, `note`). | The plan vocabulary has no x/y by design (`planRows.ts`); `planLayout.arrangeSheet` computes the grid. Three charts in one band become a two-up row and a one-up row — the closest the vocabulary says. |
| Chart types | The prompt lists Ordinate's ids; a small synonym table maps BI words (`horizontal bar`, `doughnut`, `crosstab`, `filled map`, `big number`…). Anything else → the tile says so and waits for a pick. | Never coerce silently (the `validatePlan` rule). |
| Per-tile verdict | Each tile is validated **alone** by `validatePlan` (a one-tile plan), so its reason is the validator's own sentence; then the whole plan is validated and previewed. | One validator, no second opinion. |
| Confidence | Name similarity 1 = *Exact*, ≥ 0.75 *Likely*, ≥ 0.5 *Guess*, below = unmapped. | Three words read faster than a percentage. |
| Assistant entry | A new action kind `rebuild` (whitelisted in `suggestedAction.ts`); the dock opens the page. | The dock has no image attachment; the page is where the drop zone is. |

## Server

- **`src/ai/rebuildRead.ts`** — `REBUILD_SYSTEM_PROMPT`, `readDashboardImage(dataUrl)`: one
  `dispatch` with the image (the captures path, `src/ai/analyze.ts`), `parseFirstObject`, then
  `sanitizeReading`. Pure `sanitizeReading(raw)` keeps only `{title, tool, tiles:[{id, kind, chart,
  title, box, dimension, measures[{field, aggregation}], series, filterKind, heading}]}` — closed
  vocabularies, lengths capped, at most 24 tiles and 4 measures, boxes clamped to 0–100. Any other
  field (a `value`, a `figure`, `data`) is not copied. `stripFigures(title)` removes currency,
  percent, separated and K/M/B-suffixed numbers; a bare year or "Top 10" stays.
- **`src/analysis/rebuildMatch.ts`** — pure. `scoreName(said, column)` (normalise case/separators/
  camelCase, light singular, a small synonym set, token overlap); `matchField(said, columns, role,
  aggregation)` → best compatible column + confidence, judged on the **declared** `ColumnType`
  (sum/avg/min/max need `number`; count takes any; a date range needs `date`).
- **`src/analysis/rebuildPlan.ts`** — pure. `rebuildTiles(reading, dataset, overrides)` → per tile
  the mapped fields and a raw plan item; `toPlan(tiles, reading)` → bands → rows → the plan envelope
  `validatePlan` accepts (`{name, rationale, calculatedFields: [], sheets: [{name, rows, controls}]}`).
  `checkTiles(tiles, ctx)` runs `validatePlan` per tile.
- **`src/ipc/rebuild.ts`** — `rebuild:read` (upload → PNG check → the read; `not_ready` without a
  model) and `rebuild:match` (load `PlanContext` for the one dataset → match → per-tile check →
  `previewPlan` → KPI figures through `computeCardMetric`). A Live dataset's figures go through the
  live doors; a typed refusal is kept per tile.
- **`src/api/rebuild.ts`** — `rebuild:read` (`read`, project-scoped, `{projectId, fileToken}`),
  `rebuild:match` (`read`, `{projectId, datasetId, reading, overrides}` — the reading re-sanitized on
  the way in, so a browser cannot smuggle a figure into it either).
- Sentences: `src/analysis/rebuildMessages.ts` through `t()`, added to `MAIN_FILES`.

## Web

- `web/src/features/analyses/rebuild/` — `RebuildPage.tsx` (route, states), `RebuildShot.tsx`
  (screenshot + numbered outlines), `RebuildTile.tsx` (one tile card), `api.ts`, `Rebuild.module.css`.
- `NewWizard.tsx` — the start card; `Dock.tsx` — the `rebuild` action.

## Tests

- `scripts/test-rebuild.ts` — the fake model reply fixture (`scripts/fixtures/rebuild/
  reading.json`) through `sanitizeReading` (planted figures never survive — negative control: the
  raw fixture DOES contain them); the matcher (exact, synonyms, type gates); bands → rows; the plan
  converts and passes `validatePlan` with nothing dropped; **sum over a text column is refused**
  (override and model both) and never built; a tile with an unknown chart type is held, not coerced;
  `rebuild:match` end to end on the sample project, with a spy proving no `getDataset` hydrate for a
  resident dataset's matching.
- Vitest `RebuildPage.test.tsx` — the check screen: tiles, confidence cues, dropdown change re-asks,
  drop/restore, not-ready.
- e2e `web/e2e/rebuild.e2e.ts` — stub model on loopback, upload, check screen, change a field, create,
  the dashboard opens; light + dark screenshots.

## Not in this change

- Several sheets (a screenshot is one page); calculated fields; reading a second screenshot into an
  existing dashboard; keeping a history of rebuilds; the dock accepting an image directly.
