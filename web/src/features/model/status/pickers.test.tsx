// Pickers read one order (certified first) and fold retired items away with their replacement.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { EncodingForm } from '../../visuals/EncodingForm';
import { FilterRows } from '../../visuals/filters/FilterRows';
import { AddKpiDialog } from '../../analyses/editor/AddKpi';
import { EditorCtx, type EditorApi } from '../../analyses/editor/context';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const at = { by: 'ana@acme.com', at: '2026-11-03T10:00:00Z', note: '' };
const metric = (id: string, name: string, status?: object) => ({
  id, name, datasetId: DID, datasetName: 'Sales', definition: { column: 'revenue', aggregation: 'sum' }, definitionText: 'sum of revenue', format: { kind: 'number' }, updatedAt: '', ...(status && { status }),
});
const NET = '33333333-3333-4333-8333-333333333333';
const GROSS = '44444444-4444-4444-8444-444444444444';
const PLAIN = '55555555-5555-4555-8555-555555555555';
const METRICS = [
  metric(GROSS, 'Gross revenue', { state: 'retired', ...at, replacedBy: { ref: `metric:${NET}`, name: 'Net revenue' } }),
  metric(PLAIN, 'Plain'),
  metric(NET, 'Net revenue', { state: 'certified', ...at }),
];

function serve(routes: Record<string, unknown>) {
  const calls: { channel: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const channel = decodeURIComponent(url.split('?')[0].replace('/api/rpc/', ''));
      calls.push({ channel });
      return new Response(JSON.stringify(routes[channel] ?? []), { status: 200 });
    }),
  );
  return calls;
}
const wrap = (el: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={createMemoryRouter([{ path: '/', element: el }])} />
    </QueryClientProvider>,
  );
};
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))));

describe('the measure picker', () => {
  const mount = () =>
    wrap(<EncodingForm projectId={PID} datasetId={DID} cols={[{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }]} related={[]} encoding={{ category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }} info={undefined} canEdit onChange={() => {}} />);
  it('lists the certified metric first, folds the retired one under "Retired (1)" with its replacement', async () => {
    serve({ 'metric:list': { ok: true, metrics: METRICS }, 'projects:roles': { [PID]: 'editor' } });
    mount();
    await screen.findByRole('button', { name: 'Retired (1)' });
    await settle();
    fireEvent.click(screen.getByRole('combobox', { name: 'Measure column' }));
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names.slice(names.indexOf('Metrics') + 1, names.indexOf('Metrics') + 3)).toEqual(['Net revenue', 'Plain']);
    expect(names).not.toContain('Gross revenue');
    fireEvent.click(screen.getByRole('button', { name: 'Retired (1)' }));
    expect(screen.getByText('Gross revenue · use Net revenue')).toBeTruthy();
  });
  it('NEGATIVE CONTROL: with no status the order is the server\'s and there is no Retired group', async () => {
    const plain = METRICS.map(({ status: _s, ...m }) => m);
    const calls = serve({ 'metric:list': { ok: true, metrics: plain }, 'projects:roles': { [PID]: 'editor' } });
    mount();
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:list')).toBe(true));
    await settle();
    fireEvent.click(screen.getByRole('combobox', { name: 'Measure column' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Gross revenue');
    expect(screen.queryByRole('button', { name: /Retired/ })).toBeNull();
  });
});

describe('Add KPI', () => {
  it('folds retired metrics the same way', async () => {
    serve({ 'metric:list': { ok: true, metrics: METRICS }, 'projects:roles': { [PID]: 'editor' }, 'metric:values': { ok: true, values: {} } });
    const ed = { projectId: PID, filters: [], params: {} } as unknown as EditorApi;
    wrap(
      <EditorCtx.Provider value={ed}>
        <AddKpiDialog onClose={() => {}} />
      </EditorCtx.Provider>,
    );
    await screen.findByText('Net revenue');
    const rows = screen.getAllByRole('listitem').map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('Net revenue');
    expect(rows.some((r) => r.includes('Gross revenue'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retired (1)' }));
    expect(screen.getByText('Gross revenue · use Net revenue')).toBeTruthy();
  });
});

describe('the filter list\'s Add term', () => {
  it('puts a certified term first', async () => {
    const term = (id: string, name: string, status?: object) => ({ id, name, aliases: [], datasetId: DID, datasetName: 'Sales', definition: 'x', updatedAt: '', ...(status && { status }) });
    serve({ 'term:list': { ok: true, terms: [term('a', 'Alpha'), term('b', 'Beta', { state: 'certified', ...at })] } });
    wrap(<FilterRows projectId={PID} datasetId={DID} cols={[{ name: 'region', type: 'text' }]} filters={[]} onChange={() => {}} />);
    const trigger = await screen.findByRole('button', { name: 'Add term' });
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Beta', 'Alpha']);
  });
});
