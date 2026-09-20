// The workbench's RIGHT RAIL: the connection itself, and what has been
// imported from it.
//
// Classic global-scope renderer <script>: no import/export. Split out of
// connWorkbench.ts (.claude/rules/file-size.md) — that file's job is browsing
// and querying a SOURCE, this one's is the connection as a RECORD. They share a
// pane and nothing else.
//
// Two rules this pane follows and the other two do not:
//
//   • It NEVER re-saves the connection. "Test" re-runs `connection:listTables`,
//     which is what main's own testConnection prefers, needs no credential from
//     the renderer (the secret is resolved in main from the stored record) and
//     cannot write anything. `connection:testAndSave` would need the password
//     typed again and would create a second record.
//   • Its dataset list and its schedule control come from the SAME places the
//     Data page uses — `listDatasets` summaries filtered by `originConnId`, and
//     dsList's own `dsAutoRefreshPicker`. A second schedule <select> here could
//     offer different options or write through a different channel, and the day
//     the two disagreed nobody would know which one the scheduler believed.

function cwRenderDetails(): void {
  const kv = connEl('conn-wb-kv');
  if (kv) {
    kv.innerHTML = '';
    const values = (cwConn && cwConn.values) || {};
    // Only the fields this connector actually declares, in its own order, and
    // never a `secret` one — the renderer is not given stored secrets at all,
    // so a value arriving here would be a main-process bug, not something to
    // paint. Same rule as connRenderFields.
    const fields = (cwDef && cwDef.fields) || [];
    for (const f of fields) {
      if (f.secret) continue;
      const raw = values[f.key];
      if (raw === undefined || raw === null || raw === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = f.label;
      const dd = document.createElement('dd');
      dd.textContent = typeof raw === 'boolean' ? (raw ? 'Yes' : 'No') : String(raw);
      dd.title = dd.textContent;
      kv.appendChild(dt);
      kv.appendChild(dd);
    }
  }
  cwPaintStatus(
    (cwConn && cwConn.lastStatus) || 'untested',
    (cwConn && cwConn.lastError) || '',
  );
}

function cwPaintStatus(status: string, error: string): void {
  const el = connEl('conn-wb-status');
  if (!el) return;
  const kind = status === 'ok' ? 'ok' : status === 'error' ? 'error' : status === 'testing' ? 'untested' : 'untested';
  el.className = 'conn-status conn-status-' + kind;
  el.textContent = status;
  el.title = status === 'error' && error ? String(error) : '';
}

/**
 * Re-test the connection.
 *
 * `connection:listTables` IS the reachability check — it is what
 * `testConnection` prefers in main, it needs no credential from the renderer
 * (the secret is resolved in main from the stored connection), and it cannot
 * re-save anything. `connection:testAndSave` would need the password typed
 * again and would write a second record.
 */
async function cwTestConnection(): Promise<void> {
  if (!cwConn) return;
  const btn = connEl('conn-wb-test') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  cwPaintStatus('testing', '');
  let res: any;
  try {
    res = await window.hub.listConnectionTables(currentProjectId, String(cwConn.id));
  } catch (_) {
    res = { ok: false, error: 'Could not reach the connection.' };
  } finally {
    if (btn) btn.disabled = false;
  }
  if (!cwConn) return;
  if (res && res.ok) {
    cwPaintStatus('ok', '');
    cwTables = (Array.isArray(res.tables) ? res.tables : [])
      .map((t: any) => ({ schema: t && t.schema ? String(t.schema) : undefined, name: String((t && t.name) || '') }))
      .filter((t: any) => t.name);
    cwRenderTree();
  } else {
    cwPaintStatus('error', (res && res.error) || 'Could not reach the connection.');
  }
}

/** The datasets built from THIS connection, with their schedule and freshness. */
async function cwLoadDatasets(): Promise<void> {
  const connId = String((cwConn && cwConn.id) || '');
  cwDatasets = (await listDatasetSummaries()).filter((d) => d && d.originConnId === connId);
  if (!cwConn || String(cwConn.id) !== connId) return;
  cwRenderDatasets();
}

function cwRenderDatasets(): void {
  const host = connEl('conn-wb-ds-list');
  const empty = connEl('conn-wb-ds-empty');
  if (!host) return;
  host.innerHTML = '';
  if (empty) empty.hidden = cwDatasets.length > 0;
  for (const d of cwDatasets) host.appendChild(cwDatasetRow(d));
}

function cwDatasetRow(d: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cw-ds-row';

  const top = document.createElement('div');
  top.className = 'cw-ds-top';
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'cw-ds-name';
  name.textContent = String(d.name || 'Dataset');
  name.title = 'Open this dataset';
  name.addEventListener('click', () => {
    if (typeof selectSection === 'function') selectSection('datasets');
    if (typeof openSavedDataset === 'function') openSavedDataset(String(d.id));
  });
  top.appendChild(name);

  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'btn btn-sm cw-ds-refresh';
  refresh.textContent = 'Refresh now';
  refresh.addEventListener('click', () => { void cwRefreshDataset(d, refresh); });
  top.appendChild(refresh);
  row.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'cw-ds-meta';
  meta.textContent = cwDatasetFreshness(d);
  if (d.lastRefreshStatus === 'error') {
    row.classList.add('is-error');
    // The reason, on hover — a red state with no cause is one dataset-open away
    // from an answer the row already has.
    meta.title = String(d.lastRefreshError || 'The last refresh failed.');
  }
  row.appendChild(meta);

  // The schedule the EXISTING scheduler runs. `dsAutoRefreshPicker` is the one
  // builder for this control (dsList.ts): a second <select> here could offer
  // different options or write through a different channel, and the day they
  // disagreed nobody would know which one the scheduler believed.
  const picker = typeof dsAutoRefreshPicker === 'function'
    ? dsAutoRefreshPicker(d, () => { void cwLoadDatasets(); })
    : null;
  if (picker) {
    picker.classList.add('cw-ds-auto');
    row.appendChild(picker);
  }
  return row;
}

/** "Refreshes daily · last 08:00", or "Imported …" when nothing is scheduled. */
function cwDatasetFreshness(d: any): string {
  const every = d && d.autoRefresh && d.autoRefresh.every;
  const stamp = (d && d.lastRefreshedAt) || (d && d.updatedAt);
  const rows = typeof d?.rowCount === 'number' ? d.rowCount.toLocaleString('en-US') + ' rows' : '';
  const when = every
    ? `Refreshes ${every} · last ${formatSidebarTime(stamp)}`
    : `Data as of ${formatSidebarTime(stamp)}`;
  return rows ? `${when} · ${rows}` : when;
}

async function cwRefreshDataset(d: any, btn: HTMLButtonElement): Promise<void> {
  if (!currentProjectId || !d || !d.id) return;
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Refreshing…';
  let res: any;
  try {
    res = await window.hub.refreshDataset(currentProjectId, String(d.id));
  } catch (_) {
    res = { ok: false, error: 'Could not refresh that dataset.' };
  }
  btn.disabled = false;
  btn.textContent = was;
  if (!res || res.ok === false) {
    showToast((res && res.error) || 'Could not refresh that dataset.');
  }
  await cwLoadDatasets();
  if (typeof refreshDatasetList === 'function') await refreshDatasetList();
}
