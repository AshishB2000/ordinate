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

// Repaint the strip. Empty → ONE muted line, deliberately not a card: an empty
// container with a border reads as a broken feature.
async function xpRenderJump(): Promise<void> {
  const host = xpEl('xp-jump-rows');
  if (!host) return;
  let items: any[] = [];
  try {
    const res = await window.hub.recentItems(XP_JUMP_LIMIT);
    items = Array.isArray(res) ? res : [];
  } catch (_) {
    items = [];
  }
  host.textContent = '';
  const empty = xpEl('xp-jump-empty');
  if (empty) empty.hidden = items.length > 0;
  const jump = xpEl('xp-jump');
  // Hide the whole strip's heading too when there is nothing at all to show.
  if (jump) jump.classList.toggle('xp-jump-bare', items.length === 0);
  items.slice(0, XP_JUMP_LIMIT).forEach((it) => host.appendChild(xpMakeJumpRow(it)));
}

// ── Scope: which dataset the question is about ────────────────────────────────

// Explore's scope is chosen by hand rather than inferred from an open entity.
// Empty means whole-project: copilot:ask falls back to a project inventory, so
// the ask still works — the chip just has to say so.
let xpDatasetId = '';
let xpDatasetName = '';

// The explicit context override handed to buildCopilotContextRef (copilot.ts).
function xpContextRef(): { kind: string; id: string; label: string } | undefined {
  if (!xpDatasetId) return undefined;
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

  const ref = buildCopilotContextRef(xpContextRef());

  // Optimistic: the question and a pending marker appear immediately, and the
  // stage commits to transcript mode before the round-trip.
  xpHideHint();
  xpSetAsked(true);
  appendCopilotBubble('user', question, undefined, 'xp-messages');
  appendCopilotBubble('assistant', 'Thinking…', undefined, 'xp-messages');
  scrollCopilotToBottom('xp-messages');

  input.value = '';
  xpBusy = true;
  xpSetComposerEnabled(false);

  let res: any = null;
  try {
    res = await window.hub.copilotAsk(currentProjectId, { kind: ref.kind, id: ref.id }, question);
  } catch (_) {
    res = { ok: false, error: 'Something went wrong. Try again.' };
  }

  xpBusy = false;

  if (res && res.ok) {
    // Rebuild from disk truth — main persisted both turns on success. Explore
    // has no inline empty-state node, hence the '' third argument.
    xpSetComposerEnabled(true);
    if (Array.isArray(res.turns)) renderCopilotTurns(res.turns, 'xp-messages', '');
    else await xpLoadHistory();
    xpHideHint();
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
    renderCopilotTurns([], 'xp-messages', '');
    xpSetAsked(false);
    return;
  }
  let res: any = null;
  try {
    res = await window.hub.copilotHistory(currentProjectId);
  } catch (_) {
    res = null;
  }
  const turns = res && res.ok && Array.isArray(res.turns) ? res.turns : [];
  renderCopilotTurns(turns, 'xp-messages', '');
  // A project with history opens straight into the transcript; the greeting is
  // for a blank slate, not a permanent header.
  xpSetAsked(turns.length > 0);
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

  const input = xpEl<HTMLTextAreaElement>('xp-input');
  if (!enabled) {
    xpSetComposerEnabled(false);
    if (input) input.placeholder = 'AI is off. Turn it back on in Settings to ask a question.';
    xpShowHint('AI is off. Everything else in Ordinate works exactly as it does now.');
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
