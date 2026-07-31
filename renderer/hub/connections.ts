// Connected data sources UI (Postgres + read-only URL/API JSON). Classic
// global-scope renderer <script> — NO import/export; symbols are shared with the
// other hub scripts. Consumes window.hub.* (the connection:* bridge) and the
// shared currentProjectId (workspace.ts), formatSidebarTime (hub.ts), and
// refreshDatasetList (datasets.ts).
//
// SECURITY: the pg password / URL token typed into the form travel ONE-WAY to
// main inside the `secret` argument of testAndSaveConnection and are NEVER read
// back — the password/token inputs are write-only (no reveal). All names/values
// are rendered as textContent only. No inline style= (CSP); toggles use .hidden.

// ── Module-local state ───────────────────────────────────────────────────────
let connRunConnId = ''; // connId whose result is shown in the run area
let connRunKind = ''; // 'postgres' | 'url'
let connRunPreview: any = null; // last run ParseResult, held for "save as dataset"

const CONN_PREVIEW_ROWS = 500; // display-only slice (full capped rows stay in connRunPreview)

// ── Small DOM helpers ────────────────────────────────────────────────────────
function connEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function connShow(id: string, show: boolean): void {
  const el = connEl(id);
  if (el) el.hidden = !show;
}

function connSetError(msg: string): void {
  const box = connEl('conn-error');
  if (!box) return;
  if (msg) {
    box.textContent = msg;
    box.hidden = false;
  } else {
    box.textContent = '';
    box.hidden = true;
  }
}

function connVal(id: string): string {
  const el = connEl(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return el && typeof el.value === 'string' ? el.value.trim() : '';
}

// ── Panel open/close ─────────────────────────────────────────────────────────
function openConnPanel(): void {
  connSetError('');
  connShow('conn-panel', true);
  refreshConnectionList();
}

function closeConnPanel(): void {
  connShow('conn-panel', false);
}

// Toggle the Postgres vs URL field blocks off the kind <select>.
function onConnKindChange(): void {
  const kind = connVal('conn-kind-select') || 'postgres';
  connShow('conn-pg-fields', kind === 'postgres');
  connShow('conn-url-fields', kind === 'url');
}

// ── Test & Save ──────────────────────────────────────────────────────────────
async function handleConnTestAndSave(): Promise<void> {
  connSetError('');
  if (!currentProjectId) {
    connSetError('Open a project first.');
    return;
  }
  const kind = connVal('conn-kind-select') || 'postgres';
  const btn = connEl('conn-test-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  let config: any;
  let secret: any;
  if (kind === 'postgres') {
    config = {
      name: connVal('conn-name'),
      host: connVal('conn-host'),
      port: connVal('conn-port'),
      database: connVal('conn-db'),
      user: connVal('conn-user'),
      ssl: (connEl('conn-ssl') as HTMLInputElement | null)?.checked || false,
      table: connVal('conn-table'),
      query: connVal('conn-query'),
    };
    secret = { password: connVal('conn-password') };
  } else {
    config = { name: connVal('conn-name'), url: connVal('conn-url') };
    secret = { token: connVal('conn-token') };
  }

  let res: any;
  try {
    res = await window.hub.testAndSaveConnection(currentProjectId, kind, config, secret);
  } catch (_) {
    res = { ok: false, error: 'Could not reach the connection.' };
  } finally {
    if (btn) btn.disabled = false;
  }

  if (!res || res.ok === false) {
    connSetError((res && res.error) || 'Could not connect.');
    return;
  }
  // Success: clear the secret fields (write-only) and the form, refresh the list.
  const pw = connEl('conn-password') as HTMLInputElement | null;
  if (pw) pw.value = '';
  const tok = connEl('conn-token') as HTMLInputElement | null;
  if (tok) tok.value = '';
  ['conn-name', 'conn-host', 'conn-port', 'conn-db', 'conn-user', 'conn-table', 'conn-query', 'conn-url'].forEach((id) => {
    const el = connEl(id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (el) el.value = '';
  });
  await refreshConnectionList();
}

// ── Saved-connections list ───────────────────────────────────────────────────
async function refreshConnectionList(): Promise<void> {
  const list = connEl('conn-saved-list');
  const empty = connEl('conn-saved-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    if (empty) empty.hidden = false;
    return;
  }
  let items: any[] = [];
  try {
    items = await window.hub.listConnections(currentProjectId);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  if (empty) empty.hidden = items.length > 0;
  items.forEach((c) => list.appendChild(makeConnItem(c)));
}

function makeConnItem(c: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'conn-saved-item';

  const mainCol = document.createElement('div');
  mainCol.className = 'conn-saved-main';

  const name = document.createElement('span');
  name.className = 'conn-saved-name';
  name.textContent = c && c.name ? String(c.name) : 'Untitled connection';

  const meta = document.createElement('span');
  meta.className = 'conn-saved-meta';
  const status = c && c.lastStatus ? String(c.lastStatus) : 'untested';
  const statusBadge = document.createElement('span');
  statusBadge.className = 'conn-status conn-status-' + (status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'untested');
  statusBadge.textContent = status;
  const kind = c && c.kind === 'url' ? 'URL' : 'Postgres';
  const when = c && c.lastRefreshedAt ? 'refreshed ' + formatSidebarTime(c.lastRefreshedAt) : 'never refreshed';
  const metaText = document.createElement('span');
  metaText.textContent = kind + ' · ' + when;
  meta.appendChild(statusBadge);
  meta.appendChild(metaText);

  mainCol.appendChild(name);
  mainCol.appendChild(meta);

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'conn-run-btn';
  runBtn.textContent = 'Run';
  runBtn.addEventListener('click', () => openRunArea(c));

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'conn-refresh';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => handleConnRefresh(c));

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'conn-del';
  delBtn.setAttribute('aria-label', 'Delete connection');
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', () => handleConnDelete(c));

  row.appendChild(mainCol);
  row.appendChild(runBtn);
  row.appendChild(refreshBtn);
  row.appendChild(delBtn);
  return row;
}

// ── Run area (per saved connection) ──────────────────────────────────────────
async function openRunArea(c: any): Promise<void> {
  if (!currentProjectId || !c || !c.id) return;
  connSetError('');
  connRunConnId = String(c.id);
  connRunKind = c.kind === 'url' ? 'url' : 'postgres';
  connRunPreview = null;

  const title = connEl('conn-run-title');
  if (title) title.textContent = 'Run — ' + (c.name || 'connection');

  // Reset preview + save bar.
  const scroll = connEl('conn-run-table-scroll');
  if (scroll) scroll.innerHTML = '';
  connShow('conn-run-preview', false);
  connShow('conn-save-bar', false);
  connShow('conn-run-warnings', false);

  const isPg = connRunKind === 'postgres';
  connShow('conn-run-table-row', isPg);
  connShow('conn-run-query-row', isPg);

  // Prefill the query textarea with any saved query.
  const qEl = connEl('conn-run-query') as HTMLTextAreaElement | null;
  if (qEl) qEl.value = isPg && typeof c.query === 'string' ? c.query : '';

  connShow('conn-run-area', true);

  if (isPg) {
    const sel = connEl('conn-table-select') as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = '';
      const loading = document.createElement('option');
      loading.value = '';
      loading.textContent = 'Loading tables…';
      sel.appendChild(loading);
    }
    let tRes: any;
    try {
      tRes = await window.hub.listConnectionTables(currentProjectId, connRunConnId);
    } catch (_) {
      tRes = { ok: false, error: 'Could not list tables.' };
    }
    if (sel) {
      sel.innerHTML = '';
      if (tRes && tRes.ok && Array.isArray(tRes.tables)) {
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = c.table ? c.table : 'Choose a table…';
        sel.appendChild(blank);
        tRes.tables.forEach((t: any) => {
          const qualified = (t && t.schema ? String(t.schema) + '.' : '') + (t && t.name ? String(t.name) : '');
          const opt = document.createElement('option');
          opt.value = qualified;
          opt.textContent = qualified;
          if (c.table && qualified === c.table) opt.selected = true;
          sel.appendChild(opt);
        });
      } else {
        const err = document.createElement('option');
        err.value = '';
        err.textContent = (tRes && tRes.error) || 'Could not list tables';
        sel.appendChild(err);
      }
    }
  }
}

function closeRunArea(): void {
  connShow('conn-run-area', false);
  connRunConnId = '';
  connRunKind = '';
  connRunPreview = null;
}

async function handleConnRun(): Promise<void> {
  if (!currentProjectId || !connRunConnId) return;
  connSetError('');
  const btn = connEl('conn-run-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  let tableOrQuery: any = {};
  if (connRunKind === 'postgres') {
    const query = connVal('conn-run-query');
    if (query) tableOrQuery = { query };
    else {
      const table = connVal('conn-table-select');
      if (table) tableOrQuery = { table };
    }
  }

  let res: any;
  try {
    res = await window.hub.runConnection(currentProjectId, connRunConnId, tableOrQuery);
  } catch (_) {
    res = { ok: false, error: 'Could not run the connection.' };
  } finally {
    if (btn) btn.disabled = false;
  }

  if (!res || res.ok === false) {
    connSetError((res && res.error) || 'Could not run the connection.');
    connShow('conn-run-preview', false);
    connShow('conn-save-bar', false);
    return;
  }
  connRunPreview = res.preview || null;
  connRenderRunPreview(connRunPreview);
}

// Build the preview table into #conn-run-table-scroll (reuses the .ds-table CSS).
function connRenderRunPreview(res: any): void {
  const columns: any[] = res && Array.isArray(res.columns) ? res.columns : [];
  const rows: any[] = res && Array.isArray(res.rows) ? res.rows : [];
  const warnings: any[] = res && Array.isArray(res.warnings) ? res.warnings : [];
  const rowCount: number = typeof (res && res.rowCount) === 'number' ? res.rowCount : rows.length;

  // Warnings.
  const warnBox = connEl('conn-run-warnings');
  if (warnBox) {
    warnBox.innerHTML = '';
    warnings.forEach((w) => {
      const line = document.createElement('div');
      line.className = 'ds-warning';
      line.textContent = String(w);
      warnBox.appendChild(line);
    });
  }
  connShow('conn-run-warnings', warnings.length > 0);

  // Table.
  const scroll = connEl('conn-run-table-scroll');
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
    scroll.appendChild(table);
  }

  const note = connEl('conn-run-note');
  if (note) {
    if (rowCount > CONN_PREVIEW_ROWS) {
      note.textContent = 'Showing first ' + CONN_PREVIEW_ROWS + ' of ' + rowCount + ' rows';
      note.hidden = false;
    } else {
      note.textContent = '';
      note.hidden = true;
    }
  }

  connShow('conn-run-preview', columns.length > 0);

  // Save bar — suggest a dataset name from the connection/table.
  const nameInput = connEl('conn-ds-name') as HTMLInputElement | null;
  if (nameInput && !nameInput.value) {
    const table = connVal('conn-table-select');
    nameInput.value = table || 'Connection data';
  }
  connShow('conn-save-bar', columns.length > 0);
}

// Save the current run result as a dataset, then link the connection to it (so
// Refresh has a target). Reuses the existing dataset:save channel.
async function handleConnSaveAsDataset(): Promise<void> {
  if (!currentProjectId || !connRunConnId) return;
  if (!connRunPreview || !Array.isArray(connRunPreview.columns) || connRunPreview.columns.length === 0) return;
  const nameInput = connEl('conn-ds-name') as HTMLInputElement | null;
  const name = (nameInput && nameInput.value.trim()) || 'Connection data';
  const sourceKind = connRunKind === 'url' ? 'url' : 'postgres';

  let saved: any;
  try {
    saved = await window.hub.saveDataset({
      projectId: currentProjectId,
      name,
      sourceKind,
      columns: connRunPreview.columns,
      rows: connRunPreview.rows,
    });
  } catch (_) {
    connSetError('Failed to save the dataset.');
    return;
  }
  if (saved && saved.ok === false) {
    connSetError(saved.error || 'Failed to save the dataset.');
    return;
  }
  // Link the connection to the new dataset so Refresh can re-run into it.
  if (saved && saved.id) {
    try {
      await window.hub.refreshConnection(currentProjectId, connRunConnId, String(saved.id));
    } catch (_) {
      /* best-effort link; ignore */
    }
  }
  closeRunArea();
  await refreshConnectionList();
  // The new dataset also appears in the Datasets section list.
  if (typeof refreshDatasetList === 'function') await refreshDatasetList();
}

// ── Refresh / Delete ─────────────────────────────────────────────────────────
async function handleConnRefresh(c: any): Promise<void> {
  if (!currentProjectId || !c || !c.id) return;
  connSetError('');
  if (!c.linkedDatasetId) {
    connSetError('Run this connection and save the result as a dataset first, then Refresh will keep it up to date.');
    return;
  }
  let res: any;
  try {
    res = await window.hub.refreshConnection(currentProjectId, String(c.id), String(c.linkedDatasetId));
  } catch (_) {
    res = { ok: false, error: 'Could not refresh the connection.' };
  }
  if (!res || res.ok === false) {
    connSetError((res && res.error) || 'Could not refresh the connection.');
  }
  await refreshConnectionList();
  if (typeof refreshDatasetList === 'function') await refreshDatasetList();
}

async function handleConnDelete(c: any): Promise<void> {
  if (!currentProjectId || !c || !c.id) return;
  if (!window.confirm('Delete this connection? Its saved dataset is not removed.')) return;
  try {
    await window.hub.deleteConnection(currentProjectId, String(c.id));
  } catch (_) {
    /* ignore */
  }
  if (connRunConnId === String(c.id)) closeRunArea();
  await refreshConnectionList();
}

// ── Boot wiring (once) ───────────────────────────────────────────────────────
function initConnections(): void {
  const openBtn = connEl('conn-connect-btn');
  if (openBtn) openBtn.addEventListener('click', () => openConnPanel());

  const closeBtn = connEl('conn-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => closeConnPanel());

  const kindSel = connEl('conn-kind-select');
  if (kindSel) kindSel.addEventListener('change', () => onConnKindChange());
  onConnKindChange(); // set initial field visibility

  const testBtn = connEl('conn-test-btn');
  if (testBtn) testBtn.addEventListener('click', () => handleConnTestAndSave());

  const runBtn = connEl('conn-run-btn');
  if (runBtn) runBtn.addEventListener('click', () => handleConnRun());

  const runClose = connEl('conn-run-close');
  if (runClose) runClose.addEventListener('click', () => closeRunArea());

  const saveBtn = connEl('conn-save-ds-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => handleConnSaveAsDataset());
}
