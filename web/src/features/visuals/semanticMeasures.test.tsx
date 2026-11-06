// The builder on a semantic dataset (semantic layer part 7, b3): its measures are the layer's metrics (the mirrors), by
// their own names, and its date grains are the ones the layer lists. Nothing here adds anything up: the picker writes
// what the server's door reads, `{ column: '', aggregation: 'sum', metricId }`. An extract's picker is unchanged
// (./calcMeasure.test.tsx and ./countd.test.tsx run against it as before).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { serveRpc } from '../../test-utils';
import type { Encoding } from './api';
import { EncodingForm } from './EncodingForm';
import { fitEncoding, type Column } from './model';
import { semanticEncoding } from './SemanticMeasures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const REV = '33333333-3333-4333-8333-333333333333';
const AVG = '44444444-4444-4444-8444-444444444444';
const COLS: Column[] = [
  { name: 'region', type: 'text' },
  { name: 'amt', type: 'number' },
  { name: 'd', type: 'date' },
];
const mirror = (id: string, name: string, additive: boolean) => ({
  id, name, datasetId: DID, datasetName: 'Orders layer', definition: { external: name, layer: 'fake', ...(additive ? { additive: true } : {}) }, definitionText: 'Defined in Fake layer', format: { kind: 'number' }, updatedAt: '',
});
const MIRRORS = [mirror(REV, 'revenue', true), mirror(AVG, 'avg_amount', false)];
const SEMANTIC = { layer: 'fake', label: 'Fake layer', dataset: 'Orders layer', grains: [{ column: 'd', grains: ['day', 'week', 'month'] }] };
const ON_REV: Encoding = { category: 'region', values: [{ column: '', aggregation: 'sum', metricId: REV }] };

function mount(encoding: Encoding, metrics: object[] = MIRRORS, semantic: typeof SEMANTIC = SEMANTIC) {
  const calls = serveRpc({ 'metric:list': { body: { ok: true, metrics } }, 'projects:roles': { body: { [PID]: 'editor' } } });
  const onChange = vi.fn<(e: Encoding) => void>();
  const el = <EncodingForm projectId={PID} datasetId={DID} cols={COLS} related={[]} encoding={encoding} info={undefined} live canEdit semantic={semantic} onChange={onChange} />;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={createMemoryRouter([{ path: '/', element: el }])} />
    </QueryClientProvider>,
  );
  return { onChange, calls };
}
const settle = async (calls: { channel: string }[]) => {
  await waitFor(() => expect(calls.some((c) => c.channel === 'metric:list')).toBe(true));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
};
const optionTexts = () => screen.getAllByRole('option').map((o) => o.textContent ?? '');

describe('the builder on a semantic dataset', () => {
  it('lists only the layer’s metrics, headed by the layer and the dataset, each saying whether it can be added up', async () => {
    const { calls } = mount(ON_REV);
    await settle(calls);
    fireEvent.click(screen.getByRole('combobox', { name: 'Measure' }));
    const texts = optionTexts();
    expect(texts[0]).toBe('Metrics from Fake layer · Orders layer');
    expect(texts.slice(1)).toEqual(['revenuecan be added up', 'avg_amountcan’t be added up']);
    expect(texts.some((t) => t.startsWith('amt'))).toBe(false); // no column measures on a layer
    expect(screen.queryByRole('combobox', { name: 'Aggregation' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Calculated measure/ })).toBeNull(); // a formula over a layer is refused
  });

  it('picking a metric writes the measure the layer’s door reads', async () => {
    const { calls, onChange } = mount(ON_REV);
    await settle(calls);
    fireEvent.click(screen.getByRole('combobox', { name: 'Measure' }));
    fireEvent.click(screen.getByRole('option', { name: /^avg_amount/ }));
    expect(onChange).toHaveBeenLastCalledWith({ category: 'region', values: [{ column: '', aggregation: 'sum', metricId: AVG }] });
  });

  it('says where a metric is defined, beside the measure', async () => {
    const { calls } = mount(ON_REV);
    await settle(calls);
    expect(screen.getByTitle('Defined in Fake layer: edit it there.')).toBeTruthy();
  });

  it('offers the layer’s grains for a date, no Auto, and a picked date starts at month', async () => {
    const { calls, onChange } = mount({ ...ON_REV, category: 'd', grain: 'week' });
    await settle(calls);
    fireEvent.click(screen.getByRole('combobox', { name: 'Date grain' }));
    expect(optionTexts()).toEqual(['Day', 'Week', 'Month']);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Date grain' }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('combobox', { name: 'Category' }));
    expect(optionTexts()).toEqual(['region', 'd']); // a number field is no axis on a layer: it would be binned here
    fireEvent.click(screen.getByRole('option', { name: 'region' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.not.objectContaining({ grain: expect.anything() }));
  });

  it('a date picked as the category takes the layer’s month, else its first grain', async () => {
    const { calls, onChange } = mount(ON_REV);
    await settle(calls);
    fireEvent.click(screen.getByRole('combobox', { name: 'Category' }));
    fireEvent.click(screen.getByRole('option', { name: 'd' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'd', grain: 'month' }));
    cleanup();
    const second = mount(ON_REV, MIRRORS, { ...SEMANTIC, grains: [{ column: 'd', grains: ['week', 'quarter'] }] });
    await settle(second.calls);
    fireEvent.click(screen.getByRole('combobox', { name: 'Category' }));
    fireEvent.click(screen.getByRole('option', { name: 'd' }));
    expect(second.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'd', grain: 'week' }));
  });

  it('a dataset whose layer lists no metric yet says so', async () => {
    const { calls } = mount({ category: 'region', values: [] }, []);
    await settle(calls);
    expect(screen.getByText('Orders layer has no metrics yet. Sync it after adding them in Fake layer.')).toBeTruthy();
  });

  it('a new chart starts from the first metric, and a saved mirror measure is kept (never "amt / Sum")', () => {
    expect(semanticEncoding(COLS, MIRRORS, SEMANTIC.grains)).toEqual({ category: 'region', values: [{ column: '', aggregation: 'sum', metricId: REV }] });
    expect(semanticEncoding([{ name: 'd', type: 'date' }], MIRRORS, SEMANTIC.grains)).toEqual({ category: 'd', grain: 'month', values: [{ column: '', aggregation: 'sum', metricId: REV }] });
    expect(fitEncoding(ON_REV, COLS, [])).toEqual(ON_REV);
    // NEGATIVE CONTROL: a column measure the dataset lacks still falls back, as before
    expect(fitEncoding({ category: 'region', values: [{ column: 'gone', aggregation: 'sum' }] }, COLS, []).values).toEqual([{ column: 'amt', aggregation: 'sum' }]);
  });
});
