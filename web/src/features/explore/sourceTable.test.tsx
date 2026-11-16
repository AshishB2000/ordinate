// Explore on a source table, no dataset (Assistant phase D; docs/assistant/00-design.md, "Explore, as built"): an editor
// picks a documented warehouse table as a dataset; every call names it (`table` beside its doc's id); the header says it
// is a warehouse table and offers Keep as a dataset, which opens the new Live dataset with the same question. A table on
// a connection not asked live asks nothing and says to copy it in. A viewer is offered only the tables their teams were
// given (team folders E8, `teamTables:mine`), by label, with no Keep; given none, they never send `table`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { decodeQuestion, encodeQuestion, type Question } from './spec';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const CONN = '33333333-3333-4333-8333-333333333333';
const DOC = '44444444-4444-4444-8444-444444444444';
const COPY_CONN = '55555555-5555-4555-8555-555555555555';
const COPY_DOC = '66666666-6666-4666-8666-666666666666';
const KEPT = '77777777-7777-4777-8777-777777777777';
const ME = { user: { email: 'dev@local', role: 'viewer' }, org: 'default', mode: 'header', canSignOut: false };
const BY_REASON = { category: 'reason', values: [{ column: 'amount', aggregation: 'sum' as const }] };
const Q: Question = { chartType: 'column', encoding: BY_REASON, filters: [] };
const SUGGEST = { ok: true, dimensions: [{ name: 'reason', type: 'text' }], dates: [{ name: 'day' }], measures: [{ name: 'amount', aggregation: 'sum' }], suggestions: [{ chartType: 'column', encoding: BY_REASON }] };
const ANSWER = { ok: true, data: { labels: ['Damaged', 'Late'], series: [{ name: 'sum of amount', values: [12.6, 7.2] }] }, recommendedShape: 'categorical', warnings: [], asOf: { mode: 'live', at: '2026-11-15T10:00:00Z' } };
const row = (docId: string, table: string) => ({ docId, table, owner: '', hasGuide: false, readAt: '2026-11-15T09:00:00Z', datasetIds: [] });
const SOURCES = {
  ok: true,
  todo: [],
  more: 0,
  connections: [
    { connId: CONN, name: 'Warehouse', connectorId: 'snowflake', label: 'Snowflake', readsFacts: true, live: true, rows: [row(DOC, 'RETURNS'), { table: 'UNDOCUMENTED', owner: '', hasGuide: false, datasetIds: [] }] },
    { connId: COPY_CONN, name: 'App DB', connectorId: 'postgres', label: 'PostgreSQL', readsFacts: true, rows: [row(COPY_DOC, 'TICKETS')] },
  ],
};

function serve(role: 'viewer' | 'editor', extra: Record<string, RpcReply> = {}) {
  const datasets = [{ id: DID, name: 'Retail orders', sourceKind: 'csv', rowCount: 5000, columnCount: 5, updatedAt: '' }];
  return serveRpc({
    '/api/auth/me': { body: ME },
    'projects:overview': { body: [{ id: PID, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] },
    'projects:roles': { body: { [PID]: role } },
    'ai:status': { body: { ready: false, models: [], mine: null, keyStore: null } },
    'dataset:list': () => ({ body: datasets }),
    'sourceTable:list': role === 'editor' ? { body: SOURCES } : { status: 403, body: { error: 'forbidden' } },
    'teamTables:mine': { body: { ok: true, tables: [] } },
    'explore:suggest': { body: SUGGEST },
    'visual:data': { body: ANSWER },
    'visual:dataBatch': (p) => ({ body: ((p as { items: unknown[] }).items ?? []).map(() => ANSWER) }),
    'explore:keepTable': () => {
      datasets.push({ id: KEPT, name: 'RETURNS', sourceKind: 'connection', rowCount: 0, columnCount: 3, updatedAt: '' });
      return { body: { ok: true, datasetId: KEPT } };
    },
    ...extra,
  });
}

const at = (dataset: string, table?: string, q?: Question) => `/explore?project=${PID}&dataset=${dataset}${table ? `&table=${table}` : ''}${q ? `&q=${encodeQuestion(q)}` : ''}`;
const named = (calls: { channel: string; payload: unknown }[], id: string) => calls.filter((c) => JSON.stringify(c.payload ?? null).includes(id));

describe('Explore on a source table', () => {
  it('an editor asks a live table: every call names it, the header says what it is, Keep as a dataset opens the new dataset', async () => {
    const calls = serve('editor');
    const router = renderApp(at(DOC, CONN, Q));
    await screen.findByRole('heading', { level: 2, name: 'Total amount by reason' });
    await screen.findByText('Warehouse table, not a dataset');
    await screen.findByText('12.6');
    const asked = named(calls, DOC);
    expect(asked.map((c) => c.channel)).toEqual(expect.arrayContaining(['explore:suggest', 'visual:data']));
    // Every call about the table carries its connection: the server reads the table's Live view, never a dataset by that id.
    expect(asked.every((c) => (c.payload as { table?: string }).table === CONN)).toBe(true);
    // Nothing to save until it is a dataset: Keep in the header, no Save as visual and no builder.
    expect(screen.queryByRole('button', { name: 'Save as visual' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open in the builder' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep as a dataset' }));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('dataset')).toBe(KEPT));
    const url = new URLSearchParams(router.state.location.search);
    expect(url.get('table')).toBeNull();
    expect(decodeQuestion(url.get('q'))).toEqual(Q); // the same question, now on the dataset
    expect(calls.filter((c) => c.channel === 'explore:keepTable').map((c) => c.payload)).toEqual([{ projectId: PID, datasetId: DOC, table: CONN }]);
    expect(await screen.findByRole('button', { name: 'Save as visual' })).toBeTruthy();
    expect(screen.queryByText('Warehouse table, not a dataset')).toBeNull();
  });

  it('the picker offers the documented, read tables after the datasets, a table to copy marked so', async () => {
    serve('editor');
    renderApp(at(DID));
    await screen.findByRole('heading', { level: 1, name: 'Explore' });
    fireEvent.click(await screen.findByRole('combobox', { name: 'Dataset' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['Retail orders', 'RETURNSTable on Warehouse', 'TICKETSCopy first']);
  });

  it('a table on a connection not asked live asks nothing and says to copy it in', async () => {
    const calls = serve('editor');
    renderApp(at(COPY_DOC, COPY_CONN, Q));
    await screen.findByRole('heading', { name: 'Copy TICKETS into Ordinate first' });
    expect(screen.getByRole('link', { name: 'Open App DB' }).getAttribute('href')).toBe(`/connections/${PID}/${COPY_CONN}`);
    expect(named(calls, COPY_DOC)).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Keep as a dataset' })).toBeNull();
  });

  it('a viewer given no table is never offered one: a link naming one opens a dataset, and no call carries `table`', async () => {
    const calls = serve('viewer');
    const router = renderApp(at(DOC, CONN, Q));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('dataset')).toBe(DID));
    expect(new URLSearchParams(router.state.location.search).get('table')).toBeNull();
    await screen.findByRole('heading', { level: 1, name: 'Explore' });
    expect(calls.some((c) => c.channel === 'sourceTable:list')).toBe(false);
    expect(calls.some((c) => JSON.stringify(c.payload ?? null).includes(CONN))).toBe(false);
    fireEvent.click(await screen.findByRole('combobox', { name: 'Dataset' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Retail orders']);
  });

  it('a viewer given a table explores it by its label alone, with no Keep and no connection', async () => {
    const calls = serve('viewer', { 'teamTables:mine': { body: { ok: true, tables: [{ connId: CONN, docId: DOC, name: 'Returns log', live: true }] } } });
    renderApp(at(DOC, CONN, Q));
    await screen.findByText('Warehouse table, not a dataset');
    await screen.findByText('12.6');
    expect(screen.getAllByText('Returns log').length).toBeGreaterThan(0);
    const asked = named(calls, DOC);
    expect(asked.map((c) => c.channel)).toEqual(expect.arrayContaining(['explore:suggest', 'visual:data']));
    expect(asked.every((c) => (c.payload as { table?: string }).table === CONN)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Keep as a dataset' })).toBeNull();
    expect(calls.some((c) => c.channel === 'sourceTable:list')).toBe(false);
    expect(screen.getByRole('main').textContent).not.toMatch(/RETURNS|Warehouse(?! table)/); // the page (an earlier test's toast lives outside it)
    fireEvent.click(await screen.findByRole('combobox', { name: 'Dataset' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Retail orders', 'Returns logWarehouse table']);
  });
});
