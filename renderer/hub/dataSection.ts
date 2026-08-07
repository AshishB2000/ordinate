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

function initDataSection(): void {
  // The header's primary action and the empty state's two, all routed to the
  // import controls that already exist further down the section.
  const importOpen = dxEl('ds-import-open');
  if (importOpen) importOpen.addEventListener('click', () => dxClick('ds-import-btn'));

  const emptyImport = dxEl('ds-empty-import');
  if (emptyImport) emptyImport.addEventListener('click', () => dxClick('ds-import-btn'));

  const emptyPaste = dxEl('ds-empty-paste');
  if (emptyPaste) emptyPaste.addEventListener('click', () => dxClick('ds-paste-toggle'));
}

// The hub boots its sections from hub.ts; this one has no state to restore, so
// it wires itself as soon as the DOM it addresses exists.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDataSection);
} else {
  initDataSection();
}
