import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };

const metric = (id: string, name: string, more: Record<string, unknown> = {}) => ({
  id, name, datasetId: D, datasetName: 'Orders', definition: { column: 'amount', aggregation: 'sum' }, definitionText: `sum of ${name}`, format: { kind: 'number' }, updatedAt: '', ...more,
});
const row = (additivity?: unknown) => ({ display: '2', series: null, usage: null, ...(additivity === undefined ? {} : { additivity }) });
const METRICS = [
  metric('m1', 'Revenue', { timeColumn: 'ship_date' }),
  metric('m2', 'Stock', { definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } } }),
  metric('m3', 'Avg'),
  metric('m4', 'Old pod'),
];
const ROWS = { m1: row({ categories: true, time: true }), m2: row({ categories: true, time: false }), m3: row({ categories: false, time: false }), m4: row() };

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor') {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'catalog:tags': body({ ok: true, tags: [], refs: {} }),
    'dataset:list': body([{ id: D, name: 'Orders', sourceKind: 'csv', rowCount: 10, columnCount: 3, updatedAt: '' }]),
    'metric:table': body({ ok: true, metrics: METRICS, rows: ROWS }),
    ...routes,
  });
}
const rowOf = async (name: string) => (await screen.findByText(name, {}, LAZY)).closest('tr')!;

describe('The Data model: metrics', () => {
  it('says the date each metric counts by and whether it adds up, as the server said', async () => {
    serve();
    renderApp(`/model/${P}?tab=metrics`);
    const table = await screen.findByRole('table', {}, LAZY);
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Dataset', 'Definition', 'Counts by', 'Adds up', 'Format', 'Value', 'Trend', 'Used in', 'Actions']);
    const revenue = await rowOf('Revenue');
    expect(within(revenue).getByText('ship_date')).toBeTruthy();
    expect(within(revenue).getByText('Yes')).toBeTruthy();
    const stock = await rowOf('Stock');
    expect(within(stock).getByText('Snapshot')).toBeTruthy();
    expect(within(stock).getByText('last of day')).toBeTruthy();
    expect(within(stock).getByText('Any date')).toBeTruthy();
    expect(within(stock).getByText('Not over time').closest('[title]')?.getAttribute('title')).toBe('A snapshot: it adds up across categories, not across dates.');
    expect(within(await rowOf('Avg')).getByText('No').closest('[title]')?.getAttribute('title')).toBe("It can't be added up, so a total of it would be wrong.");
    expect(screen.getByText('4 metrics')).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('NEGATIVE CONTROL: an older pod sends no additivity, and that reads "—", never "No"', async () => {
    serve();
    renderApp(`/model/${P}?tab=metrics`);
    const old = await rowOf('Old pod');
    const cells = within(old).getAllByRole('cell');
    expect(cells[4].textContent).toBe('—');
    expect(within(old).queryByText('No')).toBeNull();
  });

  it('with no metrics: one New metric (the header\'s) and Suggest metrics from my columns', async () => {
    serve({ 'metric:table': { body: { ok: true, metrics: [], rows: {} } } });
    renderApp(`/model/${P}?tab=metrics`);
    await screen.findByRole('heading', { name: 'No metrics yet' }, LAZY);
    expect(screen.getAllByRole('button', { name: 'New metric' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Suggest metrics from my columns' })).toBeTruthy();
  });

  it('the header\'s New metric opens the editor', async () => {
    serve();
    renderApp(`/model/${P}`);
    fireEvent.click(await screen.findByRole('button', { name: 'New metric' }, LAZY));
    expect(await screen.findByRole('dialog', { name: 'New metric' })).toBeTruthy();
  });

  it('a viewer gets no New metric', async () => {
    const calls = serve({}, 'viewer');
    renderApp(`/model/${P}?tab=metrics`);
    await rowOf('Revenue');
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    expect(screen.queryByRole('button', { name: 'New metric' })).toBeNull();
  });

  it('/data/metrics lands on the Metrics tab and keeps the rest of its address', async () => {
    serve();
    const router = renderApp(`/data/metrics?project=${P}&tag=finance`);
    await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(`/model/${P}?tab=metrics&tag=finance`), LAZY);
    expect(await screen.findByRole('tab', { name: 'Metrics', selected: true })).toBeTruthy();
  });
});
