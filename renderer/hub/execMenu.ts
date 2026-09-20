/**
 * The one "not set up yet" sentence, for every surface in the hub that has to
 * say it — the dock, Prepare, Explain, the chart and dashboard suggesters, the
 * analysis wizard. It used to be six near-copies ("…to use Copilot.", "…to
 * suggest a chart."), which named the feature three different ways.
 *
 * It no longer spells out a route. "Connect a model in Settings → Execution"
 * asked a first-time reader to know what a model is and where Execution is;
 * the route is now AI_SETUP_LABEL, a real button that goes there.
 *
 * Lives here because this file already owns the model-connection chrome, and
 * it loads (index.html) before every file that reads it. Classic global-scope
 * script: the `const` is the global lexical scope, read inside functions only.
 */
const AI_NOT_CONFIGURED = 'The Assistant isn’t set up yet.';

/** The one label on the one button that fixes it. */
const AI_SETUP_LABEL = 'Set up the Assistant';

/** Open Settings on the Assistant tab — the single destination behind every
 *  "Set up the Assistant" button and the dock's header pill. */
function openAssistantSettings(): void {
  if (typeof closeExecMenu === 'function') closeExecMenu();
  if (typeof showSettingsPanel === 'function') void showSettingsPanel('exec');
}

/** The "Set up the Assistant" button itself. Built, not markup, because the
 *  five surfaces that need one are five different containers. */
function aiSetupButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-sm ai-setup-btn';
  b.textContent = AI_SETUP_LABEL;
  b.addEventListener('click', openAssistantSettings);
  return b;
}

/** Paint a notice element as "sentence + the button that fixes it", replacing
 *  whatever was there. `extra` is a surface's own follow-on sentence. */
function aiSetupNotice(el: HTMLElement | null, extra?: string): void {
  if (!el) return;
  el.textContent = AI_NOT_CONFIGURED + (extra ? ' ' + extra : '') + ' ';
  el.appendChild(aiSetupButton());
  el.hidden = false;
}

/**
 * Every button that hands work to the Assistant, and the hint that explains a
 * disabled one. Ids only — each is static markup in index.html, so this list is
 * the whole registry and a new door joins it by being named here.
 */
const AI_DOORS = ['viz-empty-ai', 'viz-suggest-btn', 'an-draft-btn', 'an-empty-draft'];
const AI_DOOR_HINTS = ['viz-empty-hint', 'an-empty-hint'];

/**
 * Disable the Assistant's doors when no model is configured, and say why.
 *
 * Each surface used to decide this for itself, and only one of them did: the
 * Visuals empty state disabled its door and explained it, while the Dashboards
 * header, the Dashboards empty state and the builder's "Suggest chart" all
 * looked live with no model and answered a click with an alert. One gate over
 * one registry, so a door cannot be added without being gated.
 *
 * Readiness is publicConfig.isReady (config.executionReady()) — the same source
 * the create popup, the analysis wizard and the dock's pill ask, so there is no
 * second definition of "ready" that could disagree with them. Called once at
 * boot: it cannot change without a settings round trip, which reloads the hub.
 */
async function gateAssistantDoors(): Promise<void> {
  let ready = false;
  try {
    const st: any = await window.hub.getKeyStatus();
    ready = !!(st && st.isReady);
  } catch (_) {
    ready = false; // no answer is not a yes — a dead door beats a dead end
  }
  for (const id of AI_DOORS) {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (!b) continue;
    b.disabled = !ready;
    // The tooltip carries the reason where there is no room for the hint line.
    b.title = ready ? '' : AI_NOT_CONFIGURED;
  }
  for (const id of AI_DOOR_HINTS) {
    const h = document.getElementById(id);
    if (!h) continue;
    if (ready) { h.textContent = ''; h.hidden = true; continue; }
    aiSetupNotice(h); // one sentence, one source, one button
  }
  // Home's ask bar has no room for a notice, so its placeholder carries the
  // same answer. Submitting it opens the dock, which shows the button.
  const ask = document.getElementById('home-ask-input') as HTMLInputElement | null;
  if (ask) ask.placeholder = ready ? 'Ask about your data…' : 'Set up the Assistant to ask a question…';
}

// Execution-mode menu — the top-right chip popup: agent rows (cloud/local),
// model selectors, and the open/close/refresh logic. Extracted from hub.js as
// a pure structural move (no logic changes). The exec STATE (execMode/execByok/
// execLocal, the exec DOM refs, BYOK/brand tables) and the menu's event WIRING
// stay in hub.js — this module references them cross-file at call time.

function agentIconHTML(id: string, label: string, size: number): string {
  const asset = AGENT_LOGOS[id];
  if (asset) {
    const tile = TILE_IDS.has(id) ? ' exec-agent-img-tile' : '';
    return `<img class="exec-agent-logo exec-agent-img${tile}" src="${asset}"`
      + ` width="${size}" height="${size}" alt="" aria-hidden="true" />`;
  }
  const logo = PROVIDER_LOGOS[id];
  if (logo && logo.path) {
    return `<svg class="exec-agent-logo" width="${size}" height="${size}" viewBox="0 0 24 24"`
      + ` fill="${logo.color || 'currentColor'}" aria-hidden="true"><path d="${logo.path}"/></svg>`;
  }
  const letter = ((label || id || '?').trim()[0] || '?').toUpperCase();
  const brand = BRAND_BADGE[id] ? ' ' + BRAND_BADGE[id] : '';
  return `<span class="exec-agent-logo exec-agent-mono${brand}" aria-hidden="true">${letter}</span>`;
}

// The active source for the CURRENT mode, but ONLY when it's actually connected
// (Active-requires-Connected, same rule as the status pill). Returns {id,label}
// or null when nothing is connected — so we never imply "Claude is active" when
// it isn't. No hardcoded default.
// Pass a getKeyStatus() snapshot to ask the same question of a caller that has
// one in hand but has never opened the menu (the dock's "Powered by" line);
// with no argument it reads the menu's own state, as it always has. One rule,
// so the dock can never name something the pill disagrees with.
function execActiveConnected(st?: any): { id: string; label: string } | null {
  const mode  = st ? (st.executionMode || 'local') : execMode;
  const byok  = st ? (st.byok || {}) : execByok;
  const local = st ? (st.localCli || {}) : execLocal;
  if (mode === 'local') {
    const id = local.activeId;
    if (!id || !RUNNABLE_LOCAL.includes(id)) return null;
    const cli = (local.clis || []).find((c: any) => c.id === id);
    return (cli && cli.status === 'installed') ? { id, label: cli.displayName || id } : null;
  }
  const id = byok.activeProvider; // effective active (null if none connected)
  if (!id) return null;
  const p = (byok.providers || {})[id];
  return (p && p.connected) ? { id, label: BYOK_DISPLAY[id] || id } : null;
}

// Neutral "no AI connected yet" mark — lucide-react's `cpu` icon, inlined (this
// is a no-bundler app so we ship the SVG, not the React component). Sized 16px
// + class "ic" to match the gear; tinted currentColor → muted via .exec-btn-empty.
const EXEC_BTN_NEUTRAL =
  '<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect width="16" height="16" x="4" y="4" rx="2"/>'
  + '<rect width="6" height="6" x="9" y="9" rx="1"/>'
  + '<path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/>'
  + '<path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg>';

// Paint the top-right button: the connected active source's logo, or a neutral
// muted mark when nothing is connected.
// Paints BOTH exec buttons, unconditionally — the hidden one costs a few DOM
// writes and is then already correct the moment it appears. Updating only the
// visible one is how you get a stale icon on the sidebar button after switching
// mode from the capture page.
function updateExecBtnIcon(): void {
  const active = execActiveConnected();
  for (const btn of execBtns()) {
    if (active) {
      btn.innerHTML = agentIconHTML(active.id, active.label, 18);
      btn.classList.remove('exec-btn-empty');
      btn.setAttribute('aria-label', `Assistant: ${active.label}`);
      btn.title = active.label;
    } else {
      btn.innerHTML = EXEC_BTN_NEUTRAL;
      btn.classList.add('exec-btn-empty');
      btn.setAttribute('aria-label', AI_NOT_CONFIGURED);
      btn.title = AI_NOT_CONFIGURED;
    }
  }
}

function renderExecModeSeg(): void {
  if (!execModeSeg) return;
  execModeSeg.querySelectorAll<HTMLElement>('.menu-seg-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === execMode);
  });
}

// One agent row: logo + name + status badge (+ check when active).
function execAgentRow(
  id: string, label: string, badge: string,
  opts?: { active?: boolean; connected?: boolean; disabled?: boolean; title?: string | null; onClick?: (() => void) | null }
): HTMLButtonElement {
  const o = opts || {};
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'exec-agent'
    + (o.active ? ' active' : '')
    + (o.connected ? ' connected' : '')
    + (o.disabled ? ' disabled' : '');
  btn.dataset.id = id;
  btn.innerHTML =
    agentIconHTML(id, label, 16) +
    '<span class="exec-agent-name"></span>' +
    '<span class="exec-agent-badge"></span>' +
    '<svg class="exec-agent-check" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  btn.querySelector('.exec-agent-name')!.textContent = label;
  btn.querySelector('.exec-agent-badge')!.textContent = badge;
  if (o.title) btn.title = o.title;
  if (o.onClick) btn.addEventListener('click', o.onClick);
  return btn;
}

function renderExecAgents(): void {
  if (!execAgentList) return;
  execAgentList.innerHTML = '';
  if (execMode === 'local') renderLocalAgents();
  else renderCloudAgents();
}

function renderCloudAgents(): void {
  // activeProvider is the EFFECTIVE active from main (connected, or null).
  const active = execByok.activeProvider;
  const providers = execByok.providers || {};
  let anyConnected = false;
  BYOK_AGENTS.forEach(prov => {
    // Connected = key saved AND verified by a real test (not just a key string).
    const connected = Boolean((providers[prov] || {}).connected);
    if (connected) anyConnected = true;
    const isActive = connected && prov === active; // Active REQUIRES Connected
    const badge = isActive ? 'Active' : (connected ? 'Connected' : 'Not connected');
    const label = BYOK_DISPLAY[prov] || prov;
    const onClick = connected
      ? () => selectCloudAgent(prov)
      : () => openSettingsForProvider(prov); // don't silently activate an unverified provider
    execAgentList.appendChild(execAgentRow(prov, label, badge, { active: isActive, connected, onClick }));
  });
  if (!anyConnected) {
    const hint = document.createElement('div');
    hint.className = 'exec-agent-empty';
    hint.textContent = 'No connected provider. Add and test a key to activate one.';
    execAgentList.appendChild(hint);
  }
}

function renderLocalAgents(): void {
  const clis = execLocal.clis || [];
  const activeId = execLocal.activeId;
  // Show every installed CLI, the runnable adapters even when not installed yet,
  // and retired entries (so their status is honest).
  const shown = clis.filter((c: any) =>
    c.status === 'installed' || c.status === 'retired' || RUNNABLE_LOCAL.includes(c.id));
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'exec-agent-empty';
    empty.textContent = 'Nothing found on this Mac. Open Settings → Assistant to look again.';
    execAgentList.appendChild(empty);
  }
  shown.forEach((cli: any) => {
    const installed = cli.status === 'installed';
    const retired = cli.status === 'retired';
    const supported = RUNNABLE_LOCAL.includes(cli.id); // has a working run adapter
    const isActive = supported && installed && cli.id === activeId;
    let badge: string, onClick: (() => void) | null = null, disabled = false, title: string | null = null;
    if (retired) {
      badge = 'Retired';
      disabled = true;
      title = cli.retiredNote || 'Retired.';
    } else if (!installed) {
      badge = 'Not installed';
      onClick = () => openLocalSettings();
    } else if (!supported) {
      badge = 'Not supported yet';
      disabled = true;                               // installed but no adapter — not connectable
    } else {
      badge = isActive ? 'Active' : 'Connected';
      onClick = () => selectLocalCli(cli.id);
    }
    execAgentList.appendChild(execAgentRow(
      cli.id, cli.displayName, badge,
      { active: isActive, connected: installed && supported, disabled, title, onClick }
    ));
  });
  // Install-other row → settings, Local CLI section, Available-to-install list.
  const install = document.createElement('button');
  install.type = 'button';
  install.className = 'exec-agent exec-agent-action';
  install.innerHTML =
    '<span class="exec-agent-logo exec-agent-plus" aria-hidden="true">+</span>' +
    '<span class="exec-agent-name">Install another CLI…</span>';
  install.addEventListener('click', openLocalSettings);
  execAgentList.appendChild(install);
}

// MODEL: an editable field (type any id, or pick a suggestion from the datalist).
// BYOK reads/writes byok.providers[active].model. Local Claude Code stays
// "Default (CLI config)" — the CLI exposes no non-interactive model list (M3/M4).
// Show either the free-text input (BYOK) or the real select (local CLI list).
function execShowModelControl(which: string): void {
  if (execModelSel) execModelSel.hidden = which !== 'input';
  if (execModelCli) execModelCli.hidden = which !== 'select';
}

// Populate the local-CLI model <select> from `agy models` (Antigravity only).
// Always offers "Default (CLI config)"; on failure that's all that's left — no
// fabricated list. Keeps a previously-saved custom model selectable too.
function renderCliModelSelect(id: string, force?: boolean): void {
  if (!execModelCli) return;
  const saved = (execLocal.models || {})[id] || '';
  // Instant skeleton: Default (+ saved if custom), then swap in the live list.
  const skel = [{ value: '', label: 'Default (CLI config)' }];
  if (saved) skel.push({ value: saved, label: saved });
  execModelCli.setOptions(skel, saved);
  execModelCli.disabled = false;
  if (!window.hub || typeof window.hub.listCliModels !== 'function') return;
  if (force) execSetModelHint('Refreshing…', 'loading');
  window.hub.listCliModels(id).then(res => {
    if (execMode !== 'local' || execLocal.activeId !== id) return;
    const models = (res && res.ok && res.models) || [];
    const opts = [{ value: '', label: 'Default (CLI config)' }]
      .concat(models.map((m: any) => ({ value: m, label: m })));
    if (saved && !models.includes(saved)) opts.push({ value: saved, label: saved });
    execModelCli.setOptions(opts, saved);
    if (models.length) { execSetModelHint('', ''); return; }
    // Empty list: only a genuine failure is an error. 'auth' (installed but not
    // signed in) and 'empty'/no-list mean Default is a legit choice → stay neutral.
    const reason = res && res.reason;
    if (reason === 'failed') execSetModelHint('Couldn’t list models — using Default.', 'warn');
    else if (reason === 'auth') execSetModelHint('Sign in to this CLI to list its models.', '');
    else execSetModelHint('', '');
  }).catch(() => execSetModelHint('Couldn’t list models — using Default.', 'warn'));
}

function renderExecModel(): void {
  if (!execModelSel) return;
  const localId = execMode === 'local' ? execLocal.activeId : null;
  const liveActive = LIVE_MODEL_CLIS.includes(localId);
  // All runnable CLIs use the real <select>. Refresh ↻ only applies to LIVE lists:
  // BYOK, or a CLI whose list comes from its own command (LIVE_MODEL_CLIS). The
  // static lists (Claude Code, Codex) get no refresh.
  const listCli = MODEL_LIST_CLIS.includes(localId);
  if (execModelRefresh) execModelRefresh.hidden = !(execMode === 'byok' || liveActive);
  if (typeof execSetModelHint === 'function') execSetModelHint('');

  if (execMode === 'local') {
    // Only an INSTALLED, selected CLI has models to offer. With nothing installed/
    // selected, don't list (and don't show a "couldn't list" error) — show a neutral
    // "nothing to pick yet" placeholder instead.
    const cli = localId ? (execLocal.clis || []).find((c: any) => c.id === localId) : null;
    const installedSelected = !!(cli && cli.status === 'installed');
    if (!installedSelected) {
      if (execModelRefresh) execModelRefresh.hidden = true;
      execShowModelControl('input');
      if (execModelDl) execModelDl.innerHTML = '';
      execModelSel.value = '';
      execModelSel.placeholder = 'Select a CLI to choose a model';
      execModelSel.disabled = true;
      execSetModelHint('', '');
      return;
    }
    if (listCli) {
      execShowModelControl('select');     // a real, obvious selector
      renderCliModelSelect(localId, false);
      return;
    }
    // Installed CLI without a model list — honest, static, DISABLED "Default".
    execShowModelControl('input');
    if (execModelDl) execModelDl.innerHTML = '';
    execModelSel.value = 'Default (CLI config)';
    execModelSel.placeholder = 'Default (CLI config)';
    execModelSel.disabled = true;
    return;
  }
  // BYOK — model control follows the EFFECTIVE active provider. With nothing
  // connected there's no Active provider, so there's no model to choose: prompt
  // the user to connect one instead of showing a misleading list.
  const prov = execByok.activeProvider;
  if (!prov) {
    if (execModelRefresh) execModelRefresh.hidden = true;
    execShowModelControl('input');
    if (execModelDl) execModelDl.innerHTML = '';
    execModelSel.value = '';
    execModelSel.placeholder = 'Connect a provider first';
    execModelSel.disabled = true;
    execSetModelHint('Add and test a key to choose a model.', '');
    return;
  }
  // Gateway/custom: an arbitrary endpoint's models can't be listed, so the model is
  // a free-text id (e.g. openai/gpt-4o-mini) typed into the input, persisted via the
  // execModelSel change handler in hub.js.
  if (prov === 'gateway') {
    if (execModelRefresh) execModelRefresh.hidden = true;
    execShowModelControl('input');
    if (execModelDl) execModelDl.innerHTML = '';
    execModelSel.value = ((execByok.providers || {})[prov] || {}).model || '';
    execModelSel.placeholder = 'Model id, e.g. openai/gpt-4o-mini';
    execModelSel.disabled = false;
    execSetModelHint('Type the exact model id for your gateway.', '');
    return;
  }
  // A real <select> of live models, so ALL options show with one chevron.
  execShowModelControl('select');
  renderByokModelSelect(prov, false);
}

// BYOK model <select>: instant skeleton (Default + curated + saved), then swap in
// the live list from the shared MAIN source. Shows EVERY model; persists to
// byok.providers[prov].model — the same value the settings pane writes.
function renderByokModelSelect(prov: string, force?: boolean): void {
  if (!execModelCli) return;
  const saved = ((execByok.providers || {})[prov] || {}).model || '';
  const build = (list: any[] | null | undefined) => {
    const seen = new Set();
    const rows = [{ value: '', label: 'Default' }];
    (list || []).forEach(m => { if (m.id && !seen.has(m.id)) { seen.add(m.id); rows.push({ value: m.id, label: m.label || m.id }); } });
    if (saved && !seen.has(saved)) rows.push({ value: saved, label: saved }); // keep a custom saved id selectable
    return rows;
  };
  // Instant: curated suggestions + saved, then refresh from the live source.
  execModelCli.setOptions(build((PROVIDER_MODELS[prov] || []).map((m: any) => ({ id: m.v, label: m.l }))), saved);
  execModelCli.disabled = false;
  if (!window.hub || typeof window.hub.listModels !== 'function') return;
  if (force) execSetModelHint('Refreshing…', 'loading'); else execSetModelHint('');
  window.hub.listModels(prov, force).then(res => {
    if (execMode !== 'byok' || (execByok.activeProvider || 'anthropic') !== prov) return;
    const live = (res && res.models) || [];
    if (live.length) execModelCli.setOptions(build(live), saved);
    const [text, kind] = modelHintFor(res, prov);
    execSetModelHint(text, kind);
  }).catch(() => execSetModelHint('Couldn’t refresh — showing saved list.', 'warn'));
}

function execSetModelHint(text: string, kind?: string): void {
  if (!execModelHint) return;
  execModelHint.textContent = text || '';
  execModelHint.className = 'exec-model-hint' + (kind ? ' ' + kind : '');
  execModelHint.hidden = !text;
}

// (BYOK live model loading now lives in renderByokModelSelect — it renders into
// the real <select> so every model shows, not a value-filtered datalist.)

// Map the live-fetch outcome to a SPECIFIC, honest hint (see main models:list).
// auth is the only hard error (red); the rest are soft "showing saved list".
function modelHintFor(res: any, prov: string): [string, string] {
  const name = BYOK_DISPLAY[prov] || prov;
  const err = res && res.error;
  if (!err) return ['', ''];
  switch (err) {
    case 'no_key':  return ['Add a key to load models.', ''];
    case 'auth':    return ['Key rejected — check your API key.', 'warn'];
    case 'network': return [`Couldn’t reach ${name} — showing saved list.`, ''];
    case 'empty':   return ['No models returned.', ''];
    default:        return ['Couldn’t refresh — showing saved list.', ''];
  }
}

// Pull the current config snapshot and render every section.
async function refreshExecMenu(): Promise<void> {
  let status = null;
  try { status = await window.hub.getKeyStatus(); } catch (_) {}
  execMode  = (status && status.executionMode) || 'local';
  execByok  = (status && status.byok)  || { activeProvider: 'anthropic', providers: {} };
  execLocal = (status && status.localCli) || { activeId: null, clis: [] };
  renderExecModeSeg();
  renderExecAgents();
  renderExecModel();
  updateExecBtnIcon();
}

async function selectCloudAgent(prov: string): Promise<void> {
  // Activation is gated in main (Active requires Connected). Only reflect the
  // new active locally if main accepted it; otherwise route to settings.
  let ok = true;
  if (window.hub && typeof window.hub.activateByokProvider === 'function') {
    const r = await window.hub.activateByokProvider(prov).catch(() => null);
    ok = Boolean(r && r.ok);
  }
  if (!ok) { openSettingsForProvider(prov); return; }
  execByok.activeProvider = prov;
  renderExecAgents();
  renderExecModel();
  updateExecBtnIcon();
  refreshKeyStatus(); // keep the hub's key badge in sync with the new active agent
}

async function selectLocalCli(id: string): Promise<void> {
  if (window.hub && typeof window.hub.setLocalCli === 'function') {
    await window.hub.setLocalCli(id).catch(() => {});
  }
  execLocal.activeId = id;
  renderExecAgents();
  renderExecModel(); // model selector differs per CLI
  updateExecBtnIcon();
  refreshKeyStatus();
}

// A keyless provider can't be silently activated — send the user to Settings
// (Execution mode) with that provider's key fields focused.
function openSettingsForProvider(prov: string): void {
  openAssistantSettings();
  // Open the settings BYOK pane with that provider's card expanded + focused.
  if (typeof byokExpandProvider === 'function') byokExpandProvider(prov);
}

function openLocalSettings(): void {
  openAssistantSettings();
  if (typeof exShowMode === 'function') exShowMode('local');
  // Expand the "Available to install" group and bring it into view.
  const toggle = document.getElementById('ex-avail-toggle');
  const list = document.getElementById('ex-avail-list');
  if (toggle && list && list.hidden) toggle.click();
  if (toggle) toggle.scrollIntoView({ block: 'nearest' });
}

function openExecMenu(anchor?: HTMLElement | null): void {
  // Anchor to WHATEVER opened the menu. The parameter exists because the menu
  // now has openers that are not exec buttons at all — Ask's model chip — and
  // the fallback lookup below cannot find those. It is also load-bearing for
  // another reason: after the top-bar relayout the only exec button left,
  // #exec-mode-btn-cap, is display:none outside body.cap-focus, so from any
  // other surface execBtnVisible() returns a hidden element whose rect is all
  // zeros and the menu would position itself off a phantom at the viewport
  // origin. Callers that ARE exec buttons keep calling with no argument.
  //
  // The dismiss/Escape closures below capture this same `btn`, so an anchored
  // open also gets "clicking the opener doesn't insta-close" and "Escape
  // returns focus to the opener" for free.
  const btn = anchor || execBtnVisible();
  if (!execMenu || !btn) return;
  closeSettingsMenu();
  execMenu.hidden = false;
  const r = btn.getBoundingClientRect();
  let left = r.right - execMenu.offsetWidth;
  if (left < 12) left = 12;
  execMenu.style.left = left + 'px';
  // Open toward whichever side has more room, pinning the FAR edge so the menu
  // stays on screen as the agent list fills in asynchronously, and capping its
  // height to the space available so a short window scrolls instead of clipping.
  //
  // This one branch serves both buttons with no second positioning path: the
  // sidebar button sits at the BOTTOM, so more room above wins and the menu
  // opens upward; the capture button sits in the TOP bar, so more room below
  // wins and the same branch opens it downward. Verified in the real app rather
  // than assumed — see the open-menu screenshot on the PR.
  if (r.top > window.innerHeight - r.bottom) {
    execMenu.style.top = 'auto';
    execMenu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    execMenu.style.maxHeight = (r.top - 12) + 'px';
  } else {
    execMenu.style.bottom = 'auto';
    execMenu.style.top = (r.bottom + 6) + 'px';
    execMenu.style.maxHeight = (window.innerHeight - r.bottom - 18) + 'px';
  }
  execMenu.style.overflowY = 'auto';
  btn.setAttribute('aria-expanded', 'true');
  _execOpener = btn;
  refreshExecMenu();
  // Scan PATH once so Local status is fresh without first opening Settings.
  if (!execDidScan && window.hub && typeof window.hub.detectLocalClis === 'function') {
    execDidScan = true;
    window.hub.detectLocalClis().then(local => {
      if (!local) return;
      execLocal = local;
      if (!execMenu.hidden) { renderExecAgents(); updateExecBtnIcon(); }
    }).catch(() => {});
  }
  _execDismiss = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    // A model dropdown's list is mounted in <body> (outside the menu) — clicks in
    // it must not dismiss the menu.
    if (t.closest && t.closest('.dd-list')) return;
    if (!execMenu.contains(t) && !btn.contains(t)) closeExecMenu();
  };
  _execEsc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.dd-list')) return; // let an open dropdown handle Escape first
    closeExecMenu(); btn.focus();
  };
  document.addEventListener('click', _execDismiss, true);
  document.addEventListener('keydown', _execEsc, true);
}

function closeExecMenu(): void {
  if (!execMenu) return;
  if (execModelCli && typeof execModelCli.close === 'function') execModelCli.close();
  execMenu.hidden = true;
  // Clear on BOTH exec buttons: only the opener was ever set, and clearing the
  // other is a no-op rather than a branch. The tracked opener covers anchors
  // that are not exec buttons at all (Ask's model chip).
  execBtns().forEach((b) => b.setAttribute('aria-expanded', 'false'));
  if (_execOpener) { _execOpener.setAttribute('aria-expanded', 'false'); _execOpener = null; }
  if (_execDismiss) { document.removeEventListener('click', _execDismiss, true); _execDismiss = null; }
  if (_execEsc)     { document.removeEventListener('keydown', _execEsc, true);  _execEsc = null; }
}
