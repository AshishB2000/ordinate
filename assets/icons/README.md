# App icons (required for packaging)

`electron-builder` reads the app icon from this directory (it is the configured
`directories.buildResources`). **Both files must exist and be committed** — the
build errors out if an icon is missing, so we never ship the default Electron icon.

Place here:

- `icon.icns` — macOS app icon (used by `dist:mac`)
- `icon.ico` — Windows app icon (used by `dist:win` / CI)

## Generating from a single high-res PNG

Start from a square **1024×1024** PNG (`icon.png`), then:

**macOS `.icns`** (uses the built-in `iconutil`):

```bash
mkdir icon.iconset
for s in 16 32 64 128 256 512; do
  sips -z $s $s   icon.png --out icon.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) icon.png --out icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset
```

**Windows `.ico`** (multi-size; e.g. with ImageMagick):

```bash
magick icon.png -define icon:auto-resize=16,24,32,48,64,128,256 icon.ico
```

Or use any reputable offline converter — do **not** add a runtime/CDN dependency.
