'use strict';

// The dataset page's Snapshots tab: the versions kept on refresh, how many to
// keep, Compare (snapshotDiffView.ts) and Restore.
// Classic global-scope renderer <script>: no import/export.
//
// The tab and its panel are built HERE, at load, rather than in index.html (the
// shared markup takes a feature's additions only below its marker); the tab
// strip's own code (dataSection.ts DX_TABS) selects it like any other and calls
// `snapPaintTab` when it is chosen. Every figure is main's: row counts come off
// the snapshot index, and a restore goes through main's refresh path.

const SNAP_KEEP_CHOICES = [0, 3, 5, 10, 20, 50, 100];

/** The dataset the tab last painted, so a late reply for another one is dropped. */
let snapPaintSeq = 0;

function snapEl<T extends HTMLElement>(tag: string, cls?: string, text?: string): T {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** "Sep 26, 9:44 PM" — the year only when it is not this one, seconds only when asked. */
function snapWhen(iso: string, seconds = false): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  if (seconds) opts.second = '2-digit';
  return d.toLocaleString([], opts);
}

/** Labels for a list of times: with seconds when two would otherwise read the same. */
function snapWhenAll(isos: string[]): string[] {
  const plain = isos.map((t) => snapWhen(t));
  return new Set(plain).size === plain.length ? plain : isos.map((t) => snapWhen(t, true));
}

function snapRows(n: number): string {
  return Number(n || 0).toLocaleString('en-US') + (n === 1 ? ' row' : ' rows');
}

// Built at load: the tab after Columns, the panel after Columns' panel.
(function snapMountTab(): void {
  const after = document.getElementById('ds-tab-columns');
  const afterPanel = document.getElementById('ds-tabp-columns');
  if (!after || !afterPanel || document.getElementById('ds-tab-snapshots')) return;
  const tab = snapEl<HTMLButtonElement>('button', 'ds-tab tab', 'Snapshots');
  tab.type = 'button';
  tab.id = 'ds-tab-snapshots';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.setAttribute('aria-controls', 'ds-tabp-snapshots');
  tab.tabIndex = -1;
  after.after(tab);
  const panel = snapEl<HTMLDivElement>('div', 'ds-tabp');
  panel.id = 'ds-tabp-snapshots';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'ds-tab-snapshots');
  panel.hidden = true;
  panel.appendChild(snapEl('div', 'snap-body')).id = 'snap-body';
  afterPanel.after(panel);
  // The schedule picker in the header is rebuilt from disk after it changes;
  // that is when eligibility may have changed, so repaint then.
  const auto = document.getElementById('ds-explorer-auto');
  if (auto) {
    new MutationObserver(() => {
      if (tab.getAttribute('aria-selected') === 'true') void snapPaintTab();
    }).observe(auto, { childList: true });
  }
})();

function snapKeepSelect(keep: number, datasetId: string): HTMLElement {
  const label = snapEl<HTMLLabelElement>('label', 'snap-keep');
  label.appendChild(document.createTextNode('Keep '));
  const sel = snapEl<HTMLSelectElement>('select', 'snap-keep-select');
  sel.id = 'snap-keep';
  const choices = SNAP_KEEP_CHOICES.includes(keep) ? SNAP_KEEP_CHOICES : SNAP_KEEP_CHOICES.concat([keep]).sort((a, b) => a - b);
  for (const n of choices) {
    const o = snapEl<HTMLOptionElement>('option', '', n === 0 ? 'none (off)' : `the last ${n}`);
    o.value = String(n);
    sel.appendChild(o);
  }
  sel.value = String(keep);
  sel.addEventListener('change', async () => {
    let r: any = null;
    try { r = await window.hubSnapshots.setKeep(currentProjectId, datasetId, Number(sel.value)); } catch (_) { r = null; }
    if (!r || r.ok === false) {
      showToast((r && r.error) || 'Could not change how many snapshots are kept.', { kind: 'error' });
    } else if (r.removed) {
      showToast(`Removed ${r.removed} older snapshot${r.removed === 1 ? '' : 's'}.`, { kind: 'info' });
    }
    await snapPaintTab();
  });
  label.appendChild(sel);
  return label;
}

function snapNotice(res: any): HTMLElement {
  const box = snapEl('div', 'snap-notice');
  box.appendChild(icon('calendar', 16));
  const text = snapEl('div', 'snap-notice-text');
  text.appendChild(snapEl('strong', '', 'Only datasets with a schedule or a connection keep snapshots.'));
  text.appendChild(snapEl('span', '', res.refreshable
    ? ' Turn on Auto-refresh above to keep a copy each time this dataset refreshes.'
    : ' This dataset has no source to refresh from, so it never changes on its own.'));
  box.appendChild(text);
  return box;
}

function snapEmpty(keep: number): HTMLElement {
  const box = snapEl('div', 'ws-empty snap-empty');
  const art = snapEl('span', 'ws-empty-icon');
  art.setAttribute('aria-hidden', 'true');
  art.appendChild(icon('history', 20));
  box.appendChild(art);
  box.appendChild(snapEl('h4', 'ws-empty-h', 'Snapshots start with the next refresh'));
  box.appendChild(snapEl('p', 'ws-empty-p', keep > 0
    ? `When a refresh replaces this table, the table it replaces is kept here — the last ${keep}, oldest dropped first. Compare any of them with now, or restore one.`
    : 'Keeping is off for this dataset. Choose how many to keep above to start.'));
  return box;
}

function snapTable(res: any, datasetId: string): HTMLElement {
  const table = snapEl<HTMLTableElement>('table', 'snap-table');
  const head = table.createTHead().insertRow();
  for (const h of ['Data as of', 'Rows', 'vs now', '']) head.appendChild(snapEl('th', '', h));
  const body = table.createTBody();
  const labels = snapWhenAll([res.current.at].concat(res.items.map((s: any) => s.at)));

  const cur = body.insertRow();
  cur.className = 'snap-row is-current';
  const when = cur.insertCell();
  when.appendChild(snapEl('span', 'snap-when', labels[0]));
  when.appendChild(snapEl('span', 'snap-tag', 'Current'));
  cur.insertCell().textContent = snapRows(res.current.rowCount);
  cur.insertCell().textContent = '—';
  cur.insertCell();

  res.items.forEach((s: any, i: number) => {
    const tr = body.insertRow();
    tr.className = 'snap-row';
    tr.dataset.stamp = s.stamp;
    const w = tr.insertCell();
    w.appendChild(snapEl('span', 'snap-when', labels[i + 1]));
    w.appendChild(snapEl('span', 'snap-ago', jpAgo(s.at)));
    tr.insertCell().textContent = snapRows(s.rowCount);
    const d = res.current.rowCount - s.rowCount;
    const delta = tr.insertCell();
    delta.className = 'snap-delta' + (d > 0 ? ' is-up' : d < 0 ? ' is-down' : '');
    delta.textContent = d === 0 ? 'same rows' : `${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')} since`;
    const act = tr.insertCell();
    act.className = 'snap-actions';
    const cmp = snapEl<HTMLButtonElement>('button', 'btn btn-sm js-snap-compare', 'Compare');
    cmp.type = 'button';
    cmp.addEventListener('click', () => void snapOpenDiff(datasetId, s, res.current));
    const rst = snapEl<HTMLButtonElement>('button', 'btn btn-sm js-snap-restore');
    rst.type = 'button';
    iconLabel(rst, 'rotate-ccw', 'Restore…');
    rst.addEventListener('click', () => void snapRestore(datasetId, s));
    act.append(cmp, rst);
  });
  return table;
}

/** Paint the tab for the open dataset. Called when the tab is selected. */
async function snapPaintTab(): Promise<void> {
  const host = document.getElementById('snap-body');
  const id = expId;
  if (!host || !id || !currentProjectId || !window.hubSnapshots) return;
  const seq = ++snapPaintSeq;
  let res: any = null;
  try { res = await window.hubSnapshots.list(currentProjectId, id); } catch (_) { res = null; }
  if (seq !== snapPaintSeq || expId !== id) return; // another paint or another dataset won
  host.innerHTML = '';
  if (!res || res.ok === false) {
    host.appendChild(snapEl('p', 'snap-error', (res && res.error) || 'Could not read the snapshots.'));
    return;
  }
  const head = snapEl('div', 'snap-head');
  const ident = snapEl('div', 'snap-ident');
  ident.appendChild(snapEl('h4', 'snap-h', 'Snapshots'));
  ident.appendChild(snapEl('p', 'snap-sub', res.items.length
    ? `${res.items.length} kept · each is the table as it was before a refresh replaced it`
    : 'A copy of the table, kept each time a refresh replaces it'));
  head.appendChild(ident);
  if (res.eligible || res.items.length) head.appendChild(snapKeepSelect(res.keep, id));
  host.appendChild(head);
  if (!res.eligible) host.appendChild(snapNotice(res));
  if (res.items.length) {
    host.appendChild(snapTable(res, id));
    host.appendChild(snapEl('div', 'snap-diff')).id = 'snap-diff';
  } else if (res.eligible) {
    host.appendChild(snapEmpty(res.keep));
  }
}

async function snapRestore(datasetId: string, s: any): Promise<void> {
  const ok = await syAsk({
    icon: 'rotate-ccw', tone: 'warn',
    title: 'Restore this snapshot?',
    body: [
      `The data goes back to how it was on ${snapWhen(s.at)} — ${snapRows(s.rowCount)}. Charts and dashboards on this dataset follow.`,
      'The data as it is now is kept as a snapshot first, so you can come back to it.',
    ],
    ok: 'Restore',
  });
  if (!ok) return;
  let r: any = null;
  try { r = await window.hubSnapshots.restore(currentProjectId, datasetId, s.stamp); } catch (_) { r = null; }
  if (!r || r.ok === false) {
    showToast((r && r.error) || 'Could not restore the snapshot.', { kind: 'error' });
    return;
  }
  showToast(`Restored the data as of ${snapWhen(s.at)}.`, { kind: 'success' });
  await refreshDatasetList();
  if (expId === datasetId) {
    await openSavedDataset(datasetId);
    dxSelectTab('ds-tab-snapshots');
  }
}
