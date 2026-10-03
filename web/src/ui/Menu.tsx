// Menus — Radix DropdownMenu and ContextMenu over ONE item list, so a ⋯ menu
// and the right-click menu on the same card can never drift apart. Radix
// brings roving focus, typeahead, Escape, and focus back to the trigger.
//
// Both roots are `modal={false}`: a modal Radix menu wraps itself in
// react-remove-scroll, which injects a <style> element that `style-src 'self'`
// refuses (a console error on every open). Non-modal keeps focus inside the
// menu all the same (Tab is swallowed) and closes on any outside press.
//
// ponytail: no sub-menus or checkbox items; add when a screen needs one.

import type { ReactElement, ReactNode } from 'react';
import * as DM from '@radix-ui/react-dropdown-menu';
import * as CM from '@radix-ui/react-context-menu';
import { Icon, type IconName } from './icons/Icon';
import f from './floating.module.css';

export type MenuEntry =
  | {
      kind?: 'item';
      label: string;
      icon?: IconName;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator' }
  | { kind: 'heading'; label: string }
  | {
      kind: 'radio';
      /** Names the group for assistive tech; not drawn (add a heading for that). */
      label: string;
      value: string;
      options: readonly { value: string; label: string }[];
      onChange: (value: string) => void;
    };

// The two namespaces have the same part shapes; this picks one per call.
type Parts = typeof DM | typeof CM;

function Entries({ items, P }: { items: readonly MenuEntry[]; P: Parts }) {
  return items.map((e, i) => {
    switch (e.kind) {
      case 'separator':
        return <P.Separator key={i} className={f.sep} />;
      case 'heading':
        return (
          <P.Label key={i} className={f.heading}>
            {e.label}
          </P.Label>
        );
      case 'radio':
        return (
          <P.RadioGroup key={i} value={e.value} onValueChange={e.onChange} aria-label={e.label}>
            {e.options.map((o) => (
              <P.RadioItem key={o.value} value={o.value} className={f.item}>
                <span className={f.itemText}>{o.label}</span>
                <P.ItemIndicator className={f.check}>
                  <Icon name="check" />
                </P.ItemIndicator>
              </P.RadioItem>
            ))}
          </P.RadioGroup>
        );
      default:
        return (
          <P.Item
            key={i}
            className={e.danger ? `${f.item} ${f.danger}` : f.item}
            disabled={e.disabled}
            onSelect={e.onSelect}
          >
            {e.icon && <Icon name={e.icon} />}
            <span className={f.itemText}>{e.label}</span>
            {e.shortcut && <span className={f.shortcut}>{e.shortcut}</span>}
          </P.Item>
        );
    }
  });
}

export interface MenuProps {
  /** One focusable element (a Button / IconButton); Radix wires aria-haspopup and aria-expanded onto it. */
  trigger: ReactElement;
  items: readonly MenuEntry[];
  /** Free content above the items — a signed-in user's name, say. Not focusable. */
  header?: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Accessible name for the menu itself; defaults to the trigger's. */
  label?: string;
}

export function Menu({ trigger, items, header, align = 'start', side = 'bottom', open, onOpenChange, label }: MenuProps) {
  return (
    <DM.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content className={f.surface} align={align} side={side} sideOffset={4} collisionPadding={8} aria-label={label}>
          {header}
          <Entries items={items} P={DM} />
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export interface ContextMenuProps {
  /** The region that answers a right-click (or Shift+F10 / the menu key). */
  children: ReactElement;
  items: readonly MenuEntry[];
  label?: string;
}

export function ContextMenu({ children, items, label }: ContextMenuProps) {
  return (
    <CM.Root modal={false}>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className={f.surface} collisionPadding={8} aria-label={label}>
          <Entries items={items} P={CM} />
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
