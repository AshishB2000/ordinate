// The Data model's Lineage tab: the dataset's graph, or, once a column is picked ("Trace a column", kept in
// ?column=), the graph around that column from `lineage:column`. The graph and its counts are the server's.

import { useSearchParams } from 'react-router';
import { LineageView } from '../../data/LineageDrawer';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { Select } from '../../../ui/Select';
import { useColumnLineage } from '../api';
import m from '../Model.module.css';

function Traced({ projectId, datasetId, column }: { projectId: string; datasetId: string; column: string }) {
  const q = useColumnLineage(projectId, datasetId, column);
  if (q.isPending) return <SkeletonBlock label={`Tracing ${column}`} />;
  if (q.isError) return <ErrorState compact heading={3} title="The lineage could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  if (!q.data) {
    return (
      <EmptyState compact heading={3} icon="lineage" title={`Nothing reads “${column}” yet.`}>
        Once a metric, visual or calculated field uses it, its path appears here.
      </EmptyState>
    );
  }
  return <LineageView projectId={projectId} id={datasetId} graph={q.data} />;
}

export function ColumnLineage({ projectId, datasetId, columns }: { projectId: string; datasetId: string; columns: { name: string }[] }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('column');
  const column = asked !== null && columns.some((c) => c.name === asked) ? asked : null;
  const pick = (v: string) =>
    setParams((p) => {
      const q = new URLSearchParams(p);
      if (v) q.set('column', v);
      else q.delete('column');
      return q;
    }, { replace: true });
  return (
    <>
      <div className={m.traceBar}>
        <Select
          label="Trace a column"
          size="sm"
          value={column ?? ''}
          placeholder="The whole dataset"
          onValueChange={pick}
          options={[{ value: '', label: 'The whole dataset' }, ...columns.map((c) => ({ value: c.name, label: c.name }))]}
        />
      </div>
      {column === null ? <LineageView projectId={projectId} id={datasetId} /> : <Traced projectId={projectId} datasetId={datasetId} column={column} />}
    </>
  );
}
