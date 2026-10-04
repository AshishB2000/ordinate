// The pivot — a real <table> over the server's PivotGrid (pivotRender.ts).
// Every figure, subtotal, total and the sort order are the server's; this
// file lays them out and formats them. Sorting asks the caller to fetch the
// grid again (`onSort`) — the server reorders siblings at every level — so a
// surface that cannot re-ask gets plain header labels and no collapse, as on
// the desktop.
//
// Accessibility: column heads are `<th scope="col">` (`colgroup` when merged
// over several columns), row heads `<th scope="row">`, the corner names the
// label column, and the scroller is a labelled, focusable region.
//
// Above VIRT_MIN visible rows the tbody draws a window plus spacer rows, on a
// fixed row height (ROW_H, also the CSS token), so nothing is measured.

import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../ui/icons/Icon';
import { calcKind, cellPaint, condRanges, pathKey, pivotFmt, pivotHeadRows, pivotTip, valueOf, visibleRows, type PivotGridShape, type PivotSort } from './model';
import s from './Pivot.module.css';
import { t } from './strings';

const ROW_H = 32;
const VIRT_MIN = 200;
const VIRT_PAD = 20;

export interface PivotTableProps {
  grid: PivotGridShape;
  /** The table's accessible name (the visual's title). */
  label: string;
  /** Re-ask the server with this sort. Absent → headers are labels, subtotals do not collapse. */
  onSort?: (sort: PivotSort) => void;
  /** Fill a sized parent (a dashboard card) instead of capping at the viewport. */
  fill?: boolean;
}

export function PivotTable({ grid, label, onSort, fill }: PivotTableProps) {
  const interactive = typeof onSort === 'function';
  // Collapse is view state: a new grid starts expanded (its levels may differ).
  const [view, setView] = useState<{ grid: PivotGridShape; collapsed: Set<string> }>({ grid, collapsed: new Set() });
  if (view.grid !== grid) setView({ grid, collapsed: new Set() });
  const collapsed = view.collapsed;
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setView({ grid, collapsed: next });
  };

  const head = useMemo(() => pivotHeadRows(grid), [grid]);
  const ranges = useMemo(() => condRanges(grid), [grid]);
  const rules = useMemo(() => {
    const m = new Map<number, { kind: string; threshold?: number }>();
    for (const r of grid.conditional || []) if (!m.has(r.valueIdx)) m.set(r.valueIdx, r);
    return m;
  }, [grid]);
  const visible = useMemo(() => visibleRows(grid, collapsed), [grid, collapsed]);

  const scroller = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ top: 0, h: 400 });
  const queued = useRef(false);
  const virtual = visible.length > VIRT_MIN;
  let from = 0;
  let to = visible.length;
  if (virtual) {
    from = Math.max(0, Math.floor(win.top / ROW_H) - VIRT_PAD);
    to = Math.min(visible.length, Math.ceil((win.top + win.h) / ROW_H) + VIRT_PAD);
  }
  const onScroll = virtual
    ? () => {
        if (queued.current) return;
        queued.current = true;
        requestAnimationFrame(() => {
          queued.current = false;
          const el = scroller.current;
          if (el) setWin({ top: el.scrollTop, h: el.clientHeight || 400 });
        });
      }
    : undefined;

  const sort = grid.sort;
  const totalCols = grid.rowTotals ? grid.valueCount : 0;
  const width = 1 + grid.colHeaders.length + totalCols;
  const rowTotalsOf = (r: number) => (grid.rowTotals ? grid.rowTotals[r] : null);

  return (
    <div className={[s.wrap, fill && s.fill].filter(Boolean).join(' ')} style={{ '--pivot-row-h': `${ROW_H}px` } as CSSProperties}>
      {grid.truncated && (
        <p className={s.note}>
          {t('pivotRender.showing_the_first_row_groups_and', { p0: grid.rowGroupCount.toLocaleString(), p1: grid.colGroupCount.toLocaleString() })}
        </p>
      )}
      <div ref={scroller} className={s.scroll} tabIndex={0} role="region" aria-label={label} onScroll={onScroll}>
        <table className={s.table} aria-label={label}>
          <thead>
            {head.rows.map((row, level) => (
              <tr key={level}>
                {level === 0 && (
                  <th scope="col" rowSpan={head.depth} className={s.corner}>
                    {interactive ? (
                      <SortButton
                        label=""
                        dir={sort && sort.by === 'label' ? sort.dir : null}
                        onClick={() => onSort({ by: 'label', dir: sort && sort.by === 'label' && sort.dir === 'asc' ? 'desc' : 'asc' })}
                      />
                    ) : (
                      <span className={s.srOnly}>{t('common.label')}</span>
                    )}
                  </th>
                )}
                {row.map((h) => (
                  <th key={h.col} scope={h.span > 1 ? 'colgroup' : 'col'} colSpan={h.span > 1 ? h.span : undefined}>
                    {interactive && h.leaf ? (
                      <SortButton
                        label={h.label}
                        dir={sort && sort.by === h.col ? sort.dir : null}
                        onClick={() => onSort({ by: h.col, dir: sort && sort.by === h.col && sort.dir === 'desc' ? 'asc' : 'desc' })}
                      />
                    ) : (
                      h.label
                    )}
                  </th>
                ))}
                {grid.rowTotals && level === 0 && (
                  <th
                    scope={grid.valueCount > 1 ? 'colgroup' : 'col'}
                    rowSpan={head.depth}
                    colSpan={grid.valueCount > 1 ? grid.valueCount : undefined}
                    className={s.totalHead}
                  >
                    {t('common.total')}
                  </th>
                )}
              </tr>
            ))}
          </thead>
          <tbody>
            {virtual && from > 0 && <Spacer height={from * ROW_H} width={width} />}
            {visible.slice(from, to).map((r) => {
              const path = grid.rowHeaders[r] ?? [];
              const own = path[path.length - 1] ?? '';
              const sub = grid.rowKinds[r] === 'subtotal';
              const key = pathKey(path);
              const closed = collapsed.has(key);
              const rowTotal = rowTotalsOf(r);
              return (
                <tr key={r} className={[s.row, sub && s.subtotal].filter(Boolean).join(' ')}>
                  <th scope="row" className={s.rowHead} style={{ paddingLeft: `calc(var(--sp-8) + ${path.length - 1} * var(--sp-12))` }}>
                    {sub && interactive ? (
                      <button
                        type="button"
                        className={s.collapse}
                        aria-expanded={!closed}
                        aria-label={(closed ? t('common.expand') : t('common.collapse')) + own}
                        onClick={() => toggle(key)}
                      >
                        <span className={[s.caret, closed && s.closed].filter(Boolean).join(' ')}>
                          <Icon name="chevron-down" size={12} />
                        </span>
                        {own}
                      </button>
                    ) : (
                      own
                    )}
                  </th>
                  {grid.colHeaders.map((_, c) => {
                    const vi = valueOf(grid, c);
                    const v = grid.cells[r]?.[c] ?? null;
                    const paint = sub ? {} : cellPaint(v, rules.get(vi), ranges.get(vi));
                    return (
                      <td
                        key={c}
                        className={[s.cell, paint.tone === 'above' && s.above, paint.tone === 'below' && s.below].filter(Boolean).join(' ')}
                        style={paint.background ? { background: paint.background } : undefined}
                        title={pivotTip(grid, r, c)}
                      >
                        {pivotFmt(v, grid.showAs[vi], grid.formats[vi], calcKind(grid, vi))}
                      </td>
                    );
                  })}
                  {grid.rowTotals &&
                    Array.from({ length: grid.valueCount }, (_, vi) => (
                      // A Total column shows the FIGURE: a share of itself is 100%, a rank of a total means nothing.
                      <td key={`t${vi}`} className={`${s.cell} ${s.totalCell}`}>
                        {pivotFmt(rowTotal ? rowTotal[vi] : null, 'value', grid.formats[vi])}
                      </td>
                    ))}
                </tr>
              );
            })}
            {virtual && to < visible.length && <Spacer height={(visible.length - to) * ROW_H} width={width} />}
          </tbody>
          {(grid.colTotals || grid.grand) && (
            <tfoot>
              <tr className={`${s.row} ${s.grand}`}>
                <th scope="row" className={s.rowHead}>
                  {t('common.total')}
                </th>
                {grid.colHeaders.map((_, c) => (
                  <td key={c} className={s.cell}>
                    {grid.colTotals ? pivotFmt(grid.colTotals[c], 'value', grid.formats[valueOf(grid, c)]) : ''}
                  </td>
                ))}
                {grid.rowTotals &&
                  Array.from({ length: grid.valueCount }, (_, vi) => (
                    <td key={`t${vi}`} className={`${s.cell} ${s.totalCell}`}>
                      {grid.grand ? pivotFmt(grid.grand[vi], 'value', grid.formats[vi]) : ''}
                    </td>
                  ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function SortButton({ label, dir, onClick }: { label: string; dir: 'asc' | 'desc' | null; onClick: () => void }) {
  return (
    <button
      type="button"
      className={[s.sort, dir && s.sorted].filter(Boolean).join(' ')}
      aria-label={t('pivotRender.sort_by', {
        p0: label || 'label',
        p1: dir === 'asc' ? t('pivotRender.ascending') : dir === 'desc' ? t('pivotRender.descending') : '',
      })}
      onClick={onClick}
    >
      {label}
      <span className={s.arrow} aria-hidden="true">
        {dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : ''}
      </span>
    </button>
  );
}

function Spacer({ height, width }: { height: number; width: number }) {
  return (
    <tr className={s.spacer} aria-hidden="true">
      <td colSpan={width} style={{ height }} />
    </tr>
  );
}
