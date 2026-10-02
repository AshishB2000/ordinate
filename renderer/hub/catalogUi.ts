'use strict';

// The catalog's SHARED renderer pieces: tag chips, the tag-filter bar every
// list mounts, the per-dataset column-docs cache the pickers and the grid
// read, and the one table of record kinds (label, icon, opener).
// Classic global-scope renderer <script>: no import/export.
//
// Everything here is user text — descriptions, tags, owners — so it is set
// with textContent, never innerHTML.
//
// ONE filter state for the project (`ctActiveTag`), not one per list: picking
// #sales on Datasets and then opening Visuals shows the sales visuals, which
// is what a tag is for. The bar says so, with a clear button, wherever it is.

interface CtTag { name: string; color: number; count?: number }
interface CtColDoc {
  description?: string;
  displayName?: string;
  example?: string;
  sensitivity?: string;
  updatedBy?: string;
  updatedAt?: string;
}

// ── Record kinds ─────────────────────────────────────────────────────────────
//
// The renderer's half of catalogIndex.SOURCES: what a kind is called, its
// icon, and how to open one. Adding a kind is one entry here and one there.

async function ctEnterProject(projectId: string): Promise<void> {
  if (projectId && projectId !== currentProjectId) await openWorkspace(projectId);
}

const CT_KINDS: Array<{ kind: string; label: string; icon: string; open: (id: string, projectId: string, name: string) => Promise<void> }> = [
  { kind: 'dataset', label: t('common.dataset'), icon: 'database', open: (id, projectId, name) => openRecentItem({ type: 'dataset', id, projectId, name }) },
  {
    kind: 'visual', label: 'Visual', icon: 'columns',
    open: async (id, projectId) => { await ctEnterProject(projectId); selectSection('visuals'); await openSavedVisual(id); },
  },
  { kind: 'analysis', label: t('common.dashboard'), icon: 'grid', open: (id, projectId, name) => openRecentItem({ type: 'analysis', id, projectId, name }) },
  {
    kind: 'metric', label: t('common.metric'), icon: 'chart-line',
    open: async (id, projectId) => {
      await ctEnterProject(projectId);
      selectSection('datasets');
      clSelectTab('metrics');
      await mpOpenEditor({ id });
    },
  },
  { kind: 'report', label: t('common.report'), icon: 'file-text', open: (id, projectId, name) => openRecentItem({ type: 'report', id, projectId, name }) },
  {
    kind: 'story', label: t('common.story'), icon: 'file-text',
    open: async (id, projectId) => {
      await ctEnterProject(projectId);
      await stOpen(id);
    },
  },
];

function ctKind(kind: string): { kind: string; label: string; icon: string; open: (id: string, projectId: string, name: string) => Promise<void> } | undefined {
  return CT_KINDS.find((k) => k.kind === kind);
}

async function ctOpenRecord(kind: string, id: string, projectId?: string, name?: string): Promise<void> {
  const k = ctKind(kind);
  if (k) await k.open(id, projectId || currentProjectId || '', name || '');
}

// ── The project's tags ───────────────────────────────────────────────────────

let ctTagsCache: { projectId: string; tags: CtTag[]; refs: Record<string, string[]> } | null = null;
let ctActiveTag = '';

async function ctLoadTags(force = false): Promise<{ projectId: string; tags: CtTag[]; refs: Record<string, string[]> }> {
  const projectId = currentProjectId || '';
  if (!force && ctTagsCache && ctTagsCache.projectId === projectId) return ctTagsCache;
  let res: any = null;
  if (projectId) {
    try { res = await window.hub.catalogTags(projectId); } catch (_) { res = null; }
  }
  // A different project's filter is not a claim about this one.
  if (!ctTagsCache || ctTagsCache.projectId !== projectId) ctActiveTag = '';
  ctTagsCache = {
    projectId,
    tags: res && Array.isArray(res.tags) ? res.tags : [],
    refs: res && res.refs && typeof res.refs === 'object' ? res.refs : {},
  };
  return ctTagsCache;
}

function ctColorOf(name: string): number {
  const t = ctTagsCache ? ctTagsCache.tags.find((x) => x.name === name) : undefined;
  return t ? t.color : 0;
}

function ctTagsOf(ref: string): string[] {
  return (ctTagsCache && ctTagsCache.refs[ref]) || [];
}

/** Coloured tag pills. Accepts names (coloured from the cache) or {name,color}. */
function ctTagChips(tags: Array<string | CtTag>, max = 3): HTMLElement {
  const box = document.createElement('span');
  box.className = 'ct-chips';
  const list = (tags || []).map((t) => (typeof t === 'string' ? { name: t, color: ctColorOf(t) } : t));
  list.slice(0, max).forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'ct-chip tag-c' + (Number(t.color) || 0);
    chip.textContent = t.name;
    chip.title = '#' + t.name;
    box.appendChild(chip);
  });
  if (list.length > max) {
    const more = document.createElement('span');
    more.className = 'ct-chip ct-chip--more';
    more.textContent = '+' + (list.length - max);
    more.title = list.slice(max).map((t) => '#' + t.name).join(' ');
    box.appendChild(more);
  }
  return box;
}

// ── Lists: chips on every row, and one filter bar per list ───────────────────
//
// A list calls ctDecorate() while building a row and ctAfterPaint() once the
// rows are in — two lines per list file. The row carries `data-ct-ref`, which
// is all the filter needs; nothing here knows what a dataset row looks like.

const ctLists = new Map<HTMLElement, HTMLElement>(); // list → its filter bar

function ctDecorate(row: HTMLElement, kind: string, id: string, chipHost: HTMLElement | null): void {
  const ref = kind + ':' + id;
  row.dataset.ctRef = ref;
  if (!chipHost) return;
  const slot = document.createElement('span');
  slot.className = 'ct-slot';
  slot.dataset.ctSlot = ref;
  if (ctTagsCache && ctTagsCache.projectId === currentProjectId && ctTagsOf(ref).length) slot.appendChild(ctTagChips(ctTagsOf(ref)));
  chipHost.appendChild(slot);
}

async function ctAfterPaint(list: HTMLElement | null, barBefore?: HTMLElement | null): Promise<void> {
  if (!list) return;
  await ctLoadTags();
  if (!list.isConnected) return;
  let bar = ctLists.get(list);
  const anchor = barBefore || list;
  if ((!bar || !bar.isConnected) && anchor.parentElement) {
    bar = document.createElement('div');
    bar.className = 'ct-filter';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', t('catalogUi.filter_by_tag'));
    anchor.parentElement.insertBefore(bar, anchor);
    ctLists.set(list, bar);
  }
  ctPaintList(list);
}

/** Refill the chips, repaint the bar and re-apply the filter for one list. */
function ctPaintList(list: HTMLElement): void {
  list.querySelectorAll<HTMLElement>('[data-ct-slot]').forEach((slot) => {
    const tags = ctTagsOf(slot.dataset.ctSlot || '');
    slot.textContent = '';
    if (tags.length) slot.appendChild(ctTagChips(tags));
  });
  const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-ct-ref]'));
  const present = new Map<string, number>();
  rows.forEach((r) => ctTagsOf(r.dataset.ctRef || '').forEach((t) => present.set(t, (present.get(t) || 0) + 1)));
  let shown = 0;
  rows.forEach((r) => {
    const on = !ctActiveTag || ctTagsOf(r.dataset.ctRef || '').indexOf(ctActiveTag) >= 0;
    r.hidden = !on;
    if (on) shown += 1;
  });
  const bar = ctLists.get(list);
  if (bar) ctPaintBar(bar, present, rows.length, shown);
}

function ctPaintBar(bar: HTMLElement, present: Map<string, number>, total: number, shown: number): void {
  bar.textContent = '';
  bar.hidden = total === 0 || (present.size === 0 && !ctActiveTag);
  if (bar.hidden) return;
  const label = document.createElement('span');
  label.className = 'ct-filter-label';
  label.textContent = t('common.tags');
  bar.appendChild(label);
  const names = Array.from(present.keys()).sort((a, b) => (present.get(b) || 0) - (present.get(a) || 0) || a.localeCompare(b));
  if (ctActiveTag && names.indexOf(ctActiveTag) < 0) names.unshift(ctActiveTag);
  names.forEach((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    const on = name === ctActiveTag;
    b.className = 'ct-chip ct-chip--btn tag-c' + ctColorOf(name) + (on ? ' is-on' : '');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = name;
    const n = present.get(name) || 0;
    b.title = on ? t('catalogUi.show_everything') : t('catalogUi.show_only', { name, n });
    b.addEventListener('click', () => ctSetActiveTag(on ? '' : name));
    bar.appendChild(b);
  });
  if (ctActiveTag) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ct-filter-clear';
    clear.textContent = t('common.clear');
    clear.addEventListener('click', () => ctSetActiveTag(''));
    bar.appendChild(clear);
    const note = document.createElement('span');
    note.className = 'ct-filter-note';
    note.textContent = shown ? `${shown} of ${total}` : t('catalogUi.nothing_here_is_tagged', { ctActiveTag });
    bar.appendChild(note);
  }
}

function ctSetActiveTag(name: string): void {
  ctActiveTag = name;
  ctRepaintAll();
}

/** Every mounted list (and the Catalog page) — after a tag edit or a filter change. */
function ctRepaintAll(): void {
  ctLists.forEach((bar, list) => {
    if (!list.isConnected) { ctLists.delete(list); bar.remove(); return; }
    ctPaintList(list);
  });
  if (typeof ctCatalogRepaint === 'function') ctCatalogRepaint();
}

/** Tags changed on disk: refetch once, then repaint everything that shows them. */
async function ctTagsChanged(): Promise<void> {
  await ctLoadTags(true);
  ctRepaintAll();
}

// ── Column docs ──────────────────────────────────────────────────────────────

const ctColDocs = new Map<string, Record<string, CtColDoc>>(); // `${projectId}:${datasetId}` → docs
const ctColLoading = new Map<string, Promise<Record<string, CtColDoc>>>();

function ctColKey(datasetId: string): string {
  return (currentProjectId || '') + ':' + datasetId;
}

async function ctLoadColumnDocs(datasetId: string, force = false): Promise<Record<string, CtColDoc>> {
  const key = ctColKey(datasetId);
  if (!datasetId || !currentProjectId) return {};
  if (!force && ctColDocs.has(key)) return ctColDocs.get(key) as Record<string, CtColDoc>;
  if (!force && ctColLoading.has(key)) return ctColLoading.get(key) as Promise<Record<string, CtColDoc>>;
  const p = (async () => {
    let res: any = null;
    try { res = await window.hub.catalogColumns(currentProjectId as string, datasetId); } catch (_) { res = null; }
    const docs: Record<string, CtColDoc> = res && res.columns && typeof res.columns === 'object' ? res.columns : {};
    ctColDocs.set(key, docs);
    ctColLoading.delete(key);
    return docs;
  })();
  ctColLoading.set(key, p);
  return p;
}

/** Synchronous read of the cache; null when not loaded or not documented. */
function ctColumnDoc(datasetId: string, name: string): CtColDoc | null {
  const docs = ctColDocs.get(ctColKey(datasetId));
  return docs && Object.prototype.hasOwnProperty.call(docs, name) ? docs[name] : null;
}

/**
 * A column header's tooltip: its description, then the hint the control
 * already had. Not cached yet → the hint alone, and `repaint` runs once the
 * docs arrive so the next paint carries them.
 */
function ctColumnTitle(datasetId: string, name: string, hint: string, repaint?: () => void): string {
  if (!ctColDocs.has(ctColKey(datasetId))) {
    void ctLoadColumnDocs(datasetId).then((docs) => { if (repaint && Object.keys(docs).length) repaint(); });
    return hint;
  }
  const doc = ctColumnDoc(datasetId, name);
  const head = doc && doc.displayName ? doc.displayName + ' — ' : '';
  return doc && doc.description ? head + doc.description + '\n' + hint : hint;
}

/**
 * Columns for a picker, with the catalog's words on them: `label` is the
 * display name when there is one, `title` the description. The VALUE stays the
 * real column name everywhere — this only changes what a person reads.
 */
async function ctDocColumns<T extends { name: string }>(datasetId: string, cols: T[]): Promise<Array<T & { label?: string; title?: string }>> {
  const docs = await ctLoadColumnDocs(datasetId);
  return cols.map((c) => {
    const d = Object.prototype.hasOwnProperty.call(docs, c.name) ? docs[c.name] : null;
    if (!d || (!d.description && !d.displayName)) return c;
    const title = [d.displayName ? `${d.displayName} (${c.name})` : c.name, d.description || ''].filter(Boolean).join(' — ');
    return { ...c, label: d.displayName || c.name, title };
  });
}

/** Header chips for an open record (dataset page, builders). */
async function ctPaintHeaderChips(host: HTMLElement | null, ref: string): Promise<void> {
  if (!host) return;
  await ctLoadTags();
  host.textContent = '';
  const tags = ctTagsOf(ref);
  if (tags.length) host.appendChild(ctTagChips(tags, 4));
  host.hidden = !tags.length;
}
