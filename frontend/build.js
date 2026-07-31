/* ============================================================
   Screenchart — build the deliverable canvas. Mounts each
   screen template into a light frame and a dark frame.
   ============================================================ */
function win(html, theme, w, h, extra=''){
  const grow = extra.includes('grow');
  const size = `width:${w}px;` + (h ? (grow?`min-height:${h}px;`:`height:${h}px;`) : '');
  return `<div class="window theme-${theme} ${extra}" style="${size}">${html}</div>`;
}
function frame(theme, html, w, h, extra){
  return `<div class="frame ${theme}">
    <div class="tname"><i></i>${theme==='light'?'Light':'Dark'}</div>
    ${win(html, theme, w, h, extra)}
  </div>`;
}
function pair(renderFn, w, h, extra){
  const html = renderFn();
  return `<div class="pair">${frame('light',html,w,h,extra)}${frame('dark',html,w,h,extra)}</div>`;
}
function variant(label, desc, renderFn, w, h, extra){
  return `<div class="variant">
    <div class="var-label"><span class="nm">${label}</span>${desc?`<span class="desc">· ${desc}</span>`:''}</div>
    ${pair(renderFn,w,h,extra)}
  </div>`;
}
function single(label, desc, renderFn, w, h, extra){
  return `<div class="variant">
    <div class="var-label"><span class="nm">${label}</span>${desc?`<span class="desc">· ${desc}</span>`:''}</div>
    <div class="pair">${win(renderFn(),'dark',w,h,extra)}</div>
  </div>`;
}

function section(num, title, desc, star, body){
  return `<section class="section">
    <div class="sec-head">
      <div class="sec-num">${num}</div>
      <h2>${title}</h2>
      <p>${desc}</p>
      ${star?`<div class="star">${ic('sparkle',13,1.8)} ${star}</div>`:''}
    </div>
    ${body}
  </section>`;
}

const HUB_W=1100, HUB_H=720;

const SECTIONS = [
  section('01 · HUB', 'The hub window', 'The centerpiece. A history sidebar on the left, the selected capture as a conversation on the right — capture at top, analysis below, a follow-up chat pinned to the bottom.',
    'This is where the design system is set; every other screen inherits these tokens.',
    `<div class="variants">
      ${variant('Table result', 'extracted numbers beside the generated chart — the spot-check view', hubTableResult, HUB_W, HUB_H, 'grow')}
      ${variant('Chart result', 'a captured chart explained in plain English', hubChartResult, HUB_W, HUB_H, 'grow')}
      ${variant('Empty state', 'first launch — welcome, 3 steps, add-a-key prompt', hubEmpty, HUB_W, HUB_H)}
      ${variant('Loading state', 'waiting on the AI response', hubLoading, HUB_W, HUB_H)}
      ${variant('Error state', 'a rejected API key — clear, recoverable, capture preserved', hubError, HUB_W, HUB_H)}
    </div>`),

  section('02 · RESULT DETAIL', 'Result view, up close', 'The table-to-chart path is the differentiator: extracted numbers sit right beside the generated chart so a misread digit is easy to catch. The chart path stays simple — screenshot plus a plain-English read.',
    'Trust comes from showing the model’s work: the numbers it read, next to what it drew.',
    `<div class="variants">
      ${variant('Table → chart, focused', 'numbers + chart + spot-check note', hubTableResult, HUB_W, HUB_H, 'grow')}
    </div>`),

  section('03 · SETUP', 'First-run API key setup', 'Shown on first launch — the app can’t work without a key. Pick a provider, paste the key, validate, continue. Reassurance that the key stays local.', '',
    `<div class="variants"><div class="variant-row">
      ${variant('API key setup', 'provider picker + validate', setupScreen, 540, 560, 'grow')}
    </div></div>`),

  section('04 · CAPTURE', 'Capture overlay', 'A full-screen dimmed layer with a drag-to-select rectangle. The selected region stays bright, with live dimensions, a mode toggle, and an Esc-to-cancel hint.', '',
    `<div class="variants">
      ${single('Drag to select', 'selecting a chart on a live desktop', captureOverlay, 1180, 660, 'overlay')}
    </div>`),

  section('05 · QUICK POPUP', 'Quick popup', 'A small floating window that appears right after a hotkey capture — a compact result you can read without leaving your work, with its own loading and error states and a jump-to-hub button.', '',
    `<div class="variants"><div class="variant-row">
      ${variant('Result', 'compact table→chart', popupResult, 360, 472, 'popup')}
      ${variant('Loading', '', popupLoading, 360, 360, 'popup')}
      ${variant('Error', 'no network', popupError, 360, 360, 'popup')}
    </div></div>`),

  section('06 · SETTINGS', 'Settings', 'Everything from one place: provider and key, model and endpoint, the global hotkey, the default prompt, and the light/dark theme — all built from the same tokens.', '',
    `<div class="variants"><div class="variant-row">
      ${variant('Preferences', 'the theme toggle reflects each frame', settingsScreen, 720, 700, 'grow')}
    </div></div>`),

  section('07 · ABOUT', 'About / Help', 'What the app is, the version, a few links, and light troubleshooting — kept calm and simple.', '',
    `<div class="variants"><div class="variant-row">
      ${variant('About & help', '', aboutScreen, 460, 560)}
    </div></div>`),

  section('08 · PERMISSION', 'macOS Screen Recording', 'Shown when a capture comes back black: plain steps to grant Screen Recording permission in System Settings, then reopen.', '',
    `<div class="variants"><div class="variant-row">
      ${variant('Grant permission', 'macOS', permissionScreen, 460, 500)}
    </div></div>`),
];

document.getElementById('sections').innerHTML = SECTIONS.join('');
