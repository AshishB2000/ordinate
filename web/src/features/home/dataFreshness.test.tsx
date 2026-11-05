// Home's "Data freshness" (DataFreshness.tsx): only the datasets that refresh
// on their own (or failed), a failed one first with the server's reason; Retry
// is an editor's and asks the server again; nothing to say, no section.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { serveRpc } from '../../test-utils';
import { DataFreshness } from './DataFreshness';

const P = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ORDERS = { id: 'd1', name: 'Orders', rowCount: 10, columnCount: 3, sourceKind: 'postgres', every: 'hourly', lastRefreshedAt: minsAgo(12), lastRefreshStatus: 'ok' };
const UPLOAD = { id: 'd2', name: 'Uploads', rowCount: 4, columnCount: 2, sourceKind: 'csv' };
const DEALS = { id: 'd3', name: 'Deals', rowCount: 9, columnCount: 4, sourceKind: 'url', every: 'daily', lastRefreshedAt: minsAgo(360), lastRefreshStatus: 'error', lastRefreshError: 'HTTP 403 from files.example.com' };
const LIVE = { id: 'd4', name: 'Web sessions', rowCount: 0, columnCount: 5, sourceKind: 'sql', mode: 'live' };

function show(datasets: unknown[], role = 'editor') {
  const calls = serveRpc({
    'home:overview': { body: { counts: {}, datasets, standsOut: [], comments: { open: 0, recent: [] } } },
    'projects:roles': { body: { [P]: role } },
    'dataset:refresh': { body: { ok: true } },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DataFreshness projectId={P} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

const rowNames = (sec: HTMLElement) => within(sec).getAllByRole('listitem').map((li) => within(li).getAllByRole('link')[0]!.textContent);

describe('Data freshness', () => {
  it('lists what refreshes on its own, a failed refresh first with its reason', async () => {
    show([ORDERS, UPLOAD, DEALS, LIVE]);
    const sec = await screen.findByRole('region', { name: 'Data freshness' });
    expect(rowNames(sec)).toEqual(['Deals', 'Orders', 'Web sessions']); // an uploaded file has nothing to refresh
    expect(within(sec).getByText('1 needs attention')).toBeTruthy();
    const deals = within(sec).getAllByRole('listitem')[0]!;
    expect(within(deals).getByRole('link').getAttribute('href')).toBe(`/data/${P}/d3`);
    expect(within(deals).getByText('URL · refreshes daily · data from 6h ago')).toBeTruthy();
    expect(within(deals).getByText(/^The last refresh failed: HTTP 403 from files\.example\.com/)).toBeTruthy();
    const orders = within(sec).getAllByRole('listitem')[1]!;
    expect(within(orders).getByText('Database · refreshes hourly')).toBeTruthy();
    expect(within(orders).getByText('12m ago')).toBeTruthy();
    expect(within(within(sec).getAllByRole('listitem')[2]!).getByText('Live')).toBeTruthy();
  });

  it('retries a failed refresh for an editor, then reads Home again', async () => {
    const calls = show([ORDERS, DEALS]);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry the refresh of Deals' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'dataset:refresh')?.payload).toEqual({ projectId: P, id: 'd3' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'home:overview').length).toBe(2));
  });

  it('gives a viewer the reason without the button', async () => {
    show([DEALS], 'viewer');
    const sec = await screen.findByRole('region', { name: 'Data freshness' });
    await waitFor(() => expect(within(sec).getByText(/An editor can fix it\.$/)).toBeTruthy());
    expect(within(sec).queryByRole('button')).toBeNull();
    expect(within(sec).getByText('Failed')).toBeTruthy();
  });

  it('says all is well, and shows nothing when nothing refreshes', async () => {
    show([ORDERS, UPLOAD]);
    expect(await screen.findByText('All up to date')).toBeTruthy();
    cleanup();
    const calls = show([UPLOAD]);
    await waitFor(() => expect(calls.some((c) => c.channel === 'home:overview')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: 'Data freshness' })).toBeNull();
  });
});
