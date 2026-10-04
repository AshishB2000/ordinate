// The Query tab's SQL editor (queryEditor.ts) and its parameters row
// (queryParams.ts). The connection workbench's own editor surface — the same
// transparent textarea over a painted mirror, the same lexer and CSS — with
// this tab's vocabulary: the project's datasets and their columns.
//
// Keys: ⌘/Ctrl+Enter runs; with the list open the arrows / Enter / Tab /
// Escape belong to it. Tab indents — Escape first, and the next Tab leaves the
// editor, so the keyboard is never trapped (WCAG 2.1.2). The parameters row
// only COLLECTS values: the server binds them, nothing splices a value in.

import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Button } from '../../../ui/Button';
import { Input } from '../../../ui/Field';
import { Kbd } from '../../../ui/Kbd';
import { Select } from '../../../ui/Select';
import { highlight } from '../../connections/sqlLex';
import { completions, scan, type Completion, type ParamEntry, type ParamKind, type SchemaDataset } from './sqlText';
import w from '../../connections/Workbench.module.css';
import s from './Sql.module.css';

const HL: Record<string, string> = { kw: w.tKw, str: w.tStr, num: w.tNum, id: w.tId, com: w.tCom };
const KINDS: Array<{ value: ParamKind; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'list', label: 'List' },
];

export function QueryEditor({
  input,
  sql,
  onSql,
  placeholder,
  schema,
  busy,
  canSave,
  saving,
  onRun,
  onExplain,
  onSave,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  sql: string;
  onSql: (sql: string) => void;
  placeholder: string;
  schema: readonly SchemaDataset[];
  busy: 'run' | 'explain' | null;
  canSave: boolean;
  saving: boolean;
  onRun: () => void;
  onExplain: () => void;
  onSave: () => void;
}) {
  const mirror = useRef<HTMLPreElement>(null);
  const [items, setItems] = useState<Completion[]>([]);
  const [active, setActive] = useState(0);
  const [from, setFrom] = useState(-1);
  const escaped = useRef(false);

  function suggest(text: string, caret: number) {
    const before = text.slice(0, caret);
    const m = /[A-Za-z_][A-Za-z0-9_$]*$/.exec(before);
    if (!m || m[0].length < 2) return setItems([]);
    let at = caret - m[0].length;
    const afterDot = before[at - 1] === '.';
    // Completing inside an opened quote replaces the quote too: never `""Retail orders"`.
    if (before[at - 1] === '"') at -= 1;
    const list = completions(m[0], afterDot, text, schema);
    const done = list.length === 1 && list[0].label.toLowerCase() === m[0].toLowerCase();
    setItems(done ? [] : list);
    setActive(0);
    setFrom(at);
  }

  function accept(i: number) {
    const el = input.current;
    const item = items[i];
    if (!el || !item || from < 0) return;
    const caret = el.selectionStart ?? 0;
    onSql(el.value.slice(0, from) + item.insert + el.value.slice(caret));
    setItems([]);
    const at = from + item.insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
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
    } else if (e.key === 'Escape') {
      escaped.current = true;
      return;
    } else if (e.key === 'Tab' && !e.shiftKey && !escaped.current) {
      e.preventDefault();
      const el = e.currentTarget;
      const at = el.selectionStart ?? 0;
      onSql(el.value.slice(0, at) + '  ' + el.value.slice(el.selectionEnd ?? at));
      requestAnimationFrame(() => el.setSelectionRange(at + 2, at + 2));
    }
    if (e.key !== 'Shift') escaped.current = false;
  }

  const listId = 'qt-ac';
  return (
    <div className={w.editor}>
      <div className={w.editWrap}>
        <pre className={w.hl} ref={mirror} aria-hidden="true">
          {highlight(sql).map((r, i) => (r.cls ? <span key={i} className={HL[r.cls]}>{r.text}</span> : r.text))}
          {'\n'}
        </pre>
        <textarea
          ref={input}
          className={w.input}
          value={sql}
          aria-label="SQL"
          aria-describedby="qt-sql-keys"
          placeholder={placeholder}
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
        <span id="qt-sql-keys" className={s.sr}>
          Tab indents. Press Escape, then Tab, to leave the editor.
        </span>
        {items.length > 0 && (
          <div className={w.ac} id={listId} role="listbox" aria-label="Completions">
            {items.map((it, i) => (
              <div
                key={it.label}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? `${w.acItem} ${w.acOn}` : w.acItem}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(i);
                }}
              >
                <span className={w.acLabel}>{it.insert}</span>
                <span className={w.acSub}>{it.sub}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={w.bar}>
        <Button size="sm" variant="primary" icon="play" loading={busy === 'run'} disabled={busy !== null && busy !== 'run'} onClick={onRun}>
          Run
        </Button>
        <Button size="sm" icon="circle-check" loading={busy === 'explain'} disabled={busy !== null && busy !== 'explain'} onClick={onExplain}>
          Explain
        </Button>
        <span className={w.gap} />
        <Button size="sm" icon="download" disabled={!canSave} loading={saving} onClick={onSave} title={canSave ? undefined : 'Run the query first — a saved dataset is the result you saw.'}>
          {saving ? 'Fetching rows…' : 'Save as dataset'}
        </Button>
      </div>
      <p className={w.hint}>
        <Kbd>⌘/Ctrl</Kbd> <Kbd>↩</Kbd> runs · Run previews 500 rows · <code className={s.code}>[[name]]</code> makes a parameter · Esc then Tab leaves the editor
      </p>
    </div>
  );
}

/** One typed field per `[[name]]` in the SQL, kept by name across edits. */
export function ParamsRow({ sql, state, onChange, onRun }: { sql: string; state: ReadonlyMap<string, ParamEntry>; onChange: (name: string, e: ParamEntry) => void; onRun: () => void }) {
  const names = scan(sql).params;
  if (!names.length) return null;
  return (
    <div className={s.params} role="group" aria-label="Parameters">
      <span className={s.paramsLabel}>Parameters</span>
      {names.map((n) => {
        const st = state.get(n);
        if (!st) return null;
        return (
          <div key={n} className={s.param}>
            <span className={s.paramName}>{n}</span>
            <div className={s.paramKind}>
              <Select size="sm" aria-label={`Type of ${n}`} value={st.kind} options={KINDS} onValueChange={(k) => onChange(n, { kind: k as ParamKind, value: '' })} />
            </div>
            <Input
              size="sm"
              className={s.paramValue}
              aria-label={`Value of ${n}`}
              type={st.kind === 'number' ? 'number' : st.kind === 'date' ? 'date' : 'text'}
              placeholder={st.kind === 'list' ? 'a, b, c' : st.kind === 'number' ? '0' : st.kind === 'date' ? '' : 'value'}
              value={st.value}
              onChange={(e) => onChange(n, { kind: st.kind, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onRun();
                }
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
