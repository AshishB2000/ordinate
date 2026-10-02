'use strict';

// An open NOTEBOOK — the page: its header, the cell column, the add-cell bars
// between cells, saving, and moving between cells from the keyboard. Classic
// global-scope renderer <script>: no import/export. textContent only.
//
// Adding, moving and deleting cells is nbColumn.ts; what each kind of cell
// EDITS is nbCells.ts (the SQL editor is nbEditor.ts);
// running and the result area are nbRun.ts; Save as dataset, Pin and Export are
// nbActions.ts. This file owns the document and the frame around them.
//
// THE DOCUMENT is `nbDoc` — the page's copy of the cells, edited in place and
// saved (debounced) as a whole: main re-sanitises it and answers with the
// GRAPH (view names, dependencies, each cell's sig). A cell is STALE when its
// last result was computed under another sig (src/analysis/notebook/graph.ts),
// so painting staleness is a comparison, never a walk.
//
// Keys, as in the Query tab: ⌘↩ runs, Tab indents in SQL, Escape then Tab
// leaves. Plus the notebook's own: ⇧↩ runs and moves to the next cell, and
// Escape puts focus on the CELL, where ↑ / ↓ move between cells and ↩ edits.

let nbDoc: { id: string; name: string; cells: NbCellDoc[] } | null = null;
let nbDocProject = '';
let nbGraph: { cells: NbCellInfo[] } | null = null;
const nbResults = new Map<string, NbResult>();
let nbDirty = false;
let nbSaving: Promise<void> | null = null;
let nbSaveTimer = 0;

function nbUuid(): string {
  return window.crypto.randomUUID();
}

function nbInfo(id: string): NbCellInfo | null {
  return (nbGraph && nbGraph.cells.find((c) => c.id === id)) || null;
}

function nbCell(id: string): NbCellDoc | null {
  return (nbDoc && nbDoc.cells.find((c) => c.id === id)) || null;
}

function nbCellEl(id: string): HTMLElement | null {
  return document.querySelector(`#nb-cells .nb-cell[data-cell-id="${CSS.escape(id)}"]`);
}

/** The name a cell goes by in messages: its view, its title, or its position. */
function nbCellName(id: string): string {
  const info = nbInfo(id);
  const c = nbCell(id);
  return (info && info.view) || (c && c.title) || (info ? `Cell ${info.position}` : 'This cell');
}

// ── Open / close ─────────────────────────────────────────────────────────────

function nbShowNotebook(doc: any, graph: any): void {
  nbDiscard();
  nbDoc = { id: String(doc.id), name: String(doc.name || 'Untitled notebook'), cells: Array.isArray(doc.cells) ? doc.cells : [] };
  nbDocProject = currentProjectId || '';
  nbGraph = graph && Array.isArray(graph.cells) ? graph : { cells: [] };
  const list = nbEl('nb-list-view');
  const page = nbEl('nb-page');
  if (list) list.hidden = true;
  if (!page) return;
  page.hidden = false;
  page.textContent = '';
  page.append(nbHeader(), nbKeysLine());
  const cells = document.createElement('div');
  cells.id = 'nb-cells';
  cells.className = 'nb-cells';
  cells.setAttribute('role', 'list');
  cells.setAttribute('aria-label', 'Cells');
  page.appendChild(cells);
  nbRenderCells();
  // The datasets complete in the SQL editors and name the empty ones' placeholder.
  void nbLoadSchema().then(() => {
    document.querySelectorAll('#nb-cells .nb-cell').forEach((sec) => {
      const ta = sec.querySelector('.nb-sql-input') as HTMLTextAreaElement | null;
      if (ta) ta.placeholder = nbSqlPlaceholder(String((sec as HTMLElement).dataset.cellId));
    });
  });
}

/** Save what is pending and forget the open notebook (its results go with it). */
async function nbClose(): Promise<void> {
  if (nbDoc) await nbFlush();
  nbDiscard();
}

function nbDiscard(): void {
  window.clearTimeout(nbSaveTimer);
  nbDirty = false;
  nbDestroyCharts();
  nbDoc = null;
  nbGraph = null;
  nbResults.clear();
}

// ── Saving ───────────────────────────────────────────────────────────────────

function nbSetMeta(state: string): void {
  const el = nbEl('nb-meta');
  if (!el || !nbDoc) return;
  const n = nbDoc.cells.length;
  el.textContent = `${n} ${n === 1 ? 'cell' : 'cells'} · ${state}`;
}

/** The document changed. `structure`: cells were added, moved or removed — repaint the column. */
function nbTouch(structure = false): void {
  if (!nbDoc) return;
  nbDirty = true;
  nbSetMeta('Saving…');
  if (structure) nbRenderCells();
  window.clearTimeout(nbSaveTimer);
  nbSaveTimer = window.setTimeout(() => { void nbFlush(); }, 400);
}

/** Save now (a run reads the notebook AS SAVED). Resolves once main has it and the graph is back. */
async function nbFlush(): Promise<void> {
  window.clearTimeout(nbSaveTimer);
  while (nbSaving) await nbSaving;
  if (!nbDoc || !nbDirty) return;
  nbDirty = false;
  const doc = nbDoc;
  const pid = nbDocProject;
  nbSaving = (async (): Promise<void> => {
    let res: any = null;
    try {
      res = await window.hubNotebooks.save(pid, doc.id, doc.name, doc.cells);
    } catch (_) {
      res = null;
    }
    if (nbDoc !== doc) return;
    if (res && res.ok) {
      nbGraph = res.graph;
      nbSetMeta('Saved');
      nbPaintStates();
    } else {
      nbDirty = true;
      nbSetMeta('Not saved');
      showToast((res && res.error) || 'The notebook could not be saved.', { kind: 'error' });
    }
  })();
  try {
    await nbSaving;
  } finally {
    nbSaving = null;
  }
}

// ── The header ───────────────────────────────────────────────────────────────

function nbHeader(): HTMLElement {
  const head = document.createElement('div');
  head.className = 'nb-head';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-ghost btn-sm nb-back';
  iconLabel(back, 'chevron-left', 'Notebooks');
  back.addEventListener('click', () => { void nbShowList(); });

  const titleBox = document.createElement('div');
  titleBox.className = 'nb-head-title';
  const name = document.createElement('input');
  name.className = 'nb-name';
  name.id = 'nb-name';
  name.value = nbDoc ? nbDoc.name : '';
  name.setAttribute('aria-label', 'Notebook name');
  name.spellcheck = false;
  name.addEventListener('input', () => {
    if (!nbDoc) return;
    nbDoc.name = name.value.trim() || 'Untitled notebook';
    nbTouch();
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
  const meta = document.createElement('span');
  meta.className = 'nb-meta';
  meta.id = 'nb-meta';
  titleBox.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'nb-head-actions';
  const runAll = document.createElement('button');
  runAll.type = 'button';
  runAll.className = 'btn btn-primary';
  runAll.id = 'nb-run-all';
  iconLabel(runAll, 'play', 'Run all');
  runAll.addEventListener('click', () => { void nbRunAll(); });
  const exp = document.createElement('button');
  exp.type = 'button';
  exp.className = 'btn btn-ghost';
  exp.id = 'nb-export';
  iconLabel(exp, 'download', 'Export Markdown');
  exp.addEventListener('click', () => { void nbExportMarkdown(); });
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'icon-btn nb-head-more';
  iconOnly(more, 'more-horizontal', 'Notebook actions');
  more.addEventListener('click', () => {
    openMiniMenu(more, (menu: HTMLElement, close: () => void) => {
      nbMenuItem(menu, close, 'Add a cell at the end', () => nbAddCell('sql', nbDoc ? nbDoc.cells.length : 0));
      nbMenuItem(menu, close, 'Delete notebook', () => { if (nbDoc) void nbDeleteNotebook(nbDoc.id, nbDoc.name); });
    });
  });
  actions.append(runAll, exp, more);

  head.append(back, titleBox, actions);
  window.setTimeout(() => nbSetMeta('Saved'), 0);
  return head;
}

function nbKeysLine(): HTMLElement {
  const p = document.createElement('p');
  p.className = 'nb-keys';
  const bits: Array<[string, string]> = [['⇧↩', 'run and move on'], ['⌘↩', 'run'], ['Esc', 'then ↑ ↓ to move between cells']];
  bits.forEach(([k, t], i) => {
    if (i) p.appendChild(document.createTextNode(' · '));
    const kbd = document.createElement('kbd');
    kbd.textContent = k;
    p.append(kbd, document.createTextNode(' ' + t));
  });
  return p;
}

function nbMenuItem(menu: HTMLElement, close: () => void, label: string, run: () => void, disabled = false): void {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chart-menu-item';
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', () => { close(); run(); });
  menu.appendChild(b);
}

// ── The cell column ──────────────────────────────────────────────────────────

function nbRenderCells(): void {
  const host = nbEl('nb-cells');
  if (!host || !nbDoc) return;
  nbDestroyCharts();
  host.textContent = '';
  if (!nbDoc.cells.length) {
    const empty = makeEmptyState({
      variant: 'notebooks',
      iconName: 'file-text',
      title: 'An empty notebook',
      line: 'Start with a query over this project’s datasets, a parameter for the cells below to read, or a note saying what this notebook answers.',
    });
    empty.classList.add('nb-page-empty');
    host.append(empty, nbAddBar(0, true));
    return;
  }
  host.appendChild(nbAddBar(0, false));
  nbDoc.cells.forEach((c, i) => {
    host.appendChild(nbBuildCell(c));
    host.appendChild(nbAddBar(i + 1, i === nbDoc!.cells.length - 1));
  });
  for (const c of nbDoc.cells) nbRenderResult(c.id);
  nbPaintStates();
}

function nbBuildCell(c: NbCellDoc): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'nb-cell nb-cell--' + c.kind;
  sec.dataset.cellId = c.id;
  sec.tabIndex = -1;
  sec.setAttribute('role', 'listitem');

  const gutter = document.createElement('div');
  gutter.className = 'nb-gutter';
  const kind = document.createElement('span');
  kind.className = 'nb-gutter-kind';
  kind.title = nbKindLabel(c.kind);
  kind.appendChild(icon(nbKindIcon(c.kind), 16));
  const exec = document.createElement('span');
  exec.className = 'nb-gutter-exec';
  const state = document.createElement('span');
  state.className = 'nb-gutter-state';
  state.setAttribute('role', 'img');
  gutter.append(kind, exec, state);

  const main = document.createElement('div');
  main.className = 'nb-cell-main';
  const head = document.createElement('div');
  head.className = 'nb-cell-head';
  const label = document.createElement('span');
  label.className = 'nb-cell-kind';
  label.textContent = nbKindLabel(c.kind);
  head.appendChild(label);
  if (c.kind !== 'markdown' && c.kind !== 'param') {
    const title = document.createElement('input');
    title.className = 'nb-cell-title';
    title.value = c.title || '';
    title.placeholder = 'Add a title';
    title.setAttribute('aria-label', 'Cell title');
    title.spellcheck = false;
    title.addEventListener('input', () => {
      c.title = title.value;
      nbTouch();
    });
    title.addEventListener('keydown', (e) => nbEditorKey(e, c.id));
    head.appendChild(title);
  }
  if (c.kind === 'sql') {
    const chip = document.createElement('span');
    chip.className = 'nb-view-chip';
    chip.title = 'The cells below query this result by this name';
    chip.append(icon('table', 14), Object.assign(document.createElement('code'), { className: 'nb-view-name' }));
    head.appendChild(chip);
  }
  const stale = document.createElement('span');
  stale.className = 'nb-stale-badge';
  stale.textContent = 'Stale';
  stale.title = 'Something this cell reads has changed since it last ran';
  stale.hidden = true;
  const gap = document.createElement('span');
  gap.className = 'nb-cell-gap';
  head.append(stale, gap);
  if (c.kind === 'sql' || c.kind === 'formula' || c.kind === 'chart') {
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'btn btn-sm nb-run';
    iconLabel(run, 'play', 'Run');
    run.title = 'Run this cell (⇧↩)';
    run.addEventListener('click', () => { void nbRunCell(c.id); });
    head.appendChild(run);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'icon-btn nb-cell-more';
  iconOnly(more, 'more-horizontal', 'Cell actions');
  more.addEventListener('click', () => nbCellMenu(more, c.id));
  head.appendChild(more);

  const problem = document.createElement('p');
  problem.className = 'nb-cell-problem';
  problem.hidden = true;
  const body = document.createElement('div');
  body.className = 'nb-cell-body';
  body.appendChild(nbBuildEditor(c));
  const out = document.createElement('div');
  out.className = 'nb-out';
  out.setAttribute('aria-live', 'polite');
  main.append(head, problem, body, out);
  sec.append(gutter, main);

  sec.addEventListener('keydown', (e) => nbCommandKey(e, sec, c.id));
  sec.addEventListener('focusin', () => {
    document.querySelectorAll('#nb-cells .nb-cell.is-active').forEach((x) => { if (x !== sec) x.classList.remove('is-active'); });
    sec.classList.add('is-active');
  });
  return sec;
}

function nbCellMenu(anchor: HTMLElement, id: string): void {
  if (!nbDoc) return;
  const i = nbDoc.cells.findIndex((c) => c.id === id);
  const c = nbDoc.cells[i];
  openMiniMenu(anchor, (menu: HTMLElement, close: () => void) => {
    if (c.kind === 'sql' || c.kind === 'formula' || c.kind === 'chart') {
      nbMenuItem(menu, close, 'Run from here down', () => { void nbRunFrom(id); });
    }
    if (c.kind === 'sql' || c.kind === 'formula') nbMenuItem(menu, close, 'Save as dataset…', () => { void nbSaveAsDataset(id); });
    if (c.kind === 'chart') nbMenuItem(menu, close, 'Pin to dashboard…', () => { void nbPinChart(id); });
    nbMenuItem(menu, close, 'Move up', () => nbMoveCell(id, -1), i === 0);
    nbMenuItem(menu, close, 'Move down', () => nbMoveCell(id, 1), i === nbDoc!.cells.length - 1);
    nbMenuItem(menu, close, 'Duplicate', () => nbDuplicateCell(id));
    nbMenuItem(menu, close, 'Delete cell', () => nbDeleteCell(id));
  });
}

// ── States: gutter, stale badge, view name, problems ─────────────────────────

function nbCellState(id: string): 'idle' | 'running' | 'ok' | 'error' | 'stale' {
  if (nbRunning.has(id)) return 'running';
  const r = nbResults.get(id);
  if (!r || r.cancelled) return 'idle';
  if (!r.ok) return 'error';
  const info = nbInfo(id);
  return info && r.sig && r.sig !== info.sig ? 'stale' : 'ok';
}

const NB_STATE_WORDS: Record<string, string> = {
  idle: 'Not run yet', running: 'Running', ok: 'Up to date', error: 'Failed', stale: 'Stale — something it reads changed',
};

/** Repaint every cell's gutter, stale badge, view chip and problem line from the graph and results. */
function nbPaintStates(): void {
  if (!nbDoc) return;
  nbDoc.cells.forEach((c, i) => {
    const sec = nbCellEl(c.id);
    if (!sec) return;
    const info = nbInfo(c.id);
    const st = nbCellState(c.id);
    sec.dataset.state = st;
    sec.classList.toggle('is-stale', st === 'stale');
    sec.setAttribute('aria-label', `Cell ${i + 1}, ${nbKindLabel(c.kind)}${st === 'stale' ? ', stale' : ''}`);
    const dot = sec.querySelector('.nb-gutter-state') as HTMLElement | null;
    if (dot) {
      dot.dataset.state = st;
      dot.setAttribute('aria-label', NB_STATE_WORDS[st]);
      dot.title = NB_STATE_WORDS[st];
      dot.textContent = '';
      if (st === 'running') dot.appendChild(icon('loader', 14));
    }
    const exec = sec.querySelector('.nb-gutter-exec') as HTMLElement | null;
    const r = nbResults.get(c.id);
    if (exec) exec.textContent = r && r.exec ? `[${r.exec}]` : c.kind === 'sql' || c.kind === 'formula' || c.kind === 'chart' ? '[ ]' : '';
    const badge = sec.querySelector('.nb-stale-badge') as HTMLElement | null;
    if (badge) badge.hidden = st !== 'stale';
    const view = sec.querySelector('.nb-view-name');
    if (view) view.textContent = (info && info.view) || '';
    const problem = sec.querySelector('.nb-cell-problem') as HTMLElement | null;
    if (problem) {
      const msg = info && info.error && !/ first\.$/.test(info.error) ? info.error : '';
      problem.textContent = '';
      if (msg) problem.append(icon('alert', 14), Object.assign(document.createElement('span'), { textContent: msg }));
      problem.hidden = !msg;
    }
  });
  nbSyncEditors();
}

// ── Focus and keys ───────────────────────────────────────────────────────────

/** Focus a cell's editor (or, with `cellOnly`, the cell itself), scrolled into view. */
function nbFocusCell(id: string, scroll = false, cellOnly = false): void {
  const sec = nbCellEl(id);
  if (!sec) return;
  if (scroll) sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const target = cellOnly ? null : (sec.querySelector('.nb-cell-body textarea, .nb-cell-body input, .nb-cell-body select, .nb-md-view') as HTMLElement | null);
  (target || sec).focus({ preventScroll: true });
}

function nbNeighbour(id: string, delta: number): string | null {
  if (!nbDoc) return null;
  const i = nbDoc.cells.findIndex((c) => c.id === id);
  const n = nbDoc.cells[i + delta];
  return n ? n.id : null;
}

/** Keys inside a cell's editor. True when the key was the notebook's. */
function nbEditorKey(e: KeyboardEvent, id: string): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Enter' && (e.shiftKey || mod)) {
    e.preventDefault();
    if (e.shiftKey && !mod) {
      void nbRunCell(id);
      const next = nbNeighbour(id, 1);
      if (next) nbFocusCell(next, true);
      else nbAddCell('sql', nbDoc ? nbDoc.cells.length : 0);
    } else void nbRunCell(id);
    return true;
  }
  if (e.key === 'Escape' && !e.defaultPrevented) {
    const sec = nbCellEl(id);
    if (sec) { e.preventDefault(); sec.focus(); }
    return true;
  }
  return false;
}

/** Keys on a focused CELL (not inside its editor). */
function nbCommandKey(e: KeyboardEvent, sec: HTMLElement, id: string): void {
  if (e.target !== sec) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') {
    const next = nbNeighbour(id, e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1);
    if (next) { e.preventDefault(); nbFocusCell(next, true, true); }
  } else if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    void nbRunCell(id);
    const next = nbNeighbour(id, 1);
    if (next) nbFocusCell(next, true, true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (nbCell(id)?.kind === 'markdown') nbMdEdit(id);
    else nbFocusCell(id);
  }
}
