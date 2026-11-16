// Where a viewer's "Ask an editor" reaches an editor (docs/assistant/00-design.md, phase G): the
// bell's "Asked for data" — their name, the question, the reason in the server's words and their
// note, unseen first — a click that marks it seen and opens where it is fixed (Connections, or the
// Data model's Relationships for a link), Mark all seen over it; the toast an `asks:new` push shows
// with Open; and Settings → You → "Email me about data asks and dashboard requests".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { encode } from '../../../../src/server/wire.ts';
import { resetEventsForTest } from '../../api/events';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { NotificationsGroup } from '../settings/NotificationsGroup';

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const Q1 = '5b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const Q2 = '6b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const ask = (id: string, seen: boolean, reason: 'missing' | 'link', at = '2026-10-20T10:00:00Z') => ({
  projectId: P, id, by: 'Priya Shah', question: 'Returns by reason last month', reason, at, seen,
  why: reason === 'link' ? 'These can’t be combined yet.' : 'This data isn’t in Ordinate yet.', note: 'For the Q4 review',
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

const ME = (mentionsUnseen: number) => ({ user: { email: 'ed@acme.test', role: 'viewer' }, org: 'acme', mode: 'header', canSignOut: false, mentionsUnseen });
function shell(routes: Record<string, RpcReply>, unseen = 1) {
  const calls = serveRpc({
    '/api/auth/me': { body: ME(unseen) },
    'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
    'projects:overview': { body: [{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] },
    'projects:roles': { body: { [P]: 'editor' } },
    'alerts:list': { body: { ok: true, digest: false, unseen: 0, rules: [], events: [] } },
    'mentions:seen': { body: { ok: true } },
    ...routes,
  });
  return { calls, router: renderApp('/no-such-page') };
}
async function openBell(name: RegExp | string = /^Notifications/) {
  const bell = await screen.findByRole('button', { name });
  await waitFor(() => expect(bell.hasAttribute('disabled')).toBe(false));
  fireEvent.click(bell);
  return screen.findByRole('dialog', { name: 'Notifications' });
}
const list = (asks: unknown[], unseen: number) => ({ 'mentions:list': { body: { ok: true, available: true, items: [], asks, unseen } } });

describe('the bell: Asked for data', () => {
  it('lists each ask by name, with the question, the reason in the server\'s words, the note and the project; unseen first', async () => {
    shell(list([ask(Q1, false, 'missing'), ask(Q2, true, 'link')], 1));
    const inbox = await openBell('Notifications: 1 unseen');
    expect(await within(inbox).findByRole('heading', { name: 'Asked for data · projects you edit' })).toBeTruthy();
    const rows = within(inbox).getAllByTestId('bell-ask');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Priya Shah asked for data, new: Returns by reason last month. Opens Connections',
      'Priya Shah asked for data: Returns by reason last month. Opens Relationships',
    ]);
    expect(within(rows[0]).getByText('For the Q4 review')).toBeTruthy();
    expect(within(rows[0]).getByText('This data isn’t in Ordinate yet. · Sales')).toBeTruthy();
    expect(within(rows[1]).getByText('These can’t be combined yet. · Sales')).toBeTruthy();
    // The empty state is not shown when there are asks alone.
    expect(within(inbox).queryByRole('heading', { name: 'Nothing here yet' })).toBeNull();
  }, 30_000);

  it('a click marks it seen and opens Connections for missing data', async () => {
    const { calls, router } = shell(list([ask(Q1, false, 'missing')], 1));
    const inbox = await openBell();
    fireEvent.click(await within(inbox).findByTestId('bell-ask'));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/connections/${P}`));
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:seen' && JSON.stringify(c.payload) === JSON.stringify({ projectId: P, id: Q1 }))).toBe(true));
  }, 30_000);

  it('…and the Data model\'s Relationships for a link', async () => {
    const { router } = shell(list([ask(Q2, false, 'link')], 1));
    const inbox = await openBell();
    fireEvent.click(await within(inbox).findByTestId('bell-ask'));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/model/${P}`));
    expect(router.state.location.search).toBe('?tab=relationships');
  }, 30_000);

  it('Mark all seen covers the asks: up to the newest one shown', async () => {
    const { calls } = shell(list([ask(Q1, false, 'missing'), ask(Q2, false, 'link', '2026-10-21T08:00:00Z')], 2), 2);
    const inbox = await openBell('Notifications: 2 unseen');
    await within(inbox).findAllByTestId('bell-ask');
    fireEvent.click(within(inbox).getByRole('button', { name: 'Mark all seen' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:seen' && JSON.stringify(c.payload) === JSON.stringify({ through: '2026-10-21T08:00:00Z' }))).toBe(true));
  }, 30_000);
});

describe('the ask notice', () => {
  it('an asks:new push says who asked in which project, with Open, which marks it seen and opens where it is fixed', async () => {
    const { calls, router } = shell({}, 0);
    await screen.findByRole('button', { name: /^Notifications/ });
    await waitFor(() => expect(FakeSource.all.length).toBeGreaterThan(0));
    act(() => FakeSource.all.forEach((s) => s.emit('asks:new', { projectId: P, id: Q1, by: 'Priya Shah', on: 'Sales', reason: 'link' })));
    const notice = await screen.findByText('Priya Shah asked the editors of Sales for data');
    fireEvent.click(within(notice.parentElement as HTMLElement).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/model/${P}`));
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:seen' && JSON.stringify(c.payload) === JSON.stringify({ projectId: P, id: Q1 }))).toBe(true));
  }, 30_000);

  it('NEGATIVE CONTROL: a push with a reason off the list shows nothing', async () => {
    shell({}, 0);
    await screen.findByRole('button', { name: /^Notifications/ });
    await waitFor(() => expect(FakeSource.all.length).toBeGreaterThan(0));
    act(() => FakeSource.all.forEach((s) => s.emit('asks:new', { projectId: P, id: Q1, by: 'Priya', on: 'Sales', reason: 'anything' })));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/asked the editors/)).toBeNull();
  }, 30_000);
});

describe('Settings → You → "Email me about data asks and dashboard requests"', () => {
  const mount = (prefs: object) => {
    const calls = serveRpc({ 'mentions:prefs': { body: { ok: true, ...prefs } }, 'mentions:setPrefs': { body: { ok: true } } });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NotificationsGroup />
      </QueryClientProvider>,
    );
    return calls;
  };

  it('reads off by default and saves its own switch, never the mention one', async () => {
    const calls = mount({ available: true, mail: true, emailMe: true, requestEmail: false });
    const sw = (await screen.findByRole('switch', { name: 'Email me about data asks and dashboard requests' })) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.channel === 'mentions:setPrefs')?.payload).toEqual({ requestEmail: true }));
    expect(((await screen.findByRole('switch', { name: 'Email me when someone mentions me' })) as HTMLInputElement).checked).toBe(true);
  });

  it('a server that sends no email: off and disabled, saying the bell still has it', async () => {
    mount({ available: true, mail: false, emailMe: true, requestEmail: true });
    const sw = (await screen.findByRole('switch', { name: 'Email me about data asks and dashboard requests' })) as HTMLInputElement;
    expect(sw.disabled && !sw.checked).toBe(true);
    expect(screen.getByText(/asks and dashboard requests still reach you in the bell/)).toBeTruthy();
  });
});
