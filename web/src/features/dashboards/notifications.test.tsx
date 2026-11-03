// Where a mention reaches its person in the web app (docs/notifications/00-design.md
// §5.9-5.12): the bell's "Mentioned you" — its badge from /api/auth/me, its loading,
// error, empty and list states, unseen first, Mark all seen over both parts, a click
// that marks seen and opens the thread, the bell with no project, and mentions never
// read without a user directory; the notice a `mentions:new` push shows
// on any page, with Open; and Settings → You → "Email me when someone mentions me".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { encode } from '../../../../src/server/wire.ts';
import { resetEventsForTest } from '../../api/events';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { NotificationsGroup } from '../settings/NotificationsGroup';

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const A = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const C1 = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const C2 = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const item = (id: string, seen: boolean, by: string) => ({
  projectId: P, id, commentId: id, target: { kind: 'analysis', id: A }, on: { name: 'Revenue review' }, by, snippet: `Look @Bea, ${by} here`, at: '2026-10-20T10:00:00Z', seen,
});

class FakeSource {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly handlers = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(ch: string, fn: (e: { data: string }) => void) {
    this.handlers.set(ch, [...(this.handlers.get(ch) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  emit(ch: string, payload: unknown) {
    for (const fn of this.handlers.get(ch) ?? []) fn({ data: encode(payload) });
  }
}

beforeEach(() => {
  FakeSource.all = [];
  vi.stubGlobal('EventSource', FakeSource);
});
afterEach(() => {
  cleanup();
  resetEventsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The bell is on every page: closed, its badge is the count /api/auth/me carries,
// with no mentions:list. Opened, it lists the caller's mentions over every project.
const ME = (mentionsUnseen: number | null) => ({ user: { email: 'bea@acme.test', role: 'viewer' }, org: 'acme', mode: 'header', canSignOut: false, mentionsUnseen });
const OVERVIEW = [{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }];
const NO_ALERTS = { ok: true, digest: false, unseen: 0, rules: [], events: [] };
const RULE = '4b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const FIRED = {
  ok: true, digest: false, unseen: 1,
  rules: [{ id: RULE, name: 'Revenue drop', datasetId: A, metric: { column: 'revenue', aggregation: 'sum' }, compare: 'threshold', enabled: true, threshold: { op: '<', value: 10 } }],
  events: [{ id: 'e1', ruleId: RULE, ruleName: 'Revenue drop', datasetId: A, message: 'Revenue fell to 8.', at: '2026-10-21T09:00:00Z', value: 8, seen: false }],
};

function shell(routes: Record<string, RpcReply>, unseen: number | null = 1) {
  const calls = serveRpc({
    '/api/auth/me': { body: ME(unseen) },
    'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
    'projects:overview': { body: OVERVIEW },
    'projects:roles': { body: { [P]: 'viewer' } },
    'alerts:list': { body: NO_ALERTS },
    ...routes,
  });
  const router = renderApp('/no-such-page');
  return { calls, router };
}

async function openBell(name: RegExp | string = /^Notifications/) {
  const bell = await screen.findByRole('button', { name });
  await waitFor(() => expect(bell.hasAttribute('disabled')).toBe(false));
  fireEvent.click(bell);
  return screen.findByRole('dialog', { name: 'Notifications' });
}

describe('the bell: Mentioned you', () => {
  it('closed, the badge is /api/auth/me\'s count and nothing reads the list; opened, the list unseen first, project and record named', async () => {
    const { calls } = shell({ 'mentions:list': { body: { ok: true, available: true, items: [item(C1, false, 'Ann'), item(C2, true, 'Cal')], unseen: 1 } } });
    const bell = await screen.findByRole('button', { name: 'Notifications: 1 unseen' });
    expect(bell.textContent).toBe('1');
    expect(calls.some((c) => c.channel === 'mentions:list')).toBe(false);
    const inbox = await openBell();
    const rows = await within(inbox).findAllByRole('button', { name: /mentioned you on Revenue review/ });
    expect(rows.map((c) => c.getAttribute('aria-label'))).toEqual(['Ann mentioned you on Revenue review, new: Look @Bea, Ann here', 'Cal mentioned you on Revenue review: Look @Bea, Cal here']);
    expect(within(inbox).getByRole('heading', { name: 'Mentioned you · all projects' })).toBeTruthy();
    expect(within(inbox).getAllByText('Revenue review · Sales').length).toBe(2);
    expect(calls.filter((c) => c.channel === 'mentions:list').length).toBe(1);
  }, 30_000);

  it('a click marks that one seen, opens its thread and closes the bell', async () => {
    const { calls, router } = shell({ 'mentions:list': { body: { ok: true, available: true, items: [item(C1, false, 'Ann')], unseen: 1 } }, 'mentions:seen': { body: { ok: true } } });
    const inbox = await openBell();
    fireEvent.click(await within(inbox).findByRole('button', { name: /Ann mentioned you/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/analyses/${P}/${A}`));
    expect(router.state.location.search).toBe(`?comment=analysis:${A}`);
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:seen' && JSON.stringify(c.payload) === JSON.stringify({ projectId: P, id: C1 }))).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull());
  }, 30_000);

  it('the badge adds the two server counts, and Mark all seen clears both: mentions up to the newest shown, alerts up to the newest shown', async () => {
    const { calls } = shell(
      {
        'mentions:list': { body: { ok: true, available: true, items: [item(C1, false, 'Ann'), { ...item(C2, false, 'Cal'), at: '2026-10-20T11:00:00Z' }], unseen: 2 } },
        'alerts:list': { body: FIRED },
        'mentions:seen': { body: { ok: true } },
        'alerts:markSeen': { body: { ok: true } },
      },
      2,
    );
    const inbox = await openBell('Notifications: 2 unseen');
    await within(inbox).findByText('Revenue fell to 8.');
    expect(within(inbox).getByRole('heading', { name: 'Alerts · Sales' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Notifications: 3 unseen' })).toBeTruthy();
    fireEvent.click(within(inbox).getByRole('button', { name: 'Mark all seen' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:seen' && JSON.stringify(c.payload) === JSON.stringify({ through: '2026-10-20T11:00:00Z' }))).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.channel === 'alerts:markSeen' && JSON.stringify(c.payload) === JSON.stringify({ projectId: P, through: '2026-10-21T09:00:00Z' }))).toBe(true));
  }, 30_000);

  it('empty: one state for both parts, saying what will show up there', async () => {
    shell({ 'mentions:list': { body: { ok: true, available: true, items: [], unseen: 0 } } }, 0);
    const inbox = await openBell('Notifications');
    expect(await within(inbox).findByRole('heading', { name: 'Nothing here yet' })).toBeTruthy();
    expect(within(inbox).getByText(/or an alert fires in this project/)).toBeTruthy();
    expect(within(inbox).queryByRole('button', { name: 'Mark all seen' })).toBeNull();
  }, 30_000);

  it('no project: the bell still opens for mentions, with no alerts part and no rules', async () => {
    const { calls } = shell({ 'projects:list': { body: [] }, 'projects:overview': { body: [] }, 'mentions:list': { body: { ok: true, available: true, items: [], unseen: 0 } } }, 0);
    const inbox = await openBell('Notifications');
    expect(await within(inbox).findByText('When someone mentions you in a comment, it shows up here.')).toBeTruthy();
    expect(within(inbox).queryByRole('button', { name: /Rules|Manage rules/ })).toBeNull();
    expect(calls.some((c) => c.channel === 'alerts:list')).toBe(false);
  }, 30_000);

  it('error: says so, and Retry asks again', async () => {
    const { calls } = shell({ 'mentions:list': { status: 500, body: { error: 'boom' } } });
    const inbox = await openBell();
    expect(await within(inbox).findByRole('heading', { name: 'Could not read your mentions' })).toBeTruthy();
    fireEvent.click(within(inbox).getByRole('button', { name: /Retry|Try again/ }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'mentions:list').length).toBe(2));
  }, 30_000);

  it('NEGATIVE CONTROL: no user directory (/api/auth/me carries null) → the bell is the project\'s alerts alone, and never reads mentions', async () => {
    const { calls } = shell({}, null);
    const inbox = await openBell('Notifications');
    expect(await within(inbox).findByRole('heading', { name: 'No alerts yet' })).toBeTruthy();
    expect(calls.some((c) => c.channel === 'mentions:list')).toBe(false);
  }, 30_000);
});

describe('the mention notice', () => {
  it('a mentions:new push shows "<who> mentioned you on <what>" with Open, on any page; Open opens the thread', async () => {
    const calls = serveRpc({
      'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
      'projects:overview': { body: [{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] },
      'mentions:seen': { body: { ok: true } },
    });
    const router = renderApp('/no-such-page'); // the shell mounts the one Toaster
    await screen.findByRole('button', { name: /^Notifications/ }); // the bell, which mounts the listener
    await waitFor(() => expect(FakeSource.all.length).toBeGreaterThan(0));
    act(() => FakeSource.all.forEach((s) => s.emit('mentions:new', { projectId: P, id: C1, commentId: C1, target: { kind: 'analysis', id: A }, by: 'Ann Lee', on: 'Revenue review' })));
    const notice = await screen.findByText('Ann Lee mentioned you on Revenue review');
    fireEvent.click(within(notice.parentElement as HTMLElement).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/analyses/${P}/${A}`));
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:seen')).toBe(true));
  }, 30_000);

  it('NEGATIVE CONTROL: a push naming no project shows nothing', async () => {
    serveRpc({ 'projects:list': { body: [] } });
    renderApp('/no-such-page');
    await screen.findByRole('button', { name: /^Notifications/ });
    await waitFor(() => expect(FakeSource.all.length).toBeGreaterThan(0));
    act(() => FakeSource.all.forEach((s) => s.emit('mentions:new', { by: 'Ann', on: 'x', target: { kind: 'analysis', id: A } })));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/mentioned you/)).toBeNull();
  }, 30_000);
});

describe('Settings → You → Notifications', () => {
  const mountPrefs = (prefs: object, extra: Record<string, RpcReply> = {}) => {
    const calls = serveRpc({ 'mentions:prefs': { body: { ok: true, ...prefs } }, 'mentions:setPrefs': { body: { ok: true } }, ...extra });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NotificationsGroup />
      </QueryClientProvider>,
    );
    return calls;
  };

  it('the switch reads the setting and saves a change', async () => {
    const calls = mountPrefs({ available: true, mail: true, emailMe: true });
    const sw = (await screen.findByRole('switch', { name: 'Email me when someone mentions me' })) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:setPrefs' && (c.payload as { emailMe: boolean }).emailMe === false)).toBe(true));
  });

  it('a server that sends no email: the switch is off and disabled, and says why', async () => {
    mountPrefs({ available: true, mail: false, emailMe: true });
    const sw = (await screen.findByRole('switch', { name: 'Email me when someone mentions me' })) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByText(/does not send email/)).toBeTruthy();
  });

  it('NEGATIVE CONTROL: no user directory → no Notifications group', async () => {
    const calls = mountPrefs({ available: false, mail: false, emailMe: false });
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:prefs')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Notifications')).toBeNull();
  });
});
