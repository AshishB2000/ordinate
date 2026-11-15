// The conversation list a page at a time (src/ai/copilotRows.ts `listPage`): the Assistant page's
// column and the dock's History show the first page and "Load more" under it while the server has
// older ones, with that page's own loading and error states; the title search says when older
// conversations are not loaded yet.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { forgetPageThread, setDockOpen } from './dockState';

afterEach(() => {
  act(() => {
    setDockOpen(false);
    forgetPageThread();
  });
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const now = new Date().toISOString();
const READY = { ready: true, models: [{ provider: 'anthropic', model: 'm', label: 'M', isDefault: true }], mine: { provider: 'anthropic', model: 'm' }, copilotEnabled: true, keyStore: null };
/** 60 conversations, newest first, as the server orders them. */
const ALL = Array.from({ length: 60 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  title: `Question ${i + 1}`,
  updatedAt: new Date(Date.UTC(2026, 0, 5, 10, 0) - i * 60_000).toISOString(),
  turnCount: 2,
}));
const CURSOR = '1767607080000000.11';

/** Pages of 50 behind `CURSOR`; `second` answers the call for the page after. */
function serve(second: RpcReply = () => ({ body: { ok: true, threads: ALL.slice(50), next: null } })) {
  return serveRpc({
    '/api/auth/me': { body: { user: { email: 'pat@acme.test', role: 'editor' }, org: 'acme', mode: 'oidc', canSignOut: true } },
    'projects:list': { body: [{ id: PID, name: 'Ledger', updatedAt: now, lastOpenedAt: now, archived: false, datasets: 1, dashboards: 0, sample: false }] },
    'projects:overview': { body: [{ id: PID, name: 'Ledger', updatedAt: now, lastOpenedAt: now, archived: false, datasets: 1, dashboards: 0, sample: false }] },
    'projects:roles': { body: { [PID]: 'editor' } },
    'ai:status': { body: READY },
    'dataset:list': { body: [{ id: 'd1', name: 'Retail orders' }] },
    'copilot:history': { body: { ok: true, turns: [], threadId: null, title: null } },
    'copilot:threads': (p) => {
      if ((p as { cursor?: string }).cursor !== CURSOR) return { body: { ok: true, threads: ALL.slice(0, 50), next: CURSOR } };
      return typeof second === 'function' ? second(p) : second;
    },
  });
}

const pageCalls = (calls: { channel: string; payload: unknown }[]) => calls.filter((c) => c.channel === 'copilot:threads').map((c) => (c.payload as { cursor?: string }).cursor ?? null);
const rowsIn = (list: HTMLElement) => within(list).getAllByRole('button').filter((b) => /^Question \d+$/.test(b.textContent ?? '')).map((b) => b.textContent);

describe('the conversation list, a page at a time', () => {
  it('on the Assistant page: the first 50, then "Load more" brings the other 10 in order and goes away', async () => {
    const calls = serve();
    renderApp('/assistant');
    const list = await screen.findByRole('complementary', { name: 'Conversations' });
    await within(list).findByRole('button', { name: 'Question 1' });
    expect(rowsIn(list)).toEqual(ALL.slice(0, 50).map((t) => t.title));
    expect(pageCalls(calls)).toEqual([null]);

    fireEvent.click(within(list).getByRole('button', { name: 'Load more' }));
    await within(list).findByRole('button', { name: 'Question 60' });
    expect(rowsIn(list)).toEqual(ALL.map((t) => t.title)); // no duplicate, no gap, the server's order
    expect(pageCalls(calls)).toEqual([null, CURSOR]);
    expect(within(list).queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('a page that is loading shows rows of its own; one that fails says so under the list and tries again', async () => {
    let tries = 0;
    serve(() => {
      tries += 1;
      return tries === 1 ? { status: 500, body: { error: 'down' } } : { body: { ok: true, threads: ALL.slice(50), next: null } };
    });
    renderApp('/assistant');
    const list = await screen.findByRole('complementary', { name: 'Conversations' });
    fireEvent.click(await within(list).findByRole('button', { name: 'Load more' }));
    expect(await within(list).findByText('More conversations could not load')).toBeTruthy();
    expect(rowsIn(list)).toHaveLength(50); // the loaded page stays
    expect(within(list).queryByText('Conversations could not load')).toBeNull(); // not the whole list's error
    fireEvent.click(within(list).getByRole('button', { name: 'Try again' }));
    await within(list).findByRole('button', { name: 'Question 60' });
    expect(within(list).queryByText('More conversations could not load')).toBeNull();
    expect(tries).toBe(2);
  });

  it('shows the next page’s loading rows while it is on its way', async () => {
    let done: (v: { body: unknown }) => void = () => undefined;
    const late = new Promise<{ body: unknown }>((r) => (done = r));
    serve();
    // The second page answers only when this test says so.
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: Array<{ cursor?: string }> }).args[0] : undefined;
      if (decodeURIComponent(url).includes('copilot:threads') && payload?.cursor === CURSOR) return late.then((r) => new Response(JSON.stringify(r.body)));
      return real(url, init);
    });
    renderApp('/assistant');
    const list = await screen.findByRole('complementary', { name: 'Conversations' });
    fireEvent.click(await within(list).findByRole('button', { name: 'Load more' }));
    expect(await within(list).findByLabelText('Loading more conversations')).toBeTruthy();
    done({ body: { ok: true, threads: ALL.slice(50), next: null } });
    await within(list).findByRole('button', { name: 'Question 60' });
    expect(within(list).queryByLabelText('Loading more conversations')).toBeNull();
  });

  it('a search over the first page says older conversations are not searched until loaded', async () => {
    serve();
    renderApp('/assistant');
    const list = await screen.findByRole('complementary', { name: 'Conversations' });
    await within(list).findByRole('button', { name: 'Question 1' });
    fireEvent.change(within(list).getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'Question 55' } });
    expect(within(list).getByText('Only the ones loaded so far are searched. Load more to search older ones.')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Load more' }));
    expect(await within(list).findByRole('button', { name: 'Question 55' })).toBeTruthy();
  });

  it('in the dock’s History too: "Load more" inside the popover, and its search says the same', async () => {
    const calls = serve();
    renderApp('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
    await screen.findByRole('textbox', { name: 'Ask the Assistant' });
    const dock = document.getElementById('dock-panel') as HTMLElement;
    const clock = within(dock).getByRole('button', { name: 'Conversation history' }) as HTMLButtonElement;
    await waitFor(() => expect(clock.disabled).toBe(false)); // once the dock knows its project
    fireEvent.click(clock);
    const history = await screen.findByRole('dialog', { name: 'Conversation history' });
    await waitFor(() => expect(within(history).getAllByTestId('history-row')).toHaveLength(50));
    fireEvent.change(within(history).getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'Question 58' } });
    expect(within(history).getByText('None of these match. Load more to search older ones.')).toBeTruthy();
    fireEvent.click(within(history).getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(history).getAllByTestId('history-row').map((r) => r.textContent)).toEqual(['Question 582 turns']));
    expect(pageCalls(calls)).toEqual([null, CURSOR]);
    expect(within(history).queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
