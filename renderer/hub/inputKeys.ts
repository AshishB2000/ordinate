'use strict';

// The INPUT TABLE GRID's keyboard, cell editor, lookup dropdown and clipboard.
// Classic global-scope renderer <script>: no import/export.
//
// KEYS. Handled on `window` in the CAPTURE phase while the grid itself has
// focus, which runs before the app's command keymap (commands.ts, capture on
// document): typing `?` into a cell must type a question mark, not open the
// shortcuts sheet. Only the keys the grid owns are stopped; ⌘Z / ⇧⌘Z go on to
// the keymap, whose `dash.undo` / `dash.redo` dispatch to the grid
// (commandDefs.ts) — the app's one undo binding.
//
//   arrows move (Shift extends) · Enter / Shift+Enter down / up · Tab /
//   Shift+Tab across, wrapping · Home / End · PageUp / PageDown · typing
//   replaces · F2 or double-click edits in place · Escape cancels · Delete /
//   Backspace clears · ⌘D fills down · ⌘A selects all
//
// CLIPBOARD. The ordinary copy / cut / paste events, caught on the document
// while the grid has focus: they carry the clipboard both ways with no
// permission prompt and no IPC, from the keys AND the Edit menu. A paste is ONE
// batch however big the block (OrdInputEdits.pasteBatch).
//
// LOOKUPS. Editing a lookup cell opens a list of the key column's distinct
// values — main's resident `dataset:distinct`, searched as you type, capped at
// 200 with the true total shown. Picking one is a choice; typing something else
// is allowed, and main flags it.

let itPop: HTMLElement | null = null;
let itPopItems: string[] = [];
let itPopIdx = -1;
let itPopSeq = 0;
let itPopTimer = 0;
/** False until the user types in a lookup editor: F2 on "east" lists every value, not just "east". */
let itPopTyped = false;

function itGridFocused(): boolean {
  const t = itEl('it-grid');
  return !!itS && !!t && document.activeElement === t;
}

function itWireKeys(table: HTMLTableElement, editor: HTMLInputElement): void {
  window.addEventListener('keydown', itGridKeydown, true);
  editor.addEventListener('keydown', itEditorKeydown);
  editor.addEventListener('input', () => { itPopTyped = true; itLookupSearch(); });
  editor.addEventListener('blur', () => { if (itS && itS.edit) itCommitEdit(); });
  document.addEventListener('copy', (e) => itClipboard(e, 'copy'));
  document.addEventListener('cut', (e) => itClipboard(e, 'cut'));
  document.addEventListener('paste', (e) => itClipboard(e, 'paste'));
  void table;
}

function itGridKeydown(e: KeyboardEvent): void {
  if (!itGridFocused()) return;
  const s = itS as ItState;
  const mod = CMD_IS_MAC ? e.metaKey : e.ctrlKey;
  const k = e.key;
  const page = Math.max(1, Math.floor(((itEl('it-scroll') || { clientHeight: 300 }).clientHeight - 34) / IT_ROW_H) - 1);
  let handled = true;
  if (mod && !e.altKey && !e.shiftKey && (k === 'd' || k === 'D')) itFillDown();
  else if (mod && !e.altKey && !e.shiftKey && (k === 'a' || k === 'A')) itSelectAll();
  else if (mod && (k === 'ArrowUp' || k === 'ArrowDown')) itMove(k === 'ArrowUp' ? -s.sel.r1 : itMaxRow(), 0, e.shiftKey);
  else if (mod && (k === 'ArrowLeft' || k === 'ArrowRight')) itMove(0, k === 'ArrowLeft' ? -s.sel.c1 : s.columns.length, e.shiftKey);
  else if (mod || e.altKey) handled = false; // ⌘Z, ⌘C, ⌘V and the rest belong to the app and the clipboard
  else {
    switch (k) {
      case 'ArrowUp': itMove(-1, 0, e.shiftKey); break;
      case 'ArrowDown': itMove(1, 0, e.shiftKey); break;
      case 'ArrowLeft': itMove(0, -1, e.shiftKey); break;
      case 'ArrowRight': itMove(0, 1, e.shiftKey); break;
      case 'Enter': itMove(e.shiftKey ? -1 : 1, 0, false); break;
      case 'Tab':
        // Past the last cell (or before the first) Tab leaves the grid, as it
        // leaves any control — the grid is not a keyboard trap.
        if (e.shiftKey ? s.sel.r1 === 0 && s.sel.c1 === 0 : s.sel.r1 >= itMaxRow() && s.sel.c1 >= s.columns.length - 1) handled = false;
        else itTab(e.shiftKey);
        break;
      case 'Home': itMove(0, -s.sel.c1, e.shiftKey); break;
      case 'End': itMove(0, s.columns.length, e.shiftKey); break;
      case 'PageUp': itMove(-page, 0, e.shiftKey); break;
      case 'PageDown': itMove(page, 0, e.shiftKey); break;
      case 'F2': itBeginEdit('keep'); break;
      case 'Delete':
      case 'Backspace': itCommit(OrdInputEdits.clearBatch(s.rows, s.sel)); break;
      case 'Escape':
        if (s.sel.r0 !== s.sel.r1 || s.sel.c0 !== s.sel.c1) {
          s.sel = { r0: s.sel.r1, c0: s.sel.c1, r1: s.sel.r1, c1: s.sel.c1 };
          itRender();
          itPaintBar();
        } else {
          handled = false;
        }
        break;
      default:
        if (k.length === 1) {
          // Typing replaces: the editor takes focus NOW, and the keystroke's
          // character lands in it — so no preventDefault.
          e.stopPropagation();
          itBeginEdit('replace');
          return;
        }
        handled = false;
    }
  }
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

function itFillDown(): void {
  const s = itS;
  if (!s) return;
  const b = OrdInputEdits.fillDownBatch(s.rows, s.sel);
  if (!b) { showToast('Select the cells to fill — the first row is copied down over the rest.'); return; }
  itCommit(b);
}

// ── The cell editor ──────────────────────────────────────────────────────────

function itBeginEdit(mode: 'replace' | 'keep'): void {
  const s = itS;
  const input = itEl<HTMLInputElement>('it-editor');
  if (!s || !input || !s.columns.length) return;
  const r = s.sel.r1;
  const c = s.sel.c1;
  if (r > s.rows.length || (r === s.rows.length && s.rows.length >= s.cap)) return;
  const col = s.columns[c];
  s.sel = { r0: r, c0: c, r1: r, c1: c };
  s.edit = { r, c, mode };
  const v = r < s.rows.length ? s.rows[r][c] : null;
  input.value = mode === 'keep' && v !== null ? String(v) : '';
  input.classList.toggle('is-num', col.type === 'number');
  input.setAttribute('aria-label', `${col.name}, row ${r + 1}`);
  input.placeholder = col.type === 'date' ? 'YYYY-MM-DD' : '';
  input.hidden = false;
  itScrollToActive();
  input.focus();
  if (mode === 'keep') input.setSelectionRange(input.value.length, input.value.length);
  itPopTyped = false;
  if (col.lookup) itLookupOpen();
}

/** Lay the editor exactly over the active cell (it scrolls with the table). */
function itPositionEditor(): void {
  const s = itS;
  const input = itEl<HTMLInputElement>('it-editor');
  const scroll = itEl('it-scroll');
  if (!s || !s.edit || !input || !scroll) return;
  const td = document.getElementById(`it-c-${s.edit.r}-${s.edit.c}`);
  if (!td) return;
  const a = td.getBoundingClientRect();
  const b = scroll.getBoundingClientRect();
  input.style.top = (a.top - b.top + scroll.scrollTop) + 'px';
  input.style.left = (a.left - b.left + scroll.scrollLeft) + 'px';
  input.style.width = Math.max(a.width, 140) + 'px';
  input.style.height = a.height + 'px';
}

/**
 * Hide the editor. Focus goes back to the grid FIRST when the editor has it:
 * hiding a focused input blurs it to <body>, which reads as focus leaving the
 * table — and that is the save-on-blur trigger.
 */
function itHideEditor(input: HTMLInputElement): void {
  if (document.activeElement === input) itFocusGrid();
  input.hidden = true;
  itLookupClose();
}

function itCommitEdit(): void {
  const s = itS;
  const input = itEl<HTMLInputElement>('it-editor');
  if (!s || !s.edit || !input) return;
  const { r, c } = s.edit;
  s.edit = null;
  itHideEditor(input);
  if (!itCommit(OrdInputEdits.editBatch(s.rows, r, c, input.value, s.columns[c].name, s.cap))) itRender();
}

/** Drop the edit in progress. Focus is the caller's to place. */
function itCancelEdit(): void {
  const s = itS;
  const input = itEl<HTMLInputElement>('it-editor');
  if (!s || !s.edit || !input) return;
  s.edit = null;
  itHideEditor(input);
  itRender();
}

function itEditorKeydown(e: KeyboardEvent): void {
  const s = itS;
  if (!s || !s.edit) return;
  const open = !!itPop;
  const arrows = e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  const leave = (dr: number, dc: number): void => {
    e.preventDefault();
    itCommitEdit();
    itFocusGrid();
    if (dr || dc) itMove(dr, dc, false);
  };
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey) {
    e.preventDefault();
    itLookupMove(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.altKey && e.key === 'ArrowDown' && s.columns[s.edit.c].lookup) { e.preventDefault(); itLookupOpen(); return; }
  if (e.key === 'Enter') {
    if (open && itPopIdx >= 0) (e.target as HTMLInputElement).value = itPopItems[itPopIdx];
    leave(e.shiftKey ? -1 : 1, 0);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    itCommitEdit();
    itFocusGrid();
    itTab(e.shiftKey);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    itCancelEdit();
    itFocusGrid();
  } else if (arrows && s.edit.mode === 'replace') {
    leave(e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0, e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
  } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && s.edit.mode === 'keep') {
    leave(e.key === 'ArrowUp' ? -1 : 1, 0);
  }
}

// ── The lookup dropdown ──────────────────────────────────────────────────────

function itLookupOpen(): void {
  const input = itEl<HTMLInputElement>('it-editor');
  if (!input || !itS || !itS.edit) return;
  if (!itPop) {
    itPop = itMk('div', 'it-pop');
    itPop.id = 'it-pop';
    itPop.setAttribute('role', 'listbox');
    itPop.setAttribute('aria-label', 'Values to choose from');
    // A click inside keeps the editor focused, so choosing is not a blur.
    itPop.addEventListener('mousedown', (e) => e.preventDefault());
    // Inside the grid's scroll box, like the editor: it moves with the cell
    // when the page reflows or the grid scrolls, never left behind.
    const scroll = itEl('it-scroll');
    if (scroll) scroll.appendChild(itPop);
  }
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'it-pop');
  itLookupPlace();
  itLookupSearch();
}

function itLookupPlace(): void {
  const input = itEl<HTMLInputElement>('it-editor');
  if (!itPop || !input || input.hidden) return;
  itPositionEditor();
  itPop.style.left = input.style.left;
  itPop.style.top = input.offsetTop + input.offsetHeight + 2 + 'px';
  itPop.style.minWidth = Math.max(input.offsetWidth, 220) + 'px';
}

function itLookupSearch(): void {
  const s = itS;
  const input = itEl<HTMLInputElement>('it-editor');
  if (!itPop || !s || !s.edit || !input) return;
  const lk = s.columns[s.edit.c].lookup;
  if (!lk) return;
  window.clearTimeout(itPopTimer);
  const seq = ++itPopSeq;
  itPopTimer = window.setTimeout(async () => {
    let res: any = null;
    try {
      res = await window.hub.datasetDistinct(s.pid, lk.datasetId, lk.column, 200, itPopTyped ? input.value : '');
    } catch (_) { res = null; }
    if (seq !== itPopSeq || !itPop) return;
    itLookupPaint(Array.isArray(res && res.values) ? res.values : [], Number(res && res.total) || 0, lk);
  }, 120);
}

function itLookupPaint(values: string[], total: number, lk: any): void {
  const pop = itPop as HTMLElement;
  const input = itEl<HTMLInputElement>('it-editor') as HTMLInputElement;
  pop.textContent = '';
  itPopItems = values;
  const current = input.value;
  itPopIdx = values.indexOf(current);
  const head = itMk('div', 'it-pop-head', `${(itS && itS.lookupNames[lk.datasetId]) || 'Lookup'} · ${lk.column}`);
  pop.appendChild(head);
  if (!values.length) {
    pop.appendChild(itMk('div', 'it-pop-empty', itPopTyped && current ? `No value matches “${current}”` : 'That column has no values yet'));
  }
  values.forEach((v, i) => {
    const opt = itMk('div', 'it-opt', v);
    opt.id = 'it-opt-' + i;
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', i === itPopIdx ? 'true' : 'false');
    if (i === itPopIdx) opt.classList.add('is-hi');
    opt.addEventListener('click', () => {
      input.value = v;
      itCommitEdit();
      itFocusGrid();
    });
    pop.appendChild(opt);
  });
  if (total > values.length) {
    pop.appendChild(itMk('div', 'it-pop-foot', `Showing ${values.length} of ${total.toLocaleString('en-US')} — type to narrow`));
  }
  if (itPopIdx >= 0) input.setAttribute('aria-activedescendant', 'it-opt-' + itPopIdx);
  else input.removeAttribute('aria-activedescendant');
}

function itLookupMove(d: number): void {
  const input = itEl<HTMLInputElement>('it-editor');
  if (!itPop || !itPopItems.length || !input) return;
  itPopIdx = Math.max(0, Math.min(itPopItems.length - 1, itPopIdx + d));
  itPop.querySelectorAll('.it-opt').forEach((o, i) => {
    o.classList.toggle('is-hi', i === itPopIdx);
    o.setAttribute('aria-selected', i === itPopIdx ? 'true' : 'false');
    if (i === itPopIdx) (o as HTMLElement).scrollIntoView({ block: 'nearest' });
  });
  input.setAttribute('aria-activedescendant', 'it-opt-' + itPopIdx);
}

function itLookupClose(): void {
  window.clearTimeout(itPopTimer);
  itPopSeq++;
  if (itPop) { itPop.remove(); itPop = null; }
  itPopItems = [];
  itPopIdx = -1;
  const input = itEl<HTMLInputElement>('it-editor');
  if (input) {
    input.removeAttribute('role');
    input.removeAttribute('aria-expanded');
    input.removeAttribute('aria-controls');
    input.removeAttribute('aria-activedescendant');
  }
}

// ── Clipboard ────────────────────────────────────────────────────────────────

function itClipboard(e: ClipboardEvent, kind: 'copy' | 'cut' | 'paste'): void {
  if (!itGridFocused() || !e.clipboardData) return;
  const s = itS as ItState;
  const { r0, c0, r1, c1 } = s.sel;
  if (kind !== 'paste') {
    const a = Math.min(r0, r1);
    const b = Math.min(Math.max(r0, r1), s.rows.length - 1);
    if (b < a) return;
    const block = s.rows.slice(a, b + 1).map((row) => row.slice(Math.min(c0, c1), Math.max(c0, c1) + 1));
    e.clipboardData.setData('text/plain', OrdInputEdits.toTsv(block));
    e.preventDefault();
    if (kind === 'cut') itCommit(OrdInputEdits.clearBatch(s.rows, s.sel));
    return;
  }
  const text = e.clipboardData.getData('text/plain');
  e.preventDefault();
  const plan = OrdInputEdits.pasteBatch(text, s.sel, s.rows.length, s.columns.length, s.cap);
  if (!plan) {
    if (text && s.rows.length >= s.cap) showToast(`The table is at its ${s.cap.toLocaleString('en-US')}-row limit.`, { kind: 'error' });
    return;
  }
  const p = plan.range;
  itCommit(plan.batch, { r0: p.r1, c0: p.c1, r1: p.r0, c1: p.c0 });
  itScrollToActive();
  if (plan.clipped) {
    showToast(`${plan.clipped.toLocaleString('en-US')} pasted ${plan.clipped === 1 ? 'cell does' : 'cells do'} not fit — past the last column or the ${s.cap.toLocaleString('en-US')}-row limit.`);
  }
}
