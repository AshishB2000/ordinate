// One dialog for a filter control — kind, dataset, column, label — add and edit
// alike (legacy dashAddControl.ts openControlDialog). There is no separate
// default field: the preview IS a working widget, and whatever it is left on
// becomes the default. It writes to local state only — no card yet to filter.

import { useState } from 'react';
import { useDatasetColumns, useDatasets } from '../../../api/datasets';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import type { Card, ControlKind, ControlValue } from '../api';
import { ControlWidget } from './ControlWidget';
import s from './Dialogs.module.css';

type Control = NonNullable<Card['control']>;

export const KINDS: { kind: ControlKind; label: string; hint: string }[] = [
  { kind: 'dropdown', label: 'Dropdown', hint: 'Pick one value' },
  { kind: 'multi', label: 'Multi-select', hint: 'Pick several values' },
  { kind: 'date_range', label: 'Date range', hint: 'From and to dates' },
  { kind: 'parameter', label: 'Parameter', hint: 'A value you slide or type' },
];
export const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.kind, k.label]));

export function ControlDialog({
  projectId,
  existing,
  onDone,
  onParameter,
  onClose,
}: {
  projectId: string;
  existing?: Control;
  onDone: (c: Control) => void;
  /** "Parameter" opens the parameter dialog instead. */
  onParameter?: () => void;
  onClose: () => void;
}) {
  const sets = useDatasets(projectId);
  const [kind, setKind] = useState<ControlKind>(existing?.kind ?? 'dropdown');
  const [datasetId, setDatasetId] = useState<string | null>(existing?.datasetId ?? null);
  const ds = datasetId ?? sets.data?.[0]?.id ?? null;
  const cols = useDatasetColumns(projectId, ds ?? undefined);
  const [column, setColumn] = useState<string | null>(existing?.column ?? null);
  // A date range wants a date column first; everything else keeps the dataset's order.
  const ordered = [...(cols.data?.columns ?? [])].sort((a, b) => (kind === 'date_range' ? Number(b.type === 'date') - Number(a.type === 'date') : 0));
  const col = column && ordered.some((c) => c.name === column) ? column : (ordered[0]?.name ?? null);
  const [label, setLabel] = useState(existing?.label ?? '');
  const [preview, setPreview] = useState<ControlValue | undefined>(existing?.default);
  const editing = !!existing;
  const draft: Control | null = ds && col ? { kind, datasetId: ds, column: col, label: label.trim() } : null;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={editing ? 'Edit control' : 'Add a control'}
      description="Filters every card on the dashboard whose dataset has the column; the reader’s choice is never saved."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={!draft}
            onClick={() => {
              if (!draft) return;
              onDone(preview ? { ...draft, default: preview } : draft);
              onClose();
            }}
          >
            {editing ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <div className={s.kinds} role="radiogroup" aria-label="Kind">
          {KINDS.filter((k) => !editing || k.kind !== 'parameter').map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={k.kind === kind}
              // Kind is fixed after creation: a dropdown's `{value}` is not a multi's `{values}`.
              disabled={editing && k.kind !== kind}
              className={k.kind === kind ? `${s.kind} ${s.on}` : s.kind}
              onClick={() => {
                if (k.kind === 'parameter') {
                  onClose();
                  onParameter?.();
                  return;
                }
                setKind(k.kind);
                setPreview(undefined);
              }}
            >
              <span className={s.kindLabel}>{k.label}</span>
              <span className={s.kindHint}>{k.hint}</span>
            </button>
          ))}
        </div>
        {sets.data && sets.data.length === 0 ? (
          <p className={s.empty}>Import a dataset first — a control filters one.</p>
        ) : (
          <>
            <Select
              label="Dataset"
              value={ds}
              options={(sets.data ?? []).map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))}
              onValueChange={(v) => {
                setDatasetId(v);
                setColumn(null);
                setPreview(undefined);
              }}
            />
            <Select
              label="Column"
              value={col}
              options={ordered.map((c) => ({ value: c.name, label: `${c.name} (${c.type})` }))}
              onValueChange={(v) => {
                setColumn(v);
                setPreview(undefined);
              }}
            />
            <Input label="Label" placeholder={col ?? 'Filter'} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
            {draft && (
              <div className={s.preview}>
                <span className={s.previewH}>Preview — what it is left on becomes its default</span>
                <ControlWidget projectId={projectId} control={draft} value={preview} onChange={setPreview} />
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
