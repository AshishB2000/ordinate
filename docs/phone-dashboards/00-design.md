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
  no cell → after, in desktop order) folded into KPI strips. Pure, node-tested.
- `site/publishClient.ts` — the phone bar (title, published stamp, Filters + badge), the strips
  (cards hidden from the grid on a phone, shown in the strip), each card's phone order and height
  as custom properties, the filter sheet's scrim + handle + swipe, the tap sheet, legend below on a
  phone (redrawn when the breakpoint is crossed).
- `siteHtml.ts` — the phone CSS, inside the existing phone media query only.

## Tests

- Vitest: `phoneBlocks.test.ts` (reading order with spans, gaps, overlapping rows, groups; KPI runs;
  hidden cards; an edited phone order), `Sheet.test.tsx` (title/description, Esc, swipe past the
  threshold closes, a short drag springs back, footer buttons), `KpiStrip.test.tsx`,
  `PointSheet.test.tsx`.
- Node: `scripts/test-publishSite.ts` gains `pkPhoneBlocks` cases (same shapes) and the CSS guard
  that every phone rule sits inside the phone media query (negative control: a rule outside fails).
- e2e `web/e2e/phone.e2e.ts` at 375 × 812, touch: the in-app viewer (header, strip swipe + dots,
  stacked charts, Filters sheet, point sheet, map gestures, legend), the `/p/` page (bar, strip,
  sheet, tap sheet), light + dark screenshots of each; and **desktop unchanged**: at 1440 × 900 no
  `data-phone`, the grid has 12 tracks, the shell's rail and top bar are there, and the published
  page's grid has 12 tracks.
