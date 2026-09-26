'use strict';

// The Data page's RELATIONSHIPS tab — the project data model. Classic
// global-scope renderer <script>: no import/export.
//
// A canvas of dataset cards joined by their relationships (many side on the
// left, the lookup on the right), the same relationships as a keyboard-first
// table under it, and the New relationship dialog, whose key suggestions are
// ranked in main by name, type and a sampled match rate.
//
// The tab and its panel are BUILT here rather than spelled in index.html, and
// the switch is handled here too: the strip's other tabs belong to
// captureList.ts, which hides only the panels it knows. A click on any of them
// bubbles to the strip, where this file stands its own panel down.

let relModel: any[] = [];
let relDatasets: any[] = [];
let relSelectedId = '';
let relMetas = new Map<string, any>();

const REL_SUB = 'Relate datasets once — visuals then use columns from all of them, joined live when they ask.';

function relEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function relName(id: string): string {
  const d = relDatasets.find((x) => x.id === id);
  return d ? String(d.name) : 'Missing dataset';
}

function relRate(r: any): number {
  const n = r.verified.matched + r.verified.unmatchedFrom;
  return n ? r.verified.matched / n : 0;
}

function relPct(x: number): string {
  return (Math.round(x * 1000) / 10).toLocaleString() + '%';
}

function relCardLabel(c: string): string {
  return c === 'one_to_one' ? '1:1' : 'N:1';
}

// ── The tab ──────────────────────────────────────────────────────────────────

function relShowTab(on: boolean): void {
  const tab = relEl('ds-tab-relationships');
  const panel = relEl('rel-wrap');
  if (!tab || !panel) return;
  tab.setAttribute('aria-selected', String(on));
  tab.tabIndex = on ? 0 : -1;
  panel.hidden = !on;
  if (!on) return;
  const strip = tab.parentElement as HTMLElement;
  strip.querySelectorAll('[role="tab"]').forEach((t) => {
    if (t === tab) return;
    t.setAttribute('aria-selected', 'false');
    (t as HTMLElement).tabIndex = -1;
    const other = relEl(t.getAttribute('aria-controls') || '');
    if (other) other.hidden = true;
  });
  const actions = document.querySelector('.ds-head-actions') as HTMLElement | null;
  if (actions) actions.hidden = true;
  const metricActions = relEl('mp-actions-row');
  if (metricActions) metricActions.hidden = true;
  const sub = relEl('ds-sub');
  if (sub) sub.textContent = REL_SUB;
  void refreshRelationships();
}

function initRelationshipsPage(): void {
  const captures = relEl('ds-tab-captures');
  const capPanel = relEl('cap-grid-wrap');
  if (!captures || !capPanel || relEl('ds-tab-relationships')) return;

  const tab = document.createElement('button');
  tab.className = 'ds-tab';
  tab.type = 'button';
  tab.id = 'ds-tab-relationships';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.setAttribute('aria-controls', 'rel-wrap');
  tab.tabIndex = -1;
  tab.textContent = 'Relationships';
  captures.after(tab);

  const panel = document.createElement('div');
  panel.id = 'rel-wrap';
  panel.className = 'rel-wrap';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'ds-tab-relationships');
  panel.hidden = true;
  capPanel.after(panel);

  const head = document.createElement('div');
  head.className = 'rel-actions';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-primary';
  add.id = 'rel-new';
  add.appendChild(icon('plus'));
  const addLabel = document.createElement('span');
  addLabel.textContent = 'New relationship';
  add.appendChild(addLabel);
  add.addEventListener('click', () => void openRelationshipDialog());
  const count = document.createElement('span');
  count.className = 'viz-count';
  count.id = 'rel-count';
  const explain = document.createElement('p');
  explain.className = 'rel-explain';
  explain.textContent =
    'A relationship joins live at query time and copies nothing; Combine datasets makes a new, materialised dataset instead.';
  head.append(add, count, explain);

  const canvas = document.createElement('div');
  canvas.className = 'rel-canvas';
  canvas.id = 'rel-canvas';
  canvas.setAttribute('role', 'group');
  canvas.setAttribute('aria-label', 'Data model diagram');

  const table = document.createElement('div');
  table.className = 'ws-table rel-table';
  const cols = document.createElement('div');
  cols.className = 'ws-table-cols rel-cols';
  ['Many side', 'One side', 'Kind', 'Matched', 'Unmatched', 'Action'].forEach((t, i) => {
    const s = document.createElement('span');
    s.textContent = t;
    if (i === 5) s.className = 'ws-col-action';
    cols.appendChild(s);
  });
  const list = document.createElement('div');
  list.id = 'rel-list';
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Relationships');
  table.append(cols, list);

  panel.append(head, canvas, table);

  tab.addEventListener('click', () => relShowTab(true));
  (captures.parentElement as HTMLElement).addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('[role="tab"]');
    if (t && t !== tab) relShowTab(false);
  });
  window.addEventListener('resize', () => { if (!panel.hidden) relDrawEdges(); });
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function refreshRelationships(): Promise<void> {
  if (!currentProjectId) return;
  const pid = currentProjectId;
  const [res, list] = await Promise.all([
    window.hubAuthoring.listRelationships(pid),
    window.hub.listDatasets(pid),
  ]);
  if (pid !== currentProjectId) return;
  relModel = res && res.ok ? res.relationships : [];
  relDatasets = Array.isArray(list) ? list : [];
  const count = relEl('rel-count');
  if (count) count.textContent = relModel.length === 1 ? '1 relationship' : `${relModel.length} relationships`;
  relRenderCanvas();
  relRenderList();
}

// ── Canvas ───────────────────────────────────────────────────────────────────

/**
 * Columns by depth: a dataset sits one column right of every dataset that looks
 * rows up in it, so a fact table reads left of its lookups. Unrelated datasets
 * get their own last column. Relaxation is capped at N passes, which also ends a
 * one-to-one cycle.
 */
function relLayout(): { cols: string[][]; unrelated: string[] } {
  const ids = relDatasets.map((d) => d.id);
  const linked = new Set<string>();
  relModel.forEach((r) => { linked.add(r.from.datasetId); linked.add(r.to.datasetId); });
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const r of relModel) {
      const want = (rank.get(r.from.datasetId) || 0) + 1;
      if (rank.has(r.to.datasetId) && (rank.get(r.to.datasetId) as number) < want && want < ids.length) {
        rank.set(r.to.datasetId, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const cols: string[][] = [];
  for (const id of ids) {
    if (!linked.has(id)) continue;
    const k = rank.get(id) || 0;
    (cols[k] = cols[k] || []).push(id);
  }
  return { cols: cols.filter(Boolean), unrelated: ids.filter((id) => !linked.has(id)) };
}

function relKeyColumns(id: string): string[] {
  const out = new Set<string>();
  relModel.forEach((r) => {
    if (r.from.datasetId === id) out.add(r.from.column);
    if (r.to.datasetId === id) out.add(r.to.column);
  });
  return [...out];
}

function relMakeCard(id: string): HTMLElement {
  const d = relDatasets.find((x) => x.id === id) || {};
  const card = document.createElement('div');
  card.className = 'rel-node';
  card.dataset.datasetId = id;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Dataset ' + String(d.name || ''));
  const top = document.createElement('div');
  top.className = 'rel-node-head';
  top.appendChild(icon('database', 14));
  const name = document.createElement('span');
  name.className = 'rel-node-name';
  name.textContent = String(d.name || 'Dataset');
  top.appendChild(name);
  const meta = document.createElement('div');
  meta.className = 'rel-node-meta';
  meta.textContent = `${Number(d.rowCount || 0).toLocaleString()} rows · ${Number(d.columnCount || 0)} columns`;
  card.append(top, meta);
  const keys = relKeyColumns(id);
  if (keys.length) {
    const chips = document.createElement('div');
    chips.className = 'rel-node-keys';
    keys.forEach((k) => {
      const c = document.createElement('span');
      c.className = 'rel-key';
      c.dataset.column = k;
      c.appendChild(icon('link', 12));
      c.append(k);
      chips.appendChild(c);
    });
    card.appendChild(chips);
  }
  return card;
}

function relRenderCanvas(): void {
  const canvas = relEl('rel-canvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  if (relDatasets.length < 2) {
    canvas.appendChild(relEmpty(
      'Relate two datasets',
      'A relationship needs two datasets — say orders and a table of targets or regions. Import the second one, then relate them here.',
      'Import file',
      () => { relEl('ds-tab-datasets')?.click(); relEl('ds-import-open')?.click(); },
    ));
    canvas.classList.add('is-empty');
    return;
  }
  canvas.classList.remove('is-empty');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('rel-edges');
  svg.setAttribute('aria-hidden', 'true');
  canvas.appendChild(svg);

  const { cols, unrelated } = relLayout();
  const lanes = cols.concat(unrelated.length ? [unrelated] : []);
  lanes.forEach((lane, li) => {
    const col = document.createElement('div');
    col.className = 'rel-lane' + (li === lanes.length - 1 && unrelated.length ? ' rel-lane--loose' : '');
    if (li === lanes.length - 1 && unrelated.length) {
      const cap = document.createElement('div');
      cap.className = 'rel-lane-cap';
      cap.textContent = relModel.length ? 'Not related yet' : 'Datasets';
      col.appendChild(cap);
    }
    lane.forEach((id) => col.appendChild(relMakeCard(id)));
    canvas.appendChild(col);
  });
  if (relModel.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'rel-canvas-hint';
    hint.textContent = 'No relationships yet. New relationship picks two datasets and suggests the column that joins them.';
    canvas.appendChild(hint);
  }
  requestAnimationFrame(() => relDrawEdges());
}

/** Curves from each many-side card to its lookup, labelled with kind and match rate. */
function relDrawEdges(): void {
  const canvas = relEl('rel-canvas');
  const svg = canvas && (canvas.querySelector('.rel-edges') as SVGSVGElement | null);
  if (!canvas || !svg) return;
  canvas.querySelectorAll('.rel-edge-label').forEach((n) => n.remove());
  svg.innerHTML = '';
  // Collapse first: an absolute SVG counts toward scrollHeight, so sizing it to
  // a measurement that includes itself would grow the canvas on every redraw.
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  const box = canvas.getBoundingClientRect();
  svg.setAttribute('width', String(canvas.scrollWidth));
  svg.setAttribute('height', String(canvas.scrollHeight));
  const nodeOf = (id: string): HTMLElement | null =>
    canvas.querySelector(`.rel-node[data-dataset-id="${id}"]`) as HTMLElement | null;
  const at = (node: HTMLElement, column: string, side: 'l' | 'r'): { x: number; y: number } => {
    const key = node.querySelector(`.rel-key[data-column="${CSS.escape(column)}"]`) as HTMLElement | null;
    const r = node.getBoundingClientRect();
    const k = (key || node).getBoundingClientRect();
    return {
      x: (side === 'r' ? r.right : r.left) - box.left + canvas.scrollLeft,
      y: k.top + k.height / 2 - box.top + canvas.scrollTop,
    };
  };
  for (const r of relModel) {
    const a = nodeOf(r.from.datasetId);
    const b = nodeOf(r.to.datasetId);
    if (!a || !b) continue;
    const backwards = b.getBoundingClientRect().left < a.getBoundingClientRect().left;
    const p = at(a, r.from.column, backwards ? 'l' : 'r');
    const q = at(b, r.to.column, backwards ? 'r' : 'l');
    const dx = Math.max(40, Math.abs(q.x - p.x) / 2) * (backwards ? -1 : 1);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${p.x},${p.y} C${p.x + dx},${p.y} ${q.x - dx},${q.y} ${q.x},${q.y}`);
    path.classList.add('rel-edge');
    if (r.id === relSelectedId) path.classList.add('is-selected');
    svg.appendChild(path);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(q.x));
    dot.setAttribute('cy', String(q.y));
    dot.setAttribute('r', '4');
    dot.classList.add('rel-edge-end');
    svg.appendChild(dot);

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'rel-edge-label' + (r.id === relSelectedId ? ' is-selected' : '');
    label.textContent = `${relCardLabel(r.cardinality)} · ${relPct(relRate(r))}`;
    label.setAttribute('aria-label',
      `${relName(r.from.datasetId)}.${r.from.column} to ${relName(r.to.datasetId)}.${r.to.column}, ` +
      `${r.cardinality === 'one_to_one' ? 'one to one' : 'many to one'}, ${relPct(relRate(r))} matched`);
    label.style.left = (p.x + q.x) / 2 + 'px';
    label.style.top = (p.y + q.y) / 2 + 'px';
    label.addEventListener('click', () => relSelect(r.id));
    canvas.appendChild(label);
  }
}

function relSelect(id: string): void {
  relSelectedId = relSelectedId === id ? '' : id;
  relDrawEdges();
  document.querySelectorAll('#rel-list .rel-row').forEach((row) => {
    row.classList.toggle('is-selected', (row as HTMLElement).dataset.relId === relSelectedId);
  });
}

// ── List ─────────────────────────────────────────────────────────────────────

function relEnd(dsId: string, column: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'rel-end';
  const ds = document.createElement('span');
  ds.className = 'rel-end-ds';
  ds.textContent = relName(dsId);
  const col = document.createElement('span');
  col.className = 'rel-end-col';
  col.textContent = column;
  s.append(ds, col);
  return s;
}

function relRenderList(): void {
  const list = relEl('rel-list');
  if (!list) return;
  list.innerHTML = '';
  if (relModel.length === 0) {
    const none = document.createElement('div');
    none.className = 'rel-none';
    none.textContent = 'Relationships you add appear here, with how many rows found their match.';
    list.appendChild(none);
    return;
  }
  for (const r of relModel) {
    const row = document.createElement('div');
    row.className = 'ws-row rel-row' + (r.id === relSelectedId ? ' is-selected' : '');
    row.dataset.relId = r.id;
    row.setAttribute('role', 'listitem');
    const kind = document.createElement('span');
    kind.className = 'rel-kind';
    kind.textContent = r.cardinality === 'one_to_one' ? 'One to one' : 'Many to one';
    const matched = document.createElement('span');
    matched.className = 'rel-num';
    matched.textContent = `${r.verified.matched.toLocaleString()} (${relPct(relRate(r))})`;
    const unmatched = document.createElement('span');
    unmatched.className = 'rel-num' + (r.verified.unmatchedFrom ? ' is-warn' : '');
    unmatched.textContent = r.verified.unmatchedFrom.toLocaleString();
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn btn-sm mp-more';
    iconOnly(more, 'more-horizontal', `Actions for ${relName(r.from.datasetId)} to ${relName(r.to.datasetId)}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openRowMenu(more, [
        { label: 'Show on diagram', onClick: () => relSelect(r.id) },
        { label: 'Delete', danger: true, onClick: () => void relDelete(r) },
      ]);
    });
    const action = document.createElement('span');
    action.className = 'ws-col-action';
    action.appendChild(more);
    row.append(relEnd(r.from.datasetId, r.from.column), relEnd(r.to.datasetId, r.to.column), kind, matched, unmatched, action);
    row.addEventListener('click', () => relSelect(r.id));
    list.appendChild(row);
  }
}

async function relDelete(r: any): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm(`Delete the relationship ${relName(r.from.datasetId)} → ${relName(r.to.datasetId)}? Visuals using its columns will say so instead of drawing.`)) return;
  const res = await window.hubAuthoring.deleteRelationship(currentProjectId, r.id);
  encRelatedInvalidate();
  if (res && res.ok) showToast('Relationship deleted', { kind: 'success' });
  await refreshRelationships();
}

document.addEventListener('DOMContentLoaded', () => initRelationshipsPage());

function relEmpty(title: string, text: string, action: string, run: () => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ws-empty rel-empty';
  const ic = document.createElement('span');
  ic.className = 'ws-empty-icon';
  ic.setAttribute('aria-hidden', 'true');
  ic.appendChild(icon('link', 20));
  const h = document.createElement('h3');
  h.className = 'ws-empty-h';
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'ws-empty-p';
  p.textContent = text;
  const actions = document.createElement('div');
  actions.className = 'ws-empty-actions';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-primary';
  b.textContent = action;
  b.addEventListener('click', run);
  actions.appendChild(b);
  box.append(ic, h, p, actions);
  return box;
}
