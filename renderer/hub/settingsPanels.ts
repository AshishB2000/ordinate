// Execution settings panes — the BYOK provider cards and the Local CLI
// detection panel inside Settings → Execution. Extracted from hub.js as a pure
// structural move (no logic changes). Self-contained: its own state (exByok*,
// lc*), DOM refs, and the panes' event wiring all move together. Classic script
// sharing global scope: agentIconHTML (execMenu.js), refreshKeyStatus + the
// BYOK/brand tables (hub.js), and window.hub IPC resolve at call time.

// ── Execution mode pane (Local CLI / BYOK) ──────────────────────────────────
const EX_KEY_PAGES = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai:    'https://platform.openai.com/api-keys',
  gemini:    'https://aistudio.google.com/app/apikey',
  gateway:   '',
};

// Default API base URL per provider — mirrors BYOK_DEFAULTS in src/config.js.
// Shown pre-filled in each card so it works out of the box but can be customized
// (e.g. a proxy or self-hosted endpoint). Gateway has no default — it's required.
const EX_DEFAULT_BASE = {
  anthropic: 'https://api.anthropic.com',
  openai:    'https://api.openai.com/v1',
  gemini:    'https://generativelanguage.googleapis.com/v1beta',
  gateway:   '',
};

const exModeSeg    = document.getElementById('ex-mode-seg');
const exLocalPanel = document.getElementById('ex-local-panel');
const exByokPanel  = document.getElementById('ex-byok-panel');
// BYOK is now a card layout mirroring Local CLI: connected providers on top,
// available-to-connect below (see renderByokProviders / byokCard).
const exByokConnGroup = document.getElementById('ex-byok-conn-group');
const exByokConnCount = document.getElementById('ex-byok-conn-count');
const exByokConnList  = document.getElementById('ex-byok-conn-list');
const exByokConnEmpty = document.getElementById('ex-byok-conn-empty');
const exByokAvailToggle = document.getElementById('ex-byok-avail-toggle');
const exByokAvailCount  = document.getElementById('ex-byok-avail-count');
const exByokAvailList   = document.getElementById('ex-byok-avail-list');
// Memory model controls were removed from the UI (no feature consumes them yet).
// config.memoryModel + its setter + the analyze.js integration point are kept.

let exByokStatus = {};          // { provider: { hasKey, verified, connected, baseUrl, maxTokens, model } }
let exByokActive = null;        // effective active provider (connected) or null
let exByokExpanded = new Set(); // providers whose card body is open (persist across re-render)

function exShowMode(mode) {
  if (exModeSeg) exModeSeg.querySelectorAll('.stp-seg-opt').forEach(b =>
    b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode));
  if (exLocalPanel) exLocalPanel.hidden = mode !== 'local';
  if (exByokPanel)  exByokPanel.hidden  = mode !== 'byok';
}

// ── BYOK provider cards (mirror the Local CLI layout) ───────────────────────
// Connected = key saved AND verified by a real Test (config.byok verified).
// A passing Test promotes a card from "Available to connect" into "Your
// connected providers". exByokStatus/exByokActive come from publicByok (one
// source of truth shared with the header popup).

function renderByokProviders() {
  if (!exByokConnList || !exByokAvailList) return;
  const connected = BYOK_AGENTS.filter(p => (exByokStatus[p] || {}).connected);
  const avail     = BYOK_AGENTS.filter(p => !(exByokStatus[p] || {}).connected);

  exByokConnList.innerHTML = '';
  connected.forEach(p => exByokConnList.appendChild(byokCard(p)));
  if (exByokConnCount) exByokConnCount.textContent = String(connected.length);
  if (exByokConnGroup) exByokConnGroup.hidden = connected.length === 0;
  if (exByokConnEmpty) exByokConnEmpty.hidden = connected.length !== 0;

  exByokAvailList.innerHTML = '';
  avail.forEach(p => exByokAvailList.appendChild(byokCard(p)));
  if (exByokAvailCount) exByokAvailCount.textContent = String(avail.length);
}

// Re-fetch the byok status from main and re-render the cards (used after a Test
// or activate so promotion/active state reflects immediately).
async function byokRefresh() {
  if (!window.hub || typeof window.hub.getKeyStatus !== 'function') return;
  try {
    const status = await window.hub.getKeyStatus();
    const byok = (status && status.byok) || { activeProvider: null, providers: {} };
    exByokStatus = byok.providers || {};
    exByokActive = byok.activeProvider || null;
    renderByokProviders();
  } catch (_) {}
}

function byokCard(prov) {
  const d = exByokStatus[prov] || {};
  const connected = Boolean(d.connected);
  const isActive = connected && prov === exByokActive;
  const open = exByokExpanded.has(prov);

  const card = lcMakeEl('div', 'ex-cli-row ex-byok-card'
    + (connected ? '' : ' ex-cli-avail') + (isActive ? ' selected' : '') + (open ? ' open' : ''));
  card.dataset.prov = prov;

  const head = lcMakeEl('button', 'ex-byok-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  const icon = lcMakeEl('span', 'ex-cli-icon');
  icon.innerHTML = agentIconHTML(prov, BYOK_DISPLAY[prov] || prov, 18);
  head.appendChild(icon);
  const main = lcMakeEl('span', 'ex-cli-main');
  main.appendChild(lcMakeEl('span', 'ex-cli-name', BYOK_DISPLAY[prov] || prov));
  main.appendChild(lcMakeEl('span', 'ex-cli-vendor', connected ? 'Connected' : 'Not connected'));
  head.appendChild(main);
  const ha = lcMakeEl('span', 'ex-cli-actions');
  if (isActive) ha.appendChild(lcMakeEl('span', 'ex-byok-active-tag', 'Active'));
  ha.appendChild(lcMakeEl('span', 'ex-collapse-caret ex-byok-caret', '▸'));
  head.appendChild(ha);
  card.appendChild(head);

  const body = lcMakeEl('div', 'ex-byok-body');
  body.hidden = !open;
  buildByokBody(body, prov, d, connected, isActive);
  card.appendChild(body);
  if (open) byokFillCardModels(body, prov);

  head.addEventListener('click', () => {
    const willOpen = body.hidden;
    body.hidden = !willOpen;
    card.classList.toggle('open', willOpen);
    head.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) { exByokExpanded.add(prov); byokFillCardModels(body, prov); }
    else exByokExpanded.delete(prov);
  });
  return card;
}

// A field label, optionally with a "Get key ↗" external link.
function byokLabel(text, linkText?, url?) {
  const lab = lcMakeEl('span', 'ex-byok-flabel', text);
  if (linkText && url) {
    const a = lcMakeEl('a', 'ex-link', linkText);
    a.href = '#';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.hub && typeof window.hub.openExternal === 'function') window.hub.openExternal(url);
    });
    lab.appendChild(document.createTextNode(' '));
    lab.appendChild(a);
  }
  return lab;
}

function byokFieldRow(labelEl, controlEl) {
  const row = lcMakeEl('div', 'ex-byok-field');
  row.appendChild(labelEl);
  row.appendChild(controlEl);
  return row;
}

function buildByokBody(body, prov, d, connected, isActive) {
  body.innerHTML = '';

  // API key (+ Show toggle, + Get key link). A SAVED key shows as a fixed row of
  // mask dots by DEFAULT — never the plaintext, and not its real length. The raw
  // key never enters the DOM: "Show" fetches it on demand (revealByokKey) and
  // toggling again re-masks. Storage is unchanged (safeStorage in main).
  const KEY_MASK = '••••••••••••••••';
  const keyField = lcMakeEl('div', 'ex-key-field');
  const keyInput = lcMakeEl('input', 'sp-key-input');
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  const showBtn = lcMakeEl('button', 'btn btn-sm btn-ghost', 'Show');
  showBtn.type = 'button';
  let revealedKey = '';  // the saved key once revealed, so we don't re-save it unchanged

  // Masked: dots stand in for the saved key (the real key is NOT in the DOM).
  function maskKeyField() {
    keyInput.value = KEY_MASK;
    keyInput.type = 'password';
    keyInput.dataset.masked = '1';
    keyInput.placeholder = '';
    showBtn.textContent = 'Show';
    revealedKey = '';
  }
  // Empty, ready for a new key.
  function clearKeyField() {
    delete keyInput.dataset.masked;
    keyInput.value = '';
    keyInput.type = 'password';
    keyInput.placeholder = d.hasKey ? 'Paste a new API key to replace' : 'Paste your API key';
    showBtn.textContent = 'Show';
    revealedKey = '';
  }

  showBtn.addEventListener('click', async () => {
    // Masked saved key → reveal the real key on demand.
    if (keyInput.dataset.masked === '1') {
      const k = (window.hub && typeof window.hub.revealByokKey === 'function')
        ? await window.hub.revealByokKey(prov).catch(() => '') : '';
      if (k) {
        delete keyInput.dataset.masked;
        keyInput.value = k; revealedKey = k;
        keyInput.type = 'text';
        showBtn.textContent = 'Hide';
      }
      return;
    }
    // Revealed saved key → re-mask back to dots.
    if (revealedKey && keyInput.value === revealedKey) { maskKeyField(); return; }
    // Otherwise just toggle visibility of whatever the user is typing.
    const toText = keyInput.type === 'password';
    keyInput.type = toText ? 'text' : 'password';
    showBtn.textContent = toText ? 'Hide' : 'Show';
  });

  // Clicking into a masked field clears the dots so a new key can be typed; leaving
  // it untouched restores the mask.
  keyInput.addEventListener('focus', () => { if (keyInput.dataset.masked === '1') clearKeyField(); });
  keyInput.addEventListener('blur', () => { if (!keyInput.value.trim() && d.hasKey && !revealedKey) maskKeyField(); });
  // Typing clears the "revealed" marker so an edit is treated as a new key.
  keyInput.addEventListener('input', () => { if (keyInput.value !== revealedKey) revealedKey = ''; });
  keyInput.addEventListener('change', () => {
    const v = keyInput.value.trim();
    if (!v || v === revealedKey || keyInput.dataset.masked === '1') return;  // never save the mask
    byokSave(prov, { apiKey: v });
    d.hasKey = true;
    maskKeyField();   // show dots for the newly saved key
  });

  // Default state: masked dots when a key is saved, else empty + placeholder.
  if (d.hasKey) maskKeyField(); else clearKeyField();

  keyField.appendChild(keyInput);
  keyField.appendChild(showBtn);
  body.appendChild(byokFieldRow(byokLabel('API key', EX_KEY_PAGES[prov] ? 'Get key ↗' : '', EX_KEY_PAGES[prov]), keyField));

  // Base URL — shown for every provider, pre-filled with the provider default so
  // it works out of the box but can be pointed at a proxy / self-hosted endpoint.
  // Clearing it falls back to the default (Gateway has none → stays empty/required).
  const defBase = EX_DEFAULT_BASE[prov] || '';
  const urlInput = lcMakeEl('input', 'sp-key-input ex-wide');
  urlInput.type = 'url'; urlInput.spellcheck = false;
  urlInput.placeholder = defBase || 'https://…';
  urlInput.value = d.baseUrl || defBase;
  urlInput.addEventListener('change', () => {
    const v = urlInput.value.trim() || defBase;
    urlInput.value = v;                       // normalize cleared field back to default
    byokSave(prov, { baseUrl: v });
  });
  body.appendChild(byokFieldRow(byokLabel('Base URL'), urlInput));

  // Max tokens
  const mtInput = lcMakeEl('input', 'sp-key-input ex-narrow');
  mtInput.type = 'number'; mtInput.min = '1'; mtInput.placeholder = '4096';
  mtInput.value = d.maxTokens || '';
  mtInput.addEventListener('change', () => byokSave(prov, { maxTokens: mtInput.value.trim() }));
  body.appendChild(byokFieldRow(byokLabel('Max tokens'), mtInput));

  // Model. Gateway/custom can't auto-list an arbitrary endpoint's models, so the
  // user types the exact model id (e.g. openai/gpt-4o-mini, or an OpenRouter id like
  // google/gemini-2.0-flash-exp:free). Other providers get the populated dropdown.
  let modelSel;
  if (prov === 'gateway') {
    const modelInput = lcMakeEl('input', 'sp-key-input ex-byok-model');
    modelInput.type = 'text';
    modelInput.spellcheck = false;
    modelInput.setAttribute('autocomplete', 'off');
    modelInput.placeholder = 'e.g. openai/gpt-4o-mini';
    modelInput.value = (exByokStatus[prov] || {}).model || '';
    modelInput.addEventListener('change', () => byokSave(prov, { model: modelInput.value.trim() }));
    body.appendChild(byokFieldRow(byokLabel('Model'), modelInput));
    modelSel = modelInput;
  } else {
    modelSel = makeDropdown({
      className: 'exec-model-dd ex-byok-model',
      ariaLabel: 'Model',
      onChange: (v) => byokSave(prov, { model: v }),
    });
    body.appendChild(byokFieldRow(byokLabel('Model'), modelSel.el));
  }

  // Test + result (+ Set as active for connected, non-active providers)
  const testRow = lcMakeEl('div', 'ex-byok-field ex-byok-testrow');
  const testBtn = lcMakeEl('button', 'btn btn-sm', 'Test');
  testBtn.type = 'button';
  const testRes = lcMakeEl('span', 'ex-test-result');
  testRes.setAttribute('aria-live', 'polite');
  testBtn.addEventListener('click', () => byokTest(prov, testBtn, testRes, keyInput, urlInput, mtInput, modelSel));
  testRow.appendChild(testBtn);
  testRow.appendChild(testRes);
  if (connected && !isActive) {
    const actBtn = lcMakeEl('button', 'btn btn-sm ex-byok-setactive', 'Set as active');
    actBtn.type = 'button';
    actBtn.addEventListener('click', async () => {
      if (!window.hub || typeof window.hub.activateByokProvider !== 'function') return;
      const r = await window.hub.activateByokProvider(prov).catch(() => null);
      if (r && r.ok) { exByokActive = prov; renderByokProviders(); refreshKeyStatus(); }
    });
    testRow.appendChild(actBtn);
  }
  body.appendChild(testRow);
}

// Populate a card's model <select> from the shared live source (cache-first),
// merged with curated suggestions + the saved model. Persists via byokSave.
function byokFillCardModels(body, prov) {
  const el = body.querySelector('.ex-byok-model');
  const sel = el && el._dd;
  if (!sel) return;
  const saved = (exByokStatus[prov] || {}).model || '';
  const build = (list) => {
    const seen = new Set();
    const rows = [{ value: '', label: 'Default' }];
    (list || []).forEach(m => { if (m.id && !seen.has(m.id)) { seen.add(m.id); rows.push({ value: m.id, label: m.label || m.id }); } });
    if (saved && !seen.has(saved)) rows.push({ value: saved, label: saved });
    return rows;
  };
  sel.setOptions(build((PROVIDER_MODELS[prov] || []).map(m => ({ id: m.v, label: m.l }))), saved);
  if (window.hub && typeof window.hub.listModels === 'function') {
    window.hub.listModels(prov, false).then(res => {
      const live = (res && res.models) || [];
      if (live.length) sel.setOptions(build(live), saved);
    }).catch(() => {});
  }
}

async function byokSave(prov, fields) {
  if (!window.hub || typeof window.hub.saveByokProvider !== 'function') return;
  await window.hub.saveByokProvider(prov, fields).catch(() => {});
  exByokStatus[prov] = { ...(exByokStatus[prov] || {}), ...fields };
  if ('apiKey' in fields) exByokStatus[prov].hasKey = Boolean(fields.apiKey);
  // A changed credential invalidates verification (mirrors main) — must re-test.
  if ('apiKey' in fields || 'baseUrl' in fields) {
    exByokStatus[prov].verified = false;
    exByokStatus[prov].connected = false;
  }
}

async function byokTest(prov, btn, res, keyInput, urlInput, mtInput, modelSel) {
  if (!window.hub || typeof window.hub.testByokProvider !== 'function') return;
  // Save pending edits first so the test uses current values. Skip the mask dots —
  // a masked field means "use the already-saved key", never save the placeholder.
  const pending: any = {};
  if (keyInput && keyInput.value.trim() && keyInput.dataset.masked !== '1') pending.apiKey = keyInput.value.trim();
  if (urlInput) pending.baseUrl = urlInput.value.trim() || (EX_DEFAULT_BASE[prov] || '');
  if (mtInput)  pending.maxTokens = mtInput.value.trim();
  if (modelSel && modelSel.value) pending.model = String(modelSel.value).trim();
  await byokSave(prov, pending);
  if (pending.apiKey && keyInput) keyInput.value = '';

  btn.disabled = true;
  res.textContent = 'Testing…';
  res.className = 'ex-test-result';
  try {
    const r = await window.hub.testByokProvider(prov);
    if (r && r.ok) {
      res.textContent = '✓ Connected';
      res.className = 'ex-test-result ex-test-ok';
      exByokExpanded.add(prov);   // keep the card open as it promotes upward
      await byokRefresh();        // re-fetch verified state → moves into "connected"
    } else {
      const map = { auth: 'Key rejected', network: 'Network error', rate_limit: 'Rate limited', provider: 'Endpoint error', bad_reply: 'Unexpected reply' };
      // Prefer the SPECIFIC cause: detail carries "<provider> · <status> · <body>"
      // (e.g. "Gateway · 404 · model not found"); then a custom message; then the
      // generic label. Full text on hover since the result line clamps.
      const label = (r && r.detail) || (r && r.message) || (r && map[r.errorType]) || 'Failed';
      res.textContent = '✕ ' + label;
      res.title = label;
      res.className = 'ex-test-result ex-test-err';
    }
  } catch (_) {
    res.textContent = '✕ Failed';
    res.className = 'ex-test-result ex-test-err';
  } finally {
    btn.disabled = false;
  }
}

// Open the settings pane at BYOK and expand a specific provider's card (used by
// the header popup when a not-connected agent is clicked).
function byokExpandProvider(prov) {
  exShowMode('byok');
  exByokExpanded.add(prov);
  renderByokProviders();
  const list = exByokConnList && exByokConnList.querySelector(`.ex-byok-card[data-prov="${prov}"]`)
    ? exByokConnList : exByokAvailList;
  const card = list && list.querySelector(`.ex-byok-card[data-prov="${prov}"]`);
  if (card) {
    const key = card.querySelector('.sp-key-input');
    if (key) (key as HTMLElement).focus();
    card.scrollIntoView({ block: 'nearest' });
  }
}

// Memory model UI removed — config.memoryModel + window.hub.setMemoryModel are
// kept (main/preload) for when a memory/summary feature is actually built.

async function refreshExecPane() {
  if (!window.hub || typeof window.hub.getKeyStatus !== 'function') return;
  try {
    const status = await window.hub.getKeyStatus();
    const byok = (status && status.byok) || { activeProvider: null, providers: {} };
    exByokStatus = byok.providers || {};
    exByokActive = byok.activeProvider || null;
    exShowMode((status && status.executionMode) || 'local');
    renderByokProviders();

    // Local CLI panel: render instantly from cached detection, then scan once
    // in the background (subsequent opens use the persisted cache).
    if (status && status.localCli) lcRenderLocal(status.localCli);
    if (!lcDidInitialScan) { lcDidInitialScan = true; lcDetect(); }
  } catch (_) {}
}

if (exModeSeg) {
  exModeSeg.addEventListener('click', async (e) => {
    const opt = (e.target as HTMLElement).closest('.stp-seg-opt[data-mode]') as HTMLElement;
    if (!opt) return;
    exShowMode(opt.dataset.mode);
    if (window.hub && typeof window.hub.setExecutionMode === 'function') {
      await window.hub.setExecutionMode(opt.dataset.mode).catch(() => {});
    }
  });
}

// "Available to connect" is now a static header (always visible), styled like
// "Your connected providers" — no collapse toggle.

// ── Local CLI panel (detection) ─────────────────────────────────────────────
const lcRescanBtn   = document.getElementById('ex-rescan');
const lcScanning    = document.getElementById('ex-local-scanning');
const lcInstGroup   = document.getElementById('ex-installed-group');
const lcInstCount   = document.getElementById('ex-installed-count');
const lcInstList    = document.getElementById('ex-installed-list');
const lcInstEmpty   = document.getElementById('ex-installed-empty');
const lcAvailToggle = document.getElementById('ex-avail-toggle');
const lcAvailCount  = document.getElementById('ex-avail-count');
const lcAvailList   = document.getElementById('ex-avail-list');

let lcActiveId = null;
let lcModels = {};            // per-CLI selected model, e.g. { antigravity: '...' }
let lcDidInitialScan = false;


function lcMakeEl(tag, cls?, text?) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

// Build one installed-CLI row (selectable).
function lcInstalledRow(cli) {
  const row = lcMakeEl('button', 'ex-cli-row');
  row.type = 'button';
  row.dataset.id = cli.id;
  if (cli.id === lcActiveId) row.classList.add('selected');

  const icon = lcMakeEl('span', 'ex-cli-icon');
  icon.innerHTML = agentIconHTML(cli.id, cli.displayName, 18);
  row.appendChild(icon);

  const main = lcMakeEl('span', 'ex-cli-main');
  const nameRow = lcMakeEl('span', 'ex-cli-name', cli.displayName);
  const ver = lcMakeEl('span', 'ex-cli-ver', cli.version ? ('v' + cli.version) : 'version unknown');
  nameRow.appendChild(ver);
  main.appendChild(nameRow);
  main.appendChild(lcMakeEl('span', 'ex-cli-vendor', cli.vendor));
  // Optional per-CLI heads-up (e.g. Cursor's first-run macOS permission prompt).
  if (cli.note) {
    const note = lcMakeEl('span', 'ex-cli-note', cli.note);
    note.title = cli.note; // full text on hover if clamped
    main.appendChild(note);
  }
  // Model row. Antigravity (live `agy models`), Claude Code and Codex (curated
  // static lists) support model selection; other CLIs use whatever they're
  // configured for.
  const modelRow = lcMakeEl('span', 'ex-cli-model');
  modelRow.appendChild(lcMakeEl('span', 'ex-cli-model-lbl', 'Model'));
  if (MODEL_LIST_CLIS.includes(cli.id)) {
    const saved = (lcModels || {})[cli.id] || '';
    const sel = makeDropdown({
      className: 'dd-sm ex-cli-model-dd',
      listClassName: 'dd-list-sm',
      ariaLabel: 'Model',
      placeholder: 'Default',
      onChange: (v) => {
        if (window.hub && typeof window.hub.saveCliModel === 'function') {
          window.hub.saveCliModel(cli.id, v).catch(() => {});
        }
        lcModels = { ...(lcModels || {}), [cli.id]: v };
      },
    });
    sel.el.addEventListener('click', (e) => e.stopPropagation()); // the row is a button; don't row-select
    const skel = [{ value: '', label: 'Default' }];
    if (saved) skel.push({ value: saved, label: saved });
    sel.setOptions(skel, saved);
    if (window.hub && typeof window.hub.listCliModels === 'function') {
      window.hub.listCliModels(cli.id).then((res) => {
        const models = (res && res.ok && res.models) || [];
        if (!models.length) return;
        const opts = [{ value: '', label: 'Default' }].concat(models.map(m => ({ value: m, label: m })));
        if (saved && !models.includes(saved)) opts.push({ value: saved, label: saved });
        sel.setOptions(opts, saved);
      }).catch(() => {});
    }
    modelRow.appendChild(sel.el);
  } else {
    modelRow.appendChild(lcMakeEl('span', 'ex-cli-model-val', 'Default (CLI config)'));
  }
  main.appendChild(modelRow);
  row.appendChild(main);

  const actions = lcMakeEl('span', 'ex-cli-actions');
  actions.appendChild(lcMakeEl('span', 'ex-cli-selected-tag', 'Selected'));
  // Per-CLI connectivity test — only CLIs with a working run adapter.
  if (RUNNABLE_LOCAL.includes(cli.id)) {
    const test = lcMakeEl('button', 'btn btn-sm ex-cli-test', 'Test');
    test.type = 'button';
    // The result lives in `main` (full-width column), NOT in the narrow actions
    // row, so a long error wraps/clamps within the card instead of overflowing.
    const res = lcMakeEl('span', 'ex-cli-test-result');
    const setRes = (text, cls, full?) => {
      res.textContent = text;
      res.className = 'ex-cli-test-result' + (cls ? ' ' + cls : '');
      if (full) res.title = full; else res.removeAttribute('title'); // full text on hover
    };
    test.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't trigger row-select
      if (!window.hub || typeof window.hub.testLocalCli !== 'function') return;
      test.disabled = true;
      setRes('Testing…', '');
      try {
        const r = await window.hub.testLocalCli(cli.id);
        if (r && r.ok) {
          setRes('✓ Connected', 'ex-test-ok');
        } else {
          const msg = (r && r.message) || 'Test failed.';
          setRes('✕ ' + msg, 'ex-test-err', msg);
        }
      } catch (_) {
        setRes('✕ Test failed.', 'ex-test-err');
      } finally {
        test.disabled = false;
      }
    });
    actions.appendChild(test);
    main.appendChild(res);
  }
  row.appendChild(actions);

  row.addEventListener('click', async () => {
    lcActiveId = cli.id;
    lcInstList.querySelectorAll('.ex-cli-row').forEach(r =>
      r.classList.toggle('selected', (r as HTMLElement).dataset.id === cli.id));
    if (window.hub && typeof window.hub.setLocalCli === 'function') {
      await window.hub.setLocalCli(cli.id).catch(() => {});
    }
  });
  return row;
}

// Build one available-to-install row.
function lcAvailRow(cli) {
  const row = lcMakeEl('div', 'ex-cli-row ex-cli-avail');
  row.dataset.id = cli.id;

  if (cli.status === 'retired') row.classList.add('ex-cli-retired');

  const icon = lcMakeEl('span', 'ex-cli-icon');
  icon.innerHTML = agentIconHTML(cli.id, cli.displayName, 18);
  row.appendChild(icon);

  const main = lcMakeEl('span', 'ex-cli-main');
  main.appendChild(lcMakeEl('span', 'ex-cli-name', cli.displayName));
  main.appendChild(lcMakeEl('span', 'ex-cli-vendor', cli.vendor));
  const note = lcMakeEl('span', 'ex-cli-note');
  if (cli.status === 'retired') {
    // Retired CLI: honest copy, never probed or run, no install action.
    note.textContent = cli.retiredNote || 'Retired — no longer available.';
  } else if (cli.installOnly || !cli.binaryName) {
    note.textContent = 'Install to use this CLI with Screenchart.';
  } else {
    const code = lcMakeEl('code', null, cli.binaryName);
    note.appendChild(code);
    note.appendChild(document.createTextNode(' was not found on your PATH'));
  }
  main.appendChild(note);
  row.appendChild(main);

  // Retired entries are informational only — no re-check, no install.
  if (cli.status === 'retired') return row;

  const actions = lcMakeEl('span', 'ex-cli-actions');
  // Per-row re-check (only meaningful for probeable CLIs).
  if (cli.binaryName && !cli.installOnly) {
    const refresh = lcMakeEl('button', 'ex-cli-refresh');
    refresh.type = 'button';
    refresh.title = 'Re-check ' + cli.displayName;
    refresh.setAttribute('aria-label', 'Re-check ' + cli.displayName);
    refresh.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M1 4v6h6M23 20v-6h-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    refresh.addEventListener('click', async () => {
      if (!window.hub || typeof window.hub.detectOneCli !== 'function') return;
      refresh.disabled = true;
      try {
        const local = await window.hub.detectOneCli(cli.id);
        lcRenderLocal(local);
      } catch (_) { refresh.disabled = false; }
    });
    actions.appendChild(refresh);
  }
  const install = lcMakeEl('button', 'btn btn-sm ex-cli-install', 'Install');
  install.type = 'button';
  install.addEventListener('click', () => {
    if (cli.installUrl && window.hub && typeof window.hub.openExternal === 'function') {
      window.hub.openExternal(cli.installUrl);
    }
  });
  actions.appendChild(install);
  row.appendChild(actions);
  return row;
}

// Render the Local CLI panel from a { activeId, detectedAt, clis } view.
function lcRenderLocal(local) {
  if (!local || !Array.isArray(local.clis)) return;
  lcActiveId = local.activeId || null;
  lcModels = local.models || {};
  const installed = local.clis.filter(c => c.status === 'installed');
  const avail = local.clis.filter(c => c.status !== 'installed');

  if (lcInstList) {
    lcInstList.innerHTML = '';
    installed.forEach(c => lcInstList.appendChild(lcInstalledRow(c)));
  }
  if (lcInstCount) lcInstCount.textContent = String(installed.length);
  if (lcInstGroup) lcInstGroup.hidden = installed.length === 0;
  if (lcInstEmpty) lcInstEmpty.hidden = installed.length !== 0;

  if (lcAvailList) {
    lcAvailList.innerHTML = '';
    avail.forEach(c => lcAvailList.appendChild(lcAvailRow(c)));
  }
  if (lcAvailCount) lcAvailCount.textContent = String(avail.length);
}

// Run a full rescan with a scanning state.
async function lcDetect() {
  if (!window.hub || typeof window.hub.detectLocalClis !== 'function') return;
  if (lcScanning) lcScanning.hidden = false;
  try {
    const local = await window.hub.detectLocalClis();
    lcRenderLocal(local);
  } catch (_) {} finally {
    if (lcScanning) lcScanning.hidden = true;
  }
}

if (lcRescanBtn) lcRescanBtn.addEventListener('click', lcDetect);

// "Available to install" is now a static header (always visible), styled like
// "Your CLIs" — no collapse toggle.
