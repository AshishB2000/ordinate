// A bottom sheet — Radix Dialog, modal, rising from the bottom edge
// (docs/phone-dashboards): a grab handle, a title, a scrolling body, a footer
// above the home indicator. Esc, a press on the scrim, or a swipe down
// closes it; focus is trapped inside and returns to what opened it.
//
// The scrim is OUR div, as in ./Dialog.tsx: Radix's Overlay injects a
// <style> element the CSP refuses.

import { useRef, type ReactNode } from 'react';
import * as D from '@radix-ui/react-dialog';
import { IconButton } from './Button';
import { useSwipeDown } from './useSwipeDown';
import s from './Sheet.module.css';

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons under the body, full width on a phone. Wrap a dismiss in <DialogClose asChild>. */
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const swipe = useSwipeDown(panel, () => onOpenChange(false));
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <div className={s.scrim} />
        <D.Content ref={panel} className={s.sheet} {...(description ? {} : { 'aria-describedby': undefined })}>
          <div className={s.grab} {...swipe}>
            <span className={s.handle} aria-hidden="true" />
            <div className={s.head}>
              <div className={s.ident}>
                <D.Title className={s.title}>{title}</D.Title>
                {description && <D.Description className={s.description}>{description}</D.Description>}
              </div>
              <D.Close asChild>
                <IconButton icon="x" label="Close" className={s.close} />
              </D.Close>
            </div>
          </div>
          {children && <div className={s.body}>{children}</div>}
          {footer && <div className={s.footer}>{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
