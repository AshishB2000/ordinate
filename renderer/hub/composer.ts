'use strict';

// The dataset composer — the full-page create surface. Classic global-scope
// renderer <script>: no import/export.
//
// Creating a dataset used to be a dialog (parse → preview → name → save) and
// combining a second dialog of four selects. This is one page: the tables being
// combined on a canvas, a live preview underneath, and field mapping done on the
// preview's own header.
//
// TWO RULES SHAPE EVERYTHING HERE.
//
//   1. The canvas is a horizontal CHAIN. The engine is combine.composeTables, a
//      left-to-right fold, so free 2-D placement would draw a graph the app does
//      not run. There are no positions to persist and nothing to drift.
//   2. The renderer never computes a joined row. Every preview — every row
//      count, every warning — comes back from dataset:composePreview. This file
//      sends a chain and paints the answer.
//
// The preview is folded from the first 50k rows PER TABLE (main decides that and
// says so in its warnings); the save folds the lot.

// ── State ────────────────────────────────────────────────────────────────────

/** One table on the canvas. `ref` is what the IPC takes: a saved id, or an inline parse. */
interface DcTable {
  label: string;
  rows: number;
  kind: string;
  ref: { datasetId?: string; inline?: { name: string; columns: any[]; rows: any[][]; stagedId?: string } };
  columns: string[];
}

type DcMode = 'inner' | 'left' | 'append';
interface DcLink { table: DcTable; mode: DcMode; on?: { left: string; right: string } }

let dcBase: DcTable | null = null;
let dcLinks: DcLink[] = [];
/** The base's own origin + sourceKind, forwarded to the save so the result refreshes. */
let dcOrigin: any = undefined;
let dcSourceKind = '';
/** Preview columns as main last returned them, before this page's mapping. */
let dcRawCols: any[] = [];
/** Field mapping, keyed by the ORIGINAL column name. */
const dcMap = new Map<string, { name: string; type: string; dropped: boolean }>();
let dcPage = 0;
let dcTotal = 0;
/**
 * Whether the preview's CELLS are editable, not just its column headers.
 *
 * On for a screenshot capture and nothing else. Every other source is a file or
 * a query whose cells are ground truth — editing them here would silently
 * diverge the dataset from the thing it claims to be, and the Prepare pipeline
 * is where a saved dataset gets changed. A capture's cells are a MODEL'S
 * READING of an image and can simply be wrong, so the correction belongs before
 * the save. See `dcEditCell`: an edit is only possible while the canvas is a
 * bare base (no joins), because with a fold in between a preview cell no longer
 * maps to one source cell.
 */
let dcCellEdit = false;
let dcPageRows = 100;
let dcPreviewSeq = 0;
let dcTimer: number | null = null;
let dcOpenJoin = -1;
let dcOpenCol = '';

const DC_MODES: ReadonlyArray<{ id: DcMode; label: string; hint: string }> = [
  { id: 'inner', label: 'Inner', hint: 'Only rows that match on both sides' },
  { id: 'left', label: 'Left', hint: 'Every row on the left; blanks where there is no match' },
  { id: 'append', label: 'Append', hint: 'Stack the rows; columns line up by name' },
];

function dcEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/**
 * The two-circle venn that marks a join, and the stacked rows that mark an
 * append. Inline SVG with `currentColor` — no asset, no font, and it inherits
 * the badge's colour so a keyless join can go `--warn` with one class.
 */
function dcModeIcon(mode: DcMode, size = 18): string {
  const s = String(size);
  if (mode === 'append') {
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">`
      + '<rect x="4" y="4" width="16" height="6" rx="1" fill="currentColor" stroke="none"/>'
      + '<rect x="4" y="14" width="16" height="6" rx="1"/></svg>';
  }
  // Two overlapping circles; the FILL says which rows survive.
  const lens = 'M12 6.2a6.5 6.5 0 0 0 0 11.6 6.5 6.5 0 0 0 0-11.6z';
  const left = mode === 'left'
    ? '<circle cx="9.5" cy="12" r="6.5" fill="currentColor" stroke="none" opacity="0.9"/>'
    : '';
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">`
    + left
    + (mode === 'inner' ? `<path d="${lens}" fill="currentColor" stroke="none"/>` : '')
    + '<circle cx="9.5" cy="12" r="6.5"/><circle cx="14.5" cy="12" r="6.5"/></svg>';
}

// ── Open / close ─────────────────────────────────────────────────────────────

/**
 * Open the composer on a base table.
 *
 * `#ds-composer`'s own `hidden` bit is the single source of truth for which of
 * the Data panel's three views is showing — dataSection.ts watches it, exactly
 * as it watches the explorer's.
 */
function openComposer(base: DcTable | null, opts: { name?: string; origin?: any; sourceKind?: string } = {}): void {
  dcBase = base;
  dcLinks = [];
  dcMap.clear();
  dcRawCols = [];
  dcPage = 0;
  dcOrigin = opts.origin;
  dcSourceKind = opts.sourceKind || '';
  dcCellEdit = dcSourceKind === 'capture' && !!(base && base.ref.inline);
  pvComposerReset(); // privacyReview.ts — sensitivity chips belong to one import
  const name = dcEl('dc-name') as HTMLInputElement | null;
  if (name) name.value = opts.name || (base ? base.label : '');

  const explorer = dcEl('ds-explorer');
  if (explorer) explorer.hidden = true;
  const panel = dcEl('ds-composer');
  if (panel) panel.hidden = false;

  renderComposerSources();
  renderCanvas();
  schedulePreview(0);
  if (name) name.focus();
}

function closeComposer(): void {
  closeJoinPop();
  closeColPop();
  const panel = dcEl('ds-composer');
  if (panel) panel.hidden = true;
  dcBase = null;
  dcLinks = [];
  dcMap.clear();
}

// ── The sources panel ────────────────────────────────────────────────────────

function dcSourceRow(label: string, meta: string, onAdd: () => void): HTMLElement {
  const row = document.createElement('button');
  row.className = 'dc-src';
  row.type = 'button';
  row.draggable = true;
  const n = document.createElement('span');
  n.className = 'dc-src-name';
  n.textContent = label;
  const m = document.createElement('span');
  m.className = 'dc-src-meta';
  m.textContent = meta;
  row.appendChild(n);
  row.appendChild(m);
  row.addEventListener('click', onAdd);
  // Drag is the enhancement, the click is the contract — a pointer-only affordance
  // would put the whole panel out of reach of the keyboard.
  row.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/plain', label); });
  row.addEventListener('dragend', () => { /* drop handled on the canvas */ });
  (row as any)._dcAdd = onAdd;
  return row;
}

async function renderComposerSources(): Promise<void> {
  const importList = dcEl('dc-src-import');
  const group = dcEl('dc-src-import-group');
  if (importList && group) {
    importList.innerHTML = '';
    // The base, when just imported rather than saved — and the SHEET it came from.
    const inline = dcBase && dcBase.ref.inline ? dcBase : null;
    group.hidden = !inline;
    if (inline) {
      const sheet = dcOrigin && dcOrigin.sheetName ? ` · ${dcOrigin.sheetName}` : '';
      const row = dcSourceRow(inline.label, `${inline.rows.toLocaleString()} rows${sheet} · on the canvas`, () => {});
      row.classList.add('dc-src-used');
      row.setAttribute('aria-disabled', 'true');
      importList.appendChild(row);
    }
  }

  const savedList = dcEl('dc-src-saved');
  const empty = dcEl('dc-src-empty');
  if (!savedList) return;
  savedList.innerHTML = '';
  let list: any[] = [];
  try {
    list = (await window.hub.listDatasets(currentProjectId)) || [];
  } catch (_) { list = []; }
  if (empty) empty.hidden = list.length > 0;
  for (const d of list) {
    const row = dcSourceRow(d.name, `${Number(d.rowCount || 0).toLocaleString()} rows`, () => addTableById(d.id, d.name));
    savedList.appendChild(row);
  }
}

/** Add a saved dataset to the chain. Its columns come from main, for the key pickers. */
async function addTableById(id: string, name: string): Promise<void> {
  const first = !dcBase;
  let ds: any = null;
  try {
    const res = await window.hub.getDataset(currentProjectId, id);
    ds = res && res.dataset ? res.dataset : res;
  } catch (_) { ds = null; }
  if (!ds || !Array.isArray(ds.columns)) {
    showToast('Could not read that dataset.');
    return;
  }
  const table: DcTable = {
    label: name,
    rows: Number(ds.rowCount || (ds.rows ? ds.rows.length : 0)) || 0,
    kind: String(ds.sourceKind || ''),
    ref: { datasetId: id },
    columns: ds.columns.map((c: any) => String(c.name)),
  };
  // With nothing on the canvas yet, the first table picked IS the base.
  if (first) {
    dcBase = table;
    const nameEl = dcEl('dc-name') as HTMLInputElement | null;
    if (nameEl && !nameEl.value.trim()) nameEl.value = name;
    renderComposerSources();
    renderCanvas();
    schedulePreview(0);
    return;
  }
  dcLinks.push({ table, mode: 'inner', on: guessKeys(table) });
  renderCanvas();
  schedulePreview(0);
  // A new link with no key yet is the one thing worth opening for you.
  const idx = dcLinks.length - 1;
  if (!dcLinks[idx].on) openJoinPop(idx);
}

/**
 * Best guess for a key pair: an exact column-name match first, then a
 * case-insensitive one. No match leaves it empty and the badge goes `--warn`,
 * because a guessed key that is wrong is worse than an obvious blank.
 */
function guessKeys(right: DcTable): { left: string; right: string } | undefined {
  const left = chainColumns();
  for (const l of left) if (right.columns.indexOf(l) >= 0) return { left: l, right: l };
  const lower = right.columns.map((c) => c.toLowerCase());
  for (const l of left) {
    const i = lower.indexOf(l.toLowerCase());
    if (i >= 0) return { left: l, right: right.columns[i] };
  }
  return undefined;
}

/** The column names available on the LEFT of the next join — what main last returned. */
function chainColumns(): string[] {
  if (dcRawCols.length) return dcRawCols.map((c: any) => String(c.name));
  return dcBase ? dcBase.columns : [];
}

// ── The canvas ───────────────────────────────────────────────────────────────

function dcChip(t: DcTable, onRemove: (() => void) | null): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'dc-chip';
  const name = document.createElement('div');
  name.className = 'dc-chip-name';
  name.textContent = t.label;
  const meta = document.createElement('div');
  meta.className = 'dc-chip-meta';
  meta.textContent = `${t.rows.toLocaleString()} rows`;
  chip.appendChild(name);
  chip.appendChild(meta);
  if (t.kind) {
    const badge = document.createElement('span');
    badge.className = 'dc-chip-kind';
    badge.textContent = t.kind;
    chip.appendChild(badge);
  }
  if (onRemove) {
    const x = document.createElement('button');
    x.className = 'dc-chip-x';
    x.type = 'button';
    iconOnly(x, 'x', `Remove ${t.label}`);
    x.addEventListener('click', onRemove);
    chip.appendChild(x);
  }
  return chip;
}

function renderCanvas(): void {
  const canvas = dcEl('dc-canvas');
  if (!canvas) return;
  canvas.innerHTML = '';
  if (!dcBase) {
    const hint = document.createElement('div');
    hint.className = 'dc-canvas-empty';
    hint.textContent = 'Pick a table on the left to start from.';
    canvas.appendChild(hint);
    return;
  }
  canvas.appendChild(dcChip(dcBase, null));

  dcLinks.forEach((link, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'dc-link';
    const badge = document.createElement('button');
    badge.className = 'dc-badge';
    badge.type = 'button';
    if (link.mode !== 'append' && !link.on) badge.classList.add('dc-badge-warn');
    badge.innerHTML = dcModeIcon(link.mode);
    const modeLabel = DC_MODES.find((m) => m.id === link.mode);
    badge.setAttribute('aria-label',
      `${modeLabel ? modeLabel.label : link.mode} join with ${link.table.label}`
      + (link.mode !== 'append' && !link.on ? ' — no key chosen' : ''));
    badge.addEventListener('click', () => openJoinPop(i));
    wrap.appendChild(badge);
    canvas.appendChild(wrap);

    canvas.appendChild(dcChip(link.table, () => removeLink(i)));
  });

  // Drop target for the sources panel's drag.
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); canvas.classList.add('dc-canvas-over'); });
  canvas.addEventListener('dragleave', () => canvas.classList.remove('dc-canvas-over'));
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    canvas.classList.remove('dc-canvas-over');
    const label = e.dataTransfer?.getData('text/plain') || '';
    const row = Array.from(document.querySelectorAll('#dc-src-saved .dc-src'))
      .find((el) => (el.querySelector('.dc-src-name') as HTMLElement | null)?.textContent === label) as any;
    if (row && typeof row._dcAdd === 'function') row._dcAdd();
  });
}

/**
 * Removing a table removes everything AFTER it too — the chain is a fold, so a
 * later join was computed over this one's output and cannot outlive it. The
 * confirm says so rather than surprising you.
 */
function removeLink(i: number): void {
  const after = dcLinks.length - 1 - i;
  const msg = after > 0
    ? `Remove "${dcLinks[i].table.label}" and the ${after} table${after === 1 ? '' : 's'} joined after it?`
    : `Remove "${dcLinks[i].table.label}"?`;
  if (!window.confirm(msg)) return;
  dcLinks = dcLinks.slice(0, i);
  closeJoinPop();
  renderCanvas();
  schedulePreview(0);
}

// ── The join editor ──────────────────────────────────────────────────────────

function openJoinPop(i: number): void {
  const pop = dcEl('dc-join-pop');
  const link = dcLinks[i];
  if (!pop || !link) return;
  dcOpenJoin = i;

  const modes = dcEl('dc-modes');
  if (modes) {
    modes.innerHTML = '';
    for (const m of DC_MODES) {
      const b = document.createElement('button');
      b.className = 'dc-mode' + (link.mode === m.id ? ' dc-mode-on' : '');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(link.mode === m.id));
      b.title = m.hint;
      b.innerHTML = dcModeIcon(m.id, 16) + `<span>${m.label}</span>`;
      b.addEventListener('click', () => {
        link.mode = m.id;
        if (m.id !== 'append' && !link.on) link.on = guessKeys(link.table);
        openJoinPop(i); // repaint the popover in place
        renderCanvas();
        schedulePreview(0);
      });
      modes.appendChild(b);
    }
  }

  const keys = dcEl('dc-keys');
  if (keys) keys.hidden = link.mode === 'append';
  const l = dcEl('dc-key-left') as HTMLSelectElement | null;
  const r = dcEl('dc-key-right') as HTMLSelectElement | null;
  if (l && r) {
    fillKeySelect(l, chainColumnsBefore(i), link.on ? link.on.left : '');
    fillKeySelect(r, link.table.columns, link.on ? link.on.right : '');
    const onPick = (): void => {
      if (l.value && r.value) link.on = { left: l.value, right: r.value };
      else link.on = undefined;
      renderCanvas();
      schedulePreview(0);
      paintJoinNote(link);
    };
    l.onchange = onPick;
    r.onchange = onPick;
  }
  paintJoinNote(link);

  const badge = document.querySelectorAll('#dc-canvas .dc-badge')[i] as HTMLElement | undefined;
  pop.hidden = false;
  if (badge) {
    const b = badge.getBoundingClientRect();
    let left = b.left + b.width / 2 - pop.offsetWidth / 2;
    if (left < 12) left = 12;
    if (left + pop.offsetWidth > window.innerWidth - 12) left = window.innerWidth - 12 - pop.offsetWidth;
    pop.style.left = left + 'px';
    pop.style.top = (b.bottom + 8) + 'px';
  }
  document.addEventListener('click', dcJoinDismiss, true);
  document.addEventListener('keydown', dcPopEsc, true);
}

function paintJoinNote(link: DcLink): void {
  const note = dcEl('dc-join-note');
  if (!note) return;
  if (link.mode !== 'append' && !link.on) {
    note.textContent = 'Choose a column on each side to join on.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

/** The columns available on the left at link `i` — before that link is folded in. */
function chainColumnsBefore(i: number): string[] {
  if (i === 0) return dcBase ? dcBase.columns : [];
  // Everything up to here has been folded already, so the preview's columns are
  // the honest answer for the LAST link; for an earlier one, fall back to the
  // union of the base and each preceding table, which is a superset.
  if (i === dcLinks.length - 1 && dcRawCols.length) return dcRawCols.map((c: any) => String(c.name));
  const names = dcBase ? dcBase.columns.slice() : [];
  for (let k = 0; k < i; k += 1) for (const c of dcLinks[k].table.columns) if (names.indexOf(c) < 0) names.push(c);
  return names;
}

function fillKeySelect(sel: HTMLSelectElement, cols: string[], value: string): void {
  sel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '—';
  sel.appendChild(blank);
  for (const c of cols) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  }
  sel.value = value && cols.indexOf(value) >= 0 ? value : '';
}

function dcJoinDismiss(e: MouseEvent): void {
  const pop = dcEl('dc-join-pop');
  const t = e.target as Node;
  if (!pop || pop.contains(t)) return;
  if ((t as HTMLElement).closest && (t as HTMLElement).closest('.dc-badge')) return;
  closeJoinPop();
}

function dcPopEsc(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (!dcEl('dc-join-pop')?.hidden) { closeJoinPop(); e.stopPropagation(); }
  else if (!dcEl('dc-col-pop')?.hidden) { closeColPop(); e.stopPropagation(); }
}

function closeJoinPop(): void {
  const pop = dcEl('dc-join-pop');
  if (pop) pop.hidden = true;
  dcOpenJoin = -1;
  document.removeEventListener('click', dcJoinDismiss, true);
  document.removeEventListener('keydown', dcPopEsc, true);
}

// ── The preview ──────────────────────────────────────────────────────────────

function schedulePreview(delay = 250): void {
  if (dcTimer) window.clearTimeout(dcTimer);
  dcTimer = window.setTimeout(() => { dcTimer = null; void runPreview(); }, delay);
}

async function runPreview(): Promise<void> {
  if (!dcBase) { paintGrid([]); paintWarnings([]); return; }
  const seq = ++dcPreviewSeq;
  const joins = dcLinks.map((l) => ({ ...l.table.ref, mode: l.mode, on: l.on }));
  let res: any;
  try {
    res = await window.hub.composePreview(currentProjectId, dcBase.ref, joins, dcPage);
  } catch (_) {
    res = { ok: false, error: 'Could not build the preview' };
  }
  if (seq !== dcPreviewSeq) return; // a newer edit already won
  if (!res || !res.ok) {
    paintWarnings([(res && res.error) || 'Could not build the preview']);
    return;
  }
  dcRawCols = res.columns || [];
  dcTotal = Number(res.total || 0);
  dcPageRows = Number(res.pageRows || 100);
  pvComposerSetProposals(res.sensitivity); // the header chips (privacyReview.ts)
  paintGrid(res.rows || []);
  paintCount();
  paintWarnings(res.warnings || []);
  paintPager();
}

function paintCount(): void {
  const el = dcEl('dc-count');
  if (!el) return;
  const cols = visibleCols().length;
  el.textContent = `${dcTotal.toLocaleString()} rows · ${cols} column${cols === 1 ? '' : 's'}`;
}

function paintWarnings(list: string[]): void {
  const box = dcEl('dc-warnings');
  if (!box) return;
  box.innerHTML = '';
  for (const w of list) {
    const li = document.createElement('div');
    li.className = 'dc-warning';
    li.textContent = w;
    box.appendChild(li);
  }
  box.hidden = list.length === 0;
}

function paintPager(): void {
  const pager = dcEl('dc-pager');
  const label = dcEl('dc-page-label');
  if (!pager || !label) return;
  const pages = Math.max(1, Math.ceil(dcTotal / dcPageRows));
  pager.hidden = pages <= 1;
  label.textContent = `Page ${dcPage + 1} of ${pages.toLocaleString()}`;
  const prev = dcEl('dc-prev') as HTMLButtonElement | null;
  const next = dcEl('dc-next') as HTMLButtonElement | null;
  if (prev) prev.disabled = dcPage === 0;
  if (next) next.disabled = dcPage >= pages - 1;
}

// The PREVIEW GRID and its column menu — paintGrid, mapFor, visibleCols,
// openColPop and the capture-only cell editing — live in composerGrid.ts. This
// file owns the canvas and the save; that one owns what the preview looks like.

function mappingSteps(): any[] {
  const steps: any[] = [];
  for (const col of dcRawCols) {
    const key = String(col.name);
    const m = dcMap.get(key);
    if (m && !m.dropped && m.name && m.name !== key) steps.push({ type: 'rename_column', from: key, to: m.name });
  }
  for (const col of dcRawCols) {
    const key = String(col.name);
    const m = dcMap.get(key);
    if (m && m.dropped) steps.push({ type: 'drop_column', column: m.name !== key ? key : key });
  }
  return steps;
}

/** Retypes are not a step — they are the same column update the explorer makes. */
function mappedColumns(): Array<{ name: string; type: string }> {
  return visibleCols().map((c) => {
    const m = mapFor(c);
    return { name: m.name, type: m.type };
  });
}

// ── Save ─────────────────────────────────────────────────────────────────────

async function handleComposerSave(): Promise<void> {
  if (!dcBase || !currentProjectId) return;
  const missing = dcLinks.filter((l) => l.mode !== 'append' && !l.on);
  if (missing.length) {
    showToast(`Choose a join key for "${missing[0].table.label}" first.`);
    const i = dcLinks.indexOf(missing[0]);
    if (i >= 0) openJoinPop(i);
    return;
  }
  const nameEl = dcEl('dc-name') as HTMLInputElement | null;
  const name = (nameEl && nameEl.value.trim()) || dcBase.label || 'Untitled dataset';
  const btn = dcEl('dc-save') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  // Retypes land through the SAME column update the explorer's header menu
  // makes — now inside the save job (main applies `retype` after the rows),
  // so a 1M-row import is one job with one progress bar, not two round trips.
  const changedType = dcRawCols.some((c) => !mapFor(c).dropped && mapFor(c).type !== String(c.type || 'text'));
  let res: any;
  try {
    res = await window.hub.composeSave({
      projectId: currentProjectId,
      name,
      base: dcBase.ref,
      joins: dcLinks.map((l) => ({ ...l.table.ref, mode: l.mode, on: l.on })),
      steps: mappingSteps(),
      sourceKind: dcSourceKind || undefined,
      origin: dcOrigin,
      retype: changedType ? mappedColumns() : undefined,
    });
  } catch (_) {
    res = { ok: false, error: 'Failed to save the dataset.' };
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  if (res && res.canceled) { showToast('Import cancelled.'); return; }
  if (!res || !res.ok) {
    window.alert((res && res.error) || 'Failed to save the dataset.');
    return;
  }

  // The sensitivity chips' answers, against the column names as SAVED.
  if (res.dataset && res.dataset.id) {
    await pvComposerCommit(String(res.dataset.id), (raw) => {
      const m = dcMap.get(raw);
      return m && m.dropped ? null : (m && m.name) || raw;
    });
  }

  for (const w of (res.warnings || [])) showToast(w);
  closeComposer();
  await refreshDatasetList();
  showToast(`Saved "${name}".`);
  // A dataset saved from the Query tab opens on its own page, where its
  // lineage (what it reads from, and that it refreshes when they change) is.
  if (dcOrigin && (dcOrigin.kind === 'sql' || dcOrigin.kind === 'notebook') && res.dataset && res.dataset.id) void openSavedDataset(String(res.dataset.id));
}

// ── Boot wiring (once) ───────────────────────────────────────────────────────

/** The header's "Combine datasets": the composer with nothing on it yet. */
function openComposerEmpty(): void {
  openComposer(null, { name: '' });
}

/** A saved dataset's row action: the composer with that dataset as the base. */
async function openComposerOnDataset(id: string, name: string): Promise<void> {
  let ds: any = null;
  try {
    const res = await window.hub.getDataset(currentProjectId, id);
    ds = res && res.dataset ? res.dataset : res;
  } catch (_) { ds = null; }
  if (!ds || !Array.isArray(ds.columns)) {
    showToast('Could not read that dataset.');
    return;
  }
  openComposer({
    label: name,
    rows: Number(ds.rowCount || 0) || 0,
    kind: String(ds.sourceKind || ''),
    ref: { datasetId: id },
    columns: ds.columns.map((c: any) => String(c.name)),
  }, { name: `${name} combined` });
}

function initComposer(): void {
  const back = dcEl('dc-back');
  if (back) back.addEventListener('click', () => closeComposer());
  const save = dcEl('dc-save');
  if (save) save.addEventListener('click', () => void handleComposerSave());
  const prev = dcEl('dc-prev');
  if (prev) prev.addEventListener('click', () => { if (dcPage > 0) { dcPage -= 1; schedulePreview(0); } });
  const next = dcEl('dc-next');
  if (next) next.addEventListener('click', () => { dcPage += 1; schedulePreview(0); });
}
