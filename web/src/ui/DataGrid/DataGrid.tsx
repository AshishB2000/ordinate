// DataGrid — the one table for rows of data (legacy dsGrid + dsVirtual for
// reading, composerGrid / inputGrid for the editable mode).
//
// Rows AND columns are virtualized (@tanstack/react-virtual): the DOM holds
// about one screen of cells whatever the size of the table. Rows come from the
// server in blocks of 500 as the viewport reaches them (./pageCache.ts), so a
// million-row dataset scrolls like a hundred-row one and the browser never
// holds the table. Past MAX_SCROLL_PX the scroll space compresses
// (./geometry.ts) so the last row stays reachable.
//
// Keyboard: the grid is ONE tab stop; the active cell is
// aria-activedescendant. Arrows, Home/End (row), Ctrl/Cmd+Home/End (table),
// Ctrl/Cmd+Arrows (edges), PageUp/PageDown. ArrowUp from the first row
// reaches the header, where Shift+Left/Right resizes the column. Tab leaves.
//
// `editable` (capture drafts and input tables only) adds F2 / Enter / typing /
// double-click to edit; Enter or Tab commits, Escape cancels. An edit is
// REPORTED through `onEdit` and never applied here: the cell keeps showing the
// server's value until the caller hands the grid a new `source`.
//
// Optional, for the editors built on it (T2.4): a controlled `selection`
// (Shift+arrows / Shift+click grow a range from the anchor — input tables
// fill, clear, copy and delete rows over it), `cellFlag` (a cell the server
// flagged, with the reason as its tooltip), `onHeaderActivate` (a header
// that opens a menu — the composer's field mapper) and `editorList` (a
// <datalist> the editor suggests from — an input table's lookup values).

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { elementScroll, observeElementOffset, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { Button } from '../Button';
import { EmptyState, ErrorState } from '../States';
import { MAX_SCROLL_PX, move, scrollRatio, scrollTopFor, type Pos } from './geometry';
import { cellId, HeaderCell, Row, type CellFlag, type GridColumn } from './GridParts';
import { PAGE_ROWS, PageCache, type Cell, type FetchPage } from './pageCache';
import s from './DataGrid.module.css';

export type { CellFlag, GridColumn };

/** A rectangle of cells: r0/c0 the anchor, r1/c1 the active cell (the one keys act on). */
export interface GridRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface CellEdit {
  /** Row index in the source's order (0-based). */
  row: number;
  column: number;
  /** What was typed — the caller (and the server) coerce it. */
  value: string;
}

export interface DataGridProps {
  columns: readonly GridColumn[];
  /** Fetches one window of rows. A NEW function is a new query: memoize it. */
  source: FetchPage;
  /** The grid's accessible name. */
  label: string;
  editable?: boolean;
  onEdit?: (edit: CellEdit) => void;
  /** Shown when the source has no rows. */
  emptyTitle?: string;
  emptyBody?: string;
  /** Controlled selection; without it the grid keeps its own single active cell. */
  selection?: GridRange;
  onSelectionChange?: (selection: GridRange) => void;
  /** A flag the server put on a cell, or undefined. Keep the function stable (memoize it). */
  cellFlag?: (row: number, col: number) => CellFlag | undefined;
  /** Makes each header a button: click or Enter on it calls this with the header element. */
  onHeaderActivate?: (col: number, anchor: HTMLElement) => void;
  /** The id of a <datalist> the cell editor suggests from, for a column. */
  editorList?: (col: number) => string | undefined;
}

/** One row's height — fixed, so positions are arithmetic (legacy --ds-row-h). */
export const ROW_H = 28;
export const HEAD_H = 34;
const MIN_W = 64;
const MAX_W = 800;
const STEP_W = 16;
const SKELETON_ROWS = 16;
const rowSize = () => ROW_H;

/**
 * The scroll box's CLIENT size — inside the border and the scrollbars, the
 * box the browser actually scrolls. The library's default (border-box) is a
 * few px larger, and in the compressed space a few px of viewport is tens of
 * rows of error by the millionth row.
 */
function observeClientRect(inst: Virtualizer<HTMLDivElement, Element>, cb: (rect: { width: number; height: number }) => void) {
  const el = inst.scrollElement;
  if (!el) return;
  const report = () => cb({ width: el.clientWidth, height: el.clientHeight });
  report();
  if (typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(report);
  ro.observe(el);
  return () => ro.disconnect();
}
const defaultWidth = (c: GridColumn): number => (c.type === 'number' ? 130 : c.type === 'date' ? 140 : 190);
interface Editing {
  pos: Pos;
  value: string;
}

const cellText = (v: Cell | undefined) => (v === null || v === undefined ? '' : String(v));

const ORIGIN: GridRange = { r0: 0, c0: 0, r1: 0, c1: 0 };

export function DataGrid({
  columns,
  source,
  label,
  editable = false,
  onEdit,
  emptyTitle,
  emptyBody,
  selection,
  onSelectionChange,
  cellFlag,
  onHeaderActivate,
  editorList,
}: DataGridProps) {
  const grid = useId();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // A new source starts from the last known row count, so re-sourcing after an
  // edit keeps the scroll position (the visible rows reload in place).
  const lastTotal = useRef<number | null>(null);
  const cache = useMemo(() => new PageCache(source, rerender, lastTotal.current), [source]);
  lastTotal.current = cache.total;
  useEffect(() => () => cache.dispose(), [cache]);

  const [sized, setSized] = useState({ columns, widths: columns.map(defaultWidth) });
  const widths = sized.columns === columns ? sized.widths : columns.map(defaultWidth);
  if (sized.columns !== columns) setSized({ columns, widths });
  const [ownSel, setOwnSel] = useState<GridRange>(ORIGIN);
  const sel = selection ?? ownSel;
  const rawActive: Pos = { row: sel.r1, col: sel.c1 };
  /** Moves the active cell; `extend` keeps the anchor (a range). */
  const setActive = (p: Pos, extend = false) => {
    const next = extend ? { r0: sel.r0, c0: sel.c0, r1: p.row, c1: p.col } : { r0: p.row, c0: p.col, r1: p.row, c1: p.col };
    if (!selection) setOwnSel(next);
    onSelectionChange?.(next);
  };
  const [editing, setEditingState] = useState<Editing | null>(null);
  // Mirrors `editing` synchronously: Escape focuses the grid, which blurs the
  // editor before React re-renders — the blur must see the edit already closed.
  const editRef = useRef<Editing | null>(null);
  const setEditing = useCallback((e: Editing | null) => {
    editRef.current = e;
    setEditingState(e);
  }, []);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // State as well as a ref: the scroll listener below re-binds when the
  // element appears (after the skeleton) or is replaced.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const bindScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const ratio = useRef(1);
  const total = cache.total ?? 0;
  // Until the first block says how many rows there are, the grid draws its
  // real header over SKELETON_ROWS loading rows — the shape that is coming.
  const loadingFirst = cache.total === null;
  // Inside the table even after a new source shrank it.
  const active: Pos = {
    row: loadingFirst ? rawActive.row : Math.min(rawActive.row, total - 1),
    col: Math.min(rawActive.col, Math.max(0, columns.length - 1)),
  };

  const rows = useVirtualizer({
    count: loadingFirst ? SKELETON_ROWS : total,
    getScrollElement: () => scrollRef.current,
    observeElementRect: observeClientRect,
    estimateSize: rowSize,
    paddingStart: HEAD_H,
    overscan: 12,
    // The virtualizer works in the full-size ("virtual") space; the browser
    // scrolls the compressed one. These two are the only crossings.
    observeElementOffset: (inst, cb) => observeElementOffset(inst, (off, busy) => cb(off * ratio.current, busy)),
    scrollToFn: (off, opts, inst) => elementScroll(off / ratio.current, opts, inst),
  });
  const cols = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    observeElementRect: observeClientRect,
    estimateSize: (i) => widths[i] ?? MIN_W,
    overscan: 2,
  });
  useLayoutEffect(() => cols.measure(), [cols, widths]);

  const viewport = rows.scrollRect?.height ?? 0;
  ratio.current = scrollRatio(rows.getTotalSize(), viewport);

  // The body sits at item.start in the virtual space; shifting it by
  // (real − virtual) offset on EVERY scroll event — not only when the range
  // changes, which is when React re-renders — keeps compressed rows still.
  const place = useCallback(() => {
    const el = scrollRef.current;
    if (el && bodyRef.current) bodyRef.current.style.transform = `translateY(${el.scrollTop * (1 - ratio.current)}px)`;
  }, []);
  useLayoutEffect(place);
  useEffect(() => {
    scrollEl?.addEventListener('scroll', place, { passive: true });
    return () => scrollEl?.removeEventListener('scroll', place);
  }, [scrollEl, place]);

  const items = rows.getVirtualItems();
  const colItems = cols.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;
  useEffect(() => cache.want(first, last), [cache, first, last]);

  const resize = useCallback((index: number, w: number) => {
    setSized((cur) => {
      const next = cur.widths.slice();
      next[index] = Math.round(Math.max(MIN_W, Math.min(MAX_W, w)));
      return { columns: cur.columns, widths: next };
    });
  }, []);

  /** Scrolls the cell at `p` into view (rows through the compressed space). */
  const reveal = (p: Pos) => {
    const el = scrollRef.current;
    if (!el) return;
    if (p.row >= 0) {
      const top = scrollTopFor(HEAD_H + p.row * ROW_H, ROW_H, el.scrollTop * ratio.current, el.clientHeight, HEAD_H, ratio.current);
      if (top !== null) el.scrollTop = top;
    }
    const c = cols.measurementsCache[p.col];
    if (c && c.start < el.scrollLeft) el.scrollLeft = c.start;
    else if (c && c.end > el.scrollLeft + el.clientWidth) el.scrollLeft = c.end - el.clientWidth;
  };

  const go = (p: Pos, extend = false) => {
    setActive(p, extend);
    reveal(p);
  };
  // A selection the caller moved (next flagged cell, a new row) comes into view.
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => {
    if (selection) revealRef.current({ row: selection.r1, col: selection.c1 });
  }, [selection]);

  const beginEdit = (p: Pos, value?: string) => {
    if (!editable || p.row < 0 || !cache.has(p.row)) return;
    setActive(p);
    setEditing({ pos: p, value: value ?? cellText(cache.row(p.row)?.[p.col]) });
  };

  const endEdit = (commit: boolean, then?: Pos) => {
    const e = editRef.current;
    if (!e) return;
    setEditing(null);
    if (commit && e.value !== cellText(cache.row(e.pos.row)?.[e.pos.col])) onEdit?.({ row: e.pos.row, column: e.pos.col, value: e.value });
    scrollRef.current?.focus({ preventScroll: true });
    if (then) go(then);
  };

  const onEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const p = editRef.current?.pos;
    if (!p) return;
    if (e.key === 'Escape') endEdit(false);
    else if (e.key === 'Enter') endEdit(true, { row: Math.min(total - 1, p.row + 1), col: p.col });
    else if (e.key === 'Tab') endEdit(true, { row: p.row, col: Math.min(columns.length - 1, p.col + (e.shiftKey ? -1 : 1)) });
    else return;
    e.preventDefault();
  };

  // Stable identities for the memoized rows; they call the latest closures.
  const latest = useRef({ onEditKey, endEdit });
  latest.current = { onEditKey, endEdit };
  const editKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => latest.current.onEditKey(e), []);
  const editChange = useCallback(
    (value: string) => setEditing(editRef.current ? { ...editRef.current, value } : null),
    [setEditing],
  );
  const editBlur = useCallback(() => latest.current.endEdit(true), []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (active.row === -1 && e.shiftKey && !ctrl && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      resize(active.col, (widths[active.col] ?? MIN_W) + (e.key === 'ArrowLeft' ? -STEP_W : STEP_W));
      return;
    }
    if (editable && active.row >= 0 && !ctrl && !e.altKey) {
      const typed = e.key.length === 1 && e.key !== ' ' ? e.key : undefined;
      if (e.key === 'F2' || e.key === 'Enter' || typed) {
        e.preventDefault();
        beginEdit(active, typed);
        return;
      }
    }
    if (onHeaderActivate && active.row === -1 && !ctrl && (e.key === 'Enter' || e.key === ' ')) {
      const head = document.getElementById(cellId(grid, -1, active.col));
      if (head) {
        e.preventDefault();
        onHeaderActivate(active.col, head);
        return;
      }
    }
    const page = Math.max(1, Math.floor((viewport - HEAD_H) / ROW_H) - 1);
    // With a selection, Shift grows a range from the anchor (in the body; the header's Shift+arrows resize).
    const extend = !!onSelectionChange && e.shiftKey && active.row >= 0;
    const next = move(active, { key: e.key, ctrl, shift: e.shiftKey && !extend, alt: e.altKey }, total, columns.length, page);
    if (!next || (extend && next.row < 0)) return;
    e.preventDefault();
    go(next, extend);
  };

  const target = (e: MouseEvent): Pos | null => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
    return cell ? { row: Number(cell.dataset.row), col: Number(cell.dataset.col) } : null;
  };

  if (cache.error) {
    return <ErrorState title="Rows could not be loaded" message={cache.error.message} onRetry={() => cache.retry()} heading={3} />;
  }
  if (columns.length === 0 || (!loadingFirst && total === 0)) {
    return (
      <EmptyState icon="table" title={emptyTitle ?? (columns.length === 0 ? 'No columns' : 'No rows')} heading={3}>
        {emptyBody ?? (columns.length === 0 ? 'This table has no columns to show.' : 'There are no rows to show.')}
      </EmptyState>
    );
  }

  const failedRow = (i: number) => cache.failed.has(Math.floor(i / PAGE_ROWS));
  const busy = items.some((r) => !cache.has(r.index) && !failedRow(r.index));
  const width = cols.getTotalSize();
  return (
    <div className={s.frame}>
      {cache.failed.size > 0 && (
        <div className={s.banner} role="alert">
          <span>Some rows could not be loaded.</span>
          <Button size="sm" icon="refresh" onClick={() => cache.retry()}>
            Try again
          </Button>
        </div>
      )}
      <div
        ref={bindScroll}
        className={s.scroll}
        role="grid"
        aria-label={label}
        aria-rowcount={loadingFirst ? -1 : total + 1}
        aria-colcount={columns.length}
        aria-readonly={!editable || undefined}
        aria-busy={busy || undefined}
        aria-activedescendant={cellId(grid, active.row, active.col)}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => {
          const p = target(e);
          if (p && !(editing && p.row === editing.pos.row && p.col === editing.pos.col)) setActive(p, e.shiftKey && !!onSelectionChange && p.row >= 0);
        }}
        onDoubleClick={(e) => {
          const p = target(e);
          if (p) beginEdit(p);
        }}
      >
        <div className={s.sizer} role="presentation" style={{ height: Math.min(rows.getTotalSize(), MAX_SCROLL_PX), width }}>
          <div className={s.head} role="row" aria-rowindex={1} style={{ width }}>
            {colItems.map((c) => (
              <HeaderCell
                key={c.key}
                grid={grid}
                col={c}
                column={columns[c.index]!}
                active={active.row === -1 && active.col === c.index}
                onResize={resize}
                onActivate={onHeaderActivate}
              />
            ))}
          </div>
          <div ref={bodyRef} className={s.body} role="presentation" style={{ width }}>
            {items.map((r) => {
              const inSel = r.index >= Math.min(sel.r0, sel.r1) && r.index <= Math.max(sel.r0, sel.r1) && (sel.r0 !== sel.r1 || sel.c0 !== sel.c1);
              return (
              <Row
                key={r.key}
                grid={grid}
                index={r.index}
                start={r.start}
                cells={cache.row(r.index)}
                failed={failedRow(r.index)}
                cols={colItems}
                columns={columns}
                activeCol={active.row === r.index ? active.col : -1}
                editing={editing && editing.pos.row === r.index ? editing.value : null}
                onEditKey={editKey}
                onEditChange={editChange}
                onEditBlur={editBlur}
                selFrom={inSel ? Math.min(sel.c0, sel.c1) : -1}
                selTo={inSel ? Math.max(sel.c0, sel.c1) : -1}
                flag={cellFlag}
                list={editing && editing.pos.row === r.index ? editorList?.(editing.pos.col) : undefined}
              />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
