// Route-level failure pages: the per-route error boundary (React Router's
// errorElement) and the 404. Both render INSIDE the shell, so the nav stays.

import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { EmptyState, ErrorState, Page } from './blocks';
import s from './blocks.module.css';

export function RouteError() {
  const err = useRouteError();
  if (isRouteErrorResponse(err) && err.status === 404) return <NotFound />;
  const message =
    err instanceof Error ? err.message : isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : String(err);
  // A reload is the right retry for both causes we expect: a lazy chunk that a
  // redeploy replaced, and a page whose state went bad.
  return (
    <Page title="Something went wrong">
      <ErrorState title="This page could not be shown" message={message} onRetry={() => window.location.reload()} />
    </Page>
  );
}

export function NotFound() {
  return (
    <Page title="Page not found">
      <EmptyState
        icon="search"
        title="There is nothing at this address"
        actions={
          <Link className={s.btn} to="/">
            Go to Home
          </Link>
        }
      >
        The link may be old, or the page may have moved. Everything in Ordinate is reachable from the sections on the
        left.
      </EmptyState>
    </Page>
  );
}
