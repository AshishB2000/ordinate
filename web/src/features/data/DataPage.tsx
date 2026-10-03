// /data — the Data section belongs to a project: this goes to the current one
// (T2.2's useCurrentProject: ?project=, this browser's last choice, else the
// most recently opened) at /data/:projectId.

import { Navigate } from 'react-router';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { useCurrentProject } from '../projects/current';

export default function DataPage() {
  const cur = useCurrentProject();
  if (cur.status === 'pending') return <PageSkeleton />;
  if (cur.status === 'error') {
    return (
      <Page title="Data">
        <ErrorState title="Projects could not be loaded" message={cur.error?.message ?? 'Try again.'} onRetry={cur.refetch} />
      </Page>
    );
  }
  if (!cur.projectId) {
    return (
      <Page title="Data" sub="Datasets, their catalog, quality rules and relationships — per project.">
        <EmptyState icon="folder" title="No projects yet">
          Data lives in a project. Create one from Home, then bring a file in.
        </EmptyState>
      </Page>
    );
  }
  return <Navigate to={`/data/${cur.projectId}`} replace />;
}
