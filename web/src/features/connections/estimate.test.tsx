// The editor's dry-run estimate (L1.3): a source whose catalog entry says
// `estimates` (BigQuery) shows the server's "~1.2 GB" by Run once typing
// pauses; a source that cannot estimate never makes the call.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import type { Connector } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const CID = '33333333-3333-4333-8333-333333333333';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };

const BQ: Connector = {
  id: 'bigquery',
  label: 'Google BigQuery',
  family: 'bigquery',
  category: 'Cloud warehouses',
  browsable: true,
  estimates: true,
  hosts: ['bigquery.googleapis.com', 'oauth2.googleapis.com'],
  fields: [
    { key: 'project', label: 'Billing project', type: 'text', required: false, secret: false },
    { key: 'token', label: 'Service-account key (JSON)', type: 'textarea', required: true, secret: true },
  ],
};
const PG: Connector = { ...BQ, id: 'postgres', label: 'PostgreSQL', family: 'postgres', category: 'Databases', estimates: false, hosts: undefined };
const conn = (connectorId: string) => ({
  id: CID,
  projectId: PID,
  name: 'Warehouse',
  connectorId,
  values: { project: 'acme-analytics' },
  lastStatus: 'ok',
  lastError: null,
  queries: [],
  secretSet: { token: true },
});

type Reply = { status?: number; body?: unknown };

function serve(connectorId: string, estimate: Reply) {
  const calls: { channel: string; payload: unknown }[] = [];
  const routes: Record<string, Reply> = {
    '/api/auth/me': { body: ME },
    'projects:list': { body: [{ id: PID, name: 'Sales', createdAt: '', updatedAt: '' }] },
    'connectors:catalog': { body: [BQ, PG] },
    'connectors:logos': { body: {} },
    'connections:list': { body: [conn(connectorId)] },
    'connection:listTables': { body: { ok: true, tables: [{ schema: 'sales', name: 'orders' }] } },
    'dataset:list': { body: [] },
    'connection:estimate': estimate,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      const r = routes[channel] ?? { body: [] };
      return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

async function type(sql: string) {
  const editor = await screen.findByRole('combobox', { name: 'SQL' });
  fireEvent.change(editor, { target: { value: sql } });
}

describe('the editor estimate', () => {
  it('shows the dry run\'s size by Run once typing pauses, for a source that estimates', async () => {
    const calls = serve('bigquery', { body: { ok: true, estimate: { bytes: 1288490188, label: '~1.2 GB' } } });
    renderApp(`/connections/${PID}/${CID}`);
    await type('select region from sales.orders');
    const shown = await screen.findByRole('status', { name: 'Estimate: ~1.2 GB' }, { timeout: 3000 });
    expect(shown.textContent).toBe('~1.2 GB');
    expect(shown.getAttribute('title')).toBe('A free dry run says this query would process about 1.2 GB.');
    const asked = calls.filter((c) => c.channel === 'connection:estimate');
    expect(asked).toHaveLength(1);
    expect(asked[0].payload).toEqual({ projectId: PID, connId: CID, sql: 'select region from sales.orders' });
  });

  it('says there is no estimate, with the reason, when the dry run refuses', async () => {
    serve('bigquery', { body: { ok: false, error: 'Refused: only SELECT statements run on BigQuery here.' } });
    renderApp(`/connections/${PID}/${CID}`);
    await type('delete from sales.orders where true');
    const shown = await screen.findByRole('status', { name: 'Estimate: No estimate' }, { timeout: 3000 });
    expect(shown.getAttribute('title')).toBe('Refused: only SELECT statements run on BigQuery here.');
  });

  it('never asks for a source that cannot estimate', async () => {
    const calls = serve('postgres', { body: { ok: true, estimate: null } });
    renderApp(`/connections/${PID}/${CID}`);
    await type('select 1');
    await new Promise((r) => setTimeout(r, 1200));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'SQL' })).toBeTruthy());
    expect(calls.some((c) => c.channel === 'connection:estimate')).toBe(false);
    expect(screen.queryByRole('status', { name: /^Estimate:/ })).toBeNull();
  });
});
