// A source table's Lineage tab: the table, the datasets built from it, and what is built on those.
// Records only on the server; drawn by the same graph the dataset's Lineage uses.

import { EmptyState, ErrorState } from '../../../ui/States';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { LineageGraph } from '../../data/LineageDrawer';
import { useSourceLineage } from './linksApi';

export function SourceLineage({ projectId, connId, docId }: { projectId: string; connId: string; docId: string }) {
  const q = useSourceLineage(projectId, connId, docId);
  if (q.isPending) return <SkeletonBlock label="Tracing what is built from this table" />;
  if (q.isError) return <ErrorState compact heading={3} title="The lineage could not be traced" message={q.error.message || 'Try again.'} onRetry={() => void q.refetch()} />;
  if (q.data.nodes.length <= 1) {
    return (
      <EmptyState compact heading={3} icon="lineage" title="Nothing is built from this table">
        No dataset is built from this table yet.
      </EmptyState>
    );
  }
  return <LineageGraph projectId={projectId} g={q.data} />;
}
