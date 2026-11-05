import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { useVerifiedChips } from './api';
import { setDockOpen, takePendingSpec } from './dockState';

afterEach(() => {
  cleanup();
  act(() => {
    setDockOpen(false);
    takePendingSpec();
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const PID = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';
const NOW = new Date().toISOString();
const SPEC = { datasetId: 'd1', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Revenue by region' };
const ROW = { id: 'v1', question: 'Revenue by region', phrasings: [], datasetId: 'd1', datasetName: 'Orders', describe: '', filters: [], spec: SPEC, verifiedBy: 'a', verifiedAt: NOW, runs: true, tag: 't' };
const NO_MODEL = { ready: false, reason: 'no_model', models: [], mine: null, copilotEnabled: true, keyStore: null };

type Out = { status?: number; body?: unknown };
type Reply = Out | ((payload: unknown) => Out | Promise<Out>);
function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
    const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
    if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
    const r = routes[channel] ?? { body: [] };
    const out = await (typeof r === 'function' ? r(payload) : r);
    return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
  }));
  return calls;
}
const base = (questions: unknown[], extra: Record<string, Reply> = {}): Record<string, Reply> => ({
  '/api/auth/me': { body: { user: { email: 'boss@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true } },
  'projects:list': { body: [{ id: PID, name: 'Ledger', createdAt: NOW, updatedAt: NOW }] },
  'ai:status': { body: NO_MODEL },
  'copilot:history': { body: { ok: true, turns: [], threadId: THREAD } },
  'dataset:list': { body: [{ id: 'd1', name: 'Orders' }] },
  'projects:roles': { body: { [PID]: 'admin' } },
  'verified:list': { body: { ok: true, broken: 0, questions } },
  'answer:rerun': { body: { ok: true, turns: [], threadId: THREAD } },
  'projects:overview': { body: [{ id: PID, name: 'Ledger', updatedAt: NOW, lastOpenedAt: null, archived: false, datasets: 0, dashboards: 0, sample: false }] },
  'recent:list': { body: [] },
  'starred:get': { body: [] },
  'onboarding:status': { body: { show: false, collapsed: false, steps: [], doneCount: 0, total: 0 } },
  'numbers:get': { body: { ok: true, tiles: [], suggestions: [], choices: [] } },
  'jobs:list': { body: { active: [], recent: [] } },
  'prefs:get': { body: { formats: {}, branding: { accent: '' } } },
  'home:overview': { body: { counts: { datasets: 1, dashboards: 0, captures: 0, visuals: 0 }, datasets: [{ id: 'd1', name: 'Orders', rowCount: 3, columnCount: 2 }] } },
  ...extra,
});

async function openDock() {
  fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
  await screen.findByRole('textbox', { name: 'Ask the Assistant' });
  return document.getElementById('dock-panel') as HTMLElement;
}

describe('verified chips in the dock, with no model', () => {
  it('the composer is usable, a chip re-asks its spec on the shown thread, and a typed question gets the connect hint with its text kept', async () => {
    const calls = serve(base([ROW], { 'copilot:ask': { body: { ok: false, notReady: true } } }));
    renderApp('/');
    const dock = await openDock();
    const box = within(dock).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.placeholder).toBe('Ask a verified question, or connect a model to ask anything else.');
    fireEvent.click(await within(dock).findByRole('button', { name: '✓ Revenue by region' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'answer:rerun')?.payload).toEqual({ projectId: PID, threadId: THREAD, spec: SPEC, label: 'Revenue by region' }));
    fireEvent.change(box, { target: { value: 'revenue by state' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await within(dock).findByText('Connect a model to ask anything else.')).toBeTruthy();
    expect(box.value).toBe('revenue by state');
  });

  it('NEGATIVE CONTROL: with no verified question the composer is disabled and the notice is the setup one', async () => {
    serve(base([]));
    renderApp('/');
    const dock = await openDock();
    expect(await within(dock).findByText(/AI isn’t set up yet/)).toBeTruthy();
    expect((within(dock).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(within(dock).queryByTestId('verified-chips')).toBeNull();
  });

  it('a question that does not run, or whose spec is hidden, is no chip; an old server gives none', async () => {
    serve(base([{ ...ROW, runs: false }, { ...ROW, id: 'v2', question: 'Hidden', spec: undefined }]));
    renderApp('/');
    const dock = await openDock();
    await within(dock).findByText(/AI isn’t set up yet/);
    expect(within(dock).queryByTestId('verified-chips')).toBeNull();
  });

  it('an old server (verified:list 404) gives no chip and no error', async () => {
    serve(base([], { 'verified:list': { status: 404, body: { error: 'not_found', message: 'Unknown channel' } } }));
    renderApp('/');
    const old = await openDock();
    await within(old).findByText(/AI isn’t set up yet/);
    expect(within(old).queryByTestId('verified-chips')).toBeNull();
  });
});

describe('verified chips on Home, with no model', () => {
  it('shows the chip; a click opens the dock, which re-asks the spec', async () => {
    const calls = serve(base([ROW]));
    renderApp('/');
    fireEvent.click(await screen.findByRole('button', { name: '✓ Revenue by region' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'answer:rerun')?.payload).toEqual({ projectId: PID, threadId: THREAD, spec: SPEC, label: 'Revenue by region' }));
    expect(screen.getByRole('complementary', { name: 'Assistant' })).toBeTruthy();
  });

  it('a question typed on Home is asked by the dock, and focus stays in the dock while it is', async () => {
    let release = (): void => {};
    const held = new Promise<Out>((r) => { release = () => r({ body: { ok: false, notReady: true } }); });
    const calls = serve(base([ROW], { 'copilot:ask': () => held }));
    renderApp('/');
    const ask = await screen.findByRole('textbox', { name: 'Ask a question or say what to build' });
    await screen.findByRole('button', { name: '✓ Revenue by region' });
    fireEvent.change(ask, { target: { value: 'Which month had the most orders?' } });
    fireEvent.submit(ask.closest('form')!);
    const dock = await screen.findByRole('complementary', { name: 'Assistant' });
    const box = within(dock).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(true)); // being asked
    await waitFor(() => expect(calls.find((c) => c.channel === 'copilot:ask')?.payload).toMatchObject({ projectId: PID, question: 'Which month had the most orders?' }));
    // A browser drops focus from a composer that turns disabled to <body>; jsdom keeps it, so it is checked here.
    const focused = document.activeElement as HTMLTextAreaElement;
    expect(dock.contains(focused) && !focused.disabled).toBe(true);
    release();
    expect(await within(dock).findByText('Connect a model to ask anything else.')).toBeTruthy();
    expect(dock.contains(document.activeElement)).toBe(true);
  });
});

describe('the chips read the project\'s list once', () => {
  it('Home and the dock share one verified:list read (the page load\'s RPC budget)', async () => {
    const calls = serve(base([ROW]));
    renderApp('/');
    await screen.findByRole('button', { name: '✓ Revenue by region' });
    const dock = await openDock();
    await within(dock).findByRole('button', { name: '✓ Revenue by region' });
    expect(calls.filter((c) => c.channel === 'verified:list')).toEqual([{ channel: 'verified:list', payload: { projectId: PID } }]);
  });

  it('a dataset context puts its dataset\'s questions first without asking again; NEGATIVE CONTROL, none keeps the server\'s order', async () => {
    const onD2 = { ...ROW, id: 'v2', question: 'Units by state', datasetId: 'd2', spec: { ...SPEC, datasetId: 'd2' } };
    const calls = serve(base([onD2, ROW]));
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const inD1 = renderHook(() => useVerifiedChips(PID, 'd1'), { wrapper });
    await waitFor(() => expect(inD1.result.current.map((c) => c.question)).toEqual(['Revenue by region', 'Units by state']));
    const anywhere = renderHook(() => useVerifiedChips(PID), { wrapper });
    expect(anywhere.result.current.map((c) => c.question)).toEqual(['Units by state', 'Revenue by region']);
    expect(calls.filter((c) => c.channel === 'verified:list').length).toBe(1);
  });
});
