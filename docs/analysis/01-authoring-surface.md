# The authoring surface

Phase A ([`00-model.md`](00-model.md)) split **analysis** (mutable, owns sheets) from
**dashboard** (a published snapshot). It said nothing about what authoring an analysis
should *look* like, and the answer it inherited was: a grid of cards, with the visual
editor living in an entirely different section of the app.

This document specifies the QuickSight-style authoring surface that replaces it, and
records what was deliberately not built.

## The finding that shapes everything

**Ordinate's editor and QuickSight's are different models.**

- Ordinate's `#dash-editor` is a 12-column grid of *cards*. You place a card; editing the
  visual inside it happens in `#ws-visuals`, a separate top-level section, on a separate
  record.
- QuickSight's is a single-visual IDE. You select a visual and every panel on screen binds
  to it.

The bridge between them is **selection**: click a card on the sheet, and the field wells
and properties panels edit that card. Nothing about the Page/Card model changes, so
publishing, cross-visual filters, drag/resize and the Phase B–E snapshot design all keep
working exactly as they do today.

**Rejected:** one visual per sheet, the literal QuickSight model. It matches the
screenshots most closely and it would re-found the data model — `Page`, `Card`,
`dashboardFilters` and every published snapshot assume many cards per page. The cost is
a rewrite of Phases B through E; the benefit is a layout preference.

## The encoding UI already exists

The wells are not new functionality. `visuals.ts` already has category / measures +
aggregation / series / geo / filters / chart-type picker, driving `recomputeVisual()` →
`computeVisualData` → `renderVizInArea`. It is *hard-wired to `#viz-encoding` element ids*,
which is the only reason it cannot be shown anywhere else.

So the work is an extraction, not an implementation. That ordering matters enough to be a
phase of its own (**B** below): if C is written before B, the new panel becomes a second
encoding engine, and the two drift.

## Phases

Each is one PR, in order. B ships nothing visible and C depends on it.

### A — The create wizard learns a starting layout

Today: `1 Choose data → 2 Build with AI (optional)`.
After: `1 Choose data → 2 Start from → 3 Describe it (only when AI is chosen)`.

Step 2 offers four picture-cards:

| Card | What it does |
|------|--------------|
| Blank | One empty sheet (today's behaviour) |
| KPIs + chart | The existing `.dash-starters` scaffold |
| Two-up | The existing `.dash-starters` scaffold |
| ✨ Let AI design it | Reveals step 3, the prompt box built in PR #47 |

**Layout and AI are ONE step, not two.** Asking for a starting layout and then throwing it
away because the model defined its own sheets is a dialog that lies about what it does.

**Not built:** QuickSight's *Interactive sheet vs Pixel-Perfect report*, *Layout: Tiled*,
and *Optimize for viewing on: 1600px*. Ordinate has one layout (the 12-column grid), no
paginated-report builder, and no fixed-width canvas. Implementing the pickers without the
features behind them ships three controls that change nothing.

### B — Host-agnostic encoding builder

Extract the encoding form from `visuals.ts` into a builder taking `(hostEl, state,
onChange)`. `#ws-visuals` becomes its first caller with **identical** behaviour; the
authoring panel in C becomes its second.

The acceptance test for B is that nothing changed: the existing Visuals section must
build, preview and save a visual exactly as before.

### C — The three-pane surface

```
┌──────────────┬────────────────────────┬─────────────┐
│ DATA         │                        │ PROPERTIES  │
│ fields ▸     │      sheet grid        │ (selected   │
│ + Calc field │      (12-col cards)    │  card)      │
├──────────────┤                        │             │
│ VISUALS      │   Sheet 1  Sheet 2  +  │             │
│ ✨ Suggest    │                        │             │
│ chart types  │                        │             │
│ ROWS/VALUES  │                        │             │
└──────────────┴────────────────────────┴─────────────┘
```

- **Selection binds the panels.** A selected card drives the wells and the properties
  panel. No selection shows sheet-level settings.
- **Panels collapse** to a thin icon rail; state in `localStorage`. The sheet grid is never
  hidden.
- **Fields reach wells by drag AND by click.** HTML5 DnD for the QuickSight feel; click-to-add
  as the keyboard path, because a drag-only well is unreachable without a mouse.

### D — AI in the Visuals panel

- `✨ Suggest a visual` → the existing `suggestVisual` call, filling the wells and chart
  type, editable afterwards. Returns `notReady` with no model, like every other AI action.
- The chart-type grid keeps its **Recommended** marks, which are app-computed
  shape-eligibility (`SHAPE_CHARTS`), not a model.

These are two mechanisms and they get two labels. The app's own shape logic must never be
presented as a model's recommendation, and the grid must keep working with no model
configured.

## Invariants this surface must not break

1. **A published dashboard is read-only.** The editor is a single `#dash-editor` re-parented
   between `#an-editor-host` and `#dash-editor-host`. The authoring panels must not render
   in dashboard mode at all — a panel that can mutate a card, plus the 600 ms autosave
   debounce, clobbers a snapshot.
2. **The app does the math.** Wells and properties change *structure*; every figure still
   comes from `computeVisualData` / `computeMetric`.
3. **CSP.** No inline `style=` in hub HTML. Drag indicators are classes.
4. **One encoding engine.** After B there is exactly one; C must not grow a second.

## How it is verified

`npm test` covers anything that reaches main. It cannot see any of this — the surface is
renderer-only, and a panel that renders at zero height, a well that never accepts a drop,
or a CSP-blocked drag indicator all pass every assertion made outside a running window.

**`npm run smoke` is the gate**, and each phase adds to it:

- A — step 2 paints its four cards; each starter produces the card count it promises.
- B — the existing Visuals section still builds and saves a visual (regression only).
- C — panels render at a real size; clicking a card binds the wells to it; a real
  `dragstart → dragover → drop` sequence moves a field into a well and the chart
  recomputes; collapse and restore survive a reload; **dashboard mode renders zero
  authoring panels**.
- D — the ✨ button fills the wells; with no model it is disabled and says why, while the
  Recommended marks are still present.
