// A layer's metric in the metric editor (semantic layer part 7, b3; D13): its definition and filters are its layer's,
// shown as text with "Defined in {layer}: edit it there."; its name, format, description and direction are Ordinate's.
// A save never sends a definition or filters, so the editor cannot erase a mirror. And a KPI tile names it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc } from '../../../test-utils';
import { MetricEditor } from './MetricEditor';
import { metricLabel } from '../editor/MetricCard';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const MIRROR = { id: M, name: 'revenue', datasetId: D, definition: { external: 'revenue', layer: 'fake', additive: true }, filters: [], format: { kind: 'number' }, updatedAt: '', tag: 't1' };

function mount(existing: object = MIRROR) {
  const calls = serveRpc({
    'projects:roles': { body: { [P]: 'editor' } },
    'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
    'dataset:list': { body: [{ id: D, name: 'Orders layer', mode: 'live', semantic: { layer: 'fake', label: 'Fake layer' } }] },
    'dataset:columns': { body: { id: D, name: 'Orders layer', rowCount: 0, columns: [{ name: 'region', type: 'text' }], mode: 'live' } },
    'metric:list': { body: { ok: true, metrics: [] } },
    'metric:update': (p: unknown) => ({ body: { ok: true, metric: { ...MIRROR, ...(p as { patch: object }).patch }, tag: 't2' } }),
  });
  const onSaved = vi.fn();
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MetricEditor projectId={P} existing={existing as never} onSaved={onSaved} onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { calls, onSaved };
}

describe('a layer’s metric in the editor', () => {
  it('shows its definition and filters as text, and where to change them', async () => {
    mount();
    expect(await screen.findByText('Defined in Fake layer: edit it there.')).toBeTruthy();
    expect(screen.getByText('revenue', { selector: 'code' })).toBeTruthy();
    expect(screen.getByText('Can be added up')).toBeTruthy();
    expect(screen.getByText('None in Ordinate: Fake layer applies its own.')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Formula' })).toBeNull(); // no other kind to switch to
    expect(screen.queryByRole('combobox', { name: 'Column' })).toBeNull();
  });

  it('a format change saves without a definition or filters', async () => {
    const { calls, onSaved } = mount();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Description' }), { target: { value: 'Money in, as the layer counts it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const update = calls.find((c) => c.channel === 'metric:update')?.payload as { patch: Record<string, unknown>; base?: string };
    expect(update.patch).toEqual({ name: 'revenue', format: { kind: 'number', decimals: 0, prefix: '', suffix: '', compact: false }, description: 'Money in, as the layer counts it', direction: '' });
    expect(update.base).toBe('t1'); // the editor's tag (docs/edit-conflicts)
  });

  it('a KPI tile over it is named for it, never “Sum of”', () => {
    expect(metricLabel({ datasetId: D, column: '', aggregation: 'sum', metricId: M }, 'revenue')).toBe('revenue');
    expect(metricLabel({ datasetId: D, column: '', aggregation: 'sum', metricId: M })).toBe('Metric');
    // NEGATIVE CONTROL: a column KPI keeps its words
    expect(metricLabel({ datasetId: D, column: 'amount', aggregation: 'sum' })).toBe('Sum of amount');
  });
});
