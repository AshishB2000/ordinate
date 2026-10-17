// A page whose only job is writing (Connections, Prepare, Import, an input
// table) is an editor's from end to end: every button on it is a write the
// server refuses a viewer. A viewer is told so here, once, instead of meeting
// a form whose every button is refused — and the page's data hooks never run,
// because `children` is not mounted until the role is known.

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import type { IconName } from '../../ui/icons/Icon';
import { useRoles } from './api';

/**
 * `page`: the page's heading, kept for the viewer. `body`: what the page is for and where the
 * viewer's things are instead — the view-only sentence follows it. `back`: the one way on.
 * `above`: what stays over the notice — a project picker, so another project is one pick away.
 */
export function EditorsOnly({
  projectId,
  page,
  icon,
  title,
  body,
  back,
  above,
  children,
}: {
  projectId: string;
  page: string;
  icon: IconName;
  title: string;
  body: string;
  back: { to: string; label: string };
  above?: ReactNode;
  children: ReactNode;
}) {
  const roles = useRoles();
  if (roles.isPending) return <PageSkeleton />;
  if (roles.isError) {
    return (
      <Page title={page}>
        <ErrorState title="Your access could not be checked" message={roles.error.message} onRetry={() => void roles.refetch()} />
      </Page>
    );
  }
  const role = roles.data[projectId];
  if (role === 'editor' || role === 'admin') return <>{children}</>;
  return (
    <Page title={page}>
      {above}
      <EmptyState
        icon={icon}
        title={title}
        actions={
          <Link className={buttonClass('primary')} to={back.to}>
            {back.label}
          </Link>
        }
      >
        {body} You have view-only access. Ask a project admin to make you an editor.
      </EmptyState>
    </Page>
  );
}
