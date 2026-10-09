import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { collect, initialDraft } from './ConnectionForm';
import type { Connector } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };

const PG: Connector = {
  id: 'postgres',
  label: 'PostgreSQL',
  family: 'postgres',
  category: 'Databases',
  blurb: 'Read-only access to a PostgreSQL database.',
  browsable: true,
  fields: [
    { key: 'host', label: 'Host', type: 'text', required: true, secret: false },
    { key: 'port', label: 'Port', type: 'number', required: true, secret: false, default: 5432 },
    { key: 'database', label: 'Database', type: 'text', required: true, secret: false },
    { key: 'password', label: 'Password', type: 'password', required: false, secret: true },
    { key: 'ssl', label: 'Use TLS', type: 'checkbox', required: false, secret: false, default: false },
  ],
};
const URLC: Connector = { id: 'url', label: 'URL / API (JSON)', family: 'http', category: 'Files & local', browsable: false, fields: [{ key: 'url', label: 'URL', type: 'text', required: true, secret: false }] };
const CONN = {
  id: CID,
  projectId: PID,
  name: 'Orders DB',
  connectorId: 'postgres',
  values: { host: 'db.acme.test', port: 5432, database: 'orders', ssl: false },
  lastStatus: 'ok',
  lastError: null,
  queries: [],
  secretSet: { password: true },
  datasetCount: 2,
};

// Snowflake (L1.1): a multi-line secret — the private key — in a masked textarea.
const SF: Connector = {
  id: 'snowflake',
  label: 'Snowflake',
  family: 'snowflake',
  category: 'Cloud warehouses',
  browsable: true,
  fields: [
    { key: 'account', label: 'Account', type: 'text', required: true, secret: false },
    { key: 'user', label: 'User', type: 'text', required: true, secret: false },
    { key: 'token', label: 'Private key or access token', type: 'textarea', required: true, secret: true, placeholder: '-----BEGIN PRIVATE KEY-----' },
    { key: 'password', label: 'Private key passphrase', type: 'password', required: false, secret: true },
    { key: 'warehouse', label: 'Warehouse', type: 'text', required: true, secret: false },
  ],
};
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7canary\nline+two/canary==\n-----END PRIVATE KEY-----';
const PEM2 = '-----BEGIN PRIVATE KEY-----\nMIIEsecondKEYcanaryAAAA\n-----END PRIVATE KEY-----';
const SF_CONN = {
  ...CONN,
  name: 'Warehouse',
  connectorId: 'snowflake',
  values: { account: 'myorg-myaccount', user: 'reader', warehouse: 'COMPUTE_WH', database: 'SALES' },
  secretSet: { token: true, password: false },
  datasetCount: 0,
};
const WARNING = 'This connection signs in with the ACCOUNTADMIN role, which can change data and account settings.';

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
  'connectors:catalog': { body: [PG, URLC] },
  'connectors:logos': { body: {} },
  'connections:list': { body: [] },
  ...extra,
});

describe('the form helpers', () => {
  it('never puts a secret in the draft or the values', () => {
    const draft = initialDraft(PG, { host: 'h', password: 'leak' } as never);
    expect(draft).not.toHaveProperty('password');
    const { values, missing } = collect(PG, { ...draft, database: '' });
    expect(values).toEqual({ host: 'h', port: 5432, ssl: false });
    expect(missing.map((f) => f.key)).toEqual(['database']);
  });
});

describe('Connections', () => {
  it('shows the picker grouped by category, and filters it', async () => {
    serve(base());
    renderApp(`/connections/${PID}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Connections' })).toBeTruthy();
    expect(await screen.findByText('No connections yet. Pick a source below to add one.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Databases (1)' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search data sources' }), { target: { value: 'zz' } });
    expect(screen.getByText('No data sources match that search.')).toBeTruthy();
    expect(screen.getByText('0 of 2 sources')).toBeTruthy();
  });

  it('shows a retry when the catalog fails', async () => {
    serve(base({ 'connectors:catalog': { status: 500, body: { error: 'boom' } } }));
    renderApp(`/connections/${PID}`);
    expect(await screen.findByRole('heading', { name: 'The data sources could not be loaded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('validates required fields without a call, then sends the secret apart from the values', async () => {
    const calls = serve(base({ 'connection:testAndSave': { body: { ok: false, error: 'connection refused' } } }));
    renderApp(`/connections/${PID}?source=postgres`);
    const save = await screen.findByRole('button', { name: 'Test & Save' });
    const pw = screen.getByLabelText('Password') as HTMLInputElement;
    expect(pw.type).toBe('password');
    expect(pw.value).toBe('');
    fireEvent.click(save);
    expect(await screen.findByText('These fields are required: Host, Database.')).toBeTruthy();
    expect(calls.some((c) => c.channel === 'connection:testAndSave')).toBe(false);
    fireEvent.change(screen.getByLabelText('Host *'), { target: { value: 'db' } });
    fireEvent.change(screen.getByLabelText('Database *'), { target: { value: 'orders' } });
    fireEvent.change(pw, { target: { value: 's3cret' } });
    fireEvent.click(save);
    expect(await screen.findByText('connection refused')).toBeTruthy();
    const sent = calls.find((c) => c.channel === 'connection:testAndSave')!.payload as { values: object; secrets: object };
    expect(sent.values).toEqual({ host: 'db', port: 5432, database: 'orders', ssl: false });
    expect(sent.secrets).toEqual({ password: 's3cret' });
  });

  it('cards a saved connection with its server-counted datasets', async () => {
    serve(base({ 'connections:list': { body: [CONN] } }));
    renderApp(`/connections/${PID}`);
    const card = await screen.findByRole('link', { name: 'Open Orders DB' });
    expect(card.textContent).toContain('PostgreSQL · db.acme.test / orders');
    expect(card.textContent).toContain('2 datasets · never used');
  });
});

describe('a multi-line secret (the Snowflake private key)', () => {
  it('is a masked, write-only textarea whose value goes only into the secrets, line breaks intact', async () => {
    let saved = false;
    const calls = serve(
      base({
        'connectors:catalog': { body: [PG, SF] },
        'connection:testAndSave': () => ((saved = true), { body: { ok: true, connection: SF_CONN, warnings: [WARNING] } }),
        'connections:list': () => ({ body: saved ? [SF_CONN] : [] }),
        'connection:listTables': { body: { ok: true, tables: [{ schema: 'PUBLIC', name: 'ORDERS' }], warnings: [WARNING] } },
        'dataset:list': { body: [] },
      }),
    );
    renderApp(`/connections/${PID}?source=snowflake`);
    const key = (await screen.findByLabelText('Private key or access token *')) as HTMLTextAreaElement;
    expect(key.tagName).toBe('TEXTAREA');
    expect(key.value).toBe('');
    expect(key.hasAttribute('data-secret')).toBe(true);
    expect(key.getAttribute('spellcheck')).toBe('false');
    expect(key.getAttribute('autocomplete')).toBe('off');
    expect(key.getAttribute('autocapitalize')).toBe('off');
    expect(document.getElementById(key.getAttribute('aria-describedby')!)!.textContent).toMatch(/Write-only: it is stored encrypted and never shown again\.$/);
    fireEvent.change(key, { target: { value: PEM } });
    // Copy and cut are refused, as on a password input.
    expect(fireEvent.copy(key)).toBe(false);
    expect(fireEvent.cut(key)).toBe(false);
    fireEvent.change(screen.getByLabelText('Account *'), { target: { value: 'myorg-myaccount' } });
    fireEvent.change(screen.getByLabelText('User *'), { target: { value: 'reader' } });
    fireEvent.change(screen.getByLabelText('Warehouse *'), { target: { value: 'COMPUTE_WH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test & Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'connection:testAndSave')).toBe(true));
    const sent = calls.find((c) => c.channel === 'connection:testAndSave')!.payload as { values: Record<string, unknown>; secrets: Record<string, string> };
    expect(sent.secrets).toEqual({ token: PEM });
    expect(JSON.stringify(sent.values)).not.toContain('PRIVATE KEY');
    // Saved: the workbench opens; the test's warning is shown (toast and rail), the key nowhere.
    const rail = await screen.findByRole('complementary', { name: 'Connection details' });
    expect(await within(rail).findByText(WARNING)).toBeTruthy();
    expect(within(rail).getByText('Key saved')).toBeTruthy();
    expect(screen.getAllByText(WARNING).length).toBeGreaterThanOrEqual(1);
    expect(document.body.innerHTML).not.toContain('canary');
  });

  it('shows "Key saved" in the rail; Replace reveals an EMPTY masked textarea and sends the new key once', async () => {
    const calls = serve(
      base({
        'connectors:catalog': { body: [PG, SF] },
        'connections:list': { body: [SF_CONN] },
        'connection:listTables': { body: { ok: true, tables: [] } },
        'dataset:list': { body: [] },
        'connection:replaceSecret': { body: { ok: true, connection: SF_CONN } },
      }),
    );
    renderApp(`/connections/${PID}/${CID}`);
    const rail = await screen.findByRole('complementary', { name: 'Connection details' });
    expect(within(rail).getByText('Key saved')).toBeTruthy();
    expect(within(rail).getByText('Not set')).toBeTruthy(); // the passphrase
    expect(rail.querySelector('textarea')).toBeNull();
    fireEvent.click(within(rail).getByRole('button', { name: 'Replace Private key or access token' }));
    const next = within(rail).getByLabelText('New private key or access token') as HTMLTextAreaElement;
    expect(next.tagName).toBe('TEXTAREA');
    expect(next.value).toBe('');
    expect(next.hasAttribute('data-secret')).toBe(true);
    fireEvent.change(next, { target: { value: PEM2 } });
    fireEvent.click(within(rail).getByRole('button', { name: 'Test & replace' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'connection:replaceSecret')).toBe(true));
    expect(calls.find((c) => c.channel === 'connection:replaceSecret')!.payload).toEqual({ projectId: PID, connId: CID, key: 'token', value: PEM2 });
    await waitFor(() => expect(rail.querySelector('textarea')).toBeNull());
    expect(document.body.innerHTML).not.toContain('secondKEYcanary');
  });
});

describe('the workbench rail', () => {
  it('shows a stored password as Set and replaces it write-only', async () => {
    const calls = serve(
      base({
        'connections:list': { body: [CONN] },
        'connection:listTables': { body: { ok: true, tables: [{ schema: 'public', name: 'orders' }] } },
        'dataset:list': { body: [] },
        'connection:replaceSecret': { body: { ok: true, connection: CONN } },
      }),
    );
    renderApp(`/connections/${PID}/${CID}`);
    const rail = await screen.findByRole('complementary', { name: 'Connection details' });
    expect(within(rail).getByText('Set')).toBeTruthy();
    expect(within(rail).getByText('Nothing imported from this connection yet. Pick a table or run a query, then Save as dataset.')).toBeTruthy();
    fireEvent.click(within(rail).getByRole('button', { name: 'Replace Password' }));
    const input = within(rail).getByLabelText('New password') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'n3w' } });
    fireEvent.click(within(rail).getByRole('button', { name: 'Test & replace' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'connection:replaceSecret')).toBe(true));
    expect(calls.find((c) => c.channel === 'connection:replaceSecret')!.payload).toEqual({ projectId: PID, connId: CID, key: 'password', value: 'n3w' });
    await waitFor(() => expect(within(rail).queryByLabelText('New password')).toBeNull());
    expect(document.body.innerHTML).not.toContain('n3w');
  });

  it('words a 5- or 15-minute schedule, says "Behind schedule", and offers the fast cadences only with incremental refresh', async () => {
    const ds = (id: string, name: string, extra: object) => ({ id, name, rowCount: 10, updatedAt: '2026-10-01T10:00:00Z', originKind: 'connection', originConnId: CID, ...extra });
    const LIVE = ds('33333333-3333-4333-8333-333333333333', 'Live', { autoRefresh: { every: '15min' }, incrementalOn: true, behindSchedule: true });
    const PLAIN = ds('44444444-4444-4444-8444-444444444444', 'Plain', { autoRefresh: { every: 'hourly' } });
    const calls = serve(
      base({
        'connections:list': { body: [CONN] },
        'connection:listTables': { body: { ok: true, tables: [{ schema: 'public', name: 'orders' }] } },
        'dataset:list': { body: [LIVE, PLAIN] },
        'dataset:update': { body: { ok: true } },
      }),
    );
    renderApp(`/connections/${PID}/${CID}`);
    const rail = await screen.findByRole('complementary', { name: 'Connection details' });
    const live = (await within(rail).findByRole('link', { name: 'Live' })).closest('li')!;
    expect(within(live).getByText(/^Refreshes every 15 minutes · last/)).toBeTruthy();
    expect(within(live).getByText('Behind schedule')).toBeTruthy();
    const plain = within(rail).getByRole('link', { name: 'Plain' }).closest('li')!;
    expect(within(plain).queryByText('Behind schedule')).toBeNull();

    fireEvent.click(within(plain).getByRole('combobox', { name: 'Auto-refresh Plain' }));
    const greyed = (await screen.findAllByRole('option')).filter((o) => o.getAttribute('aria-disabled') === 'true').map((o) => o.textContent);
    expect(greyed).toEqual(['Refresh every 5 minutes — needs incremental refresh', 'Refresh every 15 minutes — needs incremental refresh']);
    fireEvent.keyDown(within(plain).getByRole('combobox', { name: 'Auto-refresh Plain' }), { key: 'Escape' });

    fireEvent.click(within(live).getByRole('combobox', { name: 'Auto-refresh Live' }));
    fireEvent.click((await screen.findAllByRole('option')).find((o) => o.textContent === 'Refresh every 5 minutes')!);
    await waitFor(() => expect(calls.some((c) => c.channel === 'dataset:update')).toBe(true));
    expect(calls.find((c) => c.channel === 'dataset:update')!.payload).toEqual({ projectId: PID, datasetId: LIVE.id, autoRefresh: '5min' });
  });

  it('says so when the connection is gone', async () => {
    serve(base());
    renderApp(`/connections/${PID}/${CID}`);
    expect(await screen.findByRole('heading', { name: 'Connection not found' })).toBeTruthy();
  });
});
