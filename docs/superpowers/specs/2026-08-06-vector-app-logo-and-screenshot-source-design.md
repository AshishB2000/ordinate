# Vector app logo and Screenshot source icon design

**Date:** 2026-08-06  
**Branch:** `codex/fix/vector-logo-assets`

## Goal

Replace the raster-embedded Ordinate artwork with a sharp, centered vector while
preserving the approved mark exactly: the faceted blue frame, darker left face,
three ascending bars, and open split at the bottom center. The icon must no
longer show a rectangular white background outside its rounded tile.

Use the supplied Screenchart icon for the Home → Connect `Screenshot` shortcut
instead of the generic capture glyph.

## Approved appearance

The new Ordinate artwork keeps the existing traced silhouette and its visual
identity. It changes only the asset construction and alignment:

- keep the bright top/right faces and darker lower-left face;
- keep the three ascending bars and the intentional bottom split;
- center the mark inside the rounded tile with equal left/right space;
- keep the area outside the rounded tile transparent;
- render from vector geometry rather than an embedded 200×200 PNG;
- retain the light rounded tile for the application icon;
- retain a tile-free form for small in-app branding.

The Screenchart icon remains a separate source mark. It does not replace the
Ordinate product identity.

## Asset changes

`assets/icons/ordinate.svg` becomes the single source of truth for the light app
icon. It uses the already-approved machine-traced path from
`assets/icons/ordinate-dark.svg`, a native SVG gradient, and a centered rounded
tile on a transparent canvas. It contains no `<image>` element, data URI, or
embedded raster.

`assets/icons/mark.svg` becomes the same vector silhouette without a tile.
`assets/icons/ordinate-dark.svg` keeps the same vector silhouette on its dark
tile. Comments and documentation stop treating the old raster as the active
source.

The generated and packaged copies are refreshed from those SVGs:

- `assets/icons/icon.png` — 1024×1024 light app icon;
- `assets/icons/icon.icns` and `assets/icons/icon.ico` — packaged platform icons;
- `renderer/hub/logo-tile.png` — light rounded tile with transparent corners;
- `renderer/hub/logo.png` — tile-free in-app mark.

The obsolete `assets/icons/reference/cube-insight-200.png` raster source is
removed after the vector replacement is verified. Existing filenames are
replaced in place so packaging and renderer references do not need migration.

The supplied
`/Users/ashishb/Projects/screenchart/assets/icons/icon.png` is copied into
`renderer/hub/assets/connectors/screenchart.png`. The Home Screenshot shortcut
loads that bundled local file through the existing logo helper. No external URL
or filesystem path reaches the renderer.

## Build path

The existing `npm run build:appicon` command is kept as the canonical icon
regeneration entry point. Its missing script is restored as a small,
dependency-free Electron build tool that:

1. rasterizes the light SVG at the sizes needed by the app;
2. writes the 1024px PNG and platform icon containers;
3. writes the renderer tile and tile-free PNG copies;
4. fails clearly if the source SVGs are missing or invalid.

No runtime dependency is added. The already-installed Electron runtime and Node
standard library perform the conversion.

## Renderer behavior

The Home `Screenshot` item keeps its existing label, click target, and capture
behavior. Only its decorative mark changes. The image remains `aria-hidden`
because the adjacent text is the accessible label.

The source icon is bundled offline and must comply with the existing strict hub
CSP. If it cannot load, the existing deterministic logo fallback remains in
place; the failure must not break navigation.

## Testing

Focused icon checks will assert that:

- `ordinate.svg` and `mark.svg` are native vector artwork with no embedded
  raster or external reference;
- the light icon has a transparent outer canvas and a centered rounded tile;
- the approved faceted path and bottom split remain present;
- the obsolete raster reference is absent;
- generated PNG dimensions are correct;
- the bundled Screenchart image exists and the Home action points to it;
- all existing 35 connector marks remain covered and safe.

The Electron smoke test will assert that the Home Screenshot shortcut renders
an image mark, while the other four shortcuts retain their existing marks. It
will continue checking both themes, renderer errors, and CSP violations.

Final verification includes the focused icon test, TypeScript build, full test
suite, app-icon regeneration, and real Electron smoke test. The generated PNG
and SVG are visually inspected at full size and at their in-app sizes.

## Out of scope

- Redesigning the approved Ordinate silhouette.
- Removing the darker left face or the bottom split.
- Changing Home layout, labels, source behavior, or the 35 connector logos.
- Adding an icon or image-processing dependency.
- Renaming the Electron product or migrating user data.
