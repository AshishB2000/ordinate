// "Alert me…" on a metric with a target (semantic part 5, D14): a Target tab, below or above a percent of it, shown only
// when the metric has a target. The server decides whether the rule fires; the dialog saves what was asked.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc } from '../../test-utils';
import type { Card } from '../analyses/api';
import { AlertDialog, subjectOf, type AlertSubject } from './AlertDialog';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const SAVED = { id: M, name: 'Revenue', datasetId: D, datasetName: 'Orders', definition: { column: 'amount', aggregation: 'sum' }, definitionText: 'sum of amount', filters: [], format: { kind: 'number' }, updatedAt: '' };
const subject = { datasetId: D, column: 'amount', aggregation: 'sum' as const, metricId: M, filters: [] };

const open = (metric: Record<string, unknown>, subj: AlertSubject = subject, rules: unknown[] = []) => {
  const calls = serveRpc({
    'dataset:columns': { body: { id: D, name: 'Orders', rowCount: 3, columns: [{ name: 'amount', type: 'number' }] } },
    'alerts:list': { body: { ok: true, rules, events: [] } },
    'alerts:save': { body: { ok: true, rule: {} } },
    'dashboard:metric': { body: { ok: true, value: 6 } },
    'metric:values': { body: [{ id: M, ok: true, display: '6' }] },
    'metric:list': { body: { ok: true, metrics: [SAVED] } }, // the summary carries no target: the dialog reads the record
    'metric:get': { body: { ok: true, metric: { ...SAVED, ...metric } } },
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AlertDialog projectId={P} subject={subj} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
};

describe('the Target tab', () => {
  it('saves a rule that fires below a percent of the target', async () => {
    const calls = open({ target: { source: { value: 100 }, per: 'month' } });
    const tab = await screen.findByRole('tab', { name: 'Target' });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Percent of target' }), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'alerts:save')).toBe(true));
    const rule = (calls.find((c) => c.channel === 'alerts:save')!.payload as { rule: Record<string, unknown> }).rule;
    expect(rule.compare).toBe('target');
    expect(rule.targetPct).toEqual({ op: 'below', pct: 80 });
    expect((rule.metric as { metricId?: string }).metricId).toBe(M);
    expect(rule.name).toBe('amount below 80% of target');
  });

  it('NEGATIVE CONTROL: a metric with no target offers no Target tab', async () => {
    open({});
    await screen.findByRole('tab', { name: 'Threshold' });
    expect(screen.queryByRole('tab', { name: 'Target' })).toBeNull();
  });
});

// A period or funnel metric's card stores no column copy (AddKpi: column ''): its metric is what the rule watches.
describe('a KPI card with a metric and no column', () => {
  const card = { id: 'c1', type: 'metric', metric: { datasetId: D, column: '', aggregation: 'sum', label: 'Revenue YTD', metricId: M } } as unknown as Card;

  it('opens on the metric\'s figure and saves a rule watched through it', async () => {
    const subj = subjectOf(card, [], 'a1');
    expect(subj).not.toBeNull();
    const calls = open({ definition: { base: M, window: { to_date: 'year' } } }, subj!);
    expect(await screen.findByText('Alert me…')).toBeTruthy();
    expect(await screen.findByText('6')).toBeTruthy(); // metric:values' display
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'alerts:save')).toBe(true));
    const rule = (calls.find((c) => c.channel === 'alerts:save')!.payload as { rule: { metric: Record<string, unknown> } }).rule;
    // The shape the server watches through resolveMetric (scripts/test-periodMetrics.ts, alertMetric.metricWatch).
    expect(rule.metric).toMatchObject({ column: '', metricId: M });
    expect(calls.some((c) => c.channel === 'dashboard:metric')).toBe(false); // no copy to total
  });

  it('NEGATIVE CONTROL: another metric\'s rule with no column is not this card\'s', async () => {
    const other = { id: '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', name: 'Orders YTD above 1', datasetId: D, compare: 'threshold', threshold: { op: '>', value: 1 }, enabled: true, metric: { column: '', aggregation: 'sum', metricId: '4b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b' } };
    open({}, subjectOf(card, [], 'a1')!, [other]);
    expect(await screen.findByText('Alert me…')).toBeTruthy();
    expect(screen.queryByText('Edit alert')).toBeNull();
  });

  it('NEGATIVE CONTROL: a card with neither a column nor a metric has nothing to watch', () => {
    expect(subjectOf({ id: 'c2', type: 'metric', metric: { datasetId: D, column: '', aggregation: 'sum' } } as unknown as Card, [], 'a1')).toBeNull();
  });
});
