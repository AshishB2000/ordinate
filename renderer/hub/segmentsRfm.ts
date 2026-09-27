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
  const blank = sgEl<HTMLOptionElement>('option', '', 'Pick a column');
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
  const h = sgEl('h3', 'sg-card-h', 'Who, when and how much');
  h.id = 'sg-rfm-h';
  head.append(h, sgEl('p', 'sg-hint',
    'One row per order. Recency is counted from the latest order date in the data, so the same data scores the same way on any day.'));
  const fields = sgEl('div', 'sg-rfm-fields');
  const nums = info.columns.filter((c) => c.type === 'number');
  fields.append(
    sgRfmSelect('sg-rfm-id', 'Customer id', info.columns, info.rfm.id),
    sgRfmSelect('sg-rfm-date', 'Order date', info.columns, info.rfm.date),
    sgRfmSelect('sg-rfm-amount', 'Amount', nums, info.rfm.amount),
  );
  const row = sgEl('div', 'sg-run-row');
  const run = sgButton('btn btn-primary', 'play', 'Score customers', () => void sgRfmRun());
  run.id = 'sg-rfm-run';
  row.append(run, sgEl('span', 'sg-run-hint', 'Rows without an id, a readable date or a number are left out and counted.'));
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
  sgProgress('rfm', true, 0, 'Starting…');
  sgWatchJob(info.datasetId, 'rfm');
  let res: any;
  try {
    res = await window.hubSegments.rfm(info.projectId, info.datasetId, spec);
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : 'Could not score the customers' };
  }
  sgStopWatch();
  sgBusy = '';
  if (seq !== sgSeq) return;
  sgProgress('rfm', false);
  sgRfmSync();
  if (!res || !res.ok) {
    if (res && res.cancelled) sgShowError('rfm', 'Stopped. Nothing was changed.', true);
    else sgShowError('rfm', (res && res.error) || 'Could not score the customers.');
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
    host.appendChild(sgEmpty('user', 'Score customers by recency, frequency and spend',
      'Every customer gets a 1–5 score for how recently, how often and how much they buy, and one of eleven named segments — from Champions to Lost. Save the scores as a dataset and chart them like any other.'));
    return;
  }
  const kpis = sgEl('div', 'sg-kpis');
  kpis.append(
    sgKpi(sgFmt(r.customers), 'customers'),
    sgKpi(sgFmt(r.used), 'orders scored'),
    sgKpi(r.asOf || '—', 'recency measured from'),
    sgKpi(sgFmt(r.skipped), r.skipped === 1 ? 'row left out' : 'rows left out'),
  );
  const pair = sgEl('div', 'sg-pair sg-pair--wide');
  pair.append(sgRfmGrid(r), sgRfmSaveCard(r));
  host.append(kpis, sgRfmTable(r), pair);
}

function sgRfmTable(r: any): HTMLElement {
  const card = sgCard('sg-rfm-segs', 'Segments', 'All eleven, with how many customers each holds and what they look like on average.');
  const scroll = sgEl('div', 'sg-table-scroll');
  const t = sgEl<HTMLTableElement>('table', 'sg-table sg-rfm-table');
  t.id = 'sg-rfm-table';
  const hr = t.createTHead().insertRow();
  for (const [text, cls] of [['Segment', ''], ['Customers', 'sg-num'], ['Share', ''], ['Days since last order', 'sg-num'], ['Orders', 'sg-num'], ['Spend', 'sg-num']]) {
    const th = sgEl<HTMLTableCellElement>('th', cls, text);
    th.scope = 'col';
    hr.appendChild(th);
  }
  const body = t.createTBody();
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
  scroll.appendChild(t);
  card.appendChild(scroll);
  return card;
}

function sgRfmGrid(r: any): HTMLElement {
  const card = sgCard('sg-rfm-map', 'The R × FM map', 'Rows are the recency score, columns the average of the frequency and monetary scores. Each cell is one segment.');
  const t = sgEl<HTMLTableElement>('table', 'sg-rfm-grid');
  t.createCaption().textContent = 'Customers by recency score and frequency-monetary score';
  const hr = t.createTHead().insertRow();
  hr.appendChild(sgEl('td', 'sg-rfm-corner'));
  for (let fm = 1; fm <= 5; fm++) {
    const th = sgEl<HTMLTableCellElement>('th', 'sg-rfm-axis', `FM ${fm}`);
    th.scope = 'col';
    hr.appendChild(th);
  }
  const body = t.createTBody();
  r.layout.forEach((row: string[], ri: number) => {
    const tr = body.insertRow();
    const th = sgEl<HTMLTableCellElement>('th', 'sg-rfm-axis', `R ${5 - ri}`);
    th.scope = 'row';
    tr.appendChild(th);
    row.forEach((seg: string, ci: number) => {
      const n = r.grid[ri][ci];
      const td = sgEl('td', 'sg-rfm-cell ' + sgRfmTone(seg) + (n ? '' : ' is-zero'));
      td.title = `R ${5 - ri} · FM ${ci + 1} — ${seg}: ${sgFmt(n)} customer${n === 1 ? '' : 's'}`;
      td.append(sgEl('span', 'sg-rfm-cell-n', sgFmt(n)), sgEl('span', 'sg-rfm-cell-s', seg));
      tr.appendChild(td);
    });
  });
  card.appendChild(t);
  return card;
}

function sgRfmSaveCard(r: any): HTMLElement {
  const card = sgCard('sg-rfm-save', 'Save as a dataset',
    `Writes one row per customer — id, recency, frequency, monetary, the three scores and the segment — as a new dataset of ${sgFmt(r.customers)} rows, ready for charts, dashboards and joins.`);
  const row = sgEl('div', 'sg-save-row');
  const save = sgButton('btn btn-primary', 'database', 'Save as dataset', () => void sgRfmSave());
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
    res = { ok: false, error: err instanceof Error ? err.message : 'Could not save the dataset' };
  }
  if (!res || !res.ok) {
    if (save) save.disabled = false;
    status.textContent = (res && res.error) || 'Could not save the dataset.';
    status.classList.add('is-error');
    return;
  }
  const ds = res.dataset;
  status.classList.add('is-ok');
  status.append(icon('circle-check', 16), sgEl('span', '', `Saved “${ds.name}” — ${sgFmt(ds.rowCount)} customers.`));
  status.appendChild(sgButton('btn btn-sm', 'table', 'Open dataset', () => {
    sgSeq++;
    selectSection('datasets');
    void openSavedDataset(ds.id);
  }));
  showToast(`Saved “${ds.name}”`, { kind: 'success' });
}
