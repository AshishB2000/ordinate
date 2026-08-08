# The visual builder becomes a workbench — chart as the hero, controls at the side

The Visuals builder (`#viz-builder`) is one vertical stack in a grey `--surface-2` box: dataset
row → encoding rows → warnings → chart-type chips → chart → Save. The chart, which is the whole
point, is the last and smallest thing on the page. Restructure it into the two-pane workbench
shape the app already uses (the Data section's Prepare tab: machinery in a side column, live
output beside it): **controls in a fixed-width left panel, the chart filling everything else.**

This is a layout + styling change. The builder's behaviour — `createEncodingForm`, `recomputeVisual`,
`buildVizPicker`, `renderVizViaEntry`, override persistence, save/back — does not change.

## Global Constraints

Constraints from `CLAUDE.md`: strict hub CSP (no inline `style=`; classes in `hub.css`, tokens
from `theme.css`); classic global-scope renderer scripts; every element id stays (visuals.ts and
encodingForm.ts drive this by `getElementById` and the `js-enc-*` class hooks — keep BOTH).
`#viz-encoding-tpl` is cloned by `createEncodingForm` and a second copy mounts in the analysis
authoring panel — so any template change must look right in BOTH hosts; check the authoring
flyout after every phase.

One worktree branch off `develop`, one commit per phase, `npm run build:ts && npm test && npm run
lint && npm run smoke` after each phase.

**Do not**: rename any element id or `js-enc-*` hook; change `createEncodingForm`'s API or the
encoding it emits; touch `renderVizInArea` / `chartControls` behaviour; move markup out of the
template (both hosts clone it); add a dependency; use inline `style=`; commit to `develop`; add a
`Co-Authored-By` trailer.

## Task 1 — The frame

`#viz-builder` becomes a three-region grid filling the panel height:

```
┌──────────────────────────────────────────────────┐
│ header: ← Back · [name] · dataset · ✨ · Save    │
├──────────┬───────────────────────────────────────┤
│ controls │  chart-type chips (#viz-switcher-mount)│
│ (left,   │  ┌─────────────────────────────────┐  │
│  300px,  │  │                                 │  │
│  its own │  │   #viz-area — fills the stage   │  │
│  scroll) │  │                                 │  │
│          │  └─────────────────────────────────┘  │
└──────────┴───────────────────────────────────────┘
```

- **Header** (one row, `--surface`, hairline bottom border): `#viz-cancel-btn` as `← Back`, the
  visual's name (the saved name, or `New visual` — plain text now, renaming still happens on
  save), a spacer, `#viz-dataset-select`, `#viz-suggest-btn`, `#viz-save-btn`. All existing ids,
  just moved.
- **Left panel** (~300px, `--surface`, hairline right border, own `overflow-y: auto`):
  `#viz-encoding-mount` and `#viz-warnings`. Do not wrap it in new ids — a class is enough.
- **Stage** (`--bg`, generous padding): `#viz-switcher-mount` on top, then `#viz-area` with
  `flex: 1` so the chart gets ALL remaining height — charts currently render at whatever height
  the squeezed area allowed; verify Chart.js resizes to the taller area (it is responsive; the
  container just finally has a real size). The `⋯` control cluster stays where `renderVizInArea`
  puts it.
- Height: the builder fills the workspace panel (same approach the Data explorer took in #84);
  the page itself does not scroll — the left panel and the stage scroll independently.

**Verify:** `npm run build:ts && npm test && npm run lint && npm run smoke`. Manually confirm (via
`npm start`, or note if the sandbox cannot launch Electron) that opening the Visuals builder shows
the new three-region layout, and every existing id is still present in the DOM (`#viz-cancel-btn`,
`#viz-dataset-select`, `#viz-suggest-btn`, `#viz-save-btn`, `#viz-encoding-mount`, `#viz-warnings`,
`#viz-switcher-mount`, `#viz-area`).

## Task 2 — The controls read as a form, not a pile of rows

Restyle `#viz-encoding-tpl` for a vertical panel (remember: both hosts — the standalone Visuals
builder AND the analysis authoring Build tab clone the same template):

- Each `data-well` block becomes label-ABOVE-field: an 11px uppercase `--text-dim` label
  (`Category`, `Measures`, `Split by`, `Map regions`, `Filters`), full-width control under it,
  14-16px vertical gap between blocks. Kill the `min-width: 92px` side-label layout — it's what
  makes the current form ragged.
- `.viz-select` goes full-width of the panel (drop `max-width: 240px`), consistent 8px padding,
  `--r-md`.
- Measure rows: the value select + agg select + delete button on one line, gap 6px, delete as a
  quiet 26px icon button that only colors on hover (`--error` tint). `+ Add measure` /
  `＋ Add filter` become ghost buttons, full-width, dashed `--border-2` border — they read as
  "slots", not actions.
- Filters render likewise as compact rows; when empty, the block shows just the ghost add button.
- A hairline separator between the encoding blocks and the Filters block — encoding says WHAT,
  filters say WHICH ROWS; the seam should be visible.
- `#viz-warnings` restyles as a `--warn-soft` panel note pinned at the bottom of the controls,
  not a bare text run.

**Do not** rename any element id or `js-enc-*` hook, change `createEncodingForm`'s API or the
encoding it emits, or move markup out of the template.

**Verify:** `npm run build:ts && npm test && npm run lint && npm run smoke`. Manually confirm the
encoding form renders correctly in BOTH the standalone Visuals builder and the analysis authoring
Build tab flyout (`#an-tabp-build`) — same template, two hosts.

## Task 3 — The stage and the chips

- `#viz-area`'s chart card: `--surface`, `--r-lg`, hairline border, comfortable inner padding —
  the chart sits on a card on the stage, matching how dashboard cards frame charts. The
  fallback message (`Pick a category…`) centres on the card in `--muted`, with a small
  `VIZ_ICONS` glyph above it.
- The chip row (`buildVizPicker`'s switcher): give the active chip a solid `--accent` fill
  (`--accent-ink` icon), inactive chips `--surface` with hairline borders; `+ More` unchanged.
  This is CSS on existing classes — do not touch renderResult.ts markup unless a class is missing,
  and if you must add one, add a class, not a structure change.
- Loading: `recomputeVisual` is fast (resident path) but on big tables there's a visible gap —
  during the await, drop the area's opacity slightly (a class toggle; respect
  `prefers-reduced-motion` by skipping any transition). No spinners for a ~100 ms path.

**Verify:** `npm run build:ts && npm test && npm run lint && npm run smoke`. Manually confirm chip
switching (active vs inactive styling), the fallback empty state, and — if feasible in the
sandbox — the loading-opacity toggle on a large dataset.

## Task 4 — Same treatment where the builder is embedded

The analysis authoring Build tab mounts the same encoding template. Verify the Task-2 styles
work inside `#an-tabp-build`'s narrower column (they should — it's a vertical panel already);
add scoped overrides ONLY if something genuinely breaks. Then check the create-popup's AI option
mini-charts still render correctly against the restyled area classes.

**Verify:** `npm run build:ts && npm test && npm run lint && npm run smoke`. Manually walk: new
visual from the popup (including the AI option's mini-charts), the analysis authoring Build tab,
and confirm nothing regressed visually or functionally in either host.

## Task 5 — Gates

- `npm run smoke` passes (renderer console errors fail it — that's the CSP tripwire).
- Real-app walk: new visual from the popup, dataset with a map-eligible column (chips + map),
  multi-measure, a filter, save, reopen, `⋯ Customize`, drill a bar, export — every one of those
  attaches to `#viz-area` or the switcher and must survive the new frame.
- Narrow window: the left panel keeps its width, the stage shrinks, nothing scrolls horizontally;
  below ~900px the panel may stack above the stage.
- `CHANGELOG.md` updated, PR into `develop`, CI checks visible.

**Verify:** run the full gate list above. This task is the final acceptance pass across everything
Tasks 1-4 built — treat any regression found here as a fix against the task that introduced it.
