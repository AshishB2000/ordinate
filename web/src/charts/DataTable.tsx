// The `table` chart id: the {labels, series} reply as a <table> (hub.css
// .cv-data-table), from tableModel. Display only — every cell is formatted
// text, nothing is computed here.

import s from './DataTable.module.css';
import { tableModel } from './table';
import type { ChartDataShape } from './types';

const SWATCH = [s.c1, s.c2, s.c3, s.c4, s.c5, s.c6, s.c7, s.c8];

export function DataTable({ data, label, labelHeader, pinLabels }: {
  data: ChartDataShape;
  label?: string;
  /** The first column's header — the column the labels come from — instead of "Label". */
  labelHeader?: string;
  /** Keep the row labels and the header in view while the table scrolls (the phone does this by itself). */
  pinLabels?: boolean;
}) {
  const m = tableModel(data);
  return (
    <div className={s.scroll}>
      <table className={pinLabels ? `${s.table} ${s.pinned}` : s.table} aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{labelHeader || m.labelHeader}</th>
            {m.series.map((c, i) => (
              <th key={i} scope="col">
                <span className={`${s.swatch} ${SWATCH[c.slot]}`} aria-hidden="true" />
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.rows.map((r, i) => (
            <tr key={i}>
              <th scope="row">{r.label}</th>
              {r.cells.map((v, j) => (
                <td key={j}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
