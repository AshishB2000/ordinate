// The metric editor's Funnel mode (semantic layer part 5, step 08): a funnel saved from the funnel grid. Its steps and
// window are the grid's, shown as words; what it shows is a choice — the conversion rate (a percent), the converted
// count or the entered count. The figure and the words are the server's (metric:preview).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc, type RpcReply } from '../../../test-utils';
import { MetricEditor } from './MetricEditor';
import { FunnelFields, funnelDraft } from './FunnelFields';
import type { FunnelDefinition } from './api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const GRID = { entity: 'user', event: 'event', time: 'ts', steps: ['visit', 'cart', 'buy'], window: { n: 7, unit: 'days' as const }, breakdown: 'country' };
const FUNNEL: FunnelDefinition = { funnel: { entity: 'user', event: 'event', time: 'ts', steps: ['visit', 'cart', 'buy'], window: { n: 7, unit: 'days' } }, show: 'rate' };

const routes = (extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:roles': { body: { [P]: 'editor' } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'dataset:list': { body: [{ id: D, name: 'Shop' }] },
  'dataset:columns': { body: { id: D, name: 'Shop', rowCount: 3, columns: [{ name: 'user', type: 'text' }, { name: 'event', type: 'text' }, { name: 'ts', type: 'date' }] } },
  'metric:list': { body: { ok: true, metrics: [] } },
  'metric:preview': { body: { ok: true, display: '38.2%', definitionText: 'visit → cart → buy within 7 days, conversion rate', notes: ['2 rows without an entity or a readable time were left out.'] } },
  'metric:save': { body: { ok: true, metric: { id: P, name: 'visit → buy', datasetId: D, definition: FUNNEL, filters: [], format: { kind: 'percent' }, updatedAt: '' } } },
  'catalog:getTable': { body: { ok: true, table: { role: '', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '' } } },
  ...extra,
});

describe('Save as metric from the funnel grid', () => {
  it('the draft: the grid\'s funnel without its breakdown, its rate, named by its first and last steps, as a percent', () => {
    const d = funnelDraft(D, GRID);
    expect(d.name).toBe('visit → buy');
    expect(d.datasetId).toBe(D);
    expect(d.definition).toEqual(FUNNEL);
    expect(d.filters).toEqual([]);
    expect(d.format?.kind).toBe('percent');
    expect('breakdown' in (d.definition as FunnelDefinition).funnel).toBe(false);
  });
});

describe('FunnelFields', () => {
  it('says the steps and window in words, and choosing Converted sends show: converted, in a whole-number format', () => {
    const onChange = vi.fn();
    render(<FunnelFields value={FUNNEL} onChange={onChange} />);
    expect(screen.getByText('visit → cart → buy, within 7 days')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Converted' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...FUNNEL, show: 'converted' }, expect.objectContaining({ kind: 'number', decimals: 0 }));
  });

  it('Conversion rate sets the format to percent', () => {
    const onChange = vi.fn();
    render(<FunnelFields value={{ ...FUNNEL, show: 'entered' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Conversion rate' }));
    expect(onChange).toHaveBeenLastCalledWith(FUNNEL, expect.objectContaining({ kind: 'percent' }));
  });
});

describe('the editor in Funnel mode', () => {
  it('opens on the Funnel tab, previews the server\'s words, figure and notes, and saves the funnel with no date of its own', async () => {
    const calls = serveRpc(routes());
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MetricEditor projectId={P} existing={funnelDraft(D, GRID)} onSaved={() => {}} onClose={() => {}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect((await screen.findByRole('tab', { name: 'Funnel' })).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('combobox', { name: 'Date it counts by' })).toBeNull();
    await screen.findByText('38.2%');
    await screen.findByText('2 rows without an entity or a readable time were left out.');
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    const input = (calls.find((c) => c.channel === 'metric:save')!.payload as { input: Record<string, unknown> }).input;
    expect(input.definition).toEqual(FUNNEL);
    expect(input.timeColumn).toBe('');
    expect(input.name).toBe('visit → buy');
  });

  it('NEGATIVE CONTROL: a new metric offers no Funnel tab (a funnel comes from the grid)', async () => {
    serveRpc(routes());
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: 'Period' });
    expect(screen.queryByRole('tab', { name: 'Funnel' })).toBeNull();
  });
});
