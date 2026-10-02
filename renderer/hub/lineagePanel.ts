// Lineage — the dependency graph around one record, drawn in the shared right
// panel. Classic global-scope renderer <script>: no import/export.
//
// Main builds and lays out the graph (src/analysis/lineage.ts): every node
// arrives with a column and a row, so this file only turns them into pixels.
// Plain SVG, no library: cards with the type's icon and name, 1px curves
// between them, the record you opened from ringed in the accent. Hover a card
// and everything not on a path through it dims; click one to open it.

const LN_W = 168;
const LN_H = 52;
const LN_COL_GAP = 40;
const LN_ROW_GAP = 18;
const LN_PAD = 8;
const LN_HEAD = 30;
const LN_NS = 'http://www.w3.org/2000/svg';

const LN_KIND: Record<string, { word: string; plural: string; icon: string }> = {
  source: { word: 'Source', plural: 'Sources', icon: 'file-text' },
  dataset: { word: 'Dataset', plural: 'Datasets', icon: 'database' },
  prepare: { word: 'Prepare', plural: 'Prepare', icon: 'sliders' },
  calc: { word: 'Calculated field', plural: 'Calculated fields', icon: 'function' },
  metric: { word: 'Metric', plural: 'Metrics', icon: 'gauge' },
  visual: { word: 'Visual', plural: 'Visuals', icon: 'chart-bar' },
  dashboard: { word: 'Dashboard', plural: 'Dashboards', icon: 'layout-dashboard' },
  report: { word: 'Report', plural: 'Reports', icon: 'file-text' },
  alert: { word: 'Alert', plural: 'Alerts', icon: 'bell' },
};

const LN_TYPE_WORD: Record<string, string> = {
  dataset: 'Dataset', visual: 'Visual', dashboard: 'Dashboard', metric: 'Metric', report: 'Report', alert: 'Alert',
};

function lnSvg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(LN_NS, tag) as SVGElement;
  for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
  return el;
}

/** "Used in 3 visuals · 1 dashboard" — the dataset header's line, and the panel's. */
function lnUsedInText(usedIn: any): string {
  const parts: string[] = [];
  const add = (k: string, one: string, many: string): void => {
    const n = usedIn && usedIn[k];
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  // A dataset built FROM this one (combined, or reading it in a union/lookup step).
  add('dataset', 'dataset', 'datasets');
  add('visual', 'visual', 'visuals');
  add('dashboard', 'dashboard', 'dashboards');
  add('report', 'report', 'reports');
  add('alert', 'alert', 'alerts');
  return parts.length ? 'Used in ' + parts.join(' · ') : '';
}

async function lnOpen(type: string, id: string, name?: string): Promise<void> {
  if (!currentProjectId || !id || !LN_TYPE_WORD[type]) return;
  const panel = spOpen({
    kind: 'lineage', wide: true,
    title: name || LN_TYPE_WORD[type],
    sub: 'Lineage · ' + LN_TYPE_WORD[type],
  });
  panel.el.dataset.recordId = id;
  const loading = document.createElement('p');
  loading.className = 'dsp-note';
  loading.textContent = 'Tracing what this is built from…';
  panel.body.appendChild(loading);
  let g: any = null;
  try { g = await window.hub.lineageGet(currentProjectId, type, id); } catch (_) { g = null; }
  if (!spIsOpen('lineage') || panel.el.dataset.recordId !== id) return;
  panel.body.textContent = '';
  if (!g || !Array.isArray(g.nodes) || !g.nodes.length) {
    panel.body.appendChild(makeEmptyState({
      variant: 'starred', iconName: 'lineage', title: 'Nothing to trace',
      line: 'This record could not be found in the project.',
    }));
    return;
  }
  panel.body.appendChild(lnSummary(g));
  const scroll = document.createElement('div');
  scroll.className = 'ln-scroll';
  const svg = lnDraw(g);
  scroll.appendChild(svg);
  panel.body.appendChild(scroll);
  // Fit the width when it is close: a graph a little wider than the panel reads
  // better slightly smaller than behind a scrollbar. Past 72% it scrolls instead.
  const W = Number(svg.getAttribute('width'));
  const avail = scroll.clientWidth - 4;
  if (W > avail && avail > 0) {
    const k = Math.max(0.66, avail / W);
    svg.setAttribute('width', String(Math.round(W * k)));
    svg.setAttribute('height', String(Math.round(Number(svg.getAttribute('height')) * k)));
  }
  if (g.nodes.length === 1) {
    const note = document.createElement('p');
    note.className = 'dsp-note ln-alone';
    note.textContent = 'Nothing is built from this yet, and it reads from nothing else in the project.';
    panel.body.appendChild(note);
  }
}

/** One strip over the graph: how much sits on each side of the record. */
function lnSummary(g: any): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'ln-summary';
  const focusNode = g.nodes.find((n: any) => n.id === g.focus);
  const upstream = g.nodes.filter((n: any) => n.col < (focusNode ? focusNode.col : 0)).length;
  const used = lnUsedInText(g.usedIn);
  const chips: Array<[string, string]> = [];
  chips.push(['lineage', upstream ? `Built from ${upstream} ${upstream === 1 ? 'record' : 'records'}` : 'Built from nothing else here']);
  chips.push(['chart-bar', used || 'Not used by anything yet']);
  for (const [ic, text] of chips) {
    const c = document.createElement('span');
    c.className = 'ln-chip';
    c.appendChild(icon(ic, 14));
    const t = document.createElement('span');
    t.textContent = text;
    c.appendChild(t);
    strip.appendChild(c);
  }
  const hint = document.createElement('span');
  hint.className = 'ln-hint';
  hint.textContent = 'Hover to follow a path · click to open';
  strip.appendChild(hint);
  return strip;
}

function lnIconFor(n: any): string {
  if (n.kind === 'source' && n.ref && n.ref.type === 'connection') return 'plug';
  if (n.kind === 'source' && n.ref && n.ref.type === 'capture') return 'camera';
  if (n.kind === 'source' && /^source:notebook:/.test(n.id || '')) return 'file-text'; // r7:notebooks
  if (n.kind === 'source' && /Web address/.test(n.sub || '')) return 'link';
  return (LN_KIND[n.kind] || LN_KIND.dataset).icon;
}

/** A column's heading — blank when it continues the band to its left. */
function lnColLabel(g: any, c: number): string {
  const kinds = [...new Set(g.nodes.filter((n: any) => n.col === c).map((n: any) => n.kind))] as string[];
  return kinds.map((k) => (LN_KIND[k] || LN_KIND.dataset).plural).join(' & ');
}

/** Fit a name to the card: a character budget, the full name in the tooltip. */
function lnFit(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function lnDraw(g: any): SVGSVGElement {
  const cols = Math.max(1, Number(g.columns) || 1);
  const rows = Math.max(1, ...g.nodes.map((n: any) => (n.row || 0) + 1));
  const W = LN_PAD * 2 + cols * LN_W + (cols - 1) * LN_COL_GAP;
  const H = LN_HEAD + LN_PAD * 2 + rows * LN_H + (rows - 1) * LN_ROW_GAP;
  const svg = lnSvg('svg', { class: 'ln-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' }) as SVGSVGElement;
  svg.setAttribute('aria-label', 'Lineage graph');
  const x = (c: number): number => LN_PAD + c * (LN_W + LN_COL_GAP);
  const y = (r: number): number => LN_HEAD + LN_PAD + r * (LN_H + LN_ROW_GAP);

  // Column heads: what the column holds, in the plural.
  for (let c = 0; c < cols; c++) {
    const kinds = [...new Set(g.nodes.filter((n: any) => n.col === c).map((n: any) => n.kind))] as string[];
    const label = kinds.map((k) => (LN_KIND[k] || LN_KIND.dataset).plural).join(' & ');
    const t = lnSvg('text', { class: 'ln-col-h', x: x(c) + 2, y: 14 });
    t.textContent = c > 0 && label === lnColLabel(g, c - 1) ? '' : label.toUpperCase();
    svg.appendChild(t);
  }

  const byId = new Map<string, any>(g.nodes.map((n: any) => [n.id, n]));
  const edgeEls: Array<{ el: SVGElement; from: string; to: string }> = [];
  const edgeLayer = lnSvg('g', { class: 'ln-edges' });
  for (const e of g.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const x1 = x(a.col) + LN_W;
    const y1 = y(a.row) + LN_H / 2;
    const x2 = x(b.col);
    const y2 = y(b.row) + LN_H / 2;
    let d: string;
    if (b.col - a.col <= 1) {
      const dx = Math.max(16, (x2 - x1) / 2);
      d = `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    } else {
      // A column is skipped: a straight curve would run BEHIND the cards in
      // between and read as coming from them. Drop into the gutter under the
      // source row, run along it — no card sits in a gutter — and rise into
      // the target inside the column gap before it.
      const yg = y(a.row) + LN_H + LN_ROW_GAP / 2;
      const s = LN_COL_GAP / 2;
      d = `M${x1} ${y1} C${x1 + s} ${y1}, ${x1 + s / 2} ${yg}, ${x1 + s} ${yg}`
        + ` L${x2 - s} ${yg} C${x2 - s / 2} ${yg}, ${x2 - s} ${y2}, ${x2} ${y2}`;
    }
    const p = lnSvg('path', { class: 'ln-edge', d });
    edgeLayer.appendChild(p);
    edgeEls.push({ el: p, from: e.from, to: e.to });
  }
  svg.appendChild(edgeLayer);

  // Up/down adjacency, for hover.
  const ups = new Map<string, string[]>();
  const downs = new Map<string, string[]>();
  for (const e of g.edges) {
    (ups.get(e.to) || ups.set(e.to, []).get(e.to)!).push(e.from);
    (downs.get(e.from) || downs.set(e.from, []).get(e.from)!).push(e.to);
  }
  const reach = (start: string, next: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length) for (const n of next.get(stack.pop()!) || []) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    return seen;
  };

  const nodeEls = new Map<string, SVGElement>();
  for (const n of g.nodes) {
    const k = LN_KIND[n.kind] || LN_KIND.dataset;
    const grp = lnSvg('g', {
      class: 'ln-node ln-node--' + n.kind + (n.id === g.focus ? ' is-focus' : '') + (n.ref ? ' is-link' : ''),
      transform: `translate(${x(n.col)} ${y(n.row)})`,
      tabindex: 0, role: 'button',
    });
    grp.setAttribute('aria-label', `${k.word}: ${n.name}${n.sub ? ', ' + n.sub : ''}`);
    const title = lnSvg('title', {});
    title.textContent = `${n.name}\n${k.word}${n.sub ? ' · ' + n.sub : ''}`;
    grp.appendChild(title);
    grp.appendChild(lnSvg('rect', { class: 'ln-card', width: LN_W, height: LN_H, rx: 10 }));
    grp.appendChild(lnSvg('rect', { class: 'ln-ic-bg', x: 10, y: 12, width: 28, height: 28, rx: 7 }));
    const ic = lnSvg('svg', {
      class: 'ln-ic', x: 16, y: 18, width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
    ic.appendChild(lnSvg('use', { href: '#i-' + lnIconFor(n) }));
    grp.appendChild(ic);
    const name = lnSvg('text', { class: 'ln-name', x: 48, y: 23 });
    name.textContent = lnFit(String(n.name || ''), 16);
    grp.appendChild(name);
    const sub = lnSvg('text', { class: 'ln-sub', x: 48, y: 39 });
    sub.textContent = lnFit(String(n.sub || k.word), 21);
    grp.appendChild(sub);

    const related = (): Set<string> => new Set([...reach(n.id, ups), ...reach(n.id, downs)]);
    grp.addEventListener('mouseenter', () => {
      const rel = related();
      svg.classList.add('is-hovering');
      nodeEls.forEach((el, id) => el.classList.toggle('is-related', rel.has(id)));
      for (const e of edgeEls) e.el.classList.toggle('is-related', rel.has(e.from) && rel.has(e.to));
    });
    grp.addEventListener('mouseleave', () => {
      svg.classList.remove('is-hovering');
      nodeEls.forEach((el) => el.classList.remove('is-related'));
      for (const e of edgeEls) e.el.classList.remove('is-related');
    });
    const open = (): void => { void lnOpenNode(n); };
    grp.addEventListener('click', open);
    grp.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') { e.preventDefault(); open(); }
    });
    svg.appendChild(grp);
    nodeEls.set(n.id, grp);
  }
  return svg;
}

/** Open what a node stands for, through each surface's own opener. */
async function lnOpenNode(n: any): Promise<void> {
  const ref = n && n.ref;
  if (!ref || !currentProjectId) return;
  spClose();
  if (ref.type === 'dataset') {
    await openRecentItem({ type: 'dataset', id: ref.id, projectId: currentProjectId, name: n.name });
    if (n.kind === 'calc' || n.kind === 'prepare') document.getElementById('ds-tab-prepare')?.click();
  } else if (ref.type === 'visual') {
    selectSection('visuals');
    await openSavedVisual(ref.id);
  } else if (ref.type === 'dashboard') {
    await openRecentItem({ type: 'analysis', id: ref.id, projectId: currentProjectId, name: n.name });
  } else if (ref.type === 'report') {
    selectSection('analyses');
    if (typeof rbOpenReportById === 'function') await rbOpenReportById(ref.id);
  } else if (ref.type === 'metric') {
    const r = await window.hub.getMetric(currentProjectId, ref.id).catch(() => null);
    if (r && r.ok && typeof mpOpenEditor === 'function') await mpOpenEditor(r.metric);
  } else if (ref.type === 'alert') {
    if (typeof aiOpenRulesPage === 'function') await aiOpenRulesPage();
  } else if (ref.type === 'connection') {
    if (typeof openConnPanel === 'function') openConnPanel();
  } else if (ref.type === 'capture') {
    if (typeof openCaptureFromSummary === 'function') openCaptureFromSummary({ id: ref.id, title: n.name });
  } else if (ref.type === 'notebook') {
    await nbOpenById(ref.id); // r7:notebooks — nbList.ts
  }
}

/** The dataset page's "Used in 3 visuals · 1 dashboard", which opens the panel. */
async function lnPaintUsedIn(datasetId: string): Promise<void> {
  const el = document.getElementById('ds-explorer-usedin');
  if (!el || !currentProjectId) return;
  el.hidden = true;
  let g: any = null;
  try { g = await window.hub.lineageGet(currentProjectId, 'dataset', datasetId); } catch (_) { g = null; }
  if (expId !== datasetId || !g) return;
  const label = el.querySelector('span');
  if (label) label.textContent = lnUsedInText(g.usedIn) || 'Not used yet';
  el.hidden = false;
}

function initLineagePanel(): void {
  const used = document.getElementById('ds-explorer-usedin');
  if (used) used.addEventListener('click', () => { if (expId) void lnOpen('dataset', expId, expName); });
}
