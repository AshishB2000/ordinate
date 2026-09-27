// The explore grid: sorting, paging, painting the table, and the column menu
// (show/hide, rename, retype).
//
// Paging and sorting run SERVER-SIDE via src/datasetPage.ts — the renderer
// never holds the table. That is what makes this identical on a million rows
// and a hundred.
//
// Split verbatim out of datasets.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

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
  return OrdFormat.formatNumber(n, { maxDecimals: 2 });
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * ONE hint under a header, not a summary.
 *
 * This used to print the whole `ColumnSummary` — `725 distinct · top 2024-12-06
 * ×24 · n=5000` — under EVERY column, which is three facts nobody asked for
 * wrapped across a header row, repeated across forty columns. The profile panel
 * (dsProfile.ts) is where those facts belong, and it opens on a click of the
 * name; what stays here is the single number that tells you whether opening it
 * is worth it.
 *
 * A number column has no `distinct` in its summary (it carries min/max/mean
 * instead), so it shows its range — the equivalent one-glance answer, and one
 * the panel does not have to be opened to learn.
 */
function summaryChipText(sum: any): string {
  if (!sum) return '';
  if (sum.type === 'number') {
    if (typeof sum.min === 'number' && typeof sum.max === 'number') {
      return fmtNum(sum.min) + '–' + fmtNum(sum.max);
    }
    return '';
  }
  return typeof sum.distinct === 'number' ? sum.distinct.toLocaleString() + ' distinct' : '';
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
  th.className = 'ds-th' + (dsProfileCol === c ? ' is-profiled' : '');
  const inner = document.createElement('div');
  inner.className = 'ds-th-inner';

  const row = document.createElement('div');
  row.className = 'ds-th-row';

  // TWO controls where there was one. The NAME opens the column profile and the
  // ARROW sorts — they were a single button, so there was no way to ask "what
  // is in this column?" without also reordering the grid you were reading.
  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'ds-th-name';
  nameBtn.textContent = col.name;
  nameBtn.title = ctColumnTitle(expId, col.name, 'Profile this column', paintExplorerTable); // + its catalog description
  nameBtn.setAttribute('aria-expanded', String(dsProfileCol === c));
  nameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void dsOpenProfile(c);
  });
  row.appendChild(nameBtn);

  const sortBtn = document.createElement('button');
  sortBtn.type = 'button';
  sortBtn.className = 'ds-th-sort';
  sortBtn.setAttribute('aria-label', 'Sort by ' + (col.name || 'this column'));
  const arrow = document.createElement('span');
  arrow.className = 'ds-th-arrow';
  // An unsorted column keeps a dimmed up-chevron, so the control is discoverable
  // at all — an empty span was invisible until you happened to click the right
  // pixels.
  setIcon(arrow, expSortCol === c && expSortDir !== 1 ? 'chevron-down' : 'chevron-up');
  if (expSortCol !== c) arrow.classList.add('is-idle');
  sortBtn.appendChild(arrow);
  sortBtn.addEventListener('click', () => toggleSort(c));
  row.appendChild(sortBtn);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'ds-th-edit';
  iconOnly(edit, 'pencil', 'Rename column');
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
  // A skeleton only on the FIRST paint of this grid. Sort, search and paging
  // come back off the resident path in ~100 ms, so shimmering the table on
  // every keystroke would be a flicker, not feedback — but the first fetch
  // after opening a dataset is a blank panel otherwise. skelTable holds the
  // shape (and sets aria-busy); paintExplorerTable clears both.
  const scrollHost = dsEl('ds-explorer-scroll');
  if (scrollHost && !scrollHost.querySelector('table')) {
    skelTable(scrollHost, 12, expColumns.length - expHidden.size);
  }
  const seq = ++expPageSeq;
  const wantId = expId;
  const req: DatasetPageReq = {
    // The block holding the first row in view — the virtual grid asks for the
    // others as it scrolls to them.
    offset: Math.floor(expOffset / DS_PAGE_ROWS) * DS_PAGE_ROWS,
    limit: DS_PAGE_ROWS,
    search: expSearch.trim(),
    sortColumn: expSortColumnName(),
    sortDir: expSortDir === 1 ? 'asc' : 'desc',
  };

  let res: any = null;
  try {
    const page = datasetPageBridge();
    // "Show failing rows" (dsRules.ts): the same window, filtered in main by the rule.
    if (dqGridRule && currentProjectId) res = await window.hub.qualityFailingRows(currentProjectId, wantId, dqGridRule.id, req);
    else if (page && currentProjectId) res = await page(currentProjectId, wantId, req);
  } catch (_) {
    res = null; // dead bridge — fall through to the client-side path
  }
  if (seq !== expPageSeq || wantId !== expId) return; // a newer request already won

  // Whatever came back replaces every row fetched before: the query, or the
  // data under it (a prepare step), changed. dsVirtual.ts refetches the rest
  // of the scroll range block by block as the viewport reaches it.
  dsvReset();
  if (res && res.ok === true) {
    // An EMPTY page is a real answer (search matched nothing, or you paged past
    // the end) — only `ok === true` is trusted, never row-count truthiness.
    expPageRows = Array.isArray(res.rows) ? res.rows : [];
    expTotal = typeof res.total === 'number' ? res.total : expPageRows.length;
    expOffset = typeof res.offset === 'number' ? res.offset : expOffset;
    dsvPut(expOffset, expPageRows);
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
    dsvPutAll(all);
  }
  // A new order or a new search starts at the top (toggleSort, the search box
  // and the rule filter reset expOffset); a data refresh keeps your place.
  if (expOffset === 0 && scrollHost) scrollHost.scrollTop = 0;
  paintExplorerTable();
  dqPaintBanner();
}

// Public entry for "the underlying data or its order changed" — used by
// prepare.ts after a pipeline step, and by sort/search/paging here. Painting is
// left to the fetch so a stale window is never shown between the two.
function renderExplorerTable(): void {
  void refreshExplorerPage();
}

// Draw the window currently in hand. NO filtering, NO sorting, NO IPC — those
// happened in main. Cheap enough to call for a column show/hide or a summary
// chip arriving.
function paintExplorerTable(): void {
  const scroll = dsEl('ds-explorer-scroll');
  if (!scroll) return;
  // A dropped column would leave the panel pointing at an index that no longer
  // exists (or, worse, at a different column that slid into it).
  if (dsProfileCol >= expColumns.length) dsCloseProfile();
  skelClear(scroll); // drops the loading skeleton AND the aria-busy with it
  // The table is VIRTUAL (dsVirtual.ts): only the rows in view exist, between
  // two spacer rows that hold the scroll height. Rebuilt IN PLACE — replacing
  // the head and then the body — so the scroll position survives a repaint.
  let table = scroll.querySelector('table.ds-table') as HTMLTableElement | null;
  if (!table) {
    scroll.innerHTML = '';
    table = document.createElement('table');
    table.className = 'ds-table is-virtual';
    table.setAttribute('role', 'grid');
    scroll.appendChild(table);
  }
  table.setAttribute('aria-rowcount', String(expTotal + 1));
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  expColumns.forEach((col, c) => {
    if (expHidden.has(c)) return;
    htr.appendChild(makeExplorerTh(col, c));
  });
  thead.appendChild(htr);
  if (table.tHead) table.replaceChild(thead, table.tHead);
  else table.insertBefore(thead, table.firstChild);
  dsvWire(scroll);
  dsvPaintBody();
}

// The row count, and which rows are on screen. Scrolling IS the paging now —
// the grid used to draw 500 rows behind Prev/Next buttons, and the rows past
// them were a click away each; now every one is a scroll away.
function paintExplorerPager(): void {
  const note = dsEl('ds-explorer-note');
  if (!note) return;
  note.hidden = false;
  if (expTotal === 0) {
    note.textContent = '0 rows';
    return;
  }
  const first = expOffset + 1;
  const last = Math.min(expOffset + expPageRows.length, expTotal);
  note.textContent = expTotal > expPageRows.length
    ? 'Rows ' + first.toLocaleString() + '–' + last.toLocaleString() + ' of ' + expTotal.toLocaleString()
    : expTotal.toLocaleString() + (expTotal === 1 ? ' row' : ' rows');
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

