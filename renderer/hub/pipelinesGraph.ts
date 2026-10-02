'use strict';

// The Pipelines tab's GRAPH — six stage columns of step cards, with the edges
// drawn over them in one SVG. Classic global-scope renderer <script>.
//
// Cards are HTML (a status, three lines of schedule/last/next, keyboard focus)
// in a CSS grid, so the browser lays them out; the edges are measured off the
// laid-out cards afterwards and redrawn on resize. Main already ordered each
// column to keep crossings down (src/app/pipelines.ts orderRows).

const PQ_NS = 'http://www.w3.org/2000/svg';

const PQ_KIND: Record<string, { word: string; icon: string }> = {
  source: { word: t('common.source'), icon: 'plug' },
  dataset: { word: t('common.dataset'), icon: 'database' },
  quality: { word: t('pipelinesGraph.quality_checks'), icon: 'shield' },
  alert: { word: t('common.alert'), icon: 'bell' },
  report: { word: t('common.report'), icon: 'file-text' },
  publish: { word: t('common.publish_2'), icon: 'globe' },
};

const PQ_STATUS: Record<string, { word: string; icon: string }> = {
  running: { word: t('common.running_2'), icon: 'loader' },
  queued: { word: t('pipelinesGraph.queued'), icon: 'history' },
  ok: { word: 'OK', icon: 'circle-check' },
  failed: { word: t('common.failed'), icon: 'alert' },
  blocked: { word: t('pipelinesGraph.blocked'), icon: 'lock' },
  paused: { word: t('pipelinesGraph.paused'), icon: 'circle' },
  never: { word: t('nbPage.not_run_yet'), icon: 'circle' },
  source: { word: t('common.source'), icon: 'arrow-right' },
};

/** What a card's pill says: live state first, then a pause, then the last run. */
function pqStatusOf(n: any): string {
  if (pqLive[n.id]) return pqLive[n.id];
  if (n.paused) return 'paused';
  if (n.lastRun) return n.lastRun.status;
  // A source has nothing of its own to run; "not run yet" would read as a fault.
  return n.kind === 'source' ? 'source' : 'never';
}

function pqIconFor(n: any): string {
  if (n.kind === 'source') {
    if (/^source:file:/.test(n.id)) return 'file-text';
    if (/^source:url:/.test(n.id)) return 'link';
    return /Watching/.test(n.schedule.text) ? 'folder' : 'plug';
  }
  if (n.kind === 'dataset' && n.stage === 2) return 'code';
  return (PQ_KIND[n.kind] || PQ_KIND.dataset).icon;
}

function pqCard(n: any): HTMLElement {
  const st = pqStatusOf(n);
  const s = PQ_STATUS[st] || PQ_STATUS.never;
  const card = pqEl('div', `pq-node is-${st}` + (n.id === pqSel ? ' is-selected' : ''));
  card.dataset.nodeId = n.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-pressed', String(n.id === pqSel));
  card.setAttribute('aria-label', `${(PQ_KIND[n.kind] || PQ_KIND.dataset).word}: ${n.name}. ${s.word}. ${n.schedule.text}.`);

  const top = pqEl('div', 'pq-node-top');
  const ic = pqEl('span', 'pq-node-ic');
  ic.appendChild(icon(pqIconFor(n), 16));
  const id = pqEl('div', 'pq-node-id');
  const name = pqEl('div', 'pq-node-name', n.name);
  name.title = n.name;
  id.append(name, pqEl('div', 'pq-node-sub', n.sub || (PQ_KIND[n.kind] || PQ_KIND.dataset).word));
  top.append(ic, id);

  const pill = pqEl('span', 'pq-pill pq-pill--' + st);
  pill.appendChild(icon(s.icon, 12));
  pill.appendChild(pqEl('span', '', s.word));

  const meta = pqEl('div', 'pq-node-meta');
  const line = (ic2: string, text: string, cls = ''): void => {
    const r = pqEl('div', 'pq-meta' + (cls ? ' ' + cls : ''));
    r.appendChild(icon(ic2, 12));
    r.appendChild(pqEl('span', '', text));
    meta.appendChild(r);
  };
  line('calendar', n.schedule.text);
  line('history', n.lastRun ? `${pqRel(n.lastRun.at)}${n.lastRun.durationMs !== undefined ? ' · ' + pqDur(n.lastRun.durationMs) : ''}` : t('common.never_run'));
  line('arrow-right', n.nextRunAt ? t('pipelinesGraph.next', { p0: (Date.parse(n.nextRunAt) <= Date.now() ? t('common.on_the_next_check') : pqRel(n.nextRunAt)) }) : t('pipelinesGraph.no_run_planned'), n.nextRunAt ? '' : 'is-dim');
  card.append(top, pill, meta);

  const select = (): void => {
    pqSel = pqSel === n.id ? null : n.id;
    pqRender();
    if (pqSel) document.getElementById('pq-detail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  card.addEventListener('click', select);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
  });
  card.addEventListener('mouseenter', () => pqHighlight(n.id));
  card.addEventListener('mouseleave', () => pqHighlight(pqSel));
  return card;
}

function pqGraph(v: any): HTMLElement {
  const graph = pqEl('div', 'pq-graph');
  graph.id = 'pq-graph';
  const cols = pqEl('div', 'pq-cols');
  const svg = document.createElementNS(PQ_NS, 'svg');
  svg.setAttribute('class', 'pq-edges');
  svg.setAttribute('aria-hidden', 'true');
  cols.appendChild(svg);
  cols.style.gridTemplateColumns = v.stages
    .map((_s: string, i: number) => (v.nodes.some((n: any) => n.stage === i) ? 'minmax(140px, 1fr)' : '100px')).join(' ');
  v.stages.forEach((stage: string, i: number) => {
    const inStage = v.nodes.filter((n: any) => n.stage === i);
    const col = pqEl('div', 'pq-col');
    col.setAttribute('role', 'group');
    col.setAttribute('aria-label', stage);
    const h = pqEl('div', 'pq-col-h');
    h.appendChild(pqEl('span', '', stage));
    h.appendChild(pqEl('span', 'pq-col-n', String(inStage.length)));
    col.appendChild(h);
    if (!inStage.length) col.appendChild(pqEl('div', 'pq-col-none', t('common.none')));
    for (const n of inStage) col.appendChild(pqCard(n));
    cols.appendChild(col);
  });
  graph.appendChild(cols);
  return graph;
}

/** Measure the laid-out cards and draw every edge between them. */
function pqDrawEdges(): void {
  const cols = document.querySelector('#pq-graph .pq-cols') as HTMLElement | null;
  const svg = cols && cols.querySelector('svg.pq-edges');
  if (!cols || !svg || !pqView || !pqView.ok) return;
  svg.textContent = '';
  const W = cols.scrollWidth;
  const H = cols.scrollHeight;
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const base = cols.getBoundingClientRect();
  const box = new Map<string, DOMRect>();
  cols.querySelectorAll<HTMLElement>('.pq-node').forEach((el) => box.set(el.dataset.nodeId || '', el.getBoundingClientRect()));
  const status = new Map<string, string>(pqView.nodes.map((n: any) => [n.id, pqStatusOf(n)]));
  for (const e of pqView.edges) {
    const a = box.get(e.from);
    const b = box.get(e.to);
    if (!a || !b) continue;
    let d: string;
    if (Math.abs(a.left - b.left) < 4) {
      // Same column (a SQL dataset over another): a loop out to the right.
      const x = a.right - base.left;
      const y1 = a.top + a.height / 2 - base.top;
      const y2 = b.top + b.height / 2 - base.top;
      d = `M${x} ${y1} C${x + 22} ${y1}, ${x + 22} ${y2}, ${x} ${y2}`;
    } else {
      const x1 = a.right - base.left;
      const y1 = a.top + a.height / 2 - base.top;
      const x2 = b.left - base.left;
      const y2 = b.top + b.height / 2 - base.top;
      const dx = Math.max(18, (x2 - x1) / 2);
      d = `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    }
    const p = document.createElementNS(PQ_NS, 'path');
    const to = status.get(e.to);
    p.setAttribute('class', 'pq-edge' + (to === 'blocked' ? ' is-blocked' : '') + (to === 'running' || to === 'queued' ? ' is-live' : ''));
    p.setAttribute('d', d);
    p.dataset.from = e.from;
    p.dataset.to = e.to;
    svg.appendChild(p);
  }
  pqHighlight(pqSel);
}

/** Light up a step's whole path — everything it feeds and everything feeding it. */
function pqHighlight(id: string | null): void {
  const cols = document.querySelector('#pq-graph .pq-cols');
  if (!cols || !pqView || !pqView.ok) return;
  const rel = new Set<string>();
  if (id) {
    const walk = (start: string, dir: 'from' | 'to'): void => {
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const e of pqView.edges) {
          const [here, next] = dir === 'from' ? [e.from, e.to] : [e.to, e.from];
          if (here === cur && !rel.has(next)) { rel.add(next); stack.push(next); }
        }
      }
    };
    rel.add(id);
    walk(id, 'from');
    walk(id, 'to');
  }
  cols.classList.toggle('is-tracing', Boolean(id));
  cols.querySelectorAll<HTMLElement>('.pq-node').forEach((el) => el.classList.toggle('is-related', rel.has(el.dataset.nodeId || '')));
  cols.querySelectorAll<SVGPathElement>('.pq-edge').forEach((p) => p.classList.toggle('is-related', rel.has(p.dataset.from || '') && rel.has(p.dataset.to || '')));
}
