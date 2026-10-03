// Tooltip — Radix Tooltip: shows on hover AND keyboard focus, hides on
// Escape, and describes its trigger (aria-describedby). hub.css `.tip`: always
// dark in both themes (an overlay on the app, not a piece of it), and a 300ms
// delay so a pass of the mouse across a toolbar is not a flicker of popups.
//
// A tooltip is a hint, never the only name: an icon-only control still needs
// its own label (IconButton requires one).

import type { ReactElement, ReactNode } from 'react';
import * as T from '@radix-ui/react-tooltip';
import s from './Tooltip.module.css';

export function Tooltip({
  content,
  children,
  side = 'top',
  open,
}: {
  content: ReactNode;
  /** One focusable element. */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Forced open (the gallery's static state); normally left to hover/focus. */
  open?: boolean;
}) {
  // A provider per tooltip: no app-level wiring, and each one keeps the delay.
  return (
    <T.Provider delayDuration={300} skipDelayDuration={300}>
      <T.Root open={open}>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content className={s.tip} side={side} sideOffset={6} collisionPadding={8}>
            {content}
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
