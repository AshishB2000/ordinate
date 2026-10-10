// ONE formula editor (legacy formulaEditor.ts): every place a calculated field
// is written opens this — a new step, a step's ✎, an Assistant suggestion
// (prefilled, so a model's proposal is seen on real rows before it is kept) and
// the chart builder's "Column" kind (../calc), which lays the same body out
// inside its own dialog through `useColumnFormula`.
//
// It does not know whether a formula is valid. Every verdict — the tokens it
// colours, the error and its position, the unknown columns, the result type,
// the eight preview rows — comes from `formula:check` on the server, which runs
// the SAME compile() the pipeline runs on save. A textarea cannot colour its own
// text, so a mirror <pre> behind a transparent-text textarea paints the
// server's tokens (./FormulaPieces); the two share one CSS rule so the colours
// never drift.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Kbd } from '../../ui/Kbd';
import { checkFormula, useFunctionDocs, type Column, type FormulaCheck, type FValue } from './api';
import { FormulaInput, FormulaSide, type FormulaInputHandle } from './FormulaPieces';
import s from './Formula.module.css';

/** How long typing has to stop before the server is asked. */
const DEBOUNCE = 180;

export interface FormulaField {
  name: string;
  expression: string;
}

export interface ColumnFormulaProps {
  projectId: string;
  datasetId: string;
  columns: readonly Column[];
  /** An existing step being edited, or a suggestion to review (with a note). */
  existing?: { name?: string; expression?: string; note?: string };
  /** Resolves to an error message (the editor stays open), or null when it landed. */
  onSave: (field: FormulaField) => Promise<string | null>;
  onClose: () => void;
  /** The primary button's word, and what is said while the save runs. */
  saveLabel?: string;
  savingNote?: string;
}

/** The editor's body and footer, for whichever dialog lays them out; `fill` writes a template into the boxes. */
export function useColumnFormula({ projectId, datasetId, columns, existing, onSave, onClose, saveLabel = 'Save', savingNote }: ColumnFormulaProps): {
  body: ReactNode;
  footer: ReactNode;
  fill: (field: Partial<FormulaField>) => void;
  name: string;
} {
  const editingName = existing?.name ?? '';
  const [name, setName] = useState(editingName);
  const [expr, setExpr] = useState(existing?.expression ?? '');
  const [last, setLast] = useState<FormulaCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const docs = useFunctionDocs();
  const input = useRef<FormulaInputHandle>(null);
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

  async function save() {
    if (reason || saving) return;
    setSaving(true);
    const err = await onSave({ name: name.trim(), expression: expr.trim() });
    setSaving(false);
    if (err) setSaveError(err);
    else onClose();
  }

  const at = last && !last.ok ? (last.at ?? null) : null;
  const sample = last?.ok ? last.sample : null;
  const lodFrom = sample ? sample.columns.length - (sample.lodColumns ?? 0) : 0;
  const isNum = (v: FValue | undefined) => typeof v === 'number';
  const cell = (v: FValue) => (v === null || v === undefined ? '—' : String(v));

  const body = (
    <>
      {existing?.note && <p className={s.note}>{existing.note}</p>}
      <div className={s.body}>
        <FormulaSide columns={columns} docs={docs.data ?? []} loading={docs.isPending} onInsert={(text, back) => input.current?.insert(text, back)} />

        <div className={s.main}>
          <div className={s.nameRow}>
            <Input size="sm" aria-label="New column name" placeholder="New column name" value={name} onChange={(e) => (setName(e.target.value), setSaveError(null))} />
            {last?.ok && last.resultType && <span className={`${s.badge} ${s[`badge_${last.resultType}`] ?? ''}`}>{last.resultType}</span>}
          </div>
          <FormulaInput
            ref={input}
            value={expr}
            onChange={(next) => (setExpr(next), setSaveError(null))}
            tokens={last?.tokens ?? []}
            at={at}
            columns={columns}
            docs={docs.data ?? []}
            autoFocus
            onSubmit={() => void save()}
          />
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
            {saving && savingNote && <p className={s.working} role="status">{savingNote}</p>}
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
    </>
  );

  const footer = (
    <>
      <span className={s.hint}>
        <Kbd>⌘↵</Kbd> to save
      </span>
      <DialogClose asChild>
        <Button>Cancel</Button>
      </DialogClose>
      <span title={reason} className={s.saveWrap}>
        <Button variant="primary" disabled={!!reason} loading={saving} title={reason} onClick={() => void save()}>
          {saveLabel}
        </Button>
      </span>
    </>
  );

  const fill = (field: Partial<FormulaField>) => {
    if (field.expression !== undefined) setExpr(field.expression);
    if (field.name !== undefined) setName(field.name);
    setSaveError(null);
  };
  return { body, footer, fill, name };
}

export function FormulaEditor(props: ColumnFormulaProps) {
  const f = useColumnFormula(props);
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()} size="lg" title={props.existing?.name ? 'Edit calculated field' : 'New calculated field'} footer={f.footer}>
      {f.body}
    </Dialog>
  );
}
