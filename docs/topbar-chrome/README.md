# Top-bar chrome relayout — before / after

Real app (Electron under xvfb), 1440x900 **content** size, throwaway
`--user-data-dir`, splash waited out and removed, one seeded project + dataset so
Data has content in both builds. Before = `11939cb` (the merge base), after = this
branch, captured with the same harness minutes apart.

Home and Data in both themes are kept here because they are the two the PR argues
from; `after-search-open.png` is the third claim (the dropdown) which no static
section shot can show.

## What moved

| | before | after |
| --- | --- | --- |
| global search | sidebar, top of the nav column | top bar, centred on the window |
| "Ask AI" | sidebar bottom, above a 2-up row | top bar, right end |
| `#dk-edge` (2nd AI door) | floating tab at the window's right edge | **deleted** |
| `#exec-mode-btn` | sidebar bottom, icon-only | **deleted** (see "What this costs") |
| sidebar bottom | `Ask AI` · `#exec-mode-btn` · `Settings` | `Settings` |

## Measured, at 1440x900 (window centre = 720px)

Read off `getBoundingClientRect()` in the running app, not from the CSS.

| box | before | after |
| --- | --- | --- |
| `.hub-topbar` | *(absent)* | `0…1440`, y `40…88`, **h 48** |
| search box centre | **115px** (sidebar column) | **720px** — exactly window centre |
| search box width | 148px | 520px (the `flex: 0 1 520px` cap) |
| `#side-ai-btn` | y `820…852`, centre 105px | right edge **1428px** (12px bar padding), y `49…79` |
| `#dk-edge` | `1410…1440`, y `407…493` | *(element absent)* |
| `#exec-mode-btn` | `10…42`, y `856…888` | *(element absent)* |
| sidebar top | y 40 | y 88 (below the bar) |
| sidebar bottom buttons | `["Ask AI", "exec-mode-btn", "Settings"]` | `["Settings"]` |

**The centring is exact, not approximate.** `.hub-search-wrap` spans `460…980`,
so its centre is 720 — the window centre — because the two `.hub-topbar-side`
spacers carry equal `flex: 1 1 0` and the middle is capped rather than grown. The
`#global-search` *input* measures centre 731, 11px right of that: it sits inside
the pill after the magnifier icon and its 7px gap. The visible box is centred;
the input within it is inset, which is what the icon costs.

## The dropdown: two failure modes, both checked

Moving a results box out of a 176px-wide column and into a 48px-tall bar changes
its layout problem completely. In the sidebar it was an in-flow block that pushed
the nav down. In the bar that same block is clipped by the bar's own height, so
it is now `position: absolute; top: 100%` on a relative wrapper.

Two ways that goes wrong, and the second is invisible to a DOM-only assertion:

1. it lays out *inside* the bar and gets cut off, and
2. it paints *behind* the content stage or an open dock.

`scripts/smoke-dock.ts` asserts both against the running app — the second via
`document.elementFromPoint()` at the dropdown's own top-centre, which resolves to
whatever is actually painted there. `after-search-open.png` is the same state by
eye, with the dock deliberately left open.

`z-index: 9960` is picked, not rounded: below ~1100px `.dk-panel` stops being a
flex sibling and becomes a fixed overlay at `z-index: 9950` over a 9940 scrim, and
a 520px centred dropdown overlaps a 340px right-edge panel at that width.

### Anchor point — the one measurement that changed the CSS

First attempt hung the dropdown off `.hub-search-wrap`'s default (shrink-to-fit)
box. The wrapper was then 32px tall centred in a 48px bar, so `top: 100%` resolved
to **above the bar's bottom border** and the dropdown overlapped it. The smoke
assertion `r.top >= barRect.bottom` caught it — it was written to fail on exactly
that, and did, on the first run. Fix: the wrapper `align-self: stretch`es to the
full bar height and centres the input itself, so `top: 100%` is the bar's bottom.

Measured after: bar bottom `88`, wrapper `40…87`, dropdown top `91` — **3px
clear**. Not the 4px `margin-top`, because the bar's 48px includes its 1px bottom
border while the wrapper's stretched content box ends at 87; the margin is applied
from there. The pill's own centre measures `720`, i.e. the window centre exactly.

## Also changed, and why it was not optional

- **`.dk-panel`'s overlay offset, `top: 40px` → `88px`** (and its scrim). Below
  ~1100px the dock is `position: fixed` and was pinned below `.titlebar` only. With
  a second 48px strip in the chrome it would have covered the top bar — burying
  global search *and its own opener* under the panel they open.
- **`hubMenus.ts`'s `initExecButtonIcon()` guard, `!execBtn` →
  `!execBtns().length`.** This was the one consumer of `#exec-mode-btn` that did
  **not** already tolerate its absence: it gated on the *sidebar* button
  specifically, so deleting that button would have left the capture page's
  `#exec-mode-btn-cap` with no icon until the menu was opened by hand. Everything
  in `execMenu.ts` reaches both buttons through `execBtns()` / `execBtnVisible()`
  and needed no change, which is what keeps this a markup-only removal.

## What this costs

`#exec-mode-btn` was the only at-a-glance "AI not connected" / active-agent
indicator in the app chrome. Execution mode is still fully configurable at
**Settings → Execution** (`section.settings-pane[data-cat="exec"]`), and
`#exec-menu` still opens from `#exec-mode-btn-cap` on the capture page, so the
capability survives everywhere; the *glance* does not, outside capture.
`execMenu.ts` and the `#exec-menu` markup are untouched — a chrome relayout is the
wrong place to delete a ~500-line subsystem, and that call is left open.

## Why deleting `#dk-edge` is safe rather than merely tidy

The edge tab was not pure clutter — it had one case that genuinely needed it.
`body.an-focus` (an open analysis) hides the entire sidebar, and the dock is
explicitly **not** suppressed there, so while "Ask AI" lived in the sidebar the
tab was the only *mouse* way into the dock; removing it would have left ⌘L as a
single undiscoverable entry point.

Moving the button into the top bar is exactly what retires that case: the bar is
deliberately **not** hidden in `an-focus`. `smoke-dock.ts` asserts the whole chain
— sidebar hidden, top bar visible, button visible and enabled, click opens the
dock — inside a real open analysis.

`body.cap-focus` is the opposite case and needs no entry point: the bar is hidden
there, and `dkAllowed()` already returns `false`, so the dock is suppressed rather
than merely unreachable.

## Test coverage moved, not dropped

The `#dk-edge` block in `smoke-dock.ts` tested a closed→open→closed cycle and an
aria contract. The tab was only ever the vehicle; both are now asserted against
`#side-ai-btn`, plus a guard that `#dk-edge` is genuinely absent (`count() === 0`)
rather than merely hidden, and that exactly one control in the whole chrome
mentions "AI" — a stronger claim than the old sidebar-scoped one.

Two assertions **invert on purpose**, and the inversion is the feature: focus mode
used to assert `#side-ai-btn` was hidden and that the edge tab was the way back
in. Both are now the opposite.

One behaviour deliberately **changed**: `#dk-edge` hid itself while the dock was
open; `#side-ai-btn` stays visible and enabled and toggles. A header button that
vanished would leave a hole in the bar and reflow its neighbours, and staying is
what `aria-expanded` promises anyway. It also makes the Escape-restores-focus path
simpler — the old tab had to be un-hidden by `dkSync()` first, because a hidden
element silently refuses `focus()`.

New coverage that did not exist before: the search dropdown checks above, and
**⌘L is inert while the caret is in the search box**. That last one is newly
relevant because search and the AI button now sit inches apart in the same strip —
`dock.ts` bails on `INPUT`/`TEXTAREA`/`contenteditable` so the shortcut cannot
hijack typing, and this asserts it still does.

## Gates

`build:ts`, `lint` (oxlint, zero findings), `test` (89/89) and four of five smoke
suites pass clean. `smoke-app.js` reports its one known **environmental** failure:
MapLibre's OSM tile fetch is `net::ERR_TUNNEL_CONNECTION_FAILED` in the offline
sandbox. It is a network fetch from `maplibre-gl-csp.js`, reproduces independently
of this branch, and nothing here touches maps.
