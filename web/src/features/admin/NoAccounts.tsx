// A server without Postgres (dev, no DATABASE_URL) keeps no members, teams or
// API tokens, so Admin and API tokens say so instead of failing their loads.

import { Page } from '../../app/blocks';
import { EmptyState } from '../../ui/States';

export function NoAccounts({ title }: { title: string }) {
  return (
    <Page title={title}>
      <EmptyState icon="database" title="This server keeps no accounts">
        Members, teams and API tokens are stored in Postgres, and this server runs without one. Set DATABASE_URL and
        sign-in (AUTH_MODE) to manage them here.
      </EmptyState>
    </Page>
  );
}
