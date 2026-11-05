// + Add: pick any table of a connection, on a click (connection:listTables), and start its notes (02-source-tables.md D4).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../../test-utils';
import { body, got, LAZY, ORD, P, S, serve, W } from './testServe';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NEW = 'd9000000-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const TABLES = body({ ok: true, tables: [{ schema: 'public', name: 'orders' }, { schema: 'public', name: 'refunds' }, { schema: 'audit', name: 'events' }] });
const count = (calls: { channel: string }[], channel: string) => calls.filter((c) => c.channel === channel).length;
const params = (r: { state: { location: { search: string } } }) => new URLSearchParams(r.state.location.search);
const nav = () => screen.findByRole('navigation', { name: 'Source tables' }, LAZY);

describe('+ Add', () => {
  it('lists the connection\'s tables only when opened, and marks the documented ones', async () => {
    const calls = serve({ 'connection:listTables': TABLES, 'sourceTable:get': got() });
    renderApp(`/model/${P}?tab=sources`);
    const list = await nav();
    expect(count(calls, 'connection:listTables')).toBe(0);
    fireEvent.click(within(list).getByRole('button', { name: 'Add a table from Shop DB' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a source table' });
    await within(dialog).findByRole('button', { name: /public\.refunds/ });
    expect(count(calls, 'connection:listTables')).toBe(1);
    expect(calls.find((c) => c.channel === 'connection:listTables')?.payload).toEqual({ projectId: P, connId: S });
    expect(within(within(dialog).getByRole('button', { name: /public\.orders/ })).getByText('documented')).toBeTruthy();
    expect(within(within(dialog).getByRole('button', { name: /public\.refunds/ })).queryByText('documented')).toBeNull();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search tables' }), { target: { value: 'EVE' } });
    expect(within(dialog).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['audit.events']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(count(calls, 'connection:listTables')).toBe(1);
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('picking a table starts its notes and opens them by id, never by name', async () => {
    const calls = serve({
      'connection:listTables': TABLES,
      'sourceTable:save': body({ ok: true, docId: NEW, created: true, tag: 'T0' }),
      'sourceTable:get': got(),
    });
    const router = renderApp(`/model/${P}?tab=sources`);
    fireEvent.click(within(await nav()).getByRole('button', { name: 'Add a table from Shop DB' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a source table' });
    fireEvent.click(await within(dialog).findByRole('button', { name: /public\.refunds/ }));
    await waitFor(() => expect(params(router).get('doc')).toBe(NEW));
    expect(params(router).get('conn')).toBe(S);
    expect(router.state.location.search).not.toContain('refunds');
    expect(calls.find((c) => c.channel === 'sourceTable:save')?.payload).toEqual({ projectId: P, connId: S, table: 'public.refunds', patch: {} });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('picking a documented table opens that doc (the server finds it by its exact name)', async () => {
    serve({ 'connection:listTables': TABLES, 'sourceTable:save': body({ ok: true, docId: ORD, created: false, tag: 'T0' }), 'sourceTable:get': got() });
    const router = renderApp(`/model/${P}?tab=sources&conn=${S}`);
    fireEvent.click(within(await nav()).getByRole('button', { name: 'Add a table from Warehouse' }));
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: /public\.orders/ }));
    await waitFor(() => expect(params(router).get('doc')).toBe(ORD));
    expect(params(router).get('conn')).toBe(W);
  });

  it('Connections\' link for a connection with nothing listed yet: the way to add its first table', async () => {
    const C = 'c9000000-2f0a-4b8e-9d34-1c2d3e4f5a6b';
    const calls = serve({ 'sourceTable:list': body({ ok: true, connections: [], todo: [], more: 0 }), 'connection:listTables': TABLES });
    renderApp(`/model/${P}?tab=sources&conn=${C}`);
    expect(await screen.findByRole('heading', { name: 'No source tables on this connection yet' }, LAZY)).toBeTruthy();
    expect(count(calls, 'connection:listTables')).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add a table' }));
    await within(await screen.findByRole('dialog', { name: 'Add a source table' })).findByRole('button', { name: /audit\.events/ });
    expect(calls.find((c) => c.channel === 'connection:listTables')?.payload).toEqual({ projectId: P, connId: C });
  });
});
