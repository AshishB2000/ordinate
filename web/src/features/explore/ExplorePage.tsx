// Explore is not in the web app yet. The page says so plainly and points at
// the two places that answer an ad-hoc question today.

import { Link } from 'react-router';
import { EmptyState, Page } from '../../app/blocks';
import { buttonClass } from '../../ui/Button';
import { useCurrentProject } from '../projects/current';

export default function ExplorePage() {
  const { projectId } = useCurrentProject();
  return (
    <Page title="Explore">
      <EmptyState
        icon="trending-up"
        title="Explore isn’t in the web app yet"
        actions={
          <>
            <Link className={buttonClass('primary')} to="/">
              Ask on Home
            </Link>
            <Link className={buttonClass('ghost')} to={projectId ? `/analytics/${projectId}/sql` : '/analytics'}>
              Open the SQL workbench
            </Link>
          </>
        }
      >
        For an ad-hoc question today, use the ask bar on Home, or write a query in the SQL workbench in Analytics.
      </EmptyState>
    </Page>
  );
}
