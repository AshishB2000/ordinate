// Combobox — a text field that filters a list as you type (the ARIA 1.2
// editable combobox with list autocomplete). A native <input> plus the same
// listbox Select opens; no Radix part beyond Popover for the placement.
// Filtering is of the OPTION LABELS only — presentation, not a figure.

import { useRef, useState, type KeyboardEvent } from 'react';
import * as P from '@radix-ui/react-popover';
import { Field, useFieldIds, type FieldFrame } from './Field';
import { Icon } from './icons/Icon';
import { nextEnabled, OptionList, type SelectOption } from './Select';
import fs from './Field.module.css';
import f from './floating.module.css';

export interface ComboboxProps extends FieldFrame {
  value: string | null;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** What the list says when nothing matches. */
  emptyText?: string;
  id?: string;
  'aria-label'?: string;
}

export function Combobox({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  emptyText = 'No matches',
  id,
  label,
  hint,
  error,
  'aria-label': ariaLabel,
}: ComboboxProps) {
  const ids = useFieldIds(id, { hint, error });
  const listId = `${ids.controlId}-list`;
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // null = not editing: the field shows the selected option's label.
  const [query, setQuery] = useState<string | null>(null);

  const selected = options.find((o) => o.value === value);
  const q = query?.trim().toLowerCase() ?? '';
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  function close() {
    setOpen(false);
    setQuery(null);
  }
  function openAt(list: readonly SelectOption[]) {
    if (disabled) return;
    const sel = list.findIndex((o) => o.value === value);
    setActive(sel >= 0 ? sel : nextEnabled(list, -1, 1));
    setOpen(true);
  }
  function pick(i: number) {
    const o = shown[i];
    if (!o || o.disabled) return;
    close();
    if (o.value !== value) onValueChange(o.value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openAt(shown);
        else setActive(nextEnabled(shown, active, e.key === 'ArrowDown' ? 1 : -1));
        break;
      case 'Enter':
        if (open && active >= 0) {
          e.preventDefault();
          pick(active);
        }
        break;
      case 'Escape':
        if (open || query !== null) {
          e.preventDefault();
          close();
        }
        break;
      case 'Tab':
        close();
        break;
    }
  }

  return (
    <Field label={label} hint={hint} error={error} controlId={ids.controlId} msgId={ids.msgId}>
      <P.Root open={open} onOpenChange={(o) => !o && close()}>
        <P.Anchor asChild>
          <span ref={anchor} className={fs.box}>
            <Icon name="search" />
            <input
              id={ids.controlId}
              className={fs.input}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
              aria-label={label ? undefined : ariaLabel}
              aria-invalid={ids.invalid}
              aria-describedby={ids.describedBy}
              autoComplete="off"
              disabled={disabled}
              placeholder={placeholder}
              value={query ?? selected?.label ?? ''}
              onChange={(e) => {
                const next = e.target.value;
                setQuery(next);
                const n = next.trim().toLowerCase();
                openAt(n ? options.filter((o) => o.label.toLowerCase().includes(n)) : options);
              }}
              onClick={() => !open && openAt(shown)}
              onKeyDown={onKeyDown}
              onBlur={close}
            />
          </span>
        </P.Anchor>
        <P.Portal>
          <P.Content
            role="listbox"
            id={listId}
            aria-label={label ?? ariaLabel}
            className={`${f.surface} ${f.list}`}
            align="start"
            sideOffset={4}
            collisionPadding={8}
            hideWhenDetached
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => anchor.current?.contains(e.target as Node) && e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
          >
            <OptionList
              id={listId}
              options={shown}
              active={active}
              selected={value}
              onPick={pick}
              onHover={setActive}
              empty={emptyText}
            />
          </P.Content>
        </P.Portal>
      </P.Root>
    </Field>
  );
}
