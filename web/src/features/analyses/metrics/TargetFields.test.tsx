// The metric editor's Target section (semantic layer part 5, step 09, D12): none, a figure, or a plan metric, the
// period one figure covers, and the status thresholds. It sends `target: <object> | null`; every sentence about it is
// the server's.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc, type RpcReply } from '../../../test-utils';
import { MetricEditor } from './MetricEditor';
import { targetBody } from './TargetFields';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D2 = '1c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const REV = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const PLAN = '5b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const summary = (id: string, name: string, definition: object, more: object = {}) => ({ id, name, datasetId: D, datasetName: 'Orders', definition, definitionText: name, format: { kind: 'number' }, updatedAt: '', ...more });
const METRICS = [
  summary(REV, 'Revenue', { column: 'amount', aggregation: 'sum' }, { timeColumn: 'day' }),
  summary('3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', 'Units', { column: 'amount', aggregation: 'count' }), // no date
  summary(PLAN, 'Plan revenue', { column: 'amount', aggregation: 'sum' }, { datasetId: D2, datasetName: 'Plan', timeColumn: 'month' }),
];
const routes = (extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:roles': { body: { [P]: 'editor' } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'dataset:list': { body: [{ id: D, name: 'Orders' }] },
  'dataset:columns': { body: { id: D, name: 'Orders', rowCount: 3, columns: [{ name: 'amount', type: 'number' }, { name: 'day', type: 'date' }] } },
  'metric:list': { body: { ok: true, metrics: METRICS } },
  'metric:preview': { body: { ok: true, display: '2,000', definitionText: 'sum of amount' } },
  'metric:save': { body: { ok: true, metric: { id: P, name: 'Revenue 2', datasetId: D, definition: {}, filters: [], format: { kind: 'number' }, updatedAt: '' } } },
  'metric:update': { body: { ok: true, metric: { id: REV, name: 'Revenue', datasetId: D, definition: {}, filters: [], format: { kind: 'number' }, updatedAt: '' }, tag: 't' } },
  'catalog:getTable': { body: { ok: true, table: { role: '', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '' } } },
  ...extra,
});

function mount(existing?: object) {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MetricEditor projectId={P} existing={existing as never} onSaved={() => {}} onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const pick = (label: string) => fireEvent.click(screen.getByRole('option', { name: label }));
const segment = (group: string, name: string) => fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name }));
const named = async (name: string) => {
  await screen.findByRole('combobox', { name: 'Dataset' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: name } });
};
const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.find((c) => c.channel === channel)?.payload as Record<string, any>; // any: the payload under test

describe('the Target section', () => {
  it('a plan metric and a month send { source: { metricId }, per: "month" }', async () => {
    const calls = serveRpc(routes());
    mount();
    await named('Revenue 2');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Column' }) as HTMLButtonElement).disabled).toBe(false));
    segment('Target', 'A plan metric');
    fireEvent.click(await screen.findByRole('combobox', { name: 'Plan metric' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Revenue', 'Plan revenue']); // metrics with a date; Units counts by none
    pick('Plan revenue');
    fireEvent.click(screen.getByRole('combobox', { name: 'Each figure covers' }));
    pick('Month');
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(sent(calls, 'metric:save')).toBeTruthy());
    expect(sent(calls, 'metric:save').input.target).toEqual({ source: { metricId: PLAN }, per: 'month' });
  });

  it('a figure sends { source: { value } }', async () => {
    const calls = serveRpc(routes());
    mount();
    await named('Revenue 2');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Column' }) as HTMLButtonElement).disabled).toBe(false));
    segment('Target', 'A figure');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target figure' }), { target: { value: '1200000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(sent(calls, 'metric:save')).toBeTruthy());
    expect(sent(calls, 'metric:save').input.target).toEqual({ source: { value: 1_200_000 } });
  });

  it('thresholds are sent as typed, the other one defaulted', async () => {
    expect(targetBody({ kind: 'value', value: '5', planId: '', per: '', good: '95', warn: '' }, 'up_good')).toEqual({ source: { value: 5 }, thresholds: { good: 95, warn: 90 } });
    expect(targetBody({ kind: 'value', value: '5', planId: '', per: '', good: '', warn: '105' }, 'down_good')).toEqual({ source: { value: 5 }, thresholds: { good: 100, warn: 105 } });
  });

  it('None on an existing target sends null on update', async () => {
    const calls = serveRpc(routes());
    mount({ id: REV, name: 'Revenue', datasetId: D, definition: { column: 'amount', aggregation: 'sum' }, filters: [], format: { kind: 'number' }, timeColumn: 'day', target: { source: { value: 5 }, per: 'month' } });
    await screen.findByRole('combobox', { name: 'Dataset' });
    expect(within(screen.getByRole('radiogroup', { name: 'Target' })).getByRole('radio', { name: 'A figure' }).getAttribute('aria-checked')).toBe('true');
    segment('Target', 'None');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(calls, 'metric:update')).toBeTruthy());
    expect(sent(calls, 'metric:update').patch.target).toBeNull();
  });

  it('NEGATIVE CONTROL: a new metric with no target sends no target key at all', async () => {
    const calls = serveRpc(routes());
    mount();
    await named('Plain');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Column' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(sent(calls, 'metric:save')).toBeTruthy());
    expect('target' in sent(calls, 'metric:save').input).toBe(false);
  });

  it('a figure left empty is not saved, and says so', async () => {
    const calls = serveRpc(routes());
    mount();
    await named('Empty');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Column' }) as HTMLButtonElement).disabled).toBe(false));
    segment('Target', 'A figure');
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    expect(await screen.findByText('Enter the target figure, or choose None.')).toBeTruthy();
    expect(calls.some((c) => c.channel === 'metric:save')).toBe(false);
  });

  it('the server’s refusal is said beside the target, the work still in the boxes', async () => {
    serveRpc(routes({ 'metric:save': { body: { ok: false, error: 'A target for a metric that adds up over time needs the period one figure covers.', field: 'target' } } }));
    mount();
    await named('Needs per');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Column' }) as HTMLButtonElement).disabled).toBe(false));
    segment('Target', 'A figure');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target figure' }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    expect(await screen.findByText('A target for a metric that adds up over time needs the period one figure covers.')).toBeTruthy();
    expect((screen.getByRole('spinbutton', { name: 'Target figure' }) as HTMLInputElement).value).toBe('5');
  });
});
