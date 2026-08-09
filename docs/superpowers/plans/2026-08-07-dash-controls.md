# Dashboard controls — let the reader ask the dashboard questions

A published Ordinate dashboard is read-only in the strongest sense: `dashReadOnly` blocks
cross-filter and every mutation, so a reader can look but never narrow. Add **controls** — a
dropdown, a multi-select, a date range — as first-class cards an author places on the sheet, that
KEEP WORKING for readers on the published snapshot. The one architectural rule that makes this
safe: **a control's current selection is session-only view state, composed over the stored
filters at render time. It is never written to the dashboard record.** Authors persist a
control's *definition* (and optional default); readers change its *value*, which lives in
renderer memory and dies with the window.

## Global Constraints

Read `CLAUDE.md`. Verified facts this plan is built on:

- `Dashboard.filters: FilterStep[]` are dashboard-wide row filters merged ahead of every card's
  compute (`src/dashboardFilters.ts` is the node-tested rule; `dashboards.ts` mirrors it).
- `dataset:distinct` already returns paged, searched distinct values off Parquet with `total`
  (built for the filter-value picker) — controls get their options from it for free.
- `FILTER_OPS` includes `=`, `in`, `not in`, `>=`, `<=` — a dropdown, a multi-select and a date
  range are all expressible as `FilterStep`s TODAY. (Top-N is NOT expressible — see the cut list.)
- Publish copies card definitions BY VALUE; the frozen `card.visual` wins over `card.visualId`.
  Controls follow the same rule: the published control is the definition at publish time.
- Cards live in `Page.cards[]` with `{ id, type, layout }`; sanitizers whitelist every stored
  shape in `src/dashboards.ts`.

One worktree branch off `develop`, one commit per phase, `npm run build:ts && npm test && npm run
lint && npm run smoke` clean after each phase.

**Do not**: persist a reader's (or author's) control VALUE into the dashboard record — ever;
gate control interaction behind `dashReadOnly`; compute an option list in the renderer (options
come from `dataset:distinct`); widen the export whitelist beyond label/value strings; fork the
filter-merge rule (route through the one mirrored function); add a runtime dependency; use
inline `style=`; commit to `develop`; add a `Co-Authored-By` trailer.

## Task 1 — The model

`src/dashboards.ts` (+ its analysis twin if the card schema is shared — find where card
sanitizing lives and extend THAT, once):

A new card type `'control'`:

```ts
{
  id, type: 'control', layout,
  control: {
    kind: 'dropdown' | 'multi' | 'date_range',
    label: string,                  // shown above the control
    datasetId: string,              // where options come from (UUID-checked)
    column: string,                 // the column it filters
    default?:                       // optional author-set initial value
      | { value: string }           // dropdown
      | { values: string[] }        // multi
      | { from?: string; to?: string }, // date_range (ISO dates as stored text)
  }
}
```

`sanitizeCard` gains a whitelist branch for it (unknown `kind` → card dropped, same discipline
as everything else). Publish copies it verbatim — by value, like visuals.

A pure helper in `src/dashboardFilters.ts` — `controlSteps(control, state): FilterStep[]` —
turns one control + a current selection into 0..2 FilterSteps: dropdown → `=`; multi → `in`;
date_range → `>=` and/or `<=`. Empty/cleared selection → `[]` (an unset control filters
nothing). Node-test it directly: every kind, empty selection, single-ended range,
values containing quotes/commas/whitespace.

**Verify:** `npm run build:ts && npm test && npm run lint && npm run smoke`.

## Task 2 — Effective filters, one place

Today cards compute with `dashCurrent.filters` (merged via the mirrored merge rule). Introduce
ONE function in `dashboards.ts` — `effectiveFilters(): FilterStep[]` — returning
`stored dashboard filters + Σ controlSteps(card.control, controlState[card.id])`, and route
EVERY card compute and the drill-down's sheet-filter argument through it. `controlState` is a
module-level `Map<cardId, selection>` — renderer memory only, cleared when a dashboard opens.
That map is the entire "session-only" mechanism; there is deliberately no persistence, no IPC,
no schema for it.

Author defaults seed the map on open (both modes). Drill-down composing `effectiveFilters()`
means the drill panel's chips show what the reader actually filtered to — verify that chip list
includes control-derived steps.

**Verify:** `npm run build:ts && npm test && npm run lint && npm run smoke`.

## Task 3 — Rendering, for readers too

In `renderDashGrid`, a `control` card renders as a real control, NOT gated by `dashReadOnly` —
interaction is a read:

- **Label** above, in the card-title style. **Dropdown**: a native `<select>` filled from
  `dataset:distinct` (options load on first open; show `total` truncation as the picker already
  does). **Multi**: the existing checkbox-list popover pattern from the filter-value picker,
  with a `n selected` summary chip. **Date range**: two native `<input type="date">`.
- Any change updates `controlState` and re-renders the grid (the same debounce cross-filter
  uses). A subtle `Clear` affordance appears on the card when it has a non-default value.
- A `Reset controls` button appears in the dashboard header when any control differs from its
  default — one click back to the published view. Present mode keeps controls usable; that is
  the point of presenting.
- Read-only still means read-only for STRUCTURE: no drag, no resize, no delete on the card in a
  published dashboard — interaction is allowed, mutation is not. The card menu in read mode
  shows only `Clear`.

**Verify:** `npm run build:ts && npm test && npm run lint && npm run smoke`.

## Task 4 — Authoring

In the analysis workbench (and standalone dashboard editor — they share `#dash-editor`):

- `+ Control` beside `+ Visual` / `+ Metric` / `+ Text`, opening ONE dialog (the single-dialog
  pattern from the metric-builder rework): kind (three tiles), dataset, column (populated from
  meta; date columns first for date_range), label (auto-filled `Filter by <column>`), optional
  default. Live preview of the control itself in the dialog.
- Selecting a control card opens its properties (same auto-open behaviour as visual cards) to
  edit the same fields.
- Author-side, changing a control's VALUE also just updates `controlState` — an author testing a
  control must not be writing filters into the record either. Only the definition persists.

**Verify:** `npm run build:ts && npm test && npm run lint && npm run smoke`.

## Task 5 — Export and publish semantics

- Publish: controls come through by value; the published dashboard opens at defaults.
- `dashboardExport.sanitizeBundle` is a SECURITY control (whitelist to labels/numbers/strings/
  data:image). An exported offline bundle is a static snapshot: render it at the CURRENT
  control state, and include each control's label + current value as plain strings in the
  header area ("Region: West · Jan 1–Mar 31") so the reader of the file knows what they're
  looking at. Do NOT export live controls; do not widen the whitelist beyond those strings.

**Verify:** `npm run build:ts && npm test && npm run lint && npm run smoke`.

## Task 6 — Gates

- Node tests: `controlSteps` matrix; sanitizer round-trip (bad kind dropped, good card
  preserved through publish-by-value); effective-filter composition order (dashboard filters
  first, then controls — assert against the mirrored merge rule, not a copy of it).
- Smoke: open a published dashboard, change a dropdown control, assert a chart's rendered data
  changed AND the record file on disk did not (mtime/bytes) — that one assertion pins the
  entire "view state never writes" rule.
- Real-app walk: author adds all three kinds; publish; reader filters, resets, drills (chips
  show control filters), presents, exports; republish keeps controls.
- `CHANGELOG.md`; PR into `develop`; CI checks visible.

**Verify:** run the full gate list above. Treat any regression found here as a fix against the
task that introduced it.

## Cut, deliberately

- **Top-N control** — not expressible as a `FilterStep`; it needs a sort+limit concept in the
  aggregate path. New engine decision; propose separately with a design if wanted.
- **Control-to-visual scoping** ("this control only drives these cards") — ship global-first;
  scoping is additive later.
- **Cascading controls** (one control narrows another's options) — needs filtered-distinct;
  `dataset:distinct` doesn't take filters today. Later.
