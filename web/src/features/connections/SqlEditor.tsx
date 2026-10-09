// The workbench's SQL editor (legacy connEditor.ts): a transparent <textarea>
// over a mirror <pre> that paints the same text in spans (one CSS rule pins
// both to the same metrics), a completion list under it, and the bar — Run,
// Explain, Save query, the import row limit.
//
// Keys: ⌘/Ctrl+Enter runs, ⌘/Ctrl+S saves the query; with the list open the
// arrows / Enter / Tab / Escape belong to it. Tab indents — press Escape first
// and the next Tab leaves the editor, so the keyboard is never trapped.

import { useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { Select } from '../../ui/Select';
import { useCaret } from '../../ui/useCaret';
import { completions, highlight, quoteQualified, wordBefore, type Completion } from './sqlLex';
import s from './Workbench.module.css';

export const IMPORT_LIMITS = [
  { value: '10000', label: '10,000 rows' },
  { value: '100000', label: '100,000 rows' },
  { value: '1000000', label: '1,000,000 rows' },
];

const HL: Record<string, string> = { kw: s.tKw, str: s.tStr, num: s.tNum, id: s.tId, com: s.tCom };

export function SqlEditor({
  sql,
  onSql,
  family,
  tables,
  columns,
  limit,
  onLimit,
  busy,
  onRun,
  onExplain,
  onSave,
  estimate = null,
}: {
  sql: string;
  onSql: (sql: string) => void;
  family: string;
  tables: readonly string[];
  columns: ReadonlyMap<string, readonly string[]>;
  limit: string;
  onLimit: (v: string) => void;
  busy: 'run' | 'explain' | null;
  onRun: () => void;
  onExplain: () => void;
  onSave: () => void;
  /** What the statement would read, by Run — only for a source that prices one (BigQuery). */
  estimate?: { text: string; title: string; muted?: boolean } | null;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLPreElement>(null);
  const place = useCaret(input);
  const [items, setItems] = useState<Completion[]>([]);
  const [active, setActive] = useState(0);
  const [from, setFrom] = useState(-1);
  const escaped = useRef(false);

  function suggest(text: string, caret: number) {
    const w = wordBefore(text, caret);
    const list = w.word.length < 2 ? [] : completions(w.word, tables, columns);
    // An exact single match is nothing left to choose.
    const done = list.length === 1 && list[0].text.toLowerCase() === w.word.toLowerCase();
    setItems(done ? [] : list);
    setActive(0);
    setFrom(w.from);
  }

  function accept(i: number) {
    const el = input.current;
    const item = items[i];
    if (!el || !item || from < 0) return;
    const caret = el.selectionStart ?? 0;
    const insert = item.kind === 'keyword' ? item.text : quoteQualified(family, item.text);
    const next = el.value.slice(0, from) + insert + el.value.slice(caret);
    onSql(next);
    setItems([]);
    const at = from + insert.length;
    place(at);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const mod = e.metaKey || e.ctrlKey;
    if (items.length > 0 && !mod) {
      const moves: Record<string, () => void> = {
        ArrowDown: () => setActive((active + 1) % items.length),
        ArrowUp: () => setActive((active - 1 + items.length) % items.length),
        Enter: () => accept(active),
        Tab: () => accept(active),
        Escape: () => setItems([]),
      };
      if (moves[e.key]) {
        e.preventDefault();
        moves[e.key]();
        return;
      }
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      setItems([]);
      onRun();
    } else if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      setItems([]);
      onSave();
    } else if (e.key === 'Escape') {
      escaped.current = true;
      return;
    } else if (e.key === 'Tab' && !e.shiftKey && !escaped.current) {
      e.preventDefault();
      const el = e.currentTarget;
      const at = el.selectionStart ?? 0;
      onSql(el.value.slice(0, at) + '  ' + el.value.slice(el.selectionEnd ?? at));
      place(at + 2);
    }
    escaped.current = false;
  }

  const listId = 'conn-wb-ac';
  return (
    <div className={s.editor}>
      <div className={s.editWrap}>
        <pre className={s.hl} ref={mirror} aria-hidden="true">
          {highlight(sql).map((r, i) => (r.cls ? <span key={i} className={HL[r.cls]}>{r.text}</span> : r.text))}
          {'\n'}
        </pre>
        <textarea
          ref={input}
          className={s.input}
          value={sql}
          aria-label="SQL"
          placeholder="select …"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            onSql(e.target.value);
            suggest(e.target.value, e.target.selectionStart ?? 0);
          }}
          onKeyDown={onKeyDown}
          onClick={() => setItems([])}
          onBlur={() => setItems([])}
          onScroll={(e) => {
            if (mirror.current) {
              mirror.current.scrollTop = e.currentTarget.scrollTop;
              mirror.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
        />
        {items.length > 0 && (
          <div className={s.ac} id={listId} role="listbox" aria-label="Completions">
            {items.map((it, i) => (
              <div
                key={`${it.kind} ${it.text}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? `${s.acItem} ${s.acOn}` : s.acItem}
                // mousedown, not click: the textarea's blur would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(i);
                }}
              >
                <span className={s.acLabel}>{it.text}</span>
                <span className={s.acSub}>{it.sub}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={s.bar}>
        <Button size="sm" variant="primary" icon="play" loading={busy === 'run'} onClick={onRun}>
          Run
        </Button>
        {estimate && (
          <span className={estimate.muted ? `${s.estimate} ${s.estimateMuted}` : s.estimate} title={estimate.title} role="status" aria-label={`Estimate: ${estimate.text}`}>
            {estimate.text}
          </span>
        )}
        <Button size="sm" icon="circle-check" loading={busy === 'explain'} onClick={onExplain}>
          Explain
        </Button>
        <Button size="sm" icon="star" onClick={onSave}>
          Save query
        </Button>
        <span className={s.gap} />
        <span className={s.limitLabel}>
          Import up to
        </span>
        <Select size="sm" aria-label="Import up to" value={limit} onValueChange={onLimit} options={IMPORT_LIMITS} />
      </div>
      <p className={s.hint}>
        <Kbd>⌘/Ctrl</Kbd> <Kbd>↩</Kbd> runs · <Kbd>⌘/Ctrl</Kbd> <Kbd>S</Kbd> saves the query · Run previews 500 rows · Esc then Tab leaves the editor
      </p>
    </div>
  );
}
