// The metric editor's Period mode (semantic layer part 5, step 05): a base metric over a window or compared with an
// earlier period. The base list offers only metrics on this dataset that count by a date and are not period metrics
// themselves; % change sets the format to percent, anything else takes the base's. The words and the figure are the
// server's (metric:preview).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc, type RpcReply } from '../../../test-utils';
import { MetricEditor } from './MetricEditor';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D2 = '1c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const REV = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const money = { kind: 'currency', decimals: 0, compact: true };
const summary = (id: string, name: string, definition: object, more: object = {}) => ({ id, name, datasetId: D, datasetName: 'Orders', definition, definitionText: name, format: { kind: 'number' }, updatedAt: '', ...more });
const METRICS = [
  summary(REV, 'Revenue', { column: 'amount', aggregation: 'sum' }, { timeColumn: 'day', format: money }),
  summary('3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', 'Units', { column: 'amount', aggregation: 'count' }),
  summary('4b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', 'Revenue YTD', { base: REV, window: { to_date: 'year' } }),
  summary('5b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', 'Elsewhere', { column: 'amount', aggregation: 'sum' }, { datasetId: D2, timeColumn: 'day' }),
];
const routes = (extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:roles': { body: { [P]: 'editor' } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'dataset:list': { body: [{ id: D, name: 'Orders' }] },
  'dataset:columns': { body: { id: D, name: 'Orders', rowCount: 3, columns: [{ name: 'amount', type: 'number' }, { name: 'day', type: 'date' }] } },
  'metric:list': { body: { ok: true, metrics: METRICS } },
  'metric:preview': { body: { ok: true, display: '$1.2M', definitionText: 'Revenue, year to date', periodRange: { from: '2024-01-01', to: '2024-11-03' } } },
  'metric:save': { body: { ok: true, metric: { id: P, name: 'Revenue YTD', datasetId: D, definition: {}, filters: [], format: money, updatedAt: '' } } },
  'catalog:getTable': { body: { ok: true, table: { role: '', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '' } } },
  ...extra,
});

function mount() {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function periodMode() {
  await screen.findByRole('combobox', { name: 'Dataset' });
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Period' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Period' }));
  const base = await screen.findByRole('combobox', { name: 'Base metric' });
  await waitFor(() => expect((base as HTMLButtonElement).disabled).toBe(false));
  return base;
}

const pick = (label: string) => fireEvent.click(screen.getByRole('option', { name: label }));

describe('the Period mode', () => {
  it('builds "Revenue, year to date" and saves it with no date of its own', async () => {
    const calls = serveRpc(routes());
    mount();
    fireEvent.click(await periodMode());
    pick('Revenue');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Window' })).getByRole('radio', { name: 'To date' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'To date of' }));
    pick('Year to date');
    expect(await screen.findByText('Revenue, year to date')).toBeTruthy(); // the server's words
    expect(screen.getByText('Jan 1 – Nov 3, 2024')).toBeTruthy(); // the days, as the server resolved them
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Revenue YTD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:save')?.payload as { input: { definition: unknown; timeColumn?: string; format: unknown } };
    expect(body.input.definition).toEqual({ base: REV, window: { to_date: 'year' } });
    expect(body.input.timeColumn).toBe(''); // a period metric counts by its base's date
    expect(body.input.format).toMatchObject(money); // the base's format
  });

  it('offers only dated metrics of this dataset that are not period metrics (NEGATIVE CONTROL: Units, Revenue YTD, Elsewhere)', async () => {
    serveRpc(routes());
    mount();
    fireEvent.click(await periodMode());
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['Revenue']);
  });

  it('% change makes it a percent; the prior figure goes back to the base’s format', async () => {
    const calls = serveRpc(routes());
    mount();
    fireEvent.click(await periodMode());
    pick('Revenue');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Compare' })).getByRole('radio', { name: 'Same period last year' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Show' }));
    pick('% change');
    expect(screen.getByRole('combobox', { name: 'Format' }).textContent).toContain('Percent');
    fireEvent.click(screen.getByRole('combobox', { name: 'Show' }));
    pick('The prior figure');
    expect(screen.getByRole('combobox', { name: 'Format' }).textContent).toContain('Currency');
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Revenue LY' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:save')?.payload as { input: { definition: unknown } };
    expect(body.input.definition).toEqual({ base: REV, compare: { vs: 'previous_year', show: 'prior' } });
  });

  it('last N: a number and a unit', async () => {
    const calls = serveRpc(routes());
    mount();
    fireEvent.click(await periodMode());
    pick('Revenue');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Window' })).getByRole('radio', { name: 'Last' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'How many' }), { target: { value: '7' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Revenue 7d' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:save')?.payload as { input: { definition: unknown } };
    expect(body.input.definition).toEqual({ base: REV, window: { last: 7, unit: 'day' } });
  });

  it('NEGATIVE CONTROL: with neither a window nor a comparison there is nothing to save, and it says so', async () => {
    const calls = serveRpc(routes());
    mount();
    fireEvent.click(await periodMode());
    pick('Revenue');
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Bare' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    expect(await screen.findByText('Pick a window, a comparison, or both.')).toBeTruthy();
    expect(calls.some((c) => c.channel === 'metric:save' || (c.channel === 'metric:preview' && 'base' in ((c.payload as { definition: object }).definition ?? {})))).toBe(false);
  });

  it('opens a saved period metric in Period mode, its parts picked', async () => {
    serveRpc(routes());
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MetricEditor projectId={P} existing={{ id: '4b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', name: 'Revenue YTD', datasetId: D, definition: { base: REV, window: { to_date: 'year' } }, filters: [] }} onSaved={() => {}} onClose={() => {}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect((await screen.findByRole('tab', { name: 'Period' })).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Base metric' }).textContent).toContain('Revenue'));
    expect(within(screen.getByRole('radiogroup', { name: 'Window' })).getByRole('radio', { name: 'To date' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('combobox', { name: 'Date it counts by' })).toBeNull(); // its base's date
  });
});
