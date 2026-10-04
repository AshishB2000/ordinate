// The event editor (eventsEditor.ts): title, kind, dates and scope in one
// dialog. Dates are native `<input type="date">`. The server sanitizes and
// stores (events:save); a refused save shows in the dialog with the work kept.

import { useState } from 'react';
import { useDatasetColumns, type DatasetSummary } from '../../../api/datasets';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { KINDS, saveEvent, type ProjectEvent } from './api';
import { KindMark } from './KindMark';
import s from './Events.module.css';

export function EventEditor({
  projectId,
  datasets,
  existing,
  onClose,
  onSaved,
}: {
  projectId: string;
  datasets: DatasetSummary[];
  existing: ProjectEvent | null;
  onClose: () => void;
  onSaved: (title: string, isNew: boolean) => void;
}) {
  const f0 = existing?.scope?.filters?.[0];
  const [title, setTitle] = useState(existing?.title ?? '');
  const [kind, setKind] = useState<string>(existing?.kind ?? 'launch');
  const [start, setStart] = useState(existing?.date ?? '');
  const [end, setEnd] = useState(existing?.end ?? '');
  const [dataset, setDataset] = useState(existing?.scope?.datasetIds?.[0] ?? '');
  const [column, setColumn] = useState(f0?.column ?? '');
  const [value, setValue] = useState(f0 ? f0.values.join(', ') : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cols = useDatasetColumns(projectId, dataset || undefined);
  const textCols = (cols.data?.columns ?? []).filter((c) => c.type === 'text').map((c) => c.name);
  if (f0 && !textCols.includes(f0.column)) textCols.push(f0.column);
  const name = existing ? 'Edit event' : 'New event';

  const save = async () => {
    setError('');
    const values = value.split(',').map((x) => x.trim()).filter(Boolean);
    if (!title.trim() || !start) {
      setError('An event needs a title and a start date.');
      return;
    }
    const scope: NonNullable<ProjectEvent['scope']> = {};
    if (dataset) scope.datasetIds = [dataset];
    if (column && values.length) scope.filters = [{ type: 'filter', column, op: 'in', values }];
    setBusy(true);
    try {
      const r = await saveEvent(projectId, {
        ...(existing ? { id: existing.id } : {}),
        title: title.trim(),
        kind,
        date: start,
        end: end || null,
        ...(scope.datasetIds || scope.filters ? { scope } : {}),
      });
      onSaved(r.event.title, !existing);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the event.');
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={name}
      description="Charts with a date axis mark it at their own grain — a day, week, month, quarter or year — and findings that change during it name it."
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            {existing ? 'Save event' : 'Add event'}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <Input label="Title" maxLength={200} placeholder="e.g. Holiday campaign" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className={s.field}>
          <span className={s.fieldLabel} id="ev-kind">
            Kind
          </span>
          <div className={s.kindPick} role="radiogroup" aria-labelledby="ev-kind">
            {KINDS.map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? `${s.kindOpt} ${s.kindOn}` : s.kindOpt} onClick={() => setKind(k)}>
                <KindMark kind={k} />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className={s.dates}>
          <Input label="Starts" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <Input label="Ends" type="date" hint="Leave empty for a single day." value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <Select
          label="Applies to"
          value={dataset}
          options={[{ value: '', label: 'Every dataset' }, ...datasets.map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))]}
          onValueChange={(v) => {
            setDataset(v);
            setColumn('');
          }}
        />
        {(dataset || f0) && (
          <div className={s.field}>
            <span className={s.fieldLabel}>Only where</span>
            <div className={s.where}>
              <Select aria-label="Only where column" value={column} options={[{ value: '', label: 'Any column' }, ...textCols.map((c) => ({ value: c, label: c }))]} onValueChange={setColumn} />
              <Input aria-label="Only where value" placeholder="Value, e.g. West" value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            <span className={s.fieldHint}>Optional. A chart filtered to a different value of this column does not show it.</span>
          </div>
        )}
        {error && (
          <p className={s.err} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
