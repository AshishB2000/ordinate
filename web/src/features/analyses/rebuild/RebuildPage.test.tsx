// Rebuild from a screenshot, over the whole app with fetch answered per
// channel. The rules under test: the page shows what rebuild:match returned
// and decides nothing itself — a figure appears as the server computed it, a
// refusal in the server's words — every correction goes back to the server as
// an override, the dropdowns offer only the columns a field may take, and
// "Create dashboard" builds the server's plan through analysis:buildPlan.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../../test-utils';

vi.mock('../../import/screenshotImage', () => ({
  readyImage: async () => ({ png: new Blob(['png'], { type: 'image/png' }), thumb: 'data:image/jpeg;base64,AA==' }),
}));

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const A = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = 15_000;

const READING = {
  title: 'Superstore',
  tool: 'tableau',
  tiles: [
    { id: 1, kind: 'kpi', chart: '', title: 'Total sales', box: { x: 2, y: 2, w: 30, h: 12 }, dimension: '', measures: [{ field: 'Sales', aggregation: 'sum' }], series: '', filterKind: '' },
    { id: 2, kind: 'chart', chart: 'bar', title: 'Sales by product', box: { x: 2, y: 20, w: 60, h: 40 }, dimension: 'Region', measures: [{ field: 'Product ID', aggregation: 'sum' }], series: '', filterKind: '' },
    { id: 3, kind: 'filter', chart: '', title: 'Region', box: { x: 70, y: 2, w: 25, h: 6 }, dimension: 'Region', measures: [], series: '', filterKind: 'multi' },
  ],
};
const COLUMNS = [
  { name: 'Region', type: 'text' },
  { name: 'Revenue', type: 'number' },
  { name: 'Product ID', type: 'text' },
  { name: 'Order Date', type: 'date' },
];
const MATCH = {
  ok: true,
  name: 'Superstore',
  columns: COLUMNS,
  tiles: [
    { id: 1, kind: 'kpi', said: '', chartType: null, title: 'Total sales', box: READING.tiles[0].box, status: 'ready', figure: { value: 842 },
      fields: [{ key: 'value0', role: 'value', said: 'Sales', column: 'Revenue', aggregation: 'sum', confidence: 'likely' }] },
    { id: 2, kind: 'chart', said: 'bar', chartType: 'bar', title: 'Sales by product', box: READING.tiles[1].box, status: 'unmapped',
      reason: 'Sum needs a number column, but "Product ID" is text.',
      fields: [
        { key: 'category', role: 'category', said: 'Region', column: 'Region', confidence: 'exact' },
        { key: 'value0', role: 'value', said: 'Product ID', column: null, aggregation: 'sum', confidence: null, note: 'Sum needs a number column, but "Product ID" is text.' },
      ] },
    { id: 3, kind: 'filter', said: '', chartType: null, title: 'Region', box: READING.tiles[2].box, status: 'ready', multi: true,
      fields: [{ key: 'filter', role: 'filter', said: 'Region', column: 'Region', confidence: 'exact' }] },
  ],
  layout: [{ kind: 'metric', x: 0, y: 0, w: 3, h: 2, tileId: 1 }],
  controls: 1,
  dropped: [],
  plan: { name: 'Superstore', sheets: [{ name: 'Overview', rows: [] }] },
};

function serve({ ai = true, read = { ok: true, reading: READING } as unknown } = {}) {
  const calls: { channel: string; payload: Record<string, any> }[] = [];
  const routes: Record<string, unknown> = {
    '/api/auth/me': { user: { email: 'boss@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true },
    'projects:list': [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }],
    'projects:roles': { [P]: 'admin' },
    'dataset:list': [{ id: D, name: 'Superstore orders', sourceKind: 'csv', rowCount: 4, columnCount: 4, updatedAt: '2026-10-01T10:00:00Z' }],
    'ai:status': ai ? { ready: true, models: [], mine: null, keyStore: null } : { ready: false, reason: 'no_model', models: [], mine: null, keyStore: null },
    '/api/files': { fileToken: 'x'.repeat(43) },
    'rebuild:read': read,
    'rebuild:match': MATCH,
    'analysis:buildPlan': { ok: true, analysis: { id: A } },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = typeof init?.body === 'string' ? ((JSON.parse(init.body) as { args: Record<string, unknown>[] }).args[0] ?? {}) : {};
      calls.push({ channel, payload });
      return new Response(JSON.stringify(routes[channel] ?? null), { status: 200 });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:shot', revokeObjectURL: () => {} }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function dropShot() {
  const router = renderApp(`/analyses/${P}/rebuild?dataset=${D}`);
  await screen.findByRole('heading', { level: 1, name: 'Rebuild a dashboard from a screenshot' }, { timeout: LAZY });
  fireEvent.change(shotInput(), { target: { files: [new File(['png'], 'dash.png', { type: 'image/png' })] } });
  await screen.findByRole('heading', { level: 1, name: 'Check the rebuild' }, { timeout: LAZY });
  await screen.findByRole('article', { name: 'Tile 1: Total sales' });
  return router;
}
/** The drop zone's own file input (the shell has another, for project bundles). */
const shotInput = () => screen.getByRole('button', { name: 'Choose a screenshot' }).parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
const lastMatch = (calls: { channel: string; payload: Record<string, any> }[]) => calls.filter((c) => c.channel === 'rebuild:match').at(-1)!.payload;

describe('rebuild a dashboard from a screenshot', () => {
  it('shows each tile as the server matched it: confidence, the server’s figure, its refusal', async () => {
    const calls = serve();
    await dropShot();
    expect(calls.find((c) => c.channel === 'rebuild:read')?.payload).toEqual({ projectId: P, fileToken: 'x'.repeat(43) });
    expect(lastMatch(calls)).toMatchObject({ projectId: P, datasetId: D, overrides: [] });

    const kpi = within(screen.getByRole('article', { name: 'Tile 1: Total sales' }));
    expect(kpi.getByText('Likely')).toBeTruthy();
    expect(kpi.getByText('842')).toBeTruthy();
    expect(kpi.getByText('“Sales”')).toBeTruthy();

    const chart = within(screen.getByRole('article', { name: 'Tile 2: Sales by product' }));
    expect(chart.getByText('Needs you')).toBeTruthy();
    expect(chart.getByRole('note').textContent).toContain('Sum needs a number column, but "Product ID" is text.');
    expect(chart.getByText('Exact')).toBeTruthy();

    expect(screen.getByText(/of 3 tiles ready/).textContent).toBe('2 of 3 tiles ready');
    expect(screen.getByText('1 filter in the bar')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'The dashboard that will be built: 1 KPI' })).toBeTruthy();
  }, 2 * LAZY);

  it('offers only the columns a sum may take, and sends the pick back as an override', async () => {
    const calls = serve();
    await dropShot();
    const chart = within(screen.getByRole('article', { name: 'Tile 2: Sales by product' }));
    const name = 'Tile 2: column for value “Product ID”';
    fireEvent.keyDown(chart.getByRole('combobox', { name }), { key: 'ArrowDown' });
    const list = await screen.findByRole('listbox', { name });
    // jsdom has no layout, so Radix marks the detached popover hidden; the options are there all the same.
    const options = within(list).getAllByRole('option', { hidden: true });
    expect(options.map((o) => o.textContent)).toEqual(['Revenue · number']); // never a text or date column for a sum
    fireEvent.click(options[0]);
    await waitFor(() => expect(lastMatch(calls).overrides).toEqual([{ id: 2, fields: { value0: { column: 'Revenue', aggregation: 'sum' } } }]));
  }, 2 * LAZY);

  it('drops a tile, and creates the dashboard from the server’s plan', async () => {
    const calls = serve();
    const router = await dropShot();
    fireEvent.click(within(screen.getByRole('article', { name: 'Tile 3: Region' })).getByRole('button', { name: 'Drop' }));
    await waitFor(() => expect(lastMatch(calls).overrides).toEqual([{ id: 3, dropped: true }]));

    fireEvent.change(screen.getByLabelText('Dashboard name'), { target: { value: 'My Superstore' } });
    const create = screen.getByRole('button', { name: 'Create dashboard' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/analyses/${P}/${A}`));
    expect(calls.find((c) => c.channel === 'analysis:buildPlan')?.payload).toEqual({ projectId: P, plan: { ...MATCH.plan, name: 'My Superstore' } });
  }, 2 * LAZY);

  it('says why a screenshot could not be read, and starts over', async () => {
    serve({ read: { ok: false, errorType: 'no_tiles', message: 'The model found no dashboard tiles in that screenshot.' } });
    renderApp(`/analyses/${P}/rebuild?dataset=${D}`);
    await screen.findByRole('heading', { level: 1, name: 'Rebuild a dashboard from a screenshot' }, { timeout: LAZY });
    fireEvent.change(shotInput(), { target: { files: [new File(['png'], 'x.png', { type: 'image/png' })] } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The model found no dashboard tiles in that screenshot.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try another screenshot' }));
    expect(await screen.findByRole('button', { name: 'Choose a screenshot' })).toBeTruthy();
  }, 2 * LAZY);

  it('with no model, shows the not-ready state instead of a drop zone', async () => {
    serve({ ai: false });
    renderApp(`/analyses/${P}/rebuild`);
    expect(await screen.findByText('Reading a dashboard screenshot needs AI', undefined, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByTestId('ai-not-ready')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose a screenshot' })).toBeNull();
  });
});
