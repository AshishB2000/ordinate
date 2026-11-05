// A Live dataset's "Always applied" filters (semantic layer part 1, D13), at the top of its Schema tab:
// plain filters the server puts into every statement it sends for the dataset. An editor edits them
// with the chart filter rows (no "context" toggle: there are no LOD expressions under a dataset) and
// saves or cancels; a viewer reads them. A viewer row access rules restrict gets each filter's column
// and operator only, so a value the server held back is said to be hidden, never shown as empty.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { EmptyState } from '../../ui/States';
import { useCanEdit } from '../projects/api';
import type { FilterStep } from '../visuals/api';
import { FilterRows, FilterSummary } from '../visuals/filters/FilterRows';
import { isValuelessOp, liveFilters, OP_LABELS } from '../visuals/filters/filterText';
import { useLiveSchema, useSetBaseFilters } from './liveApi';
import s from './Data.module.css';
import l from './LiveData.module.css';

const EMPTY = 'No always-applied filters. Add one to keep rows such as test accounts or void orders out of every figure.';

/** A step the server sent without its value (REDACT): no value, no list, no period on an operator that takes one. */
const withheld = (f: FilterStep): boolean => !isValuelessOp(f.op) && f.value === undefined && f.values === undefined && f.period === undefined;

export function BaseFiltersPanel({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const q = useLiveSchema(projectId, datasetId);
  const canEdit = useCanEdit(projectId);
  const save = useSetBaseFilters(projectId, datasetId);
  const [draft, setDraft] = useState<FilterStep[] | null>(null);
  if (!q.data) return null; // the Schema panel below shows the loading and error states
  const stored = q.data.baseFilters ?? [];
  const list = draft ?? stored;
  const cols = q.data.columns.map((c) => ({ name: c.name, type: c.type }));
  const onSave = () =>
    save.mutate(liveFilters(list), {
      onSuccess: (r) => {
        if (r.ok) setDraft(null);
      },
    });
  return (
    <section className={`${s.section} ${l.base}`} aria-labelledby="live-base-head">
      <div className={l.baseHead}>
        <h3 id="live-base-head" className={l.baseTitle}>
          Always applied
        </h3>
        <p className={s.note}>Every chart, KPI, answer and value list on this dataset leaves out the rows these filters exclude. A copy keeps them as Prepare steps.</p>
      </div>
      {list.length === 0 && draft === null ? (
        <EmptyState
          compact
          heading={4}
          icon="filter"
          title="Nothing is filtered out"
          actions={
            canEdit && cols.length > 0 ? (
              <Button size="sm" icon="plus" onClick={() => setDraft([{ type: 'filter', column: cols[0].name, op: '' }])}>
                Add filter
              </Button>
            ) : undefined
          }
        >
          {EMPTY}
        </EmptyState>
      ) : canEdit ? (
        <FilterRows projectId={projectId} datasetId={datasetId} cols={cols} filters={list} onChange={setDraft} lod={false} terms={false} />
      ) : (
        <ul className={l.baseList}>
          {list.map((f, i) => (
            <li key={i}>
              <span className={s.strong}>{f.column}</span>{' '}
              {withheld(f) ? `${OP_LABELS[f.op] ?? f.op} (value hidden by row access rules)` : <FilterSummary step={f} />}
            </li>
          ))}
        </ul>
      )}
      {draft !== null && (
        <div className={l.baseActions}>
          <Button size="sm" onClick={() => setDraft(null)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" loading={save.isPending} onClick={onSave}>
            Save
          </Button>
        </div>
      )}
    </section>
  );
}
