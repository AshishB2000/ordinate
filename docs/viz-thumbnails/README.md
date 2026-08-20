# Visuals gallery — live chart thumbnails

Gallery cards now render a REAL small chart instead of the grey type glyph, plus
a CSS-only pass over the builder's native `<select>`s.

## Thumbnails are live-rendered, never stored

A visual record stays metadata-only (CLAUDE.md) — no image/preview field was
added. Each card renders at gallery paint time from live data, the way dashboard
cards do: `getVisual` → the same `visual:data` channel the dash grid uses
(`computeVisualData`, resident fast path in main) → `buildChart`
(`chartRender.ts`) into a small canvas.

New `renderer/hub/vizThumbs.ts` (~150 lines), wired with the renderer split
ritual: `<script src="vizThumbs.js">` in `index.html` **before** `vizGallery.js`,
emitted `.js` in `.gitignore`. No `globals.d.ts` entries — its functions are
top-level declarations in the shared renderer program, which `globals.d.ts`'s own
NOTE says must not be double-declared (the same way `xpAppendBubble` is shared).

Presentation: the visual's own saved overrides (colour, sort) plus a thumbnail
preset — `noAnimate`, `showLegend:false`, `showGridlines:false`, `valueMode:'off'`,
no title — expressed through `buildChart`'s EXISTING overrides. What those can't
express (axis ticks/borders off, pointer events off) is trimmed on the returned
instance at the call site: `chartRender.ts` is allowlisted at exactly 999 lines
and was not touched. Chart.js applies `devicePixelRatio` itself, so thumbs are
crisp on retina.

Hard exclusions: **map types keep the glyph** (MapLibre needs WebGL2 and a
visible window — thumbs never render maps) and **table visuals keep the glyph**.
Any fetch/render failure silently leaves the glyph.

Perf: lazy via `IntersectionObserver` with a 3-render concurrency cap (each thumb
is two IPC round-trips). Every Chart instance is tracked and destroyed by
`vizThumbsReset()`, called by `refreshVisualList` before each repaint — measured
in smoke: **Chart.instances 2 → 2 across three section round-trips** (no leaks).

## Smoke coverage

`scripts/smoke-viz-thumbs.ts` (new, in the `npm run smoke` chain): seeds bar +
line + map visuals through the real stores and asserts both chartable cards grow
a nonzero-bitmap canvas, the map card has NO canvas and keeps its glyph, the meta
line carries the `VIZ_LABELS` label, three section round-trips leak no Chart
instances, and no renderer console errors. A separate boot rather than more lines
in `smoke-app.ts`, which sits EXACTLY at its file-size ratchet cap — the same
reasoning `smoke-ask-actions.ts` documents.

One surgical `smoke-app.ts` edit (in place, line count unchanged): the
Mosaic/vgplot scenario waited on `'svg[class*="plot-"], canvas'` — ANY canvas —
and the gallery's new thumbnail canvases satisfied it before vgplot drew. The
wait and its diagnostic count are now scoped to `#viz-area`, the builder's own
host; the assertions themselves are unchanged and pass (`marks=25 canvases=0`).

## Card + builder polish

The card meta line already used `VIZ_LABELS` + `formatSidebarTime` on develop, so
no change was needed there. The builder's `.viz-select` gains `font-family:
var(--font-ui)` (native selects defaulted to the OS UI font), hover/focus-visible
accents, and a disabled state — tokens only, correct in light and dark. The
dropdown LIST itself stays OS-rendered; that cannot be styled with CSS alone.

## Evidence

Real app, xvfb, 1440×900, light + dark, bar + line + map seeded:

- `before/after-gallery-*` — grey glyphs → live bar and line thumbnails; the map
  card keeps its glyph in both.
- `before/after-builder-*` — the builder with the polished selects.
