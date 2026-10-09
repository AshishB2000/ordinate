// Live on a PostgreSQL read replica (docs/live-data/00-plan.md L3.2, D8). The
// catalog says PostgreSQL CAN be Live and names its opt-in; the form asks it as
// a checkbox; the workbench offers "Copy the data" / "Live" only on a
// connection that has it ticked; the rail's switch changes it later, and shows
// the server's refusal in place when Live datasets still ask the connection.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { liveOffered, type Connector } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };
const BOX = 'This is a read replica or a warehouse';
const WHY = 'Needed for Live datasets. Live questions run on every view, so pointing them at a primary OLTP database adds load to production.';
const REFUSAL = `One Live dataset asks this connection. Switch it to “Copy the data” before unticking “${BOX}”.`;

const PG: Connector = {
  id: 'postgres',
  label: 'PostgreSQL',
  family: 'postgres',
  category: 'Databases',
  browsable: true,
  live: true,
  liveOptIn: 'readReplica',
  fields: [
    { key: 'host', label: 'Host', type: 'text', required: true, secret: false },
    { key: 'database', label: 'Database', type: 'text', required: true, secret: false },
    { key: 'password', label: 'Password', type: 'password', required: false, secret: true },
    { key: 'readReplica', label: BOX, type: 'checkbox', required: false, secret: false, default: false, help: WHY },
  ],
};
const RS: Connector = { ...PG, id: 'amazon-redshift', label: 'Amazon Redshift', liveOptIn: undefined, fields: PG.fields.slice(0, 3) };
const CONN = (readReplica: boolean) => ({
  id: CID,
  projectId: PID,
  name: 'App DB',
  connectorId: 'postgres',
  values: { host: 'replica.acme.test', database: 'app', readReplica },
  lastStatus: 'ok',
  lastError: null,
  queries: [],
  secretSet: { password: true },
  datasetCount: 1,
});
const SAMPLE = { ok: true, preview: { columns: [{ name: 'region', type: 'text' }], rows: [['North']], rowCount: 1 } };

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });

function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      const r = routes[channel] ?? { body: [] };
      const out = typeof r === 'function' ? r(payload) : r;
      return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
    }),
  );
  return calls;
}

const base = (extra: Record<string, Reply> = {}) => ({
  '/api/auth/me': { body: ME },
  'projects:list': { body: [{ id: PID, name: 'Sales', createdAt: '', updatedAt: '' }] },
  'connectors:catalog': { body: [PG, RS] },
  'connectors:logos': { body: {} },
  'connections:list': { body: [] },
  'connection:listTables': { body: { ok: true, tables: [{ schema: 'public', name: 'orders' }] } },
  'connection:sample': { body: SAMPLE },
  'dataset:list': { body: [] },
  ...extra,
});

describe('liveOffered (the workbench mirror of the server rule)', () => {
  it('needs the opt-in ticked where the connector asks for one, and only a real true', () => {
    expect(liveOffered(PG, { values: { readReplica: true } })).toBe(true);
    expect(liveOffered(PG, { values: { readReplica: false } })).toBe(false);
    expect(liveOffered(PG, { values: {} })).toBe(false);
    expect(liveOffered(PG, { values: { readReplica: 'true' } })).toBe(false);
    expect(liveOffered(RS, { values: {} })).toBe(true);
    expect(liveOffered({ ...PG, live: false }, { values: { readReplica: true } })).toBe(false);
    expect(liveOffered(null, { values: { readReplica: true } })).toBe(false);
  });
});

describe('the new-connection form', () => {
  it('asks it as a checkbox that says why, off by default, and sends it as a value', async () => {
    const calls = serve(base({ 'connection:testAndSave': { body: { ok: false, error: 'connection refused' } } }));
    renderApp(`/connections/${PID}?source=postgres`);
    const box = (await screen.findByRole('checkbox', { name: BOX })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(document.getElementById(box.getAttribute('aria-describedby')!)!.textContent).toBe(WHY);
    fireEvent.change(screen.getByLabelText('Host *'), { target: { value: 'replica.acme.test' } });
    fireEvent.change(screen.getByLabelText('Database *'), { target: { value: 'app' } });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Test & Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'connection:testAndSave')).toBe(true));
    const sent = calls.find((c) => c.channel === 'connection:testAndSave')!.payload as { values: Record<string, unknown> };
    expect(sent.values).toEqual({ host: 'replica.acme.test', database: 'app', readReplica: true });
  });
});

describe('the workbench', () => {
  it('offers no Live choice on an unticked PostgreSQL; the rail switch ticks it, and then it does', async () => {
    let ticked = false;
    const calls = serve(
      base({
        'connections:list': () => ({ body: [CONN(ticked)] }),
        'connection:setLiveOptIn': (p) => ((ticked = (p as { on: boolean }).on), { body: { ok: true, on: ticked } }),
      }),
    );
    renderApp(`/connections/${PID}/${CID}?table=public.orders`);
    expect(await screen.findByRole('button', { name: 'Save as dataset' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'How to save' })).toBeNull();
    const rail = await screen.findByRole('complementary', { name: 'Connection details' });
    // A setting, not a fact: a switch under the facts, never a "No" among them.
    const sw = within(rail).getByRole('switch', { name: BOX }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    expect(within(rail).getByText(WHY)).toBeTruthy();
    expect(within(rail).queryByText('No')).toBeNull();
    fireEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.channel === 'connection:setLiveOptIn')).toBe(true));
    expect(calls.find((c) => c.channel === 'connection:setLiveOptIn')!.payload).toEqual({ projectId: PID, connId: CID, on: true });
    expect(await screen.findByText('Live is now offered for datasets from this connection.')).toBeTruthy();
    const how = await screen.findByRole('combobox', { name: 'How to save' });
    expect(how.textContent).toBe('Copy the data');
    expect((within(rail).getByRole('switch', { name: BOX }) as HTMLInputElement).checked).toBe(true);
  });

  it('shows the refusal in place when Live datasets still ask the connection, and stays ticked', async () => {
    const calls = serve(
      base({
        'connections:list': { body: [CONN(true)] },
        'dataset:list': { body: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Orders live', rowCount: 0, updatedAt: '2026-10-01T10:00:00Z', originKind: 'connection', originConnId: CID, mode: 'live' }] },
        'connection:setLiveOptIn': { body: { ok: false, code: 'live_in_use', liveDatasets: 1, error: REFUSAL } },
      }),
    );
    renderApp(`/connections/${PID}/${CID}?table=public.orders`);
    expect(await screen.findByRole('combobox', { name: 'How to save' })).toBeTruthy();
    const rail = await screen.findByRole('complementary', { name: 'Connection details' });
    const sw = within(rail).getByRole('switch', { name: BOX }) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    expect((await within(rail).findByRole('alert')).textContent).toBe(REFUSAL);
    expect(calls.find((c) => c.channel === 'connection:setLiveOptIn')!.payload).toEqual({ projectId: PID, connId: CID, on: false });
    expect((within(rail).getByRole('switch', { name: BOX }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('combobox', { name: 'How to save' })).toBeTruthy();
  });

  it('a warehouse with no opt-in has no switch and always offers Live', async () => {
    serve(base({ 'connections:list': { body: [{ ...CONN(false), connectorId: 'amazon-redshift', values: { host: 'dw.acme.test', database: 'dw' } }] } }));
    renderApp(`/connections/${PID}/${CID}?table=public.orders`);
    expect(await screen.findByRole('combobox', { name: 'How to save' })).toBeTruthy();
    const rail = await screen.findByRole('complementary', { name: 'Connection details' });
    expect(within(rail).queryByRole('switch')).toBeNull();
  });
});
