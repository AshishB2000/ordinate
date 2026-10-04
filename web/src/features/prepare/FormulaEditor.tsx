// ONE formula editor (legacy formulaEditor.ts): every place a calculated field
// is written opens this — a new step, a step's ✎, and an Assistant suggestion
// (prefilled, so a model's proposal is seen on real rows before it is kept).
//
// It does not know whether a formula is valid. Every verdict — the tokens it
// colours, the error and its position, the unknown columns, the result type,
// the eight preview rows — comes from `formula:check` on the server, which runs
// the SAME compile() the pipeline runs on save. A textarea cannot colour its own
// text, so a mirror <pre> behind a transparent-text textarea paints the
// server's tokens; the two share one CSS rule so the colours never drift.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { checkFormula, useFunctionDocs, type Column, type FormulaCheck, type FValue } from './api';
import { categoryLabel, highlightRuns, lodCaretBack, popContext, type PopItem } from './formulaParts';
import s from './Formula.module.css';

/** How long typing has to stop before the server is asked. */
const DEBOUNCE = 180;
const GLYPH: Record<string, string> = { number: '#', date: '⏱', text: 'A' };

export interface FormulaField {
  name: string;
  expression: string;
}

export function FormulaEditor({
  projectId,
  datasetId,
  columns,
  existing,
  onSave,
  onClose,
}: {
  projectId: string;
  datasetId: string;
  columns: readonly Column[];
  /** An existing step being edited, or a suggestion to review (with a note). */
  existing?: { name?: string; expression?: string; note?: string };
  /** Resolves to an error message (the editor stays open), or null when it landed. */
  onSave: (field: FormulaField) => Promise<string | null>;
  onClose: () => void;
}) {
  const editingName = existing?.name ?? '';
  const [name, setName] = useState(editingName);
  const [expr, setExpr] = useState(existing?.expression ?? '');
  const [last, setLast] = useState<FormulaCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [search, setSearch] = useState('');
  const [pop, setPop] = useState<{ items: PopItem[]; from: number; index: number } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const docs = useFunctionDocs();
  const fnNames = useMemo(() => new Set((docs.data ?? []).map((d) => d.name)), [docs.data]);
  const input = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLPreElement>(null);
  const seq = useRef(0);

  // One check per pause in typing; a slower earlier reply never overwrites a newer one.
  useEffect(() => {
    const mine = ++seq.current;
    if (!expr.trim()) {
      setLast(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    const t = setTimeout(() => {
      checkFormula(projectId, datasetId, expr).then(
        (res) => mine === seq.current && (setLast(res), setChecking(false)),
        () => mine === seq.current && (setLast({ tokens: [], ok: false, error: 'Could not check the formula.', refs: [], unknownRefs: [], resultType: null, sample: { columns: [], rows: [] } }), setChecking(false)),
      );
    }, DEBOUNCE);
    return () => clearTimeout(t);
  }, [expr, projectId, datasetId]);

  const nameProblem = !name.trim()
    ? 'Give the new column a name.'
    : columns.some((c) => c.name === name.trim()) && name.trim() !== editingName
      ? `“${name.trim()}” is already a column in this dataset.`
      : '';
  const reason = !expr.trim() ? 'Write an expression first.' : checking || !last ? 'Checking…' : !last.ok ? (last.error ?? 'The formula does not compile.') : nameProblem;

  function edit(next: string, caret: number) {
    setExpr(next);
    setSaveError(null);
    const ctx = popContext(next.slice(0, caret), columns, docs.data ?? []);
    setPop(ctx ? { ...ctx, index: 0 } : null);
  }

  /** Insert at the caret (the side list); `back` leaves the caret that many characters before the end. */
  function insert(text: string, back = 0) {
    const el = input.current;
    const a = el?.selectionStart ?? expr.length;
    const b = el?.selectionEnd ?? a;
    const next = expr.slice(0, a) + text + expr.slice(b);
    const pos = a + text.length - back;
    setExpr(next);
    setPop(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  function accept(i: number) {
    const it = pop?.items[i];
    const el = input.current;
    if (!it || !pop || !el) return;
    const caret = el.selectionStart ?? expr.length;
    const next = expr.slice(0, pop.from) + it.insert + expr.slice(caret);
    const pos = pop.from + it.insert.length;
    setExpr(next);
    setPop(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void save();
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

  async function save() {
    if (reason || saving) return;
    setSaving(true);
    const err = await onSave({ name: name.trim(), expression: expr.trim() });
    setSaving(false);
    if (err) setSaveError(err);
    else onClose();
  }

  const q = search.trim().toLowerCase();
  const cols = columns.filter((c) => !q || c.name.toLowerCase().includes(q));
  const fns = (docs.data ?? []).filter((d) => !q || d.name.includes(q) || d.summary.toLowerCase().includes(q));
  const at = last && !last.ok ? (last.at ?? null) : null;
  const runs = highlightRuns(expr, last?.tokens ?? [], at, fnNames);
  const sample = last?.ok ? last.sample : null;
  const lodFrom = sample ? sample.columns.length - (sample.lodColumns ?? 0) : 0;
  const isNum = (v: FValue | undefined) => typeof v === 'number';
  const cell = (v: FValue) => (v === null || v === undefined ? '—' : String(v));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={editingName ? 'Edit calculated field' : 'New calculated field'}
      footer={
        <>
          <span className={s.hint}>
            <Kbd>⌘↵</Kbd> to save
          </span>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <span title={reason} className={s.saveWrap}>
            <Button variant="primary" disabled={!!reason} loading={saving} title={reason} onClick={() => void save()}>
              Save
            </Button>
          </span>
        </>
      }
    >
      {existing?.note && <p className={s.note}>{existing.note}</p>}
      <div className={s.body}>
        <div className={s.side}>
          <Input size="sm" type="search" icon="search" aria-label="Search columns and functions" placeholder="Search columns & functions" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className={s.sideList}>
            {cols.length > 0 && <div className={s.group}>Columns</div>}
            {cols.map((c) => (
              <button key={c.name} type="button" className={`${s.item} ${s.itemCol}`} title={`${c.type} column`} onClick={() => insert(`[${c.name}]`)}>
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
                  onClick={() => (d.insert ? insert(d.insert, lodCaretBack(d)) : insert(`${d.name}(`))}
                >
                  {d.signature}
                </button>
              </div>
            ))}
            {docs.isPending && <div className={s.sideEmpty}>Loading functions…</div>}
            {!docs.isPending && !cols.length && !fns.length && <div className={s.sideEmpty}>Nothing matches “{search.trim()}”.</div>}
          </div>
        </div>

        <div className={s.main}>
          <div className={s.nameRow}>
            <Input size="sm" aria-label="New column name" placeholder="New column name" value={name} onChange={(e) => (setName(e.target.value), setSaveError(null))} />
            {last?.ok && last.resultType && <span className={`${s.badge} ${s[`badge_${last.resultType}`] ?? ''}`}>{last.resultType}</span>}
          </div>
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
              aria-label="Expression"
              aria-autocomplete="list"
              aria-controls={pop ? 'fx-pop' : undefined}
              aria-activedescendant={pop ? `fx-pop-${pop.index}` : undefined}
              value={expr}
              autoFocus
              onChange={(e) => edit(e.target.value, e.target.selectionStart)}
              onClick={(e) => edit(expr, e.currentTarget.selectionStart)}
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
          <div className={s.msgs} aria-live="polite">
            {last && !last.ok && expr.trim() && <p className={s.err}>{last.error}</p>}
            {last?.ok &&
              last.unknownRefs.map((u) => (
                <p key={u.name} className={s.err}>
                  [{u.name}] is not a column.{u.didYouMean ? ` Did you mean [${u.didYouMean}]?` : ''}
                </p>
              ))}
            {nameProblem && name.trim() && <p className={s.err}>{nameProblem}</p>}
            {saveError && <p className={s.err} role="alert">{saveError}</p>}
          </div>
          <div className={s.preview}>
            {sample && sample.rows.length > 0 ? (
              <table className={s.table}>
                <thead>
                  <tr>
                    {sample.columns.map((c, i) => (
                      <th key={c + i} className={[isNum(sample.rows[0].inputs[i]) && s.num, i >= lodFrom && s.lodCol].filter(Boolean).join(' ') || undefined} title={i >= lodFrom ? `${c}\nComputed over the whole table, not just these rows.` : undefined}>
                        {c}
                      </th>
                    ))}
                    <th className={[s.res, isNum(sample.rows[0].result) && s.num].filter(Boolean).join(' ')}>{name.trim() || 'Result'}</th>
                  </tr>
                </thead>
                <tbody>
                  {sample.rows.map((r, k) => (
                    <tr key={k}>
                      {r.inputs.map((v, i) => (
                        <td key={i} className={[isNum(v) && s.num, i >= lodFrom && s.lodCell].filter(Boolean).join(' ') || undefined}>
                          {cell(v)}
                        </td>
                      ))}
                      <td className={[s.res, isNum(r.result) && s.num].filter(Boolean).join(' ')}>{cell(r.result)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              last?.ok && <p className={s.sideEmpty}>This dataset has no rows to preview.</p>
            )}
            {sample?.note && <p className={s.lodNote}>{sample.note}</p>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
