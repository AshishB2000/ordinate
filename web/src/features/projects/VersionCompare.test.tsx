import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const ME = { user: { email: 'pat@acme.test', role: 'editor' }, org: 'acme', mode: 'oidc', canSignOut: true, accounts: true };
const P = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const OVERVIEW = [{ id: P, name: 'Alpha', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 1, sample: false }];
const V = [
  { key: '2026-10-03T09-00-00-000Z', savedAt: '2026-10-03T09:00:00.000Z', summary: 'Edited 1 tile', by: 'priya@acme.test', thumb: [] },
  { key: '2026-10-02T09-00-00-000Z', savedAt: '2026-10-02T09:00:00.000Z', summary: 'First saved version', thumb: [] },
];
const tile = (id: string, x: number, status: string) => ({ id, x, y: 0, w: 4, h: 3, type: 'metric', status });
const side = (key: string, by?: string) => ({ key, savedAt: key.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d\d\d)Z/, 'T$1:$2:$3.$4Z'), ...(by ? { by } : {}) });
const DIFF = {
  ok: true,
  from: side(V[1].key),
  to: side(V[0].key, 'priya@acme.test'),
  summary: '20 cards changed, a filter changed',
  counts: { changed: 20, added: 0, removed: 0, moved: 0, filters: 1, other: 0 },
  changes: [
    { group: 'filters', kind: 'filter.removed', text: 'Filter region = East was removed' },
    { group: 'cards', kind: 'card.text', text: 'Notes: text edited', words: [{ op: 'same', text: 'Sales were' }, { op: 'del', text: 'strong' }, { op: 'add', text: 'weak' }] },
    ...Array.from({ length: 19 }, (_, i) => ({ group: 'cards', kind: 'card.measure', text: `KPI ${i + 1}: measure changed from sum(a) to avg(a)` })),
  ],
  sheets: [{ id: 's1', name: 'Overview', changed: true, before: [tile('a', 0, 'changed'), tile('b', 4, 'same')], after: [tile('a', 0, 'changed'), tile('b', 4, 'same')] }],
  figures: 2,
};
const FIGURES = {
  ok: true,
  figures: [
    { cardId: 'a', title: 'Total revenue', reason: 'filters changed', before: { ok: true, value: 1200000, display: '1.2M' }, after: { ok: true, value: 3400000, display: '3.4M' }, moved: true },
    { cardId: 'b', title: 'Orders', reason: 'filters changed', before: { ok: false, code: 'live_timeout', error: 'The warehouse took too long to answer.' }, after: { ok: true, value: 9, display: '9' }, moved: true },
  ],
};

type Reply = { status?: number; body?: unknown } | 'pending';

/** fetch answered per RPC channel; records each RPC's payload. */
function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload: init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined });
      const r = routes[channel] ?? { body: [] };
      if (r === 'pending') return new Promise<Response>(() => {});
      return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

const base = (extra: Record<string, Reply>) => ({
  '/api/auth/me': { body: ME },
  'projects:overview': { body: OVERVIEW },
  'projects:roles': { body: { [P]: 'editor' } },
  'versions:list': { body: V },
  'versions:get': { body: { savedAt: V[0].savedAt, summary: V[0].summary, record: { name: 'Sales' } } },
  ...extra,
});
const at = `/versions/${P}/dashboard/${D}?compare=${V[1].key}`;
const pane = () => screen.getByRole('region', { name: 'Version compare' });

describe('version compare', () => {
  it('holds the shape with a skeleton while the two versions are compared', async () => {
    serve(base({ 'versions:diff': 'pending' }));
    renderApp(at);
    expect(await screen.findByRole('status', { name: 'Comparing the two versions' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Compare from' }).textContent).toContain('v1');
    expect(screen.getByRole('combobox', { name: 'Compare to' }).textContent).toContain('Current');
  });

  it('says when the two versions are the same, and offers no restore', async () => {
    serve(base({ 'versions:diff': { body: { ...DIFF, summary: 'No changes', counts: { changed: 0, added: 0, removed: 0, moved: 0, filters: 0, other: 0 }, changes: [], sheets: [], figures: 0 } } }));
    renderApp(at);
    expect(await screen.findByRole('heading', { name: 'These two versions are the same' })).toBeTruthy();
    expect(within(pane()).queryByRole('button', { name: /^Restore/ })).toBeNull();
  });

  it('shows the server\'s sentence and a retry when a version is gone', async () => {
    const calls = serve(base({ 'versions:diff': { body: { ok: false, error: 'One of these versions is gone — it may have been pruned, or removed with its record.' } } }));
    renderApp(at);
    expect(await screen.findByText(/One of these versions is gone/)).toBeTruthy();
    const before = calls.filter((c) => c.channel === 'versions:diff').length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'versions:diff').length).toBeGreaterThan(before));
  });

  it('lays out many changes: summary, layout pair, figures, grouped sentences with a word diff, then restore with a confirmation', async () => {
    const calls = serve(base({ 'versions:diff': { body: DIFF }, 'versions:figures': { body: FIGURES }, 'versions:restore': { body: { ok: true } } }));
    renderApp(at);
    expect(await screen.findByText('20 cards changed, a filter changed')).toBeTruthy();
    expect(calls.find((c) => c.channel === 'versions:diff')?.payload).toEqual({ projectId: P, type: 'dashboard', id: D, from: V[1].key, to: V[0].key });

    // The layout pair: two thumbnails with their tiles' statuses.
    const layout = screen.getByRole('region', { name: 'Layout' });
    expect(layout.querySelectorAll('rect[data-status="changed"]').length).toBe(2);
    expect(within(layout).getByText('v1')).toBeTruthy();

    // Figures: the server's display strings, and a Live failure in its own words.
    const figs = screen.getByRole('region', { name: 'Figures that moved' });
    expect(await within(figs).findByText('1.2M')).toBeTruthy();
    expect(within(figs).getByText('3.4M')).toBeTruthy();
    expect(within(figs).getByText('The warehouse took too long to answer.')).toBeTruthy();

    // Changes: grouped, the first twelve of a long group, the rest behind a button.
    const cards = screen.getByRole('region', { name: 'Cards' });
    expect(within(cards).getAllByRole('listitem').length).toBe(12);
    fireEvent.click(within(cards).getByRole('button', { name: 'Show 8 more' }));
    expect(within(cards).getAllByRole('listitem').length).toBe(20);
    expect(cards.querySelector('del')?.textContent?.trim()).toBe('strong');
    expect(cards.querySelector('ins')?.textContent?.trim()).toBe('weak');
    expect(within(screen.getByRole('region', { name: 'Filters' })).getByText('Filter region = East was removed')).toBeTruthy();

    // Restore v1: a confirmation that restates the summary, then the existing channel.
    fireEvent.click(within(pane()).getByRole('button', { name: 'Restore v1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore v1?' });
    expect(within(dialog).getByText(/20 cards changed, a filter changed/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore v1' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'versions:restore')).toBe(true));
    expect(calls.find((c) => c.channel === 'versions:restore')?.payload).toEqual({ projectId: P, type: 'dashboard', id: D, key: V[1].key });
  });

  it('opens from the history: pick an older save, then "Compare with current"', async () => {
    const calls = serve(base({ 'versions:diff': { body: DIFF }, 'versions:figures': { body: FIGURES } }));
    renderApp(`/versions/${P}/dashboard/${D}`);
    const list = await screen.findByRole('region', { name: 'Saved versions' });
    fireEvent.click(await within(list).findByRole('button', { pressed: false }));
    fireEvent.click(await screen.findByRole('button', { name: 'Compare with current' }));
    expect(await screen.findByText('20 cards changed, a filter changed')).toBeTruthy();
    expect(calls.find((c) => c.channel === 'versions:diff')?.payload).toEqual({ projectId: P, type: 'dashboard', id: D, from: V[1].key, to: V[0].key });
    // The author is on the row and in the header.
    expect(within(list).getByText('priya@acme.test')).toBeTruthy();
  });
});
