# Dashboards on a phone

## What you will see when this is done

Open an alert's or a subscription's link on a phone and the dashboard reads like a native app,
in the app and on a published `/p/` page alike:

- **A compact sticky header** — back, the dashboard's name on one line, how fresh the figures are
  ("As of 12 min ago", or "Published 15 Oct, 14:02" on a `/p/` page), and a **Filters** button that
  wears a badge with the number of filters narrowing the page. More than one sheet: a segmented,
  swipeable sheet strip under it. The app's own top bar and rail step aside while a dashboard is on a
  phone (the back button returns to them).
- **KPIs as a swipeable strip.** Consecutive KPI cards become one row you swipe through — two to a
  screen with the next one peeking, snapping card by card (CSS scroll-snap), with page dots under it.
- **Every chart full width**, stacked in reading order (the grid read row by row, then left to
  right — the same order the phone layout has always derived, and the author's own phone order when
  they arranged one), at phone heights, legends under the chart.
- **Tables scroll sideways** inside their card with the **first column and the header pinned**.
- **Filters open in a bottom sheet**: a grab handle, the controls full width, the view settings
  (As of, Compare, Currency) under them, *Clear all* and *Done*. Swipe it down, press Esc or tap the
  scrim to close; it sits above the home indicator (safe-area insets).
- **Tapping a chart point opens a bottom sheet of what you can do with it** — filter the dashboard
  to it, show the rows behind it, explain the change (a time axis), comment on it — instead of a
  context menu nobody can right-click on a phone. The drill and Explain panels themselves open as
  bottom sheets too.
- **Text and notes** keep a readable measure (≤ 68 characters, 15 px, 1.55 line height) and grow
  to their content instead of clipping.
- **Maps** get a fixed, sensible height and never trap the page's scroll: one finger scrolls the
  page, two fingers move the map (MapLibre's cooperative gestures) — the published page's maps are
  still pictures and cannot trap anything.

Desktop and tablet do not change by one pixel: everything is behind the existing phone breakpoint.

## Decisions (the user was away; each one made here)

| Question | Decision | Why |
|---|---|---|
| Where is "a phone"? | The **existing** phone size: the dashboard's width < 600 px (`geometry.ts BREAKPOINTS.phone`; the published page moves it out by its padding, `siteHtml.sizeCss`). Not a new 640 px line. | The brief said "~640 px". A second breakpoint would make 600–640 px wide windows tablet in one place and phone in another, and the tablet layout must not move. Every phone is < 600 px wide. |
| CSS or JS? | **CSS first.** The in-app size is already measured once (`SheetHost`'s ResizeObserver → `ed.size`) because a dashboard's width is not the window's; everything phone-specific hangs off one `data-phone` attribute on the editor root and is CSS from there. The published page stays media-query only. JS only for: the KPI strip's page dots, swipe-to-close, the tap sheet, and Chart.js's legend position. | |
| Phone reader vs the author's phone preview | The new phone design is the **reader on a narrow screen** (`ed.size === 'phone'` and the size was *not* pinned). A desktop author who pins *Phone* keeps today's preview frame with its reorder / height / hide tools — that is where a phone layout is arranged. An editor who opens the dashboard on an actual phone reads it: no rail, no drag, no Properties. | Authoring on a 375 px screen is not a job anyone does; the arranging tools stay one click away on desktop. |
| Reading order | `readingOrder` (y, then x; a group then its children by tab) and `resolve(…, 'phone')` — unchanged, so the author's edited phone order and hidden cards are honoured. On top of it, `phoneBlocks` (new, pure) folds each **run of consecutive KPI cards** into one strip. | Changing the order function would move the tablet layout and break parity with the server's `sizeLayout` (geometry.test.ts). |
| KPI strip geometry | Card width `(100% − gap) / 2.2` — two whole cards and a peek; `scroll-snap-type: x mandatory`, `scroll-snap-align: start`. A run of ONE KPI is not a strip: it is a full-width card. Dots = the strip's scroll positions (`ceil(scrollWidth / clientWidth)`), the current one filled; each dot is a 44 px-tall button that scrolls there. | The peek says "swipe" without a word; dots say how far. |
| Tables | **Sideways scroll with a sticky first column and header**, never a card list. | A table on a dashboard is read across a row *and* down a column; a card list breaks the second. The author's own columns stay one grid. |
| Card heights | Charts, maps and stats: the phone cell's rows at a phone row of 40 px (a 6-row chart → 300 px). Text, summary, navigation, images and group headings: **content height** (min one row). KPI strip: 112 px. | Rows keep the author's per-card phone heights meaningful; prose must never clip. |
| A tap on a chart | Author-defined click actions still run directly (the author chose them). Otherwise the point sheet. A pie/scatter/treemap tap with no category-axis point still offers filter + rows from the hit mark. | |
| Filters badge | Count of controls and parameters moved off their defaults, plus As of / Compare when set. | Everything in the sheet that is narrowing what the page shows. |
| Header overflow (⋯) | Share (the OS share sheet where there is one, else Copy link) and Comments. Present, Style, History, Export, Print stay desktop's. | |
| Published dark | A published page follows its dashboard's style (Auto publishes light, as today); the dark screenshot is a dashboard styled Dark. | Not changing a published page's colour on desktop. |
| Reduced motion | Sheet slide, dot fill and smooth scrolling all go: `scroll-behavior: auto`, no animations (base.css's global block plus explicit `@media (prefers-reduced-motion)` in the new modules and the published CSS). | |
| Touch targets | Every control the phone header, sheets, card heads and dots draw is ≥ 44 × 44 px. Card heads on a phone lose `touch-action: none` (a drag handle on desktop; on a phone it froze the page's scroll under a finger that landed on a title). | |
| Migration / server | None. No contract, no channel, no figure: the phone is presentation over answers the server already sends. | |
| A KPI tile | Its name a small uppercase label on top, the figure (24 px) under it, ⋯ in the corner; no rule, no repeated name, no comment button (Comments are in the header's ⋯). | Two to a 375 px screen leaves ~126 px of text: "$686.2K" fits, a title row with two buttons did not. |
| Card freshness | The header says "As of …" once; a card repeats it only when its own figure is stale (the warning tone). | A caption on every card was ellipsized to "As…" at phone width. |
| Published cards have no id | `pkPhoneBlocks` names cards by their **index** in the sheet. | `sanitize.ts` whitelists what a page may carry (a security control); adding ids was not worth touching it. |

### A root cause found on the way

Every **viewer** (read-only role) saw the desktop grid on every screen, a phone's included — the
complaint behind this feature. `Editor.tsx SheetHost` measured "the bench less the rail" by
subtracting the bench's first child; a viewer has no rail, so the first child was the sheet itself
and the measured width was 0 → `pickSize(0)` = desktop. Fixed: the rail is subtracted only when it is
there (an editor's rail hidden on a phone keeps its 48 px counted, so hiding it cannot flip the size
back). Consequence, deliberate: a viewer in a 600–899 px window now gets the **tablet** layout an
author derived or arranged for that size, as an editor always has. Desktop (≥ 900 px) is unchanged.

## Pieces

In the app (`web/`):

- `ui/Sheet.tsx` (+ `Sheet.module.css`, `useSwipeDown.ts`) — a Radix Dialog as a bottom sheet:
  our own scrim (Radix's Overlay injects a `<style>` the CSP refuses), grab handle, title,
  description, scrolling body, footer; Esc / scrim / swipe-down close; safe-area padding. `Drawer`
  (drill, Explain) becomes the same sheet under 600 px by CSS, with the same swipe.
- `features/dashboards/phone/`:
  - `phoneBlocks.ts` — pure: resolved phone items → `[{kind:'strip', ids}, {kind:'card', id}]`.
  - `PhoneHead.tsx` — the sticky header, sheet strip, ⋯ menu, Filters button.
  - `FiltersSheet.tsx` — the controls and view settings in a `Sheet` (the pinned preview's
    "Filters (N)" button opens it too).
  - `KpiStrip.tsx` — scroll-snap strip + dots.
  - `PointSheet.tsx` — the tap's actions.
  - `Phone.module.css`.
- Touched: `Editor.tsx` (root attribute, Head ↔ PhoneHead, no rail), `Canvas.tsx` (the stack),
  `CardView.tsx` (lean head on a phone), `CardRuntime.tsx` (`VisualCard` → point sheet, legend
  below), `VisualTile.tsx` (`onMarkTap`), `FilterBar.tsx`, `ClickFilters.tsx` (no keyboard hints on
  a phone), `DashboardChrome.tsx` (`useSheetStamps` shared by the head), `charts/maps/maplibre.ts`
  (cooperative gestures on a coarse pointer), `app/Shell.module.css` (`:has([data-phone])` hides
  the top bar and rail), `index.html` (`viewport-fit=cover`).

Published (`src/publish/`):

- `site/publishCore.ts` — `pkPhoneBlocks(cards)`: the phone order (phone cell y, x; hidden out;
  no cell → after, in desktop order) folded into KPI strips, cards named by index. Pure.
- `site/publishPhone.ts` (new inlined script, `SiteAssets.phoneJs`, between core and client) —
  what CSS cannot build: `ppSheet` (a tapped point's bottom sheet), `ppSwipe`, `ppStrip` (the
  strip and its dots), `ppStamp` ("Published …"), `ppPhoneChart` (legend below, level and thinned
  axis labels), the filter glyph. `PP_PHONE_MQ` is the stylesheet's breakpoint to the pixel.
- `site/publishClient.ts` — the title row (`display: contents` wider than a phone), the Filters
  button + badge, the filter sheet's scrim, handle, Reset / Done and swipe; each tile's phone order
  and height as custom properties; the strips; a tap asks before it filters; crossing the
  breakpoint redraws.
- `sitePhoneCss.ts` (new) — the phone rules, all inside the phone media query; `siteHtml.sizeCss`
  adds them and only ever hides the new elements outside it (`test-publishSite` checks, with a
  negative control).

## Verification

- Desktop unchanged: the dashboards e2e run on `develop` (b692356a) and on this branch at
  1440 × 900, every screenshot pixel-compared. Published pages: **0 pixels** differ. In the app the
  only differences are the clock ("As of 8:44 PM"), the random marks the click-filter test hits,
  and whether the map tile had loaded when the shot was taken — no layout moved.
- The pinned phone preview (analyses e2e) still passes with its Filters sheet now a bottom sheet.

## Tests

- Vitest: `phone/phoneBlocks.test.ts` (reading order with spans, gaps, overlapping rows, groups;
  KPI runs; hidden cards; an edited phone order; and DIFFERENTIAL — `pkPhoneBlocks` over the
  server's `publishCells` against `phoneBlocks` over `resolve`, 200 seeded sheets),
  `ui/Sheet.test.tsx` (name/description, Esc, Done, a swipe past the threshold closes, a short drag
  springs back, a press on Close is not a drag), `phone/sheets.test.tsx` (the strip's page maths,
  the strip region, the point sheet closes then runs).
- Node: `scripts/test-publishSite.ts` gains `pkPhoneBlocks` cases, the client/stylesheet
  breakpoint agreement, the script order, and the guard that outside the phone media query the new
  elements are only ever hidden (with a negative control).
- e2e `web/e2e/phone.e2e.ts` at 375 × 812, touch (`E2eOptions.device`, new): the in-app viewer
  (chrome hidden, header, strip + dots + snap, stacked full-width charts at phone height, map
  cooperative gestures, the Filters sheet + badge + swipe-to-close + Clear all, a tapped bar → point
  sheet → filter chip, the drill as a bottom sheet), a wide table with its first column pinned, the
  `/p/` page (sticky bar, strip, filter sheet + badge, a tapped bar asks first, a Dark style), and
  **desktop unchanged** (no `data-phone`, 12 tracks, the shell, the published grid 12 tracks and
  no strip). Screenshots: `web/e2e/__screens__/phone-*.png`.
