import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { setHidden, tableState, toggleSchema, toggleTable, type Tick } from './teamTablesApi';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const C = 'c1';
const tick = (schema: string, table: string | undefined, include: boolean, hidden: string[] = []): Tick => ({ connId: C, schema, ...(table ? { table } : {}), include, hidden });

describe('a team\'s ticks, as a click changes them', () => {
  it('a schema tick gives its tables; unticking one under it is an exclude, ticking it back removes that', () => {
    const on = toggleSchema([], C, 'SALES', true);
    expect(tableState(on, C, 'SALES', 'ORDERS')).toEqual({ given: true, own: false, hidden: [] });
    const out = toggleTable(on, C, 'SALES', 'PAYROLL', false);
    expect(out).toContainEqual(tick('SALES', 'PAYROLL', false));
    expect(tableState(out, C, 'SALES', 'PAYROLL').given).toBe(false);
    expect(toggleTable(out, C, 'SALES', 'PAYROLL', true)).toEqual(on);
  });

  it('without a schema tick a table is its own include row; off removes it', () => {
    const on = toggleTable([], C, 'SALES', 'ORDERS', true);
    expect(on).toEqual([tick('SALES', 'ORDERS', true)]);
    expect(toggleTable(on, C, 'SALES', 'ORDERS', false)).toEqual([]);
  });

  it('hidden columns make a table row that wins over the schema; clearing them goes back to the schema', () => {
    const on = toggleSchema([], C, 'SALES', true);
    const hid = setHidden(on, C, 'SALES', 'CUSTOMERS', ['phone', 'email']);
    expect(tableState(hid, C, 'SALES', 'CUSTOMERS')).toEqual({ given: true, own: true, hidden: ['email', 'phone'] });
    expect(setHidden(hid, C, 'SALES', 'CUSTOMERS', [])).toEqual(on);
  });

  it('unticking a schema drops its excludes and keeps a table ticked on its own', () => {
    const ticks = [tick('SALES', undefined, true), tick('SALES', 'PAYROLL', false), tick('SALES', 'CUSTOMERS', true, ['email'])];
    expect(toggleSchema(ticks, C, 'SALES', false)).toEqual([tick('SALES', 'CUSTOMERS', true, ['email'])]);
  });
});

const ADMIN = { user: { email: 'boss@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true };
const TEAM = { id: 't1', name: 'Ops analysts', createdAt: '2026-09-01T10:00:00Z', members: [] };

function serve(routes: Record<string, unknown>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
    const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
    if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
    const r = routes[channel] ?? [];
    return new Response(JSON.stringify(typeof r === 'function' ? (r as (p: unknown) => unknown)(payload) : r), { status: 200 });
  }));
  return calls;
}

const BASE = {
  '/api/auth/me': ADMIN,
  'admin:teams': [TEAM],
  'admin:idpGroups': { mode: 'oidc', source: null, from: null, roleManaged: false, groups: [], linkedTeamIds: [] },
  'admin:projects': [{ id: 'p1', name: 'Retail', archived: false, updatedAt: '2026-10-01T10:00:00Z', owner: null }],
  'connections:list': [{ id: C, name: 'Snowflake (prod)', connectorId: 'snowflake', values: {}, lastStatus: 'ok' }],
  'sourceTable:list': { ok: true, connections: [{ connId: C, name: 'Snowflake (prod)', connectorId: 'snowflake', label: 'Snowflake', readsFacts: true, rows: [{ docId: 'd1', table: 'SALES.ORDERS', owner: '', hasGuide: false, readAt: '2026-10-01T10:00:00Z', label: 'Orders', datasetIds: [] }] }], todo: [], more: 0 },
  'connection:listTables': { ok: true, tables: [{ schema: 'SALES', name: 'ORDERS' }, { schema: 'SALES', name: 'PAYROLL' }] },
};

describe('Admin → Teams → Tables', () => {
  it('shows the team\'s ticks per connection, says when the team has no role, and saves an exclude', async () => {
    const calls = serve({ ...BASE, 'teamTables:get': { ok: true, role: null, rows: [tick('SALES', undefined, true)] }, 'teamTables:set': { ok: true, rows: 2 } });
    renderApp('/admin?tab=teams&team=t1');
    expect(await screen.findByRole('heading', { name: 'Ops analysts · Tables' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Ops analysts has no role on Retail' })).toBeTruthy();
    expect(screen.getByText(/Everyone in this team sees every row/)).toBeTruthy();
    expect(calls.some((c) => c.channel === 'connection:listTables')).toBe(false); // a warehouse call: only on Show tables
    fireEvent.click(screen.getByRole('button', { name: 'Show tables' }));
    const card = await screen.findByRole('region', { name: 'Snowflake (prod)' });
    expect(((await within(card).findByLabelText('SALES')) as HTMLInputElement).checked).toBe(true);
    expect((within(card).getByLabelText('ORDERS') as HTMLInputElement).checked).toBe(true);
    expect(within(card).getByText('Viewers see it as “Orders”')).toBeTruthy();
    expect(within(card).getAllByText('Name it for viewers: until then they are not offered it')).toHaveLength(1); // PAYROLL has no doc
    fireEvent.click(within(card).getByLabelText('PAYROLL'));
    await waitFor(() => expect(calls.some((c) => c.channel === 'teamTables:set')).toBe(true));
    expect(calls.find((c) => c.channel === 'teamTables:set')?.payload).toEqual({
      projectId: 'p1', teamId: 't1', connId: C, rows: [{ schema: 'SALES', include: true }, { schema: 'SALES', table: 'PAYROLL', include: false }],
    });
  }, 20_000);

  it('names a table for viewers on its doc when the field loses focus', async () => {
    const calls = serve({ ...BASE, 'teamTables:get': { ok: true, role: 'viewer', rows: [tick('SALES', 'ORDERS', true)] }, 'sourceTable:save': { ok: true, docId: 'd1', tag: 'x' } });
    renderApp('/admin?tab=teams&team=t1');
    fireEvent.click(await screen.findByRole('button', { name: 'Show tables' }));
    const field = await screen.findByLabelText('Name ORDERS for viewers');
    fireEvent.change(field, { target: { value: 'Shop orders' } });
    fireEvent.blur(field);
    await waitFor(() => expect(calls.some((c) => c.channel === 'sourceTable:save')).toBe(true));
    expect(calls.find((c) => c.channel === 'sourceTable:save')?.payload).toEqual({ projectId: 'p1', connId: C, docId: 'd1', patch: { label: 'Shop orders' } });
    expect(screen.queryByText(/has no role on/)).toBeNull();
  });

  it('says what to do when the project has no connection, and when the list fails', async () => {
    serve({ ...BASE, 'connections:list': [], 'teamTables:get': { ok: true, role: 'viewer', rows: [] } });
    renderApp('/admin?tab=teams&team=t1');
    expect(await screen.findByRole('heading', { name: 'No connections in this project' })).toBeTruthy();
  });

  it('shows the server\'s refusal as an error state', async () => {
    serve({ ...BASE, 'teamTables:get': { ok: false, error: 'Tables for teams need a database (DATABASE_URL): without one this server has no teams.' } });
    renderApp('/admin?tab=teams&team=t1');
    expect(await screen.findByText(/Tables for teams need a database/)).toBeTruthy();
  });
});
