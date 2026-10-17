// A project viewer in the analytics workbenches: exploring is theirs (running
// a model, a what-if slider — `scenario:compute` is a read over an unsaved
// draft); saving is an editor's (a dataset, a scenario). Each case has its
// editor negative control.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const SC = '33333333-3333-4333-8333-333333333333';
const LAZY = 15_000;
const COLUMNS = { id: D, name: 'Orders', rowCount: 120, columns: [{ name: 'customer', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }] };
const INFO = {
  ok: true, name: 'Orders', rowCount: 120, sampleCap: 50_000, features: [], otherColumns: 2,
  columns: COLUMNS.columns, rfm: { id: 'customer', date: 'day', amount: 'amount' },
};
const RFM = {
  ok: true,
  result: {
    customers: 3, used: 5, skipped: 0, asOf: '2026-09-30',
    segments: [{ name: 'Champions', meaning: 'Bought recently, buy often', count: 3, share: 1, recency: 2, frequency: 2, monetary: 40 }],
    layout: [['Champions']], grid: [[3]],
  },
};
const SCENARIO = { id: SC, name: 'Price +5%', baseMetricIds: [], drivers: [{ name: 'amount +5%', kind: 'pct', value: 5, target: { column: 'amount' } }] };

const routes = (role: string, extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
  'projects:roles': { body: { [P]: role } },
  'dataset:columns': { body: COLUMNS },
  'dataset:list': { body: [{ id: D, name: 'Orders', sourceKind: 'csv', rowCount: 120, columnCount: 3, updatedAt: '' }] },
  'segments:features': { body: INFO },
  'segments:rfm': { body: RFM },
  'scenario:get': { body: SCENARIO },
  'scenario:compute': { body: { ok: true, metrics: [], drivers: [], tornado: null, notes: [] } },
  'scenario:targets': { body: { ok: true, columns: [], metrics: [], datasets: [] } },
  'scenario:update': { body: { ok: true, scenario: SCENARIO } },
  ...extra,
});

async function scoreCustomers() {
  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Customers (RFM)' }, { timeout: LAZY }), { button: 0 });
  fireEvent.click(await screen.findByRole('button', { name: 'Score customers' }));
  await screen.findAllByText('Champions');
}

describe('a viewer in the analytics workbenches', () => {
  it('Segments: scores customers, and is not offered "Save as a dataset"', async () => {
    const calls = serveRpc(routes('viewer'));
    renderApp(`/analytics/${P}/${D}/segments`);
    await scoreCustomers();
    expect(screen.queryByRole('heading', { name: 'Save as a dataset' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as dataset' })).toBeNull();
    expect(calls.some((c) => c.channel === 'segments:rfmSave')).toBe(false);
    cleanup();
    serveRpc(routes('editor'));
    renderApp(`/analytics/${P}/${D}/segments`);
    await scoreCustomers();
    expect(await screen.findByRole('button', { name: 'Save as dataset' })).toBeTruthy();
  }, 30_000);

  it('Scenario: a viewer\'s slider move is computed, never saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = serveRpc(routes('viewer'));
    renderApp(`/analytics/scenarios/${P}/${SC}`);
    const slider = await screen.findByRole('slider', { name: 'Driver 1 percent change slider' }, { timeout: LAZY });
    expect(screen.getByRole('heading', { level: 1, name: 'Price +5%' })).toBeTruthy();
    expect(screen.getByText('What-ifs here are not saved')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Scenario name' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More scenario actions' })).toBeNull();
    fireEvent.change(slider, { target: { value: '12' } });
    await act(async () => void vi.advanceTimersByTime(800));
    await waitFor(() => expect(calls.some((c) => c.channel === 'scenario:compute' && JSON.stringify(c.payload).includes('"value":12'))).toBe(true));
    expect(calls.some((c) => c.channel === 'scenario:update')).toBe(false);
  }, 30_000);

  it('negative control: an editor\'s slider move is saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = serveRpc(routes('editor'));
    renderApp(`/analytics/scenarios/${P}/${SC}`);
    const slider = await screen.findByRole('slider', { name: 'Driver 1 percent change slider' }, { timeout: LAZY });
    expect(screen.getByRole('textbox', { name: 'Scenario name' })).toBeTruthy();
    fireEvent.change(slider, { target: { value: '12' } });
    await act(async () => void vi.advanceTimersByTime(800));
    await waitFor(() => expect(calls.some((c) => c.channel === 'scenario:update')).toBe(true));
  }, 30_000);
});
