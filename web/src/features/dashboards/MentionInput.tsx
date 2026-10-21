// A comment box with the @ picker (docs/notifications/00-design.md §5.11): typing
// @ at the start of a word lists up to 8 people who can read this project now
// (`comment:mentionable` — the server filters, the browser never sees the org's
// people), ↑ ↓ move, Enter or Tab inserts `@(address) `, Esc closes the list and
// NOT the panel around it. The same keys as the SQL editor's completions
// (QueryEditor.tsx). Off without a user directory: the box is a plain Textarea.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type TextareaHTMLAttributes } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { Textarea } from '../../ui/Field';
import { useCaret } from '../../ui/useCaret';
import { mentionToken } from '../../../../src/app/mentionToken.ts';
import s from './Mentions.module.css';

export interface Person {
  email: string;
  name: string;
}

/** The word being typed after an @ at the caret, or null. */
export function mentionQuery(text: string, caret: number): { from: number; q: string } | null {
  const m = /(^|\s)@([^\s@()<>[\]\\]{0,50})$/.exec(text.slice(0, caret));
  return m ? { from: caret - m[2].length - 1, q: m[2] } : null;
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  projectId: string;
  /** Mentions are on here (`comment:list` says so). */
  enabled: boolean;
  label: string;
  hint?: string;
  value: string;
  onValueChange: (v: string) => void;
};

export function MentionInput({ projectId, enabled, label, hint, value, onValueChange, onKeyDown, onBlur, ...rest }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const place = useCaret(input);
  const listId = useId();
  const [at, setAt] = useState<{ from: number; q: string } | null>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  // What is asked trails the keys by a beat, so a name typed fast is one request.
  useEffect(() => {
    const t = setTimeout(() => setQ(at?.q ?? ''), 150);
    return () => clearTimeout(t);
  }, [at?.q]);
  const open = enabled && at !== null;
  const people = useQuery({
    queryKey: ['comment:mentionable', projectId, q],
    enabled: open,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async () => ((await rpc('comment:mentionable', { projectId, q })) as { people?: Person[] }).people ?? [],
  });
  const items = open ? (people.data ?? []) : [];

  // Radix closes a drawer on Escape in the document's capture phase, before this box sees the key: the window's
  // capture phase comes first, so while the list is open it takes Escape (and marks it handled) instead.
  useEffect(() => {
    if (!open) return;
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setAt(null);
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [open]);

  const accept = (p: Person) => {
    const el = input.current;
    if (!el || !at) return;
    const caret = el.selectionStart ?? value.length;
    const token = mentionToken(p.email) + ' ';
    onValueChange(value.slice(0, at.from) + token + value.slice(caret));
    setAt(null);
    place(at.from + token.length);
  };

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && items.length && !(e.metaKey || e.ctrlKey)) {
      const moves: Record<string, () => void> = {
        ArrowDown: () => setActive((active + 1) % items.length),
        ArrowUp: () => setActive((active - 1 + items.length) % items.length),
        Enter: () => accept(items[Math.min(active, items.length - 1)] as Person),
        Tab: () => accept(items[Math.min(active, items.length - 1)] as Person),
      };
      const move = moves[e.key];
      if (move) {
        e.preventDefault();
        move();
        return;
      }
    }
    onKeyDown?.(e);
  };

  const note = !open ? null : people.isError ? (
    <div className={s.listNoteError} role="status">Could not search people. Keep typing to try again.</div>
  ) : people.isPending ? (
    <div className={s.listNote} role="status">Searching…</div>
  ) : !items.length ? (
    <div className={s.listNote} role="status">{q ? `No one who can read this project matches “${q}”.` : 'No one else can read this project yet.'}</div>
  ) : null;

  return (
    <div className={s.field}>
      <Textarea
        ref={input}
        label={label}
        hint={hint}
        value={value}
        {...rest}
        {...(enabled
          ? { role: 'combobox', 'aria-expanded': open && items.length > 0, 'aria-controls': listId, 'aria-autocomplete': 'list' as const, 'aria-activedescendant': open && items.length ? `${listId}-${Math.min(active, items.length - 1)}` : undefined }
          : {})}
        onChange={(e) => {
          onValueChange(e.target.value);
          const found = enabled ? mentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length) : null;
          setAt(found);
          if (found?.q !== at?.q) setActive(0);
        }}
        onKeyDown={keys}
        onClick={() => setAt(null)}
        onBlur={(e) => {
          setAt(null);
          onBlur?.(e);
        }}
      />
      {open && (
        <div className={s.list}>
          {items.length > 0 && (
            <div id={listId} role="listbox" aria-label="People who can read this project">
              {items.map((p, i) => (
            <div
              key={p.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === Math.min(active, items.length - 1)}
              className={i === Math.min(active, items.length - 1) ? `${s.option} ${s.optionOn}` : s.option}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(p);
              }}
            >
              <span className={s.avatar} aria-hidden="true">
                {(p.name[0] ?? '?').toUpperCase()}
              </span>
              <span className={s.optionText}>
                <span className={s.optionName}>{p.name}</span>
                <span className={s.optionMail}>{p.email}</span>
              </span>
            </div>
              ))}
            </div>
          )}
          {note}
        </div>
      )}
    </div>
  );
}
