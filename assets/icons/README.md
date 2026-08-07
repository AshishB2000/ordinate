# App icons

`electron-builder` reads the app icon from this directory (it is the configured
`directories.buildResources`). **`icon.icns` and `icon.ico` must both exist and be
committed** — the build errors out if an icon is missing, so we never ship the
default Electron icon.

## What is here

| file | what it is |
|------|-----------|
| `ordinate.svg` | The light app icon and source of truth: native vector artwork on a centered rounded tile with transparent outer corners. |
| `ordinate-dark.svg` | Dark-tile variant of the same traced vector. |
| `mark.svg` | The same native vector mark with no tile. |
| `icon.png` / `.icns` / `.ico` | Generated. Do not hand-edit. |

The in-app copies are **not** here: `renderer/hub/logo.png` (tile-less) and
`logo-tile.png` live under `renderer/` because this directory is excluded from
the packaged asar (see `build.files` in `package.json`).

## Regenerating

```bash
npm run build:appicon
```

Rasterises `ordinate.svg` at every size electron-builder needs and writes
`icon.png`, `icon.icns` and `icon.ico`. It also refreshes
`renderer/hub/logo-tile.png` from `ordinate.svg` and `renderer/hub/logo.png`
from `mark.svg`. It uses Electron to render (this repo has no SVG rasteriser,
and adding one for an asset that changes once a year is not worth it) and writes
the `.ico` with a hand-rolled encoder — the format is a 6-byte header, a 16-byte
directory entry per image, then whole PNGs.

It is **not** part of any other script: the icon changes rarely and it launches
Electron.

The SVG sources contain no embedded raster. The outer canvas stays transparent,
so the rounded tile does not acquire square white corners in the Dock, taskbar,
splash screen, or About panel.
