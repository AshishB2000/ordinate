'use strict';

// The published site's renderer, DOM half: the pages that are not a dashboard —
// the site's index, a story and a scorecard. A classic script inlined after
// publishMaps.js. Every string goes in through textContent; every figure is
// the app's, already formatted where the server formatted it.

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
      fig.appendChild(b.data && b.data.error ? pcEl('div', 'pub-broken', b.data.error) : pcChartBody({ chartType: b.chartType, title: b.title }, b.data || {}, page, () => { /* no filters in a story */ }));
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
  // How many are on track, at risk, off track: the server's count (the app's scorecard shows the same), never tallied here.
  const counts: Record<string, number> = sc.counts || {};
  const sum = pcEl('div', 'pub-sc-summary');
  for (const st of ['good', 'warn', 'off']) {
    const item = pcEl('span', 'pub-sc-sum');
    item.append(pcEl('span', 'pub-sc-dot pub-sc-dot--' + st), pcEl('strong', '', String(counts[st] ?? 0)), pcEl('span', '', PC_STATUS[st].toLowerCase()));
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
        att.append(bar, pcEl('span', '', OrdFormat.formatNumber(r.attainment, { decimals: 0 }) + '%'));
      } else att.textContent = '—';
      tr.appendChild(att);
      const chg = r.deltaDisplay ? r.deltaDisplay + (typeof r.pct === 'number' ? ` (${r.pct > 0 ? '+' : ''}${OrdFormat.formatNumber(r.pct, { decimals: 1 })}%)` : '') : '—';
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
