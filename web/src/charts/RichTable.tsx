// The Table shape's table (chartFormat `richTable`, src/analysis/dashboardShapes.ts):
// the `table` chart a reader can sort, search and read with bars in its cells.
// Every cell is the server's figure as tableModel formats it; sorting orders the
// rows, searching hides some, and a bar's length is a drawing of the cell's own
// value against its column's largest — no figure is shown that the server did not send.

import { useMemo, useState } from 'react';
import { Input } from '../ui/Field';
import s from './DataTable.module.css';
import { tableModel } from './table';
import type { ChartDataShape } from './types';

type Sort = { col: number; dir: 'asc' | 'desc' } | null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function RichTable({ data, label }: { data: ChartDataShape; label?: string }) {
  const m = tableModel(data);
  const [sort, setSort] = useState<Sort>(null);
  const [query, setQuery] = useState('');
  const values = useMemo(() => (data.series ?? []).map((x) => (x.values ?? []).map(num)), [data]);
  // Each column's longest bar: the largest magnitude over EVERY row, so a search does not stretch the bars.
  const peaks = values.map((col) => Math.max(0, ...col.map((v) => (v === null ? 0 : Math.abs(v)))));
  const q = query.trim().toLowerCase();
  const order = m.rows.map((_, i) => i).filter((i) => !q || m.rows[i].label.toLowerCase().includes(q));
  if (sort) {
    const sign = sort.dir === 'asc' ? 1 : -1;
    order.sort((a, b) => {
      if (sort.col < 0) return sign * m.rows[a].label.localeCompare(m.rows[b].label, undefined, { numeric: true });
      const va = values[sort.col][a];
      const vb = values[sort.col][b];
      if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1; // no figure sorts last either way
      return sign * (va - vb);
    });
  }
  // A first click sorts figures largest first and labels A to Z; a second turns it round.
  const next = (col: number): Sort => (sort && sort.col === col ? { col, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col < 0 ? 'asc' : 'desc' });
  const head = (col: number, text: string) => (
    <th key={col} scope="col" aria-sort={sort && sort.col === col ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={s.sortBtn} onClick={() => setSort(next(col))}>
        {text}
        <span className={s.sortMark} aria-hidden="true">{sort && sort.col === col ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  );
  return (
    <div className={s.rich}>
      <Input icon="search" type="search" size="sm" placeholder={`Search ${m.rows.length} rows`} aria-label={`Search ${label || 'the table'}`} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className={s.scroll}>
        <table className={`${s.table} ${s.pinned}`} aria-label={label}>
          <thead>
            <tr>
              {head(-1, m.labelHeader)}
              {m.series.map((c, j) => head(j, c.name))}
            </tr>
          </thead>
          <tbody>
            {order.map((i) => (
              <tr key={i}>
                <th scope="row">{m.rows[i].label}</th>
                {m.rows[i].cells.map((text, j) => {
                  const v = values[j][i];
                  return (
                    <td key={j} className={s.barCell}>
                      <span className={s.cellText}>{text}</span>
                      {v !== null && peaks[j] > 0 && (
                        <span className={s.track} aria-hidden="true">
                          <span className={v < 0 ? `${s.bar} ${s.neg}` : s.bar} style={{ width: `${(Math.abs(v) / peaks[j]) * 100}%` }} />
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {order.length === 0 && <p className={s.none}>No row matches “{query.trim()}”.</p>}
      </div>
    </div>
  );
}
