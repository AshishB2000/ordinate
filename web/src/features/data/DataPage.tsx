// /data — the Data section belongs to a project: this goes to the current one
// (T2.2's useCurrentProject: ?project=, this browser's last choice, else the
// most recently opened) at /data/:projectId.

import { Navigate, useLocation } from 'react-router';
import { ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { useCurrentProject } from '../projects/current';
import { NoProject } from '../projects/NoProject';

export default function DataPage() {
  const cur = useCurrentProject();
  // The rest of the address goes along (`?tab=relationships` reaches DataSection's redirect); `?project=` has done its job.
  const q = new URLSearchParams(useLocation().search);
  q.delete('project');
  const rest = q.toString();
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
      <Page title="Data" sub="Each project’s datasets, catalog, quality rules and relationships.">
        <NoProject why="Datasets live in a project." />
      </Page>
    );
  }
  return <Navigate to={`/data/${cur.projectId}${rest ? `?${rest}` : ''}`} replace />;
}
