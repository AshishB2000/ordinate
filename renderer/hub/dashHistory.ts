// Undo / redo for the dashboard editor, and nothing else. Classic global-scope
// renderer <script> — NO import/export; loaded after dashboards.js and before
// dashGrid.js, and everything it reaches across files (dashCurrent, dashPageIdx,
// renderDashGrid, …) resolves at call time.
//
// TWO HALVES, and the split is load-bearing.
//
//   THE STACK (dashHistNew/Push/Undo/Redo) is PURE: snapshots in, snapshots
//   out, no DOM, no dashCurrent, no save. scripts/test-dashUndo.ts drives it in
//   a vm sandbox with no `window` at all, which is only possible because
//   nothing above the glue line touches one.
//
//   THE GLUE binds it to the open record.
//
// WHY THE STACK HOLDS "BEFORE", PLUS A BASE. Every mutation in this surface
// already funnels through markDashDirty() (dashGrid.ts) — that is the ONE hook,
// and it fires AFTER the record has been changed. A stack of "the state before
// each change" plus `base` (the state as it stands right now) is what lets a
// commit be recorded from there: `base` was captured at the previous commit, so
// it IS the pre-change state, and the commit only has to file it and re-baseline.
// The alternative — a snapshot call before every mutation — is 20 call sites
// that each have to remember, and one that forgets is a corrupt stack.
//
// WHAT IS NOT IN A SNAPSHOT. `controlState` — a reader's live filter picks are
// view state, never part of the record (see dashboards.ts), so undo does not
// move them. Nor is `dashDirty`: "differs from the last save" is a fact about
// disk, and an undo is itself a change against it.

/** Snapshots kept. Fifty structured clones of a card/layout record is tens of
 *  KB, and past fifty nobody is navigating a stack, they are reverting a file. */
const DASH_HIST_CAP = 50;
/** Typing is many mutations and one edit. A COALESCING commit landing this soon
 *  after another with the same label extends it instead of stacking one undo
 *  per keystroke. Only the per-keystroke callers ask for it, so two deliberate
 *  clicks of the same button are still two undos. 600 ms matches the editor's
 *  existing autosave debounce — one idle definition, not two. */
const DASH_HIST_COALESCE_MS = 600;

interface DashHistEntry { label: string; snap: any }
interface DashHist {
  past: DashHistEntry[];
  future: DashHistEntry[];
  /** The record as it stands NOW. Never the live object — always a clone, or a
   *  later mutation would rewrite history in place. */
  base: any;
  at: number;    // when the last commit landed (coalescing only)
  label: string; // the last commit's label (coalescing only)
}

// structuredClone, not a JSON round-trip: these are hand-built records and the
// round-trip is the kind of thing that silently turns a Date into a string. The
// fallback is for a vm sandbox old enough to lack it.
function dashHistClone(v: any): any {
  return typeof structuredClone === 'function'
    ? structuredClone(v)
    : JSON.parse(JSON.stringify(v === undefined ? null : v));
}

function dashHistNew(base: any): DashHist {
  return { past: [], future: [], base: dashHistClone(base), at: 0, label: '' };
}

/** Record that `next` is the new state and `base` was the old one. `now` is
 *  passed in rather than read, so the coalescing window is testable. */
function dashHistPush(h: DashHist, label: string, next: any, now: number, coalesce?: boolean): void {
  const merge = Boolean(coalesce) && h.past.length > 0 && h.label === label
    && now - h.at <= DASH_HIST_COALESCE_MS;
  if (!merge) {
    h.past.push({ label, snap: h.base });
    // shift(), so the CAP drops the oldest change rather than refusing the
    // newest — an editor that stops recording after fifty edits is worse than
    // one that cannot go back further than fifty.
    if (h.past.length > DASH_HIST_CAP) h.past.shift();
  }
  h.future.length = 0; // a new change abandons whatever redo branch existed
  h.base = dashHistClone(next);
  h.at = now;
  h.label = label;
}

/** The state to restore, or null when there is nothing to undo. The returned
 *  snapshot is a CLONE: the caller installs it into the live record, which it
 *  then mutates, and the stack must not be holding that same object. */
function dashHistUndo(h: DashHist): DashHistEntry | null {
  const e = h.past.pop();
  if (!e) return null;
  h.future.push({ label: e.label, snap: h.base });
  h.base = e.snap;
  h.at = 0; h.label = ''; // never coalesce an edit onto the far side of an undo
  return { label: e.label, snap: dashHistClone(e.snap) };
}

function dashHistRedo(h: DashHist): DashHistEntry | null {
  const e = h.future.pop();
  if (!e) return null;
  h.past.push({ label: e.label, snap: h.base });
  h.base = e.snap;
  h.at = 0; h.label = '';
  return { label: e.label, snap: dashHistClone(e.snap) };
}

/** What the buttons say they will do. Null when the direction is exhausted. */
function dashHistUndoLabel(h: DashHist | null): string | null {
  return h && h.past.length ? h.past[h.past.length - 1].label : null;
}
function dashHistRedoLabel(h: DashHist | null): string | null {
  return h && h.future.length ? h.future[h.future.length - 1].label : null;
}

// ── Glue: the stack, bound to the open record ───────────────────────────────

let dashHist: DashHist | null = null;
/** True while undo/redo is installing a snapshot. The re-render it triggers can
 *  reach markDashDirty(), and a commit from there would file the undo itself as
 *  a new change — the classic way a redo stack eats itself. */
let dashHistBusy = false;

/** The slice of the open record the editor mutates, and therefore the slice
 *  undo restores. Exactly the five fields persistAnalysis writes. */
function dashHistRecord(): any {
  if (!dashCurrent) return null;
  return {
    name: dashCurrent.name,
    pages: dashCurrent.pages,
    filters: Array.isArray(dashCurrent.filters) ? dashCurrent.filters : [],
    style: dashCurrent.style,
    parameters: Array.isArray(dashCurrent.parameters) ? dashCurrent.parameters : [],
  };
}

/** Called when the editor binds a record: this state is the floor. */
function dashHistReset(): void {
  dashHist = dashCurrent ? dashHistNew(dashHistRecord()) : null;
  paintDashUndoBtns();
}

function dashHistClear(): void {
  dashHist = null;
  paintDashUndoBtns();
}

/** File one change. Called from markDashDirty(), which every mutation on this
 *  surface already goes through — so a new mutation is in the history by
 *  existing, not by remembering to ask. */
function dashHistCommit(label: string, coalesce?: boolean): void {
  if (!dashHist || !dashCurrent || dashHistBusy) return;
  dashHistPush(dashHist, label, dashHistRecord(), Date.now(), coalesce);
  paintDashUndoBtns();
}

/** Install a snapshot over the open record and repaint everything it can touch. */
function dashHistApply(snap: any): void {
  if (!dashCurrent || !snap) return;
  dashCurrent.name = snap.name;
  dashCurrent.pages = snap.pages;
  // ONE array, two names — openAnalysisFrom aliases sheets to pages and
  // persistAnalysis reads `pages` back out as `sheets`. Replacing one without
  // the other is how they quietly become two arrays.
  dashCurrent.sheets = dashCurrent.pages;
  dashCurrent.filters = snap.filters;
  dashCurrent.style = snap.style;
  dashCurrent.parameters = Array.isArray(snap.parameters) ? snap.parameters : [];
  if (dashPageIdx >= dashCurrent.pages.length) dashPageIdx = dashCurrent.pages.length - 1;
  if (dashPageIdx < 0) dashPageIdx = 0;
  const nameEl = dashEl('dash-name');
  if (nameEl) nameEl.textContent = dashCurrent.name || 'Untitled dashboard';
  syncDashStyle(); // before the grid: charts read their palette at construction
  renderDashFilterBar();
  renderDashPages();
  renderDashGrid();
}

/** Both directions are the same four moves; only the stack call differs. */
function dashHistStep(dir: 'undo' | 'redo'): void {
  if (!dashHist || !dashCurrent || dashReadOnly) return;
  const e = dir === 'undo' ? dashHistUndo(dashHist) : dashHistRedo(dashHist);
  if (!e) return;
  dashHistBusy = true;
  try {
    dashHistApply(e.snap);
  } finally {
    dashHistBusy = false;
  }
  // An undo differs from the last save exactly as the change it reverses did,
  // so it is dirty and it autosaves — Save clears the flag, never the stack.
  dashDirty = true;
  scheduleDashSave();
  paintDashUndoBtns();
  if (typeof showToast === 'function') {
    showToast((dir === 'undo' ? 'Undid: ' : 'Redid: ') + e.label);
  }
}

function dashUndo(): void { dashHistStep('undo'); }
function dashRedo(): void { dashHistStep('redo'); }

/** Enable/disable the header pair and put the change they name in the tooltip. */
function paintDashUndoBtns(): void {
  ([['dash-undo-btn', dashHistUndoLabel(dashHist), 'Undo'],
    ['dash-redo-btn', dashHistRedoLabel(dashHist), 'Redo'],
  ] as Array<[string, string | null, string]>).forEach(([id, label, verb]) => {
    const b = dashEl(id) as HTMLButtonElement | null;
    if (!b) return;
    b.disabled = label === null;
    b.title = label === null ? 'Nothing to ' + verb.toLowerCase() : verb + ': ' + label;
  });
}

// ⌘Z / ⇧⌘Z (and ⌃Y on Windows) are declared on the `dash.undo` / `dash.redo`
// commands in commandDefs.ts and bound by the single keymap in commands.ts.
// The guards that used to live in this file's own keydown handler live there
// too, generalised: the editor check is the commands' `when()`, and "a text
// field owns ⌘Z" is CMD_NATIVE_EDIT_KEYS, so the next command to claim an
// editing chord inherits the rule instead of rediscovering it.
