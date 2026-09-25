'use strict';

// The two popover menus that open ON a capture result: the per-chart ⋯ menu
// (chart type, colour, number format) and the image action menu (copy / save),
// which the capture page's image frame and the lightbox both raise on
// right-click.
//
// Split verbatim out of hub.ts — see .claude/rules/file-size.md. Classic
// global-scope <script>: no import/export. Loads after hubCapture.js — the
// wiring below reads imgLightbox, lightboxImg, lightboxClose and closeLightbox
// at load time, and those are declared there. The capture page's own frame is
// looked up here rather than shared, so the page owns its clicks and this file
// owns its right-click.

// ── Chart context menu (⋯ button) ────────────────────────────────────────
// Single shared popover, repositioned on each open.

let _chartMenuDismiss = null;
let _chartMenuEscape  = null;

// Curated swatches for the customize panel (drawn from theme palette + tasteful extras).
// Must be declared before the chartMenuEl IIFE that builds the swatch buttons.
const CURATED_COLORS = [
  { hex: '#4f7cd4', label: 'Blue'   },
  { hex: '#13a99e', label: 'Teal'   },
  { hex: '#e8960c', label: 'Amber'  },
  { hex: '#7c52e8', label: 'Violet' },
  { hex: '#e83859', label: 'Rose'   },
  { hex: '#0ea5e9', label: 'Sky'    },
  { hex: '#22c55e', label: 'Green'  },
  { hex: '#f97316', label: 'Orange' },
];

// Build the popover once and append to body.
const chartMenuEl = (function () {
  const el = document.createElement('div');
  el.className = 'chart-menu';
  el.setAttribute('role', 'menu');
  el.hidden = true;
  el.innerHTML = `
    <div class="chart-menu-section">
      <button class="chart-menu-item" id="cm-copy-img" type="button">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        Copy chart as image
      </button>
      <button class="chart-menu-item" id="cm-download" type="button">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
          <polyline points="17 21 17 13 7 13 7 21"/>
          <polyline points="7 3 7 8 15 8"/>
        </svg>
        Download chart (PNG)…
      </button>
      <button class="chart-menu-item" id="cm-copy-data" type="button">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
        Copy data
      </button>
      <!-- Drill-down. Hidden unless the entry carries a drill context (a saved
           visual on a dashboard/analysis card or in the builder) — the capture
           result surface has no dataset to drill into. -->
      <button class="chart-menu-item" id="cm-drill" type="button" hidden>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 5h18"/>
          <path d="M3 10h18"/>
          <path d="M3 15h8"/>
          <circle cx="17" cy="17" r="4"/>
          <line x1="20" y1="20" x2="22.5" y2="22.5"/>
        </svg>
        Show underlying rows
      </button>
      <!-- Explain: the app's facts about this chart, narrated in the dock.
           Same gate as Drill — it needs the dataset and encoding behind it. -->
      <button class="chart-menu-item" id="cm-explain" type="button" hidden>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          <line x1="8" y1="9" x2="16" y2="9"/>
          <line x1="8" y1="13" x2="13" y2="13"/>
        </svg>
        Explain
      </button>
    </div>
    <div class="chart-menu-sep"></div>
    <button class="chart-menu-customize-hdr" id="cm-customize-toggle" type="button">
      <span>Customize</span>
      <svg class="cm-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>
    <div class="chart-menu-customize" id="cm-customize" hidden>
      <div class="cm-field">
        <label class="cm-label" for="cm-title">Title</label>
        <input class="cm-input" id="cm-title" type="text" placeholder="Chart title" autocomplete="off"/>
      </div>
      <div class="cm-field">
        <label class="cm-label">Color</label>
        <div class="cm-swatches" id="cm-swatches"></div>
      </div>
      <div class="cm-toggle-row">
        <span class="cm-toggle-label">Show legend</span>
        <button class="cm-switch" id="cm-show-legend" role="switch" aria-checked="false" type="button">
          <span class="cm-switch-thumb"></span>
        </button>
      </div>
      <div class="cm-field" id="cm-legend-pos-field">
        <label class="cm-label" for="cm-legend-pos">Legend position</label>
        <select class="cm-input cm-select" id="cm-legend-pos">
          <option value="bottom">Bottom</option>
          <option value="top">Top</option>
          <option value="left">Left</option>
          <option value="right">Right</option>
        </select>
      </div>
      <div class="cm-toggle-row">
        <span class="cm-toggle-label">Gridlines</span>
        <button class="cm-switch" id="cm-show-gridlines" role="switch" aria-checked="true" type="button">
          <span class="cm-switch-thumb"></span>
        </button>
      </div>
      <div class="cm-toggle-row" id="cm-y-zero-row">
        <span class="cm-toggle-label">Y-axis starts at zero</span>
        <button class="cm-switch" id="cm-y-zero" role="switch" aria-checked="true" type="button">
          <span class="cm-switch-thumb"></span>
        </button>
      </div>
      <div class="cm-field" id="cm-sort-field">
        <label class="cm-label" for="cm-sort">Sort by value</label>
        <select class="cm-input cm-select" id="cm-sort">
          <option value="none">None</option>
          <option value="desc">High → Low</option>
          <option value="asc">Low → High</option>
        </select>
      </div>
      <div class="cm-field" id="cm-numfmt-field">
        <label class="cm-label" for="cm-numfmt">Number format</label>
        <select class="cm-input cm-select" id="cm-numfmt">
          <option value="auto">Auto (K/M/B)</option>
          <option value="plain">Plain</option>
          <option value="thousands">Thousands (1,234)</option>
          <option value="compact">Compact (1.2K)</option>
          <option value="percent">Percent (12%)</option>
          <option value="currency">Currency ($1,234)</option>
        </select>
      </div>
      <div class="cm-toggle-row" id="cm-smooth-row">
        <span class="cm-toggle-label">Smooth lines</span>
        <button class="cm-switch" id="cm-smooth" role="switch" aria-checked="true" type="button">
          <span class="cm-switch-thumb"></span>
        </button>
      </div>
      <div id="cm-axis-section">
        <div class="cm-field">
          <label class="cm-label" for="cm-x-axis">X axis label</label>
          <input class="cm-input" id="cm-x-axis" type="text" placeholder="X axis" autocomplete="off"/>
        </div>
        <div class="cm-field">
          <label class="cm-label" for="cm-y-axis">Y axis label</label>
          <input class="cm-input" id="cm-y-axis" type="text" placeholder="Y axis" autocomplete="off"/>
        </div>
      </div>
      <button class="cm-reset" id="cm-reset" type="button">Reset to default</button>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}());

// DOM refs inside chart menu (queried once after innerHTML is set)
const cmCopyImg      = document.getElementById('cm-copy-img');
const cmDownload     = document.getElementById('cm-download');
const cmCopyData     = document.getElementById('cm-copy-data');
const cmDrill        = document.getElementById('cm-drill');
const cmExplain      = document.getElementById('cm-explain');
const cmCustomToggle = document.getElementById('cm-customize-toggle');
const cmCustomize    = document.getElementById('cm-customize');
const cmTitleInput   = document.getElementById('cm-title') as HTMLInputElement;
const cmSwatches     = document.getElementById('cm-swatches');
const cmShowLegend   = document.getElementById('cm-show-legend');
const cmLegendPos    = document.getElementById('cm-legend-pos') as HTMLSelectElement;
const cmLegendPosField = document.getElementById('cm-legend-pos-field');
const cmShowGridlines = document.getElementById('cm-show-gridlines');
const cmYZero        = document.getElementById('cm-y-zero');
const cmYZeroRow     = document.getElementById('cm-y-zero-row');
const cmSort         = document.getElementById('cm-sort') as HTMLSelectElement;
const cmSortField    = document.getElementById('cm-sort-field');
const cmNumFmt       = document.getElementById('cm-numfmt') as HTMLSelectElement;
const cmSmooth       = document.getElementById('cm-smooth');
const cmSmoothRow    = document.getElementById('cm-smooth-row');
const cmAxisSection  = document.getElementById('cm-axis-section');
const cmXAxis        = document.getElementById('cm-x-axis') as HTMLInputElement;
const cmYAxis        = document.getElementById('cm-y-axis') as HTMLInputElement;
const cmReset        = document.getElementById('cm-reset');

// Build swatches once
CURATED_COLORS.forEach(({ hex, label }) => {
  const sw = document.createElement('button');
  sw.className = 'cm-swatch';
  sw.type = 'button';
  sw.setAttribute('aria-label', label);
  sw.setAttribute('data-color', hex);
  sw.style.setProperty('--sw-color', hex);
  cmSwatches.appendChild(sw);
});

// ── Image action menu (copy / save / download) ───────────────────────────
const imgActionMenu  = document.getElementById('img-action-menu');
const imgActCopy     = document.getElementById('img-act-copy');
const imgActDownload = document.getElementById('img-act-download');

let _menuDismissHandler = null;

function openImgActionMenu(anchorEl) {
  if (!imgActionMenu) return;
  const rect = anchorEl.getBoundingClientRect();
  const menuW = 192;
  let left = rect.left;
  if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
  imgActionMenu.style.top  = (rect.bottom + 6) + 'px';
  imgActionMenu.style.left = left + 'px';
  imgActionMenu.hidden = false;
  if (_menuDismissHandler) document.removeEventListener('click', _menuDismissHandler, true);
  _menuDismissHandler = (e) => {
    if (!imgActionMenu.contains(e.target)) closeImgActionMenu();
  };
  setTimeout(() => document.addEventListener('click', _menuDismissHandler, true), 0);
}

function closeImgActionMenu() {
  if (imgActionMenu) imgActionMenu.hidden = true;
  if (_menuDismissHandler) {
    document.removeEventListener('click', _menuDismissHandler, true);
    _menuDismissHandler = null;
  }
}

// The capture page's image frame and the image inside it. Looked up here rather
// than borrowed from hubCapture.ts: this file owns the RIGHT-CLICK menu over a
// screenshot, hubCapture.ts owns the page, and one shared mutable reference
// between them is how the two fall out of step.
const capPageFrame = document.getElementById('cap-frame');
const capPageImg = document.getElementById('cap-view-img') as HTMLImageElement | null;

function getImgSrc() {
  if (lightboxImg && imgLightbox && !imgLightbox.hidden && lightboxImg.src) return lightboxImg.src;
  return capPageImg ? capPageImg.src : '';
}

if (imgActCopy) {
  imgActCopy.addEventListener('click', () => {
    closeImgActionMenu();
    const src = getImgSrc();
    if (src && window.hub) { window.hub.copyImage(src); showToast('Screenshot copied to clipboard'); }
  });
}
if (imgActDownload) {
  imgActDownload.addEventListener('click', async () => {
    closeImgActionMenu();
    const src = getImgSrc();
    if (!src || !window.hub) return;
    const result = await window.hub.saveImage(src);
    if (result && result.ok) {
      const name = result.dest ? result.dest.split('/').pop() : 'screenshot';
      showToast(`Saved: ${name}`);
    }
  });
}

if (capPageFrame) {
  // Right-click → options menu. Left-click and Enter/Space open the lightbox and
  // are wired by the page itself (hubCapture.ts), which owns that frame.
  capPageFrame.addEventListener('contextmenu', e => { e.preventDefault(); openImgActionMenu(capPageFrame); });
}
if (lightboxImg) {
  // Right-click on expanded image → options menu
  lightboxImg.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    openImgActionMenu(lightboxImg);
  });
}
if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
if (imgLightbox) {
  imgLightbox.addEventListener('click', e => {
    if (e.target === imgLightbox || (e.target as HTMLElement).classList.contains('lightbox-backdrop')) closeLightbox();
  });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeLightbox(); closeImgActionMenu(); }
});
