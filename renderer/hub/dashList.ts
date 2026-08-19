// The dashboards LIST: the cards you land on before opening one, plus create,
// rename, duplicate and delete. The editor is dashGrid.ts.
//
// Split verbatim out of dashboards.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER dashboards.js,
// which keeps the module-local state (dashCurrent, dashMode, dashReadOnly,
// dashDirty, chartInstances, …) that every function here reads and writes —
// that state is NOT duplicated, and there is deliberately no accessor layer
// around it, because the renderer is one shared global scope by design.

// ── List view ───────────────────────────────────────────────────────────────
async function refreshDashboardList(): Promise<void> {
  // Flush any pending debounced edit before tearing the editor down, so a quick
  // section switch never drops the last few edits.
  if (dashDirty && dashCurrent) await persistDashboard();
  // Always show the list (not a half-open editor) when the section refreshes.
  closeDashboardEditor();
  const list = dashEl('dash-list');
  const empty = dashEl('dash-list-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    if (empty) empty.hidden = false;
    return;
  }
  let items: any[] = [];
  try {
    items = await window.hub.listDashboards(currentProjectId);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  dashList = items;
  if (empty) {
    empty.hidden = items.length > 0;
    // A DESIGNED empty state (makeEmptyState, homePage.ts) — the same glyph +
    // title + line + action shape Home and Ask use — rather than a bare muted
    // sentence. Rendered fresh each refresh; the action delegates to the ONE
    // existing New-dashboard handler.
    empty.innerHTML = '';
    if (items.length === 0 && typeof makeEmptyState === 'function') {
      empty.appendChild(makeEmptyState({
        variant: 'dash',
        glyph: '▤',
        title: 'No dashboards yet',
        line: 'Publish a dashboard from an analysis, or start a standalone one.',
        actionLabel: 'New dashboard',
        onAction: () => void handleNewDashboard(),
      }));
    }
  }
  items.forEach((d) => list.appendChild(makeDashListItem(d)));
}

// One dashboard as a CARD (not a flat row). Keeps the shared hooks smoke-app
// queries — the outer `.dash-list-item`, the open control `.dash-list-open`, and
// the `.dash-list-badge` read-only pill — and adds `.dash-tile*` classes the
// #ws-dashboards-scoped CSS styles. The Analyses list reuses the shared classes
// under #ws-analyses and is untouched by this (all new visuals are scoped to
// #ws-dashboards), so it stays pixel-identical.
function makeDashListItem(d: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'dash-list-item dash-tile';

  // A published dashboard is read-only. Say so BEFORE it is opened — the
  // summary carries analysisId precisely so this costs no extra read.
  const published = Boolean(d && d.analysisId);
  if (published) row.classList.add('is-published');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'dash-list-open dash-tile-open';

  const titleRow = document.createElement('span');
  titleRow.className = 'dash-tile-title';
  const name = document.createElement('span');
  name.className = 'dash-list-name dash-tile-name';
  name.textContent = d && d.name ? String(d.name) : 'Untitled dashboard';
  titleRow.appendChild(name);
  // The read-only state is real meaning, kept visible as a quiet pill — not
  // hidden. `.dash-list-badge` is the hook smoke-app asserts on.
  if (published) {
    const badge = document.createElement('span');
    badge.className = 'dash-list-badge dash-tile-pill';
    badge.textContent = 'Published · read-only';
    titleRow.appendChild(badge);
  }

  const meta = document.createElement('span');
  meta.className = 'dash-list-meta dash-tile-meta';
  const pages = d && typeof d.pageCount === 'number' ? d.pageCount : 1;
  const tiles = d && typeof d.cardCount === 'number' ? d.cardCount : 0;
  // pages · tiles · updated — every part is already in the summary (cardCount is
  // a free sum over the record listDashboards already read), so nothing here is
  // an extra read or a computed figure.
  const when = published && d.publishedAt
    ? 'published ' + formatSidebarTime(d.publishedAt)
    : formatSidebarTime(d && d.updatedAt);
  meta.textContent = pages + (pages === 1 ? ' page · ' : ' pages · ') +
    tiles + (tiles === 1 ? ' tile · ' : ' tiles · ') + when;

  open.appendChild(titleRow);
  open.appendChild(meta);
  open.addEventListener('click', () => openDashboard(String(d.id)));

  // Rename/delete are hover-revealed icons (CSS), not permanent buttons beside
  // every card. The aria-labels are preserved: smoke-app asserts a published
  // card does NOT offer "Rename dashboard" (main refuses that write) while a
  // standalone one does.
  const actions = document.createElement('div');
  actions.className = 'dash-tile-actions';

  const ren = document.createElement('button');
  ren.type = 'button';
  ren.className = 'dash-list-btn dash-tile-btn';
  ren.setAttribute('aria-label', 'Rename dashboard');
  ren.textContent = '✎';
  ren.addEventListener('click', (e) => { e.stopPropagation(); handleRenameDashboard(String(d.id), name.textContent || ''); });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'dash-list-btn dash-tile-btn';
  del.setAttribute('aria-label', 'Delete dashboard');
  del.textContent = '🗑';
  del.addEventListener('click', (e) => { e.stopPropagation(); handleDeleteDashboard(String(d.id)); });

  // Renaming a published snapshot is a write main refuses — offering the button
  // would just fail. Deleting is still allowed: a snapshot can be discarded.
  if (!published) actions.appendChild(ren);
  actions.appendChild(del);

  row.appendChild(open);
  row.appendChild(actions);
  return row;
}

async function handleNewDashboard(): Promise<void> {
  if (!currentProjectId) { window.alert('Open a project first.'); return; }
  const name = await promptModal('New dashboard', 'Untitled dashboard', 'Create');
  if (name === null) return;
  let res: any;
  try {
    res = await window.hub.saveDashboard({ projectId: currentProjectId, name });
  } catch (_) {
    res = null;
  }
  if (!res || res.ok === false || !res.id) {
    window.alert((res && res.error) || 'Failed to create the dashboard.');
    return;
  }
  await refreshDashboardList();
  openDashboardFrom(res);
}

async function handleRenameDashboard(id: string, currentName: string): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal('Rename dashboard', currentName || 'Untitled dashboard', 'Save');
  if (name === null) return;
  try {
    await window.hub.updateDashboard(currentProjectId, id, { name });
  } catch (_) { /* ignore */ }
  if (dashCurrent && dashCurrent.id === id) {
    dashCurrent.name = name.trim() || dashCurrent.name;
    const nameEl = dashEl('dash-name');
    if (nameEl) nameEl.textContent = dashCurrent.name;
  }
  await refreshDashboardListKeepEditor();
}

// Refresh only the summaries list without tearing down an open editor.
async function refreshDashboardListKeepEditor(): Promise<void> {
  if (!currentProjectId) return;
  try {
    dashList = await window.hub.listDashboards(currentProjectId);
  } catch (_) { /* ignore */ }
}

async function handleDeleteDashboard(id: string): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm('Delete this dashboard? This cannot be undone.')) return;
  try {
    await window.hub.deleteDashboard(currentProjectId, id);
  } catch (_) { /* ignore */ }
  if (dashCurrent && dashCurrent.id === id) closeDashboardEditor();
  await refreshDashboardList();
}

