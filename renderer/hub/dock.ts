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

// Applied once at boot. The drag handle that WRITES dkWidth lands in Task 4;
// reading it here now means that task needs no new sync plumbing.
function dkApplyWidth(): void {
  let w = 340;
  try {
    const raw = localStorage.getItem('dkWidth');
    const n = raw ? parseInt(raw, 10) : NaN;
    // Task 4 clamps [300, 40% of window] on WRITE; clamp the same range on
    // READ so a hand-edited/corrupted localStorage value can't blow the panel
    // out past that bound in the meantime.
    if (Number.isFinite(n) && n >= 300) w = Math.min(n, window.innerWidth * 0.4);
  } catch (_) { /* default stands */ }
  document.documentElement.style.setProperty('--dk-width', w + 'px');
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
  if (panel) panel.hidden = !visible;
  document.body.classList.toggle('dk-open', visible); // drives the <1100px scrim in hub.css
  dkRenderContext();
  if (visible && (dkLastVisible !== true || dkLastProjectId !== currentProjectId)) {
    dkLastProjectId = currentProjectId;
    void dkRefresh();
  }
  if (dkLastVisible !== null && dkLastVisible !== visible) dkNudgeCanvasResize();
  dkLastVisible = visible;
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
