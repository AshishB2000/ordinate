// Splitter — the resize handle between two panes; dockResize.ts generalised.
// A `role="separator"` that is focusable, so it is a WAI-ARIA window splitter:
// drag it, or focus it and use ←/→ (16px a press) and Home/End (min/max).
//
// Controlled: the caller owns the size and lays the panes out with it.
// `onSizeChange` fires live (every move / key); `onCommit` once per finished
// gesture — pointer up, key up — which is where the size is persisted (and
// where a chart in the pane should be told to relayout), never per move.
// Pointer capture replaces dockResize's `e.buttons` guard: a release outside
// the window still ends the drag.

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import s from './Splitter.module.css';

export interface SplitterProps {
  size: number;
  min: number;
  max: number;
  onSizeChange: (size: number) => void;
  onCommit?: (size: number) => void;
  /** Which side of the handle the sized pane is on: a left rail is 'before', a right dock 'after'. */
  pane?: 'before' | 'after';
  /** Names the handle: "Resize assistant panel". */
  label: string;
  step?: number;
}

const KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

export function Splitter({ size, min, max, onSizeChange, onCommit, pane = 'before', label, step = 16 }: SplitterProps) {
  const drag = useRef<{ x: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const hi = Math.max(min, max);
  const clamp = (n: number) => Math.min(Math.max(n, min), hi);
  // Dragging right grows a pane BEFORE the handle and shrinks one after it.
  const dir = pane === 'before' ? 1 : -1;

  function end() {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    onCommit?.(size);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={hi}
      tabIndex={0}
      className={s.handle}
      data-dragging={dragging || undefined}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault(); // no text selection under the cursor
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, size };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) onSizeChange(clamp(d.size + dir * (e.clientX - d.x)));
      }}
      onPointerUp={end}
      onLostPointerCapture={end}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (!KEYS.has(e.key)) return;
        e.preventDefault();
        const next =
          e.key === 'Home' ? min : e.key === 'End' ? hi : size + (e.key === 'ArrowRight' ? dir : -dir) * step;
        onSizeChange(clamp(next));
      }}
      onKeyUp={(e) => KEYS.has(e.key) && onCommit?.(size)}
    />
  );
}

/**
 * A pane size remembered per browser (localStorage, like the desktop's
 * `dkWidth`), clamped on the way OUT to the current bounds — so a width saved
 * on a wide window never overflows a narrow one. Returns [size, set, commit].
 */
export function useStoredSize(key: string, initial: number, min: number, max: number) {
  const [raw, setRaw] = useState(() => {
    try {
      const n = Number.parseInt(localStorage.getItem(key) ?? '', 10);
      return Number.isFinite(n) ? n : initial;
    } catch {
      return initial;
    }
  });
  const commit = useCallback(
    (n: number) => {
      try {
        localStorage.setItem(key, String(Math.round(n)));
      } catch {
        // storage blocked: the size lasts for this page only
      }
    },
    [key],
  );
  return [Math.min(Math.max(raw, min), Math.max(min, max)), setRaw, commit] as const;
}
