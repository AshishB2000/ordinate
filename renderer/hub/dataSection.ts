'use strict';

// Data-section LAYOUT. Renderer only, classic global-scope script (no
// import/export), loaded after datasets.js and prepare.js.
//
// This file owns how the Data section is arranged — the header actions, the
// empty state, and (later phases) the import dialog, the explorer swap and the
// tabs. It owns NOTHING about what those controls do: every existing control
// keeps its id and its handler in `datasets.ts` / `prepare.ts`, and this file
// only routes the new entry points to them.
//
// Why a separate file: `datasets.ts` is 1,000 lines of import/parse/preview/
// explorer logic addressed entirely by `getElementById`. Layout changes that
// have to leave that wiring untouched are much easier to review — and to
// revert — when they are not interleaved with it.

/** The section's own $. Same contract as `dsEl` in datasets.ts. */
function dxEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/**
 * Click one of the section's EXISTING controls.
 *
 * The new header and empty-state buttons are alternative doors to the controls
 * that were already there — `#ds-import-btn` opens the native file picker,
 * `#ds-paste-toggle` reveals the paste box. Routing to them by a synthetic
 * click means there is still exactly ONE handler per action, in datasets.ts,
 * and this file cannot drift away from what it triggers.
 */
function dxClick(id: string): void {
  const el = dxEl(id) as HTMLButtonElement | null;
  if (el) el.click();
}

// ── The import dialog ───────────────────────────────────────────────────────
//
// The dialog is markup that already exists (#ds-import-modal in index.html);
// this only opens, closes and traps focus in it. Every control inside keeps the
// handler datasets.ts gave it, so the dialog cannot change what importing DOES.

/**
 * ONE dialog mechanism for this section's two modals.
 *
 * Both are static markup (their controls keep the ids and handlers they always
 * had); this adds only the modal behaviour — Escape, backdrop, and the focus
 * trap from the shared `makeModalAccessible`, the same one dashChooseModal and
 * the capture review dialog use.
 */
const dxOpenDialogs = new Map<string, { a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null; onKey: (e: KeyboardEvent) => void }>();

function dxDialogOpen(overlayId: string): boolean {
  const el = dxEl(overlayId);
  return !!el && !el.hidden;
}

function dxOpenDialog(overlayId: string, boxSel: string, label: string, initialFocusId?: string): boolean {
  const overlay = dxEl(overlayId);
  const box = overlay ? (overlay.querySelector(boxSel) as HTMLElement | null) : null;
  if (!overlay || !box || !overlay.hidden) return false;

  overlay.hidden = false;
  const state = {
    a11y: makeModalAccessible(box, label, initialFocusId ? dxEl(initialFocusId) : null),
    onKey: (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dxCloseDialog(overlayId);
        return;
      }
      const st = dxOpenDialogs.get(overlayId);
      if (st && st.a11y) st.a11y.onTabKey(e);
    },
  };
  dxOpenDialogs.set(overlayId, state);
  document.addEventListener('keydown', state.onKey, true);

  // Backdrop only, on mousedown — a selection dragged out of the dialog and
  // released on the backdrop is not a click on it.
  overlay.onmousedown = (e: MouseEvent): void => {
    if (e.target === overlay) dxCloseDialog(overlayId);
  };
  return true;
}

function dxCloseDialog(overlayId: string): void {
  const overlay = dxEl(overlayId);
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  const state = dxOpenDialogs.get(overlayId);
  if (state) {
    document.removeEventListener('keydown', state.onKey, true);
    if (state.a11y) state.a11y.release(); // focus back to whatever opened it
    dxOpenDialogs.delete(overlayId);
  }
}

/** Watches the save bar, so a SUCCESSFUL save closes the import dialog. */
let dxSaveWatch: MutationObserver | null = null;

function dxImportOpen(): boolean {
  return dxDialogOpen('ds-import-modal');
}

/**
 * Open the import dialog on step one.
 *
 * `then` runs once it is on screen — that is how `+ Import data` and the empty
 * state's `Import file` reach the native file picker: open the frame first, so
 * the parsed preview has somewhere to land.
 */
function dxOpenImport(then?: () => void): void {
  if (!dxOpenDialog('ds-import-modal', '.ds-import-modal', 'Import data', 'ds-import-btn')) return;

  // A save that SUCCEEDS ends with datasets.ts hiding the save bar
  // (clearPreview) and repainting the list; a save that fails alerts and leaves
  // the bar up. So "the bar went away" is exactly "the dataset was written" —
  // which lets the dialog close itself without datasets.ts having to know it is
  // in a dialog at all.
  const bar = dxEl('ds-save-bar');
  if (bar && !dxSaveWatch) {
    dxSaveWatch = new MutationObserver(() => {
      if (bar.hidden && dxImportOpen()) dxCloseImport();
    });
    dxSaveWatch.observe(bar, { attributes: true, attributeFilter: ['hidden'] });
  }

  if (then) then();
}

function dxCloseImport(): void {
  if (dxSaveWatch) {
    dxSaveWatch.disconnect();
    dxSaveWatch = null;
  }
  dxCloseDialog('ds-import-modal');
}


/**
 * PUBLIC entry point for the other surfaces that start an import.
 *
 * `projects.ts`'s source rail (CSV / Excel, Paste data) drives the very same
 * controls, and they now live inside the dialog — so it opens the dialog first
 * rather than acting on hidden elements.
 */
function openImportDialog(mode?: 'file' | 'paste'): void {
  dxOpenImport(() => {
    if (mode === 'file') dxClick('ds-import-btn');
    else if (mode === 'paste') dxClick('ds-paste-toggle');
  });
}

/**
 * The dialog follows the DATA, not just the buttons.
 *
 * Whatever path produced a parsed preview — the rail, a future entry point, a
 * re-parse on a sheet change — the preview and its warnings live in the dialog
 * now, and showing them while it is closed would put the result somewhere
 * nobody can see. So: when either becomes visible and the dialog is not open,
 * open it. This is a backstop for callers that do not know about the dialog,
 * which is the failure this refactor could otherwise ship silently.
 */
function dxWatchImportSurface(): void {
  const watched = ['ds-preview', 'ds-warnings']
    .map((id) => dxEl(id))
    .filter((el): el is HTMLElement => !!el);
  if (watched.length === 0) return;
  const obs = new MutationObserver(() => {
    if (dxImportOpen()) return;
    if (watched.some((el) => !el.hidden)) dxOpenImport();
  });
  for (const el of watched) obs.observe(el, { attributes: true, attributeFilter: ['hidden'] });
}

/**
 * The list, the explorer and the composer are mutually exclusive: opening a
 * dataset — or starting a new one — takes the whole panel, closing it gives the
 * list back. Same swap the Visuals section makes between gallery and builder.
 *
 * It is driven OFF `#ds-explorer`'s own `hidden`, which datasets.ts already
 * sets when a dataset opens and when Back is pressed. So this adds a view
 * without touching that logic — and it cannot fall out of step with it, because
 * it is reading the same bit rather than keeping a second one.
 */
function dxWatchExplorer(): void {
  const explorer = dxEl('ds-explorer');
  const panel = document.querySelector('#ws-datasets .ds-panel') as HTMLElement | null;
  if (!explorer || !panel) return;
  const composer = dxEl('ds-composer');
  const sync = (): void => {
    panel.classList.toggle('is-exploring', !explorer.hidden);
    panel.classList.toggle('is-composing', !!composer && !composer.hidden);
  };
  new MutationObserver(sync).observe(explorer, { attributes: true, attributeFilter: ['hidden'] });
  if (composer) new MutationObserver(sync).observe(composer, { attributes: true, attributeFilter: ['hidden'] });
  sync();
}

// ── The explorer's tabs: Data · Prepare · Quality ───────────────────────────

/** Tab id → its panel id. Order is the arrow-key order. */
const DX_TABS: ReadonlyArray<{ tab: string; panel: string }> = [
  { tab: 'ds-tab-data', panel: 'ds-tabp-data' },
  { tab: 'ds-tab-prepare', panel: 'ds-tabp-prepare' },
  { tab: 'ds-tab-quality', panel: 'ds-tabp-quality' },
];

/**
 * Select one tab.
 *
 * A roving tabindex, so the strip is ONE tab stop and the arrows move within it
 * — the pattern for a tablist, and the reason these are real buttons with
 * `role="tab"` rather than styled divs.
 *
 * The Prepare panel is unhidden here because `prepare.ts` hides it on every
 * dataset open (`resetPreparePanel`) — it predates the tab and still believes
 * it is a panel that toggles. Owning its visibility from the tab is what makes
 * `#ds-prepare-btn` a tab selector without rewriting that file.
 */
function dxSelectTab(tabId: string, focus?: boolean): void {
  const panel = document.querySelector('#ws-datasets .ds-explorer') as HTMLElement | null;
  if (!panel) return;
  for (const t of DX_TABS) {
    const btn = dxEl(t.tab);
    const body = dxEl(t.panel);
    const on = t.tab === tabId;
    if (btn) {
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
      if (on && focus) btn.focus();
    }
    if (body) body.hidden = !on;
  }
  // `tab-data` / `tab-prepare` / `tab-quality` on the explorer: the grid pane
  // sits below the Data tab and beside the Prepare rail, which is layout, not
  // visibility, so CSS decides it from here.
  panel.classList.remove('tab-data', 'tab-prepare', 'tab-quality');
  panel.classList.add(tabId.replace('ds-tab-', 'tab-'));

  if (tabId === 'ds-tab-prepare') {
    const prep = dxEl('ds-prepare-panel');
    if (prep) prep.hidden = false;
  }
}

function initDataTabs(): void {
  const strip = document.querySelector('#ws-datasets .ds-tabs') as HTMLElement | null;
  if (!strip) return;

  DX_TABS.forEach(({ tab }) => {
    const btn = dxEl(tab);
    if (btn) btn.addEventListener('click', () => dxSelectTab(tab));
  });

  strip.addEventListener('keydown', (e: KeyboardEvent) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (keys.indexOf(e.key) < 0) return;
    e.preventDefault();
    // Anchor on the FOCUSED tab, falling back to the selected one. Selection
    // follows focus here, so the two normally agree — but focus can be moved
    // into the strip on its own (a click on the strip, a script), and moving
    // from the selected tab would then jump somewhere the user is not.
    const active = document.activeElement as HTMLElement | null;
    let i = DX_TABS.findIndex((t) => active && active.id === t.tab);
    if (i < 0) i = DX_TABS.findIndex((t) => dxEl(t.tab)?.getAttribute('aria-selected') === 'true');
    const at = i < 0 ? 0 : i;
    let next = at;
    if (e.key === 'ArrowLeft') next = (at - 1 + DX_TABS.length) % DX_TABS.length;
    else if (e.key === 'ArrowRight') next = (at + 1) % DX_TABS.length;
    else if (e.key === 'Home') next = 0;
    else next = DX_TABS.length - 1;
    dxSelectTab(DX_TABS[next].tab, true);
  });

  // Opening a dataset lands on Data — the tab you were on for the LAST dataset
  // is not a claim about this one.
  const explorer = dxEl('ds-explorer');
  if (explorer) {
    new MutationObserver(() => {
      if (!explorer.hidden) dxSelectTab('ds-tab-data');
    }).observe(explorer, { attributes: true, attributeFilter: ['hidden'] });
  }
  dxSelectTab('ds-tab-data');
}

function initDataSection(): void {
  dxWatchImportSurface();
  dxWatchExplorer();
  initDataTabs();

  // Every door into importing opens the dialog first, then triggers the control
  // that already existed — one handler per action, still in datasets.ts.
  const importOpen = dxEl('ds-import-open');
  if (importOpen) importOpen.addEventListener('click', () => dxOpenImport());

  const emptyImport = dxEl('ds-empty-import');
  if (emptyImport) emptyImport.addEventListener('click', () => dxOpenImport(() => dxClick('ds-import-btn')));

  const emptyPaste = dxEl('ds-empty-paste');
  if (emptyPaste) emptyPaste.addEventListener('click', () => dxOpenImport(() => dxClick('ds-paste-toggle')));

  const x = dxEl('ds-import-x');
  if (x) x.addEventListener('click', () => dxCloseImport());

  // Combine opens the COMPOSER — the same page importing lands on. There is no
  // combine dialog any more: two surfaces for one operation is how they drift.
  // With no dataset chosen the composer opens empty and its sources panel picks
  // the base, so this header action needs no picker of its own.
  const combineOpen = dxEl('ds-combine-open');
  if (combineOpen) combineOpen.addEventListener('click', () => openComposerEmpty());


}

// The hub boots its sections from hub.ts; this one has no state to restore, so
// it wires itself as soon as the DOM it addresses exists.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDataSection);
} else {
  initDataSection();
}
