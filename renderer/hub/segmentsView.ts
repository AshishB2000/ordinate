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
    host.appendChild(sgEmpty('layers', t('segmentsView.group_rows_that_are_alike'),
      t('segmentsView.pick_the_columns_that_describe_a')));
    return;
  }
  const best = r.silhouettes.find((s: any) => s.k === r.k);
  const kpis = sgEl('div', 'sg-kpis');
  kpis.append(
    sgKpi(String(r.k), 'segments'),
    sgKpi(best ? best.score.toFixed(2) : '—', t('segmentsView.silhouette_score')),
    sgKpi(sgFmt(r.fitted), r.fitted < r.complete ? t('segmentsView.rows_fitted_of', { complete: sgFmt(r.complete) }) : t('segmentsView.rows_fitted')),
    sgKpi(sgFmt(r.empty), r.empty === 1 ? t('segmentsView.row_without_a_segment') : t('segmentsView.rows_without_a_segment')),
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
  const card = sgCard('sg-sizes', t('segmentsView.segment_sizes'), t('segmentsView.every_row_assigned_to_its_nearest'));
  const list = sgEl('ol', 'sg-size-list');
  const total = Math.max(1, r.total);
  const rows: Array<{ name: string; n: number; i: number }> = r.names.map((name: string, i: number) => ({ name, n: r.sizes[i], i }));
  if (r.empty) rows.push({ name: t('segmentsView.no_segment_a_value_is_missing'), n: r.empty, i: -1 });
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
  const card = sgCard('sg-map', t('segmentsView.where_the_segments_sit'),
    t('segmentsView.each_dot_is_a_row_placed', { v1: sgPct(v1), v2: sgPct(v2) }));
  const wrap = sgEl('div', 'sg-scatter');
  const canvas = sgEl<HTMLCanvasElement>('canvas', 'sg-scatter-canvas');
  canvas.id = 'sg-scatter';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', t('segmentsView.scatter_of_rows_on_the_first', { pointsCount: sgFmt(r.pca.points.length) }));
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
        scales: { x: axis(t('segmentsView.pc1', { p0: sgPct(r.pca.variance[0]) })), y: axis(t('segmentsView.pc2', { p0: sgPct(r.pca.variance[1]) })) },
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
    const sd = mag === '0.0' ? t('segmentsView.0_0_sd') : t('segmentsView.sd', { p0: !!(dev >= 0), mag });
    wrap.appendChild(sgEl('span', 'sg-dev-sd' + (Math.abs(dev) >= 0.25 ? ' is-strong' : ''), sd));
    td.title = t('segmentsView.from_the_overall_mean', { sd });
  }
  wrap.insertBefore(track, wrap.children[1] || null);
  td.appendChild(wrap);
  return td;
}

function sgProfileCard(r: any): HTMLElement {
  const card = sgCard('sg-profile', t('segmentsView.profile'),
    t('segmentsView.each_column_s_mean_in_each'));
  const scroll = sgEl('div', 'sg-table-scroll');
  const tv = sgEl<HTMLTableElement>('table', 'sg-table');
  const hr = tv.createTHead().insertRow();
  hr.appendChild(sgEl<HTMLTableCellElement>('th', '', t('common.column')));
  hr.appendChild(sgEl<HTMLTableCellElement>('th', 'sg-num', t('segmentsView.overall')));
  r.names.forEach((n: string, i: number) => {
    const th = sgEl<HTMLTableCellElement>('th', 'sg-seg-th');
    th.scope = 'col';
    th.append(sgSwatch(i), sgEl('span', '', n));
    hr.appendChild(th);
  });
  const body = tv.createTBody();
  r.features.forEach((f: string, j: number) => {
    const tr = body.insertRow();
    const th = sgEl<HTMLTableCellElement>('th', 'sg-feat', f);
    th.scope = 'row';
    tr.appendChild(th);
    tr.appendChild(sgEl('td', 'sg-num', sgVal(r.profile.overall[j])));
    r.names.forEach((_: string, i: number) => tr.appendChild(sgDevCell(r.profile.segments[i][j], r.profile.deviation[i][j])));
  });
  scroll.appendChild(tv);
  card.appendChild(scroll);
  return card;
}

function sgKCard(r: any): HTMLElement {
  const card = sgCard('sg-k', t('segmentsView.how_many_segments'),
    t('segmentsView.the_silhouette_score_says_how_much'));
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
  const card = sgCard('sg-save', t('segmentsView.save_as_a_column'),
    t('segmentsView.adds_a_prepare_step_that_stores', { k: r.k }));
  const row = sgEl('div', 'sg-save-row');
  const label = sgEl<HTMLLabelElement>('label', 'sg-field');
  label.htmlFor = 'sg-col-name';
  label.textContent = t('segmentsView.column_name');
  const input = sgEl<HTMLInputElement>('input', 'sg-col-name');
  input.id = 'sg-col-name';
  input.type = 'text';
  input.value = r.step.column;
  const save = sgButton('btn btn-primary', 'check', t('segmentsView.save_as_column'), () => void sgSaveColumn());
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
    status.textContent = t('segmentsView.name_the_column_first');
    status.classList.add('is-error');
    return;
  }
  const info = sgInfo;
  if (save) save.disabled = true;
  let res: any;
  try {
    res = await window.hubSegments.saveColumn(info.projectId, info.datasetId, { ...sgResult.step, column });
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : t('segmentsView.could_not_save_the_column') };
  }
  if (!res || !res.ok) {
    if (save) save.disabled = false;
    status.textContent = (res && res.error) || t('segmentsView.could_not_save_the_column_2');
    status.classList.add('is-error');
    return;
  }
  if (input) input.disabled = true;
  status.classList.add('is-ok');
  status.append(icon('circle-check', 16), sgEl('span', '', t('segmentsView.saved_is_now_a_column_of', { column: res.column, name: info.name, steps: res.steps })));
  status.appendChild(sgButton('btn btn-sm', 'sliders', t('segmentsView.open_in_prepare'), () => void sgOpenPrepare(info.datasetId)));
  showToast(t('segmentsView.added_the_column_to', { column: res.column, name: info.name }), { kind: 'success' });
}

async function sgOpenPrepare(datasetId: string): Promise<void> {
  sgSeq++;
  sgStopWatch();
  selectSection('datasets');
  await openSavedDataset(datasetId);
  dxSelectTab('ds-tab-prepare', true);
}
