// The SAVED CONNECTIONS LIST — one card per connection, and the row-level
// delete. Classic global-scope renderer <script>: no import/export.
//
// WHAT THIS REPLACED. A four-button row (Run / Refresh / Delete, plus the name)
// and, under it, an inline "run area": a table <select>, a one-line query box
// and a preview. Every connection in a project shared that one area, so opening
// a second connection silently replaced the first one's result, and there was
// nowhere to keep a query you wanted again. All of that is now
// connWorkbench.ts, opened by clicking a card — which is why this file is the
// list and nothing else.
//
// A card is a BUTTON: the whole surface opens the connection, so the name, the
// host and the dataset count are all live targets instead of three pieces of
// text beside one small link. Delete stops propagation on its way past, the
// same rule dsList.ts's row actions follow.

// ── The list ─────────────────────────────────────────────────────────────────

async function refreshConnectionList(): Promise<void> {
  const list = connEl('conn-saved-list');
  const empty = connEl('conn-saved-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    connShow('conn-saved', false);
    if (empty) empty.hidden = false;
    return;
  }

  let items: any[] = [];
  let datasets: any[] = [];
  try {
    // Both in one round trip: the card's "3 datasets" line is a count over the
    // project's dataset summaries, and fetching it per card would be one IPC
    // call per connection to answer one integer each.
    [items, datasets] = await Promise.all([
      window.hub.listConnections(currentProjectId),
      listDatasetSummaries(),
    ]);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];

  const counts = new Map<string, number>();
  for (const d of datasets) {
    const id = d && typeof d.originConnId === 'string' ? d.originConnId : '';
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }

  // The block sits ABOVE the picker, so an empty one would push 35 tiles down
  // behind a heading with nothing under it. Hide the whole thing, not the list.
  connShow('conn-saved', items.length > 0);
  if (empty) empty.hidden = items.length > 0;
  items.forEach((c) => list.appendChild(makeConnCard(c, counts.get(String(c && c.id)) || 0)));
}

/** The project's dataset summaries, or [] — never throws, because a card list
 *  must render even when the dataset channel is unavailable. */
async function listDatasetSummaries(): Promise<any[]> {
  if (!currentProjectId) return [];
  try {
    const res = await window.hub.listDatasets(currentProjectId);
    return Array.isArray(res) ? res : [];
  } catch (_) {
    return [];
  }
}

/** The host line under a connection's name: what identifies this connection
 *  among several to the same kind of database. Falls back through the fields a
 *  source actually has, because a DuckDB file has no host and the URL source
 *  has nothing but one. */
function connWhere(c: any): string {
  const v = (c && c.values) || {};
  const host = typeof v.host === 'string' ? v.host : '';
  const database = typeof v.database === 'string' ? v.database : '';
  if (host && database) return host + ' / ' + database;
  if (host) return host;
  if (database) return database;
  if (typeof v.path === 'string' && v.path) return v.path;
  if (typeof v.url === 'string' && v.url) return v.url;
  if (typeof c?.url === 'string' && c.url) return c.url;
  return '';
}

function makeConnCard(c: any, datasetCount: number): HTMLElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'conn-card';
  card.dataset.connId = String((c && c.id) || '');

  // The stored `kind` is a connector id; name it from the catalogue so a saved
  // Redshift connection does not read "Postgres". Unknown ids show verbatim.
  const kindId = c && typeof c.kind === 'string' ? c.kind : '';
  const def = connDefById(kindId);
  const label = def ? def.label : kindId === 'url' ? 'URL' : kindId || t('common.connection');

  card.appendChild(connMakeLogoFor(kindId, label));

  const body = document.createElement('span');
  body.className = 'conn-card-body';

  const top = document.createElement('span');
  top.className = 'conn-card-top';
  const name = document.createElement('span');
  name.className = 'conn-card-name';
  name.textContent = c && c.name ? String(c.name) : t('common.untitled_connection');
  top.appendChild(name);

  // The health dot is the LAST TEST's verdict, not a live probe — a card list
  // must not open 12 sockets to render. The title says which it is.
  const status = c && c.lastStatus ? String(c.lastStatus) : 'untested';
  const dot = document.createElement('span');
  dot.className = 'conn-dot conn-dot-' + (status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'untested');
  dot.setAttribute('role', 'img');
  dot.title = status === 'ok'
    ? t('connRun.last_test_succeeded')
    : status === 'error'
      ? t('connRun.last_test_failed', { p0: String((c && c.lastError) || t('connRun.unknown_error')) })
      : t('connRun.not_tested_yet');
  dot.setAttribute('aria-label', dot.title);
  top.appendChild(dot);
  body.appendChild(top);

  const where = connWhere(c);
  const sub = document.createElement('span');
  sub.className = 'conn-card-sub';
  sub.textContent = where ? label + ' · ' + where : label;
  sub.title = sub.textContent;
  body.appendChild(sub);

  const meta = document.createElement('span');
  meta.className = 'conn-card-meta';
  const used = c && c.lastRefreshedAt ? 'used ' + formatSidebarTime(c.lastRefreshedAt) : t('connRun.never_used');
  const nDatasets = datasetCount === 1 ? t('connRun.1_dataset') : datasetCount + ' datasets';
  const nQueries = Array.isArray(c && c.queries) ? c.queries.length : 0;
  meta.textContent = nQueries
    ? `${nDatasets} · ${nQueries === 1 ? t('connRun.1_saved_query') : t('connRun.saved_queries', { nQueries })} · ${used}`
    : `${nDatasets} · ${used}`;
  body.appendChild(meta);

  card.appendChild(body);

  const del = document.createElement('span');
  del.className = 'conn-card-del';
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'conn-del';
  iconOnly(delBtn, 'trash', t('connRun.delete_connection'));
  // The card is itself a <button>; without this the delete opens the workbench
  // on its way past. Same rule as dsList.ts's row actions.
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void handleConnDelete(c);
  });
  del.appendChild(delBtn);
  card.appendChild(del);

  card.addEventListener('click', () => { void openConnWorkbench(c); });
  return card;
}

// ── Delete ───────────────────────────────────────────────────────────────────

async function handleConnDelete(c: any): Promise<void> {
  if (!currentProjectId || !c || !c.id) return;
  if (!window.confirm(t('connRun.delete_this_connection_datasets_already'))) return;
  try {
    await window.hub.deleteConnection(currentProjectId, String(c.id));
  } catch (_) {
    /* the list repaint below is the report either way */
  }
  if (cwConn && String(cwConn.id) === String(c.id)) closeConnWorkbench();
  await refreshConnectionList();
}
