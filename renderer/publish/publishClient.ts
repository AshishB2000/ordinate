'use strict';

// The published site's renderer, DOM half. Reads the page's data block
// (#ordinate-page, a non-executed JSON <script>), lays out the nav, the
// filter bar, the sheets and the tiles, and redraws the tiles when a control
// changes — by LOOKING UP the app's pre-computed answer for that state
// (publishCore.ts), never by computing one. Every string goes in through
// textContent; nothing is parsed as HTML. No network: no fetch, no XHR, no
// external URL anywhere in the page.

declare const Chart: any; // the app's own Chart.js UMD, inlined before this script
declare function matchGeoItem(items: any[], props: any): any; // renderer/hub/geoMatch.js, inlined

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

function pcRamp(): string[] {
  const cs = getComputedStyle(document.documentElement);
  const out: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const c = cs.getPropertyValue('--chart-' + i).trim();
    if (c) out.push(c);
  }
  return out;
}

// ── Header and nav ───────────────────────────────────────────────────────────

function pcHeader(page: any): HTMLElement {
  const head = pcEl('header', 'pub-head');
  const brand = pcEl('a', 'pub-brand');
  brand.setAttribute('href', 'index.html');
  if (page.site.logo) {
    const img = pcEl('img', 'pub-logo') as HTMLImageElement;
    img.src = page.site.logo;
    img.alt = '';
    brand.appendChild(img);
  }
  brand.appendChild(pcEl('span', 'pub-site', page.site.title));
  head.appendChild(brand);
  const nav = pcEl('nav', 'pub-nav');
  nav.setAttribute('aria-label', 'Pages');
  for (const n of page.site.nav || []) {
    const a = pcEl('a', 'pub-nav-link', n.name);
    a.setAttribute('href', n.file);
    if (location.pathname.endsWith('/' + n.file)) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
  head.appendChild(nav);
  return head;
}

function pcIndex(page: any, root: HTMLElement): void {
  root.appendChild(pcEl('h1', 'pub-title', page.site.title));
  const grid = pcEl('div', 'pub-index');
  for (const n of page.site.nav || []) {
    const a = pcEl('a', 'pub-index-card');
    a.setAttribute('href', n.file);
    a.appendChild(pcEl('span', 'pub-index-kind', n.kind === 'story' ? 'Story' : n.kind === 'scorecard' ? 'Scorecard' : 'Dashboard'));
    a.appendChild(pcEl('span', 'pub-index-name', n.name));
    grid.appendChild(a);
  }
  if (!(page.site.nav || []).length) grid.appendChild(pcEl('p', 'pub-empty', 'Nothing was published.'));
  root.appendChild(grid);
  if (page.site.generatedAt) {
    root.appendChild(pcEl('p', 'pub-foot', 'Published ' + new Date(page.site.generatedAt).toLocaleString() + ' · every figure was computed by Ordinate'));
  }
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

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A published HEXBIN or FLOW map (r6:geo): a still picture framed to the data
 * over the offline world land — the one hex level the site carries (the finest
 * that stays legible), or the routes with their main-computed arcs and widths.
 */
function pcGeoDensity(geo: any, page: any): HTMLElement {
  const level = geo.hex && Array.isArray(geo.hex.levels) ? geo.hex.levels[0] : null;
  const hexes: any[] = level && Array.isArray(level.hexes) ? level.hexes : [];
  const flows: any[] = geo.flow && Array.isArray(geo.flow.flows) ? geo.flow.flows : [];
  const pts: number[][] = [];
  for (const h of hexes) for (let i = 0; i + 1 < h.ring.length; i += 2) pts.push(pkWorld(h.ring[i], h.ring[i + 1]));
  for (const f of flows) for (let i = 0; i + 1 < f.path.length; i += 2) pts.push(pkWorld(f.path[i], f.path[i + 1]));
  const wrap = pcEl('div', 'pub-map-wrap');
  if (!pts.length) { wrap.appendChild(pcEl('div', 'pub-broken', 'No points to place on the map.')); return wrap; }
  let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  let y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  const px = Math.max(0.002, (x1 - x0) * 0.12), py = Math.max(0.002, (y1 - y0) * 0.12);
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  const W = 960;
  const scale = W / (x1 - x0);
  const H = Math.max(160, Math.min(720, Math.round((y1 - y0) * scale)));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'pub-map');
  svg.setAttribute('role', 'img');
  const add = (d: string, cls: string, title: string, attrs: Record<string, string> = {}): void => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', cls);
    for (const k of Object.keys(attrs)) path.setAttribute(k, attrs[k]);
    if (title) { const t = document.createElementNS(SVG_NS, 'title'); t.textContent = title; path.appendChild(t); }
    svg.appendChild(path);
  };
  const land = page.geo && page.geo.country;
  for (const f of (land && land.features) || []) add(pkPathD(f.geometry, pkWorld, scale, x0, y0), 'pub-land', '');
  const xy = (lng: number, lat: number): string => {
    const p = pkWorld(lng, lat);
    return ((p[0] - x0) * scale).toFixed(1) + ',' + ((p[1] - y0) * scale).toFixed(1);
  };
  const vals = hexes.map((h) => h.value).concat(flows.map((f) => f.value)).filter((v) => typeof v === 'number');
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  const label = (geo.hex && geo.hex.label) || (geo.flow && geo.flow.label) || 'Value';
  for (const h of hexes) {
    let d = '';
    for (let i = 0; i + 1 < h.ring.length; i += 2) d += (i ? 'L' : 'M') + xy(h.ring[i], h.ring[i + 1]);
    const t = pkRampT(h.value, min, max);
    add(d + 'Z', t === null ? 'pub-land' : 'pub-region', `${label}: ${h.value == null ? 'no data' : pcFmt(h.value)} · ${h.n} points`,
      t === null ? {} : { 'fill-opacity': String(0.18 + 0.82 * t) });
  }
  for (const f of flows) {
    let d = '';
    for (let i = 0; i + 1 < f.path.length; i += 2) d += (i ? 'L' : 'M') + xy(f.path[i], f.path[i + 1]);
    const w = typeof f.value === 'number' && max > 0 && f.value > 0 ? 1 + Math.sqrt(f.value / max) * 6 : 1;
    add(d, 'pub-flow', `${f.name}: ${f.value == null ? 'no data' : pcFmt(f.value)}`, { 'stroke-width': w.toFixed(1) });
  }
  wrap.appendChild(svg);
  if (geo.flow && geo.flow.routes > flows.length) {
    wrap.appendChild(pcEl('p', 'pub-note', `The top ${flows.length} of ${geo.flow.routes} routes by ${String(label).toLowerCase()}.`));
  }
  return wrap;
}

function pcMap(payload: any, page: any, chartType: string): HTMLElement {
  const geo = payload.geo || { level: 'country', items: [] };
  if (geo.hex || geo.flow) return pcGeoDensity(geo, page);
  const key = geo.level === 'custom' ? Object.keys(page.geo).find((k: string) => k.indexOf('custom:') === 0) : geo.level;
  const base = page.geo[key || ''] || page.geo[geo.level === 'us_county' ? 'us_county' : 'country'] || page.geo.country;
  const land = page.geo[geo.level === 'us_state' || geo.level === 'us_county' || geo.level === 'us_city' || geo.level === 'us_zip' ? 'us_state' : 'country'] || base;
  const project = pkProjectionFor(geo.level);
  const features: any[] = (base && base.features) || [];
  const usa = project === pkAlbersUsa;
  const covered = (f: any): boolean => {
    if (!usa) return true;
    const p = pkFirstPoint(f.geometry);
    return !!p && pkUsaCovers(p[0], p[1]);
  };
  const drawn = features.filter((f) => f.properties && f.properties.name !== 'Antarctica' && covered(f));
  const b = pkBounds(drawn, project);
  const W = 960;
  const scale = W / Math.max(1e-9, b[2] - b[0]);
  const H = Math.max(120, Math.round((b[3] - b[1]) * scale));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'pub-map');
  svg.setAttribute('role', 'img');
  const items: any[] = Array.isArray(geo.items) ? geo.items : [];
  const vals = items.map((i) => i.value).filter((v: any) => typeof v === 'number');
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  const points = geo.points || chartType === 'map_bubble';
  // The offline basemap: land shapes from the bundled boundaries, under everything.
  for (const f of (points ? (land && land.features) || [] : drawn)) {
    if (!f.properties || f.properties.name === 'Antarctica' || !covered(f)) continue;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pkPathD(f.geometry, project, scale, b[0], b[1]));
    let t: number | null = null;
    let hit: any;
    if (!points) {
      hit = matchGeoItem(items, f.properties);
      t = hit ? pkRampT(hit.value, min, max) : null;
    }
    path.setAttribute('class', t === null ? 'pub-land' : 'pub-region');
    if (t !== null) path.setAttribute('fill-opacity', String(0.18 + 0.82 * t));
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = f.properties.name + (hit && typeof hit.value === 'number' ? ': ' + pcFmt(hit.value) : '');
    path.appendChild(title);
    svg.appendChild(path);
  }
  if (points) {
    for (const it of items) {
      if (typeof it.lat !== 'number' || typeof it.lng !== 'number' || (usa && !pkUsaCovers(it.lng, it.lat))) continue;
      const p = project(it.lng, it.lat);
      const c = document.createElementNS(SVG_NS, 'circle');
      const t = pkRampT(it.value, min, max);
      c.setAttribute('cx', ((p[0] - b[0]) * scale).toFixed(1));
      c.setAttribute('cy', ((p[1] - b[1]) * scale).toFixed(1));
      c.setAttribute('r', String(3 + 12 * (t === null ? 0 : Math.sqrt(t))));
      c.setAttribute('class', 'pub-point');
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = it.name + (typeof it.value === 'number' ? ': ' + pcFmt(it.value) : '');
      c.appendChild(title);
      svg.appendChild(c);
    }
  }
  const wrap = pcEl('div', 'pub-map-wrap');
  wrap.appendChild(svg);
  return wrap;
}

function pcChartBody(card: { chartType: string; category?: string }, payload: any, page: any, onPick: (label: string) => void): HTMLElement {
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
  holder.appendChild(canvas);
  if (typeof Chart === 'function') {
    const cfg = pkChartConfig(card.chartType, payload, pcRamp(), pcFmt);
    cfg.options.onClick = (_e: any, els: any[]) => {
      if (els && els.length && payload.labels) onPick(String(payload.labels[els[0].index]));
    };
    requestAnimationFrame(() => { pcCharts.push(new Chart(canvas, cfg)); });
  }
  return holder;
}

function pcCard(card: any, combo: number, page: any, onPick: (column: string, label: string) => void, top = 0): HTMLElement {
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
  if (card.kind === 'metric') {
    const box = pcEl('div', 'pub-kpi');
    box.appendChild(pcEl('div', 'pub-kpi-value', payload.display || '—'));
    el.appendChild(box);
  } else {
    el.appendChild(pcChartBody(card, payload, page, (label) => onPick(card.category || '', label)));
  }
  // A KPI's sentence only restates its figure; charts get theirs.
  if (payload.caption && card.kind !== 'metric') el.appendChild(pcEl('p', 'pub-caption', payload.caption));
  return el;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function pcDashboard(page: any, root: HTMLElement): void {
  const d = page.dashboard;
  const defaults: number[] = d.controls.map((c: any) => c.defaultIndex);
  let picks = defaults.slice();
  let sheet = 0;
  root.appendChild(pcEl('h1', 'pub-title', d.name));
  const bar = pcEl('div', 'pub-filters');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Filters');
  const selects: HTMLSelectElement[] = [];
  d.controls.forEach((c: any, i: number) => {
    const lab = pcEl('label', 'pub-filter');
    lab.appendChild(pcEl('span', 'pub-filter-label', c.label));
    const sel = document.createElement('select');
    sel.className = 'pub-filter-select';
    sel.dataset.control = String(i);
    c.options.forEach((o: string, j: number) => {
      const opt = document.createElement('option');
      opt.value = String(j);
      opt.textContent = o;
      sel.appendChild(opt);
    });
    sel.value = String(picks[i]);
    sel.addEventListener('change', () => { picks = pkNextPicks(d.mode, defaults, picks, i, Number(sel.value)); draw(); });
    selects.push(sel);
    lab.appendChild(sel);
    bar.appendChild(lab);
  });
  if (d.controls.length) {
    // On a phone the bar folds into one "Filters (N)" button that opens it as
    // a sheet. Which of the two shows is the stylesheet's call; this only
    // toggles the sheet open and shut.
    bar.id = 'pub-filters';
    const open = pcEl('button', 'pub-filters-open', `Filters (${d.controls.length})`) as HTMLButtonElement;
    open.type = 'button';
    open.setAttribute('aria-controls', 'pub-filters');
    open.setAttribute('aria-expanded', 'false');
    const done = pcEl('button', 'pub-filters-done', 'Done') as HTMLButtonElement;
    done.type = 'button';
    const setOpen = (on: boolean): void => {
      bar.classList.toggle('is-open', on);
      open.setAttribute('aria-expanded', String(on));
      if (on) (bar.querySelector('select') as HTMLElement | null)?.focus();
      else open.focus();
    };
    open.addEventListener('click', () => setOpen(!bar.classList.contains('is-open')));
    done.addEventListener('click', () => setOpen(false));
    bar.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bar.classList.contains('is-open')) setOpen(false); });
    bar.appendChild(done);
    root.appendChild(open);
    root.appendChild(bar);
    if (d.mode === 'single') root.appendChild(pcEl('p', 'pub-hint', 'This published copy changes one filter at a time.'));
  }
  const tabs = pcEl('div', 'pub-tabs');
  tabs.setAttribute('role', 'tablist');
  if (d.sheets.length > 1) {
    d.sheets.forEach((s: any, i: number) => {
      const b = pcEl('button', 'pub-tab', s.name) as HTMLButtonElement;
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => { sheet = i; draw(); });
      tabs.appendChild(b);
    });
    root.appendChild(tabs);
  }
  const grid = pcEl('div', 'pub-grid');
  root.appendChild(grid);

  // A click on a chart label selects that value in a control on the same column.
  const pick = (column: string, label: string): void => {
    const i = d.controls.findIndex((c: any) => c.column === column && c.kind !== 'parameter' && c.kind !== 'date_range');
    if (i < 0) return;
    const j = d.controls[i].options.indexOf(label);
    if (j < 0) return;
    picks = pkNextPicks(d.mode, defaults, picks, i, picks[i] === j ? 0 : j);
    draw();
  };

  function draw(): void {
    selects.forEach((s, i) => { s.value = String(picks[i]); });
    Array.from(tabs.children).forEach((t, i) => t.setAttribute('aria-selected', String(i === sheet)));
    while (pcCharts.length) { try { pcCharts.pop().destroy(); } catch (_) { /* already gone */ } }
    grid.textContent = '';
    const combo = pkComboIndex(d.keys, picks);
    const s = d.sheets[sheet];
    if (!s || !s.cards.length) { grid.appendChild(pcEl('p', 'pub-empty', 'This sheet is empty.')); return; }
    // Controls moved to the filter bar, so the rows they sat on are empty: start
    // the grid at the first row a tile actually uses.
    const top = Math.min(...s.cards.map((c: any) => c.layout.y));
    for (const card of s.cards) grid.appendChild(pcCard(card, combo < 0 ? 0 : combo, page, pick, top));
    document.body.dataset.combo = String(combo);
  }
  draw();
}

// ── Story ────────────────────────────────────────────────────────────────────

function pcStory(page: any, root: HTMLElement): void {
  const s = page.story;
  const col = pcEl('article', 'pub-story');
  col.appendChild(pcEl('h1', 'pub-title', s.name));
  for (const b of s.blocks) {
    if (b.kind === 'text') for (const para of String(b.text).split(/\n{2,}/)) if (para.trim()) col.appendChild(pcEl('p', 'pub-story-p', para));
    if (b.kind === 'callout') col.appendChild(pcEl('aside', 'pub-callout pub-callout--' + b.tone, b.text));
    if (b.kind === 'divider') col.appendChild(pcEl('hr', 'pub-divider'));
    if (b.kind === 'broken') col.appendChild(pcEl('div', 'pub-broken', b.reason));
    if (b.kind === 'image') {
      const fig = pcEl('figure', 'pub-figure');
      const img = document.createElement('img');
      img.src = b.src;
      img.alt = b.alt || '';
      fig.appendChild(img);
      if (b.caption) fig.appendChild(pcEl('figcaption', '', b.caption));
      col.appendChild(fig);
    }
    if (b.kind === 'metrics') {
      const row = pcEl('div', 'pub-metrics-row');
      for (const m of b.metrics) {
        const k = pcEl('div', 'pub-kpi');
        k.appendChild(pcEl('div', 'pub-kpi-value', m.display));
        k.appendChild(pcEl('div', 'pub-kpi-label', m.name));
        row.appendChild(k);
      }
      col.appendChild(row);
      if (b.caption) col.appendChild(pcEl('p', 'pub-caption', b.caption));
    }
    if (b.kind === 'chart') {
      const fig = pcEl('figure', 'pub-card pub-story-chart');
      fig.appendChild(pcEl('h3', 'pub-card-title', b.title));
      fig.appendChild(b.data && b.data.error ? pcEl('div', 'pub-broken', b.data.error) : pcChartBody({ chartType: b.chartType }, b.data || {}, page, () => { /* no filters in a story */ }));
      if (b.caption) fig.appendChild(pcEl('figcaption', 'pub-caption', b.caption));
      col.appendChild(fig);
    }
  }
  root.appendChild(col);
}

// ── Scorecard ────────────────────────────────────────────────────────────────

const PC_STATUS: Record<string, string> = { good: 'On track', warn: 'At risk', off: 'Off track', none: 'No target' };

/** A twelve-period line, drawn as an inline SVG from the app's figures. */
function pcSpark(values: Array<number | null>): SVGSVGElement | null {
  const pts = values.map((v, i) => (typeof v === 'number' ? [i, v] as [number, number] : null)).filter((p): p is [number, number] => !!p);
  if (pts.length < 2) return null;
  const W = 96; const H = 24;
  const ys = pts.map((p) => p[1]);
  const min = Math.min(...ys); const span = (Math.max(...ys) - min) || 1;
  const step = W / Math.max(1, values.length - 1);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(p[0] * step).toFixed(1)},${(H - 2 - ((p[1] - min) / span) * (H - 4)).toFixed(1)}`).join(' ');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'pub-sc-spark');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

function pcScorecard(page: any, root: HTMLElement): void {
  const sc = page.scorecard;
  root.appendChild(pcEl('h1', 'pub-title', sc.name));
  root.appendChild(pcEl('p', 'pub-sc-period', `${sc.window.label} · ${sc.window.from} – ${sc.window.to}`));
  const counts: Record<string, number> = { good: 0, warn: 0, off: 0, none: 0 };
  for (const r of sc.rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const sum = pcEl('div', 'pub-sc-summary');
  for (const st of ['good', 'warn', 'off']) {
    const item = pcEl('span', 'pub-sc-sum');
    item.append(pcEl('span', 'pub-sc-dot pub-sc-dot--' + st), pcEl('strong', '', String(counts[st])), pcEl('span', '', PC_STATUS[st].toLowerCase()));
    sum.appendChild(item);
  }
  root.appendChild(sum);
  const table = pcEl('table', 'pub-table pub-sc-table');
  const head = pcEl('thead');
  const hr = pcEl('tr');
  for (const t of ['', 'Metric', sc.window.label, 'Target', 'Attainment', 'vs previous', 'Last 12', 'Owner']) hr.appendChild(pcEl('th', '', t));
  head.appendChild(hr);
  table.appendChild(head);
  const body = pcEl('tbody');
  const grouped = sc.rows.some((r: any) => r.group);
  const order: string[] = [];
  for (const r of sc.rows) if (order.indexOf(r.group || '') < 0) order.push(r.group || '');
  if (grouped && order.indexOf('') > 0) { order.splice(order.indexOf(''), 1); order.push(''); }
  for (const g of order) {
    if (grouped) {
      const roll = sc.groups.find((x: any) => x.group === g);
      const tr = pcEl('tr', 'pub-sc-group');
      const td = pcEl('td', '', (g || 'Other') + (roll && roll.scored ? ` — ${roll.onTrack} of ${roll.scored} on track` : ''));
      td.setAttribute('colspan', '8');
      tr.appendChild(td);
      body.appendChild(tr);
    }
    for (const r of sc.rows.filter((x: any) => (x.group || '') === g)) {
      const tr = pcEl('tr');
      const dot = pcEl('td');
      const d = pcEl('span', 'pub-sc-dot pub-sc-dot--' + r.status);
      d.setAttribute('title', PC_STATUS[r.status] || '');
      d.setAttribute('aria-label', PC_STATUS[r.status] || '');
      dot.appendChild(d);
      tr.appendChild(dot);
      tr.appendChild(pcEl('td', 'pub-sc-name', r.name));
      tr.appendChild(pcEl('td', 'num pub-sc-value', r.display || '—'));
      tr.appendChild(pcEl('td', 'num', r.targetDisplay || '—'));
      const att = pcEl('td', 'num');
      if (typeof r.attainment === 'number') {
        const bar = pcEl('span', 'pub-sc-bar pub-sc-bar--' + r.status);
        const fill = pcEl('span', 'pub-sc-fill');
        fill.style.width = Math.max(2, Math.min(100, (r.attainment / 150) * 100)) + '%';
        bar.appendChild(fill);
        att.append(bar, pcEl('span', '', Math.round(r.attainment) + '%'));
      } else att.textContent = '—';
      tr.appendChild(att);
      const chg = r.deltaDisplay ? r.deltaDisplay + (typeof r.pct === 'number' ? ` (${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}%)` : '') : '—';
      tr.appendChild(pcEl('td', 'num pub-sc-tone--' + r.tone, chg));
      const sp = pcEl('td', 'pub-sc-spark-cell pub-sc-dot-c--' + r.status);
      const svg = pcSpark(r.spark || []);
      if (svg) sp.appendChild(svg);
      tr.appendChild(sp);
      tr.appendChild(pcEl('td', '', r.owner || ''));
      body.appendChild(tr);
    }
  }
  table.appendChild(body);
  const wrap = pcEl('div', 'pub-card pub-sc-card');
  wrap.appendChild(table);
  root.appendChild(wrap);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

(function pcBoot() {
  const data = document.getElementById('ordinate-page');
  if (!data) return;
  let page: any;
  try { page = JSON.parse(data.textContent || '{}'); } catch (_) { return; }
  try { if (typeof OrdFormat === 'object' && page.formats) OrdFormat.setFormatPrefs(page.formats); } catch (_) { /* defaults */ }
  document.body.appendChild(pcHeader(page));
  const root = pcEl('main', 'pub-root');
  document.body.appendChild(root);
  if (page.kind === 'story') pcStory(page, root);
  else if (page.kind === 'scorecard') pcScorecard(page, root);
  else if (page.kind === 'index') pcIndex(page, root);
  else pcDashboard(page, root);
  document.body.dataset.ready = 'true';
})();
