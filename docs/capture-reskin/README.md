# Capture section layout fix + design catch-up

The **Capture** workspace (workspace section `sources`) and the **Analyses** list
had layout breakage that only surfaced once the right-side AI dock was open (or
dragged wide) and narrowed the main column. This change fixes the breakage and
brings the Capture empty state up to the same card generation as Home and
Dashboards. Presentation only — no capture flow, IPC, or overlay logic touched.

All screenshots below are from the **real app** driven under `xvfb` at
**1440×900**, light and dark, via a throwaway Playwright probe (deleted before
commit). Every measurement is `getBoundingClientRect()` off the laid-out page.

## The breakage (before)

Captured against the original code (working tree stashed) with a long title and
the shipped strapline, AI dock widened so the main column is squeezed:

| Symptom | Measurement | File |
| --- | --- | --- |
| Header title + strapline collapse to **one word per line** | strapline = **12 lines** tall at a 510px column | `before-header-broken-{light,dark}.png` |
| "New capture" clips past the panel edge on a very narrow column | (button overflowed `.main` at ~370px) | — |
| Analyses list overflows horizontally, **"Last updated" clipped** | row `scrollWidth − clientWidth = 168px`; template `220px 82px 190px 150px 56px` | `before-analyses-list-{light,dark}.png` |

## The fix (after)

Header is a proper wrapping row: the title flex-grows with a 160px floor and
truncates each line with an ellipsis; the actions are grouped in
`.main-top-actions` and wrap **below** the title (and their own buttons wrap
within that) instead of clipping. The empty state is framed as a card
(surface / border / `--r-lg` / `--shadow-sm`) with a lighter heading and
accent-tinted step chips. The Analyses grid tracks are sized to their real
content so the row never overflows.

Header, verified across AI-dock widths (main column width in parens):

| Dock | Main col | Title | Actions | "New capture" clipped | Card scrolls |
| --- | --- | --- | --- | --- | --- |
| default | 670px | 1 line, ellipsis | same row | no | no |
| wide (500px) | 510px | 1 line | **wrapped below** | no | no |
| very wide (640px) | 370px | 1 line, ellipsis | wrapped + buttons wrap | **no** | no |
| closed | 1010px | 1 line | same row | no | no |

Files: `after-capture-dockopen-{light,dark}.png` (default),
`after-capture-narrowcol-{light,dark}.png` (very narrow column, stressed text),
`after-capture-dockclosed-{light,dark}.png` (dock closed).

Analyses list — template now `minmax(150px,1fr) 60px 150px 116px 56px`, gap 10:

| Dock | Row overflow | Doc h-scroll | Name |
| --- | --- | --- | --- |
| default | **0px** | 0 | truncates with ellipsis |
| wide (560px) | **0px** | 0 | truncates with ellipsis |

Files: `after-analyses-list-{light,dark}.png`.

## Gates

- `npm run build:ts` — clean
- `npm run lint` — 0 findings
- `npm test` — 91/91 pass
- `npm run smoke` — the Capture-workspace and Analyses-list assertions pass
  (focus-mode collapse intact; the analyses header labels and row cells share a
  template and line up to the pixel: `cols == cells`). The only failing check is
  the pre-existing `net::ERR_TUNNEL_CONNECTION_FAILED` from the MapLibre tile
  fetch — the sandbox blocks the OSM tile host, unrelated to this change.
