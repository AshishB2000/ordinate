import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ADMIN = { user: { email: 'boss@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true };
const VIEWER = { user: { email: 'pat@acme.test', role: 'viewer' }, org: 'acme', mode: 'oidc', canSignOut: true };

const USERS = [
  { id: 'u1', email: 'boss@acme.test', role: 'admin', pending: false, disabled: false, createdAt: '2026-09-01T10:00:00Z', lastLoginAt: '2026-10-02T10:00:00Z', teams: 1 },
  { id: 'u2', email: 'new@acme.test', role: 'editor', pending: true, disabled: false, createdAt: '2026-10-01T10:00:00Z', lastLoginAt: null, teams: 0 },
  { id: 'u3', email: 'gone@acme.test', role: 'viewer', pending: false, disabled: true, createdAt: '2026-08-01T10:00:00Z', lastLoginAt: '2026-08-02T10:00:00Z', teams: 0 },
];

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });

/** fetch answered per path (/api/auth/me) or RPC channel; records each RPC's payload. */
function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
    const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
    if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
    const r = routes[channel] ?? { body: [] };
    const out = typeof r === 'function' ? r(payload) : r;
    return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
  });
  vi.stubGlobal('fetch', spy);
  return calls;
}

describe('Admin', () => {
  it('tells a non-admin it is for org admins, and hides Admin from the nav', async () => {
    const calls = serve({ '/api/auth/me': { body: VIEWER } });
    renderApp('/admin');
    expect(await screen.findByRole('heading', { name: 'Only organization admins can open Admin' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
    expect(calls.filter((c) => c.channel.startsWith('admin:'))).toEqual([]);
  });

  for (const path of ['/admin', '/tokens']) {
    it(`says so on a server without Postgres (${path}), without calling a channel that would fail`, async () => {
      const calls = serve({ '/api/auth/me': { body: { ...ADMIN, mode: 'dev', canSignOut: false, accounts: false } } });
      renderApp(path);
      expect(await screen.findByRole('heading', { name: 'This server keeps no accounts' })).toBeTruthy();
      expect(calls.filter((c) => c.channel.startsWith('admin:') || c.channel.startsWith('tokens:'))).toEqual([]);
    });
  }

  it('lists people with a skeleton first, their status, and the admin nav entry', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'admin:users': { body: USERS } });
    renderApp('/admin');
    expect(await screen.findByRole('status', { name: 'Loading people' })).toBeTruthy();
    expect(await screen.findByText('new@acme.test')).toBeTruthy();
    const row = (email: string) => screen.getByText(email).closest('tr') as HTMLElement;
    expect(within(row('new@acme.test')).getByText('Invited')).toBeTruthy();
    expect(within(row('gone@acme.test')).getByText('Disabled')).toBeTruthy();
    expect(within(row('boss@acme.test')).getByText('You')).toBeTruthy();
    expect(within(row('new@acme.test')).getByText('Never')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Admin' })).toBeTruthy();
  });

  it('invites by email with a role', async () => {
    const calls = serve({ '/api/auth/me': { body: ADMIN }, 'admin:users': { body: USERS }, 'admin:invite': { body: { ok: true, id: 'u9' } } });
    renderApp('/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Invite people' }));
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'Sam@Acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'admin:invite')).toBe(true));
    expect(calls.find((c) => c.channel === 'admin:invite')?.payload).toEqual({ email: 'Sam@Acme.test', role: 'viewer' });
    expect(await screen.findByText(/Invited sam@acme.test/)).toBeTruthy();
  });

  it('shows a refusal from the server as a toast', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'admin:users': { body: USERS }, 'admin:invite': { body: { ok: false, error: 'exists' } } });
    renderApp('/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Invite people' }));
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'boss@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('That name or address is already taken.')).toBeTruthy();
  });

  it('designs the error state with a retry', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'admin:users': { status: 403, body: { error: 'forbidden' } } });
    renderApp('/admin');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('People could not be loaded');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('designs the empty Teams state, opened from the URL', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'admin:teams': { body: [] } });
    renderApp('/admin?tab=teams');
    expect(await screen.findByRole('heading', { name: 'No teams yet' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Teams', selected: true })).toBeTruthy();
  });

  it('pages the audit log on the server: Older sends the cursor', async () => {
    const page = (ids: number[], next: number | null) => ({
      rows: ids.map((id) => ({ id, at: '2026-10-03T09:00:00Z', actor: 'boss@acme.test', action: 'rpc', channel: 'admin:setRole', projectId: null, targets: ['0f0e0d0c-0000-4000-8000-000000000001'], outcome: 'ok', requestId: `req-${id}` })),
      names: {},
      retentionDays: null,
      next,
      channels: ['admin:setRole'],
    });
    const calls = serve({
      '/api/auth/me': { body: ADMIN },
      'admin:projects': { body: [] },
      'admin:audit': (p) => ({ body: (p as { before?: number }).before ? page([3], null) : page([9, 8], 8) }),
    });
    renderApp('/admin?tab=audit');
    expect(await screen.findByText('req-9')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    expect(await screen.findByText('req-3')).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'admin:audit').map((c) => c.payload)).toEqual([{}, { before: 8 }]);
    expect((screen.getByRole('button', { name: 'Older' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Rows are kept until AUDIT_RETENTION_DAYS is set/)).toBeTruthy();
  });

  it('shows what a call touched by name, and counts the ids that name nothing', async () => {
    const [project, dataset, visual, card] = ['87c88b78-c91c-49c9-abf7-bd9b6cbf422b', '929646dd-e6e0-4f79-a4ad-9fda9c61448d', '196db7a1-0000-4000-8000-000000000002', '48b8668d-0000-4000-8000-000000000003'];
    serve({
      '/api/auth/me': { body: ADMIN },
      'admin:projects': { body: [] },
      'admin:audit': {
        body: {
          rows: [{ id: 1, at: '2026-10-24T13:53:00Z', actor: 'boss@acme.test', action: 'rpc', channel: 'dataset:delete', projectId: project, targets: [project, dataset, visual, card], outcome: 'ok', requestId: 'req-bu' }],
          names: { [project]: { kind: 'project', name: 'Test' }, [dataset]: { kind: 'dataset', name: 'Sales Q3' }, [visual]: { kind: 'visual', name: 'Revenue', trashed: true } },
          retentionDays: 365,
          next: null,
        },
      },
    });
    renderApp('/admin?tab=audit');
    expect(await screen.findByRole('cell', { name: 'Test' })).toBeTruthy(); // the project, from the page's names
    expect(screen.getByText(/Sales Q3/).textContent).toBe('Dataset Sales Q3');
    expect(screen.getByText(/Revenue/).textContent).toBe('Visual Revenue · in Trash');
    expect(screen.getByText('1 other id').getAttribute('title')).toContain(card);
    expect(screen.queryByText(/87c88b78/)).toBeNull(); // the project is its own column, not repeated as an item
    expect(screen.getByText(/Rows are kept for 365 days/)).toBeTruthy();
  });
});

describe('Admin under password sign-in', () => {
  const PW_ADMIN = { ...ADMIN, mode: 'password' };
  const PW_USERS = [USERS[0], { ...USERS[1], mustChangePassword: true }, USERS[2]];

  it('adds a person with a generated temporary password instead of inviting', async () => {
    const calls = serve({ '/api/auth/me': { body: PW_ADMIN }, 'admin:users': { body: PW_USERS }, 'admin:addUser': { body: { ok: true, id: 'u9' } } });
    renderApp('/admin');
    const row = (email: string) => screen.getByText(email).closest('tr') as HTMLElement;
    await screen.findByText('new@acme.test');
    expect(within(row('new@acme.test')).getByText('Temporary password')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invite people' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }));
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'sam@acme.test' } });
    const temp = (screen.getByLabelText('Temporary password') as HTMLInputElement).value;
    expect(temp).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{16}$/);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add person' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'admin:addUser')).toBe(true));
    expect(calls.find((c) => c.channel === 'admin:addUser')?.payload).toEqual({ email: 'sam@acme.test', role: 'viewer', password: temp });
    expect(await screen.findByText(/Added sam@acme.test/)).toBeTruthy();
  });

  it('will not send a temporary password under 10 characters', async () => {
    serve({ '/api/auth/me': { body: PW_ADMIN }, 'admin:users': { body: PW_USERS } });
    renderApp('/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Add person' }));
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'sam@acme.test' } });
    fireEvent.change(screen.getByLabelText('Temporary password'), { target: { value: 'short' } });
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Add person' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("resets someone's password from their row, never your own", async () => {
    const calls = serve({ '/api/auth/me': { body: PW_ADMIN }, 'admin:users': { body: PW_USERS }, 'admin:resetPassword': { body: { ok: true } } });
    renderApp('/admin');
    await screen.findByText('new@acme.test');
    const openActions = async (email: string) => {
      await waitFor(async () => {
        fireEvent.keyDown(await screen.findByRole('button', { name: `Actions for ${email}` }), { key: 'Enter' });
        expect(screen.getByRole('menu')).toBeTruthy();
      });
    };
    await openActions('boss@acme.test');
    expect(screen.queryByRole('menuitem', { name: 'Reset password' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await openActions('new@acme.test');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset password' }));
    const temp = (await screen.findByLabelText('Temporary password') as HTMLInputElement).value;
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'admin:resetPassword')?.payload).toEqual({ userId: 'u2', password: temp }));
    expect(await screen.findByText(/signed out everywhere/)).toBeTruthy();
  });
});

describe('API tokens', () => {
  it('designs the empty state', async () => {
    serve({ '/api/auth/me': { body: VIEWER }, 'tokens:list': { body: { tokens: [], maxDays: 365 } } });
    renderApp('/tokens');
    expect(await screen.findByRole('heading', { name: 'No API tokens' })).toBeTruthy();
  });

  const listed = (tokens: unknown[], maxDays = 365) => ({ body: { tokens, maxDays } });
  const tokenRow = (over: Record<string, unknown>) => ({
    id: 't1', name: 'CLI', prefix: 'ord_abcdefgh', createdAt: '2026-10-03T09:00:00Z', lastUsedAt: null,
    expiresAt: '2027-01-01T09:00:00Z', expired: false, legacy: false, ...over,
  });

  it('offers 30, 90 or 365 days, 90 chosen, and sends the choice', async () => {
    const calls = serve({ '/api/auth/me': { body: VIEWER }, 'tokens:list': listed([]), 'tokens:create': { body: { ok: false, error: 'limit' } } });
    renderApp('/tokens');
    fireEvent.click(await screen.findByRole('button', { name: 'New token' }));
    const picker = await screen.findByRole('combobox', { name: 'Expires after' });
    expect(picker.textContent).toContain('90 days');
    fireEvent.click(picker);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['30 days', '90 days', '1 year']);
    fireEvent.click(options[2]);
    await waitFor(() => expect(picker.textContent).toContain('1 year'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'CI' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'tokens:create')?.payload).toEqual({ name: 'CI', expiresInDays: 365 }));
  });

  it('is a page under Settings: a crumb back, the count after the title, New token once in the header', async () => {
    serve({ '/api/auth/me': { body: VIEWER }, 'tokens:list': listed([tokenRow({}), tokenRow({ id: 't2', name: 'CI' })]) });
    renderApp('/tokens');
    await screen.findByText('2 tokens');
    const header = screen.getByRole('main').querySelector('header')!;
    expect(within(header).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
    expect(within(header).getByRole('heading', { level: 1, name: 'API tokens' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New token' })).toHaveLength(1);
    expect(within(header).getByRole('button', { name: 'New token' })).toBeTruthy();
  });

  it('still offers New token when the list failed to load (C8)', async () => {
    const calls = serve({ '/api/auth/me': { body: VIEWER }, 'tokens:list': { status: 500, body: { error: 'handler failed' } }, 'tokens:create': { body: { ok: false, error: 'limit' } } });
    renderApp('/tokens');
    await screen.findByRole('heading', { name: 'Your tokens could not be loaded' });
    fireEvent.click(screen.getByRole('button', { name: 'New token' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'CI' } });
    expect(screen.getByRole('combobox', { name: 'Expires after' }).textContent).toContain('90 days');
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'tokens:create')?.payload).toEqual({ name: 'CI', expiresInDays: 90 }));
  });

  it("offers nothing past the server's maximum, and the maximum itself", async () => {
    serve({ '/api/auth/me': { body: VIEWER }, 'tokens:list': listed([], 60) });
    renderApp('/tokens');
    fireEvent.click(await screen.findByRole('button', { name: 'New token' }));
    const picker = await screen.findByRole('combobox', { name: 'Expires after' });
    expect(picker.textContent).toContain('60 days');
    fireEvent.click(picker);
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['30 days', '60 days']);
  });

  it("shows each token's end, an expired one, and one made before tokens expired", async () => {
    serve({
      '/api/auth/me': { body: VIEWER },
      'tokens:list': listed([tokenRow({}), tokenRow({ id: 't2', name: 'Old CI', expired: true }), tokenRow({ id: 't3', name: 'Legacy', legacy: true })]),
    });
    renderApp('/tokens');
    const row = (name: string) => screen.getByRole('cell', { name }).closest('tr') as HTMLElement;
    await screen.findByRole('columnheader', { name: 'Expires' });
    expect(within(row('CLI')).getByText(/2027/)).toBeTruthy();
    expect(within(row('Old CI')).getByText('Expired')).toBeTruthy();
    expect(within(row('Legacy')).getByText('Made before tokens expired')).toBeTruthy();
    expect(within(row('CLI')).queryByText('Made before tokens expired')).toBeNull();
  });

  it('shows a new token once, then only its prefix', async () => {
    const TOKEN = 'ord_' + 'a'.repeat(43);
    let tokens: unknown[] = [];
    serve({
      '/api/auth/me': { body: VIEWER },
      'tokens:list': () => ({ body: { tokens, maxDays: 365 } }),
      'tokens:create': () => {
        tokens = [{ id: 't1', name: 'CLI', prefix: TOKEN.slice(0, 12), createdAt: '2026-10-03T09:00:00Z', lastUsedAt: null, expiresAt: '2027-01-01T09:00:00Z', expired: false, legacy: false }];
        return { body: { ok: true, id: 't1', name: 'CLI', prefix: TOKEN.slice(0, 12), createdAt: '2026-10-03T09:00:00Z', expiresAt: '2027-01-01T09:00:00Z', token: TOKEN } };
      },
    });
    renderApp('/tokens');
    fireEvent.click(await screen.findByRole('button', { name: 'New token' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'CLI' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect((await screen.findByTestId('new-token')).textContent).toBe(TOKEN);
    fireEvent.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(await screen.findByText(`${TOKEN.slice(0, 12)}…`)).toBeTruthy();
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
