// A dataset's Guide shows its source tables' notes (editors only), a query dataset links its tables,
// and a source table's Lineage tab draws the lineage graph (semantic layer part 2, PR 08).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import type { SourceBlock, SourceBlocks } from './sources/linksApi';
import { got, LAZY as LZ, LIST, ORD, W } from './sources/testServe';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };
const body = (b: unknown) => ({ body: b });

const block = (more: Partial<SourceBlock> = {}): SourceBlock => ({
  connId: W, connName: 'Warehouse', table: 'ANALYTICS.ORDERS', docId: ORD, owner: 'Data platform', refresh: 'Hourly at :15', requiredFilters: 'ORDER_DATE',
  guide: '# Partitioned by day\n\nAlways filter.', primaryKey: { columns: ['LINE_ID'], enforced: false }, updatedBy: 'pat@acme.test', updatedAt: '2026-11-01T00:00:00Z', ...more,
});
const blocks = (more: Partial<SourceBlocks> = {}): SourceBlocks => ({ ok: true, linkable: true, byQuery: false, tables: [block()], ...more });

function serve(opts: { role?: 'editor' | 'viewer'; routes?: Record<string, RpcReply> } = {}) {
  const calls = serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: opts.role ?? 'editor' }),
    'dataset:list': body([{ id: D, name: 'Orders', sourceKind: 'postgres', rowCount: 10, columnCount: 2, updatedAt: '' }]),
    'model:overview': body({ ok: true, tables: [{ datasetId: D, role: 'fact', key: '', keyState: '', description: '', alwaysApplied: { kind: 'prepare', steps: [] }, calculated: [] }], todo: [], more: 0 }),
    'catalog:getTable': body({ ok: true, table: { role: 'fact', key: '', grain: '', guide: 'The dataset guide.', updatedBy: '', updatedAt: '' } }),
    'dataset:columns': body({ id: D, name: 'Orders', rowCount: 10, columns: [{ name: 'order_id', type: 'text' }] }),
    'quality:list': body({ ok: true, rules: [], latest: null, history: [] }),
    'catalog:columns': body({ ok: true, columns: {} }),
    'dataset:stats': body({ ok: true, summaries: [] }),
    'sourceTable:forDataset': body(blocks()),
    'sourceTable:list': body(LIST),
    ...opts.routes,
  });
  return calls;
}
const open = () => renderApp(`/model/${P}?dataset=${D}&panel=guide`);
const count = (calls: { channel: string }[], channel: string) => calls.filter((c) => c.channel === channel).length;
const region = () => screen.findByRole('region', { name: 'From the source table' }, LAZY);

describe('A dataset\'s Guide: from the source table', () => {
  it('shows the table, its facts in one line and its guide, with a link to the doc', async () => {
    serve();
    open();
    const r = await region();
    expect(within(r).getByText('ANALYTICS.ORDERS')).toBeTruthy();
    expect(r.textContent).toContain('on Warehouse');
    expect(within(r).getByText('Owner Data platform · refreshes Hourly at :15 · filter on ORDER_DATE · key LINE_ID')).toBeTruthy();
    expect(within(r).getByRole('heading', { name: 'Partitioned by day' })).toBeTruthy();
    expect(within(r).getByRole('link', { name: /Open in Source tables/ }).getAttribute('href')).toBe(`/model/${P}?tab=sources&conn=${W}&doc=${ORD}`);
    expect(screen.getByText('The dataset guide.')).toBeTruthy();
  }, 30_000);

  it('a table with no notes says so, and Write them saves the doc and opens it', async () => {
    const calls = serve({ routes: { 'sourceTable:forDataset': body(blocks({ tables: [block({ docId: undefined, owner: '', refresh: '', requiredFilters: '', guide: '', primaryKey: undefined })] })), 'sourceTable:save': body({ ok: true, docId: ORD, tag: 'T' }), 'sourceTable:get': got() } });
    open();
    const r = await region();
    expect(within(r).getByText('No notes on ANALYTICS.ORDERS yet.')).toBeTruthy();
    expect(within(r).getByRole('link', { name: /Open in Source tables/ }).getAttribute('href')).toBe(`/model/${P}?tab=sources&conn=${W}`);
    fireEvent.click(within(r).getByRole('button', { name: 'Write them' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'sourceTable:save')?.payload).toEqual({ projectId: P, connId: W, table: 'ANALYTICS.ORDERS', patch: {} }));
    await waitFor(() => expect(count(calls, 'sourceTable:get')).toBeGreaterThan(0));
  });

  it('a query with no tables offers Link tables; the dialog lists once, ticks the linked ones and saves the ticked names', async () => {
    const calls = serve({
      routes: {
        'sourceTable:forDataset': body(blocks({ byQuery: true, tables: [] })),
        'dataset:sourceTableChoices': body({ ok: true, tables: ['wh_a', 'wh_b', 'wh_c'], linked: ['wh_b'] }),
        'dataset:setSourceTables': body({ ok: true, tables: ['wh_b', 'wh_c'] }),
      },
    });
    open();
    const r = await region();
    expect(within(r).getByText('This dataset runs a query. Link the tables it reads so their notes show here.')).toBeTruthy();
    expect(count(calls, 'dataset:sourceTableChoices')).toBe(0);
    fireEvent.click(within(r).getByRole('button', { name: 'Link tables' }));
    const dlg = await screen.findByRole('dialog', { name: 'Link tables' });
    expect(await within(dlg).findByRole('checkbox', { name: 'wh_b' })).toHaveProperty('checked', true);
    expect(count(calls, 'dataset:sourceTableChoices')).toBe(1);
    expect(within(dlg).getByRole('checkbox', { name: 'wh_a' })).toHaveProperty('checked', false);
    fireEvent.click(within(dlg).getByRole('checkbox', { name: 'wh_c' }));
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'dataset:setSourceTables')?.payload).toEqual({ projectId: P, datasetId: D, tables: ['wh_b', 'wh_c'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(count(calls, 'dataset:sourceTableChoices')).toBe(1);
  });

  it('a query with tables offers Change linked tables, and 16 is the most', async () => {
    const many = Array.from({ length: 17 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    serve({ routes: { 'sourceTable:forDataset': body(blocks({ byQuery: true })), 'dataset:sourceTableChoices': body({ ok: true, tables: many, linked: [] }) } });
    open();
    const r = await region();
    expect(within(r).queryByRole('button', { name: 'Change linked tables' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change linked tables' }));
    const dlg = await screen.findByRole('dialog', { name: 'Link tables' });
    for (const t of many.slice(0, 16)) fireEvent.click(await within(dlg).findByRole('checkbox', { name: t }));
    expect(within(dlg).getByText('16 at most')).toBeTruthy();
    expect((within(dlg).getByRole('checkbox', { name: 't16' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('NEGATIVE CONTROL: a viewer sees no region and the web never asks for the notes', async () => {
    const calls = serve({ role: 'viewer' });
    open();
    await screen.findByText('The dataset guide.', {}, LAZY);
    await new Promise((res) => setTimeout(res, 50));
    expect(screen.queryByRole('region', { name: 'From the source table' })).toBeNull();
    expect(count(calls, 'sourceTable:forDataset')).toBe(0);
  });

  it('a file dataset shows nothing', async () => {
    serve({ routes: { 'sourceTable:forDataset': body(blocks({ linkable: false, tables: [] })) } });
    open();
    await screen.findByText('The dataset guide.', {}, LAZY);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'From the source table' })).toBeNull());
  });

  it('a failed read shows its own error with Try again, and the guide above still draws', async () => {
    const calls = serve({ routes: { 'sourceTable:forDataset': { status: 404, body: { error: 'unknown channel' } } } });
    open();
    expect(await screen.findByText('The source notes could not be loaded', {}, LAZY)).toBeTruthy();
    expect(screen.getByText('The dataset guide.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(count(calls, 'sourceTable:forDataset')).toBeGreaterThan(0);
  });
});

describe('A source table\'s Lineage tab', () => {
  it('draws the lineage graph from sourceTable:lineage', async () => {
    serve({
      routes: {
        'sourceTable:get': got(),
        'sourceTable:lineage': body({
          ok: true, focus: `source:st:${W}:${ORD}`, usedIn: { dataset: 1 }, columns: 2, upstream: 0,
          nodes: [
            { id: `source:st:${W}:${ORD}`, kind: 'source', name: 'ANALYTICS.ORDERS', sub: 'Warehouse', col: 0, row: 0 },
            { id: `dataset:${D}`, kind: 'dataset', name: 'Orders', sub: '10 rows', ref: { type: 'dataset', id: D }, col: 1, row: 0 },
          ],
          edges: [{ from: `source:st:${W}:${ORD}`, to: `dataset:${D}` }],
        }),
      },
    });
    renderApp(`/model/${P}?tab=sources&conn=${W}&doc=${ORD}&panel=lineage`);
    const g = await screen.findByRole('group', { name: 'Lineage graph' }, LZ);
    expect(g.textContent).toContain('Orders');
    expect(g.textContent).toContain('ANALYTICS.ORDERS');
  }, 30_000);

  it('a table nothing is built from says so', async () => {
    serve({ routes: { 'sourceTable:get': got(), 'sourceTable:lineage': body({ ok: true, focus: 'x', usedIn: {}, columns: 1, upstream: 0, nodes: [{ id: 'x', kind: 'source', name: 'T', sub: '', col: 0, row: 0 }], edges: [] }) } });
    renderApp(`/model/${P}?tab=sources&conn=${W}&doc=${ORD}&panel=lineage`);
    expect(await screen.findByText('No dataset is built from this table yet.', {}, LZ)).toBeTruthy();
  });
});
