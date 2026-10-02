// Incremental refresh — the panel on a connection or folder dataset's page.
//
// A collapsible strip under the page header: on/off and the last run in one
// line; open, the settings (cursor, key, lookback), "Full refresh now", how
// this source fetches (filtered at the source, changed files only, or filtered
// after the fetch) and the refresh log — fetched / inserted / updated / the new
// high-water mark, per run. Every figure is main's (src/ipc/incremental.ts);
// nothing here counts a row. dsExplorer.renderExplorerIdent calls incPaint.

/** Open/closed survives a reopen of the page (a refresh reopens it). */
let incOpen = false;

const INC_HOW: Record<string, string> = {
  server: 'filtered at the source',
  files: 'changed files, filtered at read',
  after: 'filtered after fetch',
  unchanged: 'no file changed',
  full: 'full refresh',
};

const INC_UNITS: Array<{ label: string; secs: number }> = [
  { label: 'days', secs: 86_400 },
  { label: 'hours', secs: 3_600 },
  { label: 'minutes', secs: 60 },
];

function incEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const incNum = (n: unknown): string => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const incMark = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

function incWhen(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Paint (or hide) the panel for the dataset whose page is open. */
async function incPaint(d: any): Promise<void> {
  const host = dsEl('inc-panel');
  if (!host) return;
  const id = String((d && d.id) || '');
  host.dataset.datasetId = id;
  const eligible = !!(d && d.origin && d.origin.kind === 'connection' && currentProjectId && window.hubIncremental);
  if (!eligible) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  let view: any;
  try {
    view = await window.hubIncremental.get(currentProjectId as string, id);
  } catch (_) {
    view = null;
  }
  if (host.dataset.datasetId !== id) return; // another dataset opened meanwhile
  if (!view || !view.ok || !view.eligible) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  incRender(host, id, view);
}

function incSummary(view: any): string {
  const s = view.settings;
  if (!s || !s.enabled) return 'Off — every refresh fetches the whole source';
  const parts = ['Cursor ' + s.cursorColumn];
  if (s.keyColumn) parts.push('key ' + s.keyColumn);
  parts.push('high-water ' + incMark(s.highWater));
  const last = s.log && s.log[0];
  if (last) {
    parts.push(last.mode === 'full'
      ? 'last run full, ' + incNum(last.fetched) + ' rows'
      : 'last run ' + incNum(last.fetched) + ' fetched, ' + incNum(last.inserted) + ' inserted, ' + incNum(last.updated) + ' updated');
  }
  return parts.join(' · ');
}

function incRender(host: HTMLElement, id: string, view: any): void {
  const s = view.settings || null;
  const on = !!(s && s.enabled);
  host.hidden = false;
  host.replaceChildren();

  const det = incEl('details', 'inc-details');
  det.open = incOpen;
  det.addEventListener('toggle', () => { incOpen = det.open; });
  const sum = incEl('summary', 'inc-sum');
  sum.appendChild(incEl('span', 'inc-title', 'Incremental refresh'));
  sum.appendChild(incEl('span', 'inc-pill' + (on ? ' is-on' : ''), on ? 'On' : 'Off'));
  sum.appendChild(incEl('span', 'inc-sum-text', incSummary(view)));
  det.appendChild(sum);

  const body = incEl('div', 'inc-body');
  body.appendChild(incForm(id, view));
  body.appendChild(incHow(view));
  body.appendChild(incLog(s));
  det.appendChild(body);
  host.appendChild(det);
}

function incField(label: string, control: HTMLElement): HTMLElement {
  const f = incEl('label', 'inc-field');
  f.appendChild(incEl('span', 'inc-field-label', label));
  f.appendChild(control);
  return f;
}

function incForm(id: string, view: any): HTMLElement {
  const s = view.settings || null;
  const form = incEl('div', 'inc-form');
  if (!view.cursorColumns.length) {
    form.appendChild(incEl('p', 'inc-empty', 'This dataset has no number or date column to use as a cursor, so it can only refresh in full.'));
    return form;
  }

  const enabled = incEl('input');
  enabled.type = 'checkbox';
  enabled.id = 'inc-enabled';
  enabled.checked = !!(s && s.enabled);
  const check = incEl('label', 'inc-check');
  check.appendChild(enabled);
  check.appendChild(document.createTextNode(' Refresh incrementally'));
  form.appendChild(check);

  const cursor = incEl('select');
  cursor.id = 'inc-cursor';
  for (const c of view.cursorColumns) {
    const o = incEl('option', undefined, c.name + (c.type === 'date' ? ' (date)' : ' (number)'));
    o.value = c.name;
    cursor.appendChild(o);
  }
  cursor.value = s && view.cursorColumns.some((c: any) => c.name === s.cursorColumn) ? s.cursorColumn : view.cursorColumns[0].name;
  form.appendChild(incField('Cursor column', cursor));

  const key = incEl('select');
  key.id = 'inc-key';
  const none = incEl('option', undefined, 'None — append new rows');
  none.value = '';
  key.appendChild(none);
  for (const n of view.keyColumns) {
    const o = incEl('option', undefined, n);
    o.value = n;
    key.appendChild(o);
  }
  key.value = (s && s.keyColumn) || '';
  form.appendChild(incField('Key column (upsert)', key));

  const amount = incEl('input');
  amount.type = 'number';
  amount.min = '0';
  amount.step = 'any';
  amount.id = 'inc-lookback';
  amount.className = 'inc-lookback-n';
  const unit = incEl('select');
  unit.id = 'inc-unit';
  unit.className = 'inc-lookback-u';
  const idUnit = incEl('span', 'inc-lookback-ids', 'ids');
  const wrap = incEl('span', 'inc-lookback');
  wrap.append(amount, unit, idUnit);
  form.appendChild(incField('Lookback', wrap));

  const typeOf = (): string => (view.cursorColumns.find((c: any) => c.name === cursor.value) || {}).type;
  const syncUnit = (secs: number): void => {
    const isDate = typeOf() === 'date';
    unit.hidden = !isDate;
    idUnit.hidden = isDate;
    unit.replaceChildren();
    for (const u of INC_UNITS) {
      const o = incEl('option', undefined, u.label);
      o.value = String(u.secs);
      unit.appendChild(o);
    }
    if (isDate) {
      const u = INC_UNITS.find((x) => secs > 0 && secs % x.secs === 0) || INC_UNITS[0];
      unit.value = String(u.secs);
      amount.value = secs > 0 ? String(secs / u.secs) : '0';
    } else {
      amount.value = String(secs || 0);
    }
  };
  syncUnit(s && s.cursorColumn === cursor.value ? s.lookback : 0);
  cursor.addEventListener('change', () => syncUnit(0));

  const actions = incEl('div', 'inc-actions');
  const save = incEl('button', 'btn btn-primary btn-sm', 'Save');
  save.type = 'button';
  save.id = 'inc-save';
  const full = incEl('button', 'btn btn-sm', 'Full refresh now');
  full.type = 'button';
  full.id = 'inc-full';
  full.disabled = !(s && s.enabled);
  full.title = full.disabled ? 'Turn incremental refresh on first' : 'Re-fetch everything and reset the high-water mark';
  const msg = incEl('span', 'inc-msg');
  msg.id = 'inc-msg';
  msg.setAttribute('role', 'status');
  actions.append(save, full, msg);
  form.appendChild(actions);

  save.addEventListener('click', async () => {
    const n = Number(amount.value || 0);
    const lookback = typeOf() === 'date' ? n * Number(unit.value) : n;
    save.disabled = true;
    let res: any;
    try {
      res = await window.hubIncremental.set(currentProjectId as string, id, {
        enabled: enabled.checked, cursorColumn: cursor.value, keyColumn: key.value, lookback,
      });
    } catch (_) {
      res = { ok: false, error: 'Could not save the settings.' };
    }
    save.disabled = false;
    if (!res || !res.ok) {
      msg.textContent = (res && res.error) || 'Could not save the settings.';
      msg.classList.add('is-error');
      return;
    }
    incOpen = true;
    incRender(dsEl('inc-panel') as HTMLElement, id, res);
    const again = dsEl('inc-msg');
    if (again) again.textContent = 'Saved';
  });

  full.addEventListener('click', async () => {
    full.disabled = true;
    msg.classList.remove('is-error');
    msg.textContent = 'Full refresh…';
    const flagged = await window.hubIncremental.requestFull(currentProjectId as string, id).catch(() => null);
    if (!flagged || !flagged.ok) {
      full.disabled = false;
      msg.textContent = (flagged && flagged.error) || 'Could not start a full refresh.';
      msg.classList.add('is-error');
      return;
    }
    incOpen = true;
    // The ordinary refresh, with its row status and job; then the page reopens
    // so the grid, the header and this log all describe the data just fetched.
    await handleRefreshDataset(id, full, null);
    await openSavedDataset(id);
  });
  return form;
}

function incHow(view: any): HTMLElement {
  const p = incEl('p', 'inc-how');
  const fetch = view.fetch === 'server'
    ? `Rows past the high-water mark are requested from ${view.source} itself.`
    : view.fetch === 'files'
      ? 'Only files changed since the last run are re-read, and only rows past the high-water mark are kept.'
      : `${view.source} cannot filter on the server, so each run fetches as before and rows are filtered after fetch.`;
  p.textContent = `${fetch} With a key column, a fetched row replaces the stored row with the same key; without one, new rows are appended and rows already stored are not added twice. Every ${view.fullEvery}th run is a full refresh, to correct drift.`;
  return p;
}

function incLog(s: any): HTMLElement {
  const wrap = incEl('div', 'inc-log-wrap');
  wrap.appendChild(incEl('h4', 'inc-log-title', 'Refresh log'));
  const log: any[] = (s && s.log) || [];
  if (!log.length) {
    wrap.appendChild(incEl('p', 'inc-empty', 'No runs yet. The first refresh is a full one and sets the high-water mark.'));
    return wrap;
  }
  const table = incEl('table', 'inc-log');
  const head = incEl('tr');
  for (const h of ['When', 'Run', 'Fetched', 'Inserted', 'Updated', 'High-water mark']) head.appendChild(incEl('th', undefined, h));
  const thead = incEl('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = incEl('tbody');
  for (const e of log) {
    const tr = incEl('tr', 'inc-log-row is-' + e.mode);
    tr.appendChild(incEl('td', 'inc-when', incWhen(e.at)));
    const run = incEl('td', 'inc-run');
    run.appendChild(incEl('span', 'inc-mode', e.mode === 'full' ? 'Full' : 'Incremental'));
    run.appendChild(incEl('span', 'inc-run-how', e.mode === 'full' ? (e.note || INC_HOW.full) : (INC_HOW[e.how] || e.how)));
    if (e.note && e.mode !== 'full') run.title = e.note;
    tr.appendChild(run);
    tr.appendChild(incEl('td', 'inc-n inc-fetched', incNum(e.fetched)));
    tr.appendChild(incEl('td', 'inc-n inc-inserted', incNum(e.inserted)));
    tr.appendChild(incEl('td', 'inc-n inc-updated', incNum(e.updated)));
    tr.appendChild(incEl('td', 'inc-mark', incMark(e.highWater)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}
