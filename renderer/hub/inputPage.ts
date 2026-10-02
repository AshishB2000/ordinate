'use strict';

// INPUT TABLES on the dataset page — the state, the toolbar and status line,
// saving, checking and undo. Classic global-scope renderer <script>: no
// import/export. The grid itself is inputGrid.ts, the keyboard, the cell editor
// and the clipboard are inputKeys.ts, and the define-columns dialog (with the
// toolbar's Edit columns and History) is inputColumns.ts.
//
// An input table opens on the Data tab like any dataset; for one, that tab is
// this editable grid instead of the read-only one (Prepare still shows the
// pipeline's output beside its steps). Everything the grid does is a BATCH from
// the shared edit model (OrdInputEdits = src/data/inputTable/edits.js):
//
//   · applied locally at once, and pushed on the undo stack — one user action,
//     one undo step. ⌘Z / ⇧⌘Z are the app's own `dash.undo` / `dash.redo`
//     commands, which dispatch here while an input table is showing
//     (commandDefs.ts) — one keybinding, like the story page's.
//   · queued, and SAVED ON BLUR: when focus leaves the table (and on window
//     blur, leaving the page, closing the tab), in one `input:save` call. Main
//     replays the batches over the stored table, validates, writes the Parquet
//     once and records one version per batch.
//   · CHECKED by main after every batch (`input:validate`, debounced): type,
//     required, lookup and the dataset's quality rules — the renderer never
//     decides what is valid. Flagged cells get a red corner and the reason.

interface ItEdit { r: number; c: number; mode: 'replace' | 'keep' }

interface ItState {
  pid: string;
  id: string;
  name: string;
  columns: any[];
  rows: ItCell[][];
  cap: number;
  steps: number;
  lookupNames: Record<string, string>;
  rules: any[];
  hist: ItHistory;
  pending: ItBatch[];
  saving: boolean;
  error: string;
  /** "r:c" → the findings on that cell. */
  issues: Map<string, any[]>;
  notes: string[];
  failCells: number;
  warnCells: number;
  /** r0/c0 is the anchor, r1/c1 the active cell — a range is the rectangle between. */
  sel: ItRange;
  edit: ItEdit | null;
  vseq: number;
}

let itS: ItState | null = null;
let itValidateTimer = 0;
let itFlushTimer = 0;
/** Saves run one at a time; a flush while one is in flight queues behind it. */
let itSaveChain: Promise<void> = Promise.resolve();
/** Bumped per open, so a slow load for a dataset left behind is dropped. */
let itOpenSeq = 0;
const IT_VALIDATE_MS = 150;

function itEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function itMk<T extends HTMLElement = HTMLElement>(tag: string, cls?: string, text?: string): T {
  const e = document.createElement(tag) as T;
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function itRowsWord(n: number): string {
  return n.toLocaleString('en-US') + (n === 1 ? ' row' : ' rows');
}

// ── Mount: the grid lives in the Data tab's panel, shown only for an input table ─

(function itMount(): void {
  const panel = document.getElementById('ds-tabp-data');
  if (!panel || document.getElementById('it-host')) return;
  const host = itMk('section', 'it-host');
  host.id = 'it-host';
  host.setAttribute('aria-label', 'Input table editor');

  const bar = itMk('div', 'it-bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Table actions');
  const btn = (id: string, ic: string, label: string, cls = 'btn btn-sm'): HTMLButtonElement => {
    const b = itMk<HTMLButtonElement>('button', cls);
    b.type = 'button';
    b.id = id;
    iconLabel(b, ic, label);
    return b;
  };
  const iconBtn = (id: string, ic: string, label: string): HTMLButtonElement => {
    const b = itMk<HTMLButtonElement>('button', 'btn btn-sm btn-ghost it-icon-btn');
    b.type = 'button';
    b.id = id;
    iconOnly(b, ic, label);
    return b;
  };
  const addRow = btn('it-add-row', 'plus', 'Row');
  addRow.title = 'Add a row at the end';
  const delRows = btn('it-del-rows', 'trash', 'Delete rows', 'btn btn-sm btn-ghost');
  const undo = iconBtn('it-undo', 'undo', 'Undo');
  const redo = iconBtn('it-redo', 'redo', 'Redo');
  const editCols = btn('it-edit-cols', 'columns', 'Edit columns', 'btn btn-sm btn-ghost');
  const hist = btn('it-history', 'history', 'History', 'btn btn-sm btn-ghost');
  const sep = (): HTMLElement => { const s = itMk('span', 'it-sep'); s.setAttribute('aria-hidden', 'true'); return s; };
  const status = itMk('span', 'it-status');
  status.id = 'it-status';
  status.setAttribute('role', 'status');
  const attn = itMk<HTMLButtonElement>('button', 'it-attn');
  attn.type = 'button';
  attn.id = 'it-attn';
  attn.hidden = true;
  const count = itMk('span', 'it-count tnum');
  count.id = 'it-count';
  const state = itMk('div', 'it-state');
  state.append(status, attn);
  bar.append(addRow, delRows, sep(), undo, redo, sep(), editCols, hist, state);

  const notes = itMk('div', 'it-notes');
  notes.id = 'it-notes';
  notes.setAttribute('role', 'note');
  notes.hidden = true;

  const scroll = itMk('div', 'it-scroll');
  scroll.id = 'it-scroll';
  const table = itMk<HTMLTableElement>('table', 'it-table');
  table.id = 'it-grid';
  table.tabIndex = 0;
  table.setAttribute('role', 'grid');
  table.setAttribute('aria-multiselectable', 'true');
  const editor = itMk<HTMLInputElement>('input', 'it-editor');
  editor.id = 'it-editor';
  editor.type = 'text';
  editor.hidden = true;
  editor.spellcheck = false;
  editor.autocomplete = 'off';
  editor.maxLength = OrdInputEdits.MAX_CELL_TEXT;
  scroll.append(table, editor);

  const empty = itMk('div', 'it-empty');
  empty.id = 'it-empty';
  empty.hidden = true;
  const art = itMk('span', 'ws-empty-icon');
  art.setAttribute('aria-hidden', 'true');
  art.appendChild(icon('table', 20));
  empty.append(art, itMk('h4', 'it-empty-h', 'No rows yet'),
    itMk('p', 'it-empty-p', 'Type into the first row, or copy rows from Excel, Numbers or Google Sheets and press ⌘V here. Up to 10,000 rows.'));

  const keys = itMk('p', 'it-keys');
  const hint = (k: string, what: string): void => {
    const s = itMk('span', 'it-key');
    s.append(itMk('kbd', '', k), document.createTextNode(' ' + what));
    keys.appendChild(s);
  };
  hint('Enter', 'down');
  hint('Tab', 'right');
  hint('F2', 'edit in place');
  hint('⌘D', 'fill down');
  hint('⌘C ⌘V', 'copy and paste');
  hint('Delete', 'clear');
  hint('⌘Z', 'undo');

  const foot = itMk('div', 'it-foot');
  foot.append(keys, count);
  host.append(bar, notes, scroll, empty, foot);
  panel.appendChild(host);

  addRow.addEventListener('click', () => itAddRow());
  delRows.addEventListener('click', () => itDeleteRows());
  undo.addEventListener('click', () => itUndo());
  redo.addEventListener('click', () => itRedo());
  editCols.addEventListener('click', () => { void itEditColumns(); });
  hist.addEventListener('click', () => { void itOpenHistory(); });
  attn.addEventListener('click', () => itNextIssue());

  // SAVE ON BLUR: focus leaving the table (not moving inside it) queues a save.
  host.addEventListener('focusout', (e: FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && host.contains(to)) return;
    itScheduleFlush();
  });
  window.addEventListener('blur', () => itScheduleFlush());
  window.addEventListener('beforeunload', () => { void itFlush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void itFlush(); });

  // Leaving the page (Back, another section, a tab close) hides the explorer.
  const explorer = document.getElementById('ds-explorer');
  if (explorer) {
    new MutationObserver(() => {
      if (explorer.hidden) { itCancelEdit(); void itFlush(); }
    }).observe(explorer, { attributes: true, attributeFilter: ['hidden'] });
  }
  // Back on the Data tab after editing a rule on Quality: check again.
  new MutationObserver(() => { if (!panel.hidden && itS) itScheduleValidate(); })
    .observe(panel, { attributes: true, attributeFilter: ['hidden'] });

  itWireGrid(table, scroll);
  itWireKeys(table, editor);
})();

// ── Opening ──────────────────────────────────────────────────────────────────

/** Called by openSavedDataset (dsExplorer.ts) for EVERY dataset it opens. */
async function itOnOpen(ds: any): Promise<void> {
  const seq = ++itOpenSeq;
  itCancelEdit();
  await itFlush();
  if (seq !== itOpenSeq) return;
  const explorer = itEl('ds-explorer');
  const isInput = !!ds && ds.sourceKind === 'input';
  if (explorer) explorer.classList.toggle('is-input', isInput);
  itS = null;
  if (!isInput || !currentProjectId) return;
  let view: any = null;
  try { view = await window.hubInput.load(currentProjectId, String(ds.id)); } catch (_) { view = null; }
  if (seq !== itOpenSeq) return;
  if (!view || !view.ok) {
    if (explorer) explorer.classList.remove('is-input');
    showToast((view && view.error) || 'This input table could not be opened.', { kind: 'error' });
    return;
  }
  itS = {
    pid: currentProjectId, id: String(view.id), name: String(view.name || ''),
    columns: [], rows: [], cap: 10000, steps: 0, lookupNames: {}, rules: [],
    hist: OrdInputEdits.histNew(), pending: [], saving: false, error: '',
    issues: new Map(), notes: [], failCells: 0, warnCells: 0,
    sel: { r0: 0, c0: 0, r1: 0, c1: 0 }, edit: null, vseq: 0,
  };
  itAdopt(view, true);
  const grid = itEl('it-grid');
  if (grid) grid.setAttribute('aria-label', `${itS.name} — editable table`);
  itRender();
  itPaintBar();
}

/** Take main's copy of the table (after a load, a save or a column change). */
function itAdopt(view: any, rowsToo: boolean): void {
  if (!itS) return;
  itS.columns = Array.isArray(view.columns) ? view.columns : [];
  if (rowsToo) itS.rows = Array.isArray(view.rows) ? view.rows : [];
  itS.cap = Number(view.cap) || 10000;
  itS.steps = Number(view.steps) || 0;
  itS.lookupNames = view.lookupNames || {};
  itS.rules = Array.isArray(view.rules) ? view.rules : [];
  if (view.check) itTakeCheck(view.check);
}

function itTakeCheck(check: any): void {
  if (!itS) return;
  const map = new Map<string, any[]>();
  for (const i of Array.isArray(check.issues) ? check.issues : []) {
    const k = i.r + ':' + i.c;
    const list = map.get(k) || [];
    list.push(i);
    map.set(k, list);
  }
  itS.issues = map;
  itS.notes = Array.isArray(check.notes) ? check.notes : [];
  itS.failCells = Number(check.failCells) || 0;
  itS.warnCells = Number(check.warnCells) || 0;
}

/** True while an input table's grid is the thing on screen — what ⌘Z acts on. */
function itIsActive(): boolean {
  const host = itEl('it-host');
  return !!itS && !!host && host.getClientRects().length > 0 && currentSection === 'datasets';
}

// ── Batches ──────────────────────────────────────────────────────────────────

/** Apply one user action: locally, onto the undo stack, into the save queue. */
function itCommit(batch: ItBatch | null, select?: ItRange): boolean {
  const s = itS;
  if (!s || !batch) return false;
  const res = OrdInputEdits.applyBatch(s.rows, batch, s.columns.length, s.cap);
  if (!res) return false;
  s.rows = res.rows;
  OrdInputEdits.histPush(s.hist, { label: batch.label, forward: batch, inverse: res.inverse });
  s.pending.push(batch);
  if (select) s.sel = select;
  itAfterChange();
  return true;
}

function itStep(dir: 'undo' | 'redo'): void {
  const s = itS;
  if (!s) return;
  itCancelEdit();
  const e = dir === 'undo' ? OrdInputEdits.histUndo(s.hist) : OrdInputEdits.histRedo(s.hist);
  if (!e) return;
  const b = dir === 'undo' ? e.inverse : e.forward;
  const res = OrdInputEdits.applyBatch(s.rows, b, s.columns.length, s.cap);
  if (!res) { showToast('That step no longer fits the table.', { kind: 'error' }); return; }
  s.rows = res.rows;
  // An undo of a batch still waiting to be saved simply drops it from the queue.
  const other = dir === 'undo' ? e.forward : e.inverse;
  if (s.pending[s.pending.length - 1] === other) s.pending.pop();
  else s.pending.push(b);
  const last = s.rows.length;
  if (s.sel.r1 > last) s.sel = { r0: last, c0: s.sel.c1, r1: last, c1: s.sel.c1 };
  itAfterChange();
  showToast((dir === 'undo' ? 'Undid: ' : 'Redid: ') + e.label);
  // The grid keeps focus, so the save still happens on blur.
  itFocusGrid();
}

function itUndo(): void { itStep('undo'); }
function itRedo(): void { itStep('redo'); }

function itAfterChange(): void {
  itRender();
  itPaintBar();
  itScheduleValidate();
}

function itAddRow(): void {
  const s = itS;
  if (!s) return;
  const at = s.rows.length;
  if (!itCommit(OrdInputEdits.insertRowsBatch(at, 1, at, s.cap), { r0: at, c0: 0, r1: at, c1: 0 })) {
    showToast(`An input table holds up to ${s.cap.toLocaleString('en-US')} rows.`, { kind: 'error' });
    return;
  }
  itScrollToActive();
  itFocusGrid();
}

function itDeleteRows(): void {
  const s = itS;
  if (!s) return;
  const a = Math.min(s.sel.r0, s.sel.r1);
  const b = Math.min(Math.max(s.sel.r0, s.sel.r1), s.rows.length - 1);
  if (b < a) return;
  itCommit(OrdInputEdits.deleteRowsBatch(a, b, s.rows.length), { r0: a, c0: s.sel.c1, r1: a, c1: s.sel.c1 });
  itFocusGrid();
}

// ── Checking (main decides) ──────────────────────────────────────────────────

function itScheduleValidate(): void {
  window.clearTimeout(itValidateTimer);
  itValidateTimer = window.setTimeout(() => { void itValidate(); }, IT_VALIDATE_MS);
}

async function itValidate(): Promise<void> {
  const s = itS;
  if (!s) return;
  const seq = ++s.vseq;
  let res: any = null;
  try { res = await window.hubInput.validate(s.pid, s.id, s.rows); } catch (_) { res = null; }
  if (itS !== s || seq !== s.vseq || !res || !res.ok) return;
  itTakeCheck(res);
  itRender();
  itPaintBar();
}

// ── Saving (on blur) ─────────────────────────────────────────────────────────

function itScheduleFlush(): void {
  window.clearTimeout(itFlushTimer);
  // After the editor's own blur has committed its cell.
  itFlushTimer = window.setTimeout(() => { void itFlush(); }, 0);
}

/** Save everything queued. Resolves when this table's queue is empty or failed. */
function itFlush(): Promise<void> {
  itSaveChain = itSaveChain.then(() => itSaveNow()).catch(() => undefined);
  return itSaveChain;
}

async function itSaveNow(): Promise<void> {
  const s = itS;
  if (!s || !s.pending.length) return;
  const batches = s.pending.splice(0);
  s.saving = true;
  s.error = '';
  itPaintBar();
  let res: any = null;
  try { res = await window.hubInput.save(s.pid, s.id, batches); } catch (e: any) { res = { ok: false, error: e && e.message }; }
  s.saving = false;
  if (!res || !res.ok) {
    s.pending.unshift(...batches); // nothing was written: keep them, and say so
    s.error = (res && res.error) || 'The table could not be saved';
    itPaintBar();
    return;
  }
  // Main's copy is the truth (typed numbers coerced, refused text kept). Adopt
  // it only if nothing was typed while it saved — otherwise the local rows are
  // main's plus those newer batches, already, and the next save carries them.
  itAdopt(res, s.pending.length === 0);
  if (s.pending.length) itScheduleValidate();
  if (itS === s) {
    itRender();
    itPaintBar();
    // The read-only grid (Prepare) and the stats read the stored table.
    if (typeof expId === 'string' && expId === s.id) {
      expRowCount = s.rows.length;
      void refreshExplorerPage();
      void loadExplorerStats();
    }
  }
}

// ── The toolbar and the status line ──────────────────────────────────────────

function itPaintBar(): void {
  const s = itS;
  if (!s) return;
  const labels = OrdInputEdits.histLabels(s.hist);
  const undo = itEl<HTMLButtonElement>('it-undo');
  const redo = itEl<HTMLButtonElement>('it-redo');
  if (undo) { undo.disabled = !labels.undo; undo.title = labels.undo ? 'Undo: ' + labels.undo : 'Nothing to undo'; }
  if (redo) { redo.disabled = !labels.redo; redo.title = labels.redo ? 'Redo: ' + labels.redo : 'Nothing to redo'; }
  const del = itEl<HTMLButtonElement>('it-del-rows');
  if (del) {
    const a = Math.min(s.sel.r0, s.sel.r1);
    const b = Math.min(Math.max(s.sel.r0, s.sel.r1), s.rows.length - 1);
    del.disabled = b < a;
    iconLabel(del, 'trash', b > a ? `Delete ${b - a + 1} rows` : 'Delete row');
  }
  const add = itEl<HTMLButtonElement>('it-add-row');
  if (add) add.disabled = s.rows.length >= s.cap;

  const status = itEl('it-status');
  if (status) {
    status.className = 'it-status';
    status.textContent = '';
    if (s.error) {
      status.classList.add('is-error');
      status.appendChild(icon('alert', 14));
      status.appendChild(document.createTextNode(' Not saved — ' + s.error + ' '));
      const retry = itMk<HTMLButtonElement>('button', 'it-link', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', () => { void itFlush(); });
      status.appendChild(retry);
    } else if (s.saving) {
      status.classList.add('is-busy');
      status.textContent = 'Saving…';
    } else if (s.pending.length) {
      status.classList.add('is-dirty');
      status.textContent = 'Unsaved — saves when you leave the table';
    } else {
      status.classList.add('is-saved');
      status.appendChild(icon('check', 14));
      status.appendChild(document.createTextNode(' Saved · ' + itRowsWord(s.rows.length)));
    }
  }
  const attn = itEl<HTMLButtonElement>('it-attn');
  if (attn) {
    const n = s.failCells + s.warnCells;
    attn.hidden = n === 0;
    attn.classList.toggle('is-warn', s.failCells === 0);
    attn.textContent = '';
    if (n) {
      attn.appendChild(icon('alert', 14));
      attn.appendChild(document.createTextNode(` ${n.toLocaleString('en-US')} ${n === 1 ? 'cell needs' : 'cells need'} attention`));
      attn.title = 'Go to the next one';
    }
  }
  const count = itEl('it-count');
  if (count) count.textContent = `${s.rows.length.toLocaleString('en-US')} of ${s.cap.toLocaleString('en-US')} rows`;
  const notes = itEl('it-notes');
  if (notes) {
    notes.textContent = '';
    const lines = s.notes.slice();
    if (s.steps) lines.push(`${s.steps} prepare ${s.steps === 1 ? 'step runs' : 'steps run'} on this table — Prepare shows the result.`);
    for (const line of lines) notes.appendChild(itMk('p', '', line));
    notes.hidden = lines.length === 0;
  }
  const empty = itEl('it-empty');
  if (empty) empty.hidden = s.rows.length > 0;
}

/** Move to the next flagged cell after the active one, wrapping. */
function itNextIssue(): void {
  const s = itS;
  if (!s || !s.issues.size) return;
  const w = s.columns.length;
  const here = s.sel.r1 * w + s.sel.c1;
  const keys = [...s.issues.keys()].map((k) => { const [r, c] = k.split(':').map(Number); return r * w + c; }).sort((a, b) => a - b);
  const next = keys.find((k) => k > here) ?? keys[0];
  const r = Math.floor(next / w);
  const c = next % w;
  s.sel = { r0: r, c0: c, r1: r, c1: c };
  itRender();
  itScrollToActive();
  itFocusGrid();
  itPaintBar();
}
