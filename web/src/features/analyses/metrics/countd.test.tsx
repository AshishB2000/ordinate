// Count distinct in the metric editor, and the hint that a key with no repeats makes it the same number as Count
// (semantic layer part 5, step 04). The hint reads only `key` and `keyCheck.repeatedKeys` of the table doc, and never
// changes the aggregation by itself.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc, type RpcReply } from '../../../test-utils';
import { KeyHint } from './KeyHint';
import { MetricEditor } from './MetricEditor';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const doc = (more: object): RpcReply => ({ body: { ok: true, table: { role: '', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '', ...more } } });
const COLUMNS = [{ name: 'customer_id', type: 'text' }, { name: 'units', type: 'number' }];
const routes = (table: RpcReply, extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:roles': { body: { [P]: 'editor' } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'dataset:list': { body: [{ id: D, name: 'Orders' }] },
  'dataset:columns': { body: { id: D, name: 'Orders', rowCount: 3, columns: COLUMNS } },
  'metric:list': { body: { ok: true, metrics: [] } },
  'metric:preview': { body: { ok: true, display: '3', definitionText: 'count distinct of customer_id' } },
  'metric:save': { body: { ok: true, metric: { id: P, name: 'C', datasetId: D, definition: {}, filters: [], format: { kind: 'number' }, updatedAt: '' } } },
  'catalog:getTable': table,
  ...extra,
});

function mount(node: React.ReactNode) {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const SENTENCE = 'Each customer_id appears once, so Count gives the same number.';
const hint = (aggregation: string, column = 'customer_id', onUseCount = vi.fn()) =>
  mount(<KeyHint projectId={P} datasetId={D} column={column} aggregation={aggregation} onUseCount={onUseCount} />);

describe('KeyHint', () => {
  it('says Count gives the same number for a key with no repeats, and the button asks for Count', async () => {
    serveRpc(routes(doc({ key: 'customer_id', keyCheck: { rows: 4, empty: 0, repeatedKeys: 0, checkedAt: 't' } })));
    const onUseCount = vi.fn();
    hint('countd', 'customer_id', onUseCount);
    expect(await screen.findByText(SENTENCE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use Count' }));
    expect(onUseCount).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE CONTROL: a key that repeats, a key check never run (or hidden from a restricted viewer), another column, or another aggregation: nothing', async () => {
    for (const [table, aggregation, column] of [
      [doc({ key: 'customer_id', keyCheck: { rows: 4, empty: 0, repeatedKeys: 3, checkedAt: 't' } }), 'countd', 'customer_id'],
      [doc({ key: 'customer_id' }), 'countd', 'customer_id'],
      [doc({ key: 'order_id', keyCheck: { rows: 4, empty: 0, repeatedKeys: 0, checkedAt: 't' } }), 'countd', 'customer_id'],
      [doc({ key: 'customer_id', keyCheck: { rows: 4, empty: 0, repeatedKeys: 0, checkedAt: 't' } }), 'count', 'customer_id'],
    ] as const) {
      cleanup();
      const calls = serveRpc(routes(table));
      hint(aggregation, column);
      if (aggregation === 'countd') await waitFor(() => expect(calls.some((c) => c.channel === 'catalog:getTable')).toBe(true));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByText(SENTENCE)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Use Count' })).toBeNull();
    }
  });
});

describe('the metric editor', () => {
  it('offers Count distinct, saves it, and previews the same definition', async () => {
    const calls = serveRpc(routes(doc({})));
    mount(<MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />);
    const trigger = await screen.findByRole('combobox', { name: 'Column' });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'customer_id (text)' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Count distinct' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Customers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create metric' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    const body = calls.find((c) => c.channel === 'metric:save')?.payload as { input: { definition: unknown } };
    expect(body.input.definition).toMatchObject({ column: 'customer_id', aggregation: 'countd' });
  });

  it('shows the hint under Count distinct on a clean key, and Use Count switches the aggregation', async () => {
    serveRpc(routes(doc({ key: 'customer_id', keyCheck: { rows: 4, empty: 0, repeatedKeys: 0, checkedAt: 't' } })));
    mount(<MetricEditor projectId={P} onSaved={() => {}} onClose={() => {}} />);
    const trigger = await screen.findByRole('combobox', { name: 'Column' });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'customer_id (text)' }));
    expect(screen.queryByText(SENTENCE)).toBeNull(); // NEGATIVE CONTROL: Sum is picked, no hint
    fireEvent.click(screen.getByRole('radio', { name: 'Count distinct' }));
    expect(await screen.findByText(SENTENCE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use Count' }));
    expect(screen.getByRole('radio', { name: 'Count' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });
});
