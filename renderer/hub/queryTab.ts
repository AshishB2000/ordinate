// The Data page's Query tab — SQL over THIS project's datasets.
//
// Classic global-scope renderer <script>: no import/export. The tab strip
// (captureList.ts) calls `qtOpen()` when the tab is selected; everything is
// wired on that first open, so a session that never opens it pays nothing.
//
// Three panes, the connection workbench's own: the datasets on the left (each
// expandable to its DECLARED columns, with the dataset grid's `.ds-type-*`
// badges), the editor (queryEditor.ts) over the results, and the results grid
// built by `cwBuildTable` — the same markup the dataset grid uses, so the rows
// checked here look exactly like the dataset a Save makes.
//
// Main does all of it: running, the read-only gate, binding `[[params]]`, the
// 500-row preview. Nothing here computes a figure or decides validity.
//
// Save as dataset goes through the ORDINARY path, like the workbench's: main
// runs the statement at the dataset cap and returns the table plus the `sql`
// origin, and the COMPOSER opens with it — the user names it and can add steps
// like any other import.

interface QtColumn { name: string; type: string }
interface QtDataset {
  id: string;
  name: string;
  alias: string | null;
  slug: string;
  rowCount: number;
  queryable: boolean;
  columns: QtColumn[];
}

let qtInited = false;
let qtProjectId = '';
let qtSchema: QtDataset[] = [];
let qtBusy = false;
let qtSeq = 0;
let qtHasResult = false;
const qtOpenNodes = new Set<string>();

function qtEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function qtFold(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The datasets `sql` names, first reference first — the client's approximation of main's. */
function qtReferencedIds(sql: string): string[] {
  const byKey = new Map<string, string>();
  for (const d of qtSchema) {
    if (d.alias) byKey.set(qtFold(d.alias), d.id);
    byKey.set(d.slug, d.id);
  }
  const out: string[] = [];
  for (const n of qeScan(sql).names) {
    const id = byKey.get(qtFold(n));
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// ── Open / schema ────────────────────────────────────────────────────────────

/** Called by the tab strip on every select. */
async function qtOpen(): Promise<void> {
  if (!qtInited) {
    qtInited = true;
    initQueryEditor();
    qtEl('qt-run')?.addEventListener('click', () => { void qtRun(); });
    qtEl('qt-explain')?.addEventListener('click', () => { void qtExplain(); });
    qtEl('qt-save')?.addEventListener('click', () => { void qtSave(); });
    qtEl('qt-tree-search')?.addEventListener('input', () => qtRenderTree());
  }
  await qtLoadSchema();
}

async function qtLoadSchema(): Promise<void> {
  const pid = currentProjectId || '';
  if (pid !== qtProjectId) {
    // Another project: its SQL, parameters and results mean nothing here.
    qtProjectId = pid;
    qeSetSql('');
    qtParamState.clear();
    qtOpenNodes.clear();
    qtClearResults();
    qtOnSqlChanged();
  }
  let res: any = null;
  if (pid) {
    try { res = await window.hub.sqlSchema(pid); } catch (_) { res = null; }
  }
  if (pid !== (currentProjectId || '')) return; // switched while loading
  qtSchema = res && res.ok && Array.isArray(res.datasets) ? res.datasets : [];

  const empty = qtEl('qt-empty-host');
  const body = qtEl('qt-body');
  if (!qtSchema.length) {
    if (empty && !empty.firstChild) {
      empty.appendChild(makeEmptyState({
        variant: 'query',
        iconName: 'code',
        title: t('queryTab.nothing_to_query_yet'),
        line: t('queryTab.every_dataset_in_this_project_becomes'),
        actionLabel: t('queryTab.import_a_file'),
        onAction: () => { if (typeof handleImportFile === 'function') void handleImportFile(); },
        ghostLabel: t('common.connect_data'),
        onGhost: () => { if (typeof openConnPanel === 'function') openConnPanel(''); },
      }));
    }
    if (empty) empty.hidden = false;
    if (body) body.hidden = true;
    return;
  }
  if (empty) empty.hidden = true;
  if (body) body.hidden = false;
  const count = qtEl('qt-tree-count');
  if (count) count.textContent = String(qtSchema.length);
  qtRenderTree();
  qtApplyStarter();
}

/**
 * The empty editor's placeholder, from the first dataset's REAL columns:
 * `select region, sum(revenue) as revenue from retail_orders group by 1 order by 2 desc`.
 */
function qtStarter(): string {
  const d = qtSchema.find((x) => x.queryable && x.columns.length) || qtSchema.find((x) => x.queryable);
  if (!d) return t('queryTab.select_from');
  // Group by a label, not an id: `order_id` is a text column nobody sums by.
  const texts = d.columns.filter((c) => c.type === 'text');
  const text = texts.find((c) => !/(^|_)(id|uuid|key|code)$|id$/i.test(c.name)) || texts[0];
  const num = d.columns.find((c) => c.type === 'number');
  if (text && num) {
    return t('queryTab.select_sum_as_from_group_by', { name: qeIdent(text.name), name2: qeIdent(num.name), slug: d.slug });
  }
  if (text) return t('queryTab.select_count_as_rows_from_group', { name: qeIdent(text.name), slug: d.slug });
  return t('common.select_from_limit_100', { slug: d.slug });
}

function qtApplyStarter(): void {
  const input = qeInput();
  if (input) input.placeholder = qtStarter();
}

// ── The dataset tree ─────────────────────────────────────────────────────────

function qtRenderTree(): void {
  const host = qtEl('qt-tree');
  const msg = qtEl('qt-tree-msg');
  if (!host) return;
  host.innerHTML = '';
  const search = qtEl('qt-tree-search') as HTMLInputElement | null;
  const q = (search && search.value ? search.value : '').trim().toLowerCase();
  let shown = 0;
  for (const d of qtSchema) {
    const hitName = !q || d.name.toLowerCase().includes(q) || d.slug.includes(q);
    const cols = hitName ? d.columns : d.columns.filter((c) => c.name.toLowerCase().includes(q));
    if (!hitName && !cols.length) continue;
    host.appendChild(qtDatasetNode(d, cols, !!q && !hitName));
    shown += 1;
  }
  if (msg) {
    msg.textContent = shown ? '' : t('queryTab.no_dataset_or_column_matches_that');
    msg.hidden = shown > 0;
  }
}

function qtDrag(el: HTMLElement, text: string): void {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt) { dt.setData('text/plain', text); dt.effectAllowed = 'copy'; }
  });
}

function qtDatasetNode(d: QtDataset, cols: QtColumn[], forceOpen: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'cw-node qt-node';
  const open = forceOpen || qtOpenNodes.has(d.id);
  wrap.classList.toggle('is-open', open);

  const row = document.createElement('div');
  row.className = 'cw-row cw-row-table qt-row-ds' + (d.queryable ? '' : ' is-off');
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-expanded', String(open));
  row.tabIndex = 0;
  row.title = d.queryable
    ? t('queryTab.insert', { slug: d.slug, p1: (d.alias && qtFold(d.alias) !== d.slug ? t('queryTab.or_query_it_as', { alias: qeIdent(d.alias) }) : '') })
    : t('queryTab.saved_before_datasets_were_stored_as');

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'cw-caret';
  caret.setAttribute('aria-label', t('queryTab.columns_of', { p0: !!(open), name: d.name }));
  caret.appendChild(icon('chevron-right', 14));
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    if (qtOpenNodes.has(d.id)) qtOpenNodes.delete(d.id); else qtOpenNodes.add(d.id);
    qtRenderTree();
  });
  row.appendChild(caret);

  const text = document.createElement('span');
  text.className = 'qt-ds-text';
  const name = document.createElement('span');
  name.className = 'cw-row-name qt-ds-name';
  name.textContent = d.name;
  const slug = document.createElement('span');
  slug.className = 'qt-ds-slug';
  slug.textContent = d.queryable ? d.slug : t('queryTab.not_queryable_re_import');
  text.append(name, slug);
  row.appendChild(text);

  const rows = document.createElement('span');
  rows.className = 'cw-num';
  rows.textContent = d.rowCount.toLocaleString('en-US');
  rows.title = d.rowCount.toLocaleString('en-US') + ' rows';
  row.appendChild(rows);

  if (d.queryable) {
    qtDrag(row, d.slug);
    row.addEventListener('click', () => qeInsert(d.slug));
  }
  row.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if ((k === 'Enter' || k === ' ') && d.queryable) { e.preventDefault(); qeInsert(d.slug); }
    else if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); caret.click(); }
  });
  wrap.appendChild(row);

  if (open) {
    const list = document.createElement('div');
    list.className = 'cw-cols-list';
    for (const c of cols) list.appendChild(qtColumnNode(c));
    wrap.appendChild(list);
  }
  return wrap;
}

function qtColumnNode(c: QtColumn): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cw-row cw-row-col';
  row.setAttribute('role', 'treeitem');
  row.tabIndex = 0;
  const ident = qeIdent(c.name);
  row.title = t('queryTab.insert_2', { ident });
  const name = document.createElement('span');
  name.className = 'cw-row-name';
  name.textContent = c.name;
  const badge = document.createElement('span');
  badge.className = 'ds-type ds-type-' + (c.type === 'number' || c.type === 'date' ? c.type : 'text');
  badge.textContent = c.type;
  row.append(name, badge);
  qtDrag(row, ident);
  row.addEventListener('click', () => qeInsert(ident));
  row.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter' || k === ' ') { e.preventDefault(); qeInsert(ident); }
  });
  return row;
}

// ── Run / Explain / Save ─────────────────────────────────────────────────────

function qtSetBusy(on: boolean, label: string): void {
  qtBusy = on;
  for (const id of ['qt-run', 'qt-explain']) {
    const b = qtEl(id) as HTMLButtonElement | null;
    if (b) b.disabled = on;
  }
  const status = qtEl('qt-status');
  if (status && on) { status.textContent = label; status.classList.remove('is-error'); }
}

function qtShowError(heading: string, message: string): void {
  const box = qtEl('qt-error');
  const h = qtEl('qt-error-h');
  const m = qtEl('qt-error-msg');
  if (h) h.textContent = heading;
  if (m) m.textContent = message;
  if (box) box.hidden = false;
  const status = qtEl('qt-status');
  if (status) { status.textContent = t('queryTab.error'); status.classList.add('is-error'); }
  const idle = qtEl('qt-idle');
  if (idle) idle.hidden = true;
}

function qtClearResults(): void {
  qtHasResult = false;
  const ids: Array<[string, boolean]> = [['qt-error', true], ['qt-cols', true], ['qt-grid', true], ['qt-idle', false]];
  for (const [id, hide] of ids) {
    const el = qtEl(id);
    if (el) el.hidden = hide;
  }
  const grid = qtEl('qt-grid');
  if (grid) grid.innerHTML = '';
  for (const id of ['qt-status', 'qt-note']) {
    const el = qtEl(id);
    if (el) { el.textContent = ''; el.classList.remove('is-error'); }
  }
}

/** Prepare a request: the SQL (the starter when the editor is empty) and its parameters. */
function qtRequest(): { sql: string; params: any[] } | null {
  let sql = qeGetSql();
  if (!sql.trim()) {
    const starter = qtStarter();
    if (!qtSchema.some((d) => d.queryable)) {
      qtClearResults();
      qtShowError(t('queryTab.nothing_to_run'), t('common.write_a_query_first'));
      return null;
    }
    qeSetSql(starter);
    qtRenderParams();
    sql = starter;
  }
  const { params, error } = qtCollectParams(sql);
  if (error) {
    qtClearResults();
    qtShowError(t('queryTab.a_parameter_needs_a_value'), error);
    return null;
  }
  return { sql, params };
}

async function qtRun(): Promise<void> {
  if (qtBusy || !currentProjectId) return;
  const req = qtRequest();
  if (!req) return;
  const seq = ++qtSeq;
  qtSetBusy(true, t('common.running'));
  let res: any;
  try {
    res = await window.hub.sqlRun(currentProjectId, req.sql, req.params);
  } catch (_) {
    res = { ok: false, error: t('queryTab.the_query_could_not_be_sent') };
  }
  qtSetBusy(false, '');
  if (seq !== qtSeq) return;
  qtClearResults();
  if (!res || res.ok === false) {
    qtShowError(t('common.the_query_did_not_run'), (res && res.error) || t('queryTab.the_query_failed'));
    return;
  }
  const columns: any[] = Array.isArray(res.columns) ? res.columns : [];
  const rows: any[] = Array.isArray(res.rows) ? res.rows : [];
  const grid = qtEl('qt-grid');
  if (grid) {
    grid.appendChild(qtFormatNumbers(cwBuildTable(columns, rows), columns));
    grid.hidden = false;
  }
  const idle = qtEl('qt-idle');
  if (idle) idle.hidden = true;
  const status = qtEl('qt-status');
  if (status) {
    const n = Number(res.rowCount) || 0;
    status.textContent = t('queryTab.ms', { p0: (res.truncated ? t('common.rows_2', { p0: n.toLocaleString('en-US') }) : `${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'}`), p1: Number(res.elapsedMs) || 0 });
  }
  const note = qtEl('qt-note');
  if (note) {
    note.textContent = `${columns.length} ${columns.length === 1 ? 'column' : 'columns'}`
      + (res.truncated ? t('queryTab.showing_the_first_500_save_as') : '');
  }
  qtHasResult = true;
  const save = qtEl('qt-save') as HTMLButtonElement | null;
  if (save) save.disabled = columns.length === 0;
}

async function qtExplain(): Promise<void> {
  if (qtBusy || !currentProjectId) return;
  const req = qtRequest();
  if (!req) return;
  const seq = ++qtSeq;
  qtSetBusy(true, t('common.checking'));
  let res: any;
  try {
    res = await window.hub.sqlExplain(currentProjectId, req.sql, req.params);
  } catch (_) {
    res = { ok: false, error: t('queryTab.the_query_could_not_be_checked') };
  }
  qtSetBusy(false, '');
  if (seq !== qtSeq) return;
  const keepGrid = qtHasResult;
  qtEl('qt-error')?.setAttribute('hidden', '');
  if (!res || res.ok === false) {
    qtShowError(t('queryTab.the_query_is_not_valid'), (res && res.error) || t('queryTab.the_query_could_not_be_checked'));
    return;
  }
  const cols = qtEl('qt-cols');
  if (cols) {
    cols.innerHTML = '';
    for (const c of Array.isArray(res.columns) ? res.columns : []) {
      const chip = document.createElement('span');
      chip.className = 'cw-col-chip';
      const n = document.createElement('span');
      n.className = 'cw-col-chip-name';
      n.textContent = String(c.name);
      const t = document.createElement('span');
      t.className = 'cw-col-chip-type';
      t.textContent = String(c.sqlType) + (c.kind && c.kind !== 'text' ? ' → ' + c.kind : '');
      chip.append(n, t);
      cols.appendChild(chip);
    }
    cols.hidden = false;
  }
  const status = qtEl('qt-status');
  if (status) {
    const n = Array.isArray(res.columns) ? res.columns.length : 0;
    status.textContent = t('queryTab.valid_returns', { n });
    status.classList.remove('is-error');
  }
  // No rows yet: the chips sit above the idle note rather than in a blank card.
  const idle = qtEl('qt-idle');
  if (idle) idle.hidden = keepGrid;
}

/** Run at the dataset cap in main, then hand the table + origin to the composer. */
async function qtSave(): Promise<void> {
  if (qtBusy || !currentProjectId || !qtHasResult) return;
  const req = qtRequest();
  if (!req) return;
  const statusEl = qtEl('qt-status');
  const prevStatus = statusEl ? statusEl.textContent : '';
  const btn = qtEl('qt-save') as HTMLButtonElement | null;
  const label = btn ? btn.querySelector('span') : null;
  qtSetBusy(true, t('queryTab.fetching_every_row'));
  if (btn) btn.disabled = true;
  if (label) label.textContent = t('common.fetching_rows');
  let res: any;
  try {
    res = await window.hub.sqlPrepareSave(currentProjectId, req.sql, req.params);
  } catch (_) {
    res = { ok: false, error: t('queryTab.the_full_result_could_not_be') };
  }
  qtSetBusy(false, '');
  // The preview underneath is unchanged — put its summary back, not "Fetching…".
  if (statusEl) statusEl.textContent = prevStatus;
  if (label) label.textContent = t('common.save_as_dataset');
  if (btn) btn.disabled = false;
  if (res && res.canceled) return; // cancelled from the Jobs popover
  if (!res || res.ok === false) {
    qtShowError(t('queryTab.the_result_was_not_saved'), (res && res.error) || t('queryTab.the_full_result_could_not_be'));
    return;
  }
  const columns: any[] = Array.isArray(res.columns) ? res.columns : [];
  const rows: any[] = Array.isArray(res.rows) ? res.rows : [];
  const firstDep = qtSchema.find((d) => res.origin && Array.isArray(res.origin.deps) && d.id === res.origin.deps[0]);
  const name = firstDep ? `${firstDep.name} query` : t('common.query_result');
  if (typeof selectSection === 'function') selectSection('datasets');
  // The composer closes back onto the Datasets tab, where the new dataset is.
  clSelectTab('datasets');
  openComposer(
    // The full result is staged in main (sql:prepareSave); `rows` is the slice.
    {
      label: name,
      rows: typeof res.rowCount === 'number' ? res.rowCount : rows.length,
      kind: 'sql',
      ref: { inline: { name, columns, rows, stagedId: res.stagedId } },
      columns: columns.map((c: any) => String(c.name)),
    },
    { name, sourceKind: 'sql', origin: res.origin },
  );
}

/** "View query" on a SQL dataset's page: its statement and parameters, run. */
function qtOpenWithSql(sql: string, params?: any[]): void {
  const close = qtEl('ds-explorer-close') as HTMLButtonElement | null;
  const explorer = qtEl('ds-explorer');
  if (close && explorer && !explorer.hidden) close.click();
  if (typeof selectSection === 'function') selectSection('datasets');
  clSelectTab('query');
  // After clSelectTab: its qtOpen resets the editor when the project changed.
  void (async (): Promise<void> => {
    await qtLoadSchema();
    for (const p of Array.isArray(params) ? params : []) {
      if (!p || typeof p.name !== 'string') continue;
      const value = Array.isArray(p.value) ? p.value.join(', ') : p.value == null ? '' : String(p.value);
      qtParamState.set(p.name, { kind: String(p.kind || 'text'), value });
    }
    qeSetSql(sql);
    const list = qtEl('qt-params-list');
    if (list) list.dataset.names = '';
    qtRenderParams();
    await qtRun();
  })();
}

/**
 * A result's NUMBER columns as a reader wants them — grouped, at most two
 * decimals, right-aligned in tabular figures — rather than as the raw double
 * (`1565150.4600000004`). Display only: the dataset a Save makes stores the
 * exact values.
 */
function qtFormatNumbers(table: HTMLElement, columns: any[]): HTMLElement {
  const numeric = columns.map((c: any) => !!c && c.type === 'number');
  if (!numeric.some(Boolean)) return table;
  table.querySelectorAll('thead th').forEach((th, i) => { if (numeric[i]) th.classList.add('qt-num'); });
  table.querySelectorAll('tbody tr').forEach((tr) => {
    tr.querySelectorAll('td').forEach((td, i) => {
      if (!numeric[i]) return;
      td.classList.add('qt-num');
      const n = Number(td.textContent);
      if (td.textContent !== '' && Number.isFinite(n)) td.textContent = OrdFormat.formatNumber(n, { maxDecimals: 2 });
    });
  });
  return table;
}

