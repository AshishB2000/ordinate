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
  });
});

describe('API tokens', () => {
  it('designs the empty state', async () => {
    serve({ '/api/auth/me': { body: VIEWER }, 'tokens:list': { body: [] } });
    renderApp('/tokens');
    expect(await screen.findByRole('heading', { name: 'No API tokens' })).toBeTruthy();
  });

  it('shows a new token once, then only its prefix', async () => {
    const TOKEN = 'ord_' + 'a'.repeat(43);
    let listed: unknown[] = [];
    serve({
      '/api/auth/me': { body: VIEWER },
      'tokens:list': () => ({ body: listed }),
      'tokens:create': () => {
        listed = [{ id: 't1', name: 'CLI', prefix: TOKEN.slice(0, 12), createdAt: '2026-10-03T09:00:00Z', lastUsedAt: null }];
        return { body: { ok: true, id: 't1', name: 'CLI', prefix: TOKEN.slice(0, 12), createdAt: '2026-10-03T09:00:00Z', token: TOKEN } };
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
