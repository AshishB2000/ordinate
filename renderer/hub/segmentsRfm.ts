'use strict';

// Find segments — the RFM tab: pick a customer id, an order date and an
// amount; every customer is scored 1–5 on recency, frequency and monetary
// value and lands in one of eleven named segments. Shows the breakdown, the
// R × FM map it was scored on, and Save as dataset (a customer-level table
// through the ordinary save path). Classic global-scope script; loads after
// segments.js and segmentsView.js.
//
// Every figure is main's (src/analysis/rfm.ts RfmResult).

let sgRfmResult: any = null;
let sgRfmSpec: { id: string; date: string; amount: string } | null = null;

/** A segment's tone class — its position in the canonical eleven (main's order). */
function sgRfmTone(name: string): string {
  const list = sgRfmResult ? sgRfmResult.segments.map((s: any) => s.name) : [];
  const i = list.indexOf(name);
  return `sg-rfm-t${i < 0 ? 10 : i}`;
}

function sgRfmSelect(id: string, label: string, options: Array<{ name: string; type: string }>, chosen: string): HTMLElement {
  const field = sgEl('div', 'sg-rfm-field');
  const l = sgEl<HTMLLabelElement>('label', 'sg-field', label);
  l.htmlFor = id;
  const sel = sgEl<HTMLSelectElement>('select', 'sg-rfm-select');
  sel.id = id;
  const blank = sgEl<HTMLOptionElement>('option', '', t('segmentsRfm.pick_a_column'));
  blank.value = '';
  sel.appendChild(blank);
  for (const c of options) {
    const o = sgEl<HTMLOptionElement>('option', '', c.name);
    o.value = c.name;
    if (c.name === chosen) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => sgRfmSync());
  field.append(l, sel);
  return field;
}

function sgRfmPicked(): { id: string; date: string; amount: string } {
  const v = (id: string): string => (document.getElementById(id) as HTMLSelectElement | null)?.value || '';
  return { id: v('sg-rfm-id'), date: v('sg-rfm-date'), amount: v('sg-rfm-amount') };
}

function sgRfmSync(): void {
  const s = sgRfmPicked();
  const run = document.getElementById('sg-rfm-run') as HTMLButtonElement | null;
  const distinct = new Set([s.id, s.date, s.amount]).size === 3;
  if (run) run.disabled = !s.id || !s.date || !s.amount || !distinct || !!sgBusy;
}

function sgPaintRfm(): void {
  const host = document.getElementById('sg-tabp-rfm');
  if (!host || !sgInfo) return;
  host.textContent = '';
  const info = sgInfo;
  const card = sgEl('section', 'sg-card sg-setup');
  card.setAttribute('aria-labelledby', 'sg-rfm-h');
  const head = sgEl('div', 'sg-card-head');
  const h = sgEl('h3', 'sg-card-h', t('segmentsRfm.who_when_and_how_much'));
  h.id = 'sg-rfm-h';
  head.append(h, sgEl('p', 'sg-hint',
    t('segmentsRfm.one_row_per_order_recency_is')));
  const fields = sgEl('div', 'sg-rfm-fields');
  const nums = info.columns.filter((c) => c.type === 'number');
  fields.append(
    sgRfmSelect('sg-rfm-id', t('segmentsRfm.customer_id'), info.columns, info.rfm.id),
    sgRfmSelect('sg-rfm-date', t('segmentsRfm.order_date'), info.columns, info.rfm.date),
    sgRfmSelect('sg-rfm-amount', t('segmentsRfm.amount'), nums, info.rfm.amount),
  );
  const row = sgEl('div', 'sg-run-row');
  const run = sgButton('btn btn-primary', 'play', t('segmentsRfm.score_customers'), () => void sgRfmRun());
  run.id = 'sg-rfm-run';
  row.append(run, sgEl('span', 'sg-run-hint', t('segmentsRfm.rows_without_an_id_a_readable')));
  card.append(head, fields, row, sgProgressBox('rfm'), sgErrorLine('rfm'));
  const results = sgEl('div', 'sg-results');
  results.id = 'sg-rfm-results';
  host.append(card, results);
  sgRfmSync();
  sgRfmPaintResults();
}

async function sgRfmRun(): Promise<void> {
  if (!sgInfo || sgBusy) return;
  const spec = sgRfmPicked();
  const info = sgInfo;
  const seq = sgSeq;
  sgBusy = 'rfm';
  sgShowError('rfm', '');
  sgRfmSync();
  sgProgress('rfm', true, 0, t('common.starting'));
  sgWatchJob(info.datasetId, 'rfm');
  let res: any;
  try {
    res = await window.hubSegments.rfm(info.projectId, info.datasetId, spec);
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : t('segmentsRfm.could_not_score_the_customers') };
  }
  sgStopWatch();
  sgBusy = '';
  if (seq !== sgSeq) return;
  sgProgress('rfm', false);
  sgRfmSync();
  if (!res || !res.ok) {
    if (res && res.cancelled) sgShowError('rfm', t('common.stopped_nothing_was_changed'), true);
    else sgShowError('rfm', (res && res.error) || t('segmentsRfm.could_not_score_the_customers_2'));
    return;
  }
  sgRfmResult = res.result;
  sgRfmSpec = spec;
  sgRfmPaintResults();
}

function sgRfmPaintResults(): void {
  const host = document.getElementById('sg-rfm-results');
  if (!host) return;
  host.textContent = '';
  const r = sgRfmResult;
  if (!r) {
    host.appendChild(sgEmpty('user', t('segmentsRfm.score_customers_by_recency_frequency_and'),
      t('segmentsRfm.every_customer_gets_a_1_5')));
    return;
  }
  const kpis = sgEl('div', 'sg-kpis');
  kpis.append(
    sgKpi(sgFmt(r.customers), 'customers'),
    sgKpi(sgFmt(r.used), t('segmentsRfm.orders_scored')),
    sgKpi(r.asOf || '—', t('segmentsRfm.recency_measured_from')),
    sgKpi(sgFmt(r.skipped), r.skipped === 1 ? t('segmentsRfm.row_left_out') : t('segmentsRfm.rows_left_out')),
  );
  const pair = sgEl('div', 'sg-pair sg-pair--wide');
  pair.append(sgRfmGrid(r), sgRfmSaveCard(r));
  host.append(kpis, sgRfmTable(r), pair);
}

function sgRfmTable(r: any): HTMLElement {
  const card = sgCard('sg-rfm-segs', t('segmentsRfm.segments'), t('segmentsRfm.all_eleven_with_how_many_customers'));
  const scroll = sgEl('div', 'sg-table-scroll');
  const tv = sgEl<HTMLTableElement>('table', 'sg-table sg-rfm-table');
  tv.id = 'sg-rfm-table';
  const hr = tv.createTHead().insertRow();
  for (const [text, cls] of [[t('segmentsRfm.segment'), ''], [t('segmentsRfm.customers'), 'sg-num'], [t('common.share'), ''], [t('segmentsRfm.days_since_last_order'), 'sg-num'], [t('common.orders'), 'sg-num'], [t('segmentsRfm.spend'), 'sg-num']]) {
    const th = sgEl<HTMLTableCellElement>('th', cls, text);
    th.scope = 'col';
    hr.appendChild(th);
  }
  const body = tv.createTBody();
  for (const s of r.segments) {
    const tr = body.insertRow();
    tr.className = 'sg-rfm-row' + (s.count ? '' : ' is-none');
    tr.dataset.segment = s.name;
    const name = sgEl<HTMLTableCellElement>('th', 'sg-rfm-name');
    name.scope = 'row';
    const sw = sgEl('span', 'sg-swatch sg-rfm-swatch ' + sgRfmTone(s.name));
    sw.setAttribute('aria-hidden', 'true');
    const text = sgEl('span', 'sg-rfm-text');
    text.append(sgEl('span', 'sg-rfm-label', s.name), sgEl('span', 'sg-rfm-meaning', s.meaning));
    name.append(sw, text);
    tr.appendChild(name);
    tr.appendChild(sgEl('td', 'sg-num sg-rfm-count', sgFmt(s.count)));
    const share = sgEl('td', 'sg-rfm-share');
    const track = sgEl('span', 'sg-size-track');
    const bar = sgEl('span', 'sg-size-bar sg-rfm-bar ' + sgRfmTone(s.name));
    bar.style.width = `${Math.max(s.count ? 1 : 0, s.share * 100)}%`;
    track.appendChild(bar);
    share.append(track, sgEl('span', 'sg-rfm-pct', sgPct(s.share)));
    tr.appendChild(share);
    tr.appendChild(sgEl('td', 'sg-num', s.recency === null ? '—' : sgFmt(s.recency, 0)));
    tr.appendChild(sgEl('td', 'sg-num', s.frequency === null ? '—' : sgFmt(s.frequency, 1)));
    tr.appendChild(sgEl('td', 'sg-num', s.monetary === null ? '—' : sgFmt(s.monetary, 2)));
  }
  scroll.appendChild(tv);
  card.appendChild(scroll);
  return card;
}

function sgRfmGrid(r: any): HTMLElement {
  const card = sgCard('sg-rfm-map', t('segmentsRfm.the_r_fm_map'), t('segmentsRfm.rows_are_the_recency_score_columns'));
  const tv = sgEl<HTMLTableElement>('table', 'sg-rfm-grid');
  tv.createCaption().textContent = t('segmentsRfm.customers_by_recency_score_and_frequency');
  const hr = tv.createTHead().insertRow();
  hr.appendChild(sgEl('td', 'sg-rfm-corner'));
  for (let fm = 1; fm <= 5; fm++) {
    const th = sgEl<HTMLTableCellElement>('th', 'sg-rfm-axis', `FM ${fm}`);
    th.scope = 'col';
    hr.appendChild(th);
  }
  const body = tv.createTBody();
  r.layout.forEach((row: string[], ri: number) => {
    const tr = body.insertRow();
    const th = sgEl<HTMLTableCellElement>('th', 'sg-rfm-axis', `R ${5 - ri}`);
    th.scope = 'row';
    tr.appendChild(th);
    row.forEach((seg: string, ci: number) => {
      const n = r.grid[ri][ci];
      const td = sgEl('td', 'sg-rfm-cell ' + sgRfmTone(seg) + (n ? '' : ' is-zero'));
      td.title = t('segmentsRfm.r_fm', { p0: 5 - ri, p1: ci + 1, seg, n: sgFmt(n), n2: n });
      td.append(sgEl('span', 'sg-rfm-cell-n', sgFmt(n)), sgEl('span', 'sg-rfm-cell-s', seg));
      tr.appendChild(td);
    });
  });
  card.appendChild(tv);
  return card;
}

function sgRfmSaveCard(r: any): HTMLElement {
  const card = sgCard('sg-rfm-save', t('segmentsRfm.save_as_a_dataset'),
    t('segmentsRfm.writes_one_row_per_customer_id', { customers: sgFmt(r.customers) }));
  const row = sgEl('div', 'sg-save-row');
  const save = sgButton('btn btn-primary', 'database', t('common.save_as_dataset'), () => void sgRfmSave());
  save.id = 'sg-rfm-save';
  const status = sgEl('p', 'sg-save-status');
  status.id = 'sg-rfm-status';
  status.setAttribute('role', 'status');
  row.appendChild(save);
  card.append(row, status);
  return card;
}

async function sgRfmSave(): Promise<void> {
  if (!sgInfo || !sgRfmSpec) return;
  const info = sgInfo;
  const save = document.getElementById('sg-rfm-save') as HTMLButtonElement | null;
  const status = document.getElementById('sg-rfm-status');
  if (!status) return;
  status.textContent = '';
  status.className = 'sg-save-status';
  if (save) save.disabled = true;
  let res: any;
  try {
    res = await window.hubSegments.rfmSave(info.projectId, info.datasetId, sgRfmSpec);
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : t('segmentsRfm.could_not_save_the_dataset') };
  }
  if (!res || !res.ok) {
    if (save) save.disabled = false;
    status.textContent = (res && res.error) || t('segmentsRfm.could_not_save_the_dataset_2');
    status.classList.add('is-error');
    return;
  }
  const ds = res.dataset;
  status.classList.add('is-ok');
  status.append(icon('circle-check', 16), sgEl('span', '', t('segmentsRfm.saved_customers', { name: ds.name, rowCount: sgFmt(ds.rowCount) })));
  status.appendChild(sgButton('btn btn-sm', 'table', t('segmentsRfm.open_dataset'), () => {
    sgSeq++;
    selectSection('datasets');
    void openSavedDataset(ds.id);
  }));
  showToast(t('common.saved_4', { name: ds.name }), { kind: 'success' });
}
