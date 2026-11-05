// "Alert me…" on a metric with a target (semantic part 5, D14): a Target tab, below or above a percent of it, shown only
// when the metric has a target. The server decides whether the rule fires; the dialog saves what was asked.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc } from '../../test-utils';
import { AlertDialog } from './AlertDialog';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const SAVED = { id: M, name: 'Revenue', datasetId: D, datasetName: 'Orders', definition: { column: 'amount', aggregation: 'sum' }, definitionText: 'sum of amount', filters: [], format: { kind: 'number' }, updatedAt: '' };
const subject = { datasetId: D, column: 'amount', aggregation: 'sum' as const, metricId: M, filters: [] };

const open = (metric: Record<string, unknown>) => {
  const calls = serveRpc({
    'dataset:columns': { body: { id: D, name: 'Orders', rowCount: 3, columns: [{ name: 'amount', type: 'number' }] } },
    'alerts:list': { body: { ok: true, rules: [], events: [] } },
    'alerts:save': { body: { ok: true, rule: {} } },
    'dashboard:metric': { body: { ok: true, value: 6 } },
    'metric:values': { body: [{ id: M, ok: true, display: '6' }] },
    'metric:list': { body: { ok: true, metrics: [SAVED] } }, // the summary carries no target: the dialog reads the record
    'metric:get': { body: { ok: true, metric: { ...SAVED, ...metric } } },
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AlertDialog projectId={P} subject={subject} onClose={() => {}} />
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
