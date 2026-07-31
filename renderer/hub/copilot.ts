// AI Copilot chat panel (Week 11). Classic global-scope renderer <script> — NO
// import/export; symbols are shared with the other hub scripts (workspace.ts owns
// the section router, datasets/visuals/dashboards own the open-entity globals this
// panel reads: expId/expName, vizEditingId, dashCurrent).
//
// The panel is a per-project chat that is CONTEXT-AWARE of whatever entity the user
// has open. It is a FEATURE, never a requirement: gated on execution readiness
// (soft hint, disabled composer — never an error dialog) AND a hard user OFF toggle
// (config.copilotEnabled). Every figure the model narrates is computed in MAIN
// (datasetStats / vizData / metricValue) and re-attached as FACTS each turn — the
// renderer never computes or sends a number; it only shows the answer + provenance.
//
// No new state tracking: buildCopilotContextRef() reads the existing open-entity
// globals directly. History lives on disk per project (survives reload) via the
// copilot:* IPC exposed on window.hub.

function aiEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// Guard against re-entrant sends while a question is in flight.
let copilotBusy = false;

// ── Context resolution ────────────────────────────────────────────────────────

// Resolve the active entity from the existing open-entity globals. Priority
// (dataset → visual → dashboard) matches the workspace nav order; the visible
// context indicator (renderCopilotContext) always shows the user what won, so the
// scope is never a mystery — closing an entity falls through to the next.
function buildCopilotContextRef(): { kind: string; id: string; label: string } {
  if (typeof expId === 'string' && expId) {
    const name = typeof expName === 'string' && expName ? expName : 'open dataset';
    return { kind: 'dataset', id: expId, label: 'dataset · ' + name };
  }
  if (typeof vizEditingId === 'string' && vizEditingId) {
    return { kind: 'visual', id: vizEditingId, label: 'visual · open visual' };
  }
  if (typeof dashCurrent !== 'undefined' && dashCurrent && dashCurrent.id) {
    const name = dashCurrent.name ? String(dashCurrent.name) : 'open dashboard';
    return { kind: 'dashboard', id: String(dashCurrent.id), label: 'dashboard · ' + name };
  }
  return { kind: '', id: '', label: 'whole project' };
}

// Render the small "what's in scope" indicator: the entity label + an
// app-computed chip (mirrors the provenance the model is actually grounded in).
function renderCopilotContext(): void {
  const el = aiEl('ai-context');
  if (!el) return;
  const ref = buildCopilotContextRef();
  el.textContent = '';
  const label = document.createElement('span');
  label.className = 'ai-context-label';
  label.textContent = 'Based on ' + ref.label;
  el.appendChild(label);
  const chip = document.createElement('span');
  chip.className = 'ai-chip';
  chip.textContent = 'stats app-computed';
  el.appendChild(chip);
}

// ── Message rendering (DOM only — textContent, never innerHTML, so nothing the
// model returns can inject markup) ─────────────────────────────────────────────

function appendCopilotBubble(role: string, text: string, provenance?: any): void {
  const list = aiEl('ai-messages');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'ai-msg ' + (role === 'assistant' ? 'ai-msg-assistant' : 'ai-msg-user');
  const bubble = document.createElement('div');
  bubble.className = 'ai-bubble';
  bubble.textContent = text;
  row.appendChild(bubble);

  if (role === 'assistant' && provenance && typeof provenance === 'object') {
    const prov = document.createElement('div');
    prov.className = 'ai-provenance';
    const chips: string[] = [];
    if (provenance.kind && provenance.name) chips.push(provenance.kind + ': ' + provenance.name);
    else if (provenance.kind) chips.push(String(provenance.kind));
    if (provenance.datasetName) chips.push('dataset: ' + provenance.datasetName);
    if (Array.isArray(provenance.columns) && provenance.columns.length) {
      const cols = provenance.columns.slice(0, 6).join(', ');
      chips.push('columns: ' + cols + (provenance.columns.length > 6 ? '…' : ''));
    }
    chips.push(provenance.note ? String(provenance.note) : 'stats app-computed');
    chips.forEach((c) => {
      const chip = document.createElement('span');
      chip.className = 'ai-chip';
      chip.textContent = c;
      prov.appendChild(chip);
    });
    row.appendChild(prov);
  }
  list.appendChild(row);
}

// Rebuild the whole message list from an authoritative turns array (disk truth).
function renderCopilotTurns(turns: any[]): void {
  const list = aiEl('ai-messages');
  if (!list) return;
  // Drop existing bubbles, keep the empty-state placeholder node.
  list.querySelectorAll('.ai-msg').forEach((n) => n.remove());
  const empty = aiEl('ai-empty');
  const has = Array.isArray(turns) && turns.length > 0;
  if (empty) empty.hidden = has;
  if (has) {
    turns.forEach((t) => appendCopilotBubble(t.role, typeof t.text === 'string' ? t.text : '', t.provenance));
  }
  scrollCopilotToBottom();
}

function scrollCopilotToBottom(): void {
  const list = aiEl('ai-messages');
  if (list) list.scrollTop = list.scrollHeight;
}

// ── Hint / composer state helpers ───────────────────────────────────────────────

function showCopilotHint(text: string): void {
  const hint = aiEl('ai-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.hidden = false;
}

function hideCopilotHint(): void {
  const hint = aiEl('ai-hint');
  if (hint) hint.hidden = true;
}

function setCopilotComposerEnabled(enabled: boolean): void {
  const input = aiEl<HTMLTextAreaElement>('ai-input');
  const send = aiEl<HTMLButtonElement>('ai-send');
  if (input) input.disabled = !enabled;
  if (send) send.disabled = !enabled;
}

function updateCopilotToggle(enabled: boolean): void {
  const btn = aiEl<HTMLButtonElement>('ai-toggle');
  if (!btn) return;
  btn.textContent = enabled ? 'Copilot: On' : 'Copilot: Off';
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  btn.classList.toggle('ai-toggle-off', !enabled);
}

// Show/hide the chat surface (context + messages + composer + clear) as a unit.
// The header (title + toggle) always stays visible so the user can turn Copilot
// back on without leaving the panel.
function setCopilotChatVisible(visible: boolean): void {
  const ids = ['ai-context', 'ai-messages', 'ai-composer'];
  ids.forEach((id) => {
    const el = aiEl(id);
    if (el) el.hidden = !visible;
  });
  const clear = aiEl('ai-clear');
  if (clear) clear.hidden = !visible;
}

// ── Data flow ────────────────────────────────────────────────────────────────

async function loadCopilotHistory(): Promise<void> {
  if (!currentProjectId) { renderCopilotTurns([]); return; }
  let res: any = null;
  try {
    res = await window.hub.copilotHistory(currentProjectId);
  } catch (_) { res = null; }
  renderCopilotTurns(res && res.ok && Array.isArray(res.turns) ? res.turns : []);
}

// Reconcile the whole panel with current readiness + the OFF switch. Called when
// the AI section activates (workspace.ts) and whenever key status changes.
async function refreshCopilot(): Promise<void> {
  let status: any = {};
  try {
    status = (await window.hub.getKeyStatus()) || {};
  } catch (_) { status = {}; }
  const enabled = status.copilotEnabled !== false;
  const ready = Boolean(status.isReady);

  updateCopilotToggle(enabled);

  if (!enabled) {
    setCopilotChatVisible(false);
    showCopilotHint('Copilot is off. Turn it on to ask questions about your data — it stays optional and only runs when you ask.');
    return;
  }

  setCopilotChatVisible(true);
  renderCopilotContext();
  await loadCopilotHistory();

  if (!ready) {
    setCopilotComposerEnabled(false);
    showCopilotHint('Connect a model in Execution settings to use Copilot. Your history is kept — it stays read-only until a model is connected.');
  } else {
    setCopilotComposerEnabled(true);
    hideCopilotHint();
  }
}

async function sendCopilot(): Promise<void> {
  if (copilotBusy) return;
  const input = aiEl<HTMLTextAreaElement>('ai-input');
  if (!input) return;
  const question = input.value.trim();
  if (!question || !currentProjectId) return;

  const ref = buildCopilotContextRef();

  // Optimistic UI: show the user's question + a pending marker immediately.
  hideCopilotHint();
  const empty = aiEl('ai-empty');
  if (empty) empty.hidden = true;
  appendCopilotBubble('user', question);
  appendCopilotBubble('assistant', 'Thinking…');
  scrollCopilotToBottom();

  input.value = '';
  copilotBusy = true;
  setCopilotComposerEnabled(false);

  let res: any = null;
  try {
    res = await window.hub.copilotAsk(currentProjectId, { kind: ref.kind, id: ref.id }, question);
  } catch (_) {
    res = { ok: false, error: 'Something went wrong. Try again.' };
  }

  copilotBusy = false;

  if (res && res.ok) {
    // Rebuild from disk truth (main persisted both turns on success).
    setCopilotComposerEnabled(true);
    if (Array.isArray(res.turns)) renderCopilotTurns(res.turns);
    else await loadCopilotHistory();
    hideCopilotHint();
    return;
  }

  // Failure: main left the thread unchanged, so reload from disk to drop the
  // optimistic bubbles, and restore the composer text so nothing is lost.
  await loadCopilotHistory();
  input.value = question;
  if (res && res.notReady) {
    setCopilotComposerEnabled(false);
    showCopilotHint('Connect a model in Execution settings to use Copilot.');
  } else {
    setCopilotComposerEnabled(true);
    showCopilotHint((res && res.error) || 'Could not answer that. Try again.');
  }
}

async function toggleCopilotEnabled(): Promise<void> {
  let status: any = {};
  try { status = (await window.hub.getKeyStatus()) || {}; } catch (_) { status = {}; }
  const next = status.copilotEnabled === false; // flip
  try { await window.hub.setCopilotEnabled(next); } catch (_) { /* ignore */ }
  await refreshCopilot();
}

async function clearCopilot(): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm('Clear this project’s Copilot chat? This cannot be undone.')) return;
  try {
    await window.hub.copilotClear(currentProjectId);
  } catch (_) { /* ignore */ }
  renderCopilotTurns([]);
}

// ── Boot wiring (once) ─────────────────────────────────────────────────────────

function initCopilot(): void {
  const send = aiEl('ai-send');
  if (send) send.addEventListener('click', () => sendCopilot());

  const input = aiEl<HTMLTextAreaElement>('ai-input');
  if (input) {
    // Enter sends; Shift+Enter inserts a newline.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCopilot();
      }
    });
  }

  const toggle = aiEl('ai-toggle');
  if (toggle) toggle.addEventListener('click', () => toggleCopilotEnabled());

  const clear = aiEl('ai-clear');
  if (clear) clear.addEventListener('click', () => clearCopilot());

  // Keep the panel honest when the execution path changes (key added/removed,
  // CLI detected). Same signal hub.ts uses for its readiness badge.
  if (window.hub && typeof window.hub.onKeyChanged === 'function') {
    window.hub.onKeyChanged(() => {
      if (currentSection === 'ai') refreshCopilot();
    });
  }
}
