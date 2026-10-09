import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { encode } from '../../../../src/server/wire.ts';
import { resetEventsForTest } from '../../api/events';
import { renderApp } from '../../test-utils';
import { limitMessage } from './liveLimitNotice';
import type { LiveUsage } from './api';

afterEach(() => {
  resetEventsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ADMIN = { user: { email: 'boss@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true };

const USAGE: LiveUsage = {
  today: '2026-10-09',
  limit: 2000,
  todayQueries: 1240,
  todayRefused: 0,
  usedLabel: '62%',
  perPod: false,
  days: 30,
  rows: [
    { day: '2026-10-09', connectionId: 'c1', projectId: 'p1', queries: 1180, bytes: 3_650_722_201, refused: 0, connection: 'Orders warehouse', connector: 'Google BigQuery', project: 'Sales', bytesLabel: '3.4 GB' },
    { day: '2026-10-09', connectionId: 'c2', projectId: 'p1', queries: 60, bytes: null, refused: 0, connection: 'Finance', connector: 'Snowflake', project: 'Sales', bytesLabel: null },
    { day: '2026-10-08', connectionId: 'c3', projectId: 'p2', queries: 12, bytes: 1024, refused: 0, connection: null, connector: null, project: null, bytesLabel: '1.0 KB' },
  ],
};

type Reply = { status?: number; body?: unknown };

/** fetch answered per path (/api/auth/me) or RPC channel; counts each RPC. */
function serve(routes: Record<string, Reply>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      calls.push(channel);
      const r = routes[channel] ?? { body: [] };
      return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

describe('Admin → Live usage', () => {
  it('shows a skeleton, then today against the limit and a row per day and connection, as the server labelled them', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'admin:liveUsage': { body: USAGE } });
    renderApp('/admin?tab=live');
    expect(await screen.findByRole('status', { name: 'Loading live usage' })).toBeTruthy();
    expect(await screen.findByText('Orders warehouse')).toBeTruthy();
    expect(screen.getByText((1240).toLocaleString())).toBeTruthy();
    expect(screen.getByText(/of 2,000 live warehouse queries/)).toBeTruthy();
    const meter = screen.getByRole('meter');
    expect([meter.getAttribute('value'), meter.getAttribute('max')]).toEqual(['1240', '2000']);
    expect(screen.getByText(/^62% of the daily limit/)).toBeTruthy();
    const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
    expect(within(row('Orders warehouse')).getByText('3.4 GB')).toBeTruthy();
    expect(within(row('Orders warehouse')).getByText('Google BigQuery')).toBeTruthy();
    expect(within(row('Orders warehouse')).getByText('Today')).toBeTruthy();
    expect(within(row('Finance')).getByText('Not reported')).toBeTruthy();
    expect(within(row('Deleted connection')).getByText('Deleted project')).toBeTruthy();
    expect(within(row('Deleted connection')).queryByText('Today')).toBeNull();
    // A UTC day stays that day, whatever the browser's zone.
    expect(within(row('Deleted connection')).getByText(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(Date.UTC(2026, 9, 8)))).toBeTruthy();
    expect(screen.queryByText('Today’s limit was reached')).toBeNull();
  });

  it('says when the limit was reached today, and when the counts are this server’s alone', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'admin:liveUsage': { body: { ...USAGE, todayQueries: 2000, todayRefused: 37, usedLabel: '100%', perPod: true } } });
    renderApp('/admin?tab=live');
    expect(await screen.findByText('Today’s limit was reached')).toBeTruthy();
    expect(screen.getByText(/37 questions were answered from the cache/)).toBeTruthy();
    expect(screen.getByText(/Counted by this server since it started/)).toBeTruthy();
  });

  it('has a designed empty state, and says when there is no limit', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'admin:liveUsage': { body: { ...USAGE, limit: 0, todayQueries: 0, usedLabel: null, rows: [] } } });
    renderApp('/admin?tab=live');
    expect(await screen.findByRole('heading', { name: 'No live queries in the last 30 days' })).toBeTruthy();
    expect(screen.getByText(/No daily limit/)).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('has a designed error state with a retry', async () => {
    const calls = serve({ '/api/auth/me': { body: ADMIN }, 'admin:liveUsage': { status: 500, body: { error: 'handler failed' } } });
    renderApp('/admin?tab=live');
    expect(await screen.findByRole('heading', { name: 'Live usage could not be loaded' })).toBeTruthy();
    const before = calls.filter((c) => c === 'admin:liveUsage').length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => expect(calls.filter((c) => c === 'admin:liveUsage').length).toBe(before + 1));
  });

  it('a `live:daily-limit` push toasts the admin, wherever they are, with a way to the usage', async () => {
    const sources: { emit: (ch: string, p: unknown) => void }[] = [];
    class FakeSource {
      static readonly CLOSED = 2;
      readyState = 0;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private readonly handlers = new Map<string, ((e: { data: string }) => void)[]>();
      constructor() {
        sources.push(this);
      }
      addEventListener(ch: string, fn: (e: { data: string }) => void) {
        this.handlers.set(ch, [...(this.handlers.get(ch) ?? []), fn]);
      }
      close() {}
      emit(ch: string, payload: unknown) {
        for (const fn of this.handlers.get(ch) ?? []) fn({ data: encode(payload) });
      }
    }
    vi.stubGlobal('EventSource', FakeSource);
    serve({ '/api/auth/me': { body: ADMIN }, 'admin:liveUsage': { body: USAGE } });
    const router = renderApp('/settings');
    await vi.waitFor(() => expect(sources.length).toBe(1));
    act(() => sources[0].emit('live:daily-limit', { day: '2026-10-09', limit: 10000 }));
    expect(await screen.findByText(limitMessage({ limit: 10000 }))).toBeTruthy();
    expect(limitMessage({ limit: 10000 })).toContain((10000).toLocaleString());
    fireEvent.click(screen.getByRole('button', { name: 'See usage' }));
    await vi.waitFor(() => expect(router.state.location.search).toBe('?tab=live'));
    expect(router.state.location.pathname).toBe('/admin');
  });
});
