// The analysis AUTHORING WORKBENCH — Data + Visuals on the left, the sheet grid
// in the middle, Properties on the right.
//
// Classic global-scope renderer <script>: NO import/export. Loaded after
// dashboards.js and encodingForm.js, so dashCurrent / dashCurrentPage /
// renderDashGrid / markDashDirty / createEncodingForm / buildVizPicker all
// resolve at call time.
//
// THE MODEL. Ordinate's editor is a grid of CARDS; QuickSight's is a
// single-visual IDE. The bridge between them is SELECTION: click a card, and
// these panels edit that card. Nothing about Page/Card changes, so publishing,
// cross-visual filters and the Phase B–E snapshot design keep working —
// see docs/analysis/01-authoring-surface.md.
//
// WHAT THE WELLS EDIT. A visual card references a project-level Visual by id, so
// changing its encoding writes the VISUAL (visual:update), not the card. That is
// the existing sharing semantic, and it is safe for readers precisely because
// publishing denormalises: a published dashboard holds a copy by value and does
// not move when the visual is edited (00-model.md, decision 1). It does mean an
// edit here shows up in every analysis using that visual, which the panel says.
//
// THE INVARIANT. These panels exist in the Analyses section only. In dashboard
// mode there is no workbench in the DOM at all — a published dashboard is
// read-only, and a panel that can mutate a card plus the 600 ms autosave debounce
// would clobber a snapshot.

let anSelectedCardId: string | null = null;
let anForm: EncodingFormApi | null = null;
let anPicker: any = null;
// The Visual record behind the selected card, and its dataset's columns. Held so
// a well edit can write back without re-reading either.
let anVisual: any = null;
let anColumns: Array<{ name: string; type: string }> = [];
let anDataset: { name: string; kind: string } | null = null;
let anSaveTimer: number | null = null;

const AN_FLYOUT_KEY = 'anFlyout'; // id of the one open flyout pane, '' for none
const AN_PANES = ['an-pane-data', 'an-pane-visuals', 'an-pane-filter', 'an-pane-props'];

function anEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ── Wiring ──────────────────────────────────────────────────────────────────
/** Called by dashboards.ts after every grid render, and on open/close. */
function anSyncWorkbench(): void {
  const host = anEl('an-editor-host');
  const on = dashMode === 'analysis' && !!dashCurrent;
  if (host) host.classList.toggle('is-active', on);
  // FOCUS MODE. An open analysis takes the whole window: the project nav goes
  // away, as it does in the reference. Four columns competing for 1180px is what
  // made this surface feel stuffed — the nav is 176px of chrome you cannot use
  // while authoring, and "‹ Back" in the editor head already returns to it.
  document.body.classList.toggle('an-focus', on);
  // dock.ts — re-evaluate now, not just on an-focus: this same function is
  // dashGrid.ts's post-`applyDashEditorMode()` hook, so it also runs right
  // after `dashReadOnly` gets its final value for the open record.
  if (typeof dkSync === 'function') dkSync();
  anMountTopStrip(on);
  anMountFilterBar(on);
  // The analysis name IS the rename control in focus mode (the separate Rename
  // button is hidden), so it has to answer to the keyboard as well as a click.
  const nameEl = anEl('dash-name');
  if (nameEl) {
    if (on) {
      nameEl.setAttribute('role', 'button');
      nameEl.setAttribute('tabindex', '0');
      nameEl.title = 'Click to rename';
    } else {
      nameEl.removeAttribute('role');
      nameEl.removeAttribute('tabindex');
      nameEl.removeAttribute('title');
    }
  }
  if (!on) anSetProps(false);
  if (dashMode !== 'analysis') {
    anSelectedCardId = null;
    return;
  }
  // The selected card can vanish (deleted, or the sheet changed under us).
  if (anSelectedCardId && !anCardById(anSelectedCardId)) {
    anSelectCard(null);
    return;
  }
  anPaintSelection();
  anWireCards();
}

// ── Delegation ──────────────────────────────────────────────────────────────
/**
 * Click the real button behind an icon or a menu row. Disabled or `hidden` means
 * the action is genuinely unavailable right now (no model, no selection, read-only
 * dashboard), and a proxy must not pretend otherwise. CSS-hidden is fine: the
 * editor head still owns these handlers, focus mode just does not draw them.
 */
function anClick(targetId: string): void {
  const t = anEl(targetId) as HTMLButtonElement | null;
  if (t && !t.hidden && !t.disabled) t.click();
}

// The top strip is MOVED out of #dash-editor and above the workbench while an
// analysis is open, then back when it closes.
//
// It has to leave the editor to span the window: #dash-editor is the CENTRE
// column of the workbench, so a strip inside it starts to the right of the
// flyout and reads as a third column header rather than a title bar. Moving it
// keeps exactly one Back / Publish / Save, each with its one handler — the same
// one-element-two-hosts move #dash-editor and .dash-toolbar already use.
function anMountTopStrip(on: boolean): void {
  const head = document.querySelector(
    '#dash-editor > .dash-editor-head, #ws-analyses > .dash-editor-head') as HTMLElement | null;
  const editor = anEl('dash-editor');
  const panel = anEl('ws-analyses');
  const bench = anEl('an-editor-host');
  if (!head || !editor || !panel || !bench) return;
  // `dash-editor--analysis` normally sits on #dash-editor and drives the
  // workbench layout. Once the head leaves the editor that class is no longer an
  // ancestor, so it travels with the head — the same fix .dash-toolbar needed
  // when it moved into the Filters pane.
  head.classList.toggle('dash-editor--analysis', on);
  if (on) {
    // Above the workbench, so the rail, the flyout and the sheet all sit under it.
    if (head.parentElement !== panel) panel.insertBefore(head, bench);
  } else if (head.parentElement !== editor) {
    editor.insertBefore(head, editor.firstChild); // its original slot: first child
  }
}

// The dashboard-wide filter bar is MOVED into the Filters flyout while an
// analysis is open, and moved back when it closes. One element, two hosts —
// exactly what #dash-editor itself does. A copy would need a second set of ids
// and a second renderDashFilterBar target.
function anMountFilterBar(on: boolean): void {
  const bar = document.querySelector('#dash-editor .dash-toolbar, #an-filter-body .dash-toolbar') as HTMLElement | null;
  if (!bar) return;
  const host = on ? anEl('an-filter-body') : anEl('dash-editor');
  if (!host || bar.parentElement === host) return;
  if (on) host.appendChild(bar);
  else host.insertBefore(bar, anEl('dash-present-exit')); // its original slot
}
