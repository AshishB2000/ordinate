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

/** A cell the server flagged: `bad` fails a check, `warn` is a warning; `text` says why. */
export interface CellFlag {
  tone: 'bad' | 'warn';
  text: string;
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
  onActivate,
}: {
  grid: string;
  col: VirtualItem;
  column: GridColumn;
  active: boolean;
  onResize: (index: number, width: number) => void;
  /** A header with a menu: a click opens it (the resize handle excepted). */
  onActivate?: (index: number, anchor: HTMLElement) => void;
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
      className={[s.th, active && s.active, onActivate && s.thMenu].filter(Boolean).join(' ')}
      style={{ transform: `translateX(${col.start}px)`, width: col.size }}
      data-row={-1}
      data-col={col.index}
      aria-haspopup={onActivate ? 'dialog' : undefined}
      onClick={onActivate ? (e) => onActivate(col.index, e.currentTarget) : undefined}
    >
      <span className={s.thName} title={column.name}>
        {column.name}
      </span>
      <TypeBadge type={column.type} />
      {onActivate && <Icon name="chevron-down" size={12} />}
      <span
        className={s.resize}
        onClick={(e) => e.stopPropagation()}
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
  /** Columns of a multi-cell selection on this row (-1 when the row is outside it). */
  selFrom?: number;
  selTo?: number;
  flag?: (row: number, col: number) => CellFlag | undefined;
  /** The editor's <datalist> id, while this row's cell is being edited. */
  list?: string;
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
        const inSel = p.selFrom !== undefined && p.selFrom >= 0 && c.index >= p.selFrom && c.index <= (p.selTo ?? -1);
        const flag = p.cells ? p.flag?.(p.index, c.index) : undefined;
        return (
          <div
            key={c.key}
            role="gridcell"
            id={cellId(p.grid, p.index, c.index)}
            aria-colindex={c.index + 1}
            aria-selected={inSel || undefined}
            aria-invalid={flag ? true : undefined}
            title={flag?.text}
            className={[s.td, num && s.num, inSel && s.inSel, active && s.active, flag && (flag.tone === 'bad' ? s.bad : s.warn)].filter(Boolean).join(' ')}
            style={{ transform: `translateX(${c.start}px)`, width: c.size }}
            data-row={p.index}
            data-col={c.index}
          >
            {active && p.editing !== null ? (
              <input
                className={s.editor}
                aria-label={`Edit ${p.columns[c.index]?.name ?? ''}, row ${p.index + 1}`}
                value={p.editing}
                list={p.list}
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
