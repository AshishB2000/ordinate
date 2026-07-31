'use strict';
// TEMP visual-verification harness — renders each window's HTML offscreen and
// saves PNGs in light + dark. Not part of the app; deleted after verification.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const OUT = '/tmp/scshots';
fs.mkdirSync(OUT, { recursive: true });

const SAMPLE = 'data:image/svg+xml;base64,' + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="320">
   <rect width="520" height="320" fill="#0f1729"/>
   <g fill="#3b82f6"><rect x="40" y="180" width="50" height="100"/><rect x="110" y="140" width="50" height="140"/>
   <rect x="180" y="90" width="50" height="190"/><rect x="250" y="120" width="50" height="160"/>
   <rect x="320" y="60" width="50" height="220"/><rect x="390" y="40" width="50" height="240"/></g>
   <text x="40" y="40" fill="#cbd5e1" font-family="monospace" font-size="20">Sample capture</text></svg>`
).toString('base64');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mk(w, h, preload) {
  return new BrowserWindow({
    width: w, height: h, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload', preload), contextIsolation: true, nodeIntegration: false },
  });
}

function loadAndWait(win, file) {
  return new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      console.log('did-fail-load', file, code, desc);
      resolve();
    });
    win.loadFile(file).catch(() => {});
  });
}

async function save(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
}

async function shootBoth(win, name, sendChannel, payload) {
  if (sendChannel) win.webContents.send(sendChannel, payload);
  await wait(500);
  await save(win, name + '-light');
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme='dark';");
  await wait(300);
  await save(win, name + '-dark');
}

app.whenReady().then(async () => {
  try {
    let win = mk(400, 320, 'statusPreload.js');
    await loadAndWait(win, 'renderer/status/index.html');
    await shootBoth(win, 'status', 'status:state', { hotkey: 'Cmd+Shift+S', note: '' });
    win.destroy();

    win = mk(1180, 780, 'hubPreload.js');
    await loadAndWait(win, 'renderer/hub/index.html');
    await shootBoth(win, 'hub', null, null);
    win.destroy();

    win = mk(1000, 640, 'overlayPreload.js');
    await loadAndWait(win, 'renderer/overlay/index.html');
    win.webContents.send('overlay:frame', { dataUrl: SAMPLE, width: 1000, height: 640 });
    await win.webContents.executeJavaScript(
      "(()=>{document.getElementById('dim').hidden=true;const s=document.getElementById('selection');s.hidden=false;" +
      "s.style.left='220px';s.style.top='150px';s.style.width='520px';s.style.height='300px';" +
      "document.getElementById('dims').textContent='520 × 300';})()"
    );
    await wait(450);
    await save(win, 'overlay-light');
    win.destroy();

    console.log('SHOTS_DONE');
  } catch (e) {
    console.log('HARNESS_ERROR', e && e.stack ? e.stack : e);
  }
  app.quit();
});
