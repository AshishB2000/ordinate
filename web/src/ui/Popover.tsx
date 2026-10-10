// Popover — Radix Popover, non-modal: focus moves into the panel on open and
// back to the trigger on close; Escape, an outside press or focus leaving the
// panel dismisses it. Modal (a focus TRAP) is deliberately not offered: Radix
// implements it with react-remove-scroll, whose injected <style> element the
// CSP refuses. Something that needs a trap is a Dialog.

import type { ReactElement, ReactNode, RefObject } from 'react';
import * as P from '@radix-ui/react-popover';
import f from './floating.module.css';
import s from './Popover.module.css';

export interface PopoverProps {
  /** The control that opens it. Or, instead, `anchorRef`: an element it is placed against (a grid header). */
  trigger?: ReactElement;
  anchorRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
  /** Names the panel (aria-label) and, if `heading`, is drawn as its title. */
  title: string;
  heading?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Replaces the panel's own size and padding (a list that runs edge to edge). */
  className?: string;
  /** Where focus goes on close instead of the trigger: call `preventDefault()` and focus it. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function Popover({ trigger, anchorRef, children, title, heading, open, onOpenChange, align = 'start', side = 'bottom', className, onCloseAutoFocus }: PopoverProps) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <P.Trigger asChild>{trigger}</P.Trigger>}
      {anchorRef && <P.Anchor virtualRef={anchorRef} />}
      <P.Portal>
        <P.Content
          className={`${f.surface} ${className ?? s.popover}`}
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={8}
          aria-label={title}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {heading && <h2 className={s.title}>{title}</h2>}
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

/** A control inside the popover that closes it (Done, Cancel). */
export const PopoverClose = P.Close;
