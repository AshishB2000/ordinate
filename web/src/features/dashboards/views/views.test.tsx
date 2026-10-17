// Saved views in the open dashboard (docs/dashboard-filters/00-design.md): the
// view a dashboard opens on reaches the FIRST tiles request (no second round),
// a `?view=` change under the open editor applies that view without a remount,
// a viewer lists and applies views and copies a link — nothing that writes
// (NEGATIVE CONTROL: an editor gets the write items) — and every edit goes to
// `analysis:view` with the state on screen, its refusal shown in the server's
// words.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from '../../../ui/Toast';
import type { Analysis, SavedView, ViewState } from '../../analyses/api';
import { Editor } from '../../analyses/editor/Editor';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '11111111-1111-4111-8111-111111111111';
const A = '33333333-3333-4333-8333-333333333333';
const D = '22222222-2222-4222-8222-222222222222';
const S1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CTRL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const KPI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const V1 = '77777777-7777-4777-8777-777777777771';
const V2 = '77777777-7777-4777-8777-777777777772';
const V3 = '77777777-7777-4777-8777-777777777773';

const state = (region: string): ViewState => ({ page: S1, controls: { [CTRL]: { value: region } }, params: {}, selection: [], tiles: {}, groupTabs: {}, asOf: null });
const view = (id: string, name: string, region: string): SavedView => ({ id, name, state: state(region), createdAt: '', updatedAt: '' });
const VIEWS = [view(V1, 'East', 'East'), view(V2, 'West', 'West')];
const ANALYSIS: Analysis = {
  id: A,
  projectId: P,
  name: 'Board',
  sheets: [
    {
      id: S1,
      name: 'One',
      cards: [
        { id: CTRL, type: 'control', layout: { x: 0, y: 0, w: 3, h: 1 }, control: { kind: 'dropdown', label: 'Region', datasetId: D, column: 'region' } },
        { id: KPI, type: 'metric', layout: { x: 0, y: 1, w: 3, h: 2 }, metric: { datasetId: D, column: 'amount', aggregation: 'sum', label: 'Total' } },
      ],
    },
  ],
  filters: [],
  style: {},
  parameters: [],
  views: VIEWS,
  defaultViewId: V2,
  updatedAt: '2026-10-01T10:00:00Z',
};

type Call = { channel: string; input: Record<string, unknown> };

function serve(viewReply: (input: Record<string, unknown>) => unknown = () => ({ ok: false, error: 'unused' })) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const channel = decodeURIComponent(String(url).split('?')[0].replace('/api/rpc/', ''));
      const input = init?.body ? ((JSON.parse(String(init.body)) as { args?: Record<string, unknown>[] }).args?.[0] ?? {}) : {};
      calls.push({ channel, input });
      const reply = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (channel === 'analysis:tiles') return reply((input.items as unknown[]).map(() => ({ ok: true, value: 7, display: '7' })));
      if (channel === 'dataset:distinct') return reply({ values: ['East', 'West', 'North'], total: 3 });
      if (channel === 'analysis:view') return reply(viewReply(input));
      if (channel === 'projects:roles') return reply({ [P]: 'admin' });
      return reply(null);
    }),
  );
  return calls;
}

function open(search: string, readOnly = false) {
  const router = createMemoryRouter([{ path: '/analyses/:projectId/:analysisId', element: <Editor projectId={P} analysis={ANALYSIS} visuals={[]} readOnly={readOnly} /> }], {
    initialEntries: [`/analyses/${P}/${A}${search}`],
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return router;
}

const tiles = (calls: Call[]) => calls.filter((c) => c.channel === 'analysis:tiles');
const regionOf = (c: Call) => JSON.stringify(c.input.items).match(/"column":"region","op":"=","value":"(\w+)"/)?.[1] ?? null;
const settle = () => act(() => new Promise((r) => setTimeout(r, 300)));

/** The Views menu, opened as Radix opens it (a pointer press). It is named by its trigger. */
async function openMenu() {
  fireEvent.pointerDown(await screen.findByRole('button', { name: /^Views/ }), { button: 0, ctrlKey: false });
  return screen.findByRole('menu', { name: /^Views/ });
}

describe('saved views in the open dashboard', { timeout: 30_000 }, () => {
  it('?view=V1: the FIRST tiles request already carries V1’s pick — one call', async () => {
    const calls = serve();
    open(`?view=${V1}`);
    await waitFor(() => expect(tiles(calls).length).toBeGreaterThan(0));
    await settle();
    expect(tiles(calls)).toHaveLength(1);
    expect(regionOf(tiles(calls)[0])).toBe('East');
    expect(screen.getByRole('button', { name: 'Views: East' })).toBeTruthy();
  });

  it('a view id that names no view opens on the default view', async () => {
    const calls = serve();
    open('?view=77777777-7777-4777-8777-000000000000');
    await waitFor(() => expect(tiles(calls).length).toBeGreaterThan(0));
    expect(regionOf(tiles(calls)[0])).toBe('West');
  });

  it('?view=V2 under the open dashboard applies V2 — the same editor, not a remount', async () => {
    const calls = serve();
    const router = open(`?view=${V1}`);
    await waitFor(() => expect(tiles(calls).length).toBeGreaterThan(0));
    const head = screen.getByRole('heading', { level: 1 });
    await act(() => router.navigate(`/analyses/${P}/${A}?view=${V2}`));
    await waitFor(() => expect(regionOf(tiles(calls).at(-1)!)).toBe('West'));
    expect(screen.getByRole('heading', { level: 1 })).toBe(head);
    expect(screen.getByRole('button', { name: 'Views: West' })).toBeTruthy();
  });

  it('a viewer lists and applies the views and copies a link — nothing that writes', async () => {
    serve();
    const router = open('', true);
    const menu = await openMenu();
    expect(within(menu).getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['As authored', 'East', 'West (default)']);
    expect(within(menu).getAllByRole('menuitem').map((r) => r.textContent)).toEqual(['Copy link']);
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'East' }));
    await waitFor(() => expect(router.state.location.search).toBe(`?view=${V1}`));
  });

  it('NEGATIVE CONTROL: an editor gets the write items, on the view on screen', async () => {
    serve();
    open(`?view=${V1}`);
    const menu = await openMenu();
    expect(within(menu).getAllByRole('menuitem').map((r) => r.textContent)).toEqual(['Save as a new view…', 'Update “East”', 'Rename…', 'Set as default', 'Delete…', 'Copy link']);
  });

  it('Save as a new view sends the state on screen, and names the new view in the address', async () => {
    const calls = serve(() => ({ ok: true, views: [...VIEWS, view(V3, 'North', 'East')], defaultViewId: V2, viewId: V3 }));
    const router = open(`?view=${V1}`);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Save as a new view…' }));
    const dlg = await screen.findByRole('dialog', { name: 'Save as a new view' });
    fireEvent.change(within(dlg).getByLabelText('Name'), { target: { value: 'North' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(router.state.location.search).toBe(`?view=${V3}`));
    expect(calls.filter((c) => c.channel === 'analysis:view').map((c) => c.input)).toEqual([{ projectId: P, id: A, op: { op: 'create', name: 'North', state: state('East') } }]);
    expect(screen.getByRole('button', { name: 'Views: North' })).toBeTruthy();
  });

  it('a refusal is a toast in the server’s words, and nothing changes', async () => {
    serve(() => ({ ok: false, error: 'There is already a view called “East”.' }));
    const router = open(`?view=${V1}`);
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Rename…' }));
    const dlg = await screen.findByRole('dialog', { name: 'Rename view' });
    fireEvent.change(within(dlg).getByLabelText('Name'), { target: { value: 'east' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await within(screen.getByRole('status', { name: 'Notifications' })).findByText('There is already a view called “East”.');
    expect(router.state.location.search).toBe(`?view=${V1}`);
    expect(screen.getByRole('button', { name: 'Views: East' })).toBeTruthy();
  });

  it('deleting the view on screen clears it, and ?view with it', async () => {
    const calls = serve(() => ({ ok: true, views: [VIEWS[1]], defaultViewId: V2, viewId: V1 }));
    const router = open(`?view=${V1}`);
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Delete…' }));
    const dlg = await screen.findByRole('dialog', { name: 'Delete “East”?' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(calls.filter((c) => c.channel === 'analysis:view').map((c) => c.input.op)).toEqual([{ op: 'delete', viewId: V1 }]);
    expect(screen.getByRole('button', { name: 'Views' })).toBeTruthy();
  });
});
