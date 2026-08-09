// The AI dock — a docked, toggleable panel on the right edge that follows the
// user across the app (docs/superpowers/plans/2026-08-09-ai-dock.md). Classic
// global-scope renderer <script>: NO import/export. Loads after workspace.js
// (reads `selectSection`'s `.hub-body[data-section]`), dashboards.js (reads
// `dashReadOnly`) and chartRender.js (reads the `chartInstances`/
// `mapInstances` WeakMaps) — see the load-order comment in index.html.
//
// Task 1 shipped the SHELL: open/close from the sidebar button and ⌘L,
// suppressed in five places, view state in localStorage, and the canvas
// resize nudge.
//
// Task 2 wires the composer to the SAME thread Explore and the AI panel use
// (copilot.ts's buildCopilotContextRef/appendCopilotBubble/renderCopilotTurns/
// scrollCopilotToBottom — dock.js loads after copilot.js and explore.js, see
// index.html). It does NOT add a second history store, transcript renderer or
// context resolver — dkSend()/dkLoadHistory() mirror explore.ts's
// xpSend()/xpLoadHistory() with 'dk-messages' as the container, same as
// Explore mirrors the original copilot.ts panel. Three surfaces, light
// duplication, no shared askFlow() — see the plan for why.
//
// Task 3 adds proposals: after a successful ask, dkSend() below hands the
// question/answer to dkOfferProposal() (dockPropose.ts, a second file — this
// one was already ~360 lines before Task 3, see .claude/rules/file-size.md).
// dock.ts owns only the two integration points — clear the last turn's
// proposal before a new one, offer a new one after a successful answer —
// everything about WHICH proposal and how it applies lives in dockPropose.ts.
//
// Task 4 finishes it: the #dk-handle drag/keyboard resize (dkClampWidth is
// the one place [300, 40% of window] is computed, read AND write), the
// resize nudge on drag/keyboard-settle only, Esc-to-close-and-refocus, and
// aria-expanded on the toggle in dkSync().

// ── Suppression ───────────────────────────────────────────────────────────
/**
 * The one place that decides whether the dock may show at all. Called from
 * `selectSection` (workspace.ts) and from every body-class toggler that can
 * flip one of the conditions below, so there is exactly one rule instead of
 * one copy per caller.
 */
function dkAllowed(): boolean {
  // `dash-presenting` is set on <html> (dashShare.ts enter/exitDashPresent),
  // NOT on <body> like the next two — a real asymmetry in how each surface
  // was built, not a typo. Check the element each one actually uses; do not
  // "fix" this into a single selector.
  if (document.documentElement.classList.contains('dash-presenting')) return false;
  if (document.body.classList.contains('an-focus')) return false; // analyses workbench owns the width
  if (document.body.classList.contains('cap-focus')) return false; // capture surface is deliberately bare
  const body = document.querySelector('.hub-body') as HTMLElement | null;
  if (body && body.dataset.section === 'explore') return false; // Explore IS the chat
  if (typeof dashReadOnly !== 'undefined' && dashReadOnly) return false; // published snapshot — nothing editable
  return true;
}

// ── View state (localStorage — renderer view state, never config.json) ────
function dkIsOpen(): boolean {
  try { return localStorage.getItem('dkOpen') === '1'; } catch (_) { return false; }
}

function dkSetOpen(open: boolean): void {
  try { localStorage.setItem('dkOpen', open ? '1' : '0'); } catch (_) { /* private mode / quota — just won't survive reload */ }
  dkSync();
}

function dkToggle(): void {
  if (!dkAllowed()) return;
  dkSetOpen(!dkIsOpen());
}

// [300, 40% of window] — the ONE clamp both the read path (dkApplyWidth) and
// the write path (dkPersistWidth, drag/keyboard resize) share, so there is
// exactly one place the bound is computed.
//
// `Math.max(window.innerWidth * 0.4, DK_MIN_WIDTH)` is the Task 1 review fix:
// below a 750px window, 40% is under 300px, so a plain `Math.min(n, 40%)`
// forced the width BELOW the documented minimum. Wrapping the max in
// `Math.max(…, DK_MIN_WIDTH)` means the minimum always wins on a narrow
// window instead of silently losing to a smaller "maximum" — simpler than
// special-casing the <1100px overlay breakpoint, and correct even though the
// dock is in overlay mode there too (the overlay still honours --dk-width;
// see hub.css's media query).
const DK_MIN_WIDTH = 300;
function dkClampWidth(n: number): number {
  const max = Math.max(window.innerWidth * 0.4, DK_MIN_WIDTH);
  return Math.min(Math.max(n, DK_MIN_WIDTH), max);
}

// Applied at boot AND after every persisted change (dkPersistWidth calls this
// rather than setting --dk-width itself) — the ONE place a stored value
// becomes an applied one.
function dkApplyWidth(): void {
  let w = 340;
  try {
    const raw = localStorage.getItem('dkWidth');
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(n) && n >= DK_MIN_WIDTH) w = dkClampWidth(n);
  } catch (_) { /* default stands */ }
  document.documentElement.style.setProperty('--dk-width', w + 'px');
  dkSyncHandleAria(w);
}

function dkCurrentWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dk-width');
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 340;
}

// The ONLY function that writes `dkWidth` to localStorage — drag and keyboard
// resize both funnel here, then hand off to dkApplyWidth() (above) rather
// than a second copy of its clamp-and-set-the-CSS-var logic.
function dkPersistWidth(n: number): void {
  const w = dkClampWidth(n);
  try { localStorage.setItem('dkWidth', String(w)); } catch (_) { /* private mode / quota — just won't survive reload */ }
  dkApplyWidth();
}

function dkSyncHandleAria(w: number): void {
  const handle = document.getElementById('dk-handle');
  if (!handle) return;
  handle.setAttribute('aria-valuenow', String(Math.round(w)));
  handle.setAttribute('aria-valuemax', String(Math.round(Math.max(window.innerWidth * 0.4, DK_MIN_WIDTH))));
}

// ── Resize handle (drag + keyboard) ─────────────────────────────────────────
// Live feedback (mousemove / each arrow press) only ever touches the CSS
// custom property directly — cheap, and NOT a second writer of `dkWidth`.
// Persisting to localStorage and re-running the canvas resize nudge happens
// once, at the end of the gesture: mouseup for a drag, a short settle timer
// for the keyboard (arrow-key repeat fires far faster than one resize per
// keystroke should cost).
let dkDragStartX = 0;
let dkDragStartWidth = 0;

function dkHandleMouseMove(e: MouseEvent): void {
  // The dock sits on the right edge; the handle is its LEFT edge, so dragging
  // the mouse left (negative movement) is what WIDENS the panel.
  const dx = dkDragStartX - e.clientX;
  const w = dkClampWidth(dkDragStartWidth + dx);
  document.documentElement.style.setProperty('--dk-width', w + 'px');
  dkSyncHandleAria(w);
}

function dkHandleMouseUp(): void {
  document.removeEventListener('mousemove', dkHandleMouseMove);
  document.removeEventListener('mouseup', dkHandleMouseUp);
  const handle = document.getElementById('dk-handle');
  if (handle) handle.classList.remove('dk-dragging');
  dkPersistWidth(dkCurrentWidth());
  dkNudgeCanvasResize(); // once, on drag END — never per mousemove
}

function dkHandleMouseDown(e: MouseEvent): void {
  e.preventDefault(); // a text-selection drag would otherwise start under the cursor
  dkDragStartX = e.clientX;
  dkDragStartWidth = dkCurrentWidth();
  const handle = document.getElementById('dk-handle');
  if (handle) handle.classList.add('dk-dragging');
  document.addEventListener('mousemove', dkHandleMouseMove);
  document.addEventListener('mouseup', dkHandleMouseUp);
}

let dkKeyResizeSettle: ReturnType<typeof setTimeout> | null = null;
const DK_KEY_STEP = 16;

function dkHandleKeydown(e: KeyboardEvent): void {
  let delta = 0;
  if (e.key === 'ArrowLeft') delta = DK_KEY_STEP; // grows the panel — see dkHandleMouseMove
  else if (e.key === 'ArrowRight') delta = -DK_KEY_STEP;
  else return;
  e.preventDefault();
  const w = dkClampWidth(dkCurrentWidth() + delta);
  document.documentElement.style.setProperty('--dk-width', w + 'px');
  dkSyncHandleAria(w);
  // Settle once key-repeat stops, not once per keystroke — the keyboard
  // equivalent of "on drag end, not every frame".
  if (dkKeyResizeSettle) clearTimeout(dkKeyResizeSettle);
  dkKeyResizeSettle = setTimeout(() => {
    dkKeyResizeSettle = null;
    dkPersistWidth(dkCurrentWidth());
    dkNudgeCanvasResize();
  }, 300);
}

// ── Context ──────────────────────────────────────────────────────────────
/**
 * Paint the header's "Based on …" line from `buildCopilotContextRef()`
 * (copilot.ts) called with NO override — the dock infers scope from whatever
 * entity is open (dataset → visual → dashboard → whole project); it never
 * picks its own, unlike Explore's explicit dataset chip. Cheap and
 * synchronous, so `dkSync()` below calls it unconditionally on every section
 * switch, focus-mode toggle and entity open/close — the context line must
 * never lag one step behind what's on screen.
 */
function dkRenderContext(): void {
  const el = document.getElementById('dk-context');
  if (!el) return;
  const ref = buildCopilotContextRef();
  el.textContent = '';
  const label = document.createElement('span');
  label.className = 'dk-context-label';
  label.textContent = 'Based on ' + ref.label;
  el.appendChild(label);
  // Same "stats app-computed" chip copilot.ts's own renderCopilotContext()
  // shows beside its context line — .ai-chip, not a new chip style.
  const chip = document.createElement('span');
  chip.className = 'ai-chip';
  chip.textContent = 'stats app-computed';
  el.appendChild(chip);
}

// ── Visibility + resize nudge ───────────────────────────────────────────────
let dkLastVisible: boolean | null = null;
// Tracks which project the panel last loaded history/readiness for, so a
// project switch that happens WITHOUT a visibility change (dock stays open
// while the user opens a different project's item from Home) still reloads
// the right thread instead of showing the previous project's conversation.
let dkLastProjectId: string | null = null;

/**
 * Recompute panel/toggle visibility from `dkAllowed()` + `dkIsOpen()`. Safe to
 * call as often as needed (section switches, focus-mode toggles, presentation
 * mode, the toggle itself, entity open/close) — it only fires the canvas
 * resize nudge when the computed visibility actually changed, and only
 * reloads the conversation (dkRefresh) when the panel just became visible or
 * the active project changed under it.
 */
function dkSync(): void {
  const panel = document.getElementById('dk-panel');
  const btn = document.getElementById('side-ai-btn');
  const allowed = dkAllowed();
  if (btn) btn.hidden = !allowed; // suppressed = toggle hidden too, no exceptions
  if (btn) btn.classList.toggle('active', allowed && dkIsOpen());
  const visible = allowed && dkIsOpen();
  if (btn) btn.setAttribute('aria-expanded', String(visible));
  const justOpened = visible && dkLastVisible !== true;
  if (panel) panel.hidden = !visible;
  document.body.classList.toggle('dk-open', visible); // drives the <1100px scrim in hub.css
  dkRenderContext();
  if (visible && (dkLastVisible !== true || dkLastProjectId !== currentProjectId)) {
    dkLastProjectId = currentProjectId;
    void dkRefresh();
  }
  if (dkLastVisible !== null && dkLastVisible !== visible) dkNudgeCanvasResize();
  dkLastVisible = visible;
  // Opening focuses the composer — but a DISABLED textarea (no model
  // connected, or no project open yet — the state a fresh install starts in)
  // silently REFUSES focus, per the HTML spec; that would strand keyboard
  // focus wherever it happened to be (typically the toggle button itself)
  // instead of inside the panel that just opened. `#dk-panel` carries
  // `tabindex="-1"` for exactly this fallback: focus lands somewhere inside
  // the dock either way, and the input still gets it the moment it becomes
  // usable (dkRefresh() enables it without touching focus, so this isn't a
  // second, competing focus write).
  if (justOpened) {
    const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
    if (input && !input.disabled) input.focus();
    else panel?.focus();
  }
}

/**
 * Opening/closing the dock changes every visual's container width as a flex
 * sibling. Chart.js (responsive:true, chartRender.ts) and MapLibre
 * (trackResize left at its default true, mapRender.ts) each already drive
 * their OWN resize off a private ResizeObserver on their own container —
 * confirmed by reading the shipped bundles
 * (node_modules/chart.js/dist/chart.umd.js, node_modules/maplibre-gl/dist/
 * maplibre-gl.js). The cheaper option — one
 * `window.dispatchEvent(new Event('resize'))` — was tried first and is
 * confirmed dead for this pinned MapLibre build: it registers ZERO
 * `addEventListener("resize", …)` calls, so a synthetic window event never
 * reaches it (trackResize is wired entirely through the ResizeObserver, not a
 * window listener). So: walk the DOM for candidate containers —
 * chartInstances/mapInstances are WeakMaps, not enumerable — and nudge
 * whichever instance is actually there, mirroring the existing
 * `try { map.resize(); } catch (_) {}` precedent at mapRender.ts:407.
 */
function dkNudgeCanvasResize(): void {
  document.querySelectorAll('.cv-viz-area').forEach((el) => {
    const chart = chartInstances.get(el);
    if (chart) { try { chart.resize(); } catch (_) { /* torn down mid-flight */ } }
    const map = mapInstances.get(el);
    if (map) { try { map.resize(); } catch (_) { /* torn down mid-flight */ } }
  });
}

// ── Conversation ─────────────────────────────────────────────────────────
// Reuses copilot.ts's rendering primitives with 'dk-messages' as the
// container — same rebuild-from-disk-on-success, same notReady hint, same
// restore-text-on-failure contract explore.ts's xpSend/xpLoadHistory use.
// The dock has no inline empty-state node (unlike the AI panel's #ai-empty),
// so — like Explore — '' is passed for `emptyId`.

let dkBusy = false; // guards against a re-entrant send while one is in flight

function dkSetComposerEnabled(enabled: boolean): void {
  const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
  const send = document.getElementById('dk-send') as HTMLButtonElement | null;
  if (input) input.disabled = !enabled;
  if (send) send.disabled = !enabled;
}

function dkShowHint(text: string): void {
  const hint = document.getElementById('dk-hint');
  if (!hint) return;
  hint.textContent = text;
  hint.hidden = false;
}

function dkHideHint(): void {
  const hint = document.getElementById('dk-hint');
  if (hint) hint.hidden = true;
}

async function dkLoadHistory(): Promise<void> {
  // A proposal is never persisted (dockPropose.ts) — rebuilding from disk
  // truth is exactly the moment to drop whatever the last turn offered.
  if (typeof dkClearProposal === 'function') dkClearProposal();
  if (!currentProjectId) { renderCopilotTurns([], 'dk-messages', ''); return; }
  let res: any = null;
  try {
    res = await window.hub.copilotHistory(currentProjectId);
  } catch (_) { res = null; }
  renderCopilotTurns(res && res.ok && Array.isArray(res.turns) ? res.turns : [], 'dk-messages', '');
}

async function dkSend(): Promise<void> {
  if (dkBusy) return;
  const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const question = input.value.trim();
  if (!question || !currentProjectId) return;

  // Context is ALWAYS inferred, never overridden — that's the dock's whole
  // point (see dkRenderContext above).
  const ref = buildCopilotContextRef();

  // Optimistic UI: the question + a pending marker appear immediately.
  if (typeof dkClearProposal === 'function') dkClearProposal(); // last turn's proposal, if any, is superseded
  dkHideHint();
  appendCopilotBubble('user', question, undefined, 'dk-messages');
  appendCopilotBubble('assistant', 'Thinking…', undefined, 'dk-messages');
  scrollCopilotToBottom('dk-messages');

  input.value = '';
  dkBusy = true;
  dkSetComposerEnabled(false);

  let res: any = null;
  try {
    res = await window.hub.copilotAsk(currentProjectId, { kind: ref.kind, id: ref.id }, question);
  } catch (_) {
    res = { ok: false, error: 'Something went wrong. Try again.' };
  }

  dkBusy = false;

  if (res && res.ok) {
    // Rebuild from disk truth — main persisted both turns on success.
    dkSetComposerEnabled(true);
    if (Array.isArray(res.turns)) renderCopilotTurns(res.turns, 'dk-messages', '');
    else await dkLoadHistory();
    dkHideHint();
    // A proposal is a bonus, never a requirement of the answer — fire it after
    // the transcript has settled and never let it block the composer.
    if (typeof dkOfferProposal === 'function') void dkOfferProposal(ref, question, String(res.answer || ''));
    return;
  }

  // Failure: main left the thread unchanged, so reload from disk to drop the
  // optimistic bubbles, and restore the typed text so nothing is lost.
  await dkLoadHistory();
  input.value = question;
  if (res && res.notReady) {
    dkSetComposerEnabled(false);
    dkShowHint('Connect a model in Execution settings to use Copilot.');
  } else {
    dkSetComposerEnabled(true);
    dkShowHint((res && res.error) || 'Could not answer that. Try again.');
  }
}

/**
 * "New conversation" clears the ONE thread this project has — the same
 * thread Explore and the AI panel read (copilot:clear, already used by
 * copilot.ts's clearCopilot). That means it also empties those two surfaces,
 * not just this panel, so it confirms first exactly like clearCopilot does
 * rather than silently wiping a conversation the user may still want from
 * Explore.
 */
async function dkNew(): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm('Start a new conversation? This clears the AI chat everywhere it appears — Explore and the AI panel too. This cannot be undone.')) return;
  try {
    await window.hub.copilotClear(currentProjectId);
  } catch (_) { /* ignore */ }
  renderCopilotTurns([], 'dk-messages', '');
  if (typeof dkClearProposal === 'function') dkClearProposal();
}

// Reconcile the composer with project/readiness state and reload history.
// Called by dkSync() only when the panel just became visible or the active
// project changed under it — not on every entity open/close, because
// neither the thread nor readiness depends on which entity is open, only the
// context LABEL does (dkRenderContext, called unconditionally by dkSync).
async function dkRefresh(): Promise<void> {
  if (dkBusy) return; // don't clobber an in-flight send's composer state
  const newBtn = document.getElementById('dk-new') as HTMLButtonElement | null;
  const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;

  if (!currentProjectId) {
    if (newBtn) newBtn.disabled = true;
    renderCopilotTurns([], 'dk-messages', '');
    dkSetComposerEnabled(false);
    if (input) input.placeholder = 'Open a project to ask a question…';
    dkShowHint('Open a project to ask a question.');
    return;
  }
  if (newBtn) newBtn.disabled = false;
  await dkLoadHistory();

  let status: any = {};
  try {
    status = (await window.hub.getKeyStatus()) || {};
  } catch (_) { status = {}; }
  const enabled = status.copilotEnabled !== false;
  const ready = Boolean(status.isReady);

  if (!enabled) {
    dkSetComposerEnabled(false);
    if (input) input.placeholder = 'AI is off. Turn it back on in Settings to ask a question.';
    dkShowHint('AI is off. Everything else in Ordinate works exactly as it does now.');
    return;
  }
  if (!ready) {
    dkSetComposerEnabled(false);
    if (input) input.placeholder = 'Connect a model to ask a question…';
    dkShowHint('Connect a model in Execution settings to use Copilot.');
    return;
  }
  dkSetComposerEnabled(true);
  if (input) input.placeholder = "Ask about what you're looking at…";
  dkHideHint();
}

// ── Keyboard ─────────────────────────────────────────────────────────────
function dkOnKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    // Bubble phase, gated on `!e.defaultPrevented` — every modal/menu/popover
    // in this app closes its OWN Escape on the CAPTURE phase (see e.g.
    // authoringRail.ts, dashAdd.ts, filterDialog.ts), so any of those already
    // ran and called preventDefault() by the time a bubble-phase listener
    // like this one sees the event. An open overlay wins; the dock is the
    // fallback, not a competitor.
    if (e.defaultPrevented || !dkAllowed() || !dkIsOpen()) return;
    e.preventDefault();
    dkSetOpen(false);
    const toggle = document.getElementById('side-ai-btn');
    if (toggle) toggle.focus();
    return;
  }
  if (e.key !== 'l' && e.key !== 'L') return;
  if (!(e.metaKey || e.ctrlKey)) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  dkToggle();
}

// ── Init ─────────────────────────────────────────────────────────────────
function initDock(): void {
  dkApplyWidth();
  document.addEventListener('keydown', dkOnKeydown);
  const handle = document.getElementById('dk-handle');
  if (handle) {
    handle.addEventListener('mousedown', dkHandleMouseDown);
    handle.addEventListener('keydown', dkHandleKeydown);
  }
  const closeBtn = document.getElementById('dk-close');
  if (closeBtn) closeBtn.addEventListener('click', () => dkSetOpen(false));
  const scrim = document.getElementById('dk-scrim');
  if (scrim) scrim.addEventListener('click', () => dkSetOpen(false));

  const newBtn = document.getElementById('dk-new');
  if (newBtn) newBtn.addEventListener('click', () => void dkNew());

  const send = document.getElementById('dk-send');
  if (send) send.addEventListener('click', () => void dkSend());

  const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
  if (input) {
    // Enter sends; Shift+Enter inserts a newline — same contract as Explore
    // and the AI panel.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void dkSend();
      }
    });
  }

  // Keep the composer honest when the execution path changes (key added or
  // removed, CLI detected) — same signal Explore and the AI panel subscribe
  // to. Only matters while the dock is actually visible; the next dkSync()
  // catches it otherwise.
  if (window.hub && typeof window.hub.onKeyChanged === 'function') {
    window.hub.onKeyChanged(() => {
      if (dkAllowed() && dkIsOpen()) void dkRefresh();
    });
  }

  // Self-contained: don't rely on whatever `selectSection` call happens to run
  // right after this in hub.ts's boot sequence to compute the first state.
  dkSync();
}
