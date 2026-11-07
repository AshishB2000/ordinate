// Saving a certified metric (semantic D5): a change that moves its pin first names the certifier and the usage.
// Any other save goes straight through. Each case has its negative control.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc } from '../../../test-utils';
import { MetricEditor } from './MetricEditor';

afterEach(() => {
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const REVENUE = {
  id: M, name: 'Revenue', datasetId: D, definition: { column: 'amount', aggregation: 'sum' }, filters: [], format: { kind: 'number' }, updatedAt: '', tag: 't1',
  status: { state: 'certified', by: 'ana@acme.com', at: '2026-11-03T10:00:00Z', note: '' },
};
const routes = () => ({
  'projects:roles': { body: { [P]: 'editor' } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'dataset:list': { body: [{ id: D, name: 'Sales' }] },
  'dataset:columns': { body: { id: D, name: 'Sales', rowCount: 3, columns: [{ name: 'amount', type: 'number' }] } },
  'metric:list': { body: { ok: true, metrics: [] } },
  'metric:preview': { body: { ok: true, display: '6', definitionText: 'sum of amount' } },
  'metric:update': { body: { ok: true, metric: REVENUE, tag: 't2' } },
  'metric:usage': { body: { ok: true, usage: { total: 31, summary: '31 charts', refs: [] } } },
});

function mount(existing: object = REVENUE) {
  const calls = serveRpc(routes());
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MetricEditor projectId={P} existing={existing as never} used="31 charts" onSaved={() => {}} onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return calls;
}

describe('saving a certified metric', () => {
  it('a definition change warns first, with the certifier and the count, and Save anyway saves', async () => {
    const calls = mount();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Net revenue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Net revenue is certified by ana@acme\.com\. Saving changes 31 charts and needs a project admin to certify it again\./)).toBeTruthy();
    expect(calls.some((c) => c.channel === 'metric:update')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:update')).toBe(true));
  });
  it('NEGATIVE CONTROL: a description change saves with no warning', async () => {
    const calls = mount();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Description' }), { target: { value: 'Money in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:update')).toBe(true));
    expect(screen.queryByText(/is certified by/)).toBeNull();
  });
  it('NEGATIVE CONTROL: an uncertified metric saves a definition change with no warning', async () => {
    const calls = mount({ ...REVENUE, status: undefined });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Net revenue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:update')).toBe(true));
    expect(calls.some((c) => c.channel === 'metric:usage')).toBe(false);
  });
});
