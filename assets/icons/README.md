# App icons

`electron-builder` reads the app icon from this directory (it is the configured
`directories.buildResources`). **`icon.icns` and `icon.ico` must both exist and be
committed** — the build errors out if an icon is missing, so we never ship the
default Electron icon.

## What is here

| file | what it is |
|------|-----------|
| `reference/cube-insight-200.png` | **The artwork, as supplied.** The source of truth. |
| `ordinate.svg` | The app icon. Embeds the artwork verbatim — it is not a redrawing. |
| `ordinate-dark.svg` | Dark-tile variant. A traced vector, because the supplied PNG bakes in its own light tile and there is no dark version of it. |
| `mark.svg` | The bare mark, no tile. |
| `icon.png` / `.icns` / `.ico` | Generated. Do not hand-edit. |

The in-app copies are **not** here: `renderer/hub/logo.png` (tile-less) and
`logo-tile.png` live under `renderer/` because this directory is excluded from
the packaged asar (see `build.files` in `package.json`).

## Regenerating

```bash
npm run build:appicon
```

Rasterises `ordinate.svg` at every size electron-builder needs and writes
`icon.png`, `icon.icns` and `icon.ico`. It uses Electron to render (this repo has
no SVG rasteriser, and adding one for an asset that changes once a year is not
worth it) and writes the `.ico` with a hand-rolled encoder — the format is a
6-byte header, a 16-byte directory entry per image, then whole PNGs.

It is **not** part of any other script: the icon changes rarely and it launches
Electron.

## Known limitation

The artwork is **200×200**, so 512 and 1024 are a 5.12× upscale and look soft in
the dock. Everything from 16 to 256 is a downscale and is sharp. **Replace
`ordinate.svg` the day a 1024px or vector export of the artwork exists** — that
one file is where the softness comes from, and nothing else has to change.
