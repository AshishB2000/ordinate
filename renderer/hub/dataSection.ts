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

function dxImportOpen(): boolean {
  return dxDialogOpen('ds-import-modal');
}

/** Set the dialog title so it names whichever surface is showing. */
function dxSetImportTitle(title: string): void {
  const el = dxEl('ds-import-title');
  if (el) el.textContent = title;
}

/**
 * Open the dialog on the SHEET picker.
 *
 * This is the one case a file import needs the dialog at all: an xlsx with more
 * than one sheet has to be asked which sheet before it hands off to the
 * composer. `renderPreview` (dsImport.ts) reveals the sheet picker and preview;
 * `dxWatchImportSurface` calls this to put a frame around them. The paste box is
 * hidden — it belongs to the other entry point.
 */
function dxOpenImport(then?: () => void): void {
  // Name the workbook in the title: "Choose a sheet" alone does not say which
  // file is being asked about, and a picked file is the one thing the user
  // cannot re-read off the dialog.
  const base = String(dsFilePath || '').split(/[\\/]/).pop() || '';
  const title = base ? 'Choose a sheet · ' + base : 'Choose a sheet';
  dxSetImportTitle(title);
  const paste = dxEl('ds-paste-wrap');
  if (paste) paste.hidden = true;
  if (!dxOpenDialog('ds-import-modal', '.ds-import-modal', title, 'ds-sheet-select')) return;
  if (then) then();
}

/**
 * Open the dialog as the PASTE surface.
 *
 * "Paste data" — from the header, the empty state, or the sidebar rail — lands
 * straight here: the paste box, ready to type into, with no intermediate
 * chooser. The file-only blocks (sheet picker, preview) are hidden so a prior
 * multi-sheet import cannot leave them showing under the textarea.
 */
function openPasteDialog(): void {
  dxSetImportTitle('Paste data');
  for (const id of ['ds-sheet-wrap', 'ds-sheet-bar', 'ds-warnings', 'ds-preview', 'ds-save-bar']) {
    const el = dxEl(id);
    if (el) el.hidden = true;
  }
  const paste = dxEl('ds-paste-wrap');
  if (paste) paste.hidden = false;
  if (!dxOpenDialog('ds-import-modal', '.ds-import-modal', 'Paste data', 'ds-paste-input')) {
    // Already open (a second click): just make sure the box has focus.
    (dxEl('ds-paste-input') as HTMLTextAreaElement | null)?.focus();
  }
}

function dxCloseImport(): void {
  dxCloseDialog('ds-import-modal');
}


/**
 * PUBLIC entry point for the other surfaces that start an import.
 *
 * `projects.ts`'s source rail (CSV / Excel, Paste data) routes through here. A
 * file import opens the native picker directly — no dialog stands between the
 * click and the OS file chooser; paste opens the paste surface.
 */
function openImportDialog(mode?: 'file' | 'paste'): void {
  if (mode === 'paste') { openPasteDialog(); return; }
  if (typeof handleImportFile === 'function') handleImportFile(); // datasets.ts
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
  { tab: 'ds-tab-insights', panel: 'ds-tabp-insights' },
  { tab: 'ds-tab-columns', panel: 'ds-tabp-columns' },
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
  panel.classList.remove('tab-data', 'tab-prepare', 'tab-quality', 'tab-insights', 'tab-columns');
  panel.classList.add(tabId.replace('ds-tab-', 'tab-'));

  if (tabId === 'ds-tab-prepare') {
    const prep = dxEl('ds-prepare-panel');
    if (prep) prep.hidden = false;
  }

  // Painted on SELECT, not on open: a dataset scan is ~30 SQL statements, and a
  // user who never opens this tab should never pay for them. `insights:list`
  // caches per dataset on `updatedAt`, so re-selecting is free.
  if (tabId === 'ds-tab-insights' && typeof insRenderDatasetTab === 'function') void insRenderDatasetTab();
  if (tabId === 'ds-tab-columns') void ctPaintColumnsTab(); // catalogPage.ts — the column docs
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

  // Each door does ONE thing directly — no chooser modal in between. Import goes
  // straight to the native file picker (handleImportFile, datasets.ts); Paste
  // opens the paste surface; Connect opens the 35-source catalog. One handler
  // per action, still in datasets.ts / connections.ts.
  const importOpen = dxEl('ds-import-open');
  if (importOpen) importOpen.addEventListener('click', () => { if (typeof handleImportFile === 'function') handleImportFile(); });

  const emptyImport = dxEl('ds-empty-import');
  if (emptyImport) emptyImport.addEventListener('click', () => { if (typeof handleImportFile === 'function') handleImportFile(); });

  const pasteOpen = dxEl('ds-paste-open');
  if (pasteOpen) pasteOpen.addEventListener('click', () => openPasteDialog());

  const emptyPaste = dxEl('ds-empty-paste');
  if (emptyPaste) emptyPaste.addEventListener('click', () => openPasteDialog());

  // "Connect data" is the door to the connectors catalog that used to be the
  // "Data" nav item. openConnPanel routes through selectSection('connect'), and
  // the Data nav item stays lit there via its data-section-alt (workspace.ts).
  const connectOpen = dxEl('ds-connect-open');
  if (connectOpen) {
    connectOpen.addEventListener('click', () => {
      if (typeof openConnPanel === 'function') openConnPanel(''); // connections.ts
    });
  }

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
