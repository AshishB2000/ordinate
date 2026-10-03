// Dialog and Drawer — both Radix Dialog, modal: focus is trapped inside,
// everything behind is inert to assistive tech (aria-hidden) and to the
// pointer, Escape or a press on the scrim closes, focus returns to whatever
// opened it. A Dialog is centred (hub.css `.ws-modal`); a Drawer is a sheet
// on the right edge (sidePanel.ts's surface, as an overlay).
//
// The scrim is OUR div, not Radix's <Dialog.Overlay>: Overlay wraps itself in
// react-remove-scroll, which injects a <style> element the CSP refuses. The
// cost is that the page behind can still scroll under the scrim (the page
// body is a fixed frame here — only <main> scrolls — so it rarely shows).

import type { ReactElement, ReactNode } from 'react';
import * as D from '@radix-ui/react-dialog';
import { IconButton } from './Button';
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

function Head({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className={s.head}>
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
}: Common & { size?: 'sm' | 'md' | 'lg' }) {
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
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <D.Trigger asChild>{trigger}</D.Trigger>}
      <D.Portal>
        <div className={`${s.scrim} ${s.scrimLight}`} />
        <D.Content
          className={`${s.drawer} ${wide ? s.wide : ''}`}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <Head title={title} description={description} />
          <div className={s.drawerBody}>{children}</div>
          {footer && <div className={s.footer}>{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Closes the surrounding Dialog / Drawer: `<DialogClose asChild><Button>Cancel</Button></DialogClose>`. */
export const DialogClose = D.Close;
