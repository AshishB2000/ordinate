'use strict';

// Changing WHICH cells an open notebook has: the add-cell bar between cells,
// and adding, moving, duplicating and deleting a cell. Classic global-scope
// renderer <script>: no import/export. Split out of nbPage.ts (file-size.md);
// every change here edits `nbDoc.cells` and calls nbTouch(true), which saves
// and repaints the column.

/** The "+ SQL · Formula · Chart · Text · Parameter" bar between cells (always shown after the last). */
function nbAddBar(at: number, last: boolean): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'nb-add' + (last ? ' is-last' : '');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', last ? t('nbColumn.add_a_cell') : t('nbColumn.add_a_cell_at_position', { p0: at + 1 }));
  const line = document.createElement('span');
  line.className = 'nb-add-line';
  line.setAttribute('aria-hidden', 'true');
  bar.appendChild(line);
  const kinds: Array<NbCellDoc['kind']> = ['sql', 'formula', 'chart', 'markdown', 'param'];
  for (const k of kinds) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nb-add-btn';
    b.dataset.kind = k;
    b.append(icon(nbKindIcon(k), 14), Object.assign(document.createElement('span'), { textContent: nbKindLabel(k) }));
    b.title = t('nbColumn.add_a_cell_here', { p0: nbKindLabel(k).toLowerCase() });
    b.addEventListener('click', () => nbAddCell(k, at));
    bar.appendChild(b);
  }
  return bar;
}

/** The nearest SQL or formula cell above `at` — a new chart's default source. */
function nbDataCellAbove(at: number): NbCellDoc | null {
  if (!nbDoc) return null;
  for (let j = Math.min(at, nbDoc.cells.length) - 1; j >= 0; j -= 1) {
    const k = nbDoc.cells[j].kind;
    if (k === 'sql' || k === 'formula') return nbDoc.cells[j];
  }
  return null;
}

function nbNewCell(kind: NbCellDoc['kind'], at: number): NbCellDoc {
  const id = nbUuid();
  if (kind === 'sql') return { id, kind, sql: '' };
  if (kind === 'formula') return { id, kind, expression: '', column: 'value' };
  if (kind === 'markdown') return { id, kind, text: '' };
  if (kind === 'param') {
    const taken = new Set((nbDoc ? nbDoc.cells : []).filter((c) => c.kind === 'param').map((c) => String(c.name || '').toLowerCase()));
    let n = 1;
    while (taken.has(n === 1 ? 'param' : `param${n}`)) n += 1;
    return { id, kind, name: n === 1 ? 'param' : `param${n}`, type: 'number', value: null };
  }
  const src = nbDataCellAbove(at);
  return { id, kind: 'chart', sourceCellId: src ? src.id : '', chartType: 'column', encoding: { category: '', values: [] } };
}

function nbAddCell(kind: NbCellDoc['kind'], at: number): void {
  if (!nbDoc) return;
  const c = nbNewCell(kind, at);
  nbDoc.cells.splice(Math.max(0, Math.min(at, nbDoc.cells.length)), 0, c);
  if (kind === 'markdown') nbMdEditing.add(c.id);
  nbTouch(true);
  nbFocusCell(c.id, true);
}

function nbMoveCell(id: string, delta: number): void {
  if (!nbDoc) return;
  const i = nbDoc.cells.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= nbDoc.cells.length) return;
  const [c] = nbDoc.cells.splice(i, 1);
  nbDoc.cells.splice(j, 0, c);
  nbTouch(true);
  nbFocusCell(id, true);
}

function nbDuplicateCell(id: string): void {
  if (!nbDoc) return;
  const i = nbDoc.cells.findIndex((c) => c.id === id);
  if (i < 0) return;
  const copy: NbCellDoc = JSON.parse(JSON.stringify(nbDoc.cells[i]));
  copy.id = nbUuid();
  if (copy.title) copy.title += t('nbColumn.copy');
  nbDoc.cells.splice(i + 1, 0, copy);
  nbTouch(true);
  nbFocusCell(copy.id, true);
}

function nbDeleteCell(id: string): void {
  if (!nbDoc) return;
  const i = nbDoc.cells.findIndex((c) => c.id === id);
  if (i < 0) return;
  nbDoc.cells.splice(i, 1);
  nbResults.delete(id);
  nbTouch(true);
  const next = nbDoc.cells[Math.min(i, nbDoc.cells.length - 1)];
  if (next) nbFocusCell(next.id, false, true);
}

