// Where a mention reaches its person in the web app (docs/notifications/00-design.md
// §5.9-5.12): Home's "Mentioned you" — its loading, error, empty and list states,
// unseen first, Mark all seen, a click that marks seen and opens the thread, and
// nothing at all without a user directory; the notice a `mentions:new` push shows
// on any page, with Open; and Settings → You → "Email me when someone mentions me".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { encode } from '../../../../src/server/wire.ts';
import { resetEventsForTest } from '../../api/events';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { NotificationsGroup } from '../settings/NotificationsGroup';
import { MentionedYou } from './MentionedYou';

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

function home(routes: Record<string, RpcReply>) {
  const calls = serveRpc({ 'projects:overview': { body: [{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] }, ...routes });
  const router = createMemoryRouter([{ path: '/', element: <MentionedYou /> }, { path: '/analyses/:p/:a', element: <p>the dashboard</p> }], { initialEntries: ['/'] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { calls, router };
}

describe('Home: Mentioned you', () => {
  it('loading, then the list: unseen first as the server sends it, the count of new, project and record named', async () => {
    const { calls } = home({ 'mentions:list': { body: { ok: true, available: true, items: [item(C1, false, 'Ann'), item(C2, true, 'Cal')] } } });
    expect(screen.getByLabelText('Loading your mentions')).toBeTruthy();
    const region = await screen.findByRole('region', { name: 'Mentioned you' });
    const cards = await within(region).findAllByRole('button', { name: /mentioned you on Revenue review/ });
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['Ann mentioned you on Revenue review, new: Look @Bea, Ann here', 'Cal mentioned you on Revenue review: Look @Bea, Cal here']);
    expect(within(region).getByText('1 new')).toBeTruthy();
    expect(within(region).getAllByText('Revenue review · Sales').length).toBe(2);
    expect(calls.filter((c) => c.channel === 'mentions:list').length).toBe(1);
  });

  it('a click marks that one seen and opens its thread', async () => {
    const { calls, router } = home({ 'mentions:list': { body: { ok: true, available: true, items: [item(C1, false, 'Ann')] } }, 'mentions:seen': { body: { ok: true } } });
    fireEvent.click(await screen.findByRole('button', { name: /Ann mentioned you/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/analyses/${P}/${A}`));
    expect(router.state.location.search).toBe(`?comment=analysis:${A}`);
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:seen' && JSON.stringify(c.payload) === JSON.stringify({ projectId: P, id: C1 }))).toBe(true));
  });

  it('Mark all seen marks the caller\'s mentions up to the newest one it SHOWED', async () => {
    const { calls } = home({ 'mentions:list': { body: { ok: true, available: true, items: [item(C1, false, 'Ann'), { ...item(C2, false, 'Cal'), at: '2026-10-20T11:00:00Z' }] } }, 'mentions:seen': { body: { ok: true } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all seen' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:seen' && JSON.stringify(c.payload) === JSON.stringify({ through: '2026-10-20T11:00:00Z' }))).toBe(true));
  });

  it('Mark all seen stays offered while the database still has unseen rows, even when none is drawn as new', async () => {
    home({ 'mentions:list': { body: { ok: true, available: true, items: [item(C2, true, 'Cal')], unseen: 3 } }, 'mentions:seen': { body: { ok: true } } });
    expect(await screen.findByRole('button', { name: 'Mark all seen' })).toBeTruthy();
    expect(screen.getByText('3 new')).toBeTruthy();
  });

  it('empty: says what will show up there', async () => {
    home({ 'mentions:list': { body: { ok: true, available: true, items: [] } } });
    expect(await screen.findByRole('heading', { name: 'No mentions yet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark all seen' })).toBeNull();
  });

  it('error: says so, and Retry asks again', async () => {
    const { calls } = home({ 'mentions:list': { status: 500, body: { error: 'boom' } } });
    expect(await screen.findByRole('heading', { name: 'Could not read your mentions' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retry|Try again/ }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'mentions:list').length).toBe(2));
  });

  it('NEGATIVE CONTROL: no user directory → nothing at all', async () => {
    const { calls } = home({ 'mentions:list': { body: { ok: true, available: false, items: [] } } });
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:list')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('region', { name: 'Mentioned you' })).toBeNull();
  });
});

describe('the mention notice', () => {
  it('a mentions:new push shows "<who> mentioned you on <what>" with Open, on any page; Open opens the thread', async () => {
    const calls = serveRpc({
      'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
      'projects:overview': { body: [{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] },
      'mentions:seen': { body: { ok: true } },
    });
    const router = renderApp('/no-such-page'); // the shell mounts the one Toaster
    await screen.findByRole('button', { name: /^Alerts/ }); // the bell, which mounts the listener
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
    await screen.findByRole('button', { name: /^Alerts/ });
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
