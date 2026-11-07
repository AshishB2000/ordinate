// The date a metric counts by (semantic layer D9), in the browser: the metric editor offers the dataset's one date
// column as a suggestion it never takes silently, and "Alert me…" on such a metric's KPI picks that date for the
// previous period. Each case has its negative control.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc, type RpcReply } from '../../../test-utils';
import { AlertDialog } from '../../dashboards/AlertDialog';
import { MetricEditor } from './MetricEditor';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const TEXT = { name: 'region', type: 'text' };
const AMOUNT = { name: 'amount', type: 'number' };
const ORDERED = { name: 'order_date', type: 'date' };
const SHIPPED = { name: 'ship_date', type: 'date' };
const SAVED = { id: M, name: 'Revenue', datasetId: D, definition: { column: 'amount', aggregation: 'sum' }, filters: [], format: { kind: 'number' }, updatedAt: '' };

const routes = (columns: unknown[], extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:roles': { body: { [P]: 'editor' } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'dataset:list': { body: [{ id: D, name: 'Orders' }] },
  'dataset:columns': { body: { id: D, name: 'Orders', rowCount: 3, columns } },
  'metric:list': { body: { ok: true, metrics: [] } },
  'metric:preview': { body: { ok: true, display: '6', definitionText: 'sum of amount' } },
  'metric:save': { body: { ok: true, metric: SAVED } },
  ...extra,
});

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const pick = async (label: string, option: string) => {
  const trigger = await screen.findByRole('combobox', { name: label });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false)); // its columns are in
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('option', { name: option }));
};

describe('the metric editor’s date', () => {
  it('suggests the one date column, never picks it, and saves it once asked', async () => {
    const calls = serveRpc(routes([TEXT, AMOUNT, ORDERED]));
    mount(<MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />);
    const use = await screen.findByRole('button', { name: 'Use order_date' });
    expect(screen.getByRole('combobox', { name: 'Date it counts by' }).textContent).toBe('The dashboard’s date');
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Revenue' } });
    fireEvent.click(use);
    expect(screen.getByRole('combobox', { name: 'Date it counts by' }).textContent).toBe('order_date');
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:save')?.payload as { input: { timeColumn?: string } };
    expect(body.input.timeColumn).toBe('order_date');
  });

  it('NEGATIVE CONTROL: with two date columns there is no suggestion, and nothing is set', async () => {
    const calls = serveRpc(routes([TEXT, AMOUNT, ORDERED, SHIPPED]));
    mount(<MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />);
    await pick('Date it counts by', 'ship_date'); // the dates are listed…
    await pick('Date it counts by', 'The dashboard’s date');
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull(); // …but none is offered
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Revenue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:save')?.payload as { input: { timeColumn?: string } } | undefined;
    expect(body?.input.timeColumn).toBe('');
  });

  it('a date the server refuses is said beside the date', async () => {
    serveRpc(routes([TEXT, AMOUNT, ORDERED], { 'metric:save': { body: { ok: false, field: 'timeColumn', error: '“region” is not a date column of this dataset.' } } }));
    mount(<MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use order_date' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Revenue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    expect(await screen.findByText('“region” is not a date column of this dataset.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull(); // not the dialog-wide error line
  });
});

describe('"Alert me…" on a metric with its own date', () => {
  const subject = { datasetId: D, column: 'amount', aggregation: 'sum' as const, metricId: M, filters: [] };
  const open = (timeColumn?: string) => {
    serveRpc(routes([TEXT, AMOUNT, ORDERED, SHIPPED], {
      'alerts:list': { body: { ok: true, rules: [], events: [] } },
      'dashboard:metric': { body: { ok: true, value: 6 } },
      'metric:values': { body: [{ id: M, ok: true, display: '6' }] },
      'metric:list': { body: { ok: true, metrics: [{ ...SAVED, datasetName: 'Orders', definitionText: 'sum of amount', ...(timeColumn ? { timeColumn } : {}) }] } },
    }));
    mount(<AlertDialog projectId={P} subject={subject} onClose={() => {}} />);
  };
  const toPreviousPeriod = async () => {
    const tab = await screen.findByRole('tab', { name: 'Change' });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    await waitFor(() => expect(screen.queryByText(/has no date column/)).toBeNull()); // the columns are in
    await pick('Compared with', 'the previous period');
  };

  it('the previous period runs along the metric’s date, picked', async () => {
    open('ship_date');
    await toPreviousPeriod();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Date column' }).textContent).toBe('ship_date'));
  });

  it('NEGATIVE CONTROL: a metric with no date leaves the date column to pick', async () => {
    open();
    await toPreviousPeriod();
    expect(screen.getByRole('combobox', { name: 'Date column' }).textContent).not.toMatch(/date/);
  });
});
