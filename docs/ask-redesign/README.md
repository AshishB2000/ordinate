# Ask redesign — before / after

Real app (Electron under xvfb), 1440x900 **content** size, throwaway
`--user-data-dir`, splash waited out and removed. Before = `cf48d8d` (the
topbar-chrome merge, this PR's base), after = this branch, same harness minutes
apart. Both themes, and both STATES — the hero (a project with data, no
conversation) and the transcript (a seeded exchange), because `.xp-asked` is one
markup tree flipping between them and a redesign can break either half alone.

## Measured, at 1440x900

Read off the running app (`getBoundingClientRect`/`getComputedStyle`), not the CSS.

| | before | after |
| --- | --- | --- |
| nav label | `Explore` | `Ask` (data-section stays `explore`) |
| greeting | `What do you want to know?` (static) | `Good evening, Root` (time-of-day + `app:userName`) |
| sub-line | *(absent)* | present, the Home hero's sentence verbatim |
| brand mark | *(absent)* | 40×40, centred at 825px |
| composer | 720px wide, centre 825 | **640px**, centre 825 — same centre, tighter card |
| starter chips | *(absent)* | 3, from real dataset names |
| stage `background-size` | `auto, auto, auto, auto` | `auto, auto, auto, 22px 22px, auto` — the lattice layer |
| renderer errors | none | none |

825px is the stage centre, not the window centre — the stage starts after the
210px sidebar, and (210 + 1440) / 2 = 825. The mark, greeting and card all sit
on it.

The chips in the shot are `What stands out in Ad spend?`, `How do Ad spend and
Regional sales compare?`, `Summarise Ad spend in plain terms` — the two seeded
dataset names verbatim, no figures. Chip order follows `dataset:list`
(directory order), which is why "Ad spend" leads.

## Texture: why a CSS lattice and not a data-URI SVG

The brief allowed either. This is a `radial-gradient(circle at 1px 1px, …)`
layer repeated at 22px — chosen over two SVG data-URIs because it is one
declaration with no asset to keep in sync per theme, and nothing for the CSP to
police at all (a `url(data:…)` in CSS is subject to `img-src`; a gradient is
not an image request). Dot colour: `rgba(15,23,42,0.05)` on light,
`rgba(255,255,255,0.05)` on dark — restated inside the existing
`[data-theme="dark"] .xp-stage` override, which already restates the whole
background stack to swap the base.

One trap worth recording: the dark override sets the `background` SHORTHAND,
which implicitly resets `background-size`/`background-repeat` to initial — and
it out-specifies the base rule, so without restating both lines the dark
lattice silently becomes one element-sized gradient (no dots). They are
restated, with a comment saying why.

## The exec-menu anchor — the trap, confirmed and fixed

`openExecMenu()` positioned off `execBtnVisible()`. After the topbar relayout
the only exec button left is `#exec-mode-btn-cap`, shown only in
`body.cap-focus` — from Ask it is `display:none`, `execBtnVisible()` falls back
to `all[0]`, and a hidden element's rect is all zeros: the menu would pin to the
viewport origin. `openExecMenu(anchor?)` now takes the opener; Ask's model chip
passes itself. The dismiss/Escape closures already capture the same `btn`, so an
anchored open also gets "clicking the opener doesn't insta-close" and "Escape
returns focus to the opener" for free. A new `_execOpener` ref lets
`closeExecMenu` clear `aria-expanded` on non-exec openers, which its
`execBtns()` sweep cannot reach.

`smoke-explore.ts` asserts the fix: menu on screen AND within 2px of the chip's
own edge (openExecMenu places it 6px above or below its anchor), plus the
aria-expanded clear on close.

## The greeting IPC

`app:userName` lives in `src/ipc/shell.ts` beside `app:version` (the file's job
is app-level one-shots): `os.userInfo().username`, first letter capitalised,
`''` on any failure. Display only — it never reaches a path, a prompt or the
network. The renderer caches it once; `''` pins the timeless fallback ("What do
you want to know?", the markup's own static text) for the session. Time-of-day
is renderer-local `Date`, so the greeting matches the wall clock:
morning/afternoon/evening by hour, "Good to see you" late-night — "Good night"
reads as a goodbye.

## Suggestions are names, not data

`DatasetSummary` (what `dataset:list` returns) carries no column names — only
counts — and hydrating a table via `dataset:get` clones every row to the
renderer. So the brief's "Compare X by first text column" example would cost a
full table load to word a prompt; the chips use dataset NAMES only. No model
call, no figures in any string (the app does the math when one is actually
asked). Clicking fills `#xp-input` and focuses it — never auto-sends — and the
strip hides when a transcript exists (CSS, `.xp-asked`) or the project has no
data (JS, `hidden`).

## Rename discipline

User-visible strings say Ask; `data-section="explore"`, every element id, the
`xp-` prefix, file names and IPC channels keep the old identifier (renaming
them is churn across workspace.ts and five smoke suites with no user-visible
gain). Comment markers at each disagreement site. `smoke-explore.ts` now
carries the rename guard: the nav item must read exactly `Ask` while its
data-section stays `explore` — the assertion that fails if either half drifts.

## Gates

`build:ts` clean · `lint` zero findings · `test` 89/89 · smoke: explore
(all checks incl. the new greeting/suggestion/anchor assertions), dock,
composer, connect all pass with **no renderer errors (incl. CSP violations)**.
`smoke-app` shows only the known offline-sandbox MapLibre tile fetch failure
(`ERR_TUNNEL_CONNECTION_FAILED`), which reproduces on the base commit and
touches nothing in this diff; CI has network and is the real gate for it.

File sizes: explore.ts 702 of the 800 cap (was 574) — under the cap, so no
split; the ratchet run passes. smoke-explore.ts 573, smoke-dock.ts 748.
