// askCore — the shared AI transcript + streaming primitives, mounted at the
// dock (dock.ts, #dk-messages). Classic global-scope renderer <script> — NO
// import/export; keeps the historical `xp` prefix so every existing caller
// (dock.ts, dockPropose.ts, dockEdit.ts, askActivity.ts) resolves these by name
// across the shared global scope, unchanged.
//
// Extracted verbatim from the retired Assistant page (explore.ts) when the page
// and the dock merged into one docked assistant. That page was the second mount
// ("ONE engine, TWO mounts", keyed on containerId); #117 retired it, so this is
// one engine and ONE mount. `containerId` stays an explicit REQUIRED parameter
// rather than a hardcoded id — one mount today is not a promise of one mount
// forever — but it must never be defaulted again; see the note below.
// DOM only, textContent NEVER innerHTML: nothing the model returns can inject
// markup.
//
// Loads BEFORE dock.js / dockPropose.js / dockEdit.js / askActivity.js, which
// all call into it.

function xpEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ── Message rendering ─────────────────────────────────────────────────────────
//
// Moved here verbatim from the retired copilot panel (renderer/hub/copilot.ts).
// DOM only, textContent NEVER innerHTML — nothing the
// model returns can inject markup. That rule is the reason these are copied
// rather than rewritten.
//
// `containerId` is REQUIRED — no default. It used to default to 'xp-messages',
// the retired Assistant page's own list, an id that has not existed anywhere in
// index.html since #117. Every function here opens `const list =
// xpEl(containerId); if (!list) return;`, so an omitted argument was a silent
// no-op: no bubble, no error, nothing in the console. The guard stays — it still
// covers a panel that is not in the DOM yet — but the default that aimed it at
// an element that cannot exist is gone, and tsc now names any caller that forgets.

function xpAppendBubble(role: string, text: string, provenance: any, containerId: string): void {
  const list = xpEl(containerId);
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'xp-msg ' + (role === 'assistant' ? 'xp-msg-assistant' : 'xp-msg-user');
  const bubble = document.createElement('div');
  bubble.className = 'xp-bubble';
  bubble.textContent = text;
  row.appendChild(bubble);

  // Provenance is a FOOTNOTE — one small muted line, not a row of pills.
  // The pills had the composer chips' radius, fill and size, so they read as
  // buttons sitting under every answer and were not. Same facts, same order,
  // joined with the separator the header's "Based on …" row already uses.
  if (role === 'assistant' && provenance && typeof provenance === 'object') {
    const parts: string[] = [];
    if (provenance.kind && provenance.name) parts.push(provenance.kind + ': ' + provenance.name);
    else if (provenance.kind) parts.push(String(provenance.kind));
    if (provenance.datasetName) parts.push('dataset: ' + provenance.datasetName);
    if (Array.isArray(provenance.columns) && provenance.columns.length) {
      const cols = provenance.columns.slice(0, 6).join(', ');
      parts.push('columns: ' + cols + (provenance.columns.length > 6 ? '…' : ''));
    }
    parts.push(provenance.note ? String(provenance.note) : 'stats app-computed');
    const prov = document.createElement('div');
    prov.className = 'xp-provenance';
    prov.textContent = parts.join(' · '); // textContent, like the bubble — never innerHTML
    row.appendChild(prov);
  }
  list.appendChild(row);
}

// Rebuild the whole transcript from an authoritative turns array (disk truth).
function xpRenderTurns(turns: any[], containerId: string): void {
  const list = xpEl(containerId);
  if (!list) return;
  list.querySelectorAll('.xp-msg').forEach((n) => n.remove());
  if (Array.isArray(turns)) {
    turns.forEach((t) => xpAppendBubble(t.role, typeof t.text === 'string' ? t.text : '', t.provenance, containerId));
  }
  xpScrollToBottom(containerId);
}

function xpScrollToBottom(containerId: string): void {
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
// ONE registry, keyed by askId. A UUID askId means only the matching in-flight
// ask paints, so a late chunk from a stale ask (the user asked again) can never
// write into this bubble — which is what makes the registry, rather than a
// single current-bubble variable, the right shape. The stream is
// only ever a live PREVIEW: on the handle's resolution the caller reconciles by
// rebuilding the transcript from disk truth (authoritative text + provenance
// chips), which is why xpEndStream is called before that rebuild — a chunk that
// somehow arrives afterwards finds no target and is dropped.
interface XpStreamTarget { bubble: HTMLElement; container: string; started: boolean }
const xpStreamTargets: Record<string, XpStreamTarget> = {};

// Adopt the LAST assistant bubble in a container as askId's streaming target —
// that is the optimistic "Thinking…" bubble the caller just appended.
function xpBeginStream(askId: string, containerId: string): void {
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

// The ONE streaming subscription for the whole hub. Every ask streams through
// here and the askId picks the right bubble, so this stays one subscription no
// matter how many asks are in flight or where they were sent from.
function initAskCore(): void {
  if (window.hub && typeof window.hub.onCopilotChunk === 'function') {
    window.hub.onCopilotChunk((d) => {
      if (d && typeof d.askId === 'string') xpOnStreamChunk(d.askId, typeof d.delta === 'string' ? d.delta : '');
    });
  }
}
