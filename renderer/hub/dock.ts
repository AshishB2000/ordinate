// The AI dock — a docked, toggleable panel on the right edge that follows the
// user across the app (docs/superpowers/plans/2026-08-09-ai-dock.md). Classic
// global-scope renderer <script>: NO import/export. Loads after workspace.js
// (reads `selectSection`'s `.hub-body[data-section]`), dashboards.js (reads
// `dashReadOnly`) and askCore.js (reads `xpAppendBubble`/`xpRenderTurns`/
// `xpScrollToBottom`) — see the load-order comment in index.html.
//
// Task 1 shipped the SHELL: open/close from the sidebar button and ⌘L,
// suppressed in five places, view state in localStorage, and the canvas
// resize nudge.
//
// Task 2 wired the composer to the SAME thread Explore uses, through the
// panel copilot.ts's rendering primitives — since REWORKED (see below).
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
//
// ── Rework (develop merged in: 498d647 retired the standalone Copilot panel,
// renderer/hub/copilot.ts) ──────────────────────────────────────────────────
// The panel's rendering (appendCopilotBubble/renderCopilotTurns/
// scrollCopilotToBottom) moved to explore.ts as xpAppendBubble/xpRenderTurns/
// xpScrollToBottom, each taking a `containerId` (defaulting to Explore's own)
// — the dock calls them with 'dk-messages'. One rendering implementation,
// two containers, same as before; only the file it lives in changed.
//
// The panel's buildCopilotContextRef() — a global priority chain (dataset →
// visual → dashboard → project) off whatever entity happened to be open
// ANYWHERE — did NOT move. It was genuinely fragile (expId survives
// navigating away, so it could resolve a dataset the user left minutes ago)
// and 498d647 fixed the exact bug that inference caused in Explore. The dock
// now has its OWN resolver, dkContextRef() below: section-aware, and it
// falls back to whole-project rather than to another section's stale global.
// #side-ai-btn briefly belonged to Explore (498d647) and now belongs to the
// dock again: Explore already had its own top-level nav item, so that button
// was a duplicate door to a place with a door, while the dock had none in the
// chrome. The dock now has TWO entry points — #side-ai-btn (moved from the
// sidebar to the right end of the top bar) and ⌘L — and both funnel through
// dkToggle()/dkSync(). The third, #dk-edge, was a vertical tab pinned to the
// window's right edge; it was deleted in the top-bar relayout. Its one real
// job was body.an-focus, which hides the sidebar the button used to live in,
// and the top bar is NOT hidden there — so the button itself now covers it.

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
  // NOT suppressed in `an-focus`. The plan's "the analyses workbench already
  // owns the full width" was an assumption, and an open analysis is the
  // surface where a contextual assistant is worth the most. Measured in the
  // real app instead (full table in
  // docs/superpowers/plans/2026-08-09-ai-dock.md): at 1180px with BOTH the
  // 48px rail and the 252px flyout open, a 340px dock leaves the sheet 540px
  // and each of two half-width cards 247px; at 1440px, 800px and 377px. The
  // editor head stays one row (47px) in all eight combinations, and head,
  // grid and document horizontal overflow are 0 everywhere. Focus mode hides
  // the 176px sidebar, which is most of what the dock takes back.
  if (document.body.classList.contains('cap-focus')) return false; // capture surface is deliberately bare
  // The `section === 'explore'` case that used to sit here is gone with the
  // page it guarded (#117 merged the two AI surfaces into this dock), and a
  // check against a section that cannot exist reads as a live rule.
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

/* The dock does NOT open itself. A `dkFirstRun()` used to flip `dkOpen` on the
   first usable sync, so the Assistant was on screen over Data, Visuals and
   Dashboards before anyone asked — and with no model it opened onto its own
   "connect a model" notice. `dkOpen` remembers the user's choice instead. */

function dkToggle(): void {
  if (!dkAllowed()) return;
  if (!dkIsOpen()) dkUserOpened = true; // a deliberate open — this one may take focus
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
  // Widening the panel drags the cursor AWAY from the handle (it's on the
  // panel's left edge), so releasing outside the OS window is plausible —
  // and when that happens, `mouseup` never reaches `document`. Without this
  // guard the listener would stay attached and keep resizing on any later
  // mouse movement with no button held, until an unrelated click happened to
  // fire `mouseup` and clean up. `e.buttons` reflects the CURRENT button
  // state on every move, so a release outside the window is caught on the
  // very next move inside it — treat it exactly like a real mouseup.
  if (e.buttons !== 1) { dkHandleMouseUp(); return; }
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
 * The dock's own section-aware context resolver. Resolves from
 * `currentSection` (workspace.ts) FIRST — an entity is only in scope while
 * its OWN section is the one on screen — and falls through to whole-project
 * rather than to another section's stale global. That fallback is the whole
 * point: it's what makes an implicit context safe, because `dkRenderContext`
 * below repaints from this on every section switch and entity open/close, so
 * the header can never silently disagree with what's on screen.
 *
 * Deliberately NOT the retired copilot.ts panel's buildCopilotContextRef() —
 * a global priority chain (dataset → visual → dashboard → project) off
 * whatever entity happened to be open ANYWHERE, including one the user
 * navigated away from (expId is never cleared on nav). Routing through that
 * is exactly what 498d647 fixed in Explore: with a dataset open in the
 * explorer and Explore's chip set to "Whole project", the question was
 * silently scoped to that open dataset anyway — the chip and the answer
 * disagreeing. The dock has no competing chip, so it renders exactly what it
 * resolved — but only if what it resolves can never outlive its section.
 */
function dkContextRef(): { kind: string; id: string; label: string } {
  if (currentSection === 'datasets') {
    if (typeof expId === 'string' && expId) {
      const name = typeof expName === 'string' && expName ? expName : 'open dataset';
      return { kind: 'dataset', id: expId, label: 'dataset · ' + name };
    }
    return { kind: '', id: '', label: 'whole project' };
  }
  if (currentSection === 'visuals') {
    if (typeof vizEditingId === 'string' && vizEditingId) {
      return { kind: 'visual', id: vizEditingId, label: 'visual · open visual' };
    }
    return { kind: '', id: '', label: 'whole project' };
  }
  // 'analyses' (now the Dashboards surface) and anything else — deliberately
  // whole project. Wiring the open dashboard in as dock context would be a
  // behaviour change, out of scope for this delete-and-relabel.
  return { kind: '', id: '', label: 'whole project' };
}

/**
 * Paint the header's "Based on …" line from `dkContextRef()`. Cheap and
 * synchronous, so `dkSync()` below calls it unconditionally on every section
 * switch, focus-mode toggle and entity open/close — the context line must
 * never lag one step behind what's on screen.
 */
function dkRenderContext(): void {
  const el = document.getElementById('dk-context');
  if (!el) return;
  const ref = dkContextRef();
  el.textContent = '';
  const label = document.createElement('span');
  label.className = 'dk-context-label';
  label.textContent = 'Based on ' + ref.label;
  el.appendChild(label);
  // Same "stats app-computed" chip Explore's provenance rows use — .xp-prov-chip,
  // not a new chip style. (Not .ai-chip: that class's CSS did not survive
  // 498d647's retirement of the copilot panel; .xp-prov-chip is its
  // surviving equivalent.)
  const chip = document.createElement('span');
  chip.className = 'xp-prov-chip';
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
// Set by an explicit user open (toggle button / ⌘L), consumed by the next
// dkSync(). Focus is only pulled into the dock when the USER opened it — not
// when it merely became visible again because a suppression condition lifted
// (leaving presentation or cap-focus, closing a dashboard). Those are
// navigations the user drove elsewhere, and stealing focus into the composer
// there yanks it out from under them.
let dkUserOpened = false;

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
  // Two entry points now: #side-ai-btn (the top bar's Agent toggle —
  // workspace.ts wires it to dkToggle) and ⌘L.
  const sideBtn = document.getElementById('side-ai-btn') as HTMLButtonElement | null;
  const allowed = dkAllowed();
  const visible = allowed && dkIsOpen();
  // DISABLED where suppressed, not hidden: it is a fixed control in a
  // persistent bar, so removing it would leave a hole in the chrome every time
  // you visit Explore. (cap-focus hides the whole top bar, and dkAllowed() is
  // false there anyway, so this only ever fires for Explore, presentation and
  // a published dashboard.) It stays visible AND enabled while the dock is
  // OPEN, because it is a toggle — it is how you close the dock from the
  // chrome, which is exactly what aria-expanded promises. The old #dk-edge hid
  // itself when open; a header button that vanished would leave a gap in the
  // bar, so this one does not.
  if (sideBtn) {
    sideBtn.disabled = !allowed;
    sideBtn.setAttribute('aria-expanded', String(visible));
  }
  const justOpened = visible && dkLastVisible !== true && dkUserOpened;
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
  dkUserOpened = false; // consumed either way — never carries into a later sync
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
// Reuses explore.ts's xpAppendBubble/xpRenderTurns/xpScrollToBottom with
// 'dk-messages' as the container — same rebuild-from-disk-on-success, same
// notReady hint, same restore-text-on-failure contract xpSend/xpLoadHistory
// use. One rendering implementation, two containers; the dock has no inline
// empty-state node, same as Explore.

let dkBusy = false; // guards against a re-entrant send while one is in flight
// The thread the dock is showing. '' → the project's most-recent thread (main
// resolves an absent id to it). The dock is now multi-thread like the retired
// Assistant page — "New conversation" starts a PARALLEL thread (copilotNewThread)
// rather than wiping the one (the old copilotClear).
let dkThreadId = '';

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
  // A proposal is never persisted (dockPropose.ts), and neither is an activity
  // region (askActivity.ts) — rebuilding from disk truth is exactly the moment
  // to drop whatever the last turn offered.
  if (typeof dkClearProposal === 'function') dkClearProposal();
  if (typeof xpActivityClearContainer === 'function') xpActivityClearContainer('dk-messages');
  if (!currentProjectId) { xpRenderTurns([], 'dk-messages'); return; }
  let res: any = null;
  try {
    res = await window.hub.copilotHistory(currentProjectId, dkThreadId || undefined);
  } catch (_) { res = null; }
  if (res && res.ok && typeof res.threadId === 'string') dkThreadId = res.threadId;
  xpRenderTurns(res && res.ok && Array.isArray(res.turns) ? res.turns : [], 'dk-messages');
  dkRenderThreadTitle();
}

// ── Thread title + switcher (the multi-thread model, rehomed from the page) ──
// The header shows the active conversation's title (its first user turn, the way
// main titles a thread) and, on click, this project's conversations to switch to.
function dkRenderThreadTitle(): void {
  const el = document.getElementById('dk-thread-title-text');
  if (!el) return;
  const first = document.querySelector('#dk-messages .xp-msg-user .xp-bubble') as HTMLElement | null;
  const t = first && first.textContent ? first.textContent.trim() : '';
  el.textContent = t ? (t.length > 40 ? t.slice(0, 40) + '\u2026' : t) : 'New conversation';
}

function dkMakeThreadRow(t: any): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'dk-thread-row';
  row.setAttribute('role', 'menuitem');
  if (String(t.id || '') === dkThreadId) row.classList.add('is-active');
  const name = document.createElement('span');
  name.className = 'dk-thread-row-name';
  name.textContent = t.title || 'Conversation';
  const meta = document.createElement('span');
  meta.className = 'dk-thread-row-meta';
  const n = typeof t.turnCount === 'number' ? t.turnCount : 0;
  meta.textContent = n === 1 ? '1 turn' : n + ' turns';
  row.append(name, meta);
  row.addEventListener('click', () => void dkOpenThread(String(t.id || '')));
  return row;
}

async function dkRenderThreadList(): Promise<void> {
  const host = document.getElementById('dk-thread-list');
  if (!host || !currentProjectId) return;
  host.textContent = '';
  let threads: any[] = [];
  try {
    const res: any = await window.hub.copilotThreads(currentProjectId);
    if (res && res.ok && Array.isArray(res.threads)) threads = res.threads;
  } catch (_) { threads = []; }
  if (!threads.length) {
    const empty = document.createElement('div');
    empty.className = 'dk-thread-empty';
    empty.textContent = 'No past conversations yet.';
    host.appendChild(empty);
    return;
  }
  threads.forEach((t) => host.appendChild(dkMakeThreadRow(t)));
}

function dkSetThreadListOpen(open: boolean): void {
  const list = document.getElementById('dk-thread-list');
  const title = document.getElementById('dk-thread-title');
  if (list) list.hidden = !open;
  if (title) title.setAttribute('aria-expanded', open ? 'true' : 'false');
}

async function dkToggleThreadList(): Promise<void> {
  const list = document.getElementById('dk-thread-list');
  if (!list) return;
  const willOpen = Boolean(list.hidden);
  if (willOpen) await dkRenderThreadList();
  dkSetThreadListOpen(willOpen);
}

async function dkOpenThread(id: string): Promise<void> {
  if (!id) return;
  dkThreadId = id;
  dkSetThreadListOpen(false);
  if (typeof dkClearProposal === 'function') dkClearProposal();
  await dkLoadHistory();
}

// ── Assistant on/off — the one control that turns config.copilotEnabled back
// on. Always clickable, even while the composer is disabled (that is the point).
//
// THREE states, not two. The pill used to read the on/off preference alone, so
// with no model it said "AI: On" directly above the panel's own "Connect a
// model…" notice. Readiness (config.executionReady(), reaching the renderer as
// getKeyStatus().isReady) is the outer state: with no model there is nothing to
// turn on or off, so the pill says so and becomes the way to fix it.
// `dkAiNeedsModel` is what the click branches on — one meaning at a time.
let dkAiNeedsModel = false;

function dkPaintAiToggle(enabled: boolean, ready: boolean): void {
  const btn = document.getElementById('dk-ai-toggle') as HTMLButtonElement | null;
  if (!btn) return;
  dkAiNeedsModel = !ready;
  if (!ready) {
    btn.textContent = 'No model';
    btn.removeAttribute('aria-pressed'); // not a toggle in this state — a link to the fix
    btn.title = AI_NOT_CONFIGURED;
    btn.classList.remove('dk-ai-toggle--off');
    btn.classList.add('dk-ai-toggle--none');
    return;
  }
  btn.classList.remove('dk-ai-toggle--none');
  btn.textContent = enabled ? 'Assistant: On' : 'Assistant: Off';
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  btn.title = enabled ? 'Turn the Assistant off' : 'Turn the Assistant on';
  btn.classList.toggle('dk-ai-toggle--off', !enabled);
}

async function dkToggleAi(): Promise<void> {
  // With no model there is no preference worth flipping — send the user to the
  // one screen that can change the answer.
  if (dkAiNeedsModel) {
    if (typeof showSettingsPanel === 'function') void showSettingsPanel('exec');
    return;
  }
  let status: any = {};
  try { status = (await window.hub.getKeyStatus()) || {}; } catch (_) { status = {}; }
  const next = status.copilotEnabled === false; // flip
  try { await window.hub.setCopilotEnabled(next); } catch (_) { /* dkRefresh re-reads truth */ }
  await dkRefresh();
}

// Entry point for the Home ask bar: open the dock and send the question.
async function dkAsk(question: string): Promise<void> {
  const q = (question || '').trim();
  if (!q) return;
  dkSetOpen(true);
  // dkSetOpen → dkSync fires an ASYNC history reload (void dkRefresh) when the
  // dock has just become visible. Await a reconcile here first, or that reload
  // lands mid-send and wipes the optimistic bubbles dkSend is about to append.
  await dkRefresh();
  const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
  if (input) input.value = q;
  await dkSend();
}

async function dkSend(): Promise<void> {
  if (dkBusy) return;
  const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const question = input.value.trim();
  if (!question || !currentProjectId) return;

  // Context is ALWAYS inferred, never overridden — that's the dock's whole
  // point (see dkContextRef/dkRenderContext above).
  const ref = dkContextRef();

  // A per-ask id so main streams this answer's tokens back to THIS bubble. The
  // streaming machinery lives in explore.ts (one rendering + one registry for
  // both surfaces); the shared askId keeps the dock's stream out of Explore's.
  const askId = xpNewAskId();

  // Optimistic UI: the question + a pending marker appear immediately.
  if (typeof dkClearProposal === 'function') dkClearProposal(); // last turn's proposal, if any, is superseded
  dkHideHint();
  xpAppendBubble('user', question, undefined, 'dk-messages');
  xpAppendBubble('assistant', 'Thinking…', undefined, 'dk-messages');
  xpScrollToBottom('dk-messages');
  // Both side channels ride the ONE askId above: streaming fills the pending
  // bubble, the activity region shows the app's work beneath it (askActivity.ts).
  xpBeginStream(askId, 'dk-messages'); // the "Thinking…" bubble just appended is the stream target
  if (typeof xpActivityStart === 'function') xpActivityStart(askId, 'dk-messages');

  input.value = '';
  dkBusy = true;
  dkSetComposerEnabled(false);

  let res: any = null;
  try {
    res = await window.hub.copilotAsk(currentProjectId, { kind: ref.kind, id: ref.id }, question, dkThreadId || undefined, askId);
  } catch (_) {
    res = { ok: false, error: 'Something went wrong. Try again.' };
  }

  dkBusy = false;
  xpEndStream(askId); // streamed text was a preview; the next step reconciles from disk truth

  if (res && res.ok) {
    // Rebuild from disk truth — main persisted both turns on success.
    if (typeof res.threadId === 'string') dkThreadId = res.threadId;
    dkRenderThreadTitle();
    dkSetComposerEnabled(true);
    if (Array.isArray(res.turns)) xpRenderTurns(res.turns, 'dk-messages');
    else await dkLoadHistory();
    if (askId && typeof xpActivityCollapse === 'function') xpActivityCollapse(askId);
    dkHideHint();
    // A proposal is a bonus, never a requirement of the answer — fire it after
    // the transcript has settled and never let it block the composer.
    // WHICH proposal comes from the model's validated suggestedAction (main's
    // whitelist, src/ai/suggestedAction.ts), not a keyword guess here.
    if (typeof dkOfferProposal === 'function') void dkOfferProposal(ref, question, res.suggestedAction, dkThreadId || '');
    return;
  }

  // Failure: main left the thread unchanged, so reload from disk to drop the
  // optimistic bubbles, and restore the typed text so nothing is lost. The
  // activity region goes with the pending bubble — no orphan chips.
  if (askId && typeof xpActivityClear === 'function') xpActivityClear(askId);
  await dkLoadHistory();
  input.value = question;
  if (res && res.notReady) {
    dkSetComposerEnabled(false);
    dkShowHint(AI_NOT_CONFIGURED);
  } else {
    dkSetComposerEnabled(true);
    dkShowHint((res && res.error) || 'Could not answer that. Try again.');
  }
}

// "New conversation" starts a PARALLEL thread — non-destructive. The previous
// thread stays on disk and in the switcher; nothing is wiped, so no confirm.
async function dkNew(): Promise<void> {
  if (!currentProjectId) return;
  try {
    const res: any = await window.hub.copilotNewThread(currentProjectId);
    dkThreadId = res && res.ok && res.thread ? String(res.thread.id) : '';
  } catch (_) { dkThreadId = ''; }
  xpRenderTurns([], 'dk-messages');
  if (typeof dkClearProposal === 'function') dkClearProposal();
  dkRenderThreadTitle();
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
    dkThreadId = '';
    xpRenderTurns([], 'dk-messages');
    // xpRenderTurns only removes `.xp-msg` — a proposal card left over from
    // the closed project is a `.dk-proposal`, so without this its Apply
    // button would stay on screen pointing at a dataset that's no longer open.
    if (typeof dkClearProposal === 'function') dkClearProposal();
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
  dkPaintAiToggle(enabled, ready);

  if (!enabled) {
    dkSetComposerEnabled(false);
    if (input) input.placeholder = 'The Assistant is off. Turn it back on with the toggle above.';
    dkShowHint('The Assistant is off. Everything else in Ordinate works exactly as it does now.');
    return;
  }
  if (!ready) {
    dkSetComposerEnabled(false);
    if (input) input.placeholder = 'Connect a model to ask a question…';
    dkShowHint(AI_NOT_CONFIGURED);
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
    // Focus returns to the control that opened it. #side-ai-btn stays visible
    // and enabled while the dock is open, so unlike the old #dk-edge there is
    // nothing to un-hide first — dkSync() has already run synchronously above.
    const toggle = document.getElementById('side-ai-btn');
    if (toggle) toggle.focus();
    return;
  }
  if (e.key !== 'l' && e.key !== 'L') return;
  if (!(e.metaKey || e.ctrlKey)) return;
  const t = e.target as HTMLElement | null;
  // The dock's own subtree is exempted BEFORE the text-field guard below.
  // dkSync() focuses #dk-input (a <textarea>) the moment the dock becomes
  // visible/usable, so without this, the text-field guard traps ⌘L the
  // instant focus is inside the composer — the SECOND open, or any click into
  // it, would silently stop the shortcut from closing the dock.
  if (t && t.closest && t.closest('#dk-panel')) { e.preventDefault(); dkToggle(); return; }
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
  // No entry point is wired here any more. #side-ai-btn (the top bar's Agent
  // toggle) is wired in workspace.ts beside the rest of the chrome, and ⌘L is
  // handled by dkOnKeydown above; both land on the same dkToggle(), which
  // checks dkAllowed(). The dock's own #dk-edge tab was removed — see the
  // header comment.
  const newBtn = document.getElementById('dk-new');
  if (newBtn) newBtn.addEventListener('click', () => void dkNew());

  const title = document.getElementById('dk-thread-title');
  if (title) title.addEventListener('click', () => void dkToggleThreadList());
  const aiToggle = document.getElementById('dk-ai-toggle');
  if (aiToggle) aiToggle.addEventListener('click', () => void dkToggleAi());
  // Close the thread list on any click outside it and its trigger.
  document.addEventListener('mousedown', (e) => {
    const list = document.getElementById('dk-thread-list');
    if (!list || list.hidden) return;
    const tgt = e.target as Node;
    if (list.contains(tgt) || (title && title.contains(tgt))) return;
    dkSetThreadListOpen(false);
  });

  const send = document.getElementById('dk-send');
  if (send) send.addEventListener('click', () => void dkSend());

  const input = document.getElementById('dk-input') as HTMLTextAreaElement | null;
  if (input) {
    // Enter sends; Shift+Enter inserts a newline — same contract as Explore.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void dkSend();
      }
    });
  }

  // Keep the composer honest when the execution path changes (key added or
  // removed, CLI detected) — same signal Explore subscribes to. Only matters
  // while the dock is actually visible; the next dkSync() catches it
  // otherwise.
  if (window.hub && typeof window.hub.onKeyChanged === 'function') {
    window.hub.onKeyChanged(() => {
      if (dkAllowed() && dkIsOpen()) void dkRefresh();
    });
  }

  // Self-contained: don't rely on whatever `selectSection` call happens to run
  // right after this in hub.ts's boot sequence to compute the first state.
  dkSync();
}
