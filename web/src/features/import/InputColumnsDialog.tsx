// New input table, and Edit columns (legacy inputColumns.ts): one dialog that
// defines an input table's columns — name, type, required, and "values from"
// another dataset's column (a LOOKUP: its values become the cell's
// suggestions, and anything else typed there is flagged). A lookup column's
// type follows its key's, so the two always compare. The server re-checks
// every definition; the checks here only shape the form.

import { useState } from 'react';
import { rpc } from '../../api/client';
import { Button, IconButton } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { EmptyState } from '../../ui/States';
import { useLookupChoices, type ColType, type InputColumn, type TableReply } from './api';
import s from './Import.module.css';

interface Draft {
  name: string;
  type: ColType;
  required: boolean;
  lookup: { datasetId: string; column: string } | null;
  /** The column this one was in the saved table, or -1 for a new one (Edit columns). */
  from: number;
}

const TEMPLATES: readonly { id: string; label: string; hint: string; columns: Omit<Draft, 'lookup' | 'from'>[] }[] = [
  { id: 'Targets', label: 'Targets', hint: 'A goal per region and month', columns: [
    { name: 'region', type: 'text', required: true }, { name: 'month', type: 'date', required: false }, { name: 'target', type: 'number', required: true },
  ] },
  { id: 'Budget', label: 'Budget', hint: 'Planned spend by department', columns: [
    { name: 'department', type: 'text', required: true }, { name: 'month', type: 'date', required: false },
    { name: 'amount', type: 'number', required: true }, { name: 'owner', type: 'text', required: false },
  ] },
  { id: 'Mapping', label: 'Mapping', hint: 'Translate one code to another', columns: [
    { name: 'from', type: 'text', required: true }, { name: 'to', type: 'text', required: true },
  ] },
  { id: 'Notes', label: 'Notes', hint: 'Dated notes to annotate charts', columns: [
    { name: 'date', type: 'date', required: true }, { name: 'note', type: 'text', required: false },
  ] },
];

const TYPES: readonly { value: ColType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
];

interface Props {
  projectId: string;
  mode: 'create' | 'edit';
  /** Edit: the table and its current columns. */
  datasetId?: string;
  columns?: readonly InputColumn[];
  onClose: () => void;
  /** Create: the new table's id. Edit: also the server's reply (the reloaded table). */
  onDone: (id: string, view?: Extract<TableReply, { ok: true }>) => void;
}

export function InputColumnsDialog({ projectId, mode, datasetId, columns = [], onClose, onDone }: Props) {
  const creating = mode === 'create';
  const choices = useLookupChoices(projectId, datasetId, true);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    columns.map((c, i) => ({ name: c.name, type: c.type, required: !!c.required, lookup: c.lookup ?? null, from: i })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const keyType = (lk: Draft['lookup']): ColType | null =>
    (lk && choices.data?.find((d) => d.id === lk.datasetId)?.columns.find((c) => c.name === lk.column)?.type) || null;
  const lookupOptions = [
    { value: '', label: 'Any value' },
    ...(choices.data ?? []).flatMap((d) => d.columns.map((c) => ({ value: JSON.stringify([d.id, c.name]), label: `${d.name} · ${c.name}` }))),
  ];
  const set = (i: number, patch: Partial<Draft>) => setDrafts((all) => all.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  const add = () => setDrafts((all) => [...all, { name: '', type: 'text', required: false, lookup: null, from: -1 }]);
  const removed = columns.length - drafts.filter((d) => d.from >= 0).length;

  const save = async () => {
    setError(null);
    setSaving(true);
    const defs = drafts.map((d): InputColumn => {
      const type = keyType(d.lookup) ?? d.type;
      return { name: d.name.trim(), type, ...(d.required ? { required: true } : {}), ...(d.lookup ? { lookup: d.lookup } : {}) };
    });
    try {
      if (creating) {
        const r = (await rpc('input:create', { projectId, name: name.trim(), columns: defs })) as { ok: true; id: string } | { ok: false; error: string };
        if (!r.ok) return setError(r.error);
        onDone(r.id);
      } else if (datasetId) {
        const r = (await rpc('input:setColumns', { projectId, id: datasetId, columns: defs, from: drafts.map((d) => d.from) })) as TableReply;
        if (!r.ok) return setError(r.error);
        onDone(datasetId, r);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The columns could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={creating ? 'New input table' : 'Edit columns'}
      description={
        creating
          ? 'A small table you type into — targets, a budget, a mapping. It is an ordinary dataset: chart it, join it, alert on it.'
          : 'Rename, retype or add columns. Values move with their column; anything that no longer fits its type is kept and flagged.'
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={saving} onClick={() => void save()} disabled={drafts.length === 0}>
            {creating ? 'Create table' : 'Save columns'}
          </Button>
        </>
      }
    >
      <div className={s.colsForm}>
        {creating && (
          <>
            <Input label="Name" value={name} maxLength={120} placeholder="e.g. Regional targets" onChange={(e) => setName(e.target.value)} />
            <div className={s.templates} role="group" aria-label="Start from">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={template === t.id}
                  className={template === t.id ? `${s.template} ${s.templateOn}` : s.template}
                  onClick={() => {
                    setTemplate(t.id);
                    setDrafts(t.columns.map((c) => ({ ...c, lookup: null, from: -1 })));
                    if (!name.trim()) setName(t.id);
                  }}
                >
                  <span className={s.templateLabel}>{t.label}</span>
                  <span className={s.templateHint}>{t.hint}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {drafts.length === 0 ? (
          <EmptyState compact heading={3} icon="table" title="Define your columns" actions={<Button icon="plus" onClick={add}>Add column</Button>}>
            Pick a starting point above, or add the columns one by one.
          </EmptyState>
        ) : (
          <div className={s.colsTable} role="list" aria-label="Columns">
            <div className={s.colsHead} aria-hidden="true">
              <span>Column</span>
              <span>Type</span>
              <span>Required</span>
              <span>Values from</span>
              <span />
            </div>
            {drafts.map((d, i) => {
              const kt = keyType(d.lookup);
              return (
                <div key={i} className={s.colRow} role="listitem">
                  <Input size="sm" aria-label={`Column ${i + 1} name`} placeholder={`column${i + 1}`} maxLength={100} value={d.name} onChange={(e) => set(i, { name: e.target.value })} />
                  <Select
                    size="sm"
                    aria-label={`Column ${i + 1} type`}
                    value={kt ?? d.type}
                    options={TYPES}
                    disabled={!!kt}
                    onValueChange={(v) => set(i, { type: v as ColType })}
                  />
                  <Checkbox label="Required" checked={d.required} onCheckedChange={(c) => set(i, { required: c })} />
                  <Select
                    size="sm"
                    aria-label={`Column ${i + 1} values from another dataset`}
                    value={d.lookup ? JSON.stringify([d.lookup.datasetId, d.lookup.column]) : ''}
                    options={lookupOptions}
                    onValueChange={(v) => {
                      const pair = v ? (JSON.parse(v) as [string, string]) : null;
                      set(i, { lookup: pair ? { datasetId: pair[0], column: pair[1] } : null });
                    }}
                  />
                  <IconButton icon="trash" size="sm" label={`Remove column ${i + 1}`} onClick={() => setDrafts((all) => all.filter((_, k) => k !== i))} />
                </div>
              );
            })}
          </div>
        )}
        {drafts.length > 0 && (
          <Button className={s.addCol} size="sm" variant="ghost" icon="plus" onClick={add}>
            Add column
          </Button>
        )}
        {removed > 0 && (
          <p className={s.colsWarn}>
            Removing {removed === 1 ? 'a column deletes its values' : `${removed} columns deletes their values`}. The table before this change stays in its history.
          </p>
        )}
        {error && (
          <p className={s.colsErr} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
