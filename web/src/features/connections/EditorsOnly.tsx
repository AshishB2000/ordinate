// Connections are an editor's from end to end: saving one, browsing its
// tables, running a query and pulling a dataset are all writes on the server
// (src/api/connections.ts). A viewer is told so here, once, instead of meeting
// a form whose every button is refused.

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import { useRoles } from '../projects/api';

/** `above`: what stays over the viewer's notice — the page's project picker, so another project is one pick away. */
export function EditorsOnly({ projectId, above, children }: { projectId: string; above?: ReactNode; children: ReactNode }) {
  const roles = useRoles();
  if (roles.isPending) return <PageSkeleton />;
  if (roles.isError) {
    return (
      <Page title="Connections">
        <ErrorState title="Your access could not be checked" message={roles.error.message} onRetry={() => void roles.refetch()} />
      </Page>
    );
  }
  const role = roles.data[projectId];
  if (role === 'editor' || role === 'admin') return <>{children}</>;
  return (
    <Page title="Connections">
      {above}
      <EmptyState
        icon="plug"
        title="Connections are for editors"
        actions={
          <Link className={buttonClass('primary')} to={`/data/${projectId}`}>
            Open Data
          </Link>
        }
      >
        Connecting a source, querying it and saving its rows as a dataset are for editors of this project. You have view-only access: the datasets a
        connection feeds are in Data. Ask a project admin to make you an editor.
      </EmptyState>
    </Page>
  );
}
