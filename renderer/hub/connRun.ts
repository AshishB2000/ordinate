// A saved connection: listing them, the run area for one, and refresh / delete.
//
// Every source is read-only and EVERY query is bounded server-side by its own
// driver — there is no central LIMIT wrapper, because one broke five of six
// dialects.
//
// Split verbatim out of connections.ts — see .claude/rules/file-size.md.
// Classic global-scope renderer <script>: no import/export.

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
  // The stored `kind` is a connector id; name it from the catalogue so a saved
  // Redshift connection does not read "Postgres". Unknown ids show verbatim.
  const kindId = c && typeof c.kind === 'string' ? c.kind : '';
  const kindDef = connDefById(kindId);
  const kind = kindDef ? kindDef.label : kindId === 'url' ? 'URL' : kindId || 'Connection';
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
  iconOnly(delBtn, 'trash', 'Delete connection');
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
  connRunKind = typeof c.kind === 'string' ? c.kind : 'postgres';
  connRunFamily = connFamilyOf(connRunKind);
  connRunPreview = null;

  const title = connEl('conn-run-title');
  if (title) title.textContent = 'Run — ' + (c.name || 'connection');

  // Reset preview + save bar.
  const scroll = connEl('conn-run-table-scroll');
  if (scroll) scroll.innerHTML = '';
  connShow('conn-run-preview', false);
  connShow('conn-save-bar', false);
  connShow('conn-run-warnings', false);

  // Table + query belong to anything SQL-shaped. The dividing line is NOT the
  // family: every HTTP engine here (ClickHouse, Trino, Druid, …) implements
  // listTables and is queried in SQL. The one source with neither is `url`,
  // which fetches a single document. Gating on family cost seven connectors
  // their table picker.
  const isPg = connRunKind !== 'url';
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
  connRunFamily = '';
  connRunPreview = null;
}

async function handleConnRun(): Promise<void> {
  if (!currentProjectId || !connRunConnId) return;
  connSetError('');
  const btn = connEl('conn-run-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  let tableOrQuery: any = {};
  if (connRunKind !== 'url') {
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
  // Dataset.sourceKind is a closed union, so 35 connector ids collapse onto the
  // two it already has: an http source is 'url', everything else 'postgres'.
  const sourceKind = connRunKind === 'url' ? 'url' : 'postgres';

  let saved: any;
  try {
    saved = await window.hub.saveDataset({
      projectId: currentProjectId,
      name,
      sourceKind,
      columns: connRunPreview.columns,
      rows: connRunPreview.rows,
      // The connection ID, never the URL or the DSN: a refresh re-runs the SAVED
      // connection, so the secret is resolved in main and never round-trips
      // through here. This covers the URL/API source too — it is a connection
      // like any other in the registry.
      origin: { kind: 'connection', connId: connRunConnId },
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

