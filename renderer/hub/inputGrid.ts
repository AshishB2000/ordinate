'use strict';

// The INPUT TABLE GRID — drawing, virtual scrolling, selection and the mouse.
// Classic global-scope renderer <script>: no import/export. State and saving
// are inputPage.ts; the keyboard, the cell editor and the clipboard are
// inputKeys.ts.
//
// A real <table role="grid">: a sticky header naming each column with its type
// (and whether it is required or a lookup), a sticky column of row numbers, and
// one trailing NEW-ROW line — typing or pasting there appends. Only the rows in
// view (plus IT_PAD either side) exist in the DOM; spacer rows hold the scroll
// height, so 10,000 rows scroll like ten. The row height is fixed (--it-row-h
// in input.css, IT_ROW_H here — one number, two spellings, kept equal).
//
// The ACTIVE cell is the one keys act on (outlined); the SELECTION is the
// rectangle from the anchor to it (tinted). Flagged cells carry a corner mark
// and the reason as their tooltip; the reasons are main's.

const IT_ROW_H = 30;
const IT_PAD = 24;
let itFrame = 0;
let itDragging = false;

function itTypeIcon(type: string): string {
  return type === 'number' ? 'type-number' : type === 'date' ? 'type-date' : 'type-text';
}

function itColWidth(col: any): number {
  if (col.lookup) return 190;
  return col.type === 'number' ? 130 : col.type === 'date' ? 140 : 190;
}

/** A cell as shown. Numbers get grouping; what was typed and refused shows as typed. */
function itDisplay(v: ItCell, col: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return col.type === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 10 }) : String(v);
  return String(v);
}

/** The last row the active cell may be on: the new-row line, when there is room for one. */
function itMaxRow(): number {
  const s = itS;
  if (!s) return 0;
  return s.rows.length < s.cap ? s.rows.length : Math.max(0, s.rows.length - 1);
}

function itInSel(r: number, c: number): boolean {
  const s = itS as ItState;
  const { r0, c0, r1, c1 } = s.sel;
  return r >= Math.min(r0, r1) && r <= Math.max(r0, r1) && c >= Math.min(c0, c1) && c <= Math.max(c0, c1);
}

function itHead(s: ItState): HTMLTableSectionElement {
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  tr.setAttribute('role', 'row');
  tr.setAttribute('aria-rowindex', '1');
  const corner = itMk('th', 'it-rn it-corner');
  corner.setAttribute('role', 'columnheader');
  corner.setAttribute('aria-label', 'Row number');
  tr.appendChild(corner);
  s.columns.forEach((col, c) => {
    const th = itMk('th', 'it-th');
    th.setAttribute('role', 'columnheader');
    th.setAttribute('aria-colindex', String(c + 2));
    th.dataset.c = String(c);
    const type = itMk('span', 'it-th-type it-th-type--' + col.type);
    type.appendChild(icon(itTypeIcon(col.type), 14));
    type.title = col.type === 'number' ? 'Number' : col.type === 'date' ? 'Date' : 'Text';
    const name = itMk('span', 'it-th-name', col.name);
    th.append(type, name);
    const bits: string[] = [col.type];
    if (col.required) {
      const req = itMk('span', 'it-th-req', 'Required');
      th.appendChild(req);
      bits.push('required');
    }
    if (col.lookup) {
      const where = `${s.lookupNames[col.lookup.datasetId] || 'another dataset'} · ${col.lookup.column}`;
      const lk = itMk('span', 'it-th-lookup');
      lk.appendChild(icon('link', 12));
      lk.title = 'Looks up ' + where;
      th.appendChild(lk);
      bits.push('looks up ' + where);
    }
    th.setAttribute('aria-label', `${col.name}, ${bits.join(', ')}`);
    th.title = 'Select column';
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  return thead;
}

function itSpacer(h: number, width: number): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'it-vspacer';
  tr.setAttribute('aria-hidden', 'true');
  const td = document.createElement('td');
  td.colSpan = width + 1;
  td.style.height = h + 'px';
  tr.appendChild(td);
  return tr;
}

function itRowEl(s: ItState, r: number, ghost: boolean): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = ghost ? 'it-tr it-ghost' : 'it-tr';
  tr.setAttribute('role', 'row');
  tr.setAttribute('aria-rowindex', String(r + 2));
  const rn = itMk('th', 'it-rn');
  rn.setAttribute('role', 'rowheader');
  rn.dataset.r = String(r);
  if (ghost) {
    rn.appendChild(icon('plus', 12));
    rn.setAttribute('aria-label', 'New row');
  } else {
    rn.textContent = String(r + 1);
  }
  const { r0, r1 } = s.sel;
  if (r >= Math.min(r0, r1) && r <= Math.max(r0, r1)) rn.classList.add('is-sel');
  tr.appendChild(rn);
  const row = ghost ? null : s.rows[r];
  s.columns.forEach((col, c) => {
    const td = itMk('td', 'it-td');
    td.id = `it-c-${r}-${c}`;
    td.setAttribute('role', 'gridcell');
    td.setAttribute('aria-colindex', String(c + 2));
    td.dataset.r = String(r);
    td.dataset.c = String(c);
    if (col.type === 'number') td.classList.add('is-num');
    const v = row ? row[c] : null;
    td.textContent = itDisplay(v, col);
    if (ghost && c === 0) {
      const hint = itMk('span', 'it-ghost-hint', s.rows.length ? 'New row' : 'Type to add the first row');
      td.appendChild(hint);
    }
    const sel = itInSel(r, c);
    if (sel) td.classList.add('is-sel');
    td.setAttribute('aria-selected', sel ? 'true' : 'false');
    if (r === s.sel.r1 && c === s.sel.c1) {
      td.classList.add('is-active');
      if (col.lookup) {
        const chev = itMk('span', 'it-chev');
        chev.appendChild(icon('chevron-down', 12));
        td.appendChild(chev);
      }
    }
    const found = s.issues.get(r + ':' + c);
    if (found && found.length) {
      const fail = found.some((i: any) => i.severity === 'fail');
      td.classList.add(fail ? 'is-bad' : 'is-warn');
      td.setAttribute('aria-invalid', 'true');
      td.title = found.map((i: any) => itIssueWords(i)).join('\n');
    }
    tr.appendChild(td);
  });
  return tr;
}

/** A finding in words — a quality rule in the Rules tab's own words. */
function itIssueWords(i: any): string {
  if (i.kind === 'rule' && itS) {
    const rule = itS.rules.find((r: any) => r && r.id === i.ruleId);
    if (rule && typeof dqRuleWords === 'function') return 'Rule: ' + dqRuleWords(rule, new Map(Object.entries(itS.lookupNames)));
  }
  return String(i.message || '');
}

/** Draw the header and the rows in view. Cheap enough to call on every change. */
function itRender(): void {
  const s = itS;
  const table = itEl<HTMLTableElement>('it-grid');
  const scroll = itEl('it-scroll');
  if (!s || !table || !scroll) return;
  const width = s.columns.length;
  const ghost = s.rows.length < s.cap;
  const total = s.rows.length + (ghost ? 1 : 0);
  table.setAttribute('aria-rowcount', String(total + 1));
  table.setAttribute('aria-colcount', String(width + 1));

  const top = scroll.scrollTop;
  const h = scroll.clientHeight || 480;
  const first = Math.max(0, Math.floor(top / IT_ROW_H) - IT_PAD);
  const last = Math.min(total - 1, Math.ceil((top + h) / IT_ROW_H) + IT_PAD);

  table.textContent = '';
  const cg = document.createElement('colgroup');
  const rnCol = document.createElement('col');
  rnCol.className = 'it-col-rn';
  cg.appendChild(rnCol);
  let w = 56;
  for (const col of s.columns) {
    const el = document.createElement('col');
    const px = itColWidth(col);
    el.style.width = px + 'px';
    w += px;
    cg.appendChild(el);
  }
  table.style.width = w + 'px';
  table.appendChild(cg);
  table.appendChild(itHead(s));
  const body = document.createElement('tbody');
  if (first > 0) body.appendChild(itSpacer(first * IT_ROW_H, width));
  for (let r = first; r <= last; r++) body.appendChild(itRowEl(s, r, r === s.rows.length));
  if (last < total - 1) body.appendChild(itSpacer((total - 1 - last) * IT_ROW_H, width));
  table.appendChild(body);

  const active = document.getElementById(`it-c-${s.sel.r1}-${s.sel.c1}`);
  if (active) table.setAttribute('aria-activedescendant', active.id);
  else table.removeAttribute('aria-activedescendant');
  itPositionEditor();
}

function itFocusGrid(): void {
  const t = itEl('it-grid');
  if (t && document.activeElement !== t) t.focus({ preventScroll: true });
}

/** Bring the active cell into view — rows by arithmetic, columns by the drawn cell. */
function itScrollToActive(): void {
  const s = itS;
  const scroll = itEl('it-scroll');
  if (!s || !scroll) return;
  const head = 34;
  const y = s.sel.r1 * IT_ROW_H;
  if (y < scroll.scrollTop) scroll.scrollTop = y;
  else if (y + IT_ROW_H + head > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = y + IT_ROW_H + head - scroll.clientHeight;
  itRender();
  const td = document.getElementById(`it-c-${s.sel.r1}-${s.sel.c1}`);
  if (!td) return;
  const left = td.offsetLeft - 56;
  if (left < scroll.scrollLeft) scroll.scrollLeft = Math.max(0, left);
  else if (td.offsetLeft + td.offsetWidth > scroll.scrollLeft + scroll.clientWidth) {
    scroll.scrollLeft = td.offsetLeft + td.offsetWidth - scroll.clientWidth;
  }
}

/** Move the active cell; with `extend`, grow the selection instead. */
function itMove(dr: number, dc: number, extend: boolean): void {
  const s = itS;
  if (!s || !s.columns.length) return;
  const r = Math.max(0, Math.min(itMaxRow(), s.sel.r1 + dr));
  const c = Math.max(0, Math.min(s.columns.length - 1, s.sel.c1 + dc));
  s.sel = extend ? { r0: s.sel.r0, c0: s.sel.c0, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c };
  itScrollToActive();
  itPaintBar();
}

/** Tab / Shift+Tab: across, wrapping onto the next or previous row. */
function itTab(back: boolean): void {
  const s = itS;
  if (!s) return;
  const w = s.columns.length;
  let r = s.sel.r1;
  let c = s.sel.c1 + (back ? -1 : 1);
  if (c >= w) { c = 0; r = Math.min(itMaxRow(), r + 1); }
  if (c < 0) { c = w - 1; r = Math.max(0, r - 1); }
  s.sel = { r0: r, c0: c, r1: r, c1: c };
  itScrollToActive();
  itPaintBar();
}

function itSelectAll(): void {
  const s = itS;
  if (!s || !s.rows.length) return;
  s.sel = { r0: s.rows.length - 1, c0: s.columns.length - 1, r1: 0, c1: 0 };
  itRender();
  itPaintBar();
}

function itWireGrid(table: HTMLTableElement, scroll: HTMLElement): void {
  scroll.addEventListener('scroll', () => {
    if (itFrame) return;
    itFrame = requestAnimationFrame(() => { itFrame = 0; itRender(); itLookupPlace(); });
  });
  table.addEventListener('mousedown', (e: MouseEvent) => {
    const s = itS;
    if (!s || e.button !== 0) return;
    const t = e.target as HTMLElement;
    const td = t.closest('td.it-td') as HTMLElement | null;
    const rn = t.closest('th.it-rn[data-r]') as HTMLElement | null;
    const th = t.closest('th.it-th') as HTMLElement | null;
    const last = s.columns.length - 1;
    if (s.edit) itCommitEdit();
    if (td) {
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      s.sel = e.shiftKey ? { r0: s.sel.r0, c0: s.sel.c0, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c };
      itDragging = true;
      if (!e.shiftKey && t.closest('.it-chev')) { itFocusGrid(); itBeginEdit('keep'); e.preventDefault(); return; }
    } else if (rn) {
      const r = Number(rn.dataset.r);
      s.sel = { r0: e.shiftKey ? s.sel.r0 : r, c0: last, r1: r, c1: 0 };
    } else if (th) {
      const c = Number(th.dataset.c);
      s.sel = { r0: Math.max(0, s.rows.length - 1), c0: c, r1: 0, c1: c };
    } else {
      return;
    }
    e.preventDefault(); // no text selection; the grid takes focus itself
    itFocusGrid();
    itRender();
    itPaintBar();
  });
  table.addEventListener('mouseover', (e: MouseEvent) => {
    const s = itS;
    if (!s || !itDragging) return;
    const td = (e.target as HTMLElement).closest('td.it-td') as HTMLElement | null;
    if (!td) return;
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    if (r === s.sel.r1 && c === s.sel.c1) return;
    s.sel = { r0: s.sel.r0, c0: s.sel.c0, r1: r, c1: c };
    itRender();
    itPaintBar();
  });
  document.addEventListener('mouseup', () => { itDragging = false; });
  table.addEventListener('dblclick', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('td.it-td')) itBeginEdit('keep');
  });
}
