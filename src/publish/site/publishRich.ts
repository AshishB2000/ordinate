'use strict';

// The published site's renderer, DOM half: the Table shape's table (chartFormat
// `richTable`, src/analysis/dashboardShapes.ts) — the canvas's RichTable.tsx in
// plain DOM. A classic script inlined after publishTiles.js. A reader sorts it,
// searches it and reads a bar in each figure's cell; every cell is the app's
// figure as the page formats it (pcFmt), sorting only orders the rows, and a
// bar is the cell's own value drawn against its column's largest.

function pcRichTable(model: { head: string[]; rows: any[][] }, label: string): HTMLElement {
  const wrap = pcEl('div', 'pub-rich');
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'pub-rich-search';
  search.placeholder = `Search ${model.rows.length} rows`;
  search.setAttribute('aria-label', 'Search ' + (label || 'the table'));
  const scroll = pcEl('div', 'pub-table-wrap');
  const table = pcEl('table', 'pub-table pub-rich-table');
  table.setAttribute('aria-label', label || 'Table');
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // The longest bar of each column: the largest magnitude over EVERY row, so a search does not stretch the bars.
  const peaks = model.head.map((_h, j) => (j === 0 ? 0 : Math.max(0, ...model.rows.map((r) => Math.abs(num(r[j]) ?? 0)))));
  let sort: { col: number; dir: 1 | -1 } | null = null;
  const heads: HTMLElement[] = [];
  const hr = pcEl('tr');
  model.head.forEach((h, j) => {
    const th = pcEl('th', j > 0 ? 'num' : '');
    th.setAttribute('scope', 'col');
    th.setAttribute('aria-sort', 'none');
    const b = pcEl('button', 'pub-sort', h || 'Label') as HTMLButtonElement;
    b.type = 'button';
    // A first click sorts figures largest first and labels A to Z; a second turns it round.
    b.addEventListener('click', () => { sort = sort && sort.col === j ? { col: j, dir: (-sort.dir) as 1 | -1 } : { col: j, dir: j === 0 ? 1 : -1 }; draw(); });
    th.appendChild(b);
    heads.push(th);
    hr.appendChild(th);
  });
  const thead = pcEl('thead');
  thead.appendChild(hr);
  const body = pcEl('tbody');
  table.append(thead, body);
  scroll.appendChild(table);
  const none = pcEl('p', 'pub-empty');
  function draw(): void {
    const q = search.value.trim().toLowerCase();
    const rows = model.rows.slice(0, 1000).filter((r) => !q || String(r[0] ?? '').toLowerCase().indexOf(q) >= 0);
    if (sort) {
      const { col, dir } = sort;
      rows.sort((a, b) => {
        if (col === 0) return dir * String(a[0] ?? '').localeCompare(String(b[0] ?? ''), undefined, { numeric: true });
        const va = num(a[col]);
        const vb = num(b[col]);
        if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1; // no figure sorts last either way
        return dir * (va - vb);
      });
    }
    heads.forEach((th, j) => th.setAttribute('aria-sort', sort && sort.col === j ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'));
    body.textContent = '';
    for (const r of rows) {
      const tr = pcEl('tr');
      r.forEach((v: any, j: number) => {
        if (j === 0) { const th = pcEl('th', '', v == null ? '' : String(v)); th.setAttribute('scope', 'row'); tr.appendChild(th); return; }
        const n = num(v);
        const td = pcEl('td', 'num pub-bar-cell', n === null ? (v == null ? '' : String(v)) : pcFmt(n));
        if (n !== null && peaks[j] > 0) {
          const track = pcEl('span', 'pub-track');
          const bar = pcEl('span', n < 0 ? 'pub-bar pub-bar--neg' : 'pub-bar');
          bar.style.width = (Math.abs(n) / peaks[j]) * 100 + '%';
          track.appendChild(bar);
          td.appendChild(track);
        }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
    none.textContent = rows.length ? '' : `No row matches “${search.value.trim()}”.`;
    none.hidden = !!rows.length;
  }
  search.addEventListener('input', draw);
  draw();
  wrap.append(search, scroll, none);
  return wrap;
}
