// The context menu of ONE chart point: the kit's Menu, opened where the pointer
// was. It is the caller's item list — one entry today, room for the next — and
// it only exists while a point is under the pointer: a right-click anywhere
// else on the tile is the browser's own menu.
//
// A right-click cannot be made from a keyboard or by touch, so everything here
// is also reachable from the tile's ⋯ menu ("Explain a change…").

import { Menu, type MenuEntry } from '../../../ui/Menu';
import s from './Explain.module.css';

export function PointMenu({ at, items, label, onClose }: { at: { x: number; y: number } | null; items: readonly MenuEntry[]; label: string; onClose: () => void }) {
  if (!at) return null;
  return (
    <Menu
      open
      onOpenChange={(o) => !o && onClose()}
      label={label}
      items={items}
      // Placement only: the pointer's position, set through the CSSOM (no inline style attribute under the CSP).
      // The menu takes its name from its trigger (Radix labels it by the trigger's id), so the anchor carries it.
      trigger={<span className={s.anchor} aria-label={label} style={{ left: at.x, top: at.y }} />}
    />
  );
}
