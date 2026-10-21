'use strict';

// The published site's renderer, DOM half: the TILES — a table, a pivot, a
// chart's body and a whole card — and the helpers every later script uses
// (pcEl, pcFmt, pcRamp). A classic script inlined after publishPhone.js and
// before publishMaps.js / publishPages.js / publishClient.js (src/publish/
// publish.ts readAssets joins the four into the page's client script). Every
// string goes in through textContent; nothing here computes a figure.

declare const Chart: any; // the app's own Chart.js UMD, inlined before this script
// src/app/format.js, inlined and bound by the page's prelude (src/publish/siteHtml.ts).
declare const OrdFormat: {
  formatValue(v: unknown, mode?: string): string; formatNumber(v: unknown, opts?: { decimals?: number; maxDecimals?: number }): string;
  formatPercent(v: unknown, decimals?: number): string; asMonthLabels(labels: any[]): any[]; setFormatPrefs(p: unknown): void;
  figureLines(chartType: string, labels: any[], series: any[], figures: any): string[];
  formatPct(v: unknown): string; stepLabel(step: { src: number; label: string }, labels: readonly unknown[]): string;
};

const pcCharts: any[] = [];

function pcEl(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pcFmt(v: number): string {
  try { return OrdFormat.formatValue(v, 'auto'); } catch (_) { return String(v); }
}

let pcFigures = 0;

/** Chart.js's own ink — ticks, legends, gridlines — from the page's tokens, read when a chart is drawn (the style's light or dark). */
function pcInk(): void {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, dflt: string): string => cs.getPropertyValue(name).trim() || dflt;
  Chart.defaults.color = v('--muted', '#6b7280');
  Chart.defaults.borderColor = v('--border', '#e5e7eb');
}

/** Labels as the app's axes name them: a first-of-month axis as "Jan 2023" (the shared formatter). */
function pcMonths(labels: any[]): any[] {
  try { return OrdFormat.asMonthLabels(labels); } catch (_) { return labels; }
}

function pcRamp(): string[] {
  const cs = getComputedStyle(document.documentElement);
  const out: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const c = cs.getPropertyValue('--chart-' + i).trim();
    if (c) out.push(c);
  }
  return out;
}

// ── Tiles ────────────────────────────────────────────────────────────────────

function pcTable(model: { head: string[]; rows: any[][] }): HTMLElement {
  const wrap = pcEl('div', 'pub-table-wrap');
  const t = pcEl('table', 'pub-table');
  const tr = pcEl('tr');
  for (const h of model.head) tr.appendChild(pcEl('th', '', h));
  const thead = pcEl('thead');
  thead.appendChild(tr);
  t.appendChild(thead);
  const body = pcEl('tbody');
  for (const r of model.rows.slice(0, 1000)) {
    const row = pcEl('tr');
    r.forEach((v: any, i: number) => row.appendChild(pcEl('td', i > 0 && typeof v === 'number' ? 'num' : '', v == null ? '' : typeof v === 'number' && i > 0 ? pcFmt(v) : String(v))));
    body.appendChild(row);
  }
  t.appendChild(body);
  wrap.appendChild(t);
  return wrap;
}

function pcPivot(grid: any): HTMLElement {
  const wrap = pcEl('div', 'pub-table-wrap');
  const t = pcEl('table', 'pub-table pub-pivot');
  const depth = grid.rowHeaders[0] ? grid.rowHeaders[0].length : 1;
  const levels = grid.colHeaders[0] ? grid.colHeaders[0].length : 1;
  const thead = pcEl('thead');
  for (let l = 0; l < levels; l++) {
    const tr = pcEl('tr');
    for (let d = 0; d < depth; d++) tr.appendChild(pcEl('th', 'corner', ''));
    for (const path of grid.colHeaders) tr.appendChild(pcEl('th', '', path[l] || ''));
    if (grid.rowTotals) for (const v of grid.valueNames) tr.appendChild(pcEl('th', '', l === levels - 1 ? 'Total ' + v : ''));
    thead.appendChild(tr);
  }
  t.appendChild(thead);
  const body = pcEl('tbody');
  grid.cells.slice(0, 2000).forEach((row: any[], r: number) => {
    const tr = pcEl('tr', grid.rowKinds[r] === 'subtotal' ? 'subtotal' : '');
    for (let d = 0; d < depth; d++) tr.appendChild(pcEl('th', '', (grid.rowHeaders[r] || [])[d] || ''));
    for (const v of row) tr.appendChild(pcEl('td', 'num', v == null ? '' : pcFmt(v)));
    if (grid.rowTotals) for (const v of grid.rowTotals[r] || []) tr.appendChild(pcEl('td', 'num total', v == null ? '' : pcFmt(v)));
    body.appendChild(tr);
  });
  if (grid.colTotals) {
    const tr = pcEl('tr', 'grand');
    tr.appendChild(pcEl('th', '', 'Total'));
    for (let d = 1; d < depth; d++) tr.appendChild(pcEl('th', '', ''));
    for (const v of grid.colTotals) tr.appendChild(pcEl('td', 'num', v == null ? '' : pcFmt(v)));
    if (grid.grand) for (const v of grid.grand) tr.appendChild(pcEl('td', 'num total', v == null ? '' : pcFmt(v)));
    body.appendChild(tr);
  }
  t.appendChild(body);
  wrap.appendChild(t);
  if (grid.truncated) wrap.appendChild(pcEl('p', 'pub-note', 'Showing the first rows and columns of a larger table.'));
  return wrap;
}

function pcChartBody(card: { chartType: string; category?: string; title?: string }, payload: any, page: any, onPick: (label: string) => void): HTMLElement {
  const kind = pkRenderKind(card.chartType);
  if (kind === 'pivot' && payload.pivot) return pcPivot(payload.pivot);
  if (kind === 'map') return pcMap(payload, page, card.chartType);
  if (kind === 'gauge') {
    const s = payload.series && payload.series[0];
    const v = s && s.values ? s.values[0] : null;
    const box = pcEl('div', 'pub-kpi');
    box.appendChild(pcEl('div', 'pub-kpi-value', v == null ? '—' : pcFmt(v)));
    return box;
  }
  if (kind === 'table') {
    const wrap = pcTable(pkTableModel(payload, card.category || ''));
    if (card.chartType !== 'table') wrap.appendChild(pcEl('p', 'pub-note', 'Shown as a table in this published copy.'));
    return wrap;
  }
  const holder = pcEl('div', 'pub-chart');
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', card.title || 'Chart');
  holder.appendChild(canvas);
  // A figure type whose figures this page does not carry (published before they existed): say so, never work them out.
  const cfg = pkChartConfig(card.chartType, payload, pcRamp(), pcFmt, pcMonths, OrdFormat.formatPct);
  if (!cfg) return pcEl('div', 'pub-broken', 'This chart needs a newer publish to draw — publish the dashboard again.');
  const src: number[] | undefined = cfg.src;
  delete cfg.src;
  // What it draws, as text a screen reader hears — the app's own list (OrdFormat.figureLines).
  const lines: string[] = OrdFormat.figureLines(card.chartType, pcMonths(payload.labels || []), payload.series || [], payload.figures);
  if (lines.length) {
    const list = pcEl('ul', 'pub-sr');
    list.id = 'pub-fig-' + (++pcFigures);
    list.setAttribute('data-figures', '');
    for (const line of lines) list.appendChild(pcEl('li', '', line));
    canvas.setAttribute('aria-describedby', list.id);
    holder.appendChild(list);
  }
  if (typeof Chart === 'function') {
    // A phone: the legend under the plot, fewer level axis labels (publishPhone.ts).
    if (ppIsPhone()) ppPhoneChart(cfg);
    cfg.options.onClick = (_e: any, els: any[]) => {
      const i = els && els.length ? (src ? src[els[0].index] : els[0].index) : -1;
      if (i >= 0 && payload.labels && i < payload.labels.length) onPick(String(payload.labels[i]));
    };
    pcInk();
    requestAnimationFrame(() => { pcCharts.push(new Chart(canvas, cfg)); });
  }
  return holder;
}

function pcCard(card: any, combo: number, page: any, onPick: (column: string, label: string, chart?: string) => void, top = 0): HTMLElement {
  const el = pcEl('section', 'pub-card pub-card--' + card.kind);
  // All three sizes' cells as custom properties; the page's CSS breakpoints
  // pick which pair `grid-column` / `grid-row` read (src/publish/siteHtml.ts).
  // Properties, not `style.gridColumn`: an inline placement would outrank the
  // media queries. No layout decision is made in script.
  el.style.setProperty('--pc-d-col', `${card.layout.x + 1} / span ${card.layout.w}`);
  el.style.setProperty('--pc-d-row', `${card.layout.y - top + 1} / span ${card.layout.h}`);
  for (const [size, tag] of [['tablet', 't'], ['phone', 'p']]) {
    const cell = card.sizes && card.sizes[size];
    if (!cell) continue;
    if (cell.hidden) { el.classList.add('pub-hide-' + tag); continue; }
    el.style.setProperty(`--pc-${tag}-col`, `${cell.x + 1} / span ${cell.w}`);
    el.style.setProperty(`--pc-${tag}-row`, `${cell.y + 1} / span ${cell.h}`);
  }
  // A phone stacks the tiles in one column (sizeCss): a chart keeps its phone cell's rows as its height.
  const ph = card.sizes && card.sizes.phone;
  if (ph && !ph.hidden) el.style.setProperty('--pc-p-h', String(ph.h));
  if (card.kind === 'text') {
    if (card.heading) el.appendChild(pcEl('h3', 'pub-text-h', card.heading));
    for (const para of String(card.text || '').split(/\n{2,}/)) if (para.trim()) el.appendChild(pcEl('p', 'pub-text-p', para));
    return el;
  }
  if (card.kind === 'broken') {
    el.appendChild(pcEl('div', 'pub-broken', card.reason || 'Source removed'));
    return el;
  }
  const payload = pkPayload(card, combo) || {};
  if (card.title) el.appendChild(pcEl('h3', 'pub-card-title', card.title));
  if (payload.error) {
    el.appendChild(pcEl('div', 'pub-broken', payload.error));
    return el;
  }
  if (payload.hidden) {
    el.appendChild(pcEl('div', 'pub-broken', payload.hidden));
    return el;
  }
  if (card.kind === 'summary') {
    for (const line of payload.sentences || []) el.appendChild(pcEl('p', 'pub-text-p', line));
    return el;
  }
  if (card.kind === 'metric') {
    // The figure, then what it measures under it, as the app's KPI tile reads (the title is the card's head).
    const box = pcEl('div', 'pub-kpi pub-kpi--card');
    box.appendChild(pcEl('div', 'pub-kpi-value', payload.display || '—'));
    if (payload.subtitle) box.appendChild(pcEl('div', 'pub-kpi-label', payload.subtitle));
    el.appendChild(box);
  } else {
    el.appendChild(pcChartBody(card, payload, page, (label) => onPick(card.category || '', label, card.title)));
  }
  // A KPI's sentence only restates its figure; charts get theirs.
  if (payload.caption && card.kind !== 'metric') el.appendChild(pcEl('p', 'pub-caption', payload.caption));
  return el;
}
