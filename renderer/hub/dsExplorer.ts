// Opening a dataset: its identity header, the capture strip, the stats and
// quality panes, and the two whole-dataset actions (explain, delete).
//
// The grid that fills the Data tab is dsGrid.ts.
//
// Split verbatim out of datasets.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

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
  renderExplorerIdent(ds);

  // Week 13 — capture provenance strip (thumbnail + view-original + recapture).
  renderCapStrip(ds);

  dsShow('ds-explorer', true);
  resetPreparePanel(); // prepare.ts — collapse editor/suggest/menu, render steps + combine
  await refreshExplorerPage(); // awaited so the grid never paints blank first
  await loadExplorerStats();
}

/**
 * The open dataset's identity line: source badge, "Data as of …", and Refresh.
 *
 * The same three facts its row in the list shows, from the same helpers
 * (`DS_SOURCE_LABELS`, `dsFreshnessText`, `handleRefreshDataset`) — the explorer
 * is a view of that row, so it must not derive them a second way. Refresh
 * appears only where there is something to re-fetch, exactly as in the list, and
 * repaints the row before reopening the explorer so the header it leaves behind
 * is the stored one.
 */
function renderExplorerIdent(d: any): void {
  const kind = d && d.sourceKind ? String(d.sourceKind) : '';
  const badge = dsEl('ds-explorer-source');
  if (badge) {
    badge.textContent = DS_SOURCE_LABELS[kind] || kind;
    badge.hidden = !badge.textContent;
  }

  const fresh = dsEl('ds-explorer-fresh');
  if (fresh) {
    fresh.textContent = dsFreshnessText(d);
    fresh.title = d && d.originKind ? '' : DS_NOT_REFRESHABLE_HINT;
  }

  // The same picker the list row carries, beside the same freshness line.
  const host = dsEl('ds-explorer-auto');
  if (host) {
    host.innerHTML = '';
    const picker = dsAutoRefreshPicker(d, () => { void openSavedDataset(String((d && d.id) || expId || '')); });
    if (picker) host.appendChild(picker);
    host.hidden = !picker;
  }

  const btn = dsEl('ds-explorer-refresh') as HTMLButtonElement | null;
  if (btn) {
    btn.hidden = !(d && d.originKind);
    btn.onclick = async (): Promise<void> => {
      const id = String((d && d.id) || expId || '');
      if (!id) return;
      await handleRefreshDataset(id, btn, null);
      // The row repainted; reopen so the grid, the stats and this header all
      // describe the data that was just fetched rather than the previous one.
      await openSavedDataset(id);
    };
  }
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

