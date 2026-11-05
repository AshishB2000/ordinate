import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';
import type { Lineage } from '../../data/api';
import { usedByText } from '../api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };
const node = (id: string, kind: string, name: string, col: number, row = 0) => ({ id, kind, name, sub: '', col, row });
const GRAPH: Lineage = {
  nodes: [
    node(`column:${D}:amount`, 'column', 'amount', 0),
    node(`calc:${D}:Margin`, 'calc', 'Margin', 1),
    node('metric:m1', 'metric', 'Margin %', 2),
    node('visual:v1', 'visual', 'Revenue', 3),
  ],
  edges: [],
  focus: `column:${D}:amount`,
  usedIn: { metric: 2, visual: 4, dashboard: 2 },
  columns: 4,
  upstream: 0,
};

function serve(routes: Record<string, RpcReply> = {}) {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: 'editor' }),
    'dataset:list': body([{ id: D, name: 'Orders', sourceKind: 'csv', rowCount: 10, columnCount: 2, updatedAt: '' }]),
    'model:overview': body({ ok: true, tables: [], todo: [], more: 0 }),
    'catalog:getTable': body({ ok: true, table: { role: 'fact', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '' } }),
    'dataset:columns': body({ id: D, name: 'Orders', rowCount: 10, columns: [{ name: 'amount', type: 'number' }, { name: 'region', type: 'text' }] }),
    'lineage:get': body({ ...GRAPH, nodes: [GRAPH.nodes[0]], focus: GRAPH.nodes[0].id }),
    'lineage:column': body(GRAPH),
    ...routes,
  });
}
const open = (column = '') => renderApp(`/model/${P}?dataset=${D}&panel=lineage${column ? `&column=${column}` : ''}`);
const pick = async (name: string) => {
  const p = await screen.findByRole('tabpanel', { name: 'Lineage' }, LAZY);
  fireEvent.click(await within(p).findByRole('combobox', { name: 'Trace a column' }, LAZY));
  fireEvent.click(await screen.findByRole('option', { name }));
  return p;
};
const columnCalls = (calls: { channel: string }[]) => calls.filter((c) => c.channel === 'lineage:column');

describe('Trace a column', () => {
  it('words the counts the server sent', () => {
    expect(usedByText({ metric: 2, visual: 6, term: 1 })).toBe('Used by 2 metrics · 6 visuals · 1 term');
    expect(usedByText({})).toBe('');
  });

  it('draws the dataset until a column is picked, then that column\'s graph', async () => {
    const calls = serve();
    open();
    const p = await pick('amount');
    expect(await within(p).findByText('Used by 2 metrics · 4 visuals · 2 dashboards')).toBeTruthy();
    for (const n of ['Margin', 'Margin %', 'Revenue']) expect(within(p).getAllByText(n).length).toBeGreaterThan(0);
    expect(within(p).getByLabelText('Calculated field: Margin')).toBeTruthy();
    expect(columnCalls(calls)).toEqual([{ channel: 'lineage:column', payload: { projectId: P, datasetId: D, column: 'amount' } }]);
  }, 30_000);

  it('negative control: no column picked, no lineage:column call', async () => {
    const calls = serve();
    open();
    const p = await screen.findByRole('tabpanel', { name: 'Lineage' }, LAZY);
    await within(p).findByRole('combobox', { name: 'Trace a column' }, LAZY);
    await waitFor(() => expect(calls.some((c) => c.channel === 'lineage:get')).toBe(true));
    expect(columnCalls(calls)).toEqual([]);
  });

  it('?column= restores the pick', async () => {
    const calls = serve();
    open('amount');
    const p = await screen.findByRole('tabpanel', { name: 'Lineage' }, LAZY);
    expect(await within(p).findByText('Used by 2 metrics · 4 visuals · 2 dashboards', undefined, LAZY)).toBeTruthy();
    expect(columnCalls(calls)).toHaveLength(1);
  }, 30_000);

  it('a column nothing reads says so', async () => {
    serve({ 'lineage:column': { body: null } });
    open('amount');
    expect(await screen.findByText('Nothing reads “amount” yet.', undefined, LAZY)).toBeTruthy();
  }, 30_000);

  it('a 404 shows the error, and Retry asks again', async () => {
    const calls = serve({ 'lineage:column': { status: 404, body: { error: 'nope' } } });
    open('amount');
    expect(await screen.findByText('The lineage could not be loaded', undefined, LAZY)).toBeTruthy();
    const before = columnCalls(calls).length;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(columnCalls(calls).length).toBeGreaterThan(before));
  }, 30_000);
});
