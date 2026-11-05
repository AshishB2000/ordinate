// The warehouse's comments and key as suggestions in a dataset's Fields, and the strip's chip (semantic layer part 2, PR 09).
// Nothing is the dataset's until an editor presses Use; Dismiss keeps one away.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { W, ORD } from './sources/testServe';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D2 = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };
const body = (b: unknown) => ({ body: b });
const base = { connId: W, docId: ORD, table: 'ANALYTICS.ORDERS' };
const SUGGESTIONS = [
  { ...base, datasetId: D, kind: 'column', column: 'discount', text: 'Discount in USD, after tax', hash: 'AbCdEf012345' },
  { ...base, datasetId: D, kind: 'table', text: 'Order lines', hash: 'BbCdEf012345' },
  { ...base, datasetId: D, kind: 'key', text: 'line_id', hash: 'CbCdEf012345' },
];

function serve(opts: { role?: 'editor' | 'viewer'; routes?: Record<string, RpcReply> } = {}) {
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 2, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: opts.role ?? 'editor' }),
    'dataset:list': body([{ id: D, name: 'Orders', sourceKind: 'postgres', rowCount: 10, columnCount: 2, updatedAt: '' }, { id: D2, name: 'Refunds', sourceKind: 'postgres', rowCount: 1, columnCount: 1, updatedAt: '' }]),
    'model:overview': body({ ok: true, tables: [{ datasetId: D, role: 'fact', key: '', keyState: '', description: '', alwaysApplied: { kind: 'prepare', steps: [] }, calculated: [] }], todo: [], more: 0 }),
    'catalog:getTable': body({ ok: true, table: { role: 'fact', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '' } }),
    'dataset:columns': body({ id: D, name: 'Orders', rowCount: 10, columns: [{ name: 'discount', type: 'number' }, { name: 'line_id', type: 'number' }] }),
    'quality:list': body({ ok: true, rules: [], latest: null, history: [] }),
    'catalog:columns': body({ ok: true, columns: {} }),
    'dataset:stats': body({ ok: true, summaries: [] }),
    'sourceTable:forDataset': body({ ok: true, linkable: false, byQuery: false, tables: [] }),
    'sourceTable:list': body({ ok: true, connections: [], todo: [], more: 0 }),
    'catalog:suggestions': body({ ok: true, suggestions: SUGGESTIONS, total: 3, datasets: 1 }),
    'catalog:setColumn': body({ ok: true }),
    'catalog:set': body({ ok: true }),
    'catalog:setTable': body({ ok: true, table: { role: 'fact', key: 'line_id', grain: '', guide: '', updatedBy: '', updatedAt: '' } }),
    'catalog:dismissSuggestion': body({ ok: true }),
    ...opts.routes,
  });
}
const open = () => renderApp(`/model/${P}?dataset=${D}&panel=fields`);
const count = (calls: { channel: string }[], channel: string) => calls.filter((c) => c.channel === channel).length;
const region = () => screen.findByRole('region', { name: 'Suggested by the warehouse' }, LAZY);

describe('Suggested meanings in Fields', () => {
  it('shows each suggestion with the warehouse\'s words and its table', async () => {
    serve();
    open();
    const r = await region();
    expect(within(r).getByText('discount')).toBeTruthy();
    expect(within(r).getByText('The warehouse says: "Discount in USD, after tax"')).toBeTruthy();
    expect(within(r).getByText('Order lines')).toBeTruthy();
    expect(within(r).getByText("The warehouse's primary key is line_id")).toBeTruthy();
    expect(within(r).getAllByText('from ANALYTICS.ORDERS')).toHaveLength(3);
  }, 30_000);

  it('Use on a column sends exactly the meaning, then asks again', async () => {
    const calls = serve();
    open();
    const r = await region();
    const n = count(calls, 'catalog:suggestions');
    fireEvent.click(within(within(r).getByText('discount').closest('li') as HTMLElement).getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'catalog:setColumn')?.payload).toEqual({ projectId: P, datasetId: D, column: 'discount', patch: { description: 'Discount in USD, after tax' } }));
    await waitFor(() => expect(count(calls, 'catalog:suggestions')).toBeGreaterThan(n));
  }, 30_000);

  it('after Use the column notes show the meaning the server now holds', async () => {
    let used = false;
    serve({ routes: { 'catalog:setColumn': () => { used = true; return body({ ok: true }); }, 'catalog:columns': () => body({ ok: true, columns: used ? { discount: { description: 'Discount in USD, after tax' } } : {} }) } });
    open();
    const r = await region();
    expect((await screen.findByLabelText('Description of discount', {}, LAZY) as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(within(within(r).getByText('discount').closest('li') as HTMLElement).getByRole('button', { name: 'Use' }));
    await waitFor(() => expect((screen.getByLabelText('Description of discount') as HTMLTextAreaElement).value).toBe('Discount in USD, after tax'));
  }, 30_000);

  it('Use on the table comment sets the dataset description; on the key sets the key', async () => {
    const calls = serve();
    open();
    const r = await region();
    fireEvent.click(within(within(r).getByText('Order lines').closest('li') as HTMLElement).getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'catalog:set')?.payload).toEqual({ projectId: P, ref: `dataset:${D}`, patch: { description: 'Order lines' } }));
    fireEvent.click(within(within(r).getByText("The warehouse's primary key is line_id").closest('li') as HTMLElement).getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'catalog:setTable')?.payload).toEqual({ projectId: P, datasetId: D, patch: { key: 'line_id' } }));
  }, 30_000);

  it('Dismiss sends the row\'s hash and doc', async () => {
    const calls = serve();
    open();
    const r = await region();
    fireEvent.click(within(within(r).getByText('discount').closest('li') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'catalog:dismissSuggestion')?.payload).toEqual({ projectId: P, datasetId: D, connId: W, docId: ORD, kind: 'column', column: 'discount', hash: 'AbCdEf012345' }));
  }, 30_000);

  it('no suggestion, no region', async () => {
    serve({ routes: { 'catalog:suggestions': body({ ok: true, suggestions: [], total: 0, datasets: 0 }) } });
    open();
    await screen.findByText('discount', {}, LAZY).catch(() => undefined);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggested by the warehouse' })).toBeNull());
  }, 30_000);

  it('NEGATIVE CONTROL: a viewer sees no region, no chip and makes no suggestion call', async () => {
    const calls = serve({ role: 'viewer' });
    renderApp(`/model/${P}?dataset=${D}&panel=fields`);
    await screen.findByRole('navigation', { name: 'Datasets' }, LAZY);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggested by the warehouse' })).toBeNull());
    expect(screen.queryByRole('button', { name: /suggested meaning/ })).toBeNull();
    expect(count(calls, 'catalog:suggestions')).toBe(0);
  }, 30_000);

  it('an old pod (404) leaves Fields as it was, with no console error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    serve({ routes: { 'catalog:suggestions': { status: 404, body: { error: 'no such channel' } } } });
    open();
    await screen.findByRole('navigation', { name: 'Datasets' }, LAZY);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggested by the warehouse' })).toBeNull());
    expect(screen.queryByRole('button', { name: /suggested meaning/ })).toBeNull();
    expect(err).not.toHaveBeenCalled();
  }, 30_000);
});

describe('The strip chip', () => {
  it('says the server\'s total after the strip\'s items and opens the first dataset\'s Fields', async () => {
    serve({ routes: { 'model:overview': body({ ok: true, tables: [{ datasetId: D2, role: '', key: '', keyState: '', description: '', alwaysApplied: { kind: 'prepare', steps: [] }, calculated: [] }], todo: [], more: 0 }),
      'catalog:suggestions': body({ ok: true, suggestions: [{ ...SUGGESTIONS[0], datasetId: D2 }], total: 3, datasets: 1 }) } });
    const router = renderApp(`/model/${P}?dataset=${D}&panel=guide`);
    const chip = await screen.findByRole('button', { name: '3 suggested meanings' }, LAZY);
    fireEvent.click(chip);
    await waitFor(() => expect(router.state.location.search).toContain(`dataset=${D2}`));
    expect(router.state.location.search).toContain('panel=fields');
  }, 30_000);
});
