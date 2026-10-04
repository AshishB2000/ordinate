import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AnalyticsPane, defaultsFor } from './analytics/AnalyticsPane';
import { FacetShelf } from './facets/FacetShelf';
import { facetGridOf } from './facets/FacetGrid';
import { FilterDialog } from './filters/FilterDialog';
import { liveFilters, stepSummary } from './filters/filterText';
import { customOrder } from './format/SortOrder';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function serve(routes: Record<string, (payload: Record<string, unknown>) => unknown>) {
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const channel = decodeURIComponent(url.replace('/api/rpc/', ''));
      const payload = (JSON.parse(String(init?.body)) as { args: [Record<string, unknown>] }).args[0];
      calls.push({ channel, payload });
      return Response.json(routes[channel] ? routes[channel](payload) : null);
    }),
  );
  return calls;
}

describe('filter words', () => {
  it('summarises a step the way the row shows it', () => {
    expect(stepSummary({ type: 'filter', column: 'r', op: 'in', values: ['a', 'b', 'c', 'd', 'e'] })).toBe('is any of a, b, c +2');
    expect(stepSummary({ type: 'filter', column: 'r', op: 'not in', values: [] })).toBe('is none of — no values yet');
    expect(stepSummary({ type: 'filter', column: 'r', op: 'is_empty' })).toBe('is empty');
    expect(stepSummary({ type: 'filter', column: 'r', op: '>=', value: 3 })).toBe('at least 3');
    expect(stepSummary({ type: 'filter', column: 'r', op: 'period', period: { preset: 'ytd' } }, 'Year to date')).toBe('in Year to date');
    expect(stepSummary({ type: 'filter', column: 'r', op: '' })).toBe('');
  });
  it('sends only rows with a column AND an operator, each in its own shape', () => {
    const rows = [
      { type: 'filter' as const, column: 'r', op: '' },
      { type: 'filter' as const, column: 'r', op: 'in', values: ['x'], value: 'stale' },
      { type: 'filter' as const, column: 'd', op: 'period', period: { preset: 'last_n_days', n: 7 }, context: true },
      { type: 'filter' as const, column: 'n', op: 'not_empty', value: 'x' },
    ];
    expect(liveFilters(rows)).toEqual([
      { type: 'filter', column: 'r', op: 'in', values: ['x'] },
      { type: 'filter', column: 'd', op: 'period', period: { preset: 'last_n_days', n: 7 }, context: true },
      { type: 'filter', column: 'n', op: 'not_empty' },
    ]);
  });
});

describe('the filter dialog', () => {
  it('lists the server\'s distinct values, says when the list is a window, and applies `in` / `not in`', async () => {
    const calls = serve({ 'dataset:distinct': () => ({ values: ['East', 'North'], total: 5 }) });
    const onApply = vi.fn();
    wrap(<FilterDialog projectId={P} datasetId={D} column="region" type="text" lodToggle onClose={() => undefined} onApply={onApply} />);
    expect(await screen.findByText('Showing the first 2 of 5 values — search to narrow.')).toBeTruthy();
    expect(calls[0].payload).toEqual({ projectId: P, datasetId: D, column: 'region', limit: 200 });
    const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true); // nothing chosen → nothing to apply
    fireEvent.click(screen.getByLabelText('North'));
    fireEvent.click(screen.getByLabelText('Exclude these'));
    fireEvent.click(screen.getByLabelText('Apply before LOD'));
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith([{ type: 'filter', column: 'region', op: 'not in', values: ['North'], context: true }]);
  });

  it('turns a number range into two AND-ed steps, and re-opens a `>=` in the Minimum box', () => {
    const onApply = vi.fn();
    wrap(<FilterDialog projectId={P} datasetId={D} column="amount" type="number" existing={{ type: 'filter', column: 'amount', op: '>=', value: '10' }} onClose={() => undefined} onApply={onApply} />);
    expect((screen.getByLabelText('Minimum') as HTMLInputElement).value).toBe('10');
    fireEvent.change(screen.getByLabelText('Maximum'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith([
      { type: 'filter', column: 'amount', op: '>=', value: '10' },
      { type: 'filter', column: 'amount', op: '<=', value: '99' },
    ]);
  });
});

describe('the analytics pane', () => {
  it('adds an overlay the chart draws, and greys out the ones it does not', async () => {
    const onChange = vi.fn();
    wrap(<AnalyticsPane type="pie" data={{ labels: ['a'], series: [{ name: 's', values: [1] }] }} overlays={[]} onChange={onChange} />);
    expect(screen.getByText(/Lay a reference line/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const ref = await screen.findByRole('menuitem', { name: /Reference line/ });
    expect((ref as HTMLButtonElement).disabled).toBe(true); // a pie has no value axis
  });
  it('shows the server\'s readout for an overlay, never its own figure', () => {
    const ov = { ...defaultsFor('reference', ['a']), id: 'r1' };
    wrap(
      <AnalyticsPane
        type="column"
        data={{ labels: ['a'], series: [{ name: 's', values: [1] }], analytics: [{ id: 'r1', kind: 'reference', label: 'Average', text: 'Average 12.3K' }] }}
        overlays={[ov]}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText('Average 12.3K')).toBeTruthy();
  });
  it('starts a target at the series maximum, resolved by the server', () => {
    expect(defaultsFor('target', []).value).toEqual({ type: 'stat', stat: 'max' });
  });
});

describe('small multiples', () => {
  it('stores rows / columns, one field per side, and clears to null', async () => {
    const onChange = vi.fn();
    const cols = [
      { name: 'region', type: 'text' as const },
      { name: 'segment', type: 'text' as const },
    ];
    const { rerender } = wrap(<FacetShelf cols={cols} facet={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Rows' }));
    fireEvent.click(await screen.findByRole('option', { name: 'region' }));
    expect(onChange).toHaveBeenLastCalledWith({ rows: 'region' });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <FacetShelf cols={cols} facet={{ rows: 'region' }} onChange={onChange} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Columns' }));
    fireEvent.click(await screen.findByRole('option', { name: 'region' }));
    expect(onChange).toHaveBeenLastCalledWith({ cols: 'region' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
  });
  it('a share chart over several series becomes one panel per series; Periods hides panels', () => {
    const data = { labels: ['a', 'b'], series: [{ name: '2023', values: [1, 2] }, { name: '2024', values: [3, 4] }] };
    expect(facetGridOf(data, 'pie')?.panels.map((p) => p.title)).toEqual(['2023', '2024']);
    expect(facetGridOf(data, 'pie', { hiddenSeries: [0] })?.panels.map((p) => p.title)).toEqual(['2024']);
    expect(facetGridOf(data, 'column')).toBeNull();
  });
});

describe('a custom sort order', () => {
  it('is the stored order, then every other label as it came', () => {
    expect(customOrder(['a', 'b', 'c', 'd'], ['c', 'gone', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });
});
