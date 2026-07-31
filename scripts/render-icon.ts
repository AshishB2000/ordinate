// Render the EXISTING Screenchart mark (the splash "app tile" treatment) to a
// 1024×1024 PNG at assets/icons/icon.png. Run with Electron (for a real SVG
// rasterizer + transparency):  node_modules/.bin/electron scripts/render-icon.js
//
// Not invented art — this is the same capture-frame + ascending-bars mark used in
// the titlebar/splash/about, on the splash's white→light-gray rounded tile.

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

const OUT = path.join(__dirname, '..', 'assets', 'icons', 'icon.png');
const SIZE = 1024;

// macOS Big Sur icon grid: ~824px rounded rect centered in 1024 (≈100px margin),
// corner radius ≈ 22.37% of the rect. The 24-unit mark is scaled to ~460px and centered.
const TILE = 824, MARGIN = (SIZE - TILE) / 2, RADIUS = 184;
const MARK_SCALE = 19.17, MARK_T = SIZE / 2 - 12 * MARK_SCALE; // center the 24×24 art

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#eef2f8"/>
    </linearGradient>
  </defs>
  <rect x="${MARGIN}" y="${MARGIN}" width="${TILE}" height="${TILE}" rx="${RADIUS}" ry="${RADIUS}"
        fill="url(#tile)" stroke="#d6dae1" stroke-width="2"/>
  <g transform="translate(${MARK_T} ${MARK_T}) scale(${MARK_SCALE})" fill="none">
    <path d="M4 8.2V5.6A1.6 1.6 0 0 1 5.6 4H8.2M15.8 4h2.6A1.6 1.6 0 0 1 20 5.6V8.2M20 15.8v2.6a1.6 1.6 0 0 1-1.6 1.6H15.8M8.2 20H5.6A1.6 1.6 0 0 1 4 18.4V15.8"
          stroke="#0f1117" stroke-width="1.7" stroke-linecap="round"/>
    <rect x="7.6" y="13" width="2.3" height="4.2" rx="0.6" fill="#2563eb"/>
    <rect x="10.85" y="10.4" width="2.3" height="6.8" rx="0.6" fill="#2563eb"/>
    <rect x="14.1" y="7.6" width="2.3" height="9.6" rx="0.6" fill="#2563eb"/>
  </g>
</svg>`;

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head>
<body>${svg}</body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false,
    transparent: true, backgroundColor: '#00000000',
    useContentSize: true, webPreferences: { offscreen: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 400)); // let it paint
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, img.toPNG());
  const sz = img.getSize();
  console.log(`wrote ${OUT} (${sz.width}x${sz.height})`);
  app.exit(0);
});
