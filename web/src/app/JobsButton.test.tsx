import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { encode } from '../../../src/server/wire.ts';
import { resetEventsForTest } from '../api/events';
import { renderApp } from '../test-utils';

/** The one EventSource the tab opens, driven by the test. */
class FakeSource {
  static readonly CLOSED = 2;
  static last: FakeSource | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly handlers = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(ch: string, fn: (e: { data: string }) => void) {
    this.handlers.set(ch, [...(this.handlers.get(ch) ?? []), fn]);
  }
  close() {}
  emit(ch: string, payload: unknown) {
    act(() => {
      for (const fn of this.handlers.get(ch) ?? []) fn({ data: encode(payload) });
    });
  }
}

const NOW = new Date().toISOString();
const job = (over: object) => ({ id: 'j', kind: 'quality', label: 'Quality checks', state: 'done', progress: 1, cancellable: true, createdAt: NOW, ...over });

function stubServer(jobs: unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/me') return Response.json({ user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false });
      const channel = decodeURIComponent(url.replace('/api/rpc/', ''));
      calls.push(channel);
      if (channel === 'jobs:list') return Response.json(jobs);
      if (channel === 'jobs:cancel' || channel === 'jobs:clear') return Response.json({ ok: true });
      return Response.json([]);
    }),
  );
  return calls;
}

beforeEach(() => vi.stubGlobal('EventSource', FakeSource));
afterEach(() => {
  resetEventsForTest();
  vi.unstubAllGlobals();
});

describe('Jobs button', () => {
  it('says how many run and wait, and lists running over recent with their outcome', async () => {
    const calls = stubServer({
      active: [
        job({ id: 'r', state: 'running', progress: 0.42, label: 'Refresh Orders', kind: 'refresh', finishedAt: undefined }),
        job({ id: 'q', state: 'queued', progress: 0, label: 'Export', kind: 'export' }),
      ],
      recent: [
        job({ id: 'd', startedAt: '2026-10-03T10:00:00.000Z', finishedAt: '2026-10-03T10:00:02.300Z', result: { message: '3 rules passed' } }),
        job({ id: 'e', state: 'error', label: 'Import sales.csv', error: 'Not a CSV file.' }),
      ],
    });
    renderApp('/');
    const btn = await screen.findByRole('button', { name: 'Jobs — 1 running, 1 waiting' });
    fireEvent.click(btn);
    const pop = await screen.findByRole('dialog', { name: 'Jobs' });
    const running = within(pop).getByRole('region', { name: 'Running' });
    expect(within(running).getByText('Refresh Orders')).toBeTruthy();
    expect(within(running).getByRole('progressbar', { name: 'Refresh Orders' }).getAttribute('value')).toBe('0.42');
    expect(within(running).getByText('42%')).toBeTruthy();
    expect(within(running).getByText('Waiting for a free slot')).toBeTruthy();
    const recent = within(pop).getByRole('region', { name: 'Recent' });
    expect(within(recent).getByText('3 rules passed')).toBeTruthy();
    expect(within(recent).getByText(/2\.3 s/)).toBeTruthy();
    expect(within(recent).getByText('Not a CSV file.')).toBeTruthy();
    expect(within(recent).getByText('Failed')).toBeTruthy();

    fireEvent.click(within(running).getAllByRole('button', { name: 'Cancel' })[0]!);
    fireEvent.click(within(pop).getByRole('button', { name: 'Clear finished' }));
    await waitFor(() => expect(calls).toEqual(expect.arrayContaining(['jobs:cancel', 'jobs:clear'])));
  });

  it('designs the empty list', async () => {
    stubServer({ active: [], recent: [] });
    renderApp('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Jobs' }));
    expect(await screen.findByRole('heading', { name: 'Nothing running' })).toBeTruthy();
  });

  it('stays live from the stream: a pushed list repaints the button, a completion becomes a toast', async () => {
    stubServer({ active: [], recent: [] });
    renderApp('/');
    await screen.findByRole('button', { name: 'Jobs' });
    const es = FakeSource.last!;
    expect(es.url).toMatch(/^\/api\/events\?client=[0-9a-f-]{36}$/);
    es.emit('jobs:changed', { active: [job({ state: 'running', progress: 0.1 })], recent: [] });
    expect(await screen.findByRole('button', { name: 'Jobs — 1 running' })).toBeTruthy();
    es.emit('jobs:finished', job({}));
    es.emit('jobs:finished', job({ id: 'x', state: 'error', label: 'Import', error: 'Bad file.' }));
    es.emit('jobs:finished', job({ id: 's', silent: true, label: 'Scheduled' }));
    const toasts = screen.getByRole('status', { name: 'Notifications' });
    expect(within(toasts).getByText('Quality checks — done')).toBeTruthy();
    expect(within(toasts).getByText('Import — Bad file.')).toBeTruthy();
    expect(within(toasts).queryByText(/Scheduled/)).toBeNull();
  });
});
