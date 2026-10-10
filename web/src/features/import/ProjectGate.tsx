// Which project an import or the Captures list works in: the app's CURRENT
// project (T2.2, web/src/features/projects/current.tsx) — `?project=<id>` in
// the URL, else this browser's last choice, else the most recent one. The
// shell's switcher changes it; this page follows.

import type { ReactNode } from 'react';
import { ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { useCurrentProject } from '../projects/current';
import { NoProject } from '../projects/NoProject';

/** Renders `children(projectId)` for the current project; its loading, error and no-project states otherwise. `why`: what a project holds for this page, one sentence. */
export function ProjectGate({ title, sub, why, children }: { title: string; sub?: string; why: string; children: (projectId: string) => ReactNode }) {
  const { projectId, status, error, refetch } = useCurrentProject();
  if (status === 'pending') return <PageSkeleton />;
  if (status === 'error') {
    return (
      <Page title={title} sub={sub}>
        <ErrorState title="Projects could not be loaded" message={error?.message ?? 'Try again.'} onRetry={refetch} />
      </Page>
    );
  }
  if (!projectId) {
    return (
      <Page title={title} sub={sub}>
        <NoProject why={why} />
      </Page>
    );
  }
  return <>{children(projectId)}</>;
}
