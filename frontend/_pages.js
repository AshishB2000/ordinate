/* ============================================================
   Screenchart — generate one standalone page per screen, in the
   index.html design system (app.css + data.js + screens.js).
   Each page mounts a single screen function full-size in a
   .window frame on the canvas backdrop, with a light/dark toggle.
   Re-run after editing screens:  node frontend/_pages.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const OUT = __dirname;

// slug, page title, render fn, width, height, grow?, window extra class
const SCREENS = [
  ['hub-table',     'Home — table turned into a chart',        'hubTableResult',  1100, 720, true,  ''],
  ['hub-chart',     'Home — chart explained in plain English', 'hubChartResult',  1100, 720, true,  ''],
  ['empty-state',   'Empty state — first run',                 'hubEmpty',        1100, 720, false, ''],
  ['processing',    'Processing the capture',                  'hubLoading',      1100, 720, false, ''],
  ['error',         'Error — rejected API key',                'hubError',        1100, 720, false, ''],
  ['setup',         'Setup — bring your own AI key',           'setupScreen',      540, 560, true,  ''],
  ['capture-overlay','Capture overlay — drag to select',       'captureOverlay',  1180, 660, false, 'overlay'],
  ['settings',      'Settings',                                'settingsScreen',   720, 700, true,  ''],
  ['about',         'About & help',                            'aboutScreen',      460, 560, false, ''],
  ['permission',    'Screen-recording permission (macOS)',     'permissionScreen', 460, 500, false, ''],
  ['popup-result',  'Quick popup — result',                    'popupResult',      360, 472, false, 'popup'],
  ['popup-loading', 'Quick popup — loading',                   'popupLoading',     360, 360, false, 'popup'],
  ['popup-error',   'Quick popup — error',                     'popupError',       360, 360, false, 'popup'],
];

const page = (title, fn, w, h, grow, extra) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Screenchart — ${title}</title>
<link rel="stylesheet" href="app.css" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    min-height: 100vh; padding: 40px; display: grid; place-items: center;
    background: radial-gradient(120% 120% at 0% 0%, #efeff1 0%, #e7e7ea 55%, #e3e3e6 100%) fixed;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  #app {
    width: ${w}px; ${grow ? `min-height: ${h}px;` : `height: ${h}px;`}
    max-width: 100%;
  }
  .theme-toggle {
    position: fixed; right: 18px; bottom: 18px; z-index: 99;
    height: 36px; padding: 0 14px; border-radius: 999px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 8px;
    background: #18181b; color: #fff; border: none; font: 600 12.5px system-ui, sans-serif;
    box-shadow: 0 8px 24px rgba(16,18,27,.22);
  }
</style>
</head>
<body>
  <div class="window theme-dark${extra ? ' ' + extra : ''}" id="app"></div>
  <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light / dark"><span id="tt-label">Light</span></button>

  <script src="data.js"></script>
  <script src="screens.js"></script>
  <script>
    var app = document.getElementById('app');
    app.innerHTML = ${fn}();
    function toggleTheme() {
      var dark = app.classList.toggle('theme-dark');
      app.classList.toggle('theme-light', !dark);
      document.getElementById('tt-label').textContent = dark ? 'Light' : 'Dark';
    }
  </script>
</body>
</html>
`;

SCREENS.forEach(([slug, title, fn, w, h, grow, extra]) => {
  fs.writeFileSync(path.join(OUT, slug + '.html'), page(title, fn, w, h, grow, extra));
});

console.log('Built', SCREENS.length, 'standalone pages:');
SCREENS.forEach(([slug, title]) => console.log('  ' + slug + '.html — ' + title));
