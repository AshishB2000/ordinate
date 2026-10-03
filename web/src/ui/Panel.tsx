// Panel — the side panel shell sidePanel.ts and dsProfile.ts share: a head
// row (title over a small uppercase kind, a close ✕), a body that scrolls, and
// actions pinned under it. It is a surface, not a placement: the screen puts
// it beside its content (with a Splitter to size it) — the desktop's "push,
// don't cover". For a panel OVER the page, use Drawer.
//
// Escape closes it while focus is inside — unless something above it (a menu,
// a select opened from within) already handled that Escape.

import type { ReactNode } from 'react';
import { IconButton } from './Button';
import s from './Panel.module.css';

export function Panel({
  title,
  sub,
  onClose,
  footer,
  children,
  className,
}: {
  title: string;
  /** The small uppercase line under the title: "Version history · Dashboard". */
  sub?: string;
  onClose?: () => void;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={className ? `${s.panel} ${className}` : s.panel}
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !onClose || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div className={s.head}>
        <div className={s.ident}>
          <h2 className={s.title}>{title}</h2>
          {sub && <span className={s.sub}>{sub}</span>}
        </div>
        {onClose && <IconButton icon="x" label="Close" size="sm" onClick={onClose} />}
      </div>
      <div className={s.body}>{children}</div>
      {footer && <div className={s.foot}>{footer}</div>}
    </aside>
  );
}
