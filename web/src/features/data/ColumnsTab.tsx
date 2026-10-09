// The dataset page's Columns tab (catalogPage.ts ctPaintColumnsTab): the column
// docs as a table edited in place. A cell reads as text until it is focused
// and saves on blur or Enter; sensitivity saves on pick. Display names and
// descriptions show wherever the column is named (the grid's header tooltip).

import { useState } from 'react';
import type { DatasetColumns } from '../../api/datasets';
import { Select } from '../../ui/Select';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { useColumnDocs, useStats, useWrite, type ColumnDoc } from './api';
import { useLiveSchema } from './liveApi';
import { SENSITIVITY } from './Details';
import s from './Data.module.css';

type Patch = Pick<ColumnDoc, 'displayName' | 'description' | 'example' | 'sensitivity'>;

function Cell({ value, placeholder, label, multiline, onSave }: { value: string; placeholder: string; label: string; multiline?: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  const [saved, setSaved] = useState(value);
  const commit = () => {
    const next = v.trim();
    if (next === saved) return;
    setSaved(next);
    onSave(next);
  };
  const common = {
    className: s.cellInput,
    value: v,
    placeholder,
    'aria-label': label,
    onBlur: commit,
  };
  return multiline ? (
    <textarea {...common} rows={1} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), commit())} />
  ) : (
    <input {...common} type="text" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())} />
  );
}

export function ColumnsTab({ projectId, datasetId, header, live }: { projectId: string; datasetId: string; header: DatasetColumns; live?: boolean }) {
  const docs = useColumnDocs(projectId, datasetId);
  // An example placeholder: the most common value — on a Live dataset, the schema sync's sample (it keeps no rows to count).
  const stats = useStats(projectId, live ? '' : datasetId, !live);
  const schema = useLiveSchema(projectId, datasetId, !!live);
  const save = useWrite('catalog:setColumn', ['catalog:columns']);
  if (header.columns.length === 0) {
    return (
      <EmptyState icon="table" heading={3} title="No columns">
        This dataset has no columns to document.
      </EmptyState>
    );
  }
  if (docs.isPending) return <SkeletonTable cols={6} rows={Math.min(8, header.columns.length)} label="Loading the column notes" />;
  if (docs.isError) return <ErrorState heading={3} title="The column notes could not be loaded" message={docs.error.message} onRetry={() => void docs.refetch()} />;
  const all = docs.data;
  const doc = (name: string): ColumnDoc => (Object.prototype.hasOwnProperty.call(all, name) ? all[name] : {});
  const patch = (column: string, p: Patch) => save.mutate({ projectId, datasetId, column, patch: p });
  return (
    <section className={s.section} aria-label="Column notes">
      <p className={s.lead}>
        Descriptions show as tooltips wherever a column is named, and a display name replaces the raw one in pickers. Mark a
        column personal or financial so exports and reports can say so.
      </p>
      <div className={s.card}>
        <table className={`${s.table} ${s.docTable}`}>
          <thead>
            <tr>
              <th scope="col">Column</th>
              <th scope="col">Type</th>
              <th scope="col">Display name</th>
              <th scope="col">Description</th>
              <th scope="col">Example</th>
              <th scope="col">Sensitivity</th>
            </tr>
          </thead>
          <tbody>
            {header.columns.map((c, i) => {
              const d = doc(c.name);
              const common = live ? schema.data?.columns.find((x) => x.name === c.name)?.values[0] : stats.data?.summaries[i]?.mostCommon?.value;
              return (
                <tr key={c.name} data-column={c.name}>
                  <td className={s.strong}>{c.name}</td>
                  <td>
                    <span className={s.typeChip}>{c.type}</span>
                  </td>
                  <td>
                    <Cell value={d.displayName ?? ''} placeholder={c.name} label={`Display name of ${c.name}`} onSave={(v) => patch(c.name, { displayName: v })} />
                  </td>
                  <td>
                    <Cell multiline value={d.description ?? ''} placeholder="Add a description" label={`Description of ${c.name}`} onSave={(v) => patch(c.name, { description: v })} />
                  </td>
                  <td>
                    <Cell value={d.example ?? ''} placeholder={common || '—'} label={`Example of ${c.name}`} onSave={(v) => patch(c.name, { example: v })} />
                  </td>
                  <td>
                    <Select
                      size="sm"
                      aria-label={`Sensitivity of ${c.name}`}
                      value={d.sensitivity ?? 'none'}
                      options={SENSITIVITY}
                      onValueChange={(v) => patch(c.name, { sensitivity: v as ColumnDoc['sensitivity'] })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
