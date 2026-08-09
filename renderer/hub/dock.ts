// The AI dock — a docked, toggleable panel on the right edge that follows the
// user across the app (docs/superpowers/plans/2026-08-09-ai-dock.md). Classic
// global-scope renderer <script>: NO import/export. Loads after workspace.js
// (reads `selectSection`'s `.hub-body[data-section]`), dashboards.js (reads
// `dashReadOnly`) and chartRender.js (reads the `chartInstances`/
// `mapInstances` WeakMaps) — see the load-order comment in index.html.
//
// Task 1 ships the SHELL only: open/close from the sidebar button and ⌘L,
// suppressed in five places, view state in localStorage, and the canvas
// resize nudge. The composer (#dk-input/#dk-send) stays disabled — Task 2
// wires it to the same send path Explore uses.

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
    if (Number.isFinite(n) && n >= 300) w = n;
  } catch (_) { /* default stands */ }
  document.documentElement.style.setProperty('--dk-width', w + 'px');
}

// ── Visibility + resize nudge ───────────────────────────────────────────────
let dkLastVisible: boolean | null = null;

/**
 * Recompute panel/toggle visibility from `dkAllowed()` + `dkIsOpen()`. Safe to
 * call as often as needed (section switches, focus-mode toggles, presentation
 * mode, the toggle itself) — it only fires the canvas resize nudge when the
 * computed visibility actually changed.
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
}
