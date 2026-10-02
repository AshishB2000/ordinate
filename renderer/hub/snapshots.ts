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
  const tab = snapEl<HTMLButtonElement>('button', 'ds-tab tab', t('snapshots.snapshots'));
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
  label.appendChild(document.createTextNode(t('snapshots.keep')));
  const sel = snapEl<HTMLSelectElement>('select', 'snap-keep-select');
  sel.id = 'snap-keep';
  const choices = SNAP_KEEP_CHOICES.includes(keep) ? SNAP_KEEP_CHOICES : SNAP_KEEP_CHOICES.concat([keep]).sort((a, b) => a - b);
  for (const n of choices) {
    const o = snapEl<HTMLOptionElement>('option', '', n === 0 ? t('snapshots.none_off') : t('snapshots.the_last', { n }));
    o.value = String(n);
    sel.appendChild(o);
  }
  sel.value = String(keep);
  sel.addEventListener('change', async () => {
    let r: any = null;
    try { r = await window.hubSnapshots.setKeep(currentProjectId, datasetId, Number(sel.value)); } catch (_) { r = null; }
    if (!r || r.ok === false) {
      showToast((r && r.error) || t('snapshots.could_not_change_how_many_snapshots'), { kind: 'error' });
    } else if (r.removed) {
      showToast(t('snapshots.removed_older', { removed: r.removed }), { kind: 'info' });
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
  text.appendChild(snapEl('strong', '', t('snapshots.only_datasets_with_a_schedule_or')));
  text.appendChild(snapEl('span', '', res.refreshable
    ? t('snapshots.turn_on_auto_refresh_above_to')
    : t('snapshots.this_dataset_has_no_source_to')));
  box.appendChild(text);
  return box;
}

function snapEmpty(keep: number): HTMLElement {
  const box = snapEl('div', 'ws-empty snap-empty');
  const art = snapEl('span', 'ws-empty-icon');
  art.setAttribute('aria-hidden', 'true');
  art.appendChild(icon('history', 20));
  box.appendChild(art);
  box.appendChild(snapEl('h4', 'ws-empty-h', t('snapshots.snapshots_start_with_the_next_refresh')));
  box.appendChild(snapEl('p', 'ws-empty-p', keep > 0
    ? t('snapshots.when_a_refresh_replaces_this_table', { keep })
    : t('snapshots.keeping_is_off_for_this_dataset')));
  return box;
}

function snapTable(res: any, datasetId: string): HTMLElement {
  const table = snapEl<HTMLTableElement>('table', 'snap-table');
  const head = table.createTHead().insertRow();
  for (const h of [t('common.data_as_of'), t('common.rows'), t('snapshots.vs_now'), '']) head.appendChild(snapEl('th', '', h));
  const body = table.createTBody();
  const labels = snapWhenAll([res.current.at].concat(res.items.map((s: any) => s.at)));

  const cur = body.insertRow();
  cur.className = 'snap-row is-current';
  const when = cur.insertCell();
  when.appendChild(snapEl('span', 'snap-when', labels[0]));
  when.appendChild(snapEl('span', 'snap-tag', t('common.current')));
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
    delta.textContent = d === 0 ? t('snapshots.same_rows') : t('snapshots.since', { p0: !!(d > 0), p1: Math.abs(d).toLocaleString('en-US') });
    const act = tr.insertCell();
    act.className = 'snap-actions';
    const cmp = snapEl<HTMLButtonElement>('button', 'btn btn-sm js-snap-compare', t('common.compare'));
    cmp.type = 'button';
    cmp.addEventListener('click', () => void snapOpenDiff(datasetId, s, res.current));
    const rst = snapEl<HTMLButtonElement>('button', 'btn btn-sm js-snap-restore');
    rst.type = 'button';
    iconLabel(rst, 'rotate-ccw', t('snapshots.restore'));
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
    host.appendChild(snapEl('p', 'snap-error', (res && res.error) || t('snapshots.could_not_read_the_snapshots')));
    return;
  }
  const head = snapEl('div', 'snap-head');
  const ident = snapEl('div', 'snap-ident');
  ident.appendChild(snapEl('h4', 'snap-h', t('snapshots.snapshots')));
  ident.appendChild(snapEl('p', 'snap-sub', res.items.length
    ? t('snapshots.kept_each_is_the_table_as', { itemsCount: res.items.length })
    : t('snapshots.a_copy_of_the_table_kept')));
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
    title: t('snapshots.restore_this_snapshot'),
    body: [
      t('snapshots.the_data_goes_back_to_how', { at: snapWhen(s.at), rowCount: snapRows(s.rowCount) }),
      t('snapshots.the_data_as_it_is_now'),
    ],
    ok: t('common.restore'),
  });
  if (!ok) return;
  let r: any = null;
  try { r = await window.hubSnapshots.restore(currentProjectId, datasetId, s.stamp); } catch (_) { r = null; }
  if (!r || r.ok === false) {
    showToast((r && r.error) || t('snapshots.could_not_restore_the_snapshot'), { kind: 'error' });
    return;
  }
  showToast(t('snapshots.restored_the_data_as_of', { at: snapWhen(s.at) }), { kind: 'success' });
  await refreshDatasetList();
  if (expId === datasetId) {
    await openSavedDataset(datasetId);
    dxSelectTab('ds-tab-snapshots');
  }
}
