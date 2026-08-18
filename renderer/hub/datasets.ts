// Datasets section UI (SHELL). Classic global-scope renderer <script> — NO
// import/export; symbols are shared with the other hub scripts. Consumes
// window.hub.* (the dataset:* bridge) and the shared currentProjectId
// (workspace.ts) + formatSidebarTime (hub.ts). All names/values are rendered as
// textContent only — never HTML injection. No inline style= (CSP); toggles use
// .hidden / element.style in JS only.

// ── Module-local state (kept across renders for save) ────────────────────────
let dsPreview: any = null; // last ParseResult (full, capped) held for save
let dsSourceKind = ''; // 'csv' | 'json' | 'paste' | 'xlsx'
let dsSuggestedName = ''; // from picked fileName, editable before save
let dsFilePath = ''; // xlsx re-parse on sheet switch (path known only to main→renderer round-trip)

const DS_PREVIEW_ROWS = 500; // display-only slice; the full capped rows stay in dsPreview

// ── Small DOM helpers ────────────────────────────────────────────────────────
function dsEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function dsShow(id: string, show: boolean): void {
  const el = dsEl(id);
  if (el) el.hidden = !show;
}

// ── Boot wiring (once) ───────────────────────────────────────────────────────
function initDatasets(): void {
  // The import/paste CHOOSER buttons are gone — each entry point (dataSection.ts)
  // now does one thing directly: file import opens the native picker, paste opens
  // the paste box. The Parse button inside that box is the one control this file
  // still wires; handleImportFile is called straight from dataSection.ts.
  const parseBtn = dsEl('ds-paste-parse');
  if (parseBtn) parseBtn.addEventListener('click', () => handleParsePaste());

  const saveBtn = dsEl('ds-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => handleSaveDataset());

  const sheetSel = dsEl('ds-sheet-select');
  if (sheetSel) sheetSel.addEventListener('change', () => handleSheetChange());

  const refreshAll = dsEl('ds-refresh-all-btn');
  if (refreshAll) refreshAll.addEventListener('click', () => handleRefreshAll());

  // ── Explorer controls ──
  // DEBOUNCED. A search is a full scan in main (~55 ms at 200k rows, two
  // statements) — the old client-side filter was free once hydrated, this one is
  // not, so a keystroke must not fire a query per character.
  const search = dsEl('ds-search') as HTMLInputElement | null;
  if (search) {
    search.addEventListener('input', () => {
      if (expSearchTimer) window.clearTimeout(expSearchTimer);
      expSearchTimer = window.setTimeout(() => {
        expSearchTimer = 0;
        expSearch = search.value;
        expOffset = 0; // a new result set starts at the top
        renderExplorerTable();
      }, DS_SEARCH_DEBOUNCE_MS);
    });
  }

  const colsBtn = dsEl('ds-cols-btn');
  const colsMenu = dsEl('ds-cols-menu');
  if (colsBtn && colsMenu) {
    colsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = colsMenu.hidden;
      if (show) renderColsMenu();
      colsMenu.hidden = !show;
    });
    // Close on any outside click.
    document.addEventListener('click', (e) => {
      if (colsMenu.hidden) return;
      const t = e.target as Node;
      if (t !== colsBtn && !colsMenu.contains(t)) colsMenu.hidden = true;
    });
  }

  const explainBtn = dsEl('ds-explain-btn');
  if (explainBtn) explainBtn.addEventListener('click', () => handleExplainDataset());

  const closeBtn = dsEl('ds-explorer-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      expId = ''; // also makes any in-flight page reply drop itself
      if (typeof dkSync === 'function') dkSync(); // dock.ts — context line falls back off this dataset
      if (expSearchTimer) {
        window.clearTimeout(expSearchTimer);
        expSearchTimer = 0;
      }
      dsShow('ds-explorer', false);
    });
  }
}
