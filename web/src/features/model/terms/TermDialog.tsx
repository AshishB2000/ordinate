// One dialog for a glossary term: its name, what else people call it (one comma-separated line, as a
// column's "Also called"), a description, its dataset (chosen once: a term's columns are that table's)
// and its filters, in the builder's own filter rows. A refusal — a name a metric or another term already
// answers to, a filter on a column the dataset lacks — is said under its box, the work still in the boxes.

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { useDatasetColumns, useDatasets } from '../../../api/datasets';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import type { FilterStep } from '../../visuals/api';
import { FilterRows } from '../../visuals/filters/FilterRows';
import { liveFilters } from '../../visuals/filters/filterText';
import { saveTerm, splitAliases, type Term, type TermField, type TermSummary } from './api';
import s from './Terms.module.css';

/** `onSaved`: after a save lands, before the dialog closes (a cancel calls `onClose` only). */
export function TermDialog({ projectId, term, onClose, onSaved }: { projectId: string; term?: TermSummary; onClose: () => void; onSaved?: () => void }) {
  const editingId = term?.id ?? '';
  const client = useQueryClient();
  const sets = useDatasets(projectId);
  const [name, setName] = useState(term?.name ?? '');
  const [aliases, setAliases] = useState((term?.aliases ?? []).join(', '));
  const [description, setDescription] = useState(term?.description ?? '');
  const [datasetId, setDatasetId] = useState<string | null>(term?.datasetId ?? null);
  const ds = datasetId ?? sets.data?.[0]?.id ?? null;
  const cols = useDatasetColumns(projectId, ds ?? undefined);
  const [filters, setFilters] = useState<FilterStep[]>([]);
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(!!editingId);
  const [errors, setErrors] = useState<Partial<Record<TermField | 'form', string>>>({});
  const [saving, setSaving] = useState(false);

  // An edit opens the FULL record (a summary has no filters, and saving it would drop them) and its tag.
  useEffect(() => {
    if (!editingId) return;
    let on = true;
    void (rpc('term:get', { projectId, id: editingId }) as Promise<{ ok: boolean; term?: Term; tag?: string; error?: string }>).then(
      (r) => {
        if (!on) return;
        if (r.ok && r.term) {
          setFilters(r.term.filters);
          setTag(r.tag);
        } else setErrors({ form: r.error || 'That term could not be read.' });
        setLoading(false);
      },
      () => on && (setErrors({ form: 'That term could not be read.' }), setLoading(false)),
    );
    return () => {
      on = false;
    };
  }, [editingId, projectId]);

  const save = async () => {
    setErrors({});
    if (!name.trim()) return setErrors({ name: 'A term needs a name.' });
    if (!ds) return setErrors({ datasetId: 'Choose a dataset.' });
    setSaving(true);
    const r = await saveTerm(projectId, editingId, ds, { name: name.trim(), aliases: splitAliases(aliases), description, filters: liveFilters(filters) }, tag);
    setSaving(false);
    if ('error' in r) return setErrors({ [r.field ?? 'form']: r.error });
    void client.invalidateQueries({ queryKey: ['term:list', projectId] });
    onSaved?.();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={editingId ? 'Edit term' : 'New term'}
      description="A term is a filter with a name. Every chart, KPI and the Assistant can use it, and an edit here changes all of them."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={saving} disabled={loading} onClick={() => void save()}>
            {editingId ? 'Save' : 'Create term'}
          </Button>
        </>
      }
    >
      <div className={s.fields}>
        <Input label="Name" placeholder="EMEA" value={name} error={errors.name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />
        <Input
          label="Also called"
          placeholder="Europe, Middle East and Africa"
          hint="Other names people use for it, separated by commas. The Assistant answers to these too."
          value={aliases}
          error={errors.aliases}
          onChange={(e) => setAliases(e.target.value)}
        />
        <Input label="Description" placeholder="What this term means, for whoever reads it next" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        <Select
          label="Dataset"
          disabled={!!editingId || sets.isPending}
          placeholder={sets.isPending ? 'Loading…' : 'Choose a dataset'}
          hint={editingId ? 'A term cannot change dataset: its filters name that table’s columns.' : 'The table whose columns the filters below name.'}
          error={errors.datasetId || (sets.isError ? `The datasets could not be listed: ${sets.error.message}` : sets.isSuccess && !sets.data.length ? 'This project has no datasets yet. Import one first.' : undefined)}
          value={ds}
          options={(sets.data ?? []).map((d) => ({ value: d.id, label: d.name || 'Untitled dataset' }))}
          onValueChange={(v) => {
            setDatasetId(v);
            setFilters([]);
          }}
        />
        {ds && !loading && <FilterRows projectId={projectId} datasetId={ds} cols={cols.data?.columns ?? []} filters={filters} onChange={setFilters} terms={false} />}
        {errors.filters && (
          <p className={s.error} role="alert">
            {errors.filters}
          </p>
        )}
      </div>
      {errors.form && (
        <p className={s.error} role="alert">
          {errors.form}
        </p>
      )}
    </Dialog>
  );
}
