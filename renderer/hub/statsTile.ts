'use strict';

// A statistical result on a dashboard — the "stats" card, its export, and the
// two ways in: "Add to dashboard" from the workbench, and "Statistics…" on a
// scatter's ⋯ menu. The card stores only its SPEC (src/analysis/stats/spec.ts
// via dashboards.sanitizeCard); every render asks main to recompute it under
// the dashboard's filters, parameters and "As of" time, like a metric card.

function swTileTitle(card: any): string {
  const s = (card && card.stats) || {};
  if (s.kind === 'correlation') return t('statsTile.correlation', { p0: !!(s.method === 'spearman') });
  if (s.kind === 'regression') return t('statsTile.regression', { p0: s.target || '' });
  if (s.kind === 'groups') return `${s.outcome || ''} by ${s.group || ''}`;
  if (s.kind === 'distribution') return t('statsTile.distribution', { p0: (s.columns || [])[0] || '' });
  return t('common.statistics');
}

function swTileTable(host: HTMLElement, head: string[], rows: string[][]): void {
  const wrap = document.createElement('div');
  wrap.className = 'sw-tile-scroll';
  const table = document.createElement('table');
  table.className = 'sw-table sw-table--tile';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  head.forEach((h, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = h;
    if (i > 0) th.className = 'num';
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    r.forEach((v, i) => {
      const c = document.createElement(i === 0 ? 'th' : 'td');
      if (i === 0) (c as HTMLTableCellElement).scope = 'row';
      else c.className = 'num tnum';
      c.textContent = v;
      tr.appendChild(c);
    });
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  host.appendChild(wrap);
}

async function renderStatsCard(card: any, body: HTMLElement): Promise<void> {
  skelChart(body);
  let res: any;
  try {
    res = await window.hubStats.tile(currentProjectId, card.stats, effectiveFilters(), dashParamPayload(),
      typeof snapDashAsOf === 'string' ? snapDashAsOf : null);
  } catch (_) {
    res = { ok: false, error: t('statsTile.could_not_compute_this_tile') };
  } finally {
    skelClear(body);
  }
  if (!res || !res.ok) { dashCardMissing(body, (res && res.error) || t('statsTile.could_not_compute_this_tile'), !res || !res.asOfMissing); return; }
  const tile = res.tile;
  const titleEl = body.closest('.dash-card')?.querySelector('.dash-card-title');
  if (titleEl && !card.heading) titleEl.textContent = tile.title;
  body.textContent = '';
  const box = document.createElement('div');
  box.className = 'sw-tile';
  body.appendChild(box);
  if (tile.subtitle) {
    const sub = document.createElement('p');
    sub.className = 'sw-tile-sub tnum';
    sub.textContent = tile.subtitle;
    box.appendChild(sub);
  }
  if (res.view === 'chart') {
    const area = document.createElement('div');
    area.className = 'dash-viz-area cv-viz-area sw-tile-chart';
    box.appendChild(area);
    renderVizInArea(area, tile.chart.data, tile.chart.chartType, { id: card.id, chartOverrides: {} }, 'v');
  } else {
    swTileTable(box, tile.table.head, tile.table.rows);
  }
  if (tile.sentence) {
    const s = document.createElement('p');
    s.className = 'sw-tile-sentence';
    s.textContent = tile.sentence;
    box.appendChild(s);
  }
}

/**
 * The card in an export (dashShare.ts): the tile's numbers through the share
 * policy (main applies it for `share: 'export'`), as a live chart where the
 * HTML export can draw one and a picture everywhere else.
 */
async function swExportCard(card: any, layout: any, forCapture: boolean, measure: any): Promise<any> {
  const title = swTileTitle(card);
  let res: any;
  try { res = await window.hubStats.tile(currentProjectId, card.stats, effectiveFilters(), dashParamPayload(), null, 'export'); } catch (_) { res = null; }
  if (!res || !res.ok) return { kind: 'broken', layout, reason: (res && res.error) || t('statsTile.could_not_compute_this_tile_2') };
  const chart = res.view === 'chart';
  const type = chart ? res.tile.chart.chartType : 'table';
  const data = chart ? res.tile.chart.data : res.tile.numeric;
  if (chart && !forCapture && DASH_EXPORT_LIVE_TYPES[type]) {
    return { kind: 'chart', layout, chartType: DASH_EXPORT_LIVE_TYPES[type], title, data: { labels: data.labels, series: data.series.map((s: any) => ({ label: s.name, values: s.values })) } };
  }
  const frame = Object.assign({ themeClasses: dashExportStyleClasses(), accentHex: dashCurrentStyle().accentHex, style: dashCurrentStyle() }, dashExportChartBox(measure, layout, true));
  const png = chart ? await captureChartPNG(type, data, {}, frame).catch(() => null) : swTablePng(data, frame);
  return png ? { kind: 'image', layout, png, title } : { kind: 'broken', layout, reason: t('statsTile.could_not_draw_this_tile') };
}

/** The numbers-only table as a picture, in the export's own theme colours. */
function swTablePng(data: any, frame: any): string | null {
  const holder = document.createElement('div');
  holder.className = 'export-capture-holder';
  for (const c of frame.themeClasses || []) holder.classList.add(c);
  document.body.appendChild(holder);
  const ink = getCSSVar('--text', holder) || '#18181b';
  const muted = getCSSVar('--muted', holder) || '#6b7280';
  const line = getCSSVar('--border', holder) || '#e5e7eb';
  const bg = getCSSVar('--surface', holder) || '#ffffff';
  holder.remove();
  const fmt = (v: any): string => (typeof v === 'number' ? OrdFormat.formatNumber(v, { maxDecimals: 4 }) : v == null ? '—' : String(v));
  const head = ['', ...data.series.map((s: any) => s.name)];
  const rows: string[][] = data.labels.map((l: any, i: number) => [String(l), ...data.series.map((s: any) => fmt(s.values[i]))]);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const font = '13px ' + (getCSSVar('--font-ui') || 'sans-serif');
  ctx.font = font;
  const widths = head.map((h, j) => Math.max(ctx.measureText(h).width, ...rows.map((r) => ctx.measureText(r[j]).width)) + 24);
  const rowH = 28;
  const W = Math.ceil(widths.reduce((s, w) => s + w, 0)) + 16;
  const H = rowH * (rows.length + 1) + 16;
  canvas.width = W * 2;
  canvas.height = H * 2;
  ctx.scale(2, 2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.font = font;
  ctx.textBaseline = 'middle';
  const draw = (cells: string[], y: number, color: string, bold: boolean): void => {
    let x = 8;
    ctx.font = (bold ? '600 ' : '') + font;
    cells.forEach((c, j) => {
      ctx.fillStyle = j === 0 || bold ? color : ink;
      ctx.textAlign = j === 0 ? 'left' : 'right';
      ctx.fillText(c, j === 0 ? x + 8 : x + widths[j] - 8, y);
      x += widths[j];
    });
  };
  draw(head, 8 + rowH / 2, muted, true);
  rows.forEach((r, i) => {
    const y = 8 + rowH * (i + 1);
    ctx.fillStyle = line;
    ctx.fillRect(8, y, W - 16, 1);
    draw(r, y + rowH / 2, ink, false);
  });
  return canvas.toDataURL('image/png');
}

// ── "Add to dashboard" ───────────────────────────────────────────────────────

async function swAddToDashboard(spec: any): Promise<void> {
  if (!currentProjectId) return;
  let list: any[] = [];
  try { list = await window.hub.listAnalyses(currentProjectId); } catch (_) { list = []; }
  if (!Array.isArray(list)) list = [];
  const NEW = '__new__';
  const options = list.map((a) => ({ value: String(a.id), label: a && a.name ? String(a.name) : t('common.untitled_dashboard') }))
    .concat([{ value: NEW, label: t('common.new_dashboard_2') }]);
  let view = 'table';
  const extra = document.createElement('div');
  extra.className = 'sw-add-view';
  const lbl = document.createElement('span');
  lbl.className = 'sw-ctl-label';
  lbl.textContent = t('statsTile.show_as');
  extra.append(lbl, swSeg(t('statsTile.show_the_result_as'), [['table', t('common.table')], ['chart', 'Chart']], view, (v) => { view = v; }));
  const choice = await dashChooseModal(t('common.add_to_dashboard'), options, t('common.add'), extra);
  if (choice === null) return;
  const card = { id: dashUuid(), type: 'stats', stats: Object.assign({}, spec, { view }), layout: { x: 0, y: 0, w: 6, h: 6 } };
  // The dashboard open in the editor takes the card in memory, so its own save
  // cannot overwrite it a moment later.
  if (dashCurrent && String(dashCurrent.id) === choice && !dashReadOnly && dashCurrentPage()) {
    const page = dashCurrentPage();
    card.layout = { ...dashFindSlot(page.cards, 6, 6), w: 6, h: 6 };
    page.cards.push(card);
    markDashDirty(t('statsTile.add_statistics'));
    renderDashGrid();
    showToast(t('common.added_to', { p0: (dashCurrent.name || t('common.the_dashboard')) }));
    return;
  }
  let analysis: any = null;
  if (choice === NEW) {
    const name = await promptModal(t('common.name_the_dashboard'), t('common.untitled_dashboard'), t('common.create'));
    if (name === null) return;
    try { analysis = await window.hub.createAnalysis({ projectId: currentProjectId, name: name.trim() || t('common.untitled_dashboard') }); } catch (_) { analysis = null; }
  } else {
    try { analysis = await window.hub.getAnalysis(currentProjectId, choice); } catch (_) { analysis = null; }
  }
  if (!analysis || !analysis.id) { showToast(t('common.that_dashboard_could_not_be_opened')); return; }
  const sheets = Array.isArray(analysis.sheets) && analysis.sheets.length ? analysis.sheets : [{ id: dashUuid(), name: t('common.sheet_1'), cards: [] }];
  const last = sheets[sheets.length - 1];
  if (!Array.isArray(last.cards)) last.cards = [];
  card.layout = { ...dashFindSlot(last.cards, 6, 6), w: 6, h: 6 };
  last.cards.push(card);
  let saved: any = null;
  try { saved = await window.hub.updateAnalysis(currentProjectId, String(analysis.id), { sheets }); } catch (_) { saved = null; }
  if (!saved || saved.ok === false) { showToast(t('common.could_not_add_it_to_that')); return; }
  showToast(t('common.added_to', { p0: (analysis.name ? String(analysis.name) : t('common.the_dashboard')) }));
}

// ── "Statistics…" on a scatter's ⋯ ───────────────────────────────────────────

/** Called by openChartMenu (chartControls.ts) for every chart it opens on. */
function swWireChartMenu(entry: any, type: string, sig: AddEventListenerOptions): void {
  let btn = document.getElementById('cm-stats') as HTMLButtonElement | null;
  if (!btn) {
    const anchor = document.getElementById('cm-explain');
    if (!anchor) return;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chart-menu-item';
    btn.id = 'cm-stats';
    iconLabel(btn, 'activity', t('common.statistics_2'), 14);
    anchor.after(btn);
  }
  const d = entry && entry.drill;
  const enc = d && d.encoding;
  const x = enc && typeof enc.category === 'string' ? enc.category : '';
  const y = enc && Array.isArray(enc.values) && enc.values[0] ? String(enc.values[0].column || '') : '';
  btn.hidden = !(type === 'scatter' && d && d.datasetId && x && y);
  if (btn.hidden) return;
  btn.addEventListener('click', () => {
    closeChartMenu();
    void swOpen({ datasetId: d.datasetId, pair: [x, y] });
  }, sig);
}
