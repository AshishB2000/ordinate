# Data-source logos design

## Goal

Make the Connect data picker easier to scan by giving all 35 registered data
sources a consistent brand block. Use a recognizable bundled logo when the
repository has a suitable official mark and a deterministic two-letter badge
otherwise. The application must remain fully offline.

## Approved presentation

Use the selected **Option A** treatment:

- a 42 px logo block on the left;
- source name and existing factual blurb on the right;
- the same compact treatment in the chosen-source header;
- no logo-only labels or tooltips, because adjacent text already names the
  source;
- graceful two-letter badges for sources without a suitable bundled mark.

The logo block keeps every tile aligned even when a mark is missing or has an
unusual aspect ratio. Full-colour marks use `object-fit: contain`; single-path
marks use their safe brand colour and adapt to light and dark themes.

## Asset strategy

Extend the existing offline icon pipeline instead of adding a dependency or a
second runtime icon system.

1. Add an explicit connector-id-to-Simple-Icons-export map beside the existing
   provider map in `src/icons.ts`. Explicit mapping avoids runtime slug guesses.
2. Teach `scripts/build-icons.js` to bake both provider and connector paths into
   the existing committed JSON asset. `simple-icons` remains a development-only
   dependency.
3. Bundle the supplied Amazon Redshift image under
   `renderer/hub/assets/connectors/`. Main reads local connector image assets as
   data URIs, matching the existing full-colour agent-logo pattern.
4. Resolve one renderer-safe connector logo map in main. An entry may contain a
   single SVG path plus safe colour, or a local data URI. No filesystem path is
   exposed to the renderer.
5. Do not download logos at runtime. Sources without a bundled official mark
   receive a neutral two-letter badge derived from their display label.

The initial mapping covers every suitable mark available in the installed
Simple Icons version. Multiple products may intentionally share a company or
platform mark when that is the clearest available official identity.

## Data flow and rendering

The connector catalog contract stays unchanged: identity, category, blurb and
form fields remain its only responsibilities. Logos are static application
assets, not connector data.

Main exposes the static connector-logo map through the existing shell/logo IPC
module. The sandboxed preload reads it once at startup and exposes it as
`window.hub.connectorLogos`. `renderer/hub/connections.ts` looks up a mark by
connector id while building each generic tile and the chosen-source header.

The renderer creates one decorative logo element:

- an `<img>` for a full-colour data URI;
- an inline SVG for a bundled single-path mark;
- otherwise a text badge computed from the source label.

All user-visible names remain `textContent`; no connector value becomes HTML.
The hub CSP remains unchanged because images are local `data:` URIs and SVG paths
are created by the application from committed assets.

## Styling and accessibility

Tiles change from a vertical text stack to a compact horizontal row. The icon
block has a fixed size, subtle theme-aware surface, and enough padding for marks
with different proportions. Text continues to wrap rather than overflow.

Logo elements are `aria-hidden="true"`. The button's existing source name and
description provide its accessible name, and native button keyboard behaviour
and grid arrow navigation remain unchanged. Focus, hover and selected states do
not rely on logo colour.

## Failure handling

Missing, malformed or unreadable icon assets never remove a connector. Main
omits the bad logo entry and the renderer displays the fallback badge. The
connector catalog's existing degraded mode remains independent of logo loading.

The icon generator continues to fail loudly when an explicitly mapped upstream
export disappears, preventing silent logo regressions after dependency updates.

## Verification

- Extend icon-generation checks to cover connector mappings and ensure every
  registered connector resolves to either a bundled mark or the documented
  badge fallback.
- Add renderer assertions for official-path, full-colour-image and fallback
  badge tiles, including the chosen-source header.
- Run the focused icon/connector tests, TypeScript build, full test suite, and
  the real Electron smoke test.
- Capture the picker in light and dark themes and inspect logo sizing, alignment,
  contrast, wrapping and focus treatment.

## Non-goals

- No runtime network requests for brand artwork.
- No dependency additions.
- No connector catalog schema change.
- No redesign of search, grouping, forms or saved connections.
- No claim that a fallback badge is an official trademark.
