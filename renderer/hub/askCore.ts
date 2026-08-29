// askCore — the shared AI transcript + streaming primitives, used by BOTH the
// dock (dock.ts, #dk-messages) and any other AI mount. Classic global-scope
// renderer <script> — NO import/export; keeps the historical `xp` prefix so
// every existing caller (dock.ts, dockPropose.ts, askActivity.ts) resolves these
// by name across the shared global scope, unchanged.
//
// Extracted verbatim from the retired Assistant page (explore.ts) when the page
// and the dock merged into one docked assistant: these functions were always
// shared ("ONE engine, TWO mounts", keyed on containerId) — they just used to
// live inside the page file. DOM only, textContent NEVER innerHTML: nothing the
// model returns can inject markup.
//
// Loads BEFORE dock.js / dockPropose.js / askActivity.js, which all call into it.

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

// The ONE streaming subscription for the whole hub. The registry it feeds
// (xpStreamTargets) is shared, so every surface's asks stream through here — the
// askId picks the right bubble regardless of which surface sent the question.
function initAskCore(): void {
  if (window.hub && typeof window.hub.onCopilotChunk === 'function') {
    window.hub.onCopilotChunk((d) => {
      if (d && typeof d.askId === 'string') xpOnStreamChunk(d.askId, typeof d.delta === 'string' ? d.delta : '');
    });
  }
}
