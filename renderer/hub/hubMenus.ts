'use strict';

// The three chrome popovers, which are one job in three costumes: the gear menu
// (theme · share · GitHub · Settings), the help menu, and the execution-mode
// chip (BYOK provider / local CLI / model). All three are the same anchored
// panel — position against the trigger, clamp to the viewport, dismiss on
// outside-click or Escape — and each closes the other two.
//
// The exec menu's RENDERERS (renderExecAgents, renderExecModel, openExecMenu, …)
// live in execMenu.ts and always have; what is here is its state and its wiring.
//
// Split verbatim out of hub.ts — see .claude/rules/file-size.md. Classic
// global-scope <script>: no import/export. Loads after customDropdown.js,
// which makeDropdown() below is called at load time.

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
const SHARE_TEXT = 'Ordinate: screenshot any chart, table, or data and get instant AI analysis. Local-first, bring your own key.';

const _enc = encodeURIComponent;
const SHARE_LINKS = {
  x:        `https://twitter.com/intent/tweet?url=${_enc(SHARE_URL)}&text=${_enc(SHARE_TEXT)}`,
  linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${_enc(SHARE_URL)}`,
  facebook: `https://www.facebook.com/sharer/sharer.php?u=${_enc(SHARE_URL)}`,
  reddit:   `https://www.reddit.com/submit?url=${_enc(SHARE_URL)}&title=${_enc(SHARE_TEXT)}`,
  telegram: `https://t.me/share/url?url=${_enc(SHARE_URL)}&text=${_enc(SHARE_TEXT)}`,
  whatsapp: `https://wa.me/?text=${_enc(SHARE_TEXT + ' ' + SHARE_URL)}`,
};

// TWO settings buttons, never two ids. #settings-gear lives in the app sidebar;
// #settings-gear-cap lives in the capture surface's own footer, which is the
// only place visible when body.cap-focus hides that sidebar. Everything below
// anchors, focuses and dismisses off whichever is CURRENTLY visible — anchoring
// off a hidden element yields a zeroed rect and drops the menu at 0,0.
const settingsGear    = document.getElementById('settings-gear');
const settingsGearCap = document.getElementById('settings-gear-cap');
function settingsGears(): HTMLElement[] {
  return [settingsGear, settingsGearCap].filter(Boolean) as HTMLElement[];
}
function settingsGearVisible(): HTMLElement | null {
  const all = settingsGears();
  return all.find((b) => b.offsetParent !== null) || all[0] || null;
}
const settingsMenu = document.getElementById('settings-menu');
const menuThemeSeg = document.getElementById('menu-theme-seg');
let _smDismiss = null;
let _smEsc = null;

function openSettingsMenu() {
  const gear = settingsGearVisible();
  if (!settingsMenu || !gear) return;
  closeExecMenu();
  settingsMenu.hidden = false;
  // Anchor the panel by the gear, right-aligned, clamped to the viewport. The
  // gear sits at the bottom of the sidebar, so anchoring BELOW it drops the menu
  // off the bottom of the window. Open toward whichever side has more room
  // (upward here), pinning the far edge and capping height to the space free.
  const r = gear.getBoundingClientRect();
  let left = r.right - settingsMenu.offsetWidth;
  if (left < 12) left = 12;
  settingsMenu.style.left = left + 'px';
  if (r.top > window.innerHeight - r.bottom) {
    settingsMenu.style.top = 'auto';
    settingsMenu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    settingsMenu.style.maxHeight = (r.top - 12) + 'px';
  } else {
    settingsMenu.style.bottom = 'auto';
    settingsMenu.style.top = (r.bottom + 6) + 'px';
    settingsMenu.style.maxHeight = (window.innerHeight - r.bottom - 18) + 'px';
  }
  settingsMenu.style.overflowY = 'auto';
  gear.setAttribute('aria-expanded', 'true');
  reflectThemeControls();
  _smDismiss = (e) => {
    if (!settingsMenu.contains(e.target) && !gear.contains(e.target)) closeSettingsMenu();
  };
  _smEsc = (e) => { if (e.key === 'Escape') { closeSettingsMenu(); gear.focus(); } };
  document.addEventListener('click', _smDismiss, true);
  document.addEventListener('keydown', _smEsc, true);
}

function closeSettingsMenu() {
  if (!settingsMenu) return;
  settingsMenu.hidden = true;
  // Reset BOTH: whichever opened it is the only one that was set, and clearing
  // the other is a no-op rather than a branch.
  settingsGears().forEach((b) => b.setAttribute('aria-expanded', 'false'));
  if (_smDismiss) { document.removeEventListener('click', _smDismiss, true); _smDismiss = null; }
  if (_smEsc)     { document.removeEventListener('keydown', _smEsc, true);  _smEsc = null; }
}

settingsGears().forEach((gear) => {
  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    if (settingsMenu.hidden) openSettingsMenu(); else closeSettingsMenu();
  });
});

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
      const g = settingsGearVisible(); if (g) g.focus();
    });
  });
}

const smGithubBtn = document.getElementById('sm-github');
if (smGithubBtn) {
  smGithubBtn.addEventListener('click', () => {
    if (window.hub && window.hub.openExternal) window.hub.openExternal(GITHUB_URL);
    closeSettingsMenu();
    const g = settingsGearVisible(); if (g) g.focus();
  });
}

// The folded Help rows. Same data-help -> HELP_LINKS lookup the help menu used,
// now scoped to the settings menu that absorbed them.
if (settingsMenu) {
  settingsMenu.querySelectorAll('.sm-row[data-help]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const url = HELP_LINKS[(btn as HTMLElement).dataset.help];
      if (url && window.hub && window.hub.openExternal) window.hub.openExternal(url);
      closeSettingsMenu();
      const g = settingsGearVisible(); if (g) g.focus();
    });
  });
}

const smSettingsBtn = document.getElementById('sm-settings');
if (smSettingsBtn) {
  smSettingsBtn.addEventListener('click', () => {
    closeSettingsMenu();
    showSettingsPanel();
  });
}

// The Help menu is GONE. Its button lived in the capture footer, which now
// holds Settings only; its four remaining rows (docs, feature request, what's
// new, website) moved into the settings menu, where one handler drives them off
// the same data-help contract. The fifth row, GitHub, was already there.

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

// ONE exec button now: #exec-mode-btn-cap, at the right end of the capture top
// bar (hub.css shows it only in body.cap-focus). The sidebar's #exec-mode-btn
// was removed in the top-bar relayout, so `execBtn` below is expected to be
// null — the lookup and the array stay because execMenu.ts drives whichever
// buttons exist through execBtns()/execBtnVisible(), and that is what makes
// this a markup-only removal rather than an edit to a ~500-line subsystem.
const execBtn          = document.getElementById('exec-mode-btn');
const execBtnCap       = document.getElementById('exec-mode-btn-cap');
function execBtns(): HTMLElement[] {
  return [execBtn, execBtnCap].filter(Boolean) as HTMLElement[];
}
function execBtnVisible(): HTMLElement | null {
  const all = execBtns();
  return all.find((b) => b.offsetParent !== null) || all[0] || null;
}
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
// Whatever anchored the last openExecMenu() — an exec button OR Ask's model
// chip. Tracked so closeExecMenu can clear aria-expanded on non-exec openers,
// which its execBtns() sweep cannot reach.
let _execOpener: HTMLElement | null = null;
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

execBtns().forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (execMenu.hidden) openExecMenu(); else closeExecMenu();
  });
});

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
// Guarded on execBtns().length, NOT on `execBtn`: that was the sidebar button,
// and gating this on it specifically meant that removing it left
// #exec-mode-btn-cap with no icon until the menu was opened by hand. The
// condition that actually matters is "is there any exec button to paint".
(function initExecButtonIcon() {
  if (!execBtns().length || !window.hub || typeof window.hub.getKeyStatus !== 'function') return;
  window.hub.getKeyStatus().then(status => {
    execMode = (status && status.executionMode) || 'local';
    execByok = (status && status.byok) || execByok;
    execLocal = (status && status.localCli) || execLocal;
    updateExecBtnIcon();
  }).catch(() => {});
})();

