---
paths:
  - "web/**"
---

# Web app (`web/`)

## Stack

- Vite + React 19 + TS `strict`, React Router 7, TanStack Query 5, Radix primitives styled by us,
  and CSS Modules over the `web/src/theme.css` tokens.
- `web/src/api/client.ts` imports `src/api` **types only**, so a renamed channel fails `tsc` in
  both halves.
- The UI only formats what the server returns. It never sums, averages, rounds or derives a
  figure; a missing number is added on the server.
- Every list, panel and chart has a designed empty, loading (skeleton) and error state, in both
  themes.
- The React UI is English-only.

## Charts and maps

- Charts use Chart.js 4 directly (`web/src/charts/`). The core and plugins load on first use, as
  do pdfmake, pptxgenjs and docx.
- Maps use MapLibre GL **4.7.1, pinned exactly**: the `-csp` build with a same-origin worker.
- **No `glyphs` and no `sprite` URL**, since either adds a network host, so value labels are DOM
  markers. OSM tiles are the one declared external fetch (`MAP_TILE_ORIGINS`).

## CSP and size

- CSP is a server header with `script-src 'self'`: no inline script or style. CSRF compares Origin
  with Host, so the Vite dev proxy must preserve Host.
- **Initial JS ≤ 300 KB gzip** (`npm --prefix web run size`, CI-enforced). Each area is a lazy
  chunk.

## Live datasets

A screen that reads rows gates on `mode: 'live'` and never asks its channel for a Live dataset.
See `.claude/rules/live-data.md`.

## Tests

- Vitest + Testing Library next to the component.
- **One Playwright e2e per screen** in `web/e2e/` (`e2e()` in `web/e2e/fixtures.ts`), run against
  the built server. The `e2e-run` skill covers running and debugging them.
  - It **fails on any console error, page error or CSP violation**.
  - It holds an **RPC budget** (`rpcBudget`, default 25 per page load). Batch an endpoint before
    raising the budget.
  - It writes light and dark screenshots to `web/e2e/__screens__/`. Look at them.
  - `E2E_CHROMIUM` overrides the browser.
- A test that does not need the real server's data, real rendering it interacts with, or routing
  across screens belongs in Vitest, not e2e. Extend the screen's existing spec rather than adding
  one.
