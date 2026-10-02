'use strict';

// Search inside the data — ⌘K's "Data" group (and so the top bar's search,
// which IS the palette's other door). Typing "California", "INV-2041" or
// "Chairs" finds the value in every dataset's text columns: main answers from
// each dataset's value index, or a bounded scan, off the stored Parquet
// (src/ipc/dataSearch.ts). Nothing is computed here; the row counts are main's.
//
// A hit row reads `value · dataset / column · N rows`, and does three things —
// as buttons on the row, and as the → list for the keyboard:
//   Open filtered   the dataset's grid, filtered to column = value (the page's
//                   own `filters` request, so the grid's total IS the count)
//   Filter          the open dashboard, through the typed filter's apply
//                   (filterTypeApply.ts) — offered only when the dashboard
//                   reads that dataset
//   Profile         the column profile panel (dsProfile.ts)
//
// Classic global-scope renderer <script>: no import/export. Loads after
// filterTypeApply.js and before hub.js.

/** The grid's column = value filter, set by "Open filtered" and cleared by its banner or the next dataset. */
let dsrGridFilter: { column: string; value: string } | null = null;

// ── ⌘K ───────────────────────────────────────────────────────────────────────

/** The Data group for `q`, or null (too short, a #tag, a dead bridge, or nothing found). */
async function dsrPaletteGroup(q: string): Promise<CpGroup | null> {
  const term = q.trim();
  if (term.length < 2 || term.charAt(0) === '#' || !window.hubDataSearch) return null;
  const dashId = typeof ftDashboardOpen === 'function' && ftDashboardOpen() ? String(dashCurrent.id) : '';
  let res: any = null;
  try { res = await window.hubDataSearch.query(currentProjectId || '', term, dashId); } catch (_) { res = null; }
  if (!res || !res.ok || !Array.isArray(res.hits) || !res.hits.length) return null;
  const partial = Array.isArray(res.partial) && res.partial.length
    ? t('dataSearch.partly_searched', { partialCount: res.partial.length }) : '';
  return { label: t('dataSearch.data', { partial }), rows: res.hits.map((h: any) => dsrHitRow(h, !currentProjectId)) };
}

/** While the values are being searched: a quiet line under what is already painted. */
function dsrPaintPending(): void {
  const box = document.getElementById('cp-results');
  if (!box || box.querySelector('.dsr-pending')) return;
  // "No matches" is not true yet — the data has not answered.
  const none = box.querySelector('.cp-none');
  if (none) none.remove();
  const label = document.createElement('div');
  label.className = 'cp-group dsr-pending';
  label.textContent = t('common.data');
  const line = document.createElement('div');
  line.className = 'dsr-pending-line dsr-pending';
  line.appendChild(icon('loader', 14));
  line.appendChild(document.createTextNode(t('dataSearch.searching_values_inside_your_datasets')));
  box.append(label, line);
}

function dsrRowsLabel(n: number): string {
  return `${Number(n || 0).toLocaleString()} ${n === 1 ? 'row' : 'rows'}`;
}

function dsrHitRow(h: any, showProject: boolean): CpRow {
  const where = `${h.datasetName} / ${h.column}` + (showProject && h.projectName ? ` · ${h.projectName}` : '');
  const actions: CpRow[] = [{
    title: t('dataSearch.open_filtered_to_it'),
    meta: t('dataSearch.where_is', { datasetName: h.datasetName, column: h.column, value: h.value }),
    icon: 'table',
    run: () => { paletteClose(); void dsrOpenFiltered(h); },
  }];
  if (h.onDashboard && typeof ftDashboardOpen === 'function' && ftDashboardOpen()) {
    actions.push({
      title: t('dataSearch.filter_this_dashboard'),
      meta: `${dashCurrent.name || t('paletteRows.the_open_dashboard')} · ${h.column} = ${h.value}`,
      icon: 'filter',
      run: () => { paletteClose(); dsrFilterDashboard(h); },
    });
  }
  actions.push({
    title: t('dataSearch.profile_the_column'),
    meta: `${h.column} in ${h.datasetName}`,
    icon: 'chart-bar',
    run: () => { paletteClose(); void dsrProfile(h); },
  });
  return {
    title: String(h.value),
    meta: where,
    icon: 'type-text',
    count: dsrRowsLabel(h.rows),
    actions,
    run: actions[0].run,
  };
}

// ── The three actions ────────────────────────────────────────────────────────

/** Open the dataset — in its own project, which ⌘K on Home may not be in — on its Data tab. */
async function dsrOpenDataset(h: any): Promise<boolean> {
  if (h.projectId && h.projectId !== currentProjectId) await openWorkspace(String(h.projectId));
  selectSection('datasets');
  await openSavedDataset(String(h.datasetId));
  if (expId !== h.datasetId) return false;
  if (typeof dxSelectTab === 'function') dxSelectTab('ds-tab-data');
  return true;
}

async function dsrOpenFiltered(h: any): Promise<void> {
  if (!(await dsrOpenDataset(h))) return;
  dsrGridFilter = { column: String(h.column), value: String(h.value) };
  expOffset = 0;
  await refreshExplorerPage();
  dsrPaintBanner();
}

function dsrFilterDashboard(h: any): void {
  const column = String(h.column);
  const value = String(h.value);
  ftApplyAndTell([{
    column, kind: 'value', negated: false, match: 'exact', label: `${column} = ${value}`,
    steps: [{ type: 'filter', column, op: '=', value }],
  }]);
}

async function dsrProfile(h: any): Promise<void> {
  if (!(await dsrOpenDataset(h))) return;
  const i = expColumns.findIndex((c) => c.name === h.column);
  if (i < 0) { showToast(t('dataSearch.is_no_longer_in', { column: h.column, datasetName: h.datasetName })); return; }
  if (dsProfileCol !== i) await dsOpenProfile(i);
}

// ── The grid filter ──────────────────────────────────────────────────────────

/** The `filters` of a grid page request (dsGrid.ts / dsVirtual.ts), or undefined. */
function dsrGridSteps(): any[] | undefined {
  return dsrGridFilter ? [{ type: 'filter', column: dsrGridFilter.column, op: '=', value: dsrGridFilter.value }] : undefined;
}

/** Another dataset is opening: the filter was for the last one. */
function dsrResetGridFilter(): void {
  dsrGridFilter = null;
  dsrPaintBanner();
}

/** "Showing 1,204 rows where State is California" above the grid, with Clear. */
function dsrPaintBanner(): void {
  let banner = document.getElementById('dsr-banner');
  if (!banner) {
    const anchor = document.getElementById('dq-banner');
    if (!anchor || !anchor.parentElement) return;
    banner = document.createElement('div');
    banner.id = 'dsr-banner';
    banner.className = 'dq-banner dsr-banner';
    banner.setAttribute('role', 'status');
    anchor.parentElement.insertBefore(banner, anchor);
  }
  banner.textContent = '';
  banner.hidden = !dsrGridFilter;
  if (!dsrGridFilter) return;
  const text = document.createElement('span');
  text.className = 'dq-banner-text';
  const col = document.createElement('strong');
  col.textContent = dsrGridFilter.column;
  const val = document.createElement('strong');
  val.textContent = dsrGridFilter.value;
  text.append(t('dataSearch.showing_where', { expTotal: dsrRowsLabel(expTotal) }), col, t('dataSearch.is'), val);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'dq-banner-clear';
  iconLabel(clear, 'x', t('common.clear'));
  clear.addEventListener('click', () => {
    dsrGridFilter = null;
    expOffset = 0;
    dsrPaintBanner();
    renderExplorerTable();
  });
  banner.append(icon('search', 14), text, clear);
}
