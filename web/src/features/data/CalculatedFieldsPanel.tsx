// A Live dataset's calculated fields, on its Schema tab (semantic layer part 8, step 04): each field's
// name, formula and type, as `dataset:liveSchema` says, and why one no longer runs. An editor adds, edits
// and deletes them through the formula editor (../prepare/FormulaEditor) against `live:checkCalc`; the
// whole list is saved by `live:setCalculated`, which checks and types each field. Every verdict is the
// server's: this screen formats it.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { ConfirmDelete } from '../../ui/ConfirmDelete';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { EmptyState } from '../../ui/States';
import { useCan } from '../projects/api';
import type { Column } from '../prepare/api';
import { useColumnFormula, type FormulaField } from '../prepare/FormulaEditor';
import { checkLiveCalc, useLiveSchema, useSetCalculated, type CalcField, type LiveSchema } from './liveApi';
import s from './Data.module.css';
import l from './LiveData.module.css';

type Editing = { index: number; field?: CalcField };

function FieldDialog({ projectId, datasetId, schema, editing, onClose }: { projectId: string; datasetId: string; schema: LiveSchema; editing: Editing; onClose: () => void }) {
  const set = useSetCalculated(projectId, datasetId);
  const fields = schema.calculated?.fields ?? [];
  // The columns a formula may name: the warehouse's, then the fields above this one.
  const columns: Column[] = [...schema.columns.map((c) => ({ name: c.name, type: c.type })), ...fields.slice(0, editing.index).map((f) => ({ name: f.name, type: f.type }))];
  const f = useColumnFormula({
    projectId,
    datasetId,
    columns,
    live: true,
    existing: editing.field ? { name: editing.field.name, expression: editing.field.expression } : undefined,
    check: (p, d, e) => checkLiveCalc(p, d, e, editing.index),
    saveLabel: editing.field ? 'Save' : 'Add field',
    onClose,
    onSave: async (field: FormulaField) => {
      const list = fields.map((x) => ({ name: x.name, expression: x.expression }));
      if (editing.field) list[editing.index] = field;
      else list.push(field);
      const r = await set.mutateAsync(list).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : undefined }));
      return r.ok ? null : (r.error ?? 'The calculated field could not be saved.');
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={editing.field ? `Edit “${editing.field.name}”` : 'New calculated field'}
      description="Computed in the warehouse by every chart, KPI and answer that reads it." footer={f.footer}>
      {f.body}
    </Dialog>
  );
}

export function CalculatedFieldsPanel({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const q = useLiveSchema(projectId, datasetId);
  const set = useSetCalculated(projectId, datasetId);
  const editor = useCan(projectId)('editor');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The Schema panel above shows the loading and error states of the same reply.
  if (!q.data?.calculated) return null;
  const v = q.data.calculated;
  const fields = v.fields;
  // A restricted reader gets names only: nobody can save a list it cannot read back in full.
  const canEdit = editor && v.allowed && !fields.some((f) => f.hidden);
  const remove = (i: number) =>
    set.mutate(
      fields.filter((_, k) => k !== i).map((x) => ({ name: x.name, expression: x.expression })),
      {
        onSuccess: (r) => (r.ok ? (setDeleting(null), setError(null)) : setError(r.error ?? 'The calculated field could not be deleted.')),
        onError: (err) => setError(err.message),
      },
    );
  return (
    <section className={`${s.section} ${l.calcSection}`} aria-label="Calculated fields">
      <div className={l.schemaHead}>
        <div className={l.schemaFacts}>
          <h3 className={l.calcTitle}>Calculated fields · run in the warehouse</h3>
          {!v.allowed && v.why && <p className={l.warnNote}>{v.why}</p>}
        </div>
        {canEdit && (
          <Button icon="plus" size="sm" onClick={() => setEditing({ index: fields.length })}>
            Add calculated field
          </Button>
        )}
      </div>
      {error && (
        <p className={s.rowError} role="alert">
          {error}
        </p>
      )}
      {fields.length === 0 ? (
        <EmptyState icon="function" heading={3} title="No calculated fields">
          {v.allowed ? 'Add one to compute a column in the warehouse, such as [revenue] - [cost].' : 'Make a copy to add calculated fields as Prepare steps.'}
        </EmptyState>
      ) : (
        <div className={s.card}>
          <table className={`${s.table} ${l.schemaTable}`}>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Formula</th>
                <th scope="col">Type</th>
                {canEdit && <th scope="col"><span className={l.srOnly}>Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {fields.map((f, i) => (
                <tr key={f.name} data-calc={f.name} className={f.problem ? l.calcBroken : undefined}>
                  <td className={s.strong}>
                    {f.problem && <Icon name="alert" size={12} />} {f.name}
                  </td>
                  <td>
                    {f.hidden ? <span className={s.muted}>formula hidden</span> : <code className={l.calcFormula}>{f.expression}</code>}
                    {f.problem && <p className={l.calcProblem}>{f.problem}</p>}
                  </td>
                  <td>
                    <span className={s.typeChip}>{f.type}</span>
                  </td>
                  {canEdit && (
                    <td className={l.calcActions}>
                      <Button size="sm" variant="ghost" icon="pencil" onClick={() => setEditing({ index: i, field: f })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" icon="trash" onClick={() => setDeleting(i)}>
                        Delete
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <FieldDialog projectId={projectId} datasetId={datasetId} schema={q.data} editing={editing} onClose={() => setEditing(null)} />}
      {deleting !== null && fields[deleting] && (
        <ConfirmDelete
          title={`Delete “${fields[deleting].name}”?`}
          description="Charts, KPIs and filters that read it will say it is not a column of this dataset."
          busy={set.isPending}
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
