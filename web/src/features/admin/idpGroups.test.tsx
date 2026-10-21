import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';

// Admin → People → Identity provider groups, and what a managed role or a
// linked team hides (docs/sso-lifecycle/00-design.md §3.15).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ADMIN = { user: { email: 'boss@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true };
const USERS = [
  { id: 'u1', email: 'boss@acme.test', role: 'admin', pending: false, disabled: false, createdAt: '2026-09-01T10:00:00Z', lastLoginAt: '2026-10-02T10:00:00Z', teams: 0 },
  { id: 'u2', email: 'carol@acme.test', role: 'editor', pending: false, disabled: false, createdAt: '2026-10-01T10:00:00Z', lastLoginAt: '2026-10-02T10:00:00Z', teams: 1 },
];
const TEAMS = [
  { id: 't1', name: 'Analysts', createdAt: '2026-09-01T10:00:00Z', members: [{ id: 'u2', email: 'carol@acme.test' }] },
  { id: 't2', name: 'Finance', createdAt: '2026-09-01T10:00:00Z', members: [] },
];
const MAP = [{ group: 'bi-editors', role: 'editor', teamId: 't1', teamName: 'Analysts' }];
const groups = (over: Record<string, unknown> = {}) => ({ mode: 'oidc', source: 'oidc', from: 'groups', roleManaged: true, groups: MAP, linkedTeamIds: ['t1'], ...over });

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });

function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
    const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
    if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
    const r = routes[channel] ?? { body: [] };
    const out = typeof r === 'function' ? r(payload) : r;
    return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
  }));
  return calls;
}

const base = (idp: Reply) => ({ '/api/auth/me': { body: ADMIN }, 'admin:users': { body: USERS }, 'admin:teams': { body: TEAMS }, 'admin:idpGroups': idp });
const row = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

describe('People: roles from the identity provider', () => {
  it('shows "From your identity provider" instead of the role picker for a managed role', async () => {
    serve(base({ body: groups() }));
    renderApp('/admin');
    await screen.findByText('carol@acme.test');
    await waitFor(() => expect(within(row('carol@acme.test')).getByText('From your identity provider')).toBeTruthy());
    expect(within(row('carol@acme.test')).getByText('Editor')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Role of carol@acme.test' })).toBeNull();
  });

  it('NEGATIVE CONTROL: with no group mapping a role, the role picker is there', async () => {
    serve(base({ body: groups({ roleManaged: false }) }));
    renderApp('/admin');
    expect(await screen.findByRole('combobox', { name: 'Role of carol@acme.test' })).toBeTruthy();
    expect(screen.queryByText('From your identity provider')).toBeNull();
  });

  it('invites without asking for a role when roles are managed', async () => {
    const calls = serve({ ...base({ body: groups() }), 'admin:invite': { body: { ok: true, id: 'u9' } } });
    renderApp('/admin');
    await waitFor(() => expect(within(row('carol@acme.test')).getByText('From your identity provider')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Invite people' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Role')).toBeNull();
    expect(within(dialog).getByText(/Their role comes from your identity provider groups/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'sam@acme.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'admin:invite')?.payload).toEqual({ email: 'sam@acme.test', role: 'viewer' }));
  });

  it('does not ask for groups under password sign-in', async () => {
    const calls = serve({ ...base({ body: groups() }), '/api/auth/me': { body: { ...ADMIN, mode: 'password' } } });
    renderApp('/admin');
    await screen.findByText('carol@acme.test');
    expect(screen.queryByRole('heading', { name: 'Identity provider groups' })).toBeNull();
    expect(calls.some((c) => c.channel === 'admin:idpGroups')).toBe(false);
  });
});

describe('Identity provider groups panel', () => {
  it('draws a skeleton while it loads, then the map', async () => {
    serve(base({ body: groups() }));
    renderApp('/admin');
    expect(await screen.findByRole('status', { name: 'Loading identity provider groups' })).toBeTruthy();
    expect(await screen.findByText('bi-editors')).toBeTruthy();
    expect(within(row('bi-editors')).getByText('Analysts')).toBeTruthy();
    expect(screen.getByText(/Read from the groups claim of each sign-in/)).toBeTruthy();
  });

  it('says how to turn it on while the server reads no groups (dormant)', async () => {
    serve(base({ body: groups({ source: null, from: null, roleManaged: false, groups: [], linkedTeamIds: [] }) }));
    renderApp('/admin');
    expect(await screen.findByRole('heading', { name: 'Groups are not read from your identity provider' })).toBeTruthy();
    expect(screen.getByText(/Set OIDC_GROUPS_CLAIM/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Map a group' })).toBeNull();
  });

  it('designs the empty state, with the action', async () => {
    serve(base({ body: groups({ groups: [], roleManaged: false, linkedTeamIds: [] }) }));
    renderApp('/admin');
    expect(await screen.findByRole('heading', { name: 'No groups mapped yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Map a group' })).toBeTruthy();
  });

  it('designs the error state, with a retry', async () => {
    serve(base({ status: 500, body: { error: 'handler failed' } }));
    renderApp('/admin');
    expect(await screen.findByRole('heading', { name: 'Identity provider groups could not be loaded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try again|Retry/ })).toBeTruthy();
  });

  it('maps a group to a role and a team', async () => {
    const calls = serve({ ...base({ body: groups({ groups: [], roleManaged: false, linkedTeamIds: [] }) }), 'admin:setIdpGroup': { body: { ok: true } } });
    renderApp('/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Map a group' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Group'), { target: { value: ' bi-admins ' } });
    expect(within(dialog).getByText(/map your admins/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Role' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Admin' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'admin:setIdpGroup')?.payload).toEqual({ group: 'bi-admins', role: 'admin', teamId: null }));
  });
});

describe('Teams linked to a group', () => {
  it('shows the source and no member picker on a linked team', async () => {
    serve(base({ body: groups() }));
    renderApp('/admin?tab=teams');
    await waitFor(() => expect(within(row('Analysts')).getByText('From your identity provider')).toBeTruthy());
    fireEvent.keyDown(within(row('Analysts')).getByRole('button', { name: 'Actions for Analysts' }), { key: 'Enter' });
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'Members…' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Rename…' })).toBeTruthy();
  });

  it('NEGATIVE CONTROL: a manual team keeps its member picker', async () => {
    serve(base({ body: groups() }));
    renderApp('/admin?tab=teams');
    await waitFor(() => expect(within(row('Analysts')).getByText('From your identity provider')).toBeTruthy());
    expect(within(row('Finance')).queryByText('From your identity provider')).toBeNull();
    fireEvent.keyDown(within(row('Finance')).getByRole('button', { name: 'Actions for Finance' }), { key: 'Enter' });
    expect(await screen.findByRole('menuitem', { name: 'Members…' })).toBeTruthy();
  });
});
