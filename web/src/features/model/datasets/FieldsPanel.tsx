// A dataset's Fields on the Data model: the fields its Prepare steps calculate, then every column's notes
// (meaning, other names, value labels, sensitivity) edited in place, as on the dataset's Columns tab.

import type { DatasetColumns } from '../../../api/datasets';
import { ColumnsTab } from '../../data/ColumnsTab';
import type { ModelTable } from '../api';
import { SuggestedMeanings } from './SuggestedMeanings';
import m from '../Model.module.css';
import { HierarchiesBlock } from './HierarchiesBlock';

export function FieldsPanel({ projectId, header, table }: { projectId: string; header: DatasetColumns; table: ModelTable | undefined }) {
  const calculated = table?.calculated ?? [];
  return (
    <>
      <HierarchiesBlock projectId={projectId} dataset={header} />
      {calculated.length > 0 && (
        <section className={m.calc} aria-label="Calculated in Prepare">
          <h3 className={m.calcHead}>Calculated in Prepare</h3>
          <ul className={m.calcList}>
            {calculated.map((c) => (
              <li key={c.name}>
                <span className={m.calcName}>{c.name}</span>
                {table?.valuesHidden ? <span className={m.muted}>formula hidden</span> : <code className={m.formula}>{c.formula}</code>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <SuggestedMeanings projectId={projectId} datasetId={header.id} />
      <ColumnsTab projectId={projectId} datasetId={header.id} header={header} live={header.mode === 'live'} />
    </>
  );
}
