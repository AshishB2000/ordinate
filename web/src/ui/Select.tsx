// Select — customDropdown.ts, ported: a trigger plus a body-mounted listbox
// that is height-capped to min(320px, 55vh) AND to the room on its side, flips
// above the trigger when there is more room there, scrolls inside, follows the
// trigger on scroll/resize, and hides when the trigger scrolls away. Keyboard:
// ↑/↓ Home/End Enter/Space Escape Tab, plus typeahead (a native select's).
//
// The ARIA 1.2 select-only combobox: focus never leaves the trigger; the
// active option is announced through aria-activedescendant.
//
// Built on Radix POPOVER (non-modal), not Radix Select: Select wraps its
// content in react-remove-scroll unconditionally, which injects a <style>
// element on every open — a CSP violation under `style-src 'self'`.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import * as P from '@radix-ui/react-popover';
import { Field, useFieldIds, type FieldFrame } from './Field';
import { Icon } from './icons/Icon';
import f from './floating.module.css';
import s from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** The next enabled index from `from` in direction `dir`, or `from` if there is none. */
export function nextEnabled(options: readonly SelectOption[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i].disabled) return i;
  return from;
}

/** The listbox both Select and Combobox open: options, highlight, selection mark. */
export function OptionList({
  id,
  options,
  active,
  selected,
  onPick,
  onHover,
  empty,
}: {
  id: string;
  options: readonly SelectOption[];
  active: number;
  selected: string | null;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
  empty?: ReactNode;
}) {
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, active]);
  if (options.length === 0) return <div className={f.none}>{empty}</div>;
  return options.map((o, i) => {
    const isSel = o.value === selected;
    return (
      <div
        key={o.value}
        id={`${id}-${i}`}
        role="option"
        aria-selected={isSel}
        aria-disabled={o.disabled || undefined}
        data-highlighted={i === active ? '' : undefined}
        className={[f.item, isSel && f.selected].filter(Boolean).join(' ')}
        onClick={() => onPick(i)}
        onPointerMove={() => !o.disabled && i !== active && onHover(i)}
      >
        <span className={f.itemText}>{o.label}</span>
        {isSel && (
          <span className={f.check}>
            <Icon name="check" />
          </span>
        )}
      </div>
    );
  });
}

export interface SelectProps extends FieldFrame {
  value: string | null;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  /** Required when there is no visible `label`. */
  'aria-label'?: string;
  className?: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  disabled,
  size = 'md',
  id,
  label,
  hint,
  error,
  className,
  'aria-label': ariaLabel,
}: SelectProps) {
  const ids = useFieldIds(id, { hint, error });
  const listId = `${ids.controlId}-list`;
  const labelId = `${ids.controlId}-label`;
  const trigger = useRef<HTMLButtonElement>(null);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selectedIndex);
  const typed = useRef({ text: '', at: 0 });

  const current = options[selectedIndex];

  function show() {
    if (disabled || options.length === 0) return;
    setActive(selectedIndex >= 0 ? selectedIndex : nextEnabled(options, -1, 1));
    setOpen(true);
  }
  function pick(i: number) {
    const o = options[i];
    if (!o || o.disabled) return;
    setOpen(false);
    if (o.value !== value) onValueChange(o.value);
  }
  /** Characters typed within 500ms of each other spell a prefix. */
  function typeahead(ch: string) {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at < 500 ? t.text + ch.toLowerCase() : ch.toLowerCase();
    t.at = now;
    const from = open ? active : selectedIndex;
    const order = [...options.keys()].map((k) => (from + 1 + k) % options.length);
    const hit = order.find((i) => !options[i].disabled && options[i].label.toLowerCase().startsWith(t.text));
    if (hit === undefined) return;
    if (open) setActive(hit);
    else pick(hit);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault();
        show();
      } else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeahead(k);
      return;
    }
    if (k === 'Tab') return setOpen(false); // focus moves on, natively
    if (k.length === 1 && k !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) return typeahead(k);
    const moves: Record<string, () => number> = {
      ArrowDown: () => nextEnabled(options, active, 1),
      ArrowUp: () => nextEnabled(options, active, -1),
      Home: () => nextEnabled(options, -1, 1),
      End: () => nextEnabled(options, options.length, -1),
    };
    if (moves[k]) {
      e.preventDefault();
      setActive(moves[k]());
    } else if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      pick(active);
    } else if (k === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <Field label={label} hint={hint} error={error} controlId={ids.controlId} msgId={ids.msgId} labelId={labelId}>
      <P.Root open={open} onOpenChange={(o) => (o ? show() : setOpen(false))}>
        <P.Anchor asChild>
          <button
            ref={trigger}
            id={ids.controlId}
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
            aria-labelledby={label ? labelId : undefined}
            aria-label={label ? undefined : ariaLabel}
            aria-invalid={ids.invalid}
            aria-describedby={ids.describedBy}
            disabled={disabled}
            data-state={open ? 'open' : 'closed'}
            className={[s.trigger, size === 'sm' && s.sm, className].filter(Boolean).join(' ')}
            onClick={() => (open ? setOpen(false) : show())}
            onKeyDown={onKeyDown}
            // Space activates a <button> on keyup; keydown already handled it.
            onKeyUp={(e) => e.key === ' ' && e.preventDefault()}
          >
            <span className={current ? s.value : `${s.value} ${s.placeholder}`}>{current?.label ?? placeholder}</span>
            <span className={s.chevron}>
              <Icon name="chevron-down" />
            </span>
          </button>
        </P.Anchor>
        <P.Portal>
          <P.Content
            role="listbox"
            id={listId}
            aria-labelledby={label ? labelId : undefined}
            aria-label={label ? undefined : ariaLabel}
            className={`${f.surface} ${f.list}`}
            align="start"
            sideOffset={4}
            collisionPadding={8}
            hideWhenDetached
            // Focus stays on the trigger the whole time (activedescendant).
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => trigger.current?.contains(e.target as Node) && e.preventDefault()}
            // A press on an option must not take focus off the trigger.
            onMouseDown={(e) => e.preventDefault()}
          >
            <OptionList
              id={listId}
              options={options}
              active={active}
              selected={value}
              onPick={pick}
              onHover={setActive}
            />
          </P.Content>
        </P.Portal>
      </P.Root>
    </Field>
  );
}
