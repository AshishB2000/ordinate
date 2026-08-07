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

/** Focus trap + return, from the shared helper every other hub modal uses. */
let dxImportA11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
/** Watches the save bar, so a SUCCESSFUL save closes the dialog. See below. */
let dxSaveWatch: MutationObserver | null = null;

function dxImportOpen(): boolean {
  const modal = dxEl('ds-import-modal');
  return !!modal && !modal.hidden;
}

/**
 * Open the dialog on step one.
 *
 * `then` runs after it is on screen — that is how `+ Import data` and the
 * empty state's `Import file` reach the native file picker: open the frame
 * first, so the parsed preview has somewhere to land.
 */
function dxOpenImport(then?: () => void): void {
  const modal = dxEl('ds-import-modal');
  const box = modal ? (modal.querySelector('.ds-import-modal') as HTMLElement | null) : null;
  if (!modal || !box || !modal.hidden) return;

  modal.hidden = false;
  dxImportA11y = makeModalAccessible(box, 'Import data', dxEl('ds-import-btn'));
  document.addEventListener('keydown', dxImportKey, true);

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
  const modal = dxEl('ds-import-modal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.removeEventListener('keydown', dxImportKey, true);
  if (dxSaveWatch) {
    dxSaveWatch.disconnect();
    dxSaveWatch = null;
  }
  if (dxImportA11y) {
    dxImportA11y.release(); // focus back to whatever opened it
    dxImportA11y = null;
  }
}

function dxImportKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    dxCloseImport();
    return;
  }
  if (dxImportA11y) dxImportA11y.onTabKey(e);
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

function initDataSection(): void {
  dxWatchImportSurface();

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

  // Backdrop only — mousedown, so a selection dragged out of the preview and
  // released on the backdrop does not count as a click on it.
  const modal = dxEl('ds-import-modal');
  if (modal) {
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) dxCloseImport();
    });
  }
}

// The hub boots its sections from hub.ts; this one has no state to restore, so
// it wires itself as soon as the DOM it addresses exists.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDataSection);
} else {
  initDataSection();
}
