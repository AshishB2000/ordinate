'use strict';

// Tag <html> with the OS so the titlebar can pad clear of the native window
// controls (macOS traffic lights on the left, Windows min/max/close on the right).
(() => {
  const p = navigator.platform.toLowerCase();
  document.documentElement.dataset.os = p.includes('mac') ? 'mac' : p.includes('win') ? 'win' : 'linux';
})();

// ── Theme ──────────────────────────────────────────────────────────────────
// Single source of truth is config.themePreference ('system'|'light'|'dark'),
// owned by main. Main resolves it to an effective 'light'|'dark' (via nativeTheme)
// and pushes updates; the renderer only ever applies a concrete light/dark value.
let currentThemePref = 'system';

function applyEffectiveTheme(effective) {
  document.documentElement.dataset.theme = effective === 'dark' ? 'dark' : 'light';
}

// Reflect the active preference on both theme controls (gear menu + settings panel).
function reflectThemeControls() {
  document
    .querySelectorAll('#menu-theme-seg .menu-seg-opt, #stp-theme-seg .stp-seg-opt')
    .forEach(btn => btn.classList.toggle('active', (btn as HTMLElement).dataset.theme === currentThemePref));
}

async function setThemePreference(pref) {
  if (!['system', 'light', 'dark'].includes(pref)) return;
  currentThemePref = pref;
  reflectThemeControls();
  if (window.hub && window.hub.setThemePreference) {
    const res = await window.hub.setThemePreference(pref);
    if (res && res.effective) applyEffectiveTheme(res.effective);
  }
}

// First paint: best-effort from the OS (hidden behind the splash), then correct
// from the saved preference and subscribe to live OS-theme changes.
applyEffectiveTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
(async function initTheme() {
  if (window.hub && window.hub.getThemePreference) {
    try {
      const { preference, effective } = await window.hub.getThemePreference();
      currentThemePref = preference || 'system';
      applyEffectiveTheme(effective);
      reflectThemeControls();
    } catch (_) {}
  }
  if (window.hub && window.hub.onThemeApply) {
    window.hub.onThemeApply(data => { if (data && data.effective) applyEffectiveTheme(data.effective); });
  }
})();

// ── Launch splash ──────────────────────────────────────────────────────────
// Plays once when the hub window loads (every cold start), then fades into the
// hub. The CSS handles prefers-reduced-motion; here we just drive the timing.
(function initSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  const HOLD = 2000; // total time the splash stays visible (ms)
  const OUT  = 620;  // exit animation length (ms), matches .splash.leaving
  // Fill bar runs over the hold window, after the entrance offset (~0.72s).
  document.documentElement.style.setProperty('--splash-fill', ((HOLD - 720) / 1000) + 's');
  splash.classList.add('play');
  setTimeout(() => splash.classList.add('leaving'), HOLD);
  setTimeout(() => { splash.hidden = true; }, HOLD + OUT);
})();

// ── Workspace shell boot ─────────────────────────────────────────────────────
// Wire the project gallery (HOME) + workspace section router, and land on HOME
// first (gallery before any workspace). Defined in projects.ts / workspace.ts,
// which load before hub.js. The existing capture→result surface is the Sources
// section and is otherwise untouched.
(function initWorkspaceShell() {
  initWorkspaceRouter(); // workspace.ts — wires the persistent sidebar nav
  selectSection('home'); // workspace.ts — Home is the default section
  initHome();            // projects.ts
  initDatasets();        // datasets.ts
  initComposer();        // composer.ts — the full-page create surface
  initPrepare();         // prepare.ts
  initConnections();     // connections.ts
  initVisuals();         // visuals.ts
  initDashboards();      // dashboards.ts
  initAnalyses();        // analyses.ts
  initAuthoring();       // authoring.ts — the analysis workbench panels
  initCopilot();         // copilot.ts
  initGlobalSearch();    // globalSearch.ts — the sidebar's search box
})();

// ── Toast ─────────────────────────────────────────────────────────────────
const hubToast = document.getElementById('hub-toast');
let _toastTimer = null;

function showToast(msg) {
  if (!hubToast) return;
  if (_toastTimer) { clearTimeout(_toastTimer); hubToast.classList.remove('hub-toast-fade'); }
  hubToast.textContent = msg;
  hubToast.hidden = false;
  _toastTimer = setTimeout(() => {
    hubToast.classList.add('hub-toast-fade');
    _toastTimer = setTimeout(() => { hubToast.hidden = true; hubToast.classList.remove('hub-toast-fade'); }, 320);
  }, 2200);
}

function _fmtVal(v) {
  if (v == null) return '';
  if (Math.abs(v) >= 1e9) return (v/1e9).toFixed(1) + 'B';
  if (Math.abs(v) >= 1e6) return (v/1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v/1e3).toFixed(1) + 'K';
  return v.toLocaleString();
}

// Number formatter selected by the Customize "Number format" override. `auto`
// (and any unknown mode) delegates to _fmtVal so charts with no override render
// byte-identically to before this control existed. Pure display — never touches
// the app-computed numbers themselves.
function fmtWith(v, mode) {
  if (v == null) return '';
  if (typeof v !== 'number') return String(v);
  switch (mode) {
    case 'plain':     return v.toLocaleString();
    case 'thousands': return Math.round(v).toLocaleString();
    case 'compact':   return _fmtVal(v);
    // Ratio → percent: 0.12 shows as "12%" (matches the "Percent (12%)" label).
    case 'percent':   return (v * 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + '%';
    case 'currency':  return '$' + Math.round(v).toLocaleString();
    default:          return _fmtVal(v);
  }
}

// Bin numeric values into ~sqrt(n) equal-width buckets for a histogram.
// Returns { labels: ["lo–hi", …], counts: [n, …] }. Empty/degenerate inputs are safe.
function histogramBins(values) {
  if (!values.length) return { labels: [], counts: [] };
  const min = Math.min(...values), max = Math.max(...values);
  if (min === max) return { labels: [_fmtVal(min)], counts: [values.length] };
  const k = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(values.length))));
  const width = (max - min) / k;
  const counts = new Array(k).fill(0);
  values.forEach(v => {
    let idx = Math.floor((v - min) / width);
    if (idx >= k) idx = k - 1;        // max value lands in the last bin
    if (idx < 0) idx = 0;
    counts[idx]++;
  });
  const labels = counts.map((_, i) => `${_fmtVal(min + i * width)}–${_fmtVal(min + (i + 1) * width)}`);
  return { labels, counts };
}

// ── Readiness banner → open Execution mode settings (Local CLI + BYOK live there)
const bannerLinkEl = document.getElementById('open-settings-banner');
if (bannerLinkEl) bannerLinkEl.addEventListener('click', () => showSettingsPanel('exec'));

// ── Settings panel (view/edit current config) ────────────────────────────────
const stpPanel       = document.getElementById('settings-panel');
const stpClose       = document.getElementById('stp-close');
const stpHotkeyEl   = document.getElementById('stp-hotkey');
const stpThemeSeg    = document.getElementById('stp-theme-seg');
const stpLoginToggle = document.getElementById('stp-login-toggle');

// ── Settings modal: categories, focus trap, backdrop/Esc close ──────────────
const stpTitleEl = document.getElementById('stp-title');
const stpDialog  = stpPanel ? stpPanel.querySelector('.settings-modal') : null;
const stpCats    = (stpPanel ? Array.from(stpPanel.querySelectorAll('.settings-cat')) : []) as HTMLElement[];
const stpPanes   = (stpPanel ? Array.from(stpPanel.querySelectorAll('.settings-pane')) : []) as HTMLElement[];
const CAT_TITLES = {
  exec: 'Execution mode',
  hotkey: 'Hotkey',
  prompt: 'Instructions / Rules',
  appearance: 'Appearance',
  notifications: 'Notifications',
  general: 'General',
  about: 'About',
};
let stpOpener = null;    // element to refocus when the modal closes
let _stpKeydown = null;  // active keydown handler (Esc + Tab trap) while open

function selectSettingsCat(cat) {
  if (!CAT_TITLES[cat]) cat = 'exec';
  stpCats.forEach(b => {
    const on = b.dataset.cat === cat;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  stpPanes.forEach(p => { p.hidden = p.dataset.cat !== cat; });
  if (stpTitleEl) stpTitleEl.textContent = CAT_TITLES[cat];
}

stpCats.forEach(btn => btn.addEventListener('click', () => selectSettingsCat(btn.dataset.cat)));

// Visible, enabled focusable elements inside the dialog (for the focus trap).
function stpFocusables() {
  if (!stpDialog) return [];
  return Array.from(stpDialog.querySelectorAll(
    'button, select, textarea, input, [href], [tabindex]:not([tabindex="-1"])'
  )).filter((el: any) => !el.disabled && el.offsetParent !== null) as HTMLElement[];
}

// Close when the dim backdrop (outside the dialog) is clicked.
if (stpPanel) {
  stpPanel.addEventListener('click', (e) => { if (e.target === stpPanel) hideSettingsPanel(); });
}

const PROVIDER_DISPLAY = {
  anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini',
  openrouter: 'OpenRouter', ollama: 'Ollama', custom: 'Custom',
};

const PROVIDER_MODELS = {
  anthropic:  [
    { v: 'claude-3-5-sonnet-20241022', l: 'Claude 3.5 Sonnet' },
    { v: 'claude-3-5-haiku-20241022',  l: 'Claude 3.5 Haiku'  },
    { v: 'claude-3-opus-20240229',      l: 'Claude 3 Opus'     },
  ],
  openai:     [
    { v: 'gpt-4o',      l: 'GPT-4o'      },
    { v: 'gpt-4o-mini', l: 'GPT-4o mini' },
    { v: 'gpt-4-turbo', l: 'GPT-4 Turbo' },
  ],
  gemini:     [
    { v: 'gemini-1.5-pro',   l: 'Gemini 1.5 Pro'   },
    { v: 'gemini-1.5-flash', l: 'Gemini 1.5 Flash'  },
  ],
  openrouter: [
    { v: 'openai/gpt-4o',                    l: 'GPT-4o'            },
    { v: 'anthropic/claude-3.5-sonnet',       l: 'Claude 3.5 Sonnet' },
  ],
  ollama: [],
  custom: [],
};

// Settings-panel theme segment reflects the same preference as the gear menu.
function updateStpThemeSeg() {
  reflectThemeControls();
}

// Shared accessibility helper for JS-CONSTRUCTED modal dialogs (promptModal,
// dashChooseModal, capture-review, export dialog, image lightbox). Mirrors the
// static settings panel's pattern (showSettingsPanel below): sets dialog
// semantics, moves focus in, cycles Tab within the modal, and returns focus to
// the opener on teardown. Renderer scripts share one global scope, so this is
// callable from every hub file. Returns { onTabKey, release }: the caller feeds
// Tab keydowns to onTabKey and calls release() when closing.
function makeModalAccessible(
  box: HTMLElement,
  label: string,
  initialFocus?: HTMLElement | null,
): { onTabKey: (e: KeyboardEvent) => void; release: () => void } {
  const opener = document.activeElement as HTMLElement | null; // the trigger, captured before we move focus
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  if (label) box.setAttribute('aria-label', label);
  // `:not([disabled])` is not enough for a modal with more than one pane: the
  // hidden panes' controls are still in the DOM, so the wrap-around below could
  // pick one as first/last and call focus() on a display:none element — which is
  // a no-op, and leaves focus stranded outside the dialog. getClientRects() is
  // empty for exactly the elements that cannot take focus for that reason.
  const focusables = (): HTMLElement[] =>
    Array.from(box.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((el) => el.getClientRects().length > 0);
  const onTabKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const target = initialFocus || focusables()[0] || box;
  if (target && typeof (target as HTMLElement).focus === 'function') (target as HTMLElement).focus();
  const release = (): void => {
    if (opener && typeof opener.focus === 'function') opener.focus();
  };
  return { onTabKey, release };
}

async function showSettingsPanel(cat?) {
  if (!stpPanel) return;

  // Remember what to refocus on close (the button/row that opened the modal).
  stpOpener = document.activeElement;

  // Always refresh hotkey display in case it changed since last open
  if (stpHotkeyEl) {
    try {
      const { label } = await window.hub.getHotkeyLabel();
      stpRenderHotkeyDisplay(label);
    } catch (_) {
      stpRenderHotkeyDisplay('–');
    }
  }

  // Refresh the Execution mode (BYOK) pane from config.
  await refreshExecPane();

  updateStpThemeSeg();
  selectSettingsCat(cat || 'exec');
  stpPanel.style.display = 'flex';

  // Focus trap + Escape, active only while the modal is open.
  _stpKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideSettingsPanel();
      return;
    }
    if (e.key === 'Tab') {
      const f = stpFocusables();
      if (!f.length) return;
      const first = f[0];
      const last  = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', _stpKeydown, true);

  // Start focus on the active category for keyboard users.
  const activeCat = stpCats.find(b => b.classList.contains('active'));
  if (activeCat) activeCat.focus();
}

function hideSettingsPanel() {
  stpStopRecording();
  if (_stpKeydown) { document.removeEventListener('keydown', _stpKeydown, true); _stpKeydown = null; }
  if (stpPanel) stpPanel.style.display = 'none';
  if (stpOpener && typeof stpOpener.focus === 'function') { stpOpener.focus(); }
  stpOpener = null;
}

if (stpClose) stpClose.addEventListener('click', hideSettingsPanel);

// Fill the About panel version dynamically from package.json (app.getVersion via
// the preload) — never hardcoded, so it tracks every version bump.
const stpVersionEl = document.querySelector('.stp-version');
if (stpVersionEl) {
  const v = (window.hub && window.hub.appVersion) || '';
  stpVersionEl.textContent = v ? `Ordinate ${v}` : 'Ordinate';
}

const stpAbout = document.getElementById('stp-about');
// The About link opens the public website in the default browser (not in-app).
if (stpAbout) stpAbout.addEventListener('click', () => {
  if (window.hub && typeof window.hub.openExternal === 'function') window.hub.openExternal(WEBSITE_URL);
});

const stpGithubLink = document.getElementById('stp-github-link');
if (stpGithubLink) {
  stpGithubLink.addEventListener('click', () => {
    if (window.hub && typeof window.hub.openExternal === 'function') window.hub.openExternal(GITHUB_URL);
  });
}

const stpTestPerm = document.getElementById('stp-test-perm');
if (stpTestPerm) stpTestPerm.addEventListener('click', () => { hideSettingsPanel(); showPermissionPanel(); });

if (stpThemeSeg) {
  stpThemeSeg.addEventListener('click', e => {
    const opt = (e.target as HTMLElement).closest('.stp-seg-opt[data-theme]') as HTMLElement;
    if (opt) setThemePreference(opt.dataset.theme);
  });
}

if (stpLoginToggle) {
  stpLoginToggle.addEventListener('click', () => {
    const on = stpLoginToggle.classList.toggle('stp-switch-on');
    stpLoginToggle.setAttribute('aria-checked', String(on));
  });
}

// ── Permission panel ─────────────────────────────────────────────────────────
//
// Screen Recording permission. Two entry points existed and BOTH were dead:
//   1. main.ts `openPermission()` sends `hub:show-permission` when a capture is
//      blocked. The preload exposes `onShowPermission`, but nothing subscribed.
//   2. Settings → General → "Test permission screen" calls `showPermissionPanel()`,
//      which was declared in globals.d.ts and defined NOWHERE — so the button
//      threw a ReferenceError.
// The markup (#permission-panel) and its styles shipped fully built, and none of
// its three buttons was wired either. This connects all of it.

const permPanel = document.getElementById('permission-panel');
const permClose = document.getElementById('permission-close');
const permOpenSettings = document.getElementById('perm-open-settings');
const permDone = document.getElementById('perm-done');
let permOpener: Element | null = null;
let _permKeydown: ((e: KeyboardEvent) => void) | null = null;

function showPermissionPanel(): void {
  if (!permPanel) return;
  // Remember what to refocus on close, matching hideSettingsPanel's behaviour.
  permOpener = document.activeElement;
  permPanel.style.display = 'flex';
  if (permOpenSettings && typeof permOpenSettings.focus === 'function') permOpenSettings.focus();
  _permKeydown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); hidePermissionPanel(); } };
  document.addEventListener('keydown', _permKeydown, true);
}

function hidePermissionPanel(): void {
  if (_permKeydown) { document.removeEventListener('keydown', _permKeydown, true); _permKeydown = null; }
  if (permPanel) permPanel.style.display = 'none';
  if (permOpener && typeof (permOpener as HTMLElement).focus === 'function') (permOpener as HTMLElement).focus();
  permOpener = null;
}

if (permClose) permClose.addEventListener('click', hidePermissionPanel);
if (permDone) permDone.addEventListener('click', hidePermissionPanel);
if (permOpenSettings) {
  permOpenSettings.addEventListener('click', () => {
    // Opens macOS System Settings → Privacy & Security → Screen Recording. The
    // panel stays up: the user grants permission over there and comes back.
    try { window.hub.openSystemSettings(); } catch (_) {}
  });
}

// The push from main. Without this, a blocked capture opened the hub and then
// showed nothing at all.
if (window.hub && typeof window.hub.onShowPermission === 'function') {
  window.hub.onShowPermission(showPermissionPanel);
}
