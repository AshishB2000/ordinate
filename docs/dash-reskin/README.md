# Dashboards reskin — before / after

Screenshots of the REAL app (Electron under xvfb) at 1440×900, on a throwaway
`--user-data-dir`, splash waited out and removed. Both the populated and empty
states seed through the real main-process modules (projects / datasets / visuals
/ dashboards / analysis + `analysis:publish`), so every card's meta line is
computed from real records — e.g. `1 page · 2 tiles · published 10:28 PM`.

This is a **visual reskin only**. Grid mechanics, the publish/republish flow,
controls, filters, export internals and the analysis editor's behaviour are all
unchanged (guarded by `npm run smoke` — smoke-app drives this surface end to
end, including the "view state never writes" mtime invariant on both sides).

| state | before | after |
| --- | --- | --- |
| list, populated | `before-list-light.png` / `-dark` | `after-list-light.png` / `-dark` |
| list, empty | `before-empty-light.png` / `-dark` | `after-empty-light.png` / `-dark` |
| editor (chart + metric tile) | `before-editor-light.png` / `-dark` | `after-editor-light.png` / `-dark` |
| Analyses list (must be unchanged) | `before-analyses-list-light.png` | `after-analyses-list-light.png` |

## What changed

- **List → card grid.** A flat stacked list became a responsive
  `auto-fill, minmax(240px, 1fr)` card grid: name (600, heading tier), a
  `pages · tiles · updated` meta computed from the summary (`cardCount` is a free
  sum), the **Published · read-only** state as a quiet pill, hover border-accent +
  lift. Rename/delete moved into hover-revealed icons instead of a permanent
  button beside every row. Header sub-copy shortened to one line (the lecture is
  now a `title` tooltip).
- **Empty state** is the designed `makeEmptyState()` card (the same glyph + title
  + line + action Home uses), delegating to the existing `#dash-new-btn` handler
  — not a bare `<p>No dashboards yet.</p>`.
- **Editor chrome → three zones** (identity · add · commit) with the add group as
  a segmented pill. Every button id and handler is unchanged; this is CSS +
  markup grouping.
- **Tiles**: radius 8 → 12px, a roomier (7px) and quieter (transparent) card head
  so the chart is the loudest thing on the tile.

## The shared-class trap, and how it was avoided

`.dash-list-item`, `.dash-list-open`, `.dash-list-name` and `.dash-list-badge`
are **shared** with the Analyses list, which re-scopes them into a CSS-grid table
under `#ws-analyses`. **Route chosen: scope every new list rule under
`#ws-dashboards`** (option a in the brief) rather than restyling the bare shared
classes or renaming them — because smoke-app queries `#dash-list .dash-list-item`,
`.dash-list-open` and `.dash-list-badge` by those exact names, so the class hooks
must stay. The bare rules are left as the Analyses base; nothing under
`#ws-analyses` was touched.

**Proof the Analyses list is unchanged** (measured in the same probe, not just
eyeballed): its `#an-list .dash-list-item` computes to `display: grid;
grid-template-columns: 262px 82px 190px 150px 56px` with the name button at
`border: 0`, transparent background, `flex-direction: row` — identical to
develop. The screenshot pair above is the visual confirmation.

## The editor header, and why the analysis workbench is byte-identical

The same `.dash-editor-head` markup serves the published/standalone dashboard
editor **and** the analysis workbench in focus mode, so it must not be forked.
The three zones are real flex groups in the dashboard editor, but collapse to
`display: contents` under `body.an-focus` — so the analysis header's buttons
participate in its carefully-tuned single-row flex layout exactly as before, and
a second spacer used only for centring the dashboard editor's add group is hidden
in focus mode. The identity items (incl. **Back**) stay flat direct children of
the head because smoke-app reads `.dash-editor-head`'s direct children to find the
Back control. Measured: in focus mode the header stays **one row at 47px with
zero horizontal overflow** (smoke-app + smoke-dock both assert this), the zones
compute to `display: contents`, and Publish/Save/Back are all present.

## Reproducing

There is no committed harness — this is a one-off design record, not a test.
`npm run smoke` is what guards the behaviour. The seeds and measurements were
produced by a throwaway probe (not committed) that mirrors smoke-app's seeding.
