'use strict';

// The AI dock's WIDTH: the clamp, the stored value, and the two gestures that
// change it (drag the handle, or arrow-key it when the handle has focus).
//
// Split out of dock.ts under the 800-line cap (.claude/rules/file-size.md).
// One job, cleanly separable: nothing here knows what the dock CONTAINS — it
// reads and writes one CSS custom property and one localStorage key, and calls
// dkNudgeCanvasResize() (dock.ts) once per finished gesture so charts relayout.
//
// Classic global-scope <script>: no import/export. Loads BEFORE dock.js, whose
// initDock() calls dkApplyWidth() and wires the handle to the handlers here.

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
