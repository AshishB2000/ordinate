import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Card } from '../analyses/api';
import type { EditorApi } from '../analyses/editor/context';
import { changeRequest, CompareSummary, SUMMARY_KPIS, usable } from './CompareBar';
import type { Compare } from './useViewer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DS = '22222222-2222-4222-8222-222222222222';
const FILTERS = [{ type: 'filter', column: 'region', op: '=', value: 'East' }];
const kpi = (id: string, label: string, extra: object = {}): Card => ({ id, type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: DS, column: 'revenue', aggregation: 'sum', label, ...extra } }) as Card;

/** Stubs the RPC route; returns each drivers:explain request the strip sent. */
function serve(reply: (request: { metric: { label?: string } }) => unknown) {
  const sent: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: { request: { metric: { label?: string } } }[] }).args[0] : undefined;
      if (url.includes('drivers%3Aexplain') || url.includes('drivers:explain')) {
        sent.push(payload?.request);
        return new Response(JSON.stringify(reply(payload!.request)), { status: 200 });
      }
      return new Response('null', { status: 200 });
    }),
  );
  return sent;
}

function show(compare: Compare | null, cards: Card[]) {
  const ed = { projectId: PID, filters: FILTERS, cards, view: { compare } } as unknown as EditorApi;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CompareSummary ed={ed} />
    </QueryClientProvider>,
  );
}

describe('the sheet’s Compare', () => {
  it('a custom comparison is usable only with both dates', () => {
    expect(usable(null)).toBeNull();
    expect(usable({ mode: 'previous_year' })).toEqual({ mode: 'previous_year' });
    expect(usable({ mode: 'custom' })).toBeNull();
    expect(usable({ mode: 'custom', from: '2024-01-01' })).toBeNull();
    expect(usable({ mode: 'custom', from: '2024-01-01', to: '2024-01-31' })).toEqual({ mode: 'custom', from: '2024-01-01', to: '2024-01-31' });
  });

  it('asks of a KPI exactly what its "Why?" asks: the card’s metric, the sheet’s filters, the compare', () => {
    expect(changeRequest(kpi('a', 'Revenue', { metricId: 'm1' }), FILTERS, { mode: 'previous_period' })).toEqual({
      datasetId: DS,
      metric: { metricId: 'm1', column: 'revenue', aggregation: 'sum', label: 'Revenue' },
      filters: FILTERS,
      compare: { mode: 'previous_period' },
      path: [],
    });
    expect(changeRequest({ id: 't', type: 'text', layout: { x: 0, y: 0, w: 1, h: 1 } } as Card, FILTERS, { mode: 'previous_period' })).toBeNull();
  });

  it('NEGATIVE CONTROL: off, there is no strip and nothing is asked', () => {
    const sent = serve(() => ({ ok: true, caption: 'x', headline: 'x' }));
    show(null, [kpi('a', 'Revenue')]);
    expect(screen.queryByRole('region', { name: 'What changed' })).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('on, each KPI’s line is the server’s sentence — the headline when nothing drove it — for the first few KPIs only', async () => {
    const cards = ['Revenue', 'Units', 'Margin', 'Orders', 'Refunds'].map((l, i) => kpi(String(i), l));
    const sent = serve((r) => (r.metric.label === 'Units' ? { ok: true, caption: '', headline: 'Units fell 12' } : { ok: true, caption: `${r.metric.label} rose 5; West explains 61%.`, headline: 'n/a' }));
    show({ mode: 'previous_year' }, cards);
    const strip = screen.getByRole('region', { name: 'What changed' });
    expect(strip.textContent).toContain('What changed · vs same period last year');
    expect(await screen.findByText('Revenue rose 5; West explains 61%.')).toBeTruthy();
    expect(await screen.findByText('Units fell 12.')).toBeTruthy();
    expect(await screen.findByText('Margin rose 5; West explains 61%.')).toBeTruthy();
    expect(screen.queryByText(/^Orders rose/)).toBeNull();
    await waitFor(() => expect(sent).toHaveLength(SUMMARY_KPIS));
  });

  it('one reason for every line (no date in scope) is said once', async () => {
    serve(() => ({ ok: false, error: 'There is no date range in scope to compare — add a date filter or a date control first.' }));
    show({ mode: 'previous_period' }, [kpi('a', 'Revenue'), kpi('b', 'Units')]);
    expect(await screen.findAllByText('There is no date range in scope to compare — add a date filter or a date control first.')).toHaveLength(1);
  });

  it('half a custom range asks nothing and says what is missing; a sheet with no KPI says where the comparison shows', async () => {
    const sent = serve(() => ({ ok: true, caption: 'x', headline: 'x' }));
    const half = show({ mode: 'custom', from: '2024-01-01' }, [kpi('a', 'Revenue')]);
    expect(screen.getByText('Pick both dates to compare with.')).toBeTruthy();
    expect(sent).toHaveLength(0);
    half.unmount();
    show({ mode: 'previous_period' }, []);
    expect(screen.getByText(/^The bar charts on this sheet show the comparison period beside each bar\./)).toBeTruthy();
    expect(sent).toHaveLength(0);
  });
});
