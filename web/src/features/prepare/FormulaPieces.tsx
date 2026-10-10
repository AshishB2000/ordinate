// The formula editor's two reusable halves, shared by every place a formula is
// written — a calculated field in Prepare (./FormulaEditor) and a calculated
// measure in the chart builder (../calc):
//
//   <FormulaInput>  the expression box: a transparent-text textarea over a
//                   mirror <pre> that paints the SERVER's tokens and underlines
//                   the SERVER's error span, plus the completion popover
//   <FormulaSide>   the searchable list of columns, names and functions that
//                   insert at the caret
//
// Neither knows whether a formula is valid: the tokens, the error and its
// position are handed in by whoever asked the server (./formulaParts.ts).

import { useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Input } from '../../ui/Field';
import type { Column, FunctionDoc, Tok } from './api';
import { categoryLabel, highlightRuns, lodCaretBack, popContext, type PopItem } from './formulaParts';
import s from './Formula.module.css';

const GLYPH: Record<string, string> = { number: '#', date: '⏱', text: 'A' };

export interface FormulaInputHandle {
  /** Insert at the caret; `back` leaves the caret that many characters before the end. */
  insert: (text: string, back?: number) => void;
}

export function FormulaInput({
  ref,
  value,
  onChange,
  tokens,
  at,
  columns,
  docs,
  refs,
  label = 'Expression',
  invalid,
  describedBy,
  autoFocus,
  onSubmit,
}: {
  ref?: Ref<FormulaInputHandle>;
  value: string;
  onChange: (next: string) => void;
  /** The server's tokens for `value` (or for the text just before it — the colours hold while a check is in flight). */
  tokens: readonly Tok[];
  /** The server's error span, or null. */
  at: { start: number; end: number } | null;
  columns: readonly Column[];
  docs: readonly FunctionDoc[];
  /** Other names a `[` completes to (saved metrics). */
  refs?: readonly PopItem[];
  label?: string;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  /** ⌘/Ctrl+Enter. */
  onSubmit?: () => void;
}) {
  const [pop, setPop] = useState<{ items: PopItem[]; from: number; index: number } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLPreElement>(null);
  const fnNames = new Set(docs.map((d) => d.name));

  const place = (next: string, pos: number) => {
    onChange(next);
    setPop(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(pos, pos);
    });
  };
  useImperativeHandle(ref, () => ({
    insert(text, back = 0) {
      const el = input.current;
      const a = el?.selectionStart ?? value.length;
      const b = el?.selectionEnd ?? a;
      place(value.slice(0, a) + text + value.slice(b), a + text.length - back);
    },
  }));

  function edit(next: string, caret: number) {
    if (next !== value) onChange(next);
    const ctx = popContext(next.slice(0, caret), columns, docs, refs);
    setPop(ctx ? { ...ctx, index: 0 } : null);
  }
  function accept(i: number) {
    const it = pop?.items[i];
    if (!it || !pop) return;
    const caret = input.current?.selectionStart ?? value.length;
    place(value.slice(0, pop.from) + it.insert + value.slice(caret), pop.from + it.insert.length);
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onSubmit?.();
      return;
    }
    if (!pop) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = pop.items.length;
      setPop({ ...pop, index: (pop.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      accept(pop.index);
    }
  }

  const runs = highlightRuns(value, tokens, at, fnNames);
  return (
    <>
      <div className={s.wrap}>
        <pre className={s.hl} aria-hidden="true" ref={mirror}>
          {runs.map((r, i) => (
            <span key={i} className={[r.cls && s[`t_${r.cls}`], r.err && s.tErr].filter(Boolean).join(' ') || undefined}>
              {r.text}
            </span>
          ))}
        </pre>
        <textarea
          ref={input}
          className={s.input}
          spellCheck={false}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-autocomplete="list"
          aria-controls={pop ? 'fx-pop' : undefined}
          aria-activedescendant={pop ? `fx-pop-${pop.index}` : undefined}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => edit(e.target.value, e.target.selectionStart)}
          onClick={(e) => edit(value, e.currentTarget.selectionStart)}
          onBlur={() => setPop(null)}
          onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
          onKeyDown={onKey}
        />
      </div>
      {pop && (
        <div className={s.pop} role="listbox" id="fx-pop" aria-label="Completions">
          {pop.items.map((it, i) => (
            <div
              key={it.label + i}
              id={`fx-pop-${i}`}
              role="option"
              aria-selected={i === pop.index}
              className={i === pop.index ? `${s.popItem} ${s.popOn}` : s.popItem}
              onMouseDown={(e) => (e.preventDefault(), accept(i))}
            >
              <span className={s.popLabel}>{it.label}</span>
              <span className={s.popSub}>{it.sub}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** One extra group of names in the side list (a measure's saved metrics). */
export interface SideGroup {
  title: string;
  items: { label: string; insert: string; title?: string }[];
}

export function FormulaSide({
  columns,
  docs,
  loading,
  groups = [],
  columnInsert = (name) => `[${name}]`,
  onInsert,
  footer,
}: {
  columns: readonly Column[];
  docs: readonly FunctionDoc[];
  /** The function list is still on its way. */
  loading?: boolean;
  groups?: readonly SideGroup[];
  /** What clicking a column writes — `[name]` on a row, `sum([name])` in a measure. */
  columnInsert?: (name: string, type: string) => string;
  onInsert: (text: string, back?: number) => void;
  footer?: ReactNode;
}) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const cols = columns.filter((c) => !q || c.name.toLowerCase().includes(q));
  const fns = docs.filter((d) => !q || d.name.includes(q) || d.summary.toLowerCase().includes(q));
  const extra = groups.map((g) => ({ ...g, items: g.items.filter((it) => !q || it.label.toLowerCase().includes(q)) })).filter((g) => g.items.length);
  const nothing = !loading && !cols.length && !fns.length && !extra.length;
  return (
    <div className={s.side}>
      <Input size="sm" type="search" icon="search" aria-label="Search columns and functions" placeholder="Search columns & functions" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className={s.sideList}>
        {extra.map((g) => (
          <div key={g.title} className={s.fnRow}>
            <div className={s.group}>{g.title}</div>
            {g.items.map((it) => (
              <button key={it.label} type="button" className={`${s.item} ${s.itemCol}`} title={it.title} onClick={() => onInsert(it.insert)}>
                {it.label}
              </button>
            ))}
          </div>
        ))}
        {cols.length > 0 && <div className={s.group}>Columns</div>}
        {cols.map((c) => (
          <button key={c.name} type="button" className={`${s.item} ${s.itemCol}`} title={`${c.type} column`} onClick={() => onInsert(columnInsert(c.name, c.type))}>
            {GLYPH[c.type] ?? 'A'}  {c.name}
          </button>
        ))}
        {fns.map((d, i) => (
          <div key={d.name} className={s.fnRow}>
            {(i === 0 || fns[i - 1].category !== d.category) && <div className={s.group}>{categoryLabel(d.category)}</div>}
            <button
              type="button"
              className={`${s.item} ${s.itemFn}`}
              title={d.insert ? `${d.summary}\n${d.example}` : d.summary}
              onClick={() => (d.insert ? onInsert(d.insert, lodCaretBack(d)) : onInsert(`${d.name}(`))}
            >
              {d.signature}
            </button>
          </div>
        ))}
        {loading && <div className={s.sideEmpty}>Loading functions…</div>}
        {nothing && <div className={s.sideEmpty}>Nothing matches “{search.trim()}”.</div>}
      </div>
      {footer}
    </div>
  );
}
