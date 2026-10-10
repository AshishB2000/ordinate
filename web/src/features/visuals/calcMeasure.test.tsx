// The builder's measure picker and the calculated-field dialog it opens
// (./EncodingForm.tsx + ../calc): a saved metric is a measure like a column is,
// and a new one is made without leaving the chart.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { Encoding } from './api';
import { EncodingForm } from './EncodingForm';
import { fitEncoding, type Column } from './model';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const OTHER = '55555555-5555-4555-8555-555555555555';
const SIMPLE = '33333333-3333-4333-8333-333333333333';
const FORMULA = '44444444-4444-4444-8444-444444444444';
const COLS: Column[] = [
  { name: 'region', type: 'text' },
  { name: 'profit', type: 'number' },
  { name: 'revenue', type: 'number' },
];
const metric = (id: string, name: string, datasetId: string, definition: object, definitionText: string) => ({ id, name, datasetId, datasetName: 'Sales', definition, definitionText, format: { kind: 'number' }, updatedAt: '' });
const METRICS = [
  metric(SIMPLE, 'Total revenue', DID, { column: 'revenue', aggregation: 'sum' }, 'sum of revenue'),
  metric(FORMULA, 'Margin %', DID, { formula: 'sum([profit]) / sum([revenue])' }, 'sum([profit]) / sum([revenue])'),
  metric('66666666-6666-4666-8666-666666666666', 'Elsewhere', OTHER, { column: 'x', aggregation: 'sum' }, 'sum of x'),
];
const BASE: Encoding = { category: 'region', values: [{ column: 'profit', aggregation: 'sum' }] };

function serve(routes: Record<string, unknown>) {
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload: init?.body ? (JSON.parse(String(init.body)) as { args: Record<string, unknown>[] }).args[0] : {} });
      return new Response(JSON.stringify(routes[channel] ?? []), { status: 200 });
    }),
  );
  return calls;
}
const SERVER = { 'metric:list': { ok: true, metrics: METRICS }, 'projects:roles': { [PID]: 'editor' }, 'formula:functions': [] };

function mount(props: Partial<Parameters<typeof EncodingForm>[0]> = {}) {
  const onChange = vi.fn<(e: Encoding) => void>();
  const onFormat = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = <EncodingForm projectId={PID} datasetId={DID} cols={COLS} related={[]} encoding={BASE} info={undefined} canEdit onChange={onChange} onFormat={onFormat} {...props} />;
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={createMemoryRouter([{ path: '/', element: el }])} />
    </QueryClientProvider>,
  );
  return { onChange, onFormat };
}
/**
 * Open the measure picker once the project's metrics are in. (Opened first, jsdom's
 * zero-sized rects make the popover hide itself when its options change, so the
 * list is waited for by its request, not by an option appearing.)
 */
const openPicker = async (calls: { channel: string }[]) => {
  await waitFor(() => expect(calls.some((c) => c.channel === 'metric:list')).toBe(true));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  fireEvent.click(screen.getByRole('combobox', { name: 'Measure column' }));
};

describe('the builder’s measure picker', () => {
  it('lists this dataset’s metrics beside its columns, and the way to write a new one', async () => {
    const calls = serve(SERVER);
    mount();
    await openPicker(calls);
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['profit', 'revenue', 'Metrics', 'Total revenue', 'Margin %', '+ New calculated measure…']);
    expect(screen.getByRole('button', { name: 'Calculated measure' })).toBeTruthy();
  });

  it('a formula metric becomes a measure named for it; a simple metric keeps its column and aggregation', async () => {
    const calls = serve(SERVER);
    const { onChange } = mount();
    await openPicker(calls);
    fireEvent.click(screen.getByRole('option', { name: 'Margin %' }));
    expect(onChange).toHaveBeenLastCalledWith({ category: 'region', values: [{ column: 'Margin %', aggregation: 'count', metricId: FORMULA }] });
    fireEvent.click(screen.getByRole('combobox', { name: 'Measure column' }));
    fireEvent.click(screen.getByRole('option', { name: 'Total revenue' }));
    expect(onChange).toHaveBeenLastCalledWith({ category: 'region', values: [{ column: 'revenue', aggregation: 'sum', metricId: SIMPLE }] });
  });

  it('a metric measure shows what it is, with its edit; leaving it for a column sums that column', async () => {
    serve(SERVER);
    const { onChange } = mount({ encoding: { category: 'region', values: [{ column: 'Margin %', aggregation: 'count', metricId: FORMULA }] } });
    await screen.findByRole('button', { name: 'Edit the metric Margin %' });
    expect(screen.getByRole('combobox', { name: 'Measure column' }).textContent).toBe('Margin %');
    // No aggregation to choose: the metric's formula is the calculation.
    expect(screen.queryByRole('combobox', { name: 'Aggregation' })).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'Measure column' }));
    fireEvent.click(screen.getByRole('option', { name: 'revenue' }));
    expect(onChange).toHaveBeenLastCalledWith({ category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] });
  });

  it('"New calculated measure…" opens the dialog in place; saving sets the measure and its format in one step', async () => {
    const saved = { id: '77777777-7777-4777-8777-777777777777', name: 'Share', datasetId: DID, definition: { formula: 'sum([profit]) / sum([revenue])' }, format: { kind: 'percent', decimals: 1 }, filters: [], updatedAt: '' };
    const calls = serve({ ...SERVER, 'metric:check': { ok: true, valid: true, tokens: [], preview: { ok: true, value: 0.25, display: '25.0%', definitionText: 'x' } }, 'metric:save': { ok: true, metric: saved } });
    const { onChange, onFormat } = mount();
    await openPicker(calls);
    fireEvent.click(screen.getByRole('option', { name: '+ New calculated measure…' }));
    const dialog = screen.getByRole('dialog', { name: 'New calculated field' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Share' } });
    fireEvent.change(within(dialog).getByLabelText('Formula'), { target: { value: 'sum([profit]) / sum([revenue])', selectionStart: 30 } });
    await within(dialog).findByText('25.0%');
    // Opened from a chart: the check is asked to keep every operand on this dataset.
    expect(calls.findLast((c) => c.channel === 'metric:check')?.payload).toMatchObject({ datasetId: DID, chart: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create measure' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ category: 'region', values: [{ column: 'Share', aggregation: 'count', metricId: saved.id }] }));
    // The chart's only measure: its figures read as the metric's format says.
    expect(onFormat).toHaveBeenCalledWith('percent');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New calculated field' })).toBeNull());
  });

  it('a viewer picks from what exists: no way to write a measure, no edit', async () => {
    const calls = serve(SERVER);
    mount({ canEdit: false, encoding: { category: 'region', values: [{ column: 'Margin %', aggregation: 'count', metricId: FORMULA }] } });
    await openPicker(calls);
    expect(screen.getByRole('option', { name: 'Total revenue' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '+ New calculated measure…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Calculated measure' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit the metric Margin %' })).toBeNull();
  });

  it('on a Live dataset the dialog offers the measure and turns the column off', async () => {
    serve(SERVER);
    mount({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Calculated measure' }));
    const dialog = screen.getByRole('dialog', { name: 'New calculated field' });
    expect(within(dialog).getByRole('radio', { name: /^Column/ }).getAttribute('aria-disabled')).toBe('true');
    expect(within(dialog).getByRole('radio', { name: /^Measure/ }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('reopening a saved visual', () => {
  it('keeps a measure that is a metric, though its name is not a column', () => {
    const saved: Encoding = { category: 'region', values: [{ column: 'Margin %', aggregation: 'count', metricId: FORMULA }, { column: 'gone', aggregation: 'sum' }] };
    expect(fitEncoding(saved, COLS, []).values).toEqual([{ column: 'Margin %', aggregation: 'count', metricId: FORMULA }]);
  });
});
