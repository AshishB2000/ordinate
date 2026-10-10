import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RefreshUrlDialog } from './RefreshUrl';
import { intervalText, snippets } from './refreshUrls';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const TOKEN = 'ordh_' + 'A'.repeat(43);
const ACTIVE = { id: '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', prefix: 'ordh_Abc12345', createdBy: 'carol@acme.test', createdAt: '2026-10-09T08:00:00Z', lastUsedAt: null, lastResult: null, lastFinishedAt: null, revokedAt: null };
const REVOKED = { ...ACTIVE, id: '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', prefix: 'ordh_Zyx98765', revokedAt: '2026-10-09T09:00:00Z' };

type Reply = { status?: number; body?: unknown };

/** fetch answered per RPC channel (a function: per call); records each call's payload. */
function serve(routes: Record<string, Reply | (() => Reply)>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const channel = decodeURIComponent(url.split('?')[0].slice('/api/rpc/'.length));
    calls.push({ channel, payload: init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined });
    const r = routes[channel];
    const reply = typeof r === 'function' ? r() : (r ?? { body: null });
    return new Response(JSON.stringify(reply.body ?? { error: 'forbidden' }), { status: reply.status ?? 200 });
  }));
  return calls;
}

function open(live = false, connId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RefreshUrlDialog projectId={P} target={connId ? { connId } : { datasetId: D }} name={connId ? 'Warehouse' : 'Orders'} live={live} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('Refresh URL panel', () => {
  it('empty → make one: the URL is shown once, the list reloads, no token in the examples', async () => {
    let made = false;
    const calls = serve({
      'refreshHook:list': () => ({ body: { available: true, minIntervalSec: 60, hooks: made ? [ACTIVE] : [] } }),
      'refreshHook:create': () => ((made = true), { body: { ok: true, hook: ACTIVE, token: TOKEN } }),
    });
    open();
    expect(await screen.findByText('No refresh URLs yet')).toBeTruthy();
    expect(screen.getByText(/refreshes “Orders” from its source/)).toBeTruthy();
    expect(screen.getByText(/at most once a minute/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New refresh URL' }));
    const url = await screen.findByTestId('new-refresh-url');
    expect(url.textContent).toBe(`${window.location.origin}/api/hooks/refresh/${TOKEN}`);
    expect(calls.find((c) => c.channel === 'refreshHook:create')?.payload).toEqual({ projectId: P, datasetId: D });
    expect(await screen.findByText('ordh_Abc12345…')).toBeTruthy();
    expect(screen.getByText(/never called/)).toBeTruthy();
    // The examples read the URL from a secret; the token is on screen once, in the callout.
    expect(document.body.textContent?.split(TOKEN).length).toBe(2);
  });

  it('lists active and revoked URLs; revoke asks first, then calls with the id', async () => {
    const calls = serve({
      'refreshHook:list': { body: { available: true, minIntervalSec: 60, hooks: [ACTIVE, REVOKED] } },
      'refreshHook:revoke': { body: { ok: true } },
    });
    open();
    expect(await screen.findByText('ordh_Zyx98765…')).toBeTruthy();
    expect(screen.getByText('Revoked')).toBeTruthy();
    expect(screen.getByText('URLs · 1 active')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke ordh_Zyx98765' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke ordh_Abc12345' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke this refresh URL?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke URL' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'refreshHook:revoke')?.payload).toEqual({ projectId: P, id: ACTIVE.id }));
  });

  it('a server without a database says so, and offers nothing to make', async () => {
    serve({ 'refreshHook:list': { body: { available: false, minIntervalSec: 60, hooks: [] } } });
    open();
    expect(await screen.findByText('Refresh URLs need the server’s database')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New refresh URL' })).toBeNull();
  });

  it('a project viewer gets the designed editors-only state, not an error', async () => {
    serve({ 'refreshHook:list': { status: 403, body: { error: 'forbidden' } } });
    open();
    expect(await screen.findByText('Editors only')).toBeTruthy();
  });

  it('a Live dataset: the URL resets the cache', async () => {
    serve({ 'refreshHook:list': { body: { available: true, minIntervalSec: 90, hooks: [] } } });
    open(true);
    expect(await screen.findByText(/resets the cache of “Orders”/)).toBeTruthy();
    expect(screen.getByText(/at most once every 90 seconds/)).toBeTruthy();
  });

  it('a connection: one URL for every dataset that came from it — listed and made by the connection\'s id', async () => {
    const calls = serve({
      'refreshHook:list': { body: { available: true, minIntervalSec: 60, hooks: [] } },
      'refreshHook:create': { body: { ok: true, hook: ACTIVE, token: TOKEN } },
    });
    open(false, D);
    expect(await screen.findByText(/refreshes every dataset that came from “Warehouse”/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Refresh URL · Warehouse' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New refresh URL' }));
    await screen.findByTestId('new-refresh-url');
    expect(calls.find((c) => c.channel === 'refreshHook:list')?.payload).toEqual({ projectId: P, connId: D });
    expect(calls.find((c) => c.channel === 'refreshHook:create')?.payload).toEqual({ projectId: P, connId: D });
  });

  it('each row says how its last call ended: never called, refreshing, refreshed, failed, joined — a revoked one nothing', async () => {
    const called = { lastUsedAt: '2026-10-09T08:30:00Z' };
    const row = (n: number, more: object) => ({ ...ACTIVE, id: `${n}b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b`, prefix: `ordh_Row${n}0000`, ...more });
    serve({
      'refreshHook:list': {
        body: {
          available: true, minIntervalSec: 60,
          hooks: [
            row(3, called), // called by a release that kept no outcome: nothing to say
            row(4, {}),
            row(5, { ...called, lastResult: 'running' }),
            row(6, { ...called, lastResult: 'ok', lastFinishedAt: '2026-10-09T08:31:00Z' }),
            row(7, { ...called, lastResult: 'failed', lastFinishedAt: '2026-10-09T08:31:00Z' }),
            row(8, { ...called, lastResult: 'already_running', lastFinishedAt: '2026-10-09T08:30:00Z' }),
            row(9, { ...called, lastResult: 'failed', revokedAt: '2026-10-09T09:00:00Z' }),
          ],
        },
      },
    });
    open();
    const badges = async (n: number) => {
      const main = (await screen.findByText(`ordh_Row${n}0000…`)).parentElement!; // the prefix and its badges
      return [...main.querySelectorAll(':scope > span')].map((b) => b.textContent);
    };
    expect(await badges(3)).toEqual(['Active']);
    expect(await badges(4)).toEqual(['Active']);
    expect(await badges(5)).toEqual(['Active', 'Refreshing']);
    expect(await badges(6)).toEqual(['Active', 'Refreshed']);
    expect(await badges(7)).toEqual(['Active', 'Refresh failed']);
    expect(await badges(8)).toEqual(['Active', 'Joined a refresh']);
    expect(await badges(9)).toEqual(['Revoked']);
    expect(screen.getByText(/A GET of the same URL says how that call ended/)).toBeTruthy();
  });

  it('the examples: curl retries a 429, dbt calls it after the build, Airflow is an HttpOperator task', () => {
    const s = snippets('Orders 2026');
    // Waiting for the refresh: a GET of the same URL — `"running"` in quotes, so `already_running` is not mistaken for it.
    expect(s.curl).toContain('s=$(curl -fsS --retry 3 "$ORDINATE_REFRESH_URL") || exit 1');
    expect(s.curl).toContain(`*'"running"'*) sleep 10 ;;`);
    expect(s.airflow).toContain('refresh_orders_2026_landed = HttpSensor(');
    expect(s.airflow).toContain('load_tables >> refresh_orders_2026 >> refresh_orders_2026_landed');
    expect(s.curl).toContain('curl -fsS --retry 3 -X POST "$ORDINATE_REFRESH_URL"');
    expect(s.dbt).toContain('dbt build && curl');
    expect(s.airflow).toContain('HttpOperator(');
    expect(s.airflow).toContain('task_id="refresh_orders_2026"');
    expect(s.airflow).toContain('{{ var.value.ordinate_refresh_token }}');
    expect(intervalText(60)).toBe('once a minute');
    expect(intervalText(300)).toBe('once every 5 minutes');
  });
});
