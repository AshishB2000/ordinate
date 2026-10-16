// Swipe a bottom sheet down to close it (docs/phone-dashboards): the grab
// zone follows the finger, and letting go far enough — or fast enough —
// closes; anything less springs back. The sheet moves by a transform set
// through the CSSOM (never a style attribute: the CSP refuses those).

import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/** Past this many pixels a release closes the sheet. */
export const SWIPE_CLOSE_PX = 96;
/** A flick this fast (px per ms) closes it from any distance. */
export const SWIPE_CLOSE_SPEED = 0.6;

export function useSwipeDown(panel: RefObject<HTMLElement | null>, onClose: () => void, enabled: () => boolean = () => true) {
  const drag = useRef<{ id: number; y0: number; t0: number; dy: number } | null>(null);
  const place = (dy: number, settle: boolean) => {
    const el = panel.current;
    if (!el) return;
    el.style.transition = settle ? '' : 'none';
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  };
  return {
    onPointerDown(e: ReactPointerEvent) {
      if (e.button !== 0 || !enabled()) return;
      // A press on a control in the grab zone (Close) is that control's.
      if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
      drag.current = { id: e.pointerId, y0: e.clientY, t0: e.timeStamp, dy: 0 };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // no active pointer for that id — the moves below still arrive
      }
    },
    onPointerMove(e: ReactPointerEvent) {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      d.dy = Math.max(0, e.clientY - d.y0);
      place(d.dy, false);
    },
    onPointerUp(e: ReactPointerEvent) {
      const d = drag.current;
      drag.current = null;
      if (!d || d.id !== e.pointerId) return;
      const speed = d.dy / Math.max(1, e.timeStamp - d.t0);
      // Closing leaves the sheet where the finger let go: it unmounts from there, it does not jump back first.
      if (d.dy >= SWIPE_CLOSE_PX || (d.dy > 24 && speed >= SWIPE_CLOSE_SPEED)) onClose();
      else place(0, true);
    },
    onPointerCancel() {
      drag.current = null;
      place(0, true);
    },
  };
}
