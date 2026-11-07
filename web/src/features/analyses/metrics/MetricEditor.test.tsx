// A snapshot metric (semantic layer D8) in the metric editor: the "Snapshot" field offers the dataset's date columns,
// the definition always says which (an object, or null for every row — how the server tells a clear from an old
// tab), and a refusal is said beside the field. Each case has its negative control. Part 5 (D11): "For each" keeps each
// account's own latest rows; the definition always says which (a column, or null for the whole scope).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc, type RpcReply } from '../../../test-utils';
import { MetricEditor } from './MetricEditor';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const DAY = { name: 'day', type: 'date' };
const UNITS = { name: 'units', type: 'number' };
const REGION = { name: 'region', type: 'text' };
const ACCOUNT = { name: 'account', type: 'text' };
const STOCK = { id: M, name: 'Stock', datasetId: D, definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } }, filters: [], format: { kind: 'number' }, updatedAt: '' };

const routes = (columns: unknown[], extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:roles': { body: { [P]: 'editor' } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'dataset:list': { body: [{ id: D, name: 'Stock' }] },
  'dataset:columns': { body: { id: D, name: 'Stock', rowCount: 3, columns } },
  'metric:list': { body: { ok: true, metrics: [] } },
  'metric:preview': { body: { ok: true, display: '6', definitionText: 'sum of units' } },
  'metric:save': { body: { ok: true, metric: STOCK } },
  'metric:update': { body: { ok: true, metric: STOCK, tag: 't2' } },
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

describe('the metric editor’s snapshot', () => {
  it('saves the latest day of a date column', async () => {
    const calls = serveRpc(routes([DAY, UNITS]));
    mount(<MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />);
    await pick('Column', 'units (number)');
    await pick('Snapshot', 'Latest day only');
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Stock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:save')?.payload as { input: { definition: unknown } };
    expect(body.input.definition).toEqual({ column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last', per: null } });
    // The preview asks for the same definition, so its figure is the snapshot's (not the plain total release 1 showed).
    const previewed = () => calls.filter((c) => c.channel === 'metric:preview').map((c) => (c.payload as { definition: unknown }).definition);
    await waitFor(() => expect(previewed()).toContainEqual(body.input.definition), { timeout: 2000 });
  });

  it('NEGATIVE CONTROL: left on every row, the definition says snapshot: null', async () => {
    const calls = serveRpc(routes([DAY, UNITS]));
    mount(<MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />);
    await pick('Column', 'units (number)');
    expect(screen.getByRole('combobox', { name: 'Snapshot' }).textContent).toBe('Every row');
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Units' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:save')?.payload as { input: { definition: unknown } };
    expect(body.input.definition).toEqual({ column: 'units', aggregation: 'sum', snapshot: null });
  });

  it('opens an existing snapshot on its day, and "Every row" clears it with null', async () => {
    const calls = serveRpc(routes([DAY, UNITS]));
    mount(<MetricEditor projectId={P} existing={{ ...STOCK, tag: 't1' } as never} onSaved={() => {}} onClose={() => {}} />);
    const field = await screen.findByRole('combobox', { name: 'Snapshot' });
    await waitFor(() => expect(field.textContent).toBe('Latest day only'));
    await pick('Snapshot', 'Every row');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:update')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:update')?.payload as { patch: { definition: { snapshot?: unknown } } };
    expect(body.patch.definition.snapshot).toBeNull();
  });

  it('a snapshot the server refuses is said beside the field', async () => {
    serveRpc(routes([DAY, UNITS], { 'metric:save': { body: { ok: false, field: 'snapshot', error: '“day” is not a date column, so it can\'t be a snapshot\'s date.' } } }));
    mount(<MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />);
    await pick('Snapshot', 'Earliest day only');
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Opening' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    expect(await screen.findByText('“day” is not a date column, so it can\'t be a snapshot\'s date.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull(); // not the dialog-wide error line
  });

  it('keeps each account\'s own latest rows: "For each" saves per', async () => {
    const calls = serveRpc(routes([DAY, ACCOUNT, UNITS]));
    mount(<MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />);
    await pick('Column', 'units (number)');
    expect(screen.queryByRole('combobox', { name: 'For each' })).toBeNull(); // NEGATIVE CONTROL: not until a snapshot date is chosen
    await pick('Snapshot', 'Latest day only');
    expect(screen.getByRole('combobox', { name: 'For each' }).textContent).toBe('The whole scope');
    await pick('For each', 'account');
    expect(screen.getByText('Each account’s own latest row counts, even if it stopped reporting earlier. Pick a period to count only recent ones.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'MRR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:save')?.payload as { input: { definition: unknown } };
    expect(body.input.definition).toEqual({ column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last', per: 'account' } });
    const previewed = () => calls.filter((c) => c.channel === 'metric:preview').map((c) => (c.payload as { definition: unknown }).definition);
    await waitFor(() => expect(previewed()).toContainEqual(body.input.definition), { timeout: 2000 });
  });

  it('opens an existing per on its column, and "The whole scope" clears it with null', async () => {
    const calls = serveRpc(routes([DAY, ACCOUNT, UNITS]));
    const MRR = { ...STOCK, definition: { ...STOCK.definition, snapshot: { column: 'day', take: 'last', per: 'account' } } };
    mount(<MetricEditor projectId={P} existing={{ ...MRR, tag: 't1' } as never} onSaved={() => {}} onClose={() => {}} />);
    const field = await screen.findByRole('combobox', { name: 'For each' });
    await waitFor(() => expect(field.textContent).toBe('account'));
    await pick('For each', 'The whole scope');
    expect(screen.queryByText(/own latest row counts/)).toBeNull(); // NEGATIVE CONTROL: the hint goes with it
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:update')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:update')?.payload as { patch: { definition: { snapshot?: unknown } } };
    expect(body.patch.definition.snapshot).toEqual({ column: 'day', take: 'last', per: null });
  });

  it('NEGATIVE CONTROL: with no date column there is no Snapshot field, and the formula tab has none', async () => {
    serveRpc(routes([REGION, UNITS]));
    mount(<MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />);
    await screen.findByRole('combobox', { name: 'Column' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Column' }).textContent).toContain('region'));
    expect(screen.queryByRole('combobox', { name: 'Snapshot' })).toBeNull();
  });
});
