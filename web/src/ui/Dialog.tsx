// Dialog and Drawer — both Radix Dialog, modal: focus is trapped inside,
// everything behind is inert to assistive tech (aria-hidden) and to the
// pointer, Escape or a press on the scrim closes, focus returns to whatever
// opened it. A Dialog is centred (hub.css `.ws-modal`); a Drawer is a sheet
// on the right edge (sidePanel.ts's surface, as an overlay) — and, in a window
// under 600px, a bottom sheet with a grab handle you swipe down
// (docs/phone-dashboards; the switch is CSS, the swipe asks the same query).
//
// The scrim is OUR div, not Radix's <Dialog.Overlay>: Overlay wraps itself in
// react-remove-scroll, which injects a <style> element the CSP refuses. The
// cost is that the page behind can still scroll under the scrim (the page
// body is a fixed frame here — only <main> scrolls — so it rarely shows).

import { useRef, type ReactElement, type ReactNode } from 'react';
import * as D from '@radix-ui/react-dialog';
import { IconButton } from './Button';
import { useSwipeDown } from './useSwipeDown';
import s from './Dialog.module.css';

interface Common {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional: an element that opens it (focus returns there on close). */
  trigger?: ReactElement;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned under the body. Wrap a cancel in <DialogClose asChild>. */
  footer?: ReactNode;
}

/** The window width under which a Drawer is a bottom sheet (Dialog.module.css's media query). */
export const PHONE_QUERY = '(max-width: 599px)';
const narrow = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;

function Head({ title, description, swipe }: { title: string; description?: ReactNode; swipe?: ReturnType<typeof useSwipeDown> }) {
  return (
    <div className={s.head} {...swipe}>
      <div className={s.ident}>
        <D.Title className={s.title}>{title}</D.Title>
        {description && <D.Description className={s.description}>{description}</D.Description>}
      </div>
      <D.Close asChild>
        <IconButton icon="x" label="Close" size="sm" />
      </D.Close>
    </div>
  );
}

export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  size = 'md',
}: Common & { size?: 'sm' | 'md' | 'lg' | 'xl' | 'xxl' }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <D.Trigger asChild>{trigger}</D.Trigger>}
      <D.Portal>
        <div className={s.scrim} />
        <D.Content
          className={`${s.dialog} ${s[size]}`}
          // No description → drop the reference, or Radix warns in the console.
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <Head title={title} description={description} />
          {children && <div className={s.body}>{children}</div>}
          {footer && <div className={s.footer}>{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function Drawer({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  wide,
}: Common & { wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const swipe = useSwipeDown(panel, () => onOpenChange?.(false), narrow);
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <D.Trigger asChild>{trigger}</D.Trigger>}
      <D.Portal>
        <div className={`${s.scrim} ${s.scrimLight}`} />
        <D.Content
          ref={panel}
          className={`${s.drawer} ${wide ? s.wide : ''}`}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <span className={s.handle} aria-hidden="true" />
          <Head title={title} description={description} swipe={swipe} />
          <div className={s.drawerBody}>{children}</div>
          {footer && <div className={s.footer}>{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Closes the surrounding Dialog / Drawer: `<DialogClose asChild><Button>Cancel</Button></DialogClose>`. */
export const DialogClose = D.Close;
