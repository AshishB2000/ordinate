'use strict';

// Rasterise assets/icons/ordinate.svg into every APP icon format
// electron-builder needs: icon.png, icon.icns (macOS) and icon.ico (Windows).
//
// Not to be confused with scripts/build-icons.js, which bakes the six PROVIDER
// brand glyphs out of simple-icons. This one is the application's own icon.
//
// WHY ELECTRON RATHER THAN A CONVERTER
// This machine has no SVG rasteriser — no rsvg-convert, no ImageMagick, no
// Inkscape — and adding one as a build dependency for an asset that changes
// about once a year is not worth it. Electron is already here, renders SVG
// exactly, and can capture at an exact pixel size. Same mechanism
// src/reportCapture.ts uses for dashboard PNGs.
//
// WHY THE .ico IS HAND-WRITTEN
// There is no ICO encoder here either. The format is a 6-byte header, one
// 16-byte directory entry per image, then the payloads — and since Vista an
// entry may be a whole PNG rather than a BMP. That makes a correct encoder about
// thirty lines with no dependency, which beats adding one.
//
// NOT part of any other script: the icon changes rarely and this launches
// Electron.  npm run build:appicon
//
// ponytail: plain JS with no .ts sibling, like scripts/build-vendor.js — it has
// to run without a TypeScript build already existing.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'assets', 'icons');
const SRC = path.join(ICONS, 'ordinate.svg');
const MARK_SRC = path.join(ICONS, 'mark.svg');
const RENDERER = path.join(ROOT, 'renderer', 'hub');

const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]; // .ico tops out at 256
const ALL = [...new Set([...ICNS_SIZES, ...ICO_SIZES])].sort((a, b) => a - b);

/**
 * Render the SVG at a set of exact pixel sizes, reusing ONE window.
 *
 * A window per size fails on this machine — Electron's Mach rendezvous refuses
 * repeated renderer spawns and the second load dies with ERR_FAILED. One window
 * that is resized between captures avoids that entirely, and rendering each size
 * natively (rather than downscaling a single 1024 render) keeps the 16px and
 * 32px icons crisp, which is where a downscale would show first.
 *
 * `backgroundColor: '#00000000'` keeps the margin around the tile TRANSPARENT.
 * The tile draws its own rounded rect, so filling the canvas would put square
 * corners behind it and the dock would show a white box.
 */
async function renderSizes(win, svgText, sizes, label) {
  const html =
    '<!doctype html><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    'svg{display:block;width:100vw;height:100vw}</style>' +
    svgText;

  const tmp = path.join(os.tmpdir(), `ordinate-icon-${label}-${process.pid}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  await win.loadFile(tmp);

  const out = new Map();
  try {
    for (const size of sizes) {
      win.setContentSize(size, size);
      // Two beats: one for the resize to land, one for the repaint.
      await new Promise((r) => setTimeout(r, 140));
      const image = await win.webContents.capturePage();
      // capturePage returns physical pixels (2× on a Retina display). Normalize
      // every artifact to its requested size so builds are machine-independent.
      const png = image.resize({ width: size, height: size, quality: 'best' }).toPNG();
      if (!png || png.length < 100) throw new Error(`render at ${size}px produced no image`);
      out.set(size, png);
      console.log(`[build-appicon] rendered ${size}\u00d7${size}`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
  }
  return out;
}

/** Minimal ICO container. Each entry embeds a complete PNG (valid since Vista). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const at = i * 16;
    // 256 is written as 0 — the width/height fields are a single byte each.
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 0);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1);
    dir.writeUInt8(0, at + 2); // palette entries
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

async function main() {
  if (!fs.existsSync(SRC)) throw new Error('missing ' + SRC);
  if (!fs.existsSync(MARK_SRC)) throw new Error('missing ' + MARK_SRC);
  const svgText = fs.readFileSync(SRC, 'utf8');
  const markText = fs.readFileSync(MARK_SRC, 'utf8');

  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  let pngs;
  let markPngs;
  try {
    pngs = await renderSizes(win, svgText, [...new Set([...ALL, 200])].sort((a, b) => a - b), 'tile');
    markPngs = await renderSizes(win, markText, [160], 'mark');
  } finally {
    win.destroy();
  }

  fs.writeFileSync(path.join(ICONS, 'icon.png'), pngs.get(1024));
  console.log('[build-appicon] wrote icon.png (1024×1024)');

  fs.writeFileSync(path.join(RENDERER, 'logo-tile.png'), pngs.get(200));
  fs.writeFileSync(path.join(RENDERER, 'logo.png'), markPngs.get(160));
  console.log('[build-appicon] wrote renderer logo-tile.png and logo.png');

  fs.writeFileSync(
    path.join(ICONS, 'icon.ico'),
    buildIco(ICO_SIZES.map((size) => ({ size, png: pngs.get(size) }))),
  );
  console.log(`[build-appicon] wrote icon.ico (${ICO_SIZES.join(', ')})`);

  if (process.platform === 'darwin') {
    const set = path.join(ICONS, 'icon.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    // A retina name is the SAME pixel count as the next size up.
    const names = [
      ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
    ];
    for (const [name, size] of names) fs.writeFileSync(path.join(set, name), pngs.get(size));
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(ICONS, 'icon.icns')], { stdio: 'inherit' });
    fs.rmSync(set, { recursive: true, force: true });
    console.log('[build-appicon] wrote icon.icns');
  } else {
    console.log('[build-appicon] skipped icon.icns (iconutil is macOS-only)');
  }
}

app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (err) {
    console.error('[build-appicon] FAILED:', err && err.message ? err.message : err);
    app.exit(1);
  }
});
