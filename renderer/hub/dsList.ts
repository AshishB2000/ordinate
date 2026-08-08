// The saved-dataset table and how old its data is: the rows, and the freshness
// machinery behind `Data as of <time>` — per dataset, plus Refresh all.
//
// A failed refresh must leave the stored table exactly as it was, so the
// reason is shown inline and a warning stays until the next success.
//
// Split verbatim out of datasets.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

// ── Saved-dataset list ───────────────────────────────────────────────────────
async function refreshDatasetList(): Promise<void> {
  const list = dsEl('ds-saved-list');
  const empty = dsEl('ds-saved-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    if (empty) empty.hidden = false;
    return;
  }
  let items: any[] = [];
  try {
    items = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  if (empty) empty.hidden = items.length > 0;
  items.forEach((d) => list.appendChild(makeSavedItem(d)));
  // "Refresh all" only appears when there is something it could refresh.
  const all = dsEl('ds-refresh-all-btn');
  if (all) all.hidden = !items.some((d) => d && d.originKind);
}

// ── Freshness ────────────────────────────────────────────────────────────────
// "Data as of" reads lastRefreshedAt, falling back to updatedAt for every
// dataset that predates refresh provenance. The two are deliberately different
// fields: updatedAt moves when a dataset is renamed or its pipeline is edited,
// which does not make the DATA any newer.
function dsFreshnessText(d: any): string {
  const stamp = (d && d.lastRefreshedAt) || (d && d.updatedAt);
  const when = formatSidebarTime(stamp);
  return d && d.originKind ? 'Data as of ' + when : 'Imported ' + when;
}

/**
 * The Source column's badge text, one per `Dataset['sourceKind']` (the closed
 * set in src/datasets.ts). A kind outside it falls back to the raw string rather
 * than to a guess, so a new source shows up as itself instead of as "Unknown".
 */
const DS_SOURCE_LABELS: Record<string, string> = {
  csv: 'CSV',
  json: 'JSON',
  xlsx: 'Excel',
  paste: 'Paste',
  url: 'URL',
  postgres: 'Postgres',
  combined: 'Combined',
  capture: 'Screenshot',
};

const DS_NOT_REFRESHABLE_HINT =
  'This dataset was saved before its source was recorded, or has no re-fetchable source '
  + '(pasted text, or a screenshot capture). Re-importing the file will make it refreshable.';

function makeSavedItem(d: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ds-saved-item';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ds-saved-open';

  // Week 13 — a capture-sourced dataset gets a "Capture" badge and, when its
  // screenshot crop is still on disk, a small thumbnail that opens the original
  // in the shared lightbox (verify extracted values against the image).
  if (d && d.sourceKind === 'capture') {
    const cropPath = d.capture && d.capture.cropPath ? String(d.capture.cropPath) : '';
    if (cropPath) {
      const thumb = document.createElement('img');
      thumb.className = 'ds-cap-thumb';
      thumb.src = 'file://' + cropPath;
      thumb.alt = 'Capture screenshot';
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof openLightboxSrc === 'function') openLightboxSrc('file://' + cropPath);
      });
      open.appendChild(thumb);
    }
    const badge = document.createElement('span');
    badge.className = 'ds-cap-badge';
    badge.textContent = 'Capture';
    open.appendChild(badge);
  }

  const name = document.createElement('span');
  name.className = 'ds-saved-name';
  name.textContent = d && d.name ? String(d.name) : 'Untitled dataset';
  open.appendChild(name);

  // The row is a TABLE ROW now — rows, source and freshness are their own
  // columns rather than one run-on "12 rows · csv · 10:52" string, so they line
  // up down the list and can be compared at a glance. `.ds-saved-meta` stays on
  // the row count: it is still the cell that answers "how big is this".
  const rowCount = typeof (d && d.rowCount) === 'number' ? d.rowCount : 0;
  const meta = document.createElement('span');
  meta.className = 'ds-saved-meta ws-cell';
  meta.textContent = rowCount.toLocaleString() + (rowCount === 1 ? ' row' : ' rows');

  const kind = d && d.sourceKind ? String(d.sourceKind) : '';
  const source = document.createElement('span');
  source.className = 'ws-cell ds-source-cell';
  const badge = document.createElement('span');
  badge.className = 'ds-source-badge';
  badge.textContent = DS_SOURCE_LABELS[kind] || kind || 'Unknown';
  source.appendChild(badge);

  // Freshness line. A dataset whose last refresh FAILED keeps a warning dot
  // until the next success, so a silently stale number has a visible cause.
  const fresh = document.createElement('span');
  fresh.className = 'ds-fresh ws-cell';
  if (d && d.lastRefreshStatus === 'error') {
    const dot = document.createElement('span');
    dot.className = 'ds-fresh-dot';
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', 'Last refresh failed');
    dot.textContent = '●';
    fresh.appendChild(dot);
  }
  const freshText = document.createElement('span');
  freshText.textContent = dsFreshnessText(d);
  fresh.appendChild(freshText);
  if (!(d && d.originKind)) fresh.title = DS_NOT_REFRESHABLE_HINT;
  open.addEventListener('click', () => openSavedDataset(String(d.id)));

  // Inline status for this row's own refresh — spinner, then either nothing
  // (the row repaints) or the error text. textContent only, never innerHTML,
  // and never a window.alert.
  const status = document.createElement('span');
  status.className = 'ds-refresh-status';
  status.hidden = true;
  row.dataset.datasetId = String(d.id);

  // Cells, in the order the column labels in index.html declare them.
  row.appendChild(open);
  row.appendChild(meta);
  row.appendChild(source);
  row.appendChild(fresh);

  // The action cell. Refresh (only where there is something to re-fetch) and
  // delete sit together at the end of the row, right-aligned under "Action".
  const actions = document.createElement('span');
  actions.className = 'ws-col-action ds-row-actions';

  if (d && d.originKind) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ds-saved-refresh';
    btn.setAttribute('aria-label', 'Refresh dataset');
    btn.textContent = '↻ Refresh';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleRefreshDataset(String(d.id), btn, status);
    });
    actions.appendChild(btn);
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'ds-saved-del';
  del.setAttribute('aria-label', 'Delete dataset');
  del.textContent = '🗑';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDeleteDataset(String(d.id));
  });
  actions.appendChild(del);

  row.appendChild(actions);
  // The refresh message spans the whole row under its cells, so a long reason
  // is readable instead of being squeezed into the action column.
  row.appendChild(status);
  return row;
}

/**
 * Refresh ONE dataset, reporting into its own row.
 *
 * Returns the result so "Refresh all" can count outcomes without a second
 * channel or a second error convention. Never throws, never alerts: a failed
 * refresh is an inline line of text next to the thing that failed.
 */
async function handleRefreshDataset(
  id: string,
  btn: HTMLButtonElement | null,
  status: HTMLElement | null,
  // "Refresh all" passes false and repaints ONCE at the end; a repaint per row
  // would tear down the very buttons its loop is still holding.
  repaint = true,
): Promise<{ ok: boolean; error?: string }> {
  if (!currentProjectId) return { ok: false };
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  if (status) {
    status.hidden = false;
    status.classList.remove('is-error');
    status.textContent = 'Refreshing…';
  }
  let res: any;
  try {
    res = await window.hub.refreshDataset(currentProjectId, id);
  } catch (_) {
    res = { ok: false, error: 'Could not refresh this dataset.' };
  }
  if (btn) {
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }
  const failed = !res || res.ok === false;
  const error = failed ? ((res && res.error) || 'Could not refresh this dataset.') : '';
  // Warnings are NOT a failure — the data landed, but something in the pipeline
  // no longer fits it, and that is worth saying next to the row.
  const warnings: string[] = !failed && Array.isArray(res.warnings) ? res.warnings : [];
  const message = failed ? error : warnings.join(' · ');

  if (repaint) {
    // BOTH outcomes repaint. On success the row count and "Data as of" changed;
    // on failure the warning dot appeared. Repainting from disk rather than
    // patching the DOM means what is on screen is what was actually stored —
    // and the message is re-applied afterwards, because the summary carries
    // lastRefreshStatus (the dot) but not the reason.
    await refreshDatasetList();
    setRowRefreshStatus(id, message, failed);
  } else if (status) {
    // "Refresh all" is mid-loop and still holding this row's elements.
    status.hidden = message === '';
    status.classList.toggle('is-error', failed);
    status.textContent = message;
  }
  return failed ? { ok: false, error } : { ok: true };
}

// Put a message back on a row after a repaint has replaced it.
function setRowRefreshStatus(id: string, message: string, isError: boolean): void {
  const row = document.querySelector('#ds-saved-list .ds-saved-item[data-dataset-id="' + id + '"]');
  const status = row ? (row.querySelector('.ds-refresh-status') as HTMLElement | null) : null;
  if (!status) return;
  status.hidden = message === '';
  status.classList.toggle('is-error', isError);
  status.textContent = message;
}

// Refresh everything refreshable, SEQUENTIALLY. Not Promise.all: a serial loop
// keeps one slow or hanging source from stalling the whole UI, keeps memory flat
// (one table in flight rather than N), and lets each row update as it lands.
async function handleRefreshAll(): Promise<void> {
  if (!currentProjectId) return;
  const btn = dsEl('ds-refresh-all-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  const rows = Array.from(document.querySelectorAll('#ds-saved-list .ds-saved-item')) as HTMLElement[];
  const targets = rows
    .map((row) => ({
      id: row.dataset.datasetId || '',
      button: row.querySelector('.ds-saved-refresh') as HTMLButtonElement | null,
      status: row.querySelector('.ds-refresh-status') as HTMLElement | null,
    }))
    .filter((t) => t.id && t.button); // only the refreshable ones have a button

  let okCount = 0;
  const failures = new Map<string, string>();
  for (const t of targets) {
    const res = await handleRefreshDataset(t.id, t.button, t.status, false);
    if (res.ok) okCount += 1;
    else failures.set(t.id, res.error || 'Could not refresh this dataset.');
  }

  if (btn) btn.disabled = false;
  const failed = targets.length - okCount;
  const summary = 'Refreshed ' + okCount + ' of ' + targets.length
    + (failed > 0 ? ' · ' + failed + ' failed' : '');
  if (typeof showToast === 'function') showToast(summary);

  // Repaint so every row's timestamp and warning dot reflect what is on disk,
  // then put the failures back: the summary carries lastRefreshStatus (the dot)
  // but not the message, and "1 failed" without saying WHICH or WHY is the kind
  // of report that sends someone hunting through five datasets by hand.
  await refreshDatasetList();
  failures.forEach((message, id) => setRowRefreshStatus(id, message, true));
}

