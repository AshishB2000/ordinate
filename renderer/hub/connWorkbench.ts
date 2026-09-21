// The connection workbench: three panes over ONE saved connection — the schema
// tree, the results grid under the editor, and the details rail.
//
// Classic global-scope renderer <script>: no import/export. State lives in
// connections.ts (the `cw*` block); the editor inside the centre pane is
// connEditor.ts, which loads after this file and calls back into it.
//
// ── What each pane is for, and what it must never do ────────────────────────
//
// LEFT is a browser, not a query. It shows what `listTables` already returned
// and asks `connection:describe` for one table's columns only when that table
// is expanded. Nothing here fetches a ROW: opening a tree node against a
// warehouse must not cost a scan, and the row figures it shows are the
// optimiser's ESTIMATES, rendered with a leading `~` so they never read as a
// count the app is standing behind.
//
// BOTTOM is the dataset grid's own markup (`.ds-table`, `.ds-th`, `.ds-type-*`)
// rather than a second table component — the preview a user checks here and the
// dataset they get afterwards are the same rows and must look identical, and
// two table renderers is how that stops being true.
//
// RIGHT is the only pane that can talk about datasets, and it reads them from
// the summaries the Data page already lists (`originConnId`), so "3 datasets
// from this connection" cannot disagree with what Data shows.
//
// The preview is bounded at CONN_PREVIEW_ROWS by MAIN. The import row limit in
// the editor's bar is a separate, explicit choice and only ever applies at
// "Save as dataset".

// ── Small helpers ────────────────────────────────────────────────────────────

/** The connect panel's error line, but the workbench's own — the browse flow's
 *  `#conn-error` is behind a hidden wrapper while this is open. */
function cwSetError(msg: string): void {
  const box = connEl('conn-wb-error');
  if (!box) return;
  box.textContent = msg || '';
  box.hidden = !msg;
}

/**
 * Quote one identifier the way THIS connection's dialect does.
 *
 * Mirrors connectionRun.ts's DIALECTS table deliberately, including Oracle's
 * bare (unquoted) form: Oracle folds an unquoted identifier to upper case, so
 * inserting `"sales"` would look for a lower-case table that almost never
 * exists. This is a text insertion into an editor the user then reads — it is
 * NOT a security boundary, which lives in main where the statement is bounded
 * and the table name is whitelisted.
 */
function cwQuote(name: string): string {
  const family = (cwDef && cwDef.family) || '';
  const n = String(name || '');
  if (family === 'mysql') return '`' + n.replace(/`/g, '``') + '`';
  if (family === 'mssql') return '[' + n.replace(/]/g, ']]') + ']';
  if (family === 'oracle') return n;
  return '"' + n.replace(/"/g, '""') + '"';
}

/** `schema.table`, or just `table` for a source that reports no schema. This is
 *  the string main's describe/sample take, and the key `cwColumns` is keyed on. */
function cwQualify(t: { schema?: string; name: string }): string {
  return t && t.schema ? String(t.schema) + '.' + String(t.name) : String((t && t.name) || '');
}

/** A row estimate as a short, honest figure: `~1.2M`, `~12k`, `~840`. */
function cwEstimate(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1_000_000) return '~' + (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return '~' + (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
  return '~' + n;
}

// ── Open / close ─────────────────────────────────────────────────────────────

/**
 * Open the workbench on one saved connection.
 *
 * The table list is fetched here, once, because all three panes need it: the
 * tree renders it, the editor's autocomplete reads it, and the details rail
 * reports how much of the source is reachable. A failure is reported in the
 * tree's own message line rather than as a panel error — the editor still
 * works against a source whose catalog cannot be listed.
 */
async function openConnWorkbench(c: any): Promise<void> {
  if (!c || !c.id) return;
  cwConn = c;
  cwDef = connDefById(typeof c.kind === 'string' ? c.kind : '');
  cwTables = [];
  cwColumns.clear();
  cwTable = '';
  cwPreview = null;
  cwPreviewTable = '';
  cwPreviewSql = '';
  cwQueryId = '';
  cwDatasets = [];

  cwSetError('');
  connShow('conn-browse', false);
  connShow('conn-wb', true);

  // Header.
  const logo = connEl('conn-wb-logo');
  const kindId = typeof c.kind === 'string' ? c.kind : '';
  const label = cwDef ? cwDef.label : kindId || 'Connection';
  if (logo) {
    const built = connMakeLogoFor(kindId, label);
    logo.replaceChildren(...built.childNodes);
    logo.className = built.className + ' cw-logo';
  }
  const title = connEl('conn-wb-title');
  if (title) title.textContent = String(c.name || 'Untitled connection');
  const sub = connEl('conn-wb-sub');
  if (sub) {
    const where = connWhere(c);
    sub.textContent = where ? label + ' · ' + where : label;
  }

  // A source with no catalog to read has no tree. Hiding it is the honest
  // answer: `connection:describe` resolves `{schema: null}` for these, and a
  // tree of tables whose columns can never be shown is worse than none.
  const browsable = !cwDef || cwDef.browsable !== false;
  connShow('conn-wb-tree-pane', browsable);

  cwRenderDetails();
  cwRenderQueryChips();
  cwClearResults('Pick a table on the left, or write a query and Run.');
  cwSetSql('');

  // The two fetches are independent; neither blocks the panel being usable.
  void cwLoadDatasets();
  if (browsable) await cwLoadTables();
}

function closeConnWorkbench(): void {
  connShow('conn-wb', false);
  connShow('conn-browse', true);
  cwCloseAutocomplete();
  cwConn = null;
  cwDef = null;
  cwTables = [];
  cwColumns.clear();
  cwTable = '';
  cwPreview = null;
  cwPreviewTable = '';
  cwPreviewSql = '';
  cwQueryId = '';
  cwDatasets = [];
}

// ── Left pane: the schema tree ───────────────────────────────────────────────

async function cwLoadTables(): Promise<void> {
  const msg = connEl('conn-wb-tree-msg');
  const host = connEl('conn-wb-tree');
  if (host) host.innerHTML = '';
  if (msg) { msg.textContent = 'Loading tables…'; msg.hidden = false; }

  let res: any;
  try {
    res = await window.hub.listConnectionTables(currentProjectId, String(cwConn.id));
  } catch (_) {
    res = { ok: false, error: 'Could not list tables.' };
  }
  if (!cwConn) return; // the workbench closed while this was in flight

  if (!res || res.ok === false) {
    if (msg) { msg.textContent = (res && res.error) || 'Could not list tables.'; msg.hidden = false; }
    return;
  }
  cwTables = (Array.isArray(res.tables) ? res.tables : [])
    .map((t: any) => ({ schema: t && t.schema ? String(t.schema) : undefined, name: String((t && t.name) || '') }))
    .filter((t: any) => t.name);
  cwRenderTree();
}

/**
 * Paint the tree from `cwTables`, filtered by the search box.
 *
 * Grouped by schema, and a source that reports no schema gets NO schema level
 * rather than a fabricated one — the DuckDB connectors fold any schema into the
 * table name on purpose (see local.ts's CONTRACT NOTE), so inventing a "main"
 * node would name something that does not resolve.
 *
 * Matching a table keeps its schema visible; matching a SCHEMA keeps all of its
 * tables, so typing a schema name is a way to scope the tree.
 */
function cwRenderTree(): void {
  const host = connEl('conn-wb-tree');
  const msg = connEl('conn-wb-tree-msg');
  if (!host) return;
  host.innerHTML = '';

  const search = connEl('conn-wb-tree-search') as HTMLInputElement | null;
  const q = (search && search.value ? search.value : '').trim().toLowerCase();
  const shown = cwTables.filter((t) => {
    if (!q) return true;
    return cwQualify(t).toLowerCase().includes(q);
  });

  if (msg) {
    if (cwTables.length === 0) {
      msg.textContent = 'This source reported no tables.';
      msg.hidden = false;
    } else if (shown.length === 0) {
      msg.textContent = 'No tables match that search.';
      msg.hidden = false;
    } else {
      msg.hidden = true;
    }
  }

  const groups = new Map<string, { schema?: string; name: string }[]>();
  for (const t of shown) {
    const key = t.schema || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  for (const [schema, tables] of groups) {
    if (schema) {
      const head = document.createElement('div');
      head.className = 'cw-schema';
      const name = document.createElement('span');
      name.className = 'cw-schema-name';
      name.textContent = schema;
      const count = document.createElement('span');
      count.className = 'cw-num';
      count.textContent = String(tables.length);
      head.appendChild(name);
      head.appendChild(count);
      host.appendChild(head);
    }
    for (const t of tables) host.appendChild(cwTableNode(t));
  }
}

function cwTableNode(t: { schema?: string; name: string }): HTMLElement {
  const qualified = cwQualify(t);
  const wrap = document.createElement('div');
  wrap.className = 'cw-node';
  wrap.dataset.table = qualified;

  const row = document.createElement('div');
  row.className = 'cw-row cw-row-table';
  row.setAttribute('role', 'treeitem');
  row.tabIndex = 0;
  if (qualified === cwTable) row.classList.add('is-on');

  // The disclosure and the row are two different actions: the caret shows the
  // columns (metadata), the row shows the DATA. Collapsing them into one would
  // mean every expand ran a sample query against the source.
  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'cw-caret';
  caret.setAttribute('aria-label', 'Show columns of ' + qualified);
  caret.setAttribute('aria-expanded', 'false');
  caret.appendChild(icon('chevron-right', 14));
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    void cwToggleColumns(wrap, qualified, caret);
  });
  row.appendChild(caret);

  const label = document.createElement('span');
  label.className = 'cw-row-name';
  label.textContent = t.name;
  label.title = qualified;
  row.appendChild(label);

  const est = document.createElement('span');
  est.className = 'cw-num cw-est';
  est.dataset.estFor = qualified;
  row.appendChild(est);

  // Native HTML5 drag, with no drop handler of our own: a <textarea> already
  // inserts dropped `text/plain` at the drop point, which is exactly the
  // behaviour wanted. Writing a dragover/drop pair would be re-implementing it
  // and would also have to reproduce the caret placement.
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt) {
      dt.setData('text/plain', cwQuote(qualified));
      dt.effectAllowed = 'copy';
    }
  });

  row.addEventListener('click', () => { void cwSelectTable(qualified); });
  row.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === 'Enter' || key === ' ') {
      e.preventDefault();
      void cwSelectTable(qualified);
    } else if (key === 'ArrowRight') {
      e.preventDefault();
      void cwToggleColumns(wrap, qualified, caret);
    }
  });
  wrap.appendChild(row);
  return wrap;
}

/** Expand/collapse one table's columns, fetching them the first time only. */
async function cwToggleColumns(wrap: HTMLElement, qualified: string, caret: HTMLElement): Promise<void> {
  const open = wrap.querySelector('.cw-cols-list');
  if (open) {
    open.remove();
    caret.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('is-open');
    return;
  }
  caret.setAttribute('aria-expanded', 'true');
  wrap.classList.add('is-open');

  const list = document.createElement('div');
  list.className = 'cw-cols-list';
  const loading = document.createElement('div');
  loading.className = 'cw-row cw-row-col cw-loading';
  loading.textContent = 'Loading columns…';
  list.appendChild(loading);
  wrap.appendChild(list);

  const described = await cwDescribe(qualified);
  if (!wrap.isConnected) return;
  list.innerHTML = '';
  if (!described) {
    const err = document.createElement('div');
    err.className = 'cw-row cw-row-col cw-loading';
    err.textContent = 'Columns unavailable.';
    list.appendChild(err);
    return;
  }
  for (const col of described.columns) list.appendChild(cwColumnNode(qualified, col));
}

function cwColumnNode(qualified: string, col: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cw-row cw-row-col';
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (dt) {
      dt.setData('text/plain', cwQuote(String(col.name)));
      dt.effectAllowed = 'copy';
    }
  });

  // The type GLYPH is the source's own type name reduced to the three shapes
  // the app has — the same vocabulary the dataset grid's `.ds-type-*` badges
  // use, so a column reads the same here and after the import. The sprite's
  // own `type-*` marks, not `#`/`A` characters: a letterform scaled to 11px is
  // a different weight in every font the OS might resolve.
  const glyph = document.createElement('span');
  const kind = cwTypeKind(String(col.type || ''));
  glyph.className = 'cw-glyph cw-glyph-' + kind;
  glyph.setAttribute('aria-hidden', 'true');
  // Spelled out rather than built as `'type-' + kind`: scripts/test-noGlyphIcons
  // resolves icon names STATICALLY, so a concatenated name reads as the icon
  // "type-" and the check that every referenced icon exists stops working.
  glyph.appendChild(icon(
    kind === 'number' ? 'type-number' : kind === 'date' ? 'type-date' : 'type-text', 13,
  ));
  row.appendChild(glyph);

  const name = document.createElement('span');
  name.className = 'cw-row-name';
  name.textContent = String(col.name);
  row.appendChild(name);

  const type = document.createElement('span');
  type.className = 'cw-col-type';
  // The source's verbatim type, plus NOT NULL where the catalog says so — that
  // is a fact about the column and the only place the workbench shows it.
  type.textContent = col.nullable === false ? String(col.type) + ' · not null' : String(col.type);
  type.title = type.textContent;
  row.appendChild(type);
  return row;
}

/**
 * Reduce a SOURCE type name to one of three shapes, for the glyph only.
 *
 * Deliberately NOT a type decision: what a column becomes in a dataset is
 * parse.ts's call, made over the actual values, so that `007` stays text
 * wherever it came from. This only picks an icon.
 */
function cwTypeKind(sourceType: string): 'number' | 'date' | 'text' {
  const t = sourceType.toLowerCase();
  if (/(int|numeric|decimal|real|double|float|number|money|serial|bigint)/.test(t)) return 'number';
  if (/(date|time|timestamp|interval)/.test(t)) return 'date';
  return 'text';
}

/** Describe one table, caching its column names for the editor's autocomplete.
 *  Returns null on any failure, and for a source with no catalog at all. */
async function cwDescribe(qualified: string): Promise<{ columns: any[]; rowEstimate?: number } | null> {
  let res: any;
  try {
    res = await window.hub.describeConnectionTable(currentProjectId, String(cwConn.id), qualified);
  } catch (_) {
    return null;
  }
  if (!res || res.ok === false || !res.schema) return null;
  const columns = Array.isArray(res.schema.columns) ? res.schema.columns : [];
  cwColumns.set(qualified, columns.map((c: any) => String((c && c.name) || '')).filter(Boolean));

  // Paint the estimate onto the table row, wherever it currently is.
  const est = Number(res.schema.rowEstimate);
  const cell = document.querySelector('.cw-est[data-est-for="' + CSS.escape(qualified) + '"]');
  if (cell instanceof HTMLElement) {
    cell.textContent = Number.isFinite(est) ? cwEstimate(est) : '';
    cell.title = Number.isFinite(est) ? est.toLocaleString('en-US') + ' rows (estimated)' : '';
  }
  return { columns, rowEstimate: Number.isFinite(est) ? est : undefined };
}

// ── Selecting a table shows its sample ───────────────────────────────────────

async function cwSelectTable(qualified: string): Promise<void> {
  if (!cwConn) return;
  cwSetError('');
  cwTable = qualified;
  // Repaint just the selection, not the whole tree — a repaint would collapse
  // every expanded node the user opened to get here.
  document.querySelectorAll('.cw-row-table.is-on').forEach((el) => el.classList.remove('is-on'));
  const node = document.querySelector('.cw-node[data-table="' + CSS.escape(qualified) + '"] .cw-row-table');
  if (node instanceof HTMLElement) node.classList.add('is-on');

  cwClearResults('Loading ' + qualified + '…');
  // Columns for the editor's autocomplete, in the background: selecting a table
  // is the strongest signal that the next thing typed will name its columns.
  if (!cwColumns.has(qualified)) void cwDescribe(qualified);

  let res: any;
  try {
    res = await window.hub.sampleConnectionTable(
      currentProjectId, String(cwConn.id), qualified, CONN_PREVIEW_ROWS,
    );
  } catch (_) {
    res = { ok: false, error: 'Could not read that table.' };
  }
  if (!cwConn || cwTable !== qualified) return; // a later click won

  if (!res || res.ok === false) {
    cwSetError((res && res.error) || 'Could not read that table.');
    cwClearResults('That table could not be read.');
    return;
  }
  cwShowResult(res.preview, { table: qualified, sql: '', name: qualified });
}

// ── The results grid ─────────────────────────────────────────────────────────

/**
 * Show a ParseResult, and remember WHAT produced it.
 *
 * `source.table` / `source.sql` are what the dataset's origin will carry, and
 * exactly one of them is ever set — that is what makes a refresh re-run the
 * thing that built this dataset rather than whatever the connection last had
 * selected. `name` only seeds the dataset-name box.
 */
function cwShowResult(result: any, source: { table: string; sql: string; name: string }): void {
  cwPreview = result || null;
  cwPreviewTable = source.table;
  cwPreviewSql = source.sql;

  const columns: any[] = result && Array.isArray(result.columns) ? result.columns : [];
  const rows: any[] = result && Array.isArray(result.rows) ? result.rows : [];
  const rowCount: number = typeof (result && result.rowCount) === 'number' ? result.rowCount : rows.length;

  const grid = connEl('conn-wb-grid');
  if (grid) {
    grid.innerHTML = '';
    grid.appendChild(cwBuildTable(columns, rows));
  }
  connShow('conn-wb-results-empty', columns.length === 0);

  const note = connEl('conn-wb-note');
  if (note) {
    const shown = Math.min(rows.length, CONN_PREVIEW_ROWS);
    const warnings: string[] = result && Array.isArray(result.warnings) ? result.warnings : [];
    const base = columns.length
      ? `${shown.toLocaleString('en-US')} of ${rowCount.toLocaleString('en-US')} rows · ${columns.length} columns`
      : '';
    note.textContent = warnings.length ? base + ' · ' + warnings[0] : base;
    note.title = warnings.join(' ');
  }

  const nameInput = connEl('conn-wb-ds-name') as HTMLInputElement | null;
  if (nameInput) nameInput.value = source.name || 'Connection data';
  const save = connEl('conn-wb-save-ds') as HTMLButtonElement | null;
  if (save) save.disabled = columns.length === 0;
}

function cwClearResults(message: string): void {
  cwPreview = null;
  cwPreviewTable = '';
  cwPreviewSql = '';
  const grid = connEl('conn-wb-grid');
  if (grid) grid.innerHTML = '';
  const empty = connEl('conn-wb-results-empty');
  if (empty) { empty.textContent = message; empty.hidden = false; }
  const note = connEl('conn-wb-note');
  if (note) { note.textContent = ''; note.title = ''; }
  const save = connEl('conn-wb-save-ds') as HTMLButtonElement | null;
  if (save) save.disabled = true;
}

/** The dataset grid's own markup — same classes, same type badges. */
function cwBuildTable(columns: any[], rows: any[]): HTMLElement {
  const table = document.createElement('table');
  table.className = 'ds-table';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  columns.forEach((col) => {
    const th = document.createElement('th');
    th.className = 'ds-th';
    const name = document.createElement('span');
    name.className = 'ds-th-name';
    name.textContent = col && col.name != null ? String(col.name) : '';
    const type = col && col.type ? String(col.type) : 'text';
    const badge = document.createElement('span');
    badge.className = 'ds-type ds-type-' + type;
    badge.textContent = type;
    th.appendChild(name);
    th.appendChild(badge);
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.slice(0, CONN_PREVIEW_ROWS).forEach((row) => {
    const tr = document.createElement('tr');
    const cells: any[] = Array.isArray(row) ? row : [];
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
  return table;
}

// The right rail (details, Test, and the datasets imported from this
// connection) lives in ./connDetails.ts — see that file's header.

// ── Save as dataset ──────────────────────────────────────────────────────────

/**
 * Hand the current result to the COMPOSER, prefilled.
 *
 * The composer is the app's one create-a-dataset surface — same page, same
 * preview, same field mapping, same Save — so a connection import is not a
 * special kind of import, only a source. That is exactly how a screenshot
 * capture and a file import already reach it.
 *
 * The preview on screen is bounded at 500 rows, so the statement is RE-RUN at
 * the chosen import limit first. Saving the preview instead would quietly give
 * a 500-row dataset from a table the user just set to a million.
 */
async function cwSaveAsDataset(): Promise<void> {
  if (!cwConn || !cwPreview) return;
  const nameInput = connEl('conn-wb-ds-name') as HTMLInputElement | null;
  const name = (nameInput && nameInput.value.trim()) || cwPreviewTable || 'Connection data';
  const btn = connEl('conn-wb-save-ds') as HTMLButtonElement | null;
  const limit = cwImportLimit();
  const selection = cwPreviewSql ? { query: cwPreviewSql } : { table: cwPreviewTable };

  if (btn) { btn.disabled = true; btn.textContent = 'Fetching rows…'; }
  let res: any;
  try {
    res = await window.hub.runConnection(currentProjectId, String(cwConn.id), selection, limit);
  } catch (_) {
    res = { ok: false, error: 'Could not read the full result.' };
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Save as dataset'; }
  if (!res || res.ok === false) {
    cwSetError((res && res.error) || 'Could not read the full result.');
    return;
  }

  const preview = res.preview || { columns: [], rows: [] };
  const columns = Array.isArray(preview.columns) ? preview.columns : [];
  const rows = Array.isArray(preview.rows) ? preview.rows : [];

  // `sourceKind` is a closed union of eight display labels that 35 connectors
  // collapse onto; `origin` is the thing that actually re-runs the import.
  const sourceKind = (cwConn.kind === 'url') ? 'url' : 'postgres';
  const origin: any = { kind: 'connection', connId: String(cwConn.id) };
  if (cwPreviewSql) origin.sql = cwPreviewSql;
  else if (cwPreviewTable) origin.table = cwPreviewTable;
  // A LABEL, not what gets re-run: renaming or deleting the saved query must
  // not change what this dataset refreshes to.
  if (cwPreviewSql && cwQueryId) origin.queryId = cwQueryId;

  if (typeof selectSection === 'function') selectSection('datasets');
  openComposer(
    {
      label: name,
      rows: rows.length,
      kind: sourceKind,
      ref: { inline: { name, columns, rows } },
      columns: columns.map((c: any) => String(c.name)),
    },
    { name, sourceKind, origin },
  );
}

/** The import row limit the editor's bar is set to, clamped to the app's cap. */
function cwImportLimit(): number {
  const sel = connEl('conn-wb-limit') as HTMLSelectElement | null;
  const n = Number(sel && sel.value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : 100_000;
}

// ── Boot wiring (once, from initConnections) ─────────────────────────────────

function initConnWorkbench(): void {
  const back = connEl('conn-wb-back');
  if (back) back.addEventListener('click', () => { closeConnWorkbench(); void refreshConnectionList(); });

  const details = connEl('conn-wb-details-btn');
  if (details) {
    details.addEventListener('click', () => {
      const pane = connEl('conn-wb-details');
      if (!pane) return;
      const open = pane.hidden;
      pane.hidden = !open;
      details.setAttribute('aria-expanded', String(open));
    });
  }

  const search = connEl('conn-wb-tree-search') as HTMLInputElement | null;
  if (search) search.addEventListener('input', () => cwRenderTree());

  const test = connEl('conn-wb-test');
  if (test) test.addEventListener('click', () => { void cwTestConnection(); });

  const save = connEl('conn-wb-save-ds');
  if (save) save.addEventListener('click', () => { void cwSaveAsDataset(); });
}
