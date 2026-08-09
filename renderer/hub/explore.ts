// Explore — the conversational front door (Phase 1: the surface).
//
// Classic global-scope renderer <script> — NO import/export; symbols are shared
// with the other hub scripts (workspace.ts owns the section router and
// currentProjectId, projects.ts owns the recent-item router, hub.ts owns
// formatSidebarTime).
//
// Explore is a PLACE, not a panel: a full-bleed stage with a greeting and a
// composer, over a "Jump back in" strip. Phase 1 builds the surface only — the
// composer is deliberately inert until Phase 2 wires copilot:ask. Nothing here
// computes, rounds or formats a figure; that stays main-process work.
//
// NAMING — `xp` is Explore's reserved prefix. `exp*` is the dataset explorer
// (expId/expName), `ex-`/`exec-` is execution mode, `ai-` is the copilot panel.
// A collision with any of those silently breaks an unrelated surface.

function xpEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ── Message rendering ─────────────────────────────────────────────────────────
//
// Moved here verbatim from the retired copilot panel (renderer/hub/copilot.ts),
// which Explore replaced. DOM only, textContent NEVER innerHTML — nothing the
// model returns can inject markup. That rule is the reason these are copied
// rather than rewritten.
//
// `containerId` defaults to Explore's own list, so every existing call site
// above is unchanged — exactly the pattern the retired copilot.ts used
// (`containerId = 'ai-messages'`) for the panel/Explore split. The dock
// (dock.ts) is the second caller now, passing 'dk-messages'; there is still
// only ONE rendering implementation.

function xpAppendBubble(role: string, text: string, provenance?: any, containerId = 'xp-messages'): void {
  const list = xpEl(containerId);
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'xp-msg ' + (role === 'assistant' ? 'xp-msg-assistant' : 'xp-msg-user');
  const bubble = document.createElement('div');
  bubble.className = 'xp-bubble';
  bubble.textContent = text;
  row.appendChild(bubble);

  if (role === 'assistant' && provenance && typeof provenance === 'object') {
    const prov = document.createElement('div');
    prov.className = 'xp-provenance';
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
      chip.className = 'xp-prov-chip';
      chip.textContent = c;
      prov.appendChild(chip);
    });
    row.appendChild(prov);
  }
  list.appendChild(row);
}

// Rebuild the whole transcript from an authoritative turns array (disk truth).
function xpRenderTurns(turns: any[], containerId = 'xp-messages'): void {
  const list = xpEl(containerId);
  if (!list) return;
  list.querySelectorAll('.xp-msg').forEach((n) => n.remove());
  if (Array.isArray(turns)) {
    turns.forEach((t) => xpAppendBubble(t.role, typeof t.text === 'string' ? t.text : '', t.provenance, containerId));
  }
  xpScrollToBottom(containerId);
}

function xpScrollToBottom(containerId = 'xp-messages'): void {
  const list = xpEl(containerId);
  if (list) list.scrollTop = list.scrollHeight;
}

// How many rows the "Jump back in" strip shows. The recent list itself is
// cross-project and already sorted newest-first in main (src/recent.ts).
const XP_JUMP_LIMIT = 10;

// ── Jump back in ──────────────────────────────────────────────────────────────

// One row per recent item: name, kind, relative time. Clicking routes through
// projects.ts's openRecentItem — the SAME router the Home rows use, so a new
// entity kind added there works here with no change.
function xpMakeJumpRow(it: any): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'xp-jump-row';
  row.dataset.type = String(it.type || '');
  row.dataset.id = String(it.id || '');

  const name = document.createElement('span');
  name.className = 'xp-jump-name';
  name.textContent = it.name || 'Untitled';

  const kind = document.createElement('span');
  kind.className = 'xp-jump-kind';
  kind.textContent =
    it.type === 'dataset' ? 'Dataset' : it.type === 'analysis' ? 'Analysis' : 'Dashboard';

  const time = document.createElement('span');
  time.className = 'xp-jump-time';
  // formatSidebarTime (hub.ts) is the app's one relative-time formatter.
  time.textContent = typeof formatSidebarTime === 'function'
    ? formatSidebarTime(it.updatedAt || null)
    : '';

  row.append(name, kind, time);
  row.addEventListener('click', () => {
    if (typeof openRecentItem === 'function') openRecentItem(it);
  });
  return row;
}

// One row per past conversation: title, turn count, relative time. Clicking
// resumes it in place. A thread id is a renderer key only — never a path
// component; only projectId ever reaches the filesystem.
function xpMakeThreadRow(t: any): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'xp-jump-row';
  row.dataset.threadId = String(t.id || '');

  const name = document.createElement('span');
  name.className = 'xp-jump-name';
  name.textContent = t.title || 'Conversation';

  const kind = document.createElement('span');
  kind.className = 'xp-jump-kind';
  const n = typeof t.turnCount === 'number' ? t.turnCount : 0;
  kind.textContent = n === 1 ? '1 turn' : n + ' turns';

  const time = document.createElement('span');
  time.className = 'xp-jump-time';
  time.textContent = typeof formatSidebarTime === 'function'
    ? formatSidebarTime(t.updatedAt || null)
    : '';

  row.append(name, kind, time);
  row.addEventListener('click', () => void xpOpenThread(String(t.id || '')));
  return row;
}

// Repaint the strip. Past CONVERSATIONS when this project has any; otherwise the
// cross-project recent list, so a first-time visitor still has somewhere to go.
// Empty → ONE muted line, deliberately not a card: an empty container with a
// border reads as a broken feature.
async function xpRenderJump(): Promise<void> {
  const host = xpEl('xp-jump-rows');
  if (!host) return;

  let threads: any[] = [];
  if (currentProjectId) {
    try {
      const res = await window.hub.copilotThreads(currentProjectId);
      threads = res && res.ok && Array.isArray(res.threads) ? res.threads : [];
    } catch (_) {
      threads = [];
    }
  }

  host.textContent = '';
  const heading = xpEl('xp-jump-h');
  const newBtn = xpEl<HTMLButtonElement>('xp-new-thread');
  const empty = xpEl('xp-jump-empty');
  const jump = xpEl('xp-jump');

  if (threads.length > 0) {
    if (heading) heading.textContent = 'Conversations';
    if (newBtn) newBtn.hidden = false;
    if (empty) empty.hidden = true;
    if (jump) jump.classList.remove('xp-jump-bare');
    threads.slice(0, XP_JUMP_LIMIT).forEach((t) => host.appendChild(xpMakeThreadRow(t)));
    return;
  }

  // No conversations in this project yet — fall back to recent items.
  if (heading) heading.textContent = 'Jump back in';
  if (newBtn) newBtn.hidden = true;
  let items: any[] = [];
  try {
    const res = await window.hub.recentItems(XP_JUMP_LIMIT);
    items = Array.isArray(res) ? res : [];
  } catch (_) {
    items = [];
  }
  if (empty) empty.hidden = items.length > 0;
  // Hide the whole strip's heading too when there is nothing at all to show.
  if (jump) jump.classList.toggle('xp-jump-bare', items.length === 0);
  items.slice(0, XP_JUMP_LIMIT).forEach((it) => host.appendChild(xpMakeJumpRow(it)));
}

// ── Conversations ─────────────────────────────────────────────────────────────

// Which conversation the composer is talking to. Empty means "the most recent",
// which is exactly what copilot:ask already defaults to — so it stays empty
// until the user picks or starts one, and no id is ever invented here.
let xpThreadId = '';

async function xpOpenThread(id: string): Promise<void> {
  if (!id) return;
  xpThreadId = id;
  await xpLoadHistory();
}

// Start a fresh conversation. The new thread is empty, so the stage returns to
// the greeting — that blank slate is the point of asking for one.
async function xpNewThread(): Promise<void> {
  if (!currentProjectId) return;
  let res: any = null;
  try {
    res = await window.hub.copilotNewThread(currentProjectId);
  } catch (_) {
    res = null;
  }
  if (!res || !res.ok || !res.thread || !res.thread.id) return;
  xpThreadId = String(res.thread.id);
  xpRenderTurns([]);
  xpSetAsked(false);
  xpHideHint();
  await xpRenderJump();
  const input = xpEl<HTMLTextAreaElement>('xp-input');
  if (input && !input.disabled) input.focus();
}

// ── Scope: which dataset the question is about ────────────────────────────────

// Explore's scope is chosen by hand rather than inferred from an open entity.
// Empty means whole-project: copilot:ask falls back to a project inventory, so
// the ask still works — the chip just has to say so.
let xpDatasetId = '';
let xpDatasetName = '';

// Explore's scope is ALWAYS explicit — never inferred from whatever entity
// happens to be open elsewhere in the app. An empty kind/id is what copilot:ask
// reads as "whole project", and it means exactly what the chip says.
//
// This replaces the copilot panel's buildCopilotContextRef(), which inferred
// scope from expId/vizEditingId/dashCurrent. Routing Explore through that
// inference was a bug: with a dataset open in the explorer and the chip set to
// "Whole project", the question would silently have been scoped to that open
// dataset instead — the chip and the answer disagreeing with no way to tell.
function xpContextRef(): { kind: string; id: string; label: string } {
  if (!xpDatasetId) return { kind: '', id: '', label: 'whole project' };
  return { kind: 'dataset', id: xpDatasetId, label: 'dataset · ' + (xpDatasetName || 'dataset') };
}

function xpPaintDatasetChip(): void {
  const chip = xpEl<HTMLButtonElement>('xp-dataset-chip');
  if (!chip) return;
  chip.textContent = xpDatasetId ? xpDatasetName || 'Dataset' : 'Whole project';
  chip.title = xpDatasetId
    ? 'Asking about "' + xpDatasetName + '" — click to change'
    : 'Asking about everything in this project — click to pick one dataset';
}

// Pick a dataset with the app's shared chooser (dashboards.ts) rather than a
// bespoke modal — same dialog Visuals and Dashboards already use.
async function xpPickDataset(): Promise<void> {
  if (!currentProjectId) return;
  let list: any[] = [];
  try {
    list = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    list = [];
  }
  if (!Array.isArray(list)) list = [];

  const WHOLE = '__whole__';
  const options = [{ value: WHOLE, label: 'Whole project' }].concat(
    list.map((d: any) => ({ value: String(d.id), label: d && d.name ? String(d.name) : 'Untitled dataset' })),
  );
  const choice = await dashChooseModal('Ask about', options, 'Choose');
  if (choice === null) return;
  if (choice === WHOLE) {
    xpDatasetId = '';
    xpDatasetName = '';
  } else {
    const picked = list.find((d: any) => String(d.id) === choice);
    xpDatasetId = choice;
    xpDatasetName = picked && picked.name ? String(picked.name) : 'Dataset';
  }
  xpPaintDatasetChip();
}

// ── Model chip ────────────────────────────────────────────────────────────────

// Mirrors the sidebar's execution button (execMenu.ts) — the SAME state, not a
// second picker. Clicking opens the existing exec-mode menu.
function xpPaintModelChip(): void {
  const chip = xpEl<HTMLButtonElement>('xp-model-chip');
  if (!chip) return;
  const active = typeof execActiveConnected === 'function' ? execActiveConnected() : null;
  chip.textContent = active ? active.label : 'Connect a model';
  chip.classList.toggle('xp-chip-warn', !active);
  chip.disabled = false; // always clickable — it is how you connect one
}

// ── Composer state ────────────────────────────────────────────────────────────

let xpBusy = false;

// Only the ask itself is gated. The two chips stay live even with no model:
// choosing what you want to ask ABOUT has nothing to do with having something to
// ask WITH, and the model chip is the way to connect one in the first place.
// Disabling them strands a first-run user with no route forward.
function xpSetComposerEnabled(enabled: boolean): void {
  const input = xpEl<HTMLTextAreaElement>('xp-input');
  const send = xpEl<HTMLButtonElement>('xp-send');
  if (input) input.disabled = !enabled;
  if (send) send.disabled = !enabled;
}

function xpShowHint(text: string): void {
  const hint = xpEl('xp-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.hidden = false;
}

function xpHideHint(): void {
  const hint = xpEl('xp-hint');
  if (hint) hint.hidden = true;
}

// Flip the stage from hero to transcript. A class on the panel, not a second
// markup tree — the composer is the same element in both states.
function xpSetAsked(on: boolean): void {
  const panel = xpEl('ws-explore');
  if (panel) panel.classList.toggle('xp-asked', on);
}

// ── Ask ───────────────────────────────────────────────────────────────────────

async function xpSend(): Promise<void> {
  if (xpBusy) return;
  const input = xpEl<HTMLTextAreaElement>('xp-input');
  if (!input) return;
  const question = input.value.trim();
  if (!question || !currentProjectId) return;

  const ref = xpContextRef();

  // Optimistic: the question and a pending marker appear immediately, and the
  // stage commits to transcript mode before the round-trip.
  xpHideHint();
  xpSetAsked(true);
  xpAppendBubble('user', question);
  xpAppendBubble('assistant', 'Thinking…');
  xpScrollToBottom();

  input.value = '';
  xpBusy = true;
  xpSetComposerEnabled(false);

  let res: any = null;
  try {
    res = await window.hub.copilotAsk(
      currentProjectId,
      { kind: ref.kind, id: ref.id },
      question,
      xpThreadId || undefined,
    );
  } catch (_) {
    res = { ok: false, error: 'Something went wrong. Try again.' };
  }

  xpBusy = false;

  if (res && res.ok) {
    // Rebuild from disk truth — main persisted both turns on success. Explore
    // has no inline empty-state node, hence the '' third argument.
    xpSetComposerEnabled(true);
    if (Array.isArray(res.turns)) xpRenderTurns(res.turns);
    else await xpLoadHistory();
    xpHideHint();
    // Adopt whichever thread main actually wrote to, so a first question in a
    // project (sent with no threadId) keeps talking to that same conversation
    // instead of silently defaulting again on the next turn.
    if (typeof res.threadId === 'string' && res.threadId) xpThreadId = res.threadId;
    void xpRenderJump(); // the title and turn count just changed
    // A chart is a bonus on top of the answer (exploreChart.ts): it needs a
    // dataset in scope, a usable suggestion and drawable data, and it stays
    // silent when it cannot have all three. Not awaited — the answer is already
    // on screen and must not wait on a second model round-trip.
    void xpMaybeRenderChart(question);
    return;
  }

  // Failure: main left the thread unchanged, so reload from disk to drop the
  // optimistic bubbles, and restore the typed text so nothing is lost.
  await xpLoadHistory();
  input.value = question;
  if (res && res.notReady) {
    xpSetComposerEnabled(false);
    xpShowHint('Connect a model in Execution settings.');
  } else {
    xpSetComposerEnabled(true);
    xpShowHint((res && res.error) || 'Could not answer that. Try again.');
  }
}

// Repaint the transcript from disk. History is per project and survives reload.
async function xpLoadHistory(): Promise<void> {
  if (!currentProjectId) {
    xpRenderTurns([]);
    xpSetAsked(false);
    return;
  }
  let res: any = null;
  try {
    res = await window.hub.copilotHistory(currentProjectId, xpThreadId || undefined);
  } catch (_) {
    res = null;
  }
  // Adopt the thread main resolved — an unknown or omitted id falls back to the
  // most recent one there, and the renderer must agree with that choice.
  if (res && typeof res.threadId === 'string' && res.threadId) xpThreadId = res.threadId;
  const turns = res && res.ok && Array.isArray(res.turns) ? res.turns : [];
  xpRenderTurns(turns);
  // A project with history opens straight into the transcript; the greeting is
  // for a blank slate, not a permanent header.
  xpSetAsked(turns.length > 0);
}

// ── The hard AI ON/OFF switch ─────────────────────────────────────────────────
//
// Carried over from the retired copilot panel, which owned the ONLY control that
// could turn config.copilotEnabled back on. Deleting that panel without moving
// this would have stranded anyone who had switched AI off, with no route back —
// the switch is a promise that the app stays fully usable without AI, so it has
// to stay reachable from wherever AI now lives.

function xpPaintAiToggle(enabled: boolean): void {
  const btn = xpEl<HTMLButtonElement>('xp-ai-toggle');
  if (!btn) return;
  btn.textContent = enabled ? 'AI: On' : 'AI: Off';
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  btn.classList.toggle('xp-toggle-off', !enabled);
}

async function xpToggleAi(): Promise<void> {
  let status: any = {};
  try {
    status = (await window.hub.getKeyStatus()) || {};
  } catch (_) {
    status = {};
  }
  const next = status.copilotEnabled === false; // flip
  try {
    await window.hub.setCopilotEnabled(next);
  } catch (_) { /* ignore — refreshExplore re-reads the real state below */ }
  await refreshExplore();
}

// ── Panel refresh ─────────────────────────────────────────────────────────────

// Called by workspace.ts:selectSection when Explore becomes active. Reconciles
// the whole surface with readiness + the Copilot OFF switch; a missing model is
// a soft hint and a disabled composer, never an error dialog.
async function refreshExplore(): Promise<void> {
  xpPaintDatasetChip();
  xpPaintModelChip();
  await xpRenderJump();
  await xpLoadHistory();

  let status: any = {};
  try {
    status = (await window.hub.getKeyStatus()) || {};
  } catch (_) {
    status = {};
  }
  const enabled = status.copilotEnabled !== false;
  const ready = Boolean(status.isReady);
  xpPaintAiToggle(enabled);

  const input = xpEl<HTMLTextAreaElement>('xp-input');
  if (!enabled) {
    xpSetComposerEnabled(false);
    if (input) input.placeholder = 'AI is off.';
    xpShowHint('AI is off. Everything else in Ordinate works exactly as it does now — turn it back on whenever you want it.');
    return;
  }
  if (!ready) {
    xpSetComposerEnabled(false);
    if (input) input.placeholder = 'Connect a model to ask a question…';
    xpHideHint();
    return;
  }
  xpSetComposerEnabled(true);
  if (input) input.placeholder = 'Ask about your data…';
  xpHideHint();
}

// ── Boot wiring (once) ────────────────────────────────────────────────────────

function initExplore(): void {
  // The Home band is a door to this section, wired here rather than in
  // projects.ts so every Explore entry point lives in one file.
  const band = xpEl('home-xp-band');
  if (band) band.addEventListener('click', () => selectSection('explore'));

  const send = xpEl('xp-send');
  if (send) send.addEventListener('click', () => void xpSend());

  const input = xpEl<HTMLTextAreaElement>('xp-input');
  if (input) {
    // Enter sends; Shift+Enter inserts a newline — same contract as the panel.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void xpSend();
      }
    });
  }

  const ds = xpEl('xp-dataset-chip');
  if (ds) ds.addEventListener('click', () => void xpPickDataset());

  const newThread = xpEl('xp-new-thread');
  if (newThread) newThread.addEventListener('click', () => void xpNewThread());

  const aiToggle = xpEl('xp-ai-toggle');
  if (aiToggle) aiToggle.addEventListener('click', () => void xpToggleAi());

  const model = xpEl('xp-model-chip');
  if (model) {
    model.addEventListener('click', (e) => {
      // openExecMenu's dismiss handler runs on capture and ignores only clicks
      // inside the menu or its own sidebar button — without this the menu opens
      // and closes on the same click. Mirrors hubMenus.ts's own handler.
      e.stopPropagation();
      if (typeof openExecMenu === 'function') openExecMenu();
    });
  }

  // Keep the model chip honest when the execution path changes (key added or
  // removed, CLI detected). Same signal the copilot panel and the readiness
  // badge already subscribe to; multiple listeners are fine.
  if (window.hub && typeof window.hub.onKeyChanged === 'function') {
    window.hub.onKeyChanged(() => {
      if (currentSection === 'explore') void refreshExplore();
      else xpPaintModelChip();
    });
  }
}
