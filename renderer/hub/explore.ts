// Ask — the conversational front door. (The section id 'explore', this file's
// name and the xp- prefix all predate the rename to Ask; they stay because
// renaming them is churn across workspace.ts and five smoke suites with no
// user-visible gain. Identifiers keep the old name; user-visible strings say
// Ask.)
//
// Classic global-scope renderer <script> — NO import/export; symbols are shared
// with the other hub scripts (workspace.ts owns the section router and
// currentProjectId, projects.ts owns the recent-item router, hub.ts owns
// formatSidebarTime).
//
// Ask is a PLACE, not a panel: a full-bleed stage with a brand mark, a
// personal greeting and one composer card, over a "Jump back in" strip.
// Nothing here computes, rounds or formats a figure; that stays main-process
// work — the greeting's name and the starter suggestions are strings built
// from record NAMES, never from data.
//
// NAMING — `xp` is this surface's reserved prefix. `exp*` is the dataset
// explorer (expId/expName), `ex-`/`exec-` is execution mode, `ai-` is the
// copilot panel. A collision with any of those silently breaks an unrelated
// surface.

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

// ── Streaming (token-by-token narration) ────────────────────────────────────
//
// Main streams an in-flight answer over `copilot:ask:chunk` { askId, delta } as
// the model produces it (BYOK only — see src/analyzeStream.ts). The bubble the
// tokens fill is the SAME optimistic assistant bubble xpSend/dkSend already
// appended ("Thinking…"): the first delta clears that placeholder and each
// subsequent one is appended to `bubble.textContent`, NEVER innerHTML — a
// streamed token can carry markup, exactly the reason xpAppendBubble is
// textContent-only (see its header).
//
// ONE registry serves both surfaces. A UUID askId means only the matching
// in-flight ask paints, so a late chunk from a stale ask (the user asked again)
// or the other surface's stream can never write into this bubble. The stream is
// only ever a live PREVIEW: on the handle's resolution the caller reconciles by
// rebuilding the transcript from disk truth (authoritative text + provenance
// chips), which is why xpEndStream is called before that rebuild — a chunk that
// somehow arrives afterwards finds no target and is dropped.
interface XpStreamTarget { bubble: HTMLElement; container: string; started: boolean }
const xpStreamTargets: Record<string, XpStreamTarget> = {};

// Adopt the LAST assistant bubble in a container as askId's streaming target —
// that is the optimistic "Thinking…" bubble the caller just appended.
function xpBeginStream(askId: string, containerId = 'xp-messages'): void {
  if (!askId) return;
  const list = xpEl(containerId);
  if (!list) return;
  const bubbles = list.querySelectorAll('.xp-msg-assistant .xp-bubble');
  const bubble = bubbles.length ? (bubbles[bubbles.length - 1] as HTMLElement) : null;
  if (bubble) xpStreamTargets[askId] = { bubble, container: containerId, started: false };
}

function xpEndStream(askId: string): void {
  if (askId) delete xpStreamTargets[askId];
}

// A fresh ask id. crypto.randomUUID is available in the hub renderer; the
// fallback only matters for an ancient engine and just needs to be unique enough
// to distinguish two in-flight asks.
function xpNewAskId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch (_) { /* fall through */ }
  return 'ask-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

// One delta from main. Drops anything whose askId isn't a live target.
function xpOnStreamChunk(askId: string, delta: string): void {
  const t = askId ? xpStreamTargets[askId] : null;
  if (!t) return;
  if (!t.started) { t.bubble.textContent = ''; t.started = true; } // clear "Thinking…" on first token
  t.bubble.textContent += delta; // textContent, NEVER innerHTML — a token can carry markup
  t.bubble.classList.add('xp-streaming'); // CSS-only caret while it grows
  xpScrollToBottom(t.container);
}

// How many rows the "Jump back in" strip shows. The recent list itself is
// cross-project and already sorted newest-first in main (src/recent.ts).
const XP_JUMP_LIMIT = 10;

// ── Jump back in ──────────────────────────────────────────────────────────────

// The recent list, loaded in ONE place. The jump strip paints it and the context
// picker offers it as its empty-query suggestions; a second fetch would be a
// second thing to keep in step. Cross-project and already newest-first from main
// (src/recent.ts) — filtering to one project is the caller's business, because
// the strip deliberately shows all of them and the picker deliberately does not.
async function xpRecentItems(): Promise<any[]> {
  try {
    const res = await window.hub.recentItems(XP_JUMP_LIMIT);
    return Array.isArray(res) ? res : [];
  } catch (_) {
    return [];
  }
}

// One row per recent item: name, kind, relative time. Clicking routes through
// projects.ts's openRecentItem — the SAME router the Home rows use, so a new
// entity kind added there works here with no change.
function xpMakeJumpRow(it: any): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'xp-jump-row';
  row.dataset.type = String(it.type || '');
  row.dataset.id = String(it.id || '');

  // GS_GLYPH (globalSearch.ts) — the app's one kind-glyph vocabulary.
  const glyph = document.createElement('span');
  glyph.className = 'gs-glyph';
  glyph.textContent = GS_GLYPH[String(it.type || '')] || '•';

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

  row.append(glyph, name, kind, time);
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

  // Conversations are not a GS_GLYPH kind (they are not searchable records) —
  // a quote mark is the speech glyph, same monochrome vocabulary.
  const glyph = document.createElement('span');
  glyph.className = 'gs-glyph';
  glyph.textContent = '❝';

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

  row.append(glyph, name, kind, time);
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
  const items = await xpRecentItems();
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
  void xpRenderSuggests(); // back on the blank slate — offer the starters again, fresh
  await xpRenderJump();
  const input = xpEl<HTMLTextAreaElement>('xp-input');
  if (input && !input.disabled) input.focus();
}

// ── Scope: what the question is about ─────────────────────────────────────────

// Explore points at ONE thing: a dataset, a visual, an analysis, a dashboard —
// or nothing, which means the whole project. Empty kind/id is what copilot:ask
// already reads as whole-project (it falls back to a project inventory), so the
// ask always works; the chip just has to say which it is.
//
// Explore's scope is ALWAYS explicit — never inferred from whatever entity
// happens to be open elsewhere in the app. This replaces the copilot panel's
// buildCopilotContextRef(), which inferred scope from expId/vizEditingId/
// dashCurrent. Routing Explore through that inference was a bug: with a dataset
// open in the explorer and the chip set to "Whole project", the question would
// silently have been scoped to that open dataset instead — the chip and the
// answer disagreeing with no way to tell.
let xpCtxKind = '';
let xpCtxId = '';
let xpCtxName = '';

function xpContextRef(): { kind: string; id: string; label: string } {
  if (!xpCtxKind || !xpCtxId) return { kind: '', id: '', label: 'whole project' };
  return { kind: xpCtxKind, id: xpCtxId, label: xpCtxKind + ' · ' + (xpCtxName || xpCtxKind) };
}

// exploreChart.ts draws only when a DATASET is in scope (visual:suggest needs
// one). One accessor so "is there a dataset?" is asked in exactly one place.
function xpDatasetInScope(): string {
  return xpCtxKind === 'dataset' ? xpCtxId : '';
}

// Point Explore somewhere else. The single writer of the three state fields —
// the picker and the deleted-entity reset both come through here.
function xpSetContext(kind: string, id: string, name: string): void {
  xpCtxKind = kind && id ? kind : '';
  xpCtxId = xpCtxKind ? id : '';
  xpCtxName = xpCtxKind ? name : '';
  xpPaintContextChip();
}

// The chip: a kind glyph plus the name. GS_GLYPH (globalSearch.ts) is the app's
// ONE kind-glyph vocabulary — the same marks the sidebar's search results use.
// The fallback mark stands for "everything", which is what no kind means here.
function xpPaintContextChip(): void {
  const chip = xpEl<HTMLButtonElement>('xp-context-chip');
  if (!chip) return;
  chip.textContent = '';
  const glyph = document.createElement('span');
  glyph.className = 'gs-glyph';
  glyph.textContent = (xpCtxKind && GS_GLYPH[xpCtxKind]) || '◈';
  const name = document.createElement('span');
  name.className = 'xp-chip-name';
  name.textContent = xpCtxKind ? xpCtxName || xpCtxKind : 'Whole project';
  chip.append(glyph, name);
  chip.title = xpCtxKind
    ? 'Every question is answered about the ' + xpCtxKind + ' “' + (xpCtxName || xpCtxKind) +
      '” — click to point Ask at something else.'
    : 'Every question is answered about everything in this project — click to point Ask at one ' +
      'dataset, visual, analysis or dashboard.';
}

// ── Model chip ────────────────────────────────────────────────────────────────

// Mirrors the exec buttons' state (execMenu.ts) — the SAME state, not a second
// picker. Clicking opens the existing exec-mode menu, anchored to this chip.
//
// The mark is agentIconHTML — the exec buttons' ONE logo renderer — so the chip
// shows the same provider/agent glyph the menu does. innerHTML is safe here for
// the same reason it is on those buttons: every string in it is app-owned
// (asset paths from src/icons.ts, labels from the BYOK/CLI display tables);
// nothing model-returned ever reaches this function.
function xpPaintModelChip(): void {
  const chip = xpEl<HTMLButtonElement>('xp-model-chip');
  if (!chip) return;
  const active = typeof execActiveConnected === 'function' ? execActiveConnected() : null;
  chip.textContent = '';
  if (active && typeof agentIconHTML === 'function') {
    const mark = document.createElement('span');
    mark.className = 'xp-model-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = agentIconHTML(active.id, active.label, 14);
    chip.appendChild(mark);
  }
  const name = document.createElement('span');
  name.className = 'xp-chip-name';
  name.textContent = active ? active.label : 'Connect a model';
  chip.appendChild(name);
  // The caret marks it as a picker, like the menu's other openers.
  const caret = document.createElement('span');
  caret.className = 'xp-chip-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"'
    + ' stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M6 9l6 6 6-6"/></svg>';
  chip.appendChild(caret);
  chip.classList.toggle('xp-chip-warn', !active);
  chip.disabled = false; // always clickable — it is how you connect one
}

// ── Greeting ──────────────────────────────────────────────────────────────────

// The OS account name, fetched once (app:userName). null = not asked yet;
// '' = asked and unavailable, which pins the timeless fallback for the session.
let xpUserName: string | null = null;

// Pure: pick the greeting line. Time-of-day is renderer-local on purpose — the
// greeting should match the clock on the user's wall, no IPC needed. With no
// name there is nothing to greet, so the timeless question (the markup's own
// static text) stands.
function xpGreetingText(name: string, hour: number): string {
  if (!name) return 'What do you want to know?';
  if (hour >= 5 && hour < 12) return 'Good morning, ' + name;
  if (hour >= 12 && hour < 17) return 'Good afternoon, ' + name;
  if (hour >= 17 && hour < 22) return 'Good evening, ' + name;
  return 'Good to see you, ' + name; // late night — "Good night" reads as a goodbye
}

async function xpPaintGreeting(): Promise<void> {
  const el = xpEl('xp-greet');
  if (!el) return;
  if (xpUserName === null) {
    try {
      const res = window.hub && typeof window.hub.userName === 'function'
        ? await window.hub.userName() : '';
      xpUserName = typeof res === 'string' ? res : '';
    } catch (_) {
      xpUserName = '';
    }
  }
  el.textContent = xpGreetingText(xpUserName, new Date().getHours());
}

// ── Starter suggestions ───────────────────────────────────────────────────────

// Up to three prompts built from REAL dataset names — strings only, no model
// call and no figures (the app does the math when one is actually asked).
// Clicking fills the composer and focuses it; it NEVER auto-sends, because a
// suggestion is a draft to edit, not a button that spends a model round-trip.
// The strip hides itself when the project has no data; transcript mode hides
// it via CSS (.xp-asked), so a suggestion never floats over a conversation.
function xpMakeSuggestChip(prompt: string): HTMLElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'xp-suggest';
  chip.textContent = prompt;
  chip.addEventListener('click', () => {
    const input = xpEl<HTMLTextAreaElement>('xp-input');
    if (!input) return;
    input.value = prompt;
    if (!input.disabled) input.focus(); // a disabled control refuses focus(), per spec
  });
  return chip;
}

async function xpRenderSuggests(): Promise<void> {
  const host = xpEl('xp-suggests');
  if (!host) return;
  host.textContent = '';
  host.hidden = true;
  if (!currentProjectId) return;
  let list: any[] = [];
  try {
    const res = await window.hub.listDatasets(currentProjectId);
    list = Array.isArray(res) ? res : [];
  } catch (_) {
    list = [];
  }
  // Names only — DatasetSummary carries no columns, and hydrating a table
  // (dataset:get clones every row) just to word a prompt would be absurd.
  const names = list.map((d) => String(d && d.name ? d.name : '').trim()).filter(Boolean);
  if (!names.length) return;
  const prompts: string[] = ['What stands out in ' + names[0] + '?'];
  if (names.length > 1) prompts.push('How do ' + names[0] + ' and ' + names[1] + ' compare?');
  prompts.push('Summarise ' + names[0] + ' in plain terms');
  prompts.slice(0, 3).forEach((p) => host.appendChild(xpMakeSuggestChip(p)));
  host.hidden = false;
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

  // A per-ask id so main can stream this answer's tokens back to THIS bubble and
  // the renderer can ignore a stale ask's late chunks (see xpOnStreamChunk).
  const askId = xpNewAskId();

  // Optimistic: the question and a pending marker appear immediately, and the
  // stage commits to transcript mode before the round-trip.
  xpHideHint();
  xpSetAsked(true);
  xpAppendBubble('user', question);
  xpAppendBubble('assistant', 'Thinking…');
  xpScrollToBottom();
  xpBeginStream(askId); // the "Thinking…" bubble just appended is the stream target

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
      askId,
    );
  } catch (_) {
    res = { ok: false, error: 'Something went wrong. Try again.' };
  }

  xpBusy = false;
  // Stop streaming into the optimistic bubble: whether we succeeded or failed,
  // the next step rebuilds the transcript from disk truth (or drops the bubbles),
  // and the streamed text was only ever a preview.
  xpEndStream(askId);

  if (res && res.ok) {
    // Rebuild from disk truth — main persisted both turns on success. Explore
    // has no inline empty-state node, hence the '' third argument.
    xpSetComposerEnabled(true);
    if (Array.isArray(res.turns)) xpRenderTurns(res.turns);
    else await xpLoadHistory();
    // The entity may have been deleted between picking it and asking. Main says
    // so by falling back to the project inventory, and the PROVENANCE KIND is
    // how you can tell: we asked about something specific and got 'project'
    // back. Reset rather than let the chip keep naming a scope that is gone.
    const gone = Boolean(ref.kind) && res.provenance && res.provenance.kind === 'project';
    if (gone) {
      xpSetContext('', '', '');
      xpShowHint('That ' + ref.kind + ' is no longer here — this was answered about the whole project.');
    } else {
      xpHideHint();
    }
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
  xpPaintContextChip();
  xpPaintModelChip();
  void xpPaintGreeting();  // not awaited — the static text stands until the name lands
  void xpRenderSuggests(); // not awaited — chips are a bonus, never a gate on the surface
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

  // The context chip opens the picker (explorePicker.ts), which owns its own
  // dismissal — including ignoring clicks on this chip, so a second click here
  // toggles it shut instead of closing and reopening it.
  const ctx = xpEl('xp-context-chip');
  if (ctx) ctx.addEventListener('click', () => void xpOpenContextPicker());
  initExplorePicker(); // explorePicker.ts — the picker's own listeners

  const newThread = xpEl('xp-new-thread');
  if (newThread) newThread.addEventListener('click', () => void xpNewThread());

  const aiToggle = xpEl('xp-ai-toggle');
  if (aiToggle) aiToggle.addEventListener('click', () => void xpToggleAi());

  const model = xpEl('xp-model-chip');
  if (model) {
    model.addEventListener('click', (e) => {
      // openExecMenu's dismiss handler ignores only clicks inside the menu or
      // inside its ANCHOR — without this stopPropagation the menu opens and
      // closes on the same click. Mirrors hubMenus.ts's own handler.
      e.stopPropagation();
      // The chip IS the anchor. Calling with no argument would fall back to
      // execBtnVisible(), and after the top-bar relayout the only exec button
      // (#exec-mode-btn-cap) is display:none outside capture — a zero rect
      // that would position the menu off a phantom at the viewport origin.
      if (typeof openExecMenu === 'function') openExecMenu(model);
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

  // The ONE streaming subscription for the whole hub. The registry it feeds
  // (xpStreamTargets) is shared, so the dock's asks stream through here too — the
  // askId picks the right bubble regardless of which surface sent the question.
  if (window.hub && typeof window.hub.onCopilotChunk === 'function') {
    window.hub.onCopilotChunk((d) => {
      if (d && typeof d.askId === 'string') xpOnStreamChunk(d.askId, typeof d.delta === 'string' ? d.delta : '');
    });
  }
}
