'use strict';

// Tag <html> with the OS so the titlebar can pad clear of the native window
// controls (macOS traffic lights on the left, Windows min/max/close on the right).
(() => {
  const p = navigator.platform.toLowerCase();
  document.documentElement.dataset.os = p.includes('mac') ? 'mac' : p.includes('win') ? 'win' : 'linux';
})();

// ── Hotkey label helpers ──────────────────────────────────────────────────
// Split a label like "⌘ ⇧ S" or "Ctrl + Alt + S" into individual key tokens.
function labelToKeys(label) {
  return label.split(' ').filter(k => k !== '+');
}

// Mirror of main's hotkeyLabel() — used in the renderer for live recorder preview.
function accelToLabel(accelerator) {
  const mac = navigator.platform.toLowerCase().includes('mac');
  const parts = (accelerator || '').split('+');
  if (mac) {
    return parts.map(p => {
      switch (p.toLowerCase()) {
        case 'commandorcontrol': case 'command': case 'cmd': return '⌘';
        case 'shift': return '⇧';
        case 'alt': case 'option': return '⌥';
        case 'control': case 'ctrl': return '⌃';
        default: return p.toUpperCase();
      }
    }).join(' ');
  }
  return parts.map(p => {
    switch (p.toLowerCase()) {
      case 'commandorcontrol': case 'command': case 'cmd':
      case 'control': case 'ctrl': return 'Ctrl';
      case 'shift': return 'Shift';
      case 'alt': case 'option': return 'Alt';
      default: return p.toUpperCase();
    }
  }).join(' + ');
}

// Map a KeyboardEvent.key to an Electron accelerator key name.
// Uses e.code (physical key position) so Alt/Option combos on macOS don't produce
// special Unicode characters that break recognition.
function keyToAccelKey(code) {
  if (/^Key([A-Z])$/.test(code)) return code.slice(3);       // KeyS → S
  if (/^Digit(\d)$/.test(code)) return code.slice(5);        // Digit1 → 1
  if (/^F(\d+)$/.test(code)) return code;                    // F1, F12
  const MAP = {
    Space: 'Space', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete',
    Tab: 'Tab', Escape: 'Escape', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Backquote: '`',
  };
  return MAP[code] || null;
}

async function applyHotkeyLabel() {
  if (!window.hub || typeof window.hub.getHotkeyLabel !== 'function') return;
  try {
    const { label } = await window.hub.getHotkeyLabel();
    const hotkeyHintEl = document.getElementById('hotkey-hint');
    if (hotkeyHintEl) hotkeyHintEl.textContent = label;
    const stepKeysEl = document.getElementById('step-hotkey-keys');
    if (stepKeysEl) {
      stepKeysEl.innerHTML = labelToKeys(label).map(k => `<kbd>${k}</kbd>`).join(' ');
    }
  } catch (_) {}
}
applyHotkeyLabel();

// ── Hotkey registration failure banner ────────────────────────────────────
const hotkeyFailBanner   = document.getElementById('hotkey-fail-banner');
const hotkeyFailMsg      = document.getElementById('hotkey-fail-msg');
const hotkeyFailChange   = document.getElementById('hotkey-fail-change');
const hotkeyFailDismiss  = document.getElementById('hotkey-fail-dismiss');

if (window.hub && typeof window.hub.onHotkeyState === 'function') {
  window.hub.onHotkeyState((data) => {
    // Success → hide the banner; failure → show it with the real label.
    if (data && data.registered) {
      if (hotkeyFailBanner) hotkeyFailBanner.style.display = 'none';
      return;
    }
    const label = data && data.label;
    if (hotkeyFailMsg) {
      hotkeyFailMsg.textContent = label
        ? `Couldn't register ${label} — it may already be in use by another app.`
        : `Couldn't register the shortcut — it may already be in use by another app.`;
    }
    if (hotkeyFailBanner) hotkeyFailBanner.style.display = 'flex';
  });
}

if (hotkeyFailChange) {
  // Open Settings at the Hotkey category, where the recorder lets the user rebind.
  hotkeyFailChange.addEventListener('click', () => { showSettingsPanel('hotkey'); });
}
if (hotkeyFailDismiss) {
  hotkeyFailDismiss.addEventListener('click', () => {
    if (hotkeyFailBanner) hotkeyFailBanner.style.display = 'none';
  });
}

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
  const win = document.querySelector('.win');
  if (win) win.setAttribute('data-view', 'home');
  initWorkspaceRouter(); // workspace.ts
  initHome();            // projects.ts
  initDatasets();        // datasets.ts
  initPrepare();         // prepare.ts
  initConnections();     // connections.ts
  initVisuals();         // visuals.ts
  initDashboards();      // dashboards.ts
  initAnalyses();        // analyses.ts
  initCopilot();         // copilot.ts
})();

// ── Settings menu popup (top-right gear) ────────────────────────────────────
const GITHUB_URL = 'https://github.com/AshishB2000/screenchart';

// ── Help menu destinations ──────────────────────────────────────────────────
// Single source for the Help menu links — keep them here so they're a one-line
// swap. Opened in the default browser via shell.openExternal (never in-app).
const HELP_URL            = 'https://github.com/AshishB2000/screenchart/issues/new/choose';
const FEATURE_REQUEST_URL = 'https://github.com/AshishB2000/screenchart/issues/new/choose';
// While we're shipping pre-releases, point "What's new" at the full releases list.
// Once we ship a non-prerelease, switch this to /releases/latest.
const WHATS_NEW_URL       = 'https://github.com/AshishB2000/screenchart/releases';
// screenchart.app isn't deployed yet — point the "Website" links at the live
// GitHub repo (a real page) until the site ships, mirroring the SHARE_URL decision
// below. TODO: switch back to https://screenchart.app once the site is deployed.
const WEBSITE_URL         = GITHUB_URL;
// GITHUB_URL (above) is reused for the GitHub row.
const HELP_LINKS = {
  help:     HELP_URL,
  feature:  FEATURE_REQUEST_URL,
  whatsnew: WHATS_NEW_URL,
  website:  WEBSITE_URL,
  github:   GITHUB_URL,
};

// Share row. Every social button carries this one URL for its preview card — a
// share link can only attach a single url. screenchart.app isn't deployed yet
// (blank preview), so we point at the live GitHub repo, which renders a proper
// card.
// TODO: switch shared URL to https://screenchart.app once the site is deployed with OG tags
const SHARE_URL  = GITHUB_URL;
// NOTE: LinkedIn (share-offsite) and Facebook (sharer) accept a URL only and
// ignore SHARE_TEXT — they pull the page's own OpenGraph title/description. The
// other four carry the text. Colon (not em-dash) so the encoded text reads clean.
const SHARE_TEXT = 'Screenchart: screenshot any chart, table, or data and get instant AI analysis. Local-first, bring your own key.';

const _enc = encodeURIComponent;
const SHARE_LINKS = {
  x:        `https://twitter.com/intent/tweet?url=${_enc(SHARE_URL)}&text=${_enc(SHARE_TEXT)}`,
  linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${_enc(SHARE_URL)}`,
  facebook: `https://www.facebook.com/sharer/sharer.php?u=${_enc(SHARE_URL)}`,
  reddit:   `https://www.reddit.com/submit?url=${_enc(SHARE_URL)}&title=${_enc(SHARE_TEXT)}`,
  telegram: `https://t.me/share/url?url=${_enc(SHARE_URL)}&text=${_enc(SHARE_TEXT)}`,
  whatsapp: `https://wa.me/?text=${_enc(SHARE_TEXT + ' ' + SHARE_URL)}`,
};

const settingsGear = document.getElementById('settings-gear');
const settingsMenu = document.getElementById('settings-menu');
const menuThemeSeg = document.getElementById('menu-theme-seg');
let _smDismiss = null;
let _smEsc = null;

function openSettingsMenu() {
  if (!settingsMenu || !settingsGear) return;
  closeExecMenu();
  settingsMenu.hidden = false;
  // Anchor the panel under the gear, right-aligned, clamped to the viewport.
  const r = settingsGear.getBoundingClientRect();
  let left = r.right - settingsMenu.offsetWidth;
  if (left < 12) left = 12;
  settingsMenu.style.left = left + 'px';
  settingsMenu.style.top  = (r.bottom + 6) + 'px';
  settingsGear.setAttribute('aria-expanded', 'true');
  reflectThemeControls();
  _smDismiss = (e) => {
    if (!settingsMenu.contains(e.target) && !settingsGear.contains(e.target)) closeSettingsMenu();
  };
  _smEsc = (e) => { if (e.key === 'Escape') { closeSettingsMenu(); settingsGear.focus(); } };
  document.addEventListener('click', _smDismiss, true);
  document.addEventListener('keydown', _smEsc, true);
}

function closeSettingsMenu() {
  if (!settingsMenu) return;
  settingsMenu.hidden = true;
  if (settingsGear) settingsGear.setAttribute('aria-expanded', 'false');
  if (_smDismiss) { document.removeEventListener('click', _smDismiss, true); _smDismiss = null; }
  if (_smEsc)     { document.removeEventListener('keydown', _smEsc, true);  _smEsc = null; }
}

if (settingsGear) {
  settingsGear.addEventListener('click', (e) => {
    e.stopPropagation();
    if (settingsMenu.hidden) openSettingsMenu(); else closeSettingsMenu();
  });
}

if (menuThemeSeg) {
  menuThemeSeg.addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement).closest('.menu-seg-opt[data-theme]') as HTMLElement;
    if (opt) setThemePreference(opt.dataset.theme);
  });
}

if (settingsMenu) {
  settingsMenu.querySelectorAll('.sm-share[data-share]').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = SHARE_LINKS[(btn as HTMLElement).dataset.share];
      if (url && window.hub && window.hub.openExternal) window.hub.openExternal(url);
      closeSettingsMenu();
      if (settingsGear) settingsGear.focus();
    });
  });
}

const smGithubBtn = document.getElementById('sm-github');
if (smGithubBtn) {
  smGithubBtn.addEventListener('click', () => {
    if (window.hub && window.hub.openExternal) window.hub.openExternal(GITHUB_URL);
    closeSettingsMenu();
    if (settingsGear) settingsGear.focus();
  });
}

const smSettingsBtn = document.getElementById('sm-settings');
if (smSettingsBtn) {
  smSettingsBtn.addEventListener('click', () => {
    closeSettingsMenu();
    showSettingsPanel();
  });
}

// ── Help menu popup (bottom-left help button) ───────────────────────────────
// Same anchored-panel pattern as the settings menu, but opens UPWARD from the
// sidebar footer. Each row opens its HELP_LINKS URL in the default browser.
const helpBtn  = document.getElementById('help-btn');
const helpMenu = document.getElementById('help-menu');
let _hmDismiss = null;
let _hmEsc = null;

function openHelpMenu() {
  if (!helpMenu || !helpBtn) return;
  closeSettingsMenu();
  closeExecMenu();
  helpMenu.hidden = false;
  // Anchor above the button (footer sits at the bottom), left-aligned, clamped.
  const r = helpBtn.getBoundingClientRect();
  let left = r.left;
  if (left + helpMenu.offsetWidth > window.innerWidth - 12) {
    left = window.innerWidth - 12 - helpMenu.offsetWidth;
  }
  if (left < 12) left = 12;
  let top = r.top - helpMenu.offsetHeight - 6;
  if (top < 12) top = r.bottom + 6; // not enough room above → drop below
  helpMenu.style.left = left + 'px';
  helpMenu.style.top  = top + 'px';
  helpBtn.setAttribute('aria-expanded', 'true');
  _hmDismiss = (e) => {
    if (!helpMenu.contains(e.target) && !helpBtn.contains(e.target)) closeHelpMenu();
  };
  _hmEsc = (e) => { if (e.key === 'Escape') { closeHelpMenu(); helpBtn.focus(); } };
  document.addEventListener('click', _hmDismiss, true);
  document.addEventListener('keydown', _hmEsc, true);
}

function closeHelpMenu() {
  if (!helpMenu) return;
  helpMenu.hidden = true;
  if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
  if (_hmDismiss) { document.removeEventListener('click', _hmDismiss, true); _hmDismiss = null; }
  if (_hmEsc)     { document.removeEventListener('keydown', _hmEsc, true);  _hmEsc = null; }
}

if (helpBtn) {
  helpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (helpMenu.hidden) openHelpMenu(); else closeHelpMenu();
  });
}

if (helpMenu) {
  helpMenu.querySelectorAll('.sm-row[data-help]').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = HELP_LINKS[(btn as HTMLElement).dataset.help];
      if (url && window.hub && window.hub.openExternal) window.hub.openExternal(url);
      closeHelpMenu();
      if (helpBtn) helpBtn.focus();
    });
  });
}

// ── Execution mode menu popup (top-right chip button) ───────────────────────
// Reflects the REAL execution state (M1–M4): MODE = Cloud (BYOK providers) /
// Local (detected CLIs). MODE persists executionMode; AGENT/MODEL read & write
// the same config (byok block / localCli) the Settings modal uses. The active
// agent's brand logo becomes the button icon.
const BYOK_AGENTS  = ['anthropic', 'openai', 'gemini', 'gateway'];
const BYOK_DISPLAY = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', gateway: 'Gateway' };
// Local CLIs with a working run adapter — keep in sync with src/analyze.js.
const RUNNABLE_LOCAL = ['claude', 'antigravity', 'codex', 'grok', 'opencode', 'cursor'];
// Local CLIs that expose a model picker — all runnable CLIs now do. Static lists:
// Claude Code, Codex (curated in src/localCli.js). Live lists run the CLI's own
// command (see LIVE_MODEL_CLIS) and so also get the ↻ refresh button.
const MODEL_LIST_CLIS = ['antigravity', 'claude', 'codex', 'grok', 'opencode', 'cursor'];
const LIVE_MODEL_CLIS = ['antigravity', 'grok', 'opencode', 'cursor'];

// Shared providerId → real brand icon, resolved deterministically in MAIN from
// explicit simple-icons exports (src/icons.js). { path, color } per provider;
// providers without a real mark are simply absent → styled badge below.
const PROVIDER_LOGOS = (window.hub && window.hub.providerLogos) || {};
// Full-color logos (data URIs) for marks not in simple-icons, e.g. Antigravity.
// Present only when a file exists in renderer/hub/assets/agents/<id>.svg|png.
const AGENT_LOGOS = (window.hub && window.hub.agentLogos) || {};
// Diagnostic: which ids resolved to a real logo file. Anything the app shows
// that's NOT listed here falls back to a styled brand badge.
console.log('[logos] file assets present for:', Object.keys(AGENT_LOGOS).sort().join(', ') || '(none)');

const execBtn          = document.getElementById('exec-mode-btn');
const execMenu         = document.getElementById('exec-menu');
const execModeSeg      = document.getElementById('exec-mode-seg');
const execAgentList    = document.getElementById('exec-agent-list');
const execModelSel     = document.getElementById('exec-model-sel') as HTMLInputElement;
const execModelDl      = document.getElementById('exec-model-dl');
// Local CLI / BYOK model picker — a custom dropdown (native <select> popups are
// OS-rendered and overflow the window for long lists). Mounted where the old
// <select id="exec-model-cli"> sat, just before the hint.
const execModelCli     = makeDropdown({ className: 'exec-model-dd', ariaLabel: 'Model', onChange: onExecModelChange });
const execModelRefresh = document.getElementById('exec-model-refresh');
const execModelHint    = document.getElementById('exec-model-hint');
if (execModelHint && execModelHint.parentNode) execModelHint.parentNode.insertBefore(execModelCli.el, execModelHint);
execModelCli.hidden = true;
const execOpenSettings = document.getElementById('exec-open-settings');

let _execDismiss = null;
let _execEsc = null;
let execMode  = 'local';                                   // 'byok' | 'local'
let execByok: any  = { activeProvider: 'anthropic', providers: {} };
let execLocal: any = { activeId: null, clis: [] };
let execDidScan = false;                                  // background CLI scan done once

// Brand-colored badge class for agents with NO simple-icon glyph, so the
// fallback reads as an intentional brand mark (not a gray letter). CSS classes
// because the hub CSP blocks inline styles — see .exec-agent-mono.brand-* .
const BRAND_BADGE = {
  openai: 'brand-openai', gateway: 'brand-gateway',
  codex: 'brand-openai', grok: 'brand-grok', antigravity: 'brand-antigravity',
};

// Build logo markup for an agent, in priority order:
//  1. a full-color logo asset (e.g. Antigravity's gradient PNG/SVG), if present;
//  2. a real simple-icon in its brand color (or currentColor when near mono, the
//     contrast safeguard) — resolved deterministically in MAIN;
//  3. a styled brand badge (solid color tile + letter), never a faint gray glyph.
// The `fill` ATTRIBUTE (not inline style) keeps this CSP-safe.
// Pure-black brand marks vanish on the dark theme — sit them on a light chip so
// they read on both. ponytail: add an id here only if its logo is mono black/white.
const TILE_IDS = new Set(['openai', 'grok', 'opencode']);

if (execModelRefresh) {
  execModelRefresh.addEventListener('click', () => {
    if (execMode === 'byok') {
      renderByokModelSelect(execByok.activeProvider || 'anthropic', true);
    } else if (execMode === 'local' && LIVE_MODEL_CLIS.includes(execLocal.activeId)) {
      renderCliModelSelect(execLocal.activeId, true); // re-run the CLI's list command
    }
  });
}

// Local-CLI / BYOK model picker change — persists to the same config the settings
// pane writes (one source of truth via cli:saveModel / saveByokProvider). Hoisted
// so the makeDropdown(onChange) above can reference it.
function onExecModelChange() {
  const val = (execModelCli.value || '').trim();
  if (execMode === 'byok') {
    const prov = execByok.activeProvider || 'anthropic';
    if (window.hub && typeof window.hub.saveByokProvider === 'function') {
      window.hub.saveByokProvider(prov, { model: val }).catch(() => {});
    }
    if (execByok.providers && execByok.providers[prov]) execByok.providers[prov].model = val;
    return;
  }
  const id = execLocal.activeId;
  if (!MODEL_LIST_CLIS.includes(id)) return;
  if (window.hub && typeof window.hub.saveCliModel === 'function') {
    window.hub.saveCliModel(id, val).catch(() => {});
  }
  execLocal.models = { ...(execLocal.models || {}), [id]: val };
}

if (execBtn) {
  execBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (execMenu.hidden) openExecMenu(); else closeExecMenu();
  });
}

if (execModeSeg) {
  execModeSeg.addEventListener('click', async (e) => {
    const opt = (e.target as HTMLElement).closest('.menu-seg-opt[data-mode]') as HTMLElement;
    if (!opt) return;
    execMode = opt.dataset.mode; // 'byok' | 'local'
    if (window.hub && typeof window.hub.setExecutionMode === 'function') {
      await window.hub.setExecutionMode(execMode).catch(() => {});
    }
    renderExecModeSeg();
    renderExecAgents();
    renderExecModel();
    updateExecBtnIcon();
  });
}

if (execModelSel) {
  execModelSel.addEventListener('change', () => {
    const val = execModelSel.value.trim();
    if (execMode === 'local') {
      const id = execLocal.activeId;
      if (id !== 'antigravity') return; // other CLIs have no model selection
      if (window.hub && typeof window.hub.saveCliModel === 'function') {
        window.hub.saveCliModel(id, val).catch(() => {});
      }
      execLocal.models = { ...(execLocal.models || {}), [id]: val };
      return;
    }
    const prov = execByok.activeProvider || 'anthropic';
    if (window.hub && typeof window.hub.saveByokProvider === 'function') {
      window.hub.saveByokProvider(prov, { model: val }).catch(() => {});
    }
    if (execByok.providers && execByok.providers[prov]) {
      execByok.providers[prov].model = val;
    }
  });
}

if (execOpenSettings) {
  execOpenSettings.addEventListener('click', () => {
    closeExecMenu();
    showSettingsPanel('exec');
  });
}

// Reflect the active agent's logo on the button before the menu is ever opened.
(function initExecButtonIcon() {
  if (!execBtn || !window.hub || typeof window.hub.getKeyStatus !== 'function') return;
  window.hub.getKeyStatus().then(status => {
    execMode = (status && status.executionMode) || 'local';
    execByok = (status && status.byok) || execByok;
    execLocal = (status && status.localCli) || execLocal;
    updateExecBtnIcon();
  }).catch(() => {});
})();

// ── Key status ────────────────────────────────────────────────────────────
const keyBadge      = document.getElementById('key-badge');
const keyBadgeLabel = document.getElementById('key-badge-label');
const apiBanner     = document.getElementById('api-banner');

// Reflect execution READINESS (Local CLI connected OR a validated BYOK provider),
// not just an API key. The status pill + the empty-state banner follow this.
function applyReadiness(ready) {
  if (keyBadge) {
    keyBadge.className = ready ? 'api-chip key-ok' : 'api-chip key-missing';
  }
  if (keyBadgeLabel) {
    keyBadgeLabel.textContent = ready ? 'AI connected' : 'AI not connected';
  }
  if (apiBanner) {
    // Use style.display directly — author CSS (display:flex) must not fight the hidden attr.
    apiBanner.style.display = ready ? 'none' : 'flex';
  }
}

// Start pessimistic (not ready) until IPC confirms otherwise.
applyReadiness(false);

async function refreshKeyStatus() {
  if (!window.hub || typeof window.hub.getKeyStatus !== 'function') return;
  try {
    const status = await window.hub.getKeyStatus();
    applyReadiness(Boolean(status && status.isReady));
    // Keep the top-right exec button in sync with the real connection state
    // (connect/disconnect/switch/delete all funnel through key:changed → here).
    if (status) {
      execMode  = status.executionMode || execMode;
      if (status.byok)     execByok  = status.byok;
      if (status.localCli) execLocal = status.localCli;
      updateExecBtnIcon();
    }
    if (status && status.notifications) applyNotifPrefs(status.notifications);
    // Load global rules into the box (don't clobber while the user is typing).
    if (stpPromptEl && status && typeof status.globalRules === 'string'
        && document.activeElement !== stpPromptEl) {
      stpPromptEl.value = status.globalRules;
    }
  } catch (_) {
    // IPC unavailable; leave as "not ready" — the safe default.
    applyReadiness(false);
  }
}

// ── Completion notifications (settings + sound) ─────────────────────────────
// Cached so the completion handlers can decide whether to beep without an async
// round-trip. Desktop notifications fire in MAIN; the sound plays here.
let notifPrefs = { sound: false, desktop: false };
const stpNotifSound   = document.getElementById('stp-notif-sound');
const stpNotifDesktop = document.getElementById('stp-notif-desktop');

// Instructions / Rules box → config.globalRules (debounced; empty allowed).
const stpPromptEl = document.getElementById('stp-prompt') as HTMLTextAreaElement;
if (stpPromptEl) {
  let rulesTimer = null;
  stpPromptEl.addEventListener('input', () => {
    if (rulesTimer) clearTimeout(rulesTimer);
    rulesTimer = setTimeout(() => {
      if (window.hub && typeof window.hub.setGlobalRules === 'function') {
        window.hub.setGlobalRules(stpPromptEl.value).catch(() => {});
      }
    }, 400);
  });
}

function reflectSwitch(btn, on) {
  if (!btn) return;
  btn.classList.toggle('stp-switch-on', !!on);
  btn.setAttribute('aria-checked', String(!!on));
}

function applyNotifPrefs(n) {
  notifPrefs = { sound: !!n.sound, desktop: !!n.desktop };
  reflectSwitch(stpNotifSound, notifPrefs.sound);
  reflectSwitch(stpNotifDesktop, notifPrefs.desktop);
}

async function setNotif(field, value) {
  notifPrefs = { ...notifPrefs, [field]: value };
  if (window.hub && typeof window.hub.setNotifications === 'function') {
    try { await window.hub.setNotifications({ [field]: value }); } catch (_) {}
  }
}

if (stpNotifSound) {
  stpNotifSound.addEventListener('click', () => {
    const on = !stpNotifSound.classList.contains('stp-switch-on');
    reflectSwitch(stpNotifSound, on);
    setNotif('sound', on);
    if (on) playCompletionSound(); // immediate preview so the user hears it
  });
}
if (stpNotifDesktop) {
  stpNotifDesktop.addEventListener('click', async () => {
    const on = !stpNotifDesktop.classList.contains('stp-switch-on');
    reflectSwitch(stpNotifDesktop, on);
    setNotif('desktop', on);
    // On enable, register with the OS now (so the app shows in System Settings →
    // Notifications) rather than lazily on the first unfocused completion. macOS
    // doesn't report allow/deny to us, so nudge the user toward System Settings.
    if (on && window.hub && typeof window.hub.bootstrapNotifications === 'function') {
      try {
        const r = await window.hub.bootstrapNotifications();
        if (r && r.supported === false) showToast('Desktop notifications aren’t supported on this system.');
        else showToast('Sent a test notification. If it didn’t appear, allow Screenchart in System Settings → Notifications.');
      } catch (_) { /* never block the toggle */ }
    }
  });
}

// Short synthesized beep via Web Audio — no bundled asset, no network. Wrapped
// so a missing/blocked AudioContext can never throw into the analysis flow.
function playCompletionSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => { try { ctx.close(); } catch (_) {} };
  } catch (_) { /* best-effort: never block the result */ }
}

// ── Delete my data (General → Privacy). The confirm dialog + actual deletion
// happen in MAIN; here we just trigger it and reflect the reset state. ────────
const stpDeleteResult = document.getElementById('stp-delete-result');
document.querySelectorAll('[data-delete]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const scope = btn.getAttribute('data-delete');
    if (!window.hub || typeof window.hub.deleteData !== 'function') return;
    if (stpDeleteResult) { stpDeleteResult.hidden = false; stpDeleteResult.textContent = 'Waiting for confirmation…'; }
    try {
      const r = await window.hub.deleteData(scope);
      if (r && r.cancelled) { if (stpDeleteResult) stpDeleteResult.hidden = true; return; }
      if (r && r.ok) {
        if (stpDeleteResult) stpDeleteResult.textContent = 'Deleted. ' + (r.removed || []).join(' · ');
        // Main also pushed key:changed + (for history) hub:history []. Refresh the
        // visible settings/provider state so it shows disconnected/empty now.
        await refreshKeyStatus();
        if (typeof refreshExecPane === 'function') refreshExecPane();
      } else if (stpDeleteResult) {
        stpDeleteResult.textContent = 'Couldn’t delete. Try again.';
      }
    } catch (_) {
      if (stpDeleteResult) stpDeleteResult.textContent = 'Couldn’t delete. Try again.';
    }
  });
});

refreshKeyStatus();

if (window.hub && typeof window.hub.onKeyChanged === 'function') {
  window.hub.onKeyChanged(() => refreshKeyStatus());
}

// Main asks us to open settings (e.g. New capture while not ready) → open the
// settings modal at the requested category (Execution mode by default).
if (window.hub && typeof window.hub.onOpenSettings === 'function') {
  window.hub.onOpenSettings((cat) => showSettingsPanel(cat || 'exec'));
}

// ── Capture ───────────────────────────────────────────────────────────────
// The readiness gate (executionReady) lives in main.js — if not ready, main
// opens the Execution mode settings instead of capturing. Renderer sends intent.
function doCapture() {
  if (window.hub && typeof window.hub.takeScreenshot === 'function') {
    window.hub.takeScreenshot();
  }
}

['take-shot-main', 'new-capture'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', doCapture);
});

// ── In-memory capture history ──────────────────────────────────────────────
// Each entry: { id, dataUrl, cropPath, state, result, error, title, turns, activeVizType, updatedAt }
// state: 'loading' | 'result' | 'error' | 'disk' (loaded from history, full data not yet fetched)
const entries = [];
let currentEntryId = null;
const captureHistoryEl = document.getElementById('capture-history');
const sideEmptyEl      = document.querySelector('.side-empty') as HTMLElement;

function getEntry(id) {
  return entries.find(e => e.id === id);
}

function formatSidebarTime(dateOrString) {
  const d = typeof dateOrString === 'string' ? new Date(dateOrString) : (dateOrString || new Date());
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Build a sidebar item. `entry` may have `dataUrl` (in-session) or `cropPath` (from disk).
// Appends to the list when `prepend` is false, otherwise inserts at top.
function renderSidebarItem(entry, prepend = true) {
  if (!captureHistoryEl) return;
  if (sideEmptyEl) sideEmptyEl.style.display = 'none';
  captureHistoryEl.style.display = 'flex';

  const item = document.createElement('div');
  item.className = 'cap-hist-item';
  item.dataset.entryId = String(entry.id);

  const thumb = document.createElement('img');
  thumb.className = 'cap-hist-thumb';
  if (entry.dataUrl) {
    thumb.src = entry.dataUrl;
  } else if (entry.cropPath) {
    thumb.src = 'file://' + entry.cropPath;
  }
  thumb.alt = '';
  thumb.draggable = false;

  const info = document.createElement('div');
  info.className = 'cap-hist-info';

  const summary = document.createElement('div');
  summary.className = 'cap-hist-summary';
  summary.id = 'hist-summary-' + entry.id;
  summary.textContent = entry.state === 'loading' ? 'Analyzing…'
    : (entry.title || (entry.state === 'error' ? 'Analysis failed' : 'Analysis'));

  const time = document.createElement('div');
  time.className = 'cap-hist-time';
  time.textContent = formatSidebarTime(entry.updatedAt || null);

  // Delete button (visible on hover via CSS)
  const delBtn = document.createElement('button');
  delBtn.className = 'cap-hist-del';
  delBtn.type = 'button';
  delBtn.setAttribute('aria-label', 'Delete');
  delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    deleteEntry(entry.id);
  });

  info.appendChild(summary);
  info.appendChild(time);
  item.appendChild(thumb);
  item.appendChild(info);
  item.appendChild(delBtn);
  item.addEventListener('click', () => selectEntry(entry.id));

  if (prepend) {
    captureHistoryEl.insertBefore(item, captureHistoryEl.firstChild);
  } else {
    captureHistoryEl.appendChild(item);
  }
  filterSidebar();
}

// ── Sidebar search ─────────────────────────────────────────────────────────
const capSearchEl = document.getElementById('cap-search') as HTMLInputElement;

// Show only capture items whose title/summary contains the query (case-insensitive).
function filterSidebar() {
  if (!captureHistoryEl) return;
  const q = (capSearchEl ? capSearchEl.value : '').trim().toLowerCase();
  captureHistoryEl.querySelectorAll('.cap-hist-item').forEach(item => {
    const summary = item.querySelector('.cap-hist-summary');
    const text = (summary ? summary.textContent : '').toLowerCase();
    (item as HTMLElement).style.display = !q || text.includes(q) ? '' : 'none';
  });
}

if (capSearchEl) capSearchEl.addEventListener('input', filterSidebar);

function updateSidebarItem(entry) {
  const summaryEl = document.getElementById('hist-summary-' + entry.id);
  if (!summaryEl) return;
  if (entry.state === 'loading') {
    summaryEl.textContent = 'Analyzing…';
  } else if (entry.state === 'error') {
    summaryEl.textContent = 'Analysis failed';
  } else if (entry.state === 'result' || entry.state === 'disk') {
    summaryEl.textContent = entry.title || 'Analysis';
  }
  filterSidebar();
}

// Remove an entry from the sidebar and, if it's the current entry, show empty state.
function removeSidebarItem(id) {
  if (!captureHistoryEl) return;
  const item = captureHistoryEl.querySelector('[data-entry-id="' + String(id) + '"]');
  if (item) item.remove();
  if (captureHistoryEl.children.length === 0) {
    captureHistoryEl.style.display = 'none';
    if (sideEmptyEl) sideEmptyEl.style.display = '';
  }
}

// Wipe ALL entries from the in-memory list + sidebar and return to the empty
// state. Used after a "Delete capture history / everything" action.
function clearAllEntriesUI() {
  entries.length = 0;
  if (captureHistoryEl) { captureHistoryEl.innerHTML = ''; captureHistoryEl.style.display = 'none'; }
  if (sideEmptyEl) sideEmptyEl.style.display = '';
  showEmptyState();
}

// Delete a thread: confirm → IPC → remove from memory and sidebar.
function deleteEntry(id) {
  if (!window.confirm('Delete this capture and its analysis? This can\'t be undone.')) return;
  const idx = entries.findIndex(e => e.id === id);
  if (idx !== -1) entries.splice(idx, 1);
  removeSidebarItem(id);
  if (currentEntryId === id) showEmptyState();
  if (window.hub && typeof window.hub.deleteThread === 'function') {
    window.hub.deleteThread(id).catch(() => {});
  }
}

function selectEntry(id) {
  currentEntryId = id;
  const entry = getEntry(id);
  if (!entry) return;

  // Sidebar highlight
  if (captureHistoryEl) {
    captureHistoryEl.querySelectorAll('.cap-hist-item').forEach(el => {
      el.classList.toggle('cap-hist-item-active', (el as HTMLElement).dataset.entryId === String(id));
    });
  }

  // Image thumbnail — entry may have a dataUrl (in-session) or a cropPath (from disk)
  if (capViewImg) {
    const imgSrc = entry.dataUrl || (entry.cropPath ? 'file://' + entry.cropPath : '');
    capViewImg.src = imgSrc;
    capViewImg.onload = () => {
      if (cvThumbMeta) {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        cvThumbMeta.textContent = `${capViewImg.naturalWidth} × ${capViewImg.naturalHeight} · ${time}`;
      }
    };
  }

  if (cvThread) cvThread.innerHTML = '';
  if (cvChipsEl) cvChipsEl.innerHTML = '';
  if (followupInp) followupInp.disabled = true;
  if (followupBtn) followupBtn.disabled = true;
  // Hidden by default; renderThread re-shows it only for a result entry that
  // carries a non-empty extracted table (Week 13 "Save as dataset").
  if (cvSaveDatasetBtn) cvSaveDatasetBtn.hidden = true;

  if (captureView) captureView.classList.remove('cap-view-hidden');

  if (entry.state === 'loading') {
    if (captureView) captureView.dataset.cvState = 'loading';
    if (mainTitleH) mainTitleH.textContent = 'Your capture';
    if (mainTitleSub) mainTitleSub.textContent = 'Analyzing…';
    cvStartSteps();
  } else if (entry.state === 'result' && entry.result) {
    cvStopSteps();
    if (captureView) captureView.dataset.cvState = 'result';
    if (mainTitleH) mainTitleH.textContent = entry.title || 'Analysis';
    if (mainTitleSub) mainTitleSub.textContent = 'Ready';
    renderThread(entry);
  } else if (entry.state === 'error' && entry.error) {
    cvStopSteps();
    if (captureView) captureView.dataset.cvState = 'error';
    if (mainTitleH) mainTitleH.textContent = 'Your capture';
    if (mainTitleSub) mainTitleSub.textContent = 'Analysis failed';
    _displayErrorContent(entry.error);
  } else if (entry.state === 'disk') {
    // Entry is in the sidebar but full data hasn't been loaded yet — fetch from disk.
    cvStopSteps();
    if (captureView) captureView.dataset.cvState = 'loading';
    if (mainTitleH) mainTitleH.textContent = entry.title || 'Analysis';
    if (mainTitleSub) mainTitleSub.textContent = 'Loading…';
    const snapId = id;
    if (window.hub && typeof window.hub.loadThread === 'function') {
      window.hub.loadThread(id).then(thread => {
        if (currentEntryId !== snapId || !thread) return;
        entry.state = 'result';
        entry.result = thread.result;
        entry.turns = (thread.turns || []).map(t => ({ ...t, activeVizType: null }));
        entry.title = thread.title || 'Analysis';
        entry.activeVizType = null;
        entry.chartOverrides = thread.chartOverrides || {};
        updateSidebarItem(entry);
        if (captureView) captureView.dataset.cvState = 'result';
        if (mainTitleH) mainTitleH.textContent = entry.title;
        if (mainTitleSub) mainTitleSub.textContent = 'Ready';
        renderThread(entry);
      }).catch(() => {
        if (currentEntryId !== snapId) return;
        if (captureView) captureView.dataset.cvState = 'error';
        if (mainTitleSub) mainTitleSub.textContent = 'Could not load';
      });
    }
  }
}

// ── Hub capture result ─────────────────────────────────────────────────────
const captureView   = document.getElementById('capture-view');
const capViewImg    = document.getElementById('cap-view-img') as HTMLImageElement;
const cvThumbMeta   = document.getElementById('cv-thumb-meta');
const cvThumbWrap   = document.getElementById('cv-thumb-wrap');
const imgLightbox   = document.getElementById('img-lightbox');
const lightboxImg   = document.getElementById('lightbox-img') as HTMLImageElement;
const lightboxClose = document.getElementById('lightbox-close');

// Focus management for the (static-markup) lightbox: move focus onto the close
// button on open, trap Tab, and return focus to whatever opened it on close.
let _lightboxA11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
function _lightboxKey(e: KeyboardEvent): void { if (_lightboxA11y) _lightboxA11y.onTabKey(e); }
function _openLightboxFocus(): void {
  if (_lightboxA11y) return; // already open
  _lightboxA11y = makeModalAccessible(imgLightbox as HTMLElement, 'Image preview', lightboxClose as HTMLElement | null);
  document.addEventListener('keydown', _lightboxKey, true);
}
function openLightbox() {
  if (!capViewImg || !capViewImg.src || !imgLightbox) return;
  lightboxImg.src = capViewImg.src;
  imgLightbox.hidden = false;
  _openLightboxFocus();
}
// Open the existing image lightbox for an ARBITRARY src (e.g. a dataset's stored
// capture crop) — captureDataset.js / datasets.js call this to "view original"
// without touching the current capture thumbnail. Reuses the same lightbox DOM.
function openLightboxSrc(src) {
  if (!src || !imgLightbox || !lightboxImg) return;
  lightboxImg.src = src;
  imgLightbox.hidden = false;
  _openLightboxFocus();
}
function closeLightbox() {
  if (imgLightbox) imgLightbox.hidden = true;
  document.removeEventListener('keydown', _lightboxKey, true);
  if (_lightboxA11y) { _lightboxA11y.release(); _lightboxA11y = null; } // return focus to the opener
}

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

function getImgSrc() {
  if (lightboxImg && imgLightbox && !imgLightbox.hidden && lightboxImg.src) return lightboxImg.src;
  return capViewImg ? capViewImg.src : '';
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

if (cvThumbWrap) {
  // Left-click → full view; right-click → options menu
  cvThumbWrap.addEventListener('click', openLightbox);
  cvThumbWrap.addEventListener('contextmenu', e => { e.preventDefault(); openImgActionMenu(cvThumbWrap); });
  cvThumbWrap.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') openLightbox();
  });
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

const mainTitleH    = document.getElementById('main-title-h');
const mainTitleSub  = document.getElementById('main-title-sub');
const capViewNewBtn = document.getElementById('cap-view-new');
const cvSaveDatasetBtn = document.getElementById('cv-save-dataset');
const cvThread      = document.getElementById('cv-thread');
const cvChipsEl     = document.getElementById('cv-chips');
const cveBadge      = document.getElementById('cve-badge');
const cveTitle      = document.getElementById('cve-title');
const cveMsg        = document.getElementById('cve-msg');
const cveSettingsBtn  = document.getElementById('cve-settings-btn');
const cveRetryBtn     = document.getElementById('cve-retry-btn');
const cveDetailPill   = document.getElementById('cve-detail-pill');
const cveDetailText   = document.getElementById('cve-detail-text');
const followupInp   = document.getElementById('cv-followup-input') as HTMLInputElement;
const followupBtn   = document.getElementById('cv-followup-send') as HTMLButtonElement;

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

// Re-render all active charts on theme change.
new MutationObserver(() => {
  const entry = getEntry(currentEntryId);
  if (entry && entry.state === 'result') renderThread(entry);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// Returns the result from the last successful turn in the thread.
function getLastResult(entry) {
  if (!entry) return null;
  for (let i = (entry.turns || []).length - 1; i >= 0; i--) {
    if (entry.turns[i].state === 'result' && entry.turns[i].result) return entry.turns[i].result;
  }
  return entry.result;
}

// Render the full conversation thread for an entry into #cv-thread.
function renderThread(entry) {
  if (!cvThread || !entry || !entry.result) return;
  cvThread.innerHTML = '';

  // Week 13 — enable "Save as dataset" only when this result carries a usable
  // extracted table. captureHasExtractedTable is defined in captureDataset.js.
  if (cvSaveDatasetBtn) {
    const usable = typeof captureHasExtractedTable === 'function' && captureHasExtractedTable(entry);
    cvSaveDatasetBtn.hidden = !usable;
  }

  const label = document.createElement('div');
  label.className = 'cv-section-label';
  label.textContent = 'Analysis';
  cvThread.appendChild(label);

  cvThread.appendChild(renderTurnResult(entry.result, entry.activeVizType, entry, 'main'));

  (entry.turns || []).forEach((turn, ti) => {
    const qEl = document.createElement('div');
    qEl.className = 'cv-turn-question';
    qEl.textContent = turn.text;
    cvThread.appendChild(qEl);

    if (turn.state === 'loading') {
      const loadEl = document.createElement('div');
      loadEl.className = 'cv-turn-loading';
      loadEl.innerHTML = '<span class="cv-turn-spinner"></span><span>Thinking…</span>';
      cvThread.appendChild(loadEl);
    } else if (turn.state === 'result' && turn.result) {
      cvThread.appendChild(renderTurnResult(turn.result, turn.activeVizType, entry, ti));
    } else if (turn.state === 'error') {
      const errEl = document.createElement('div');
      errEl.className = 'cv-turn-error';
      errEl.textContent = (turn.error && turn.error.message) || 'Something went wrong. Try again.';
      cvThread.appendChild(errEl);
    }
  });

  const lastResult = getLastResult(entry);
  buildCvChips(lastResult ? lastResult.followups : []);

  const hasPending = (entry.turns || []).some(t => t.state === 'loading');
  if (followupInp) followupInp.disabled = hasPending;
  if (followupBtn) followupBtn.disabled = hasPending;
}

function buildCvChips(followups) {
  if (!cvChipsEl) return;
  cvChipsEl.innerHTML = '';
  (followups || []).forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'cv-chip';
    btn.type = 'button';
    btn.textContent = q;
    btn.addEventListener('click', () => {
      if (followupInp) followupInp.value = q;
      sendFollowup();
    });
    cvChipsEl.appendChild(btn);
  });
}

// Error type → large icon (28px, scaled by CSS) + title + warn tint flag
const CVE_CONFIG = {
  network:    { title: 'No connection',          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>', warn: false },
  auth:       { title: 'Your API key was rejected', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></svg>', warn: true  },
  rate_limit: { title: 'Rate limit reached',     icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', warn: true  },
  provider:   { title: 'Provider error',         icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/></svg>', warn: false },
  bad_reply:  { title: 'Unreadable response',    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>', warn: false },
  truncated:  { title: 'Response cut off',       icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>', warn: true  },
  unknown:    { title: 'Something went wrong',   icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', warn: false },
};

// ── Step animation ────────────────────────────────────────────────────────────
const cvStepEls = Array.from(document.querySelectorAll('#cv-steps .cv-step'));

const CV_STEP_ICON = {
  done:    '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="7" fill="var(--ok)"/><path d="M3.5 7.5L5.5 9.5L10.5 4.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  active:  '<div class="cv-step-spinner"></div>',
  pending: '<div class="cv-step-dot"></div>',
};

let cvStepTimer  = null;
let cvActiveStep = 0;

function setCvStepStatus(el, status) {
  el.dataset.status = status;
  const icon = el.querySelector('.cv-step-icon');
  if (icon) icon.innerHTML = CV_STEP_ICON[status] || '';
}

function cvStartSteps() {
  clearInterval(cvStepTimer);
  cvActiveStep = 0;
  cvStepEls.forEach((el, i) => setCvStepStatus(el, i === 0 ? 'active' : 'pending'));
  cvStepTimer = setInterval(() => {
    if (cvActiveStep < cvStepEls.length - 1) {
      setCvStepStatus(cvStepEls[cvActiveStep], 'done');
      cvActiveStep++;
      setCvStepStatus(cvStepEls[cvActiveStep], 'active');
    }
  }, 2500);
}

function cvStopSteps() {
  clearInterval(cvStepTimer);
  cvStepTimer = null;
}

function cvFinishSteps(callback) {
  clearInterval(cvStepTimer);
  cvStepTimer = null;
  function completeNext() {
    setCvStepStatus(cvStepEls[cvActiveStep], 'done');
    if (cvActiveStep < cvStepEls.length - 1) {
      cvActiveStep++;
      setCvStepStatus(cvStepEls[cvActiveStep], 'active');
      setTimeout(completeNext, 140);
    } else {
      setTimeout(callback, 200);
    }
  }
  completeNext();
}


function _displayErrorContent(error) {
  const cfg = CVE_CONFIG[error.errorType] || CVE_CONFIG.unknown;
  if (cveBadge) {
    cveBadge.innerHTML = cfg.icon;
    cveBadge.classList.toggle('cve-warn', cfg.warn);
  }
  if (cveTitle) cveTitle.textContent = cfg.title;
  if (cveMsg)   cveMsg.textContent   = error.message || 'Something went wrong. Try again.';
  if (cveDetailPill) {
    if (error.detail) {
      if (cveDetailText) cveDetailText.textContent = error.detail;
      cveDetailPill.classList.remove('cve-detail-pill-hidden');
    } else {
      cveDetailPill.classList.add('cve-detail-pill-hidden');
    }
  }
  if (cveSettingsBtn) cveSettingsBtn.hidden = (error.errorType !== 'auth');
}

function showEmptyState() {
  cvStopSteps();
  currentEntryId = null;
  if (captureView) captureView.classList.add('cap-view-hidden');
  if (mainTitleH) mainTitleH.textContent = 'Welcome';
  if (mainTitleSub) mainTitleSub.textContent = 'Capture any data';
  if (captureHistoryEl) {
    captureHistoryEl.querySelectorAll('.cap-hist-item').forEach(el => el.classList.remove('cap-hist-item-active'));
  }
}

function showAnalyzeResult(entryId, result) {
  if (!captureView) return;
  const entry = getEntry(entryId);
  if (entry) {
    entry.state = result.ok ? 'result' : 'error';
    if (result.ok) {
      entry.result = result;
      entry.title = result.title || null;
    } else {
      entry.error = result;
    }
    updateSidebarItem(entry);
  }
  if (entryId !== currentEntryId) return;

  if (result.ok) {
    const snapId = entryId;
    cvFinishSteps(() => {
      if (currentEntryId !== snapId) return;
      captureView.dataset.cvState = 'result';
      if (mainTitleH) mainTitleH.textContent = entry ? (entry.title || 'Analysis') : 'Analysis';
      if (mainTitleSub) mainTitleSub.textContent = 'Ready';
      renderThread(entry);
    });
  } else {
    cvStopSteps();
    captureView.dataset.cvState = 'error';
    _displayErrorContent(result);
    if (mainTitleSub) mainTitleSub.textContent = 'Analysis failed';
  }
}

if (cveSettingsBtn) cveSettingsBtn.addEventListener('click', () => showSettingsPanel('exec'));
if (cveRetryBtn) cveRetryBtn.addEventListener('click', () => {
  if (!currentEntryId) return;
  const entry = getEntry(currentEntryId);
  if (!entry) return;
  entry.state = 'loading';
  entry.result = null;
  entry.error = null;
  entry.title = null;
  entry.turns = [];
  entry.activeVizType = null;
  updateSidebarItem(entry);
  if (captureView) captureView.dataset.cvState = 'loading';
  if (mainTitleH) mainTitleH.textContent = 'Your capture';
  if (mainTitleSub) mainTitleSub.textContent = 'Analyzing…';
  if (cvThread) cvThread.innerHTML = '';
  if (cvChipsEl) cvChipsEl.innerHTML = '';
  cvStartSteps();
  if (window.hub && window.hub.retry) window.hub.retry(currentEntryId);
});
if (capViewNewBtn)  capViewNewBtn.addEventListener('click', showEmptyState);
// Week 13 — open the review-and-correct grid for the current capture.
// openCaptureDatasetModal is defined in captureDataset.js (shared global scope).
if (cvSaveDatasetBtn) {
  cvSaveDatasetBtn.addEventListener('click', () => {
    const entry = getEntry(currentEntryId);
    if (entry && typeof openCaptureDatasetModal === 'function') openCaptureDatasetModal(entry);
  });
}

if (window.hub && typeof window.hub.onNewEntry === 'function') {
  window.hub.onNewEntry(async ({ entryId, dataUrl }) => {
    const entry = {
      id: entryId, dataUrl, state: 'loading',
      result: null, error: null,
      title: null, turns: [], activeVizType: null,
      chartOverrides: {},
    };
    entries.unshift(entry);
    // Quick-capture with no open project transparently uses/creates a default
    // project and shows the Sources surface (workspace.ts). Non-regressing: the
    // result surface renders exactly as before. Guarded so a project-layer
    // failure can never suppress the captured result (ensureWorkspaceForCapture
    // is already defensive; this is belt-and-suspenders).
    try { await ensureWorkspaceForCapture(); } catch (_) { /* render regardless */ }
    renderSidebarItem(entry);
    selectEntry(entryId);
  });
}

if (window.hub && typeof window.hub.onEntryResult === 'function') {
  window.hub.onEntryResult(({ entryId, ...result }) => {
    showAnalyzeResult(entryId, result);
    if (result && result.ok && notifPrefs.sound) playCompletionSound();
    // Week 13 — if a recapture (replace/append) is pending, auto-open the review
    // modal pre-set to that target. maybeResumeRecapture is defined in
    // captureDataset.js and no-ops when nothing is pending.
    if (typeof maybeResumeRecapture === 'function') maybeResumeRecapture(getEntry(entryId));
  });
}

// Populate sidebar with persisted threads from disk (sent by main on hub open).
// Historical entries are added after any in-session entries (session entries are prepended).
if (window.hub && typeof window.hub.onHistory === 'function') {
  window.hub.onHistory(summaries => {
    if (!Array.isArray(summaries)) return;
    if (summaries.length === 0) { clearAllEntriesUI(); return; } // e.g. after "delete history"
    summaries.forEach(summary => {
      // Don't duplicate an entry that was already captured in this session
      if (getEntry(summary.id)) return;
      const entry = {
        id: summary.id,
        dataUrl: null,
        cropPath: summary.cropPath || null,
        state: 'disk',
        result: null,
        error: null,
        title: summary.title || 'Analysis',
        turns: [],
        activeVizType: null,
        updatedAt: summary.updatedAt || null,
        chartOverrides: {},
      };
      entries.push(entry);
      // Append (not prepend) — session entries sit above history entries
      renderSidebarItem(entry, false);
      updateSidebarItem(entry);
    });
  });
}

function sendFollowup() {
  if (!currentEntryId) return;
  const text = (followupInp ? followupInp.value : '').trim();
  if (!text) return;
  const entry = getEntry(currentEntryId);
  if (!entry || entry.state !== 'result') return;

  const turn = { text, state: 'loading', result: null, error: null, activeVizType: null };
  entry.turns.push(turn);
  if (followupInp) followupInp.value = '';
  renderThread(entry);

  if (window.hub && typeof window.hub.followup === 'function') {
    window.hub.followup(currentEntryId, text);
  }
}

function showFollowupResult(entryId, result) {
  const entry = getEntry(entryId);
  if (!entry) return;

  const turn = entry.turns.find(t => t.state === 'loading');
  if (!turn) return;

  if (result.ok) {
    turn.state = 'result';
    turn.result = result;
    turn.activeVizType = null;
  } else {
    turn.state = 'error';
    turn.error = result;
  }

  if (entryId === currentEntryId) renderThread(entry);
}

if (window.hub && typeof window.hub.onFollowupResult === 'function') {
  window.hub.onFollowupResult(({ entryId, ...result }) => {
    showFollowupResult(entryId, result);
    if (result && result.ok && notifPrefs.sound) playCompletionSound();
  });
}

if (followupBtn) followupBtn.addEventListener('click', sendFollowup);
if (followupInp) {
  followupInp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowup(); }
  });
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

// ── Settings panel — hotkey recorder ─────────────────────────────────────
let stpRecording = false;
let stpCapturedAccel = null;
let stpRecordingHandler = null;

function stpRenderHotkeyDisplay(label) {
  if (!stpHotkeyEl) return;
  const chips = labelToKeys(label).map(k => `<span class="kbd">${k}</span>`).join('');
  stpHotkeyEl.innerHTML = chips +
    `<button id="stp-hotkey-change" class="btn btn-sm" type="button">Change</button>`;
  document.getElementById('stp-hotkey-change').addEventListener('click', async () => {
    const { accelerator } = await window.hub.getHotkeyLabel().catch(() => ({ accelerator: '' }));
    stpStartRecording(accelerator);
  });
}

function stpStartRecording(prevAccel) {
  stpRecording = true;
  stpCapturedAccel = null;
  if (!stpHotkeyEl) return;
  stpHotkeyEl.innerHTML =
    `<div class="stp-recorder" id="stp-recorder"><span class="stp-recorder-hint">Press your shortcut…</span></div>` +
    `<button id="stp-rec-save" class="btn btn-sm btn-primary" type="button" disabled>Save</button>` +
    `<button id="stp-rec-cancel" class="btn btn-sm" type="button">Cancel</button>`;

  document.getElementById('stp-rec-save').addEventListener('click', stpSaveHotkey);
  document.getElementById('stp-rec-cancel').addEventListener('click', () => stpCancelRecording(prevAccel));

  stpRecordingHandler = (e) => {
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const parts = [];
    if (e.metaKey) parts.push('CommandOrControl');
    if (e.ctrlKey) parts.push('Control');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    const key = keyToAccelKey(e.code);
    const isFKey = key && /^F\d+$/.test(key);
    // F-keys work without a modifier; all other keys need at least one modifier.
    if (!key || (parts.length === 0 && !isFKey)) return;
    parts.push(key);
    stpCapturedAccel = parts.join('+');
    const rec = document.getElementById('stp-recorder');
    if (rec) {
      rec.innerHTML = labelToKeys(accelToLabel(stpCapturedAccel))
        .map(k => `<span class="kbd">${k}</span>`).join('');
    }
    const saveBtn = document.getElementById('stp-rec-save') as HTMLButtonElement;
    if (saveBtn) saveBtn.disabled = false;
  };
  window.addEventListener('keydown', stpRecordingHandler, true);
}

async function stpSaveHotkey() {
  if (!stpCapturedAccel || !window.hub || typeof window.hub.saveHotkey !== 'function') return;
  const saveBtn = document.getElementById('stp-rec-save') as HTMLButtonElement;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const result = await window.hub.saveHotkey(stpCapturedAccel);
    if (result && result.ok) {
      stpStopRecording();
      stpRenderHotkeyDisplay(result.label || accelToLabel(stpCapturedAccel));
      await applyHotkeyLabel();
      if (hotkeyFailBanner) hotkeyFailBanner.style.display = 'none';
    } else {
      const rec = document.getElementById('stp-recorder');
      if (rec) rec.textContent = (result && result.error) || 'Could not register — try another combo';
      if (saveBtn) saveBtn.disabled = false;
    }
  } catch (_) {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function stpCancelRecording(prevAccel) {
  stpStopRecording();
  if (stpHotkeyEl) {
    stpRenderHotkeyDisplay(prevAccel ? accelToLabel(prevAccel) : '–');
  }
}

function stpStopRecording() {
  stpRecording = false;
  stpCapturedAccel = null;
  if (stpRecordingHandler) {
    window.removeEventListener('keydown', stpRecordingHandler, true);
    stpRecordingHandler = null;
  }
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
  const focusables = (): HTMLElement[] =>
    Array.from(box.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
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
  stpVersionEl.textContent = v ? `Screenchart ${v}` : 'Screenchart';
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
