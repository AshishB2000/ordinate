import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { fmtDay, fmtOpened } from './api';
import { restoredLine } from './trashToast';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const ME = { user: { email: 'pat@acme.test', role: 'editor' }, org: 'acme', mode: 'oidc', canSignOut: true, accounts: true };
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const row = (id: string, name: string, extra: object = {}) => ({
  id,
  name,
  updatedAt: '2026-10-01T10:00:00Z',
  lastOpenedAt: null,
  archived: false,
  datasets: 1,
  dashboards: 0,
  sample: false,
  ...extra,
});
const OVERVIEW = [
  row(A, 'Alpha', { lastOpenedAt: '2026-10-03T09:00:00Z', datasets: 2, sample: true }),
  row(B, 'Beta', { lastOpenedAt: '2026-10-02T09:00:00Z' }),
  row(C, 'Cold storage', { archived: true }),
];

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });

/** fetch answered per path or RPC channel; records each RPC's payload. */
function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload: init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined });
      const r = routes[channel] ?? { body: [] };
      const out = typeof r === 'function' ? r(calls.at(-1)?.payload) : r;
      return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
    }),
  );
  return calls;
}

const base = (roles: Record<string, string>) => ({ '/api/auth/me': { body: ME }, 'projects:overview': { body: OVERVIEW }, 'projects:roles': { body: roles } });
const switcher = () => screen.getByTestId('project-switcher');

describe('current project', () => {
  it('is the most recently opened live project by default', async () => {
    serve(base({ [A]: 'admin' }));
    renderApp('/');
    await waitFor(() => expect(switcher().textContent).toContain('Alpha'));
  });

  it('honours ?project= over what this browser last chose, and ignores an archived one', async () => {
    localStorage.setItem('ordinate.project', A);
    serve(base({}));
    renderApp(`/?project=${B}`);
    await waitFor(() => expect(switcher().textContent).toContain('Beta'));
  });

  it('falls through an archived or unknown stored choice', async () => {
    localStorage.setItem('ordinate.project', C);
    serve(base({}));
    renderApp('/');
    await waitFor(() => expect(switcher().textContent).toContain('Alpha'));
  });
});

describe('project switcher', () => {
  it('lists live projects with their counts, folds archived ones, and switches in place', async () => {
    const calls = serve({ ...base({ [A]: 'admin', [B]: 'viewer' }), 'projects:open': { body: row(B, 'Beta') } });
    renderApp('/');
    await waitFor(() => expect(switcher().textContent).toContain('Alpha'));
    fireEvent.click(switcher());
    const pop = await screen.findByRole('dialog', { name: 'Projects' });
    const rows = within(pop).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Beta')]);
    expect(rows[0].textContent).toContain('2 datasets · 0 dashboards');
    expect(within(rows[0]).getByText('Sample')).toBeTruthy();
    expect(within(rows[0]).getByRole('button', { name: /^Alpha.*opened/ }).getAttribute('aria-current')).toBe('true');
    fireEvent.click(within(pop).getByRole('button', { name: 'Archived (1)' }));
    expect(within(pop).getByText('Cold storage')).toBeTruthy();
    fireEvent.click(within(rows[1]).getByRole('button', { name: /^Beta.*opened/ }));
    await waitFor(() => expect(switcher().textContent).toContain('Beta'));
    expect(localStorage.getItem('ordinate.project')).toBe(B);
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:open')).toBe(true));
    expect(calls.find((c) => c.channel === 'projects:open')?.payload).toEqual({ id: B });
  });

  it('offers each row only what the caller\'s role allows', async () => {
    serve(base({ [A]: 'admin', [B]: 'viewer' }));
    renderApp('/');
    await waitFor(() => expect(switcher().textContent).toContain('Alpha'));
    fireEvent.click(switcher());
    const pop = await screen.findByRole('dialog', { name: 'Projects' });
    fireEvent.keyDown(within(pop).getByRole('button', { name: 'Alpha options' }), { key: 'Enter' });
    const admin = await screen.findByRole('menu', { name: 'Alpha options' });
    expect(within(admin).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Rename', 'Share…', 'Export project', 'Archive', 'Delete…']);
    fireEvent.keyDown(admin, { key: 'Escape' });
    fireEvent.keyDown(within(pop).getByRole('button', { name: 'Beta options' }), { key: 'Enter' });
    const viewer = await screen.findByRole('menu', { name: 'Beta options' });
    expect(within(viewer).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Who has access', 'Export project']);
  });

  it('creates a project from its name and switches to it', async () => {
    const D = '44444444-4444-4444-8444-444444444444';
    let made = false;
    const calls = serve({
      ...base({ [A]: 'admin' }),
      'projects:overview': () => ({ body: made ? [...OVERVIEW, row(D, 'Delta', { lastOpenedAt: '2026-10-03T10:00:00Z' })] : OVERVIEW }),
      'projects:create': () => ((made = true), { body: row(D, 'Delta') }),
    });
    renderApp('/');
    await waitFor(() => expect(switcher().textContent).toContain('Alpha'));
    fireEvent.click(switcher());
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(await screen.findByLabelText('Project name'), { target: { value: '  Delta ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(switcher().textContent).toContain('Delta'));
    expect(calls.find((c) => c.channel === 'projects:create')?.payload).toEqual({ name: 'Delta' });
    expect(await screen.findByText('Created “Delta”.')).toBeTruthy();
  });

  it('deletes only once the name is typed back', async () => {
    const calls = serve({ ...base({ [A]: 'admin' }), 'projects:delete': { body: { ok: true } } });
    renderApp('/');
    await waitFor(() => expect(switcher().textContent).toContain('Alpha'));
    fireEvent.click(switcher());
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Alpha options' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Alpha?' });
    const go = within(dialog).getByRole('button', { name: 'Delete project' });
    expect(go.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Type “Alpha” to confirm'), { target: { value: 'Alpha' } });
    fireEvent.click(go);
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:delete')).toBe(true));
    expect(calls.find((c) => c.channel === 'projects:delete')?.payload).toEqual({ id: A });
  });

  it('shares: lists grants, adds a person with a role, removes one (project admin)', async () => {
    const calls = serve({
      ...base({ [A]: 'admin' }),
      'project:access': {
        body: [
          { kind: 'team', id: 't1', label: 'Analysts', role: 'admin', owner: true },
          { kind: 'user', id: 'u2', label: 'sam@acme.test', role: 'viewer', owner: false },
        ],
      },
      'project:shareTargets': { body: { users: [{ id: 'u2', email: 'sam@acme.test' }, { id: 'u3', email: 'kim@acme.test' }], teams: [{ id: 't1', name: 'Analysts' }] } },
      'project:share': { body: { ok: true } },
    });
    renderApp('/');
    await waitFor(() => expect(switcher().textContent).toContain('Alpha'));
    fireEvent.click(switcher());
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Alpha options' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Alpha' });
    expect(await within(dialog).findByText('Owner · Admin')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove sam@acme.test' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'project:share')).toBe(true));
    expect(calls.find((c) => c.channel === 'project:share')?.payload).toEqual({ projectId: A, member: { userId: 'u2' }, role: null });
  });
});

describe('Trash', () => {
  const ITEMS = [
    { type: 'dataset', id: 'd1', name: 'Orders', deletedAt: '2026-10-01T10:00:00Z', daysLeft: 28 },
    { type: 'visual', id: 'v1', name: 'By region', deletedAt: '2026-10-01T10:00:00Z', deletedWith: 'd1', daysLeft: 2 },
  ];

  it('lists what was deleted, with what it went with and the server\'s days left', async () => {
    serve({ ...base({ [A]: 'editor' }), 'trash:list': { body: ITEMS } });
    renderApp('/trash');
    expect(await screen.findByText('By region')).toBeTruthy();
    expect(screen.getByText('Deleted with “Orders”')).toBeTruthy();
    expect(screen.getByText('2 days left')).toBeTruthy();
    expect(screen.getByText('2 items')).toBeTruthy();
    // An editor restores; deleting for good is the project admin's.
    expect(screen.getAllByRole('button', { name: /^Restore / })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /permanently/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Empty trash' })).toBeNull();
  });

  it('restores and says what came back', async () => {
    const calls = serve({
      ...base({ [A]: 'admin' }),
      'trash:list': { body: ITEMS },
      'trash:restore': { body: { ok: true, restored: [{ type: 'dataset', id: 'd1', name: 'Orders' }, { type: 'visual', id: 'v1', name: 'By region' }] } },
    });
    renderApp('/trash');
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Orders' }));
    expect(await screen.findByText('Restored “Orders” and 1 visual deleted with it')).toBeTruthy();
    expect(calls.find((c) => c.channel === 'trash:restore')?.payload).toEqual({ projectId: A, type: 'dataset', id: 'd1' });
  });

  it('deletes permanently after a confirmation (admin)', async () => {
    const calls = serve({ ...base({ [A]: 'admin' }), 'trash:list': { body: ITEMS }, 'trash:purge': { body: { ok: true } } });
    renderApp('/trash');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete By region permanently' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete “By region” permanently?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'trash:purge')).toBe(true));
    expect(calls.find((c) => c.channel === 'trash:purge')?.payload).toEqual({ projectId: A, type: 'visual', id: 'v1' });
  });

  it('has a designed empty state, and one for no project at all', async () => {
    serve({ ...base({ [A]: 'admin' }), 'trash:list': { body: [] } });
    renderApp('/trash');
    expect(await screen.findByRole('heading', { name: 'Trash is empty' })).toBeTruthy();
  });

  it('says so when there is no project to hold a Trash', async () => {
    serve({ ...base({}), 'projects:overview': { body: [] } });
    renderApp('/trash');
    expect(await screen.findByRole('heading', { name: 'No project open' })).toBeTruthy();
  });

  it('words what a restore brought back', () => {
    expect(restoredLine([{ type: 'visual', id: 'v', name: 'Chart' }, { type: 'dataset', id: 'd', name: 'Orders' }])).toBe(
      'Restored “Chart” — and its dataset “Orders”, which was in Trash too',
    );
    expect(restoredLine([{ type: 'metric', id: 'm', name: 'MRR' }])).toBe('Restored “MRR”');
  });
});

describe('Version history', () => {
  const V = [
    { key: '2026-10-03T10-00-00-000Z', savedAt: '2026-10-03T10:00:00.000Z', summary: 'Renamed to Revenue' },
    { key: '2026-10-02T10-00-00-000Z', savedAt: '2026-10-02T10:00:00.000Z', summary: 'First saved version' },
  ];
  const path = `/versions/${A}/visual/${B}`;
  const versions = (payload: unknown) => {
    const key = (payload as { key: string }).key;
    return { body: { savedAt: '', summary: '', record: { name: key === V[0].key ? 'Revenue' : 'Sales', chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } } };
  };

  it('lists saves, previews an older one read-only, and restores it', async () => {
    const calls = serve({ ...base({ [A]: 'editor' }), 'versions:list': { body: V }, 'versions:get': versions, 'versions:restore': { body: { ok: true } } });
    renderApp(path);
    expect(await screen.findByRole('heading', { level: 1, name: 'Revenue — version history' })).toBeTruthy();
    expect(screen.getByText('The current version')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /First saved version/ }));
    expect(await screen.findByText(/^Viewing version from/)).toBeTruthy();
    expect(await screen.findByText('Sales')).toBeTruthy();
    expect(screen.getByText('sum(amount)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'versions:restore')).toBe(true));
    expect(calls.find((c) => c.channel === 'versions:restore')?.payload).toEqual({ projectId: A, type: 'visual', id: B, key: V[1].key });
    expect(await screen.findByText(/^Restored the version from/)).toBeTruthy();
  });

  it('offers no Restore to a viewer, and has a designed empty state', async () => {
    serve({ ...base({ [A]: 'viewer' }), 'versions:list': { body: V }, 'versions:get': versions });
    renderApp(path);
    fireEvent.click(await screen.findByRole('button', { name: /First saved version/ }));
    expect(await screen.findByRole('button', { name: 'Back to current' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('shows "no saved versions yet" for a record with no history', async () => {
    serve({ ...base({ [A]: 'admin' }), 'versions:list': { body: [] } });
    renderApp(path);
    expect(await screen.findByRole('heading', { name: 'No saved versions yet' })).toBeTruthy();
  });
});

describe('formatting', () => {
  it('words "last opened" and day headings', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(fmtOpened(null, now)).toBe('never opened');
    expect(fmtOpened('2026-10-03T11:59:30Z', now)).toBe('opened just now');
    expect(fmtOpened('2026-10-03T10:00:00Z', now)).toBe('opened 2h ago');
    expect(fmtOpened('2026-10-01T12:00:00Z', now)).toBe('opened 2d ago');
    expect(fmtDay('2026-10-03T08:00:00', new Date('2026-10-03T20:00:00'))).toBe('Today');
    expect(fmtDay('2026-10-02T08:00:00', new Date('2026-10-03T20:00:00'))).toBe('Yesterday');
  });
});
