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

// ── Preview rendering ────────────────────────────────────────────────────────
function clearPreview(): void {
  dsPreview = null;
  dsSourceKind = '';
  dsSuggestedName = '';
  dsFilePath = '';
  const scroll = dsEl('ds-table-scroll');
  if (scroll) scroll.innerHTML = '';
  const warn = dsEl('ds-warnings');
  if (warn) warn.innerHTML = '';
  dsShow('ds-warnings', false);
  dsShow('ds-preview', false);
  dsShow('ds-save-bar', false);
  dsShow('ds-sheet-wrap', false);
  dsShow('ds-explorer', false); // close the saved-dataset explorer if open
  const nameInput = dsEl('ds-name-input') as HTMLInputElement | null;
  if (nameInput) nameInput.value = '';
}

// Fill #ds-warnings, the preview table, the sheet picker, and the save bar from a
// ParseResult. Read-only views (opening a saved dataset) pass showSave=false.
function renderPreview(res: any, showSave: boolean): void {
  dsShow('ds-explorer', false); // an import preview replaces any open explorer
  dsPreview = res || null;
  const columns: any[] = (res && Array.isArray(res.columns)) ? res.columns : [];
  const rows: any[] = (res && Array.isArray(res.rows)) ? res.rows : [];
  const warnings: any[] = (res && Array.isArray(res.warnings)) ? res.warnings : [];
  const rowCount: number = typeof (res && res.rowCount) === 'number' ? res.rowCount : rows.length;

  // Warnings.
  const warnBox = dsEl('ds-warnings');
  if (warnBox) {
    warnBox.innerHTML = '';
    warnings.forEach((w) => {
      const line = document.createElement('div');
      line.className = 'ds-warning';
      line.textContent = String(w);
      warnBox.appendChild(line);
    });
  }
  dsShow('ds-warnings', warnings.length > 0);

  // Sheet picker (xlsx multi-sheet only).
  const sheetNames: string[] = (res && Array.isArray(res.sheetNames)) ? res.sheetNames : [];
  const sheetSel = dsEl('ds-sheet-select') as HTMLSelectElement | null;
  if (sheetSel) {
    sheetSel.innerHTML = '';
    sheetNames.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sheetSel.appendChild(opt);
    });
  }
  dsShow('ds-sheet-wrap', sheetNames.length > 1 && !!dsFilePath);

  // Preview table.
  const scroll = dsEl('ds-table-scroll');
  if (scroll) {
    scroll.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'ds-table';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    columns.forEach((col) => {
      const th = document.createElement('th');
      th.className = 'ds-th';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'ds-th-name';
      nameSpan.textContent = col && col.name != null ? String(col.name) : '';
      const type = col && col.type ? String(col.type) : 'text';
      const badge = document.createElement('span');
      badge.className = 'ds-type ds-type-' + type;
      badge.textContent = type;
      th.appendChild(nameSpan);
      th.appendChild(badge);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const shown = rows.slice(0, DS_PREVIEW_ROWS);
    shown.forEach((row) => {
      const tr = document.createElement('tr');
      const cells: any[] = Array.isArray(row) ? row : [];
      // Pad/truncate to the column count so cells align with headers.
      for (let i = 0; i < columns.length; i++) {
        const td = document.createElement('td');
        td.className = 'ds-td';
        const v = cells[i];
        td.textContent = v == null ? '' : String(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
  }

  const note = dsEl('ds-preview-note');
  if (note) {
    if (rowCount > DS_PREVIEW_ROWS) {
      note.textContent = 'Showing first ' + DS_PREVIEW_ROWS + ' of ' + rowCount + ' rows';
      note.hidden = false;
    } else {
      note.textContent = '';
      note.hidden = true;
    }
  }
  dsShow('ds-preview', columns.length > 0 || warnings.length === 0);

  // Save bar (hidden for read-only views).
  const nameInput = dsEl('ds-name-input') as HTMLInputElement | null;
  if (nameInput && showSave) nameInput.value = dsSuggestedName || '';
  dsShow('ds-save-bar', showSave && columns.length > 0);
}

// ── Import / paste handlers ──────────────────────────────────────────────────
async function handleImportFile(): Promise<void> {
  let res: any;
  try {
    res = await window.hub.pickAndParseDataset();
  } catch (_) {
    return;
  }
  if (!res || res.canceled) return;
  if (!res.ok) {
    window.alert(res.error || 'Could not read that file.');
    return;
  }
  dsSourceKind = String(res.sourceKind || 'csv');
  dsSuggestedName = defaultNameFrom(res.fileName);
  dsFilePath = typeof res.filePath === 'string' ? res.filePath : '';
  renderPreview(res.preview, true);
}

async function handleSheetChange(): Promise<void> {
  if (!dsFilePath) return;
  const sel = dsEl('ds-sheet-select') as HTMLSelectElement | null;
  if (!sel) return;
  let res: any;
  try {
    res = await window.hub.pickAndParseDataset(sel.value, dsFilePath);
  } catch (_) {
    return;
  }
  if (!res || !res.ok || res.canceled) return;
  renderPreview(res.preview, true);
}

async function handleParsePaste(): Promise<void> {
  const input = dsEl('ds-paste-input') as HTMLTextAreaElement | null;
  const text = input ? input.value : '';
  let res: any;
  try {
    res = await window.hub.parsePasteDataset(text);
  } catch (_) {
    return;
  }
  if (!res || !res.ok) {
    window.alert((res && res.error) || 'Could not parse the pasted text.');
    return;
  }
  dsSourceKind = 'paste';
  dsSuggestedName = 'Pasted data';
  dsFilePath = '';
  renderPreview(res.preview, true);
}

// Strip the extension from a picked file name for the default dataset name.
function defaultNameFrom(fileName: any): string {
  const base = typeof fileName === 'string' ? fileName : '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// ── Save ─────────────────────────────────────────────────────────────────────
async function handleSaveDataset(): Promise<void> {
  if (!currentProjectId) {
    window.alert('Open a project first.');
    return;
  }
  if (!dsPreview || !Array.isArray(dsPreview.columns) || dsPreview.columns.length === 0) return;
  const nameInput = dsEl('ds-name-input') as HTMLInputElement | null;
  const name = (nameInput && nameInput.value.trim()) || dsSuggestedName || 'Untitled dataset';
  let res: any;
  try {
    res = await window.hub.saveDataset({
      projectId: currentProjectId,
      name,
      sourceKind: dsSourceKind || 'csv',
      columns: dsPreview.columns,
      rows: dsPreview.rows,
    });
  } catch (_) {
    window.alert('Failed to save the dataset.');
    return;
  }
  if (res && res.ok === false) {
    window.alert(res.error || 'Failed to save the dataset.');
    return;
  }
  clearPreview();
  const pasteInput = dsEl('ds-paste-input') as HTMLTextAreaElement | null;
  if (pasteInput) pasteInput.value = '';
  dsShow('ds-paste-wrap', false);
  await refreshDatasetList();
}

// ── Saved-dataset list ───────────────────────────────────────────────────────
async function refreshDatasetList(): Promise<void> {
  const list = dsEl('ds-saved-list');
  const empty = dsEl('ds-saved-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    if (empty) empty.hidden = false;
    return;
  }
  let items: any[] = [];
  try {
    items = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  if (empty) empty.hidden = items.length > 0;
  items.forEach((d) => list.appendChild(makeSavedItem(d)));
}

function makeSavedItem(d: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ds-saved-item';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ds-saved-open';

  // Week 13 — a capture-sourced dataset gets a "Capture" badge and, when its
  // screenshot crop is still on disk, a small thumbnail that opens the original
  // in the shared lightbox (verify extracted values against the image).
  if (d && d.sourceKind === 'capture') {
    const cropPath = d.capture && d.capture.cropPath ? String(d.capture.cropPath) : '';
    if (cropPath) {
      const thumb = document.createElement('img');
      thumb.className = 'ds-cap-thumb';
      thumb.src = 'file://' + cropPath;
      thumb.alt = 'Capture screenshot';
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof openLightboxSrc === 'function') openLightboxSrc('file://' + cropPath);
      });
      open.appendChild(thumb);
    }
    const badge = document.createElement('span');
    badge.className = 'ds-cap-badge';
    badge.textContent = 'Capture';
    open.appendChild(badge);
  }

  const name = document.createElement('span');
  name.className = 'ds-saved-name';
  name.textContent = d && d.name ? String(d.name) : 'Untitled dataset';
  const meta = document.createElement('span');
  meta.className = 'ds-saved-meta';
  const rowCount = typeof (d && d.rowCount) === 'number' ? d.rowCount : 0;
  const kind = d && d.sourceKind ? String(d.sourceKind) : '';
  meta.textContent = rowCount + ' rows · ' + kind + ' · ' + formatSidebarTime(d && d.updatedAt);
  open.appendChild(name);
  open.appendChild(meta);
  open.addEventListener('click', () => openSavedDataset(String(d.id)));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ds-saved-del';
  del.setAttribute('aria-label', 'Delete dataset');
  del.textContent = '🗑';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDeleteDataset(String(d.id));
  });

  row.appendChild(open);
  row.appendChild(del);
  return row;
}

// ── Saved-dataset explorer (page / sort / search / show-hide / rename / retype /
// stats / quality / AI explain).
//
// PAGED, NOT HYDRATED. This grid used to hold the whole table in renderer memory
// (`expRows = ds.rows`) and re-copy it — filter + sort + slice — on every
// keystroke and every header click. That made it the last consumer that
// materialises everything, which is what forced parse.ts's 50,000-row cap.
//
// Now search, sort and slice run in main against the stored .parquet
// (`window.hub.datasetPage` → src/datasetPage.ts) and only the ~500-row window
// the grid is about to draw crosses the bridge. Round-trips to main: opening a
// dataset, a debounced search keystroke, a header sort click, a page step, and a
// pipeline/retype change. Column show/hide and the summary chips repaint from
// the window already in hand — no IPC.
//
// `expRows` is kept as the FALLBACK table: a v2 (rows-inline) record, a dead
// bridge or a failed query lands on `explorerDisplayRows()`, the identical
// client-side search+sort this file has always used, sliced to the same window.
// `{ok:false}` NEVER means "no rows" — an empty page is a real result.
type ExpCol = { name: string; type: string };
type ExpCell = string | number | null;

/** One page of the grid. Also the fallback slice size and the old preview cap. */
const DS_PAGE_ROWS = DS_PREVIEW_ROWS;
/** A full-scan search in main costs ~55 ms at 200k rows — never per character. */
const DS_SEARCH_DEBOUNCE_MS = 250;

let expId = ''; // open dataset's id (empty when no explorer open)
let expName = '';
let expColumns: ExpCol[] = [];
let expRows: ExpCell[][] = []; // FALLBACK ONLY — never rendered directly (see above)
let expSummaries: any[] = []; // per-column ColumnSummary from dataset:stats
let expHidden: Set<number> = new Set();
let expSearch = '';
let expSortCol = -1;
let expSortDir = 1; // 1 asc, -1 desc

let expPageRows: ExpCell[][] = []; // the window currently drawn
let expTotal = 0; // rows matching the search, BEFORE paging (comes back with the page)
let expOffset = 0; // first row of the drawn window, 0-based
let expPageSeq = 0; // request generation — a late reply for an older query is dropped
let expSearchTimer = 0; // pending debounced search (window.setTimeout handle)

// `datasetPage` is on the preload bridge (preload/hubPreload.ts) but not in
// globals.d.ts's Window['hub'] shape, which this file may not edit. Resolve it
// through one narrow cast rather than sprinkling `any` at the call site; an
// absent method simply reads as undefined and takes the fallback path.
type DatasetPageReq = {
  offset: number;
  limit: number;
  search?: string;
  sortColumn?: string;
  sortDir?: 'asc' | 'desc';
};
function datasetPageBridge(): ((p: string, d: string, r: DatasetPageReq) => Promise<any>) | undefined {
  return (window.hub as unknown as { datasetPage?: (p: string, d: string, r: DatasetPageReq) => Promise<any> })
    .datasetPage;
}

function normalizeCols(cols: any): ExpCol[] {
  return Array.isArray(cols)
    ? cols.map((c: any) => ({
        name: c && c.name != null ? String(c.name) : '',
        type: c && (c.type === 'number' || c.type === 'date') ? c.type : 'text',
      }))
    : [];
}

async function openSavedDataset(id: string): Promise<void> {
  if (!currentProjectId) return;
  let ds: any;
  try {
    // Metadata only — the grid pulls the window it draws through datasetPage,
    // so the whole table never crosses IPC. This is what lets a dataset be
    // larger than the renderer could hold.
    ds = await (window.hub as any).getDatasetMeta(currentProjectId, id);
  } catch (_) {
    return;
  }
  if (!ds) return;

  // Leaving any in-progress import preview — hide it, show the explorer instead.
  dsFilePath = '';
  dsShow('ds-preview', false);
  dsShow('ds-save-bar', false);
  dsShow('ds-warnings', false);
  dsShow('ds-sheet-wrap', false);

  expId = String(ds.id || id);
  expName = ds.name ? String(ds.name) : 'Untitled dataset';
  expColumns = normalizeCols(ds.columns);
  // Intentionally empty: rows are never hydrated into the renderer any more.
  // The client-side fallback in explorerDisplayRows() operates on this buffer,
  // so it now yields nothing — which is correct, because main's dataset:page
  // handler already falls back to hydrate-and-page for a v2 record. There is no
  // case where the renderer needs its own copy of the table.
  expRows = [];
  expSteps = Array.isArray(ds.steps) ? ds.steps : []; // prepare.ts pipeline state
  expSummaries = [];
  expHidden = new Set();
  expSearch = '';
  expSortCol = -1;
  expSortDir = 1;
  expPageRows = [];
  expTotal = 0;
  expOffset = 0;
  if (expSearchTimer) {
    window.clearTimeout(expSearchTimer);
    expSearchTimer = 0;
  }

  const searchInput = dsEl('ds-search') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
  const explainOut = dsEl('ds-explain-out');
  if (explainOut) {
    explainOut.hidden = true;
    explainOut.textContent = '';
  }
  const colsMenu = dsEl('ds-cols-menu');
  if (colsMenu) colsMenu.hidden = true;
  const quality = dsEl('ds-quality');
  if (quality) {
    quality.innerHTML = '';
    quality.hidden = true;
  }
  const title = dsEl('ds-explorer-title');
  if (title) title.textContent = expName;

  // Week 13 — capture provenance strip (thumbnail + view-original + recapture).
  renderCapStrip(ds);

  dsShow('ds-explorer', true);
  resetPreparePanel(); // prepare.ts — collapse editor/suggest/menu, render steps + combine
  await refreshExplorerPage(); // awaited so the grid never paints blank first
  await loadExplorerStats();
}

// Week 13 — render (or hide) the capture-provenance strip for the open dataset.
// Only a capture-sourced dataset shows it: a thumbnail + "View original" (both
// open the shared lightbox) and Recapture → Replace / Append (startRecapture is
// defined in captureDataset.js and reuses the ordinary capture path). All other
// dataset kinds keep the strip hidden — nothing else in the explorer changes.
function renderCapStrip(ds: any): void {
  const strip = dsEl('ds-cap-strip');
  if (!strip) return;
  strip.innerHTML = '';
  if (!ds || ds.sourceKind !== 'capture') {
    strip.hidden = true;
    return;
  }
  const cropPath = ds.capture && ds.capture.cropPath ? String(ds.capture.cropPath) : '';
  const src = cropPath ? 'file://' + cropPath : '';

  if (src) {
    const thumb = document.createElement('img');
    thumb.className = 'ds-cap-thumb';
    thumb.src = src;
    thumb.alt = 'Capture screenshot';
    thumb.addEventListener('click', () => {
      if (typeof openLightboxSrc === 'function') openLightboxSrc(src);
    });
    strip.appendChild(thumb);

    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn btn-sm';
    viewBtn.textContent = 'View original';
    viewBtn.addEventListener('click', () => {
      if (typeof openLightboxSrc === 'function') openLightboxSrc(src);
    });
    strip.appendChild(viewBtn);
  }

  const dsId = String(ds.id || expId);
  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.id = 'ds-recapture-replace';
  replaceBtn.className = 'btn btn-sm';
  replaceBtn.textContent = 'Recapture (replace)';
  replaceBtn.addEventListener('click', () => {
    if (typeof startRecapture === 'function') startRecapture(dsId, 'replace');
  });
  strip.appendChild(replaceBtn);

  const appendBtn = document.createElement('button');
  appendBtn.type = 'button';
  appendBtn.id = 'ds-recapture-append';
  appendBtn.className = 'btn btn-sm';
  appendBtn.textContent = 'Recapture (append)';
  appendBtn.addEventListener('click', () => {
    if (typeof startRecapture === 'function') startRecapture(dsId, 'append');
  });
  strip.appendChild(appendBtn);

  strip.hidden = false;
}

// Fetch per-column summaries + quality issues ONCE (per open / after a retype).
async function loadExplorerStats(): Promise<void> {
  if (!currentProjectId || !expId) return;
  let res: any;
  try {
    res = await window.hub.datasetStats(currentProjectId, expId);
  } catch (_) {
    return;
  }
  if (!res || !res.ok) return;
  expSummaries = Array.isArray(res.summaries) ? res.summaries : [];
  renderQuality(Array.isArray(res.issues) ? res.issues : []);
  paintExplorerTable(); // headers now carry summary chips — same rows, no refetch
}

function renderQuality(issues: any[]): void {
  const box = dsEl('ds-quality');
  if (!box) return;
  box.innerHTML = '';
  issues.forEach((i) => {
    const badge = document.createElement('span');
    badge.className = 'ds-quality-badge' + (i && i.severity === 'warn' ? ' ds-quality-warn' : '');
    badge.textContent = i && i.detail ? String(i.detail) : '';
    box.appendChild(badge);
  });
  box.hidden = issues.length === 0;
}

// Empties sort last regardless of direction; numbers numeric, text/date lexical.
function sortCompare(a: ExpCell, b: ExpCell, type: string, dir: number): number {
  const aE = a == null || a === '';
  const bE = b == null || b === '';
  if (aE && bE) return 0;
  if (aE) return 1;
  if (bE) return -1;
  let c: number;
  if (type === 'number') {
    const an = typeof a === 'number' ? a : Number(a);
    const bn = typeof b === 'number' ? b : Number(b);
    c = an < bn ? -1 : an > bn ? 1 : 0;
  } else {
    c = String(a).localeCompare(String(b));
  }
  return c * dir;
}

// FALLBACK PATH ONLY. Apply search + sort to a copy of the rows the renderer
// already has; never mutates expRows. Used when `datasetPage` cannot serve the
// window (v2 record, dead bridge, failed query) — deliberately still the exact
// semantics src/datasetPage.ts's `pageRowsJs` was transcribed from, so the
// fallback and the fast path agree.
function explorerDisplayRows(): ExpCell[][] {
  const q = expSearch.trim().toLowerCase();
  let rows = expRows.map((row) => (Array.isArray(row) ? row : []));
  if (q) {
    rows = rows.filter((row) =>
      expColumns.some((_, c) => {
        const v = row[c];
        return v != null && String(v).toLowerCase().includes(q);
      }),
    );
  }
  if (expSortCol >= 0 && expSortCol < expColumns.length) {
    const type = expColumns[expSortCol].type;
    const dir = expSortDir;
    rows = rows.slice().sort((a, b) => sortCompare(a[expSortCol], b[expSortCol], type, dir));
  }
  return rows;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '';
  const r = Math.round(n * 100) / 100;
  return String(r);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function summaryChipText(sum: any): string {
  if (!sum) return '';
  if (sum.type === 'number') {
    const parts: string[] = [];
    if (typeof sum.min === 'number' && typeof sum.max === 'number') parts.push(fmtNum(sum.min) + '–' + fmtNum(sum.max));
    if (typeof sum.mean === 'number') parts.push('avg ' + fmtNum(sum.mean));
    parts.push('n=' + (sum.count ?? 0));
    return parts.join(' · ');
  }
  const parts: string[] = [(sum.distinct ?? 0) + ' distinct'];
  if (sum.mostCommon) parts.push('top "' + truncate(String(sum.mostCommon.value), 16) + '" ×' + sum.mostCommon.count);
  parts.push('n=' + (sum.nonEmpty ?? 0));
  return parts.join(' · ');
}

function toggleSort(c: number): void {
  if (expSortCol === c) expSortDir = expSortDir === 1 ? -1 : 1;
  else {
    expSortCol = c;
    expSortDir = 1;
  }
  expOffset = 0; // a new order invalidates the page you were on
  renderExplorerTable();
}

// The clicked column's NAME — what `datasetPage` takes (it resolves the name to
// an index against the stored schema). The header UI still tracks the clicked
// INDEX, so the arrow lands where you clicked.
//
// BEHAVIOUR CHANGE, duplicate column names only: main resolves the FIRST column
// with this name, so clicking the second "Total" of two now sorts by the first
// "Total". The old client-side path sorted by the exact index. It only bites a
// dataset with two identically-named columns; the fallback path below is still
// index-exact, so the two paths disagree in that one case.
function expSortColumnName(): string {
  return expSortCol >= 0 && expSortCol < expColumns.length ? expColumns[expSortCol].name : '';
}

function makeExplorerTh(col: ExpCol, c: number): HTMLElement {
  const th = document.createElement('th');
  th.className = 'ds-th';
  const inner = document.createElement('div');
  inner.className = 'ds-th-inner';

  const row = document.createElement('div');
  row.className = 'ds-th-row';

  const sortBtn = document.createElement('button');
  sortBtn.type = 'button';
  sortBtn.className = 'ds-th-sort';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'ds-th-name';
  nameSpan.textContent = col.name;
  sortBtn.appendChild(nameSpan);
  const arrow = document.createElement('span');
  arrow.className = 'ds-th-arrow';
  arrow.textContent = expSortCol === c ? (expSortDir === 1 ? '▲' : '▼') : '';
  sortBtn.appendChild(arrow);
  sortBtn.addEventListener('click', () => toggleSort(c));
  row.appendChild(sortBtn);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'ds-th-edit';
  edit.setAttribute('aria-label', 'Rename column');
  edit.textContent = '✎';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    handleRenameColumn(c);
  });
  row.appendChild(edit);

  const sel = document.createElement('select');
  sel.className = 'ds-th-retype';
  sel.setAttribute('aria-label', 'Column type');
  ['text', 'number', 'date'].forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (t === col.type) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => handleRetypeColumn(c, sel.value));
  row.appendChild(sel);

  inner.appendChild(row);

  const chip = document.createElement('div');
  chip.className = 'ds-th-summary';
  chip.textContent = summaryChipText(expSummaries[c]);
  inner.appendChild(chip);

  th.appendChild(inner);
  return th;
}

/**
 * Fetch the window the grid should be showing and paint it.
 *
 * One round-trip to main per call. Search, sort and slice all happen there,
 * against the .parquet — nothing outside the window is hydrated. `total` comes
 * back with the page, so the row-count label costs no extra read.
 *
 * A stale reply (the user typed or clicked again while this was in flight, or
 * closed the dataset) is dropped on the `expPageSeq`/`expId` check rather than
 * repainting over a newer window.
 */
async function refreshExplorerPage(retried?: boolean): Promise<void> {
  if (!expId) return;
  const seq = ++expPageSeq;
  const wantId = expId;
  const req: DatasetPageReq = {
    offset: expOffset,
    limit: DS_PAGE_ROWS,
    search: expSearch.trim(),
    sortColumn: expSortColumnName(),
    sortDir: expSortDir === 1 ? 'asc' : 'desc',
  };

  let res: any = null;
  try {
    const page = datasetPageBridge();
    if (page && currentProjectId) res = await page(currentProjectId, wantId, req);
  } catch (_) {
    res = null; // dead bridge — fall through to the client-side path
  }
  if (seq !== expPageSeq || wantId !== expId) return; // a newer request already won

  if (res && res.ok === true) {
    // An EMPTY page is a real answer (search matched nothing, or you paged past
    // the end) — only `ok === true` is trusted, never row-count truthiness.
    expPageRows = Array.isArray(res.rows) ? res.rows : [];
    expTotal = typeof res.total === 'number' ? res.total : expPageRows.length;
    expOffset = typeof res.offset === 'number' ? res.offset : expOffset;
    // The table shrank under us (a prepare step dropped rows while you were on a
    // later page) — an offset past the end is a legitimately empty page, but a
    // blank grid is not what the user asked for. Snap to the top, once.
    if (expPageRows.length === 0 && expTotal > 0 && expOffset > 0 && !retried) {
      expOffset = 0;
      await refreshExplorerPage(true);
      return;
    }
  } else {
    // Fallback: the rows the renderer already has, same search + sort + slice.
    const all = explorerDisplayRows();
    expTotal = all.length;
    if (expOffset >= expTotal) expOffset = 0;
    expPageRows = all.slice(expOffset, expOffset + DS_PAGE_ROWS);
  }
  paintExplorerTable();
}

// Public entry for "the underlying data or its order changed" — used by
// prepare.ts after a pipeline step, and by sort/search/paging here. Painting is
// left to the fetch so a stale window is never shown between the two.
function renderExplorerTable(): void {
  void refreshExplorerPage();
}

function stepExplorerPage(delta: number): void {
  const next = expOffset + delta * DS_PAGE_ROWS;
  if (next < 0 || next >= expTotal) return;
  expOffset = next;
  renderExplorerTable();
}

// Draw the window currently in hand. NO filtering, NO sorting, NO IPC — those
// happened in main. Cheap enough to call for a column show/hide or a summary
// chip arriving.
function paintExplorerTable(): void {
  const scroll = dsEl('ds-explorer-scroll');
  if (!scroll) return;
  scroll.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'ds-table';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  expColumns.forEach((col, c) => {
    if (expHidden.has(c)) return;
    htr.appendChild(makeExplorerTh(col, c));
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  expPageRows.forEach((rowArr) => {
    const tr = document.createElement('tr');
    const cells: any[] = Array.isArray(rowArr) ? rowArr : [];
    expColumns.forEach((_, c) => {
      if (expHidden.has(c)) return;
      const td = document.createElement('td');
      td.className = 'ds-td';
      const v = cells[c];
      td.textContent = v == null ? '' : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  scroll.appendChild(table);

  paintExplorerPager();
}

// Row count + Prev/Next, built into the existing #ds-explorer-note. The grid
// only ever drew the first 500 rows, so paging is a strict gain: the rows past
// 500 were previously unreachable. Chose explicit pages over a virtual scroll —
// same 500-row draw, no scroll-position bookkeeping, no new markup or CSS (this
// file is the only one that may change). No inline style= anywhere: CSP would
// silently drop it, so spacing is set through element.style from JS.
function paintExplorerPager(): void {
  const note = dsEl('ds-explorer-note');
  if (!note) return;
  note.innerHTML = '';
  note.hidden = false;

  const first = expTotal === 0 ? 0 : expOffset + 1;
  const last = Math.min(expOffset + expPageRows.length, expTotal);
  const label = document.createElement('span');
  label.textContent =
    expTotal > expPageRows.length
      ? 'Rows ' + first + '–' + last + ' of ' + expTotal
      : expTotal + (expTotal === 1 ? ' row' : ' rows');
  note.appendChild(label);

  if (expTotal <= DS_PAGE_ROWS) return; // one page — no controls to show

  const mkPageBtn = (text: string, delta: number, disabled: boolean): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.textContent = text;
    btn.disabled = disabled;
    btn.style.marginLeft = '8px';
    btn.addEventListener('click', () => stepExplorerPage(delta));
    note.appendChild(btn);
  };
  mkPageBtn('‹ Prev', -1, expOffset <= 0);
  mkPageBtn('Next ›', 1, expOffset + DS_PAGE_ROWS >= expTotal);
}

// Column show/hide menu (checkbox per column).
function renderColsMenu(): void {
  const menu = dsEl('ds-cols-menu');
  if (!menu) return;
  menu.innerHTML = '';
  expColumns.forEach((col, c) => {
    const item = document.createElement('label');
    item.className = 'ds-cols-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !expHidden.has(c);
    cb.addEventListener('change', () => {
      if (cb.checked) expHidden.delete(c);
      else expHidden.add(c);
      paintExplorerTable(); // pure display — the window in hand is unchanged
    });
    const span = document.createElement('span');
    span.textContent = col.name || 'Column ' + (c + 1);
    item.appendChild(cb);
    item.appendChild(span);
    menu.appendChild(item);
  });
}

// Persist a full new columns array (rename and/or retype) — main re-coerces cells
// on a type change — then reload state + stats from the returned dataset.
async function persistColumns(newCols: ExpCol[]): Promise<void> {
  if (!currentProjectId || !expId) return;
  let res: any;
  try {
    res = await window.hub.updateDataset(currentProjectId, expId, newCols);
  } catch (_) {
    window.alert('Failed to update the dataset.');
    return;
  }
  if (!res || res.ok === false) {
    window.alert((res && res.error) || 'Failed to update the dataset.');
    return;
  }
  const ds = res.dataset || {};
  expColumns = normalizeCols(ds.columns);
  if (Array.isArray(ds.rows)) expRows = ds.rows;
  await refreshExplorerPage(); // a retype re-coerced cells and changed sort semantics
  await loadExplorerStats(); // recompute summaries/quality + repaint the headers
  await refreshDatasetList(); // updatedAt changed in the saved list
}

async function handleRenameColumn(c: number): Promise<void> {
  const current = expColumns[c] ? expColumns[c].name : '';
  const name = await promptModal('Rename column', current, 'Save'); // projects.ts
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === current) return;
  const newCols = expColumns.map((col, i) => ({ name: i === c ? trimmed : col.name, type: col.type }));
  await persistColumns(newCols);
}

async function handleRetypeColumn(c: number, type: string): Promise<void> {
  if (!expColumns[c] || expColumns[c].type === type) return;
  const newCols = expColumns.map((col, i) => ({ name: col.name, type: i === c ? type : col.type }));
  await persistColumns(newCols);
}

// OPTIONAL: narrate the dataset via the configured model. Numbers are computed in
// main and passed as facts; gate on readiness — show a gentle hint, never an error.
async function handleExplainDataset(): Promise<void> {
  if (!currentProjectId || !expId) return;
  const out = dsEl('ds-explain-out');
  const btn = dsEl('ds-explain-btn') as HTMLButtonElement | null;
  if (out) {
    out.hidden = false;
    out.className = 'ds-explain-out ds-explain-hint';
    out.textContent = 'Thinking…';
  }
  if (btn) btn.disabled = true;
  let res: any;
  try {
    res = await window.hub.explainDataset(currentProjectId, expId);
  } catch (_) {
    res = { ok: false, error: 'Failed to explain the dataset.' };
  }
  if (btn) btn.disabled = false;
  if (!out) return;
  if (res && res.ok) {
    out.className = 'ds-explain-out';
    out.textContent = String(res.text || '');
  } else if (res && res.notReady) {
    out.className = 'ds-explain-out ds-explain-hint';
    out.textContent = 'Connect a model in Execution settings to explain datasets.';
  } else {
    out.className = 'ds-explain-out ds-explain-hint';
    out.textContent = (res && res.error) || 'Could not explain the dataset.';
  }
}

async function handleDeleteDataset(id: string): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm('Delete this dataset? This cannot be undone.')) return;
  try {
    await window.hub.deleteDataset(currentProjectId, id);
  } catch (_) {
    /* ignore */
  }
  await refreshDatasetList();
}

// ── Boot wiring (once) ───────────────────────────────────────────────────────
function initDatasets(): void {
  const importBtn = dsEl('ds-import-btn');
  if (importBtn) importBtn.addEventListener('click', () => handleImportFile());

  const pasteToggle = dsEl('ds-paste-toggle');
  if (pasteToggle) {
    pasteToggle.addEventListener('click', () => {
      const wrap = dsEl('ds-paste-wrap');
      if (wrap) wrap.hidden = !wrap.hidden;
    });
  }

  const parseBtn = dsEl('ds-paste-parse');
  if (parseBtn) parseBtn.addEventListener('click', () => handleParsePaste());

  const saveBtn = dsEl('ds-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => handleSaveDataset());

  const sheetSel = dsEl('ds-sheet-select');
  if (sheetSel) sheetSel.addEventListener('change', () => handleSheetChange());

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
      if (expSearchTimer) {
        window.clearTimeout(expSearchTimer);
        expSearchTimer = 0;
      }
      dsShow('ds-explorer', false);
    });
  }
}
