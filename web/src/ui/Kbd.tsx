// Kbd — hub.css `.kbd`, a key cap for shortcut hints.

import type { ReactNode } from 'react';
import s from './Kbd.module.css';

/** One key, or a chord as separate caps: <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}
