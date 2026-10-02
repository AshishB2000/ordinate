'use strict';

// The composer's PREVIEW GRID, and the field mapping that lives in its header.
//
// Split out of composer.ts under the 800-line cap (.claude/rules/file-size.md).
// composer.ts owns the canvas (the chain of tables, the joins) and the save;
// this owns what the preview looks like — the column menu that renames, retypes
// and drops, and, for a screenshot capture, the editable cells that are how a
// mis-read value gets corrected before it becomes a dataset.
//
// It reads composer.ts's state (dcRawCols, dcMap, dcBase, dcPage, dcPageRows)
// and calls back into schedulePreview()/paintCount(). Classic global-scope
// <script>: no import/export. Loads AFTER composer.js.

// ── The header IS the field mapper ───────────────────────────────────────────

/** The mapping for a column, defaulted from what main returned. */
function mapFor(col: any): { name: string; type: string; dropped: boolean } {
  const key = String(col.name);
  let m = dcMap.get(key);
  if (!m) {
    m = { name: key, type: String(col.type || 'text'), dropped: false };
    dcMap.set(key, m);
  }
  return m;
}

function visibleCols(): any[] {
  return dcRawCols.filter((c) => !mapFor(c).dropped);
}

function paintGrid(rows: any[][]): void {
  const host = dcEl('dc-grid');
  if (!host) return;
  host.innerHTML = '';
  if (!dcRawCols.length) {
    const empty = document.createElement('div');
    empty.className = 'dc-grid-empty';
    empty.textContent = t('composerGrid.nothing_to_preview_yet');
    host.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'dc-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');

  dcRawCols.forEach((col) => {
    const m = mapFor(col);
    const th = document.createElement('th');
    if (m.dropped) {
      // A dropped column collapses to a stub, never to nothing: an invisible
      // drop is how a column gets lost without anyone noticing.
      th.className = 'dc-th dc-th-dropped';
      const restore = document.createElement('button');
      restore.className = 'dc-restore';
      restore.type = 'button';
      restore.textContent = '↩';
      restore.title = t('composerGrid.restore', { name: col.name });
      restore.setAttribute('aria-label', t('composerGrid.restore', { name: col.name }));
      restore.addEventListener('click', () => {
        m.dropped = false;
        paintGridFromCache();
      });
      th.appendChild(restore);
      hr.appendChild(th);
      return;
    }
    th.className = 'dc-th';
    const btn = document.createElement('button');
    btn.className = 'dc-th-btn';
    btn.type = 'button';
    const nm = document.createElement('span');
    nm.className = 'dc-th-name';
    nm.textContent = m.name;
    btn.appendChild(nm);
    if (m.name !== String(col.name)) {
      const dot = document.createElement('span');
      dot.className = 'dc-th-dot';
      dot.title = t('composerGrid.renamed_from', { name: col.name });
      dot.setAttribute('aria-label', t('composerGrid.renamed_from', { name: col.name }));
      btn.appendChild(dot);
    }
    const ty = document.createElement('span');
    ty.className = 'dc-th-type';
    ty.textContent = m.type;
    btn.appendChild(ty);
    const caret = document.createElement('span');
    caret.className = 'dc-th-caret';
    setIcon(caret, 'chevron-down');
    btn.appendChild(caret);
    btn.addEventListener('click', (e) => { e.stopPropagation(); openColPop(String(col.name), th); });
    th.appendChild(btn);
    const chip = pvComposerChip(String(col.name)); // "Personal?" — privacyReview.ts
    if (chip) th.appendChild(chip);
    hr.appendChild(th);
  });

  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  // Only a bare capture base is cell-editable — see dcCellEdit. Once a join is
  // on the canvas a preview cell is the output of a fold, not a source cell.
  const editable = dcCellEdit && dcLinks.length === 0;
  rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    dcRawCols.forEach((col, c) => {
      const td = document.createElement('td');
      if (mapFor(col).dropped) { td.className = 'dc-td-dropped'; tr.appendChild(td); return; }
      const value = row[c] == null ? '' : String(row[c]);
      if (!editable) { td.textContent = value; tr.appendChild(td); return; }
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'dc-cell';
      input.value = value;
      input.setAttribute('aria-label', t('composerGrid.row', { p0: mapFor(col).name, p1: dcPage * dcPageRows + r + 1 }));
      input.addEventListener('change', () => dcEditCell(r, c, input.value));
      td.appendChild(input);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  host.appendChild(table);
  dcLastRows = rows;
}

/**
 * Write one corrected cell back into the inline base, then re-preview.
 *
 * The edit lands on the SOURCE rows the renderer holds — the same array the
 * save re-sends — so main coerces and types the corrected value exactly as it
 * would an original one. Nothing is computed here. `r` is the row's index on
 * the current page, which maps straight onto the source only because editing
 * is confined to a join-free canvas.
 */
function dcEditCell(r: number, c: number, value: string): void {
  const inline = dcBase && (dcBase.ref.inline as any);
  if (!inline || !Array.isArray(inline.rows)) return;
  const row = inline.rows[dcPage * dcPageRows + r];
  if (!Array.isArray(row)) return;
  row[c] = value;
  schedulePreview(0);
}

let dcLastRows: any[][] = [];
/** Repaint from the rows already on screen — a mapping edit changes no data. */
function paintGridFromCache(): void {
  paintGrid(dcLastRows);
  paintCount();
}

function openColPop(colName: string, anchor: HTMLElement): void {
  const pop = dcEl('dc-col-pop');
  const col = dcRawCols.find((c) => String(c.name) === colName);
  if (!pop || !col) return;
  dcOpenCol = colName;
  const m = mapFor(col);

  const name = dcEl('dc-col-name') as HTMLInputElement | null;
  const type = dcEl('dc-col-type') as HTMLSelectElement | null;
  if (name) {
    name.value = m.name;
    name.oninput = () => { m.name = name.value; };
    name.onchange = () => { m.name = name.value.trim() || colName; paintGridFromCache(); };
  }
  if (type) {
    type.value = m.type;
    type.onchange = () => { m.type = type.value; paintGridFromCache(); };
  }
  const drop = dcEl('dc-col-drop');
  if (drop) {
    drop.onclick = () => {
      m.dropped = true;
      closeColPop();
      paintGridFromCache();
    };
  }

  pop.hidden = false;
  const b = anchor.getBoundingClientRect();
  let left = b.left;
  if (left + pop.offsetWidth > window.innerWidth - 12) left = window.innerWidth - 12 - pop.offsetWidth;
  if (left < 12) left = 12;
  pop.style.left = left + 'px';
  pop.style.top = (b.bottom + 6) + 'px';
  if (name) name.focus();
  document.addEventListener('click', dcColDismiss, true);
  document.addEventListener('keydown', dcPopEsc, true);
}

function dcColDismiss(e: MouseEvent): void {
  const pop = dcEl('dc-col-pop');
  const t = e.target as Node;
  if (!pop || pop.contains(t)) return;
  closeColPop();
}

function closeColPop(): void {
  const pop = dcEl('dc-col-pop');
  if (pop) pop.hidden = true;
  dcOpenCol = '';
  document.removeEventListener('click', dcColDismiss, true);
  document.removeEventListener('keydown', dcPopEsc, true);
}

/**
 * The mapping, as REAL prepare steps — so the saved dataset opens in the
 * explorer with its pipeline visible and every mapping reversible, exactly like
 * a step added later. Renames go first: a drop names the column, and after a
 * rename that name is the new one.
 */
