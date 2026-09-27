'use strict';

// Find segments — the RESULTS of a k-means fit: the headline figures, segment
// sizes, where the segments sit on the first two principal components, the
// profile (each column's mean per segment against overall, as a deviation
// bar), how k was chosen, and Save as column. Classic global-scope script;
// loads after segments.js (sgEl, sgFmt, sgColor, sgInfo…).
//
// Every number is main's (src/analysis/segmentModel.ts FitResult).

/** The last fit shown, or null before a run. */
let sgResult: any = null;
let sgChart: any = null;

/** A mean for the profile: whole numbers when large, more digits when small. */
function sgVal(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return sgFmt(v, a >= 100 ? 0 : a >= 1 ? 2 : 3);
}

function sgCard(cls: string, title: string, hint?: string): HTMLElement {
  const card = sgEl('section', 'sg-card ' + cls);
  const id = 'sg-h-' + cls.replace(/[^a-z0-9-]/gi, '');
  card.setAttribute('aria-labelledby', id);
  const head = sgEl('div', 'sg-card-head');
  const h = sgEl('h3', 'sg-card-h', title);
  h.id = id;
  head.appendChild(h);
  if (hint) head.appendChild(sgEl('p', 'sg-hint', hint));
  card.appendChild(head);
  return card;
}

function sgKpi(value: string, label: string): HTMLElement {
  const k = sgEl('div', 'sg-kpi');
  k.append(sgEl('div', 'sg-kpi-v', value), sgEl('div', 'sg-kpi-l', label));
  return k;
}

function sgSwatch(i: number): HTMLElement {
  const s = sgEl('span', 'sg-swatch');
  s.style.background = sgColor(i);
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function sgPaintResults(): void {
  const host = document.getElementById('sg-results');
  if (!host) return;
  host.textContent = '';
  if (sgChart) {
    sgChart.destroy();
    sgChart = null;
  }
  const r = sgResult;
  if (!r) {
    host.appendChild(sgEmpty('layers', 'Group rows that are alike',
      'Pick the columns that describe a row — spend, discount, units — and Find segments groups the rows that are alike, names each group after what sets it apart and plots them. Save the grouping as a column and it becomes an ordinary dimension for charts, filters and pivots.'));
    return;
  }
  const best = r.silhouettes.find((s: any) => s.k === r.k);
  const kpis = sgEl('div', 'sg-kpis');
  kpis.append(
    sgKpi(String(r.k), 'segments'),
    sgKpi(best ? best.score.toFixed(2) : '—', 'silhouette score'),
    sgKpi(sgFmt(r.fitted), r.fitted < r.complete ? `rows fitted, of ${sgFmt(r.complete)}` : 'rows fitted'),
    sgKpi(sgFmt(r.empty), r.empty === 1 ? 'row without a segment' : 'rows without a segment'),
  );
  // Sizes and the k choice stacked on the left, the map on the right, so
  // neither column trails off into empty space; the wide tables go full width.
  const left = sgEl('div', 'sg-stack');
  left.append(sgSizesCard(r), sgKCard(r));
  const pair = sgEl('div', 'sg-pair');
  pair.append(left, sgScatterCard(r));
  host.append(kpis, pair, sgProfileCard(r), sgSaveCard(r));
  sgDrawScatter(r);
}

function sgSizesCard(r: any): HTMLElement {
  const card = sgCard('sg-sizes', 'Segment sizes', 'Every row, assigned to its nearest segment. Names come from the two columns that set each segment apart most.');
  const list = sgEl('ol', 'sg-size-list');
  const total = Math.max(1, r.total);
  const rows: Array<{ name: string; n: number; i: number }> = r.names.map((name: string, i: number) => ({ name, n: r.sizes[i], i }));
  if (r.empty) rows.push({ name: 'No segment — a value is missing', n: r.empty, i: -1 });
  for (const row of rows) {
    const li = sgEl('li', 'sg-size' + (row.i < 0 ? ' is-empty' : ''));
    li.dataset.segment = row.i < 0 ? '' : String(row.i);
    const label = sgEl('div', 'sg-size-label');
    if (row.i >= 0) label.appendChild(sgSwatch(row.i));
    label.appendChild(sgEl('span', 'sg-size-name', row.name));
    const track = sgEl('div', 'sg-size-track');
    const bar = sgEl('div', 'sg-size-bar');
    bar.style.width = `${Math.max(0.5, (row.n / total) * 100)}%`;
    if (row.i >= 0) bar.style.background = sgColor(row.i);
    track.appendChild(bar);
    const fig = sgEl('div', 'sg-size-fig');
    fig.append(sgEl('b', '', sgFmt(row.n)), sgEl('span', '', sgPct(row.n / total)));
    li.append(label, track, fig);
    list.appendChild(li);
  }
  card.appendChild(list);
  return card;
}

function sgScatterCard(r: any): HTMLElement {
  const [v1, v2] = r.pca.variance;
  const card = sgCard('sg-map', 'Where the segments sit',
    `Each dot is a row, placed on the two directions that spread the rows most (principal components: ${sgPct(v1)} and ${sgPct(v2)} of the variation).`);
  const wrap = sgEl('div', 'sg-scatter');
  const canvas = sgEl<HTMLCanvasElement>('canvas', 'sg-scatter-canvas');
  canvas.id = 'sg-scatter';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Scatter of ${sgFmt(r.pca.points.length)} rows on the first two principal components, coloured by segment`);
  wrap.appendChild(canvas);
  card.appendChild(wrap);
  return card;
}

function sgDrawScatter(r: any): void {
  const canvas = document.getElementById('sg-scatter') as HTMLCanvasElement | null;
  if (!canvas || !window.Chart) return;
  const muted = getCSSVar('--muted') || '#6b7280';
  const grid = getCSSVar('--border') || '#e5e7eb';
  const font = { family: getCSSVar('--font-ui') || 'sans-serif', size: 11 };
  const datasets = r.names.map((name: string, i: number) => {
    const c = sgColor(i);
    return {
      label: name,
      data: r.pca.points.filter((p: number[]) => p[2] === i).map((p: number[]) => ({ x: p[0], y: p[1] })),
      backgroundColor: /^#[0-9a-f]{6}$/i.test(c) ? brandRgba(c, 0.6) : c,
      borderColor: c,
      borderWidth: 0,
      pointRadius: 2.5,
      pointHoverRadius: 4,
    };
  });
  const axis = (title: string) => ({
    title: { display: true, text: title, color: muted, font },
    grid: { color: grid },
    border: { color: grid },
    ticks: { color: muted, font, maxTicksLimit: 6 },
  });
  try {
    sgChart = new window.Chart(canvas, {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: muted, font, boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle', padding: 12 } },
          tooltip: { callbacks: { label: (ctx: any) => ctx.dataset.label } },
        },
        scales: { x: axis(`PC1 · ${sgPct(r.pca.variance[0])}`), y: axis(`PC2 · ${sgPct(r.pca.variance[1])}`) },
      },
    });
  } catch (_) {
    sgChart = null;
  }
}

/** One profile cell: the segment's mean, and a bar from the centre by how many SDs it sits off overall. */
function sgDevCell(mean: number | null, dev: number | null): HTMLElement {
  const td = sgEl('td', 'sg-dev-cell');
  const wrap = sgEl('div', 'sg-dev');
  wrap.appendChild(sgEl('span', 'sg-dev-val', sgVal(mean)));
  const track = sgEl('span', 'sg-dev-track');
  track.setAttribute('aria-hidden', 'true');
  track.appendChild(sgEl('span', 'sg-dev-zero'));
  if (dev !== null && Number.isFinite(dev)) {
    const bar = sgEl('span', 'sg-dev-bar ' + (dev >= 0 ? 'is-up' : 'is-down'));
    bar.style.width = `${(Math.min(Math.abs(dev), 2) / 2) * 50}%`;
    track.appendChild(bar);
    const mag = Math.abs(dev).toFixed(1);
    const sd = mag === '0.0' ? '0.0 SD' : `${dev >= 0 ? '+' : '−'}${mag} SD`;
    wrap.appendChild(sgEl('span', 'sg-dev-sd' + (Math.abs(dev) >= 0.25 ? ' is-strong' : ''), sd));
    td.title = `${sd} from the overall mean`;
  }
  wrap.insertBefore(track, wrap.children[1] || null);
  td.appendChild(wrap);
  return td;
}

function sgProfileCard(r: any): HTMLElement {
  const card = sgCard('sg-profile', 'Profile',
    'Each column’s mean in each segment against the overall mean. Bars show how far off overall it sits, in standard deviations (capped at ±2).');
  const scroll = sgEl('div', 'sg-table-scroll');
  const t = sgEl<HTMLTableElement>('table', 'sg-table');
  const hr = t.createTHead().insertRow();
  hr.appendChild(sgEl<HTMLTableCellElement>('th', '', 'Column'));
  hr.appendChild(sgEl<HTMLTableCellElement>('th', 'sg-num', 'Overall'));
  r.names.forEach((n: string, i: number) => {
    const th = sgEl<HTMLTableCellElement>('th', 'sg-seg-th');
    th.scope = 'col';
    th.append(sgSwatch(i), sgEl('span', '', n));
    hr.appendChild(th);
  });
  const body = t.createTBody();
  r.features.forEach((f: string, j: number) => {
    const tr = body.insertRow();
    const th = sgEl<HTMLTableCellElement>('th', 'sg-feat', f);
    th.scope = 'row';
    tr.appendChild(th);
    tr.appendChild(sgEl('td', 'sg-num', sgVal(r.profile.overall[j])));
    r.names.forEach((_: string, i: number) => tr.appendChild(sgDevCell(r.profile.segments[i][j], r.profile.deviation[i][j])));
  });
  scroll.appendChild(t);
  card.appendChild(scroll);
  return card;
}

function sgKCard(r: any): HTMLElement {
  const card = sgCard('sg-k', 'How many segments',
    'The silhouette score says how much closer each row is to its own segment than to the next one, from −1 to 1. The highest wins; a tie goes to fewer segments.');
  const list = sgEl('ul', 'sg-k-list');
  const top = Math.max(0.0001, ...r.silhouettes.map((s: any) => s.score));
  for (const s of r.silhouettes) {
    const li = sgEl('li', 'sg-k-row' + (s.k === r.k ? ' is-chosen' : ''));
    const bar = sgEl('span', 'sg-k-bar');
    bar.style.width = `${Math.max(1, (Math.max(0, s.score) / top) * 100)}%`;
    const track = sgEl('span', 'sg-k-track');
    track.appendChild(bar);
    li.append(sgEl('span', 'sg-k-n', `${s.k} segments`), track, sgEl('span', 'sg-k-v', s.score.toFixed(3)));
    if (s.k === r.k) li.appendChild(sgEl('span', 'sg-k-badge', 'chosen'));
    list.appendChild(li);
  }
  card.appendChild(list);
  return card;
}

function sgSaveCard(r: any): HTMLElement {
  const card = sgCard('sg-save', 'Save as a column',
    `Adds a Prepare step that stores this model — each column’s mean and spread and the ${r.k} centroids — and assigns every row on each refresh. The column is text, so it works as a dimension in any chart, filter or pivot.`);
  const row = sgEl('div', 'sg-save-row');
  const label = sgEl<HTMLLabelElement>('label', 'sg-field');
  label.htmlFor = 'sg-col-name';
  label.textContent = 'Column name';
  const input = sgEl<HTMLInputElement>('input', 'sg-col-name');
  input.id = 'sg-col-name';
  input.type = 'text';
  input.value = r.step.column;
  const save = sgButton('btn btn-primary', 'check', 'Save as column', () => void sgSaveColumn());
  save.id = 'sg-save';
  row.append(label, input, save);
  const status = sgEl('p', 'sg-save-status');
  status.id = 'sg-save-status';
  status.setAttribute('role', 'status');
  card.append(row, status);
  return card;
}

async function sgSaveColumn(): Promise<void> {
  if (!sgInfo || !sgResult) return;
  const input = document.getElementById('sg-col-name') as HTMLInputElement | null;
  const save = document.getElementById('sg-save') as HTMLButtonElement | null;
  const status = document.getElementById('sg-save-status');
  const column = input ? input.value.trim() : '';
  if (!status) return;
  status.textContent = '';
  status.className = 'sg-save-status';
  if (!column) {
    status.textContent = 'Name the column first.';
    status.classList.add('is-error');
    return;
  }
  const info = sgInfo;
  if (save) save.disabled = true;
  let res: any;
  try {
    res = await window.hubSegments.saveColumn(info.projectId, info.datasetId, { ...sgResult.step, column });
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : 'Could not save the column' };
  }
  if (!res || !res.ok) {
    if (save) save.disabled = false;
    status.textContent = (res && res.error) || 'Could not save the column.';
    status.classList.add('is-error');
    return;
  }
  if (input) input.disabled = true;
  status.classList.add('is-ok');
  status.append(icon('circle-check', 16), sgEl('span', '', `Saved — “${res.column}” is now a column of ${info.name}, step ${res.steps} in Prepare.`));
  status.appendChild(sgButton('btn btn-sm', 'sliders', 'Open in Prepare', () => void sgOpenPrepare(info.datasetId)));
  showToast(`Added the “${res.column}” column to ${info.name}`, { kind: 'success' });
}

async function sgOpenPrepare(datasetId: string): Promise<void> {
  sgSeq++;
  sgStopWatch();
  selectSection('datasets');
  await openSavedDataset(datasetId);
  dxSelectTab('ds-tab-prepare', true);
}
