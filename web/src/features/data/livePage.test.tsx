// The Live dataset's page and the routes that read rows (docs/live-data/00-plan.md
// L2.6), over the whole app with fetch answered per channel. The rule under test
// beside each screen: a Live dataset's screens never call a row-reading channel —
// each says why the feature is off and offers "Make a copy".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const COPY = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = 15_000;

/** Every channel that reads a dataset's stored rows: none may be called for a Live one. */
const ROW_READERS = ['dataset:page', 'dataset:stats', 'dataset:profile', 'prepare:get', 'quality:run', 'insights:list', 'stats:run', 'drivers:explain', 'segments:features', 'snapshots:diff', 'visual:preview'];

const LIVE = { id: D, name: 'Orders (live)', sourceKind: 'postgres', rowCount: 0, columnCount: 3, updatedAt: '2026-10-09T10:00:00Z', originKind: 'connection', mode: 'live', maxCacheAgeSec: 300 };
const SCHEMA = {
  ok: true,
  schemaSyncedAt: '2026-10-09T10:00:00Z',
  syncing: false,
  sampledAt: '2026-10-09T10:00:00Z',
  sampleRows: 240,
  method: 'sample',
  note: null,
  columns: [
    { name: 'region', type: 'text', filled: 240, filledPct: 100, distinct: 4, values: ['North', 'South', 'East', 'West'], more: 0, withheld: true },
    { name: 'amount', type: 'number', filled: 240, filledPct: 100, distinct: 101, values: [], more: 0, withheld: false },
    { name: 'day', type: 'date', filled: 240, filledPct: 100, distinct: 240, values: [], more: 0, withheld: false },
  ],
  missing: [{ column: 'discount', usedBy: [{ kind: 'visual', id: 'v1', name: 'Discount by region' }] }],
};

function serve(extra: Record<string, unknown> = {}) {
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  const routes: Record<string, unknown> = {
    'projects:list': [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }],
    'projects:roles': { [P]: 'admin' },
    'dataset:list': [LIVE],
    'dataset:columns': { id: D, name: LIVE.name, rowCount: 0, mode: 'live', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'day', type: 'date' }] },
    'dataset:source': { kind: 'connection', label: 'Fake warehouse', refreshable: true, live: true, maxCacheAgeSec: 300 },
    'catalog:tags': { ok: true, tags: [], refs: {} },
    'catalog:columns': { ok: true, columns: {} },
    'dataset:liveSchema': SCHEMA,
    'dataset:setMode': { ok: true, mode: 'live', maxCacheAgeSec: 3600 },
    'dataset:refresh': { ok: true, live: { epoch: 1 }, warnings: [] },
    'dataset:syncLiveSchema': { ok: true, status: 'synced', columns: 3, added: [], removed: ['discount'], retyped: [], missing: ['discount'], sample: { ok: true, rows: 240 } },
    'dataset:copyLive': { ok: true, dataset: { id: COPY, name: 'Orders (live) (copy)', rowCount: 240 }, warnings: [] },
    ...extra,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? ((JSON.parse(String(init.body)) as { args: Record<string, unknown>[] }).args[0] ?? {}) : {};
      calls.push({ channel, payload });
      return new Response(JSON.stringify(routes[channel] ?? null), { status: 200 });
    }),
  );
  return calls;
}

const readersCalled = (calls: { channel: string }[]) => calls.filter((c) => ROW_READERS.includes(c.channel)).map((c) => c.channel);

describe('a Live dataset’s page', () => {
  it('the settings: Live switch on, the cache age, Refresh now — and the Data tab says what needs a copy', async () => {
    const calls = serve();
    renderApp(`/data/${P}/${D}`);
    await screen.findByRole('heading', { name: 'Live — the rows stay in the warehouse' }, { timeout: LAZY });
    expect((screen.getByRole('switch', { name: 'Live' }) as HTMLInputElement).checked).toBe(true);
    expect((await screen.findByRole('combobox', { name: 'Cache age of Orders (live)' })).textContent).toContain('5 min (default)');
    expect((screen.getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement).disabled).toBe(false);
    const off = screen.getByRole('region', { name: 'Needs a copy' });
    expect(within(off).getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getAllByRole('button', { name: 'Make a copy' }).length).toBeGreaterThan(0);
    // The tabs that read rows are there, each saying why it is off.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Data', 'Schema', 'Columns', 'Quality', 'Insights', 'Snapshots']);
    expect(readersCalled(calls)).toEqual([]);
  });

  it('a cache age is a live → live setMode; Refresh now resets the cache and says so', async () => {
    const calls = serve();
    renderApp(`/data/${P}/${D}`);
    fireEvent.click(await screen.findByRole('combobox', { name: 'Cache age of Orders (live)' }, { timeout: LAZY }));
    fireEvent.click(screen.getByRole('option', { name: '1 h' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'dataset:setMode')?.payload).toEqual({ projectId: P, datasetId: D, mode: 'live', maxCacheAgeSec: 3600 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await screen.findByText('Cache reset — the next figure asks the warehouse.');
    expect(calls.find((c) => c.channel === 'dataset:refresh')?.payload).toEqual({ projectId: P, id: D });
  });

  it('turning Live off asks first; "Keep it Live" changes nothing', async () => {
    const calls = serve();
    renderApp(`/data/${P}/${D}`);
    fireEvent.click(await screen.findByRole('switch', { name: 'Live' }, { timeout: LAZY }));
    const dialog = await screen.findByRole('dialog', { name: 'Copy the data instead?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it Live' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.channel === 'dataset:setMode')).toBe(false);
  });

  it('the Schema tab: the sample’s figures, a withheld column, a missing column; Sync schema says what it found', async () => {
    const calls = serve();
    renderApp(`/data/${P}/${D}?tab=schema`);
    await screen.findByText(/^Profiled from a sample of 240 rows · /, undefined, { timeout: LAZY });
    const row = screen.getByText('region').closest('tr') as HTMLElement;
    expect(within(row).getByText('North').textContent).toBe('North');
    expect(within(row).queryByText('Values withheld from the Assistant')).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('discount — used by the visual “Discount by region”');
    fireEvent.click(screen.getByRole('button', { name: 'Sync schema' }));
    await screen.findByText('Synced 3 columns — gone discount. Profiled from 240 rows.');
    expect(calls.filter((c) => c.channel === 'dataset:syncLiveSchema')).toHaveLength(1);
    expect(readersCalled(calls)).toEqual([]);
  });

  it('the Quality tab is off — "Make a copy" makes one and opens ITS quality tab', async () => {
    const calls = serve();
    const router = renderApp(`/data/${P}/${D}?tab=quality`);
    await screen.findByRole('heading', { name: 'Quality checks are off for Live datasets' }, { timeout: LAZY });
    fireEvent.click(screen.getByRole('button', { name: 'Make a copy' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/data/${P}/${COPY}`));
    expect(router.state.location.search).toBe('?tab=quality');
    expect(calls.find((c) => c.channel === 'dataset:copyLive')?.payload).toEqual({ projectId: P, datasetId: D });
    expect(readersCalled(calls)).toEqual([]);
  });

  it('a copy refused by the server says why, and goes nowhere', async () => {
    serve({ 'dataset:copyLive': { ok: false, error: 'The warehouse could not be read, so no copy was made.' } });
    const router = renderApp(`/data/${P}/${D}?tab=insights`);
    await screen.findByRole('heading', { name: 'Insights and anomalies are off for Live datasets' }, { timeout: LAZY });
    fireEvent.click(screen.getByRole('button', { name: 'Make a copy' }));
    await screen.findByText('The warehouse could not be read, so no copy was made.');
    expect(router.state.location.pathname).toBe(`/data/${P}/${D}`);
  });
});

describe('routes that read rows, on a Live dataset', () => {
  it('Prepare: the page says why, and prepare:get is never asked', async () => {
    const calls = serve();
    renderApp(`/data/${P}/${D}/prepare`);
    await screen.findByRole('heading', { name: 'Prepare steps and formulas are off for Live datasets' }, { timeout: LAZY });
    expect(screen.getByRole('link', { name: 'Back to the dataset' }).getAttribute('href')).toBe(`/data/${P}/${D}`);
    expect(readersCalled(calls)).toEqual([]);
  });

  it('Statistics: the workbench never runs', async () => {
    const calls = serve();
    renderApp(`/analytics/${P}/${D}/stats`);
    await screen.findByRole('heading', { name: 'Statistics are off for Live datasets' }, { timeout: LAZY });
    expect(readersCalled(calls)).toEqual([]);
  });

  it('NEGATIVE CONTROL: on an extract the same Prepare route asks prepare:get', async () => {
    const calls = serve({ 'dataset:list': [{ ...LIVE, mode: undefined, rowCount: 10 }], 'prepare:get': null });
    renderApp(`/data/${P}/${D}/prepare`);
    await screen.findByRole('heading', { name: 'Dataset not found' }, { timeout: LAZY });
    expect(calls.some((c) => c.channel === 'prepare:get')).toBe(true);
    expect(screen.queryByText(/off for Live datasets/)).toBeNull();
  });
});
