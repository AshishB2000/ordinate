# AI-designed dashboards: ask first, arrange the page, interactive by default

**Date:** 2026-10-12

## What you will see when this is done

1. You ask the Assistant for a dashboard. **It asks first**:
   - *What kind?* Explore (filters, click a bar to filter the rest, more charts and a table) /
     Overview (a few big numbers and one main chart) / Report (charts with a note beside each).
   - *Which look?* The existing styles as swatches, preselected to the workspace default.
   - If the request is vague, up to three more questions about the content, written by the AI
     ("Change from 2025 to 2026 / Both years side by side / Just 2026").
   - "Skip — just build it" is always there. It asks once, never twice.
2. **The AI arranges the page** instead of always KPIs-on-top: a wide chart first, a big chart with
   numbers beside it, a chart with its note, KPIs or no KPIs. A small sketch of the arrangement
   shows before you click Create.
3. **Every generated dashboard is interactive**: it gets filters when the data has a good column
   for one, and the look you picked is applied. (Click-to-filter was already on for every new
   dashboard.)
4. People with no AI model get two more starter layouts, and the six templates stop looking identical.
5. **Maps work, and are right.** A dataset with state or country names gets a map offered in the
   visual builder and in Assistant drafts, and every region shows its own figure.

## Fix first — maps (PR A and PR B, before everything else)

Reproduced with the real functions on the columns of `US States Ranked by Population 2024.csv`.
Full state names are not the problem: all 50 resolve to the bundled shapes (`resolveGeoLevel` →
`us_state`, hit rate 1).

**Bug 1 — a map with no region level draws nothing.**
- `validatePlan` keeps a `map_choropleth` visual whose encoding has no `geo`. The facts offer both
  map types (`analysisPlan.ts:294`) but the prompt's encoding shape never mentions `geo` (`:338`).
- `buildVizData` only emits `data.geo` when `encoding.geo` is set (`vizData.ts:505`), and `MapView`
  then shows "Nothing to map" (`MapView.tsx:120`).
- The suggest-charts prompt already excludes maps for exactly this reason (`visuals.ts:377`); the
  dashboard draft never got the guard.
- In the visual builder the same gap shows as greyed-out map types: "Map regions" defaults to Off
  (`MapRegions.tsx:18`) and nothing detects that a column holds places. Only the template wizard
  does (`geoHitsFor`, `src/ipc/templates.ts:40`).

**Bug 2 — a region can show another region's figure.**
- `matchGeoItem` returns the first row that matches exactly *or by substring* (`geoMatch.ts:43`).
- With this file, in its own row order: the Kansas shape gets Arkansas's 3,089,060 and West
  Virginia gets Virginia's 8,752,297.
- With a row filtered out, the neighbour's figure lands on the empty shape. Nigeria gets Niger's.
- It is pinned as a known divergence (`web/src/charts/maps/geo.test.ts:180`, "kept for parity")
  and recorded in `web/src/charts/maps/__golden__/geo.json`.

### PR A — a region only ever shows its own figure

- **`src/analysis/geoMatch.ts`** and **`web/src/charts/maps/geoMatch.ts`** (held equal by
  `geo.test.ts`): an exact match across all rows wins first; a substring match is allowed only for
  a row whose normalized name is not itself a shape in the collection. New optional third argument:
  the collection's normalized feature-name set, with a `featureNameSet(features)` helper beside it.
  "United States" still matches "United States of America"; Arkansas can no longer stand in for Kansas.
- Callers build the set once per collection: `web/src/charts/maps/features.ts:68`,
  `geometry.ts:124`, `thumb.ts:42`, and `src/publish/site/publishClient.ts:240` (inlined by
  `src/publish/siteHtml.ts:182`).
- Tests: `scripts/test-geo-match.ts` gains each reproduced case (this file's row order, a missing
  row, Niger / Nigeria, the United States variant); flip the pinned assertion at `geo.test.ts:181`.
- **Golden, needs your approval:** `__golden__/geo.json` holds West Virginia painted from
  Virginia's row. Amend only the entries this fix changes and list each one in the PR. This is a
  deliberate exception to "never re-record a golden": the golden records a wrong figure.

### PR B — a map always knows its regions

- **New `src/analysis/geoHits.ts`** — `geoHitsFor` moved from `src/ipc/templates.ts`;
  `loadPlanContext` fills `PlanDataset.geoHits` (one `LIMIT 200` sample per dataset, as the
  template wizard already does).
- **`validateVisual`** (`analysisPlan.ts:646`) — a map type with no `encoding.geo` gets
  `{level}` from `geoHits[category]`; a column that is not places → dropped with a message, never
  coerced to another chart.
- **New `src/analysis/planFacts.ts`** — `buildFactsText` moves here now (it frees ~80 lines in
  `analysisPlan.ts`, which is at 752 of 800). A places column's line says so
  ("— places: US states"); the prompt allows a map only on such a column.
- **Visual builder** — the `visual:data` reply gains `geoSuggest` when the encoding has no `geo`
  and its labels resolve (`resolveGeoLevel(labels)`; the labels are already computed, so no extra
  query). `builderState.ts:98` counts it as mappable, so the map chips are offered; choosing one
  sets `encoding.geo` through `geoFor` (`MapRegions.tsx:35`). A saved map with no level gets it the
  same way when opened.
- Tests: `test-analysisPlan.ts` (a map is kept with its level; a non-place column is dropped; the
  facts line), Vitest for the builder (chips enabled, picking one sets `geo`), and the visuals
  builder e2e with a states fixture.

## Context

- Sameness comes from one packer (`src/analysis/planBuild.ts:143-172`) that every path funnels into.
  The grid is a free 12-column grid; the plan vocabulary just cannot say where anything goes.
- The draft prompt tells the model to guess (`analysisPlan.ts:302`).
- Filters already exist and AI drafts never add one: filter controls are validated
  (`src/analysis/planControls.ts`) but the prompt never mentions them, and `buildPlan` saves no
  style (only `planExec.ts:222` does). Click-to-filter is already on for every new dashboard
  (`saveAnalysis`, `src/analysis/analysis.ts:268`).

Decisions made in this conversation:

- **The AI decides the layout** by writing each sheet as an ordered stack of rows from a closed
  set of row types. **The app still computes every x/y/w/h** (the stance at `planBuild.ts:46-54`):
  nothing checks tile overlap, and the app runs on whatever model an org brings.
- **Ask first**, including about the kind of dashboard and its look.
- "AI skills per stage" becomes richer facts for the draft prompt. No context tracker here.

## Row vocabulary

```
kpis        [K][K][K][K]          3×2 each, wraps at four (today's strip)
charts      [     C     ]         one visual 12×6, or two at 6×6
spotlight   [   C    ][K]         visual 8 wide + 2–4 KPIs stacked in a 4-wide rail (a fourth makes the row 8 tall)
annotated   [   C    ][note]      visual 8×6 + text 4×6
note        [   note    ]         text 12×2
```

Every band starts on a fresh row at x=0. No chart is narrower than 6, so `isBigChart`
(`reportSpec.ts:250`) and the per-chart report pages keep working. Tablet and phone derive from
kind and reading order (`sizeLayout.ts:100`), so they need nothing.

## PR 1 — the AI arranges the page and adds interactivity (server only)

Flat plans (`{metrics, visuals, texts}`) must produce byte-identical geometry: the sample
dashboard, `planExec.runDashboard` and `test-analysisPlan.ts:555` depend on it.

- **New `src/analysis/planRows.ts`** — the row vocabulary: `PlanRow` union, `ROW_TYPES`,
  `validateRows(raw, {visual, metric, text}, dropped)` and `ROWS_PROMPT` (the prompt clause lives
  beside its parser, as `analysisPlan.ts:311-319` requires). Items are validated through callbacks
  to the existing `validateVisual` / `validateMetric` / `validateText`. Rules:
  - unknown `type` → dropped and reported (new `PlanDropKind` `'row'`);
  - `charts` with more than two visuals → split into consecutive rows;
  - `spotlight` with one metric → a `kpis` row then a `charts` row; more than three → first three
    in the rail, the rest in a following `kpis` row;
  - at most 12 rows per sheet; rows that validate to nothing → the sheet's flat arrays are used.
- **`src/analysis/analysisPlan.ts`** (752 lines — additions limited to the hook):
  `PlanSheet.rows?: PlanRow[]`. When present it is the source of truth and `metrics` / `visuals` /
  `texts` are its flattening in row order, so `planPreview`, stories and the web review keep
  reading the flat arrays. `validatePlan` must accept its own output (the plan round-trips through
  the browser to `analysis:buildPlan`). The prompt gains:
  - `rows`, via `ROWS_PROMPT`, with when-to-use guidance per row type;
  - **`controls`** (`dropdown | multi | date_range` — already validated, never described): add one
    to three when a column has few distinct values or the data has a date;
  - chart variety: share of a whole → donut, against a target → bullet or gauge, ranking → bar,
    over time → line or area, detail → table; no repeating one type down a sheet without a reason.
- **New `src/analysis/planLayout.ts`** — the geometry of a plan sheet: the existing `packer()` and
  constants moved out of `planBuild.ts`, plus `arrangeSheet(sheet)`. No `rows` → today's path.
- **`src/analysis/planBuild.ts`** — save visuals first, then `arrangeSheet` over what survived.
- **`src/analysis/planPreview.ts`** — each previewed sheet gains `layout: {kind, x, y, w, h}[]`.
- **`src/ipc/analyses.ts` `withInsightCharts`** — with `rows`, append insight charts as `charts` rows.
- **New `scripts/test-planRows.ts`**:
  - property test over random row stacks: no two tiles overlap, every `x + w ≤ 12`, every band
    except `kpis` is flush to 12 — with a negative control (a hand-made overlap must fail);
  - idempotence: `validatePlan(validatePlan(x).plan)` is deep-equal;
  - each degenerate rule above;
  - drift guard: every `ROW_TYPES` id and every control kind appears in the prompt.

## PR 2 — starters, templates and the review sketch

- **`src/analysis/starterPlan.ts`** — `StarterKind` gains `'spotlight'` and `'lead'`; same content
  picks as `'kpis'`; a small `shapeRows(shape, sheet)` turns the flat lists into rows.
- **`src/analysis/templates.ts`** — two more `starter(...)` entries; `Draft.plan()` takes an
  optional shape. Sales and Inventory lead with their first chart, Marketing and Customer use
  spotlight, Finance and Operations keep the strip. Update the count assertion in `test-templates.ts`.
- **`src/api/analyses.ts:115`** and **`src/ipc/analyses.ts:148`** — widen the starter kind.
- **`web/src/features/analyses/NewWizard.tsx`** — two `STARTS` entries (`lead` reuses the art
  tokens as `['wide', 'strip']`; `spotlight` needs one new token in `Wizard.module.css`);
  generalise the `kind === 'kpis' || kind === 'twoup'` test in `createFrom`.
- **`web/src/features/analyses/editor/EmptySheet.tsx`** — two more starter buttons.
- **`web/src/features/analyses/DraftReview.tsx`** — a small sketch per sheet drawn from
  `sheet.layout` (12-column CSS grid, the inline `gridColumn` / `gridRow` technique of
  `editor/Canvas.tsx`).

## PR 3 — ask first: kind, look, then the AI's own questions

- **New `src/analysis/planClarify.ts`**:
  - `DASHBOARD_KINDS` = `explore | overview | report`, each with an app-written sentence that goes
    into the facts block (explore: filters, a detail table, more charts; overview: one `spotlight`
    or lead chart and few tiles; report: `annotated` rows and notes);
  - `CLARIFY_PROMPT`, `validateQuestions(raw)` (at most 3 questions, 2–4 options, lengths capped);
  - `answersText(answers)` — a fenced block labelled a request, like the intent at `analysisPlan.ts:300`.
- **`src/ai/analyze.ts:751`** — `draftDashboard(inventoryText, system = DRAFT_DASHBOARD_SYSTEM_PROMPT)`,
  edited in place. The file is allowlisted at exactly 854 lines and must not grow.
- **`src/ipc/analyses.ts` `draftAnalysisPlan`** — new opts `kind`, `clarify`, `answers`. The clarify
  clause is appended only when `clarify === true` and `answers` is undefined, so **one round is
  guaranteed by construction**. Valid questions → `{ok: true, questions}`; a `questions` reply with
  none valid → one plan-only call. `story:draft` and `planExec` pass none of these.
- **`src/analysis/planBuild.ts` `buildPlan`** — takes an optional style preset id, checked against
  `DASHBOARD_STYLE_PRESETS` (as `planCheck.ts:263` does); absent → the workspace default, the way
  `planExec.ts:222` already does. The look never goes to the model.
- **`src/api/analyses.ts`** — `analysis:draft` input gains `kind`, `clarify`, `answers` (max 3,
  strings ≤ 200); `analysis:buildPlan` gains `style` (the preset enum).
- **Web**, `DraftFlow` owns every draft ask:
  - new `web/src/features/analyses/DraftBrief.tsx` — the kind and look pickers. Rendered instantly
    with no model call, as `DraftFlow`'s first screen, and inside the wizard's AI step under the
    intent box (`NewWizard.tsx:381`), in which case `DraftFlow` skips its own;
  - new `web/src/features/analyses/DraftClarify.tsx` — the AI's questions, "Continue" and
    "Skip — just build it" (sends `answers: []`);
  - `NewWizard.runDraft` stops calling the RPC itself and opens `DraftFlow`; the unused `draft`
    prop is deleted. `Dock.tsx` is untouched — it already opens `DraftFlow`;
  - `DraftReply` in `web/src/features/analyses/api.ts` gains the questions variant.
- Tests: `scripts/test-analysisPlan.ts` drives `draftAnalysisPlan` with a stubbed model reply for
  ask → answer → plan, for skip, and for each kind's sentence reaching the facts; a built plan
  carries the chosen style; Vitest for `DraftFlow`; update the payload assertion
  at `assistant.test.tsx:403`.

## PR 4 — richer facts for the draft

- **`src/analysis/planFacts.ts`** (created in PR B) — `buildFactsText` takes optional extras: the
  user's column notes through the existing `columnNoteLines` (`src/ai/copilotFacts.ts:137`), and
  defined metrics as name + definition **without their value**.
- **`src/ipc/analyses.ts`** — load them where `src/ipc/copilot.ts:140,246` already does.
- Test: the facts block carries the notes; a planted metric value never appears in it.
- Relationships are left out: a plan visual addresses one dataset.

## Next plan, not this one — the tiles and the look

The reference image needs things the app cannot draw yet, whoever designs the page:

- a sparkline inside a KPI tile, and a coloured "hero" tile;
- a softer look (large radius, soft shadows, tinted cards) as a new built-in style;
- KPI change chips on generated dashboards — the chip exists (`MetricCard.tsx:111`) but needs a
  date range in scope, so the plan must also give its date filter a default period.

These touch the card model, the editor, published pages and the export whitelist
(`sanitizeBundle`, a security control), so they get their own design, with mockups.

## Verification

- Per PR: `npm run build:ts`, then the touched suites directly —
  `node --test scripts/test-planRows.js scripts/test-analysisPlan.js scripts/test-starterPlan.js scripts/test-templates.js scripts/test-reportSpec.js scripts/test-sampleProject.js scripts/test-file-size.js scripts/test-i18n.js`
  — plus `npm run lint` and `npm run test:web`. Full smoke runs in CI.
- PR A and PR B: add `scripts/test-geo-match.js` to the list. Then with the attached CSV on a
  local server: Visuals → `US State` by `Population 2024` → the map chip is offered → all 50 states
  are filled, Kansas reads 2,944,376 and West Virginia 1,766,107. An Assistant draft on the same
  dataset gives a filled map tile or a dropped one with its reason, never "Nothing to map".
- PR 2 and PR 3: run the wizard and editor e2e and look at the light and dark screenshots in
  `web/e2e/__screens__/`; `npm --prefix web run size`.
- End to end, if a model is configured locally: `npm run server`, ask for "a dashboard" on the
  population data → pick Explore and a look → answer the AI's question → the review shows the
  sketch → create → filters are in the bar, clicking a bar filters the other tiles, no tiles
  overlap, the published page and a PDF report still render every chart.

## Not planned

- "Change this" on the review dialog (refining a draft) — after PR 3.
- Applying an arrangement to an existing sheet from the editor.
- Wiring the already-written "save a dashboard as a template" (`src/analysis/userTemplate*.ts`).
- A three-up chart row — needs `isBigChart` changed first.
- "What the Assistant can see" panel, and capping the dock chat's full-thread replay
  (`src/ipc/copilot.ts:507`).
