// The DataGrid's pieces: the type badge, a header cell (with its resize
// handle), a body row and the cell editor. DataGrid.tsx owns the state and
// the scrolling; these only draw what they are handed.

import { memo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { VirtualItem } from '@tanstack/react-virtual';
import { formatNumber } from '../../../../src/app/format.ts';
import { Icon } from '../icons/Icon';
import type { Cell } from './pageCache';
import s from './DataGrid.module.css';

/** Ordinate's column types (src/data/parse.ts `ColumnType`). */
export type ColumnType = 'text' | 'number' | 'date';

export interface GridColumn {
  name: string;
  type: ColumnType;
}

const TYPE_WORD: Record<ColumnType, string> = { text: 'Text', number: 'Number', date: 'Date' };

/** The column's type as an icon and a word, so it never rests on colour alone. */
export function TypeBadge({ type }: { type: ColumnType }) {
  return (
    <span className={`${s.type} ${s[type]}`} title={`${TYPE_WORD[type]} column`}>
      <Icon name={`type-${type}`} size={12} />
      <span className={s.typeWord}>{type === 'number' ? '123' : type === 'date' ? 'Date' : 'Abc'}</span>
      <span className={s.sr}>, {TYPE_WORD[type]}</span>
    </span>
  );
}

/**
 * A cell as shown. A number reads grouped in the workspace's marks without
 * float noise (1565150.4600000004 → 1,565,150.46) — display only, the value
 * is the server's (legacy dsVirtual.ts, same 4 decimals).
 */
export function display(v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? formatNumber(v, { maxDecimals: 4 }) : String(v);
  return v;
}

export function cellId(grid: string, row: number, col: number): string {
  return row < 0 ? `${grid}-h${col}` : `${grid}-r${row}c${col}`;
}

export function HeaderCell({
  grid,
  col,
  column,
  active,
  onResize,
}: {
  grid: string;
  col: VirtualItem;
  column: GridColumn;
  active: boolean;
  onResize: (index: number, width: number) => void;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const down = (e: PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: col.size };
  };
  const moveTo = (e: PointerEvent<HTMLSpanElement>) => {
    if (drag.current) onResize(col.index, drag.current.w + e.clientX - drag.current.x);
  };
  const up = () => {
    drag.current = null;
  };
  return (
    <div
      role="columnheader"
      id={cellId(grid, -1, col.index)}
      aria-colindex={col.index + 1}
      aria-description="Shift+Left or Shift+Right resizes the column"
      className={active ? `${s.th} ${s.active}` : s.th}
      style={{ transform: `translateX(${col.start}px)`, width: col.size }}
      data-row={-1}
      data-col={col.index}
    >
      <span className={s.thName} title={column.name}>
        {column.name}
      </span>
      <TypeBadge type={column.type} />
      <span
        className={s.resize}
        aria-hidden="true"
        onPointerDown={down}
        onPointerMove={moveTo}
        onPointerUp={up}
        onPointerCancel={up}
      />
    </div>
  );
}

export interface RowProps {
  grid: string;
  index: number;
  start: number;
  cells: Cell[] | undefined;
  /** No block, and none coming: the block failed (the grid offers a retry). */
  failed: boolean;
  cols: VirtualItem[];
  columns: readonly GridColumn[];
  /** The active column when the active cell is on this row, else -1. */
  activeCol: number;
  /** The editor's text when this row's active cell is being edited. */
  editing: string | null;
  onEditKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  onEditChange: (value: string) => void;
  onEditBlur: () => void;
}

export const Row = memo(function Row(p: RowProps) {
  const loading = !p.cells && !p.failed;
  return (
    <div
      role="row"
      aria-rowindex={p.index + 2}
      className={loading ? `${s.tr} ${s.loading}` : s.tr}
      style={{ transform: `translateY(${p.start}px)` }}
    >
      {p.cols.map((c) => {
        const v = p.cells?.[c.index];
        const num = typeof v === 'number' || (p.columns[c.index]?.type === 'number' && v != null);
        const active = c.index === p.activeCol;
        return (
          <div
            key={c.key}
            role="gridcell"
            id={cellId(p.grid, p.index, c.index)}
            aria-colindex={c.index + 1}
            className={[s.td, num && s.num, active && s.active].filter(Boolean).join(' ')}
            style={{ transform: `translateX(${c.start}px)`, width: c.size }}
            data-row={p.index}
            data-col={c.index}
          >
            {active && p.editing !== null ? (
              <input
                className={s.editor}
                aria-label={`Edit ${p.columns[c.index]?.name ?? ''}, row ${p.index + 1}`}
                value={p.editing}
                autoFocus
                onChange={(e) => p.onEditChange(e.target.value)}
                onKeyDown={p.onEditKey}
                onBlur={p.onEditBlur}
              />
            ) : loading ? (
              <span className={s.sk} aria-hidden="true" />
            ) : (
              display(v)
            )}
          </div>
        );
      })}
    </div>
  );
});
