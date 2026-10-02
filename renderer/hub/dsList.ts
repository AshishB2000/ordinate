// The saved-dataset table and how old its data is: the rows, and the freshness
// machinery behind `Data as of <time>` — per dataset, plus Refresh all.
//
// A failed refresh must leave the stored table exactly as it was, so the
// reason is shown inline and a warning stays until the next success.
//
// Split verbatim out of datasets.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

// ── Saved-dataset list ───────────────────────────────────────────────────────
// Reflect "no datasets" onto the list view so the header toolbar and the empty
// -state card are MUTUALLY EXCLUSIVE (hub.css): with no data the card is the
// focal call-to-action, so the toolbar's Import/Paste — the same two actions —
// stay hidden and appear exactly once. Once a dataset exists the toolbar takes
// over and the card is gone. Same is-* state pattern dataSection.ts already
// toggles on the panel for explore/compose.
function dsMarkEmpty(isEmpty: boolean): void {
  const view = document.querySelector('#ws-datasets .ds-list-view');
  if (view) view.classList.toggle('is-empty', isEmpty);
}

async function refreshDatasetList(): Promise<void> {
  const list = dsEl('ds-saved-list');
  const empty = dsEl('ds-saved-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    if (empty) empty.hidden = false;
    dsMarkEmpty(true);
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
  dsMarkEmpty(items.length === 0);
  await dsLoadConnKinds(items);
  items.forEach((d) => list.appendChild(makeSavedItem(d)));
  void ctAfterPaint(list, list.previousElementSibling as HTMLElement | null); // catalog tag bar + chips
  // "Refresh all" only appears when there is something it could refresh.
  const all = dsEl('ds-refresh-all-btn');
  if (all) all.hidden = !items.some((d) => d && d.originKind);
}

/**
 * connId -> connectorId, so a row imported from a connection can carry THAT
 * SOURCE's logo rather than a generic "Database" badge.
 *
 * Fetched once per list paint and cached, not per row: the summaries carry
 * `originConnId` (which connection) and the connector id lives on the
 * connection record, so without this the alternative is one IPC call per row to
 * resolve one string each. Best-effort — a row whose connection has since been
 * deleted simply falls back to the badge.
 */
const dsConnKinds = new Map<string, { kind: string; label: string }>();

async function dsLoadConnKinds(items: any[]): Promise<void> {
  if (!currentProjectId) return;
  if (!items.some((d) => d && d.originConnId)) return;
  let list: any[] = [];
  try {
    list = await window.hub.listConnections(currentProjectId);
  } catch (_) {
    return;
  }
  dsConnKinds.clear();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.id) continue;
    const kind = typeof c.kind === 'string' ? c.kind : '';
    dsConnKinds.set(String(c.id), { kind, label: String(c.name || kind || t('common.connection')) });
  }
}

// ── Freshness ────────────────────────────────────────────────────────────────
// "Data as of" reads lastRefreshedAt, falling back to updatedAt for every
// dataset that predates refresh provenance. The two are deliberately different
// fields: updatedAt moves when a dataset is renamed or its pipeline is edited,
// which does not make the DATA any newer.
function dsFreshnessText(d: any): string {
  const stamp = (d && d.lastRefreshedAt) || (d && d.updatedAt);
  const when = formatSidebarTime(stamp);
  // A schedule is part of how fresh this is, so it belongs on the same line
  // rather than in a second badge somewhere else — and it is stated as a
  // SENTENCE ("Refreshes daily · last 08:00") rather than the "auto daily"
  // shorthand, which read as a status rather than as a promise about the
  // future.
  const every = d && d.autoRefresh && d.autoRefresh.every;
  if (every) return t('dsList.refreshes_last', { every, when });
  if (d && d.originKind) return t('dsList.data_as_of', { when });
  return (d && d.sourceKind === 'input' ? t('dsList.edited') : t('dsList.imported')) + when;
}

/**
 * The Auto-refresh picker, used in BOTH places a dataset's freshness is shown:
 * its row in the list, and the explorer header. One builder, so the two cannot
 * offer different options or write through different channels.
 *
 * Only a dataset with a re-fetchable origin gets one — there is nothing to
 * schedule otherwise, and main refuses it anyway (datasets.setAutoRefresh).
 */
function dsAutoRefreshPicker(d: any, onDone?: () => void): HTMLElement | null {
  if (!d || !d.originKind) return null;
  const sel = document.createElement('select');
  sel.className = 'ds-auto-select';
  sel.setAttribute('aria-label', `Auto-refresh ${d.name || 'dataset'}`);
  const opts: Array<[string, string]> = [
    ['off', t('dsList.auto_refresh_off')],
    ['hourly', t('dsList.auto_refresh_hourly')],
    ['daily', t('dsList.auto_refresh_daily')],
    ['weekly', t('dsList.auto_refresh_weekly')],
  ];
  for (const [value, label] of opts) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = (d.autoRefresh && d.autoRefresh.every) || 'off';
  sel.addEventListener('click', (e) => e.stopPropagation()); // the row itself opens the dataset
  sel.addEventListener('change', async () => {
    const value = sel.value === 'off' ? null : sel.value;
    let res: any;
    try {
      res = await window.hub.setDatasetAutoRefresh(currentProjectId, String(d.id), value);
    } catch (_) {
      res = { ok: false };
    }
    if (!res || res.ok === false) {
      showToast(t('dsList.could_not_change_the_schedule'));
      sel.value = (d.autoRefresh && d.autoRefresh.every) || 'off';
      return;
    }
    if (onDone) onDone();
    else await refreshDatasetList();
  });
  return sel;
}

/**
 * Watch for anomalies — opt-in, and only offered where there is a schedule to
 * hang it on. Nothing re-runs without one, so there would be nothing to watch.
 *
 * The alert this enables carries an app-computed count and no model output; the
 * AI "explain anomalies" action is unchanged and stays pull, not push.
 */
function dsWatchToggle(d: any): HTMLElement | null {
  if (!d || !d.autoRefresh || !d.autoRefresh.every) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ds-watch-btn';
  const on = Boolean(d.autoRefresh.watch);
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? t('dsList.watching') : t('dsList.watch');
  btn.title = t('dsList.notify_me_when_new_anomalies_appear');
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const next = !btn.classList.contains('is-on');
    let res: any;
    try {
      res = await window.hub.setDatasetWatch(currentProjectId, String(d.id), next);
    } catch (_) {
      res = { ok: false };
    }
    if (!res || res.ok === false) {
      showToast((res && res.error) || t('dsList.could_not_change_the_watch'));
      return;
    }
    await refreshDatasetList();
  });
  return btn;
}

/**
 * The Source column's badge text, one per `Dataset['sourceKind']` (the closed
 * set in src/datasets.ts). A kind outside it falls back to the raw string rather
 * than to a guess, so a new source shows up as itself instead of as "Unknown".
 */
const DS_SOURCE_LABELS: Record<string, string> = {
  csv: 'CSV',
  json: 'JSON',
  xlsx: t('dsList.excel'),
  paste: t('dsList.paste'),
  url: 'URL',
  postgres: t('dsList.postgres'),
  combined: t('dsList.combined'),
  capture: t('common.screenshot'),
  sql: 'SQL',
  input: t('dsList.input'),
  parquet: t('dsList.parquet'),
  notebook: t('dsList.notebook'), // r7:notebooks — a notebook cell's result (nbActions.ts)
};

/** The camera mark a capture-sourced record carries, wherever it is listed. */
function dsCameraGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ds-cam-glyph');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  body.setAttribute('d', 'M3 8.5A2 2 0 0 1 5 6.5h1.2l.8-1.4A1.5 1.5 0 0 1 8.3 4.3h7.4a1.5 1.5 0 0 1 1.3.8l.8 1.4H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
  body.setAttribute('stroke', 'currentColor');
  body.setAttribute('stroke-width', '1.7');
  svg.appendChild(body);
  const lens = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  lens.setAttribute('cx', '12');
  lens.setAttribute('cy', '13');
  lens.setAttribute('r', '3.4');
  lens.setAttribute('stroke', 'currentColor');
  lens.setAttribute('stroke-width', '1.7');
  svg.appendChild(lens);
  return svg;
}

const DS_NOT_REFRESHABLE_HINT =
  t('dsList.this_dataset_was_saved_before_its');

function makeSavedItem(d: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ds-saved-item';
  row.dataset.recKind = 'dataset'; row.dataset.recId = String(d && d.id ? d.id : ''); // ⌘-click → background tab (tabStrip.ts)
  row.draggable = true; // drag out of the app as a CSV (dndOut.ts)

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
      thumb.alt = t('common.capture_screenshot');
      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof openLightboxSrc === 'function') openLightboxSrc('file://' + cropPath);
      });
      open.appendChild(thumb);
    }
    const badge = document.createElement('span');
    badge.className = 'ds-cap-badge';
    badge.textContent = t('common.capture');
    open.appendChild(badge);
  }

  const name = document.createElement('span');
  name.className = 'ds-saved-name';
  name.textContent = d && d.name ? String(d.name) : t('common.untitled_dataset');
  // Red, not the amber refresh dot: a data-quality rule is failing. The dot goes
  // straight to the Quality tab; the rest of the row still opens the grid.
  const dq = dqDot(d && d.qualityFailing);
  if (dq) {
    dq.addEventListener('click', (e) => { e.stopPropagation(); void dqOpenQualityTab(String(d.id)); });
    name.prepend(dq);
  }
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
  if (kind === 'capture') {
    // A screenshot's source is WHEN it was taken — "Screenshot" alone said less
    // than "CSV" does, because every capture-sourced dataset says it. The camera
    // is the same glyph the Captures grid and Home's Recent rows use.
    source.appendChild(dsCameraGlyph());
    const label = document.createElement('span');
    label.className = 'ds-source-badge';
    label.textContent = t('dsList.from_screenshot', { p0: formatSidebarTime((d && d.updatedAt) || null) });
    source.appendChild(label);
  } else {
    // A connection-sourced dataset shows WHICH source it came from. `csv` /
    // `postgres` are the eight display labels 35 connectors collapse onto, so
    // the badge alone reads "Postgres" for a Redshift import — the logo and the
    // connection's own name are the part that identifies it.
    const conn = d && d.originConnId ? dsConnKinds.get(String(d.originConnId)) : undefined;
    // A query over this project's datasets: the same code mark the Query tab
    // and the lineage chips carry.
    if (kind === 'sql' || kind === 'notebook') {
      const glyph = icon(kind === 'sql' ? 'code' : 'file-text', 16);
      glyph.classList.add('ds-sql-glyph');
      source.appendChild(glyph);
    }
    if (conn && typeof connMakeLogoFor === 'function') {
      const logo = connMakeLogoFor(conn.kind, conn.label);
      logo.classList.add('ds-source-logo');
      source.appendChild(logo);
    }
    const badge = document.createElement('span');
    badge.className = 'ds-source-badge';
    const def = conn && typeof connDefById === 'function' ? connDefById(conn.kind) : null;
    badge.textContent = conn ? conn.label : DS_SOURCE_LABELS[kind] || kind || t('dsList.unknown');
    if (conn) badge.title = (def ? def.label + ' · ' : '') + conn.label;
    source.appendChild(badge);
  }

  // Freshness line. A dataset whose last refresh FAILED keeps a warning dot
  // until the next success, so a silently stale number has a visible cause.
  const fresh = document.createElement('span');
  fresh.className = 'ds-fresh';
  // The dot and the sentence share one LINE element, so the cell below can be a
  // column without the dot becoming its own row — and so the line is the same
  // element whether or not there is a dot to put in it.
  const freshLine = document.createElement('span');
  freshLine.className = 'ds-fresh-line';
  if (d && d.lastRefreshStatus === 'error') {
    const dot = document.createElement('span');
    dot.className = 'ds-fresh-dot';
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', t('dsList.last_refresh_failed'));
    dot.textContent = '●';
    freshLine.appendChild(dot);
  }
  const freshText = document.createElement('span');
  freshText.textContent = dsFreshnessText(d);
  freshLine.appendChild(freshText);
  fresh.appendChild(freshLine);
  // The schedule and the anomaly watch live HERE, not in the action cell.
  // Semantically they are freshness — "Refreshes hourly · last 08:00" and the
  // control that sets it are one statement — and structurally the action cell
  // could not hold them: six controls in a 232px track overflowed LEFT across
  // the Source column, which is exactly where a connection's logo now goes.
  const auto = dsAutoRefreshPicker(d);
  if (auto) fresh.appendChild(auto);
  const watch = dsWatchToggle(d);
  if (watch) fresh.appendChild(watch);
  if (!(d && d.originKind)) fresh.title = DS_NOT_REFRESHABLE_HINT;
  // WHY it failed, on hover. A red dot whose cause is one dataset-open away is
  // a warning that makes you go and look; the row already has the reason.
  else if (d && d.lastRefreshStatus === 'error') {
    fresh.title = String(d.lastRefreshError || t('common.the_last_refresh_failed'));
  }
  open.addEventListener('click', () => openSavedDataset(String(d.id)));

  // THE WHOLE ROW opens it, not just the name. Everything from the row count to
  // the timestamp looked clickable and was not, so half the row was a dead
  // target. Every control inside the action cell already calls
  // `stopPropagation`, which is what keeps Refresh/Combine/delete from opening
  // the dataset on their way past — and the name button above stays the
  // keyboard-reachable control, so this adds a target without removing one.
  row.addEventListener('click', () => openSavedDataset(String(d.id)));

  // Inline status for this row's own refresh — spinner, then either nothing
  // (the row repaints) or the error text. textContent only, never innerHTML,
  // and never a window.alert.
  const status = document.createElement('span');
  status.className = 'ds-refresh-status';
  status.hidden = true;
  row.dataset.datasetId = String(d.id);
  ctDecorate(row, 'dataset', String(d.id), open); // catalog tag chips

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
    btn.className = 'btn btn-sm ds-saved-refresh';
    btn.setAttribute('aria-label', t('dsList.refresh_dataset'));
    iconLabel(btn, 'refresh', t('common.refresh'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleRefreshDataset(String(d.id), btn, status);
    });
    actions.appendChild(btn);
  }


  // "New visual", the row-level twin of the explorer header's primary action:
  // the most common next step after importing a table, without opening it
  // first. Ghost until the row is hovered or focus lands inside it (hub.css) —
  // present where it is wanted, not five buttons of noise down the list.
  const viz = document.createElement('button');
  viz.type = 'button';
  viz.className = 'btn btn-sm ds-saved-viz';
  viz.setAttribute('aria-label', t('dsList.new_visual_from', { p0: d && d.name ? d.name : t('dsList.this_dataset') }));
  viz.title = t('dsList.build_a_chart_from_this_dataset');
  viz.textContent = t('common.new_visual');
  viz.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof selectSection === 'function') selectSection('visuals');
    void handleNewVisual({ datasetId: String(d.id) });
  });
  actions.appendChild(viz);

  const comb = document.createElement('button');
  comb.type = 'button';
  comb.className = 'btn btn-sm ds-saved-combine';
  comb.setAttribute('aria-label', t('dsList.combine_with_another_dataset', { p0: d && d.name ? d.name : 'dataset' }));
  comb.title = t('dsList.combine_this_dataset_with_another');
  comb.textContent = t('dsList.combine');
  comb.addEventListener('click', (e) => {
    e.stopPropagation();
    void openComposerOnDataset(String(d.id), String((d && d.name) || t('common.dataset')));
  });
  actions.appendChild(comb);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn btn-sm ds-saved-del';
  // Icon-only, so the accessible name is iconOnly's aria-label; `title` is the
  // hover tooltip, which an icon with no text needs to be identifiable at all.
  // It is set first because iconOnly() only fills in a title that is missing.
  del.title = t('dsList.delete', { p0: d && d.name ? d.name : 'dataset' });
  iconOnly(del, 'trash', t('common.delete', { p0: d && d.name ? d.name : 'dataset' }));
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
    status.textContent = t('common.refreshing');
  }
  let res: any;
  try {
    res = await window.hub.refreshDataset(currentProjectId, id);
  } catch (_) {
    res = { ok: false, error: t('dsList.could_not_refresh_this_dataset') };
  }
  if (btn) {
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }
  const failed = !res || res.ok === false;
  const error = failed ? ((res && res.error) || t('dsList.could_not_refresh_this_dataset')) : '';
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

/**
 * An unattended refresh happened in main. Update THAT row in place — the
 * freshness line, the row count and any failure message — and nothing else.
 *
 * Deliberately not a list re-render: the user may be mid-scroll, mid-select or
 * typing in a control, and repainting the section under them to report a
 * background event would be the app taking the page away for its own reasons.
 */
function applyAutoRefreshOutcome(o: any): void {
  if (!o || !o.datasetId) return;
  const row = document.querySelector('#ds-saved-list .ds-saved-item[data-dataset-id="' + String(o.datasetId) + '"]');
  if (!row) return; // a different project is open, or the list is not rendered

  if (o.ok) {
    const meta = row.querySelector('.ds-saved-meta') as HTMLElement | null;
    if (meta && typeof o.rowsAfter === 'number') {
      meta.textContent = meta.textContent
        ? meta.textContent.replace(/[\d,.\u202f\u00a0\s]+rows/, `${o.rowsAfter.toLocaleString()} rows`)
        : `${o.rowsAfter.toLocaleString()} rows`;
    }
    const fresh = row.querySelector('.ds-fresh') as HTMLElement | null;
    // "just now" through the same formatter every other stamp uses, so the
    // wording matches the rest of the column rather than being a special case.
    if (fresh) {
      const every = fresh.textContent && fresh.textContent.indexOf(' · auto ') >= 0
        ? fresh.textContent.slice(fresh.textContent.indexOf(' · auto '))
        : '';
      fresh.textContent = t('dsList.data_as_of_2', { p0: formatSidebarTime(new Date().toISOString()), every });
    }
  }
  setRowRefreshStatus(String(o.datasetId), o.ok ? '' : String(o.error || t('dsList.refresh_failed')), !o.ok);
}

if (window.hub && typeof window.hub.onDatasetRefreshed === 'function') {
  window.hub.onDatasetRefreshed((o) => applyAutoRefreshOutcome(o));
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
  for (const tv of targets) {
    const res = await handleRefreshDataset(tv.id, tv.button, tv.status, false);
    if (res.ok) okCount += 1;
    else failures.set(tv.id, res.error || t('dsList.could_not_refresh_this_dataset'));
  }

  if (btn) btn.disabled = false;
  const failed = targets.length - okCount;
  const summary = t('dsList.refreshed_of', { okCount, targetsCount: targets.length, p2: (failed > 0 ? ' · ' + failed + ' failed' : '') });
  if (typeof showToast === 'function') showToast(summary);

  // Repaint so every row's timestamp and warning dot reflect what is on disk,
  // then put the failures back: the summary carries lastRefreshStatus (the dot)
  // but not the message, and "1 failed" without saying WHICH or WHY is the kind
  // of report that sends someone hunting through five datasets by hand.
  await refreshDatasetList();
  failures.forEach((message, id) => setRowRefreshStatus(id, message, true));
}

