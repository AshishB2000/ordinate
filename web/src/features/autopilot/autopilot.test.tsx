// Admin → Autopilot and a run's report against a stubbed server: the states by design, what each switch sends, and every row's words
// and button (Undo for a move and a repair, Open for the rest). The words come from the server's structured rows; nothing is computed here.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '../../ui/Toast';
import { serve } from '../subscriptions/testServer';
import { AutopilotTab } from './AutopilotTab';
import ReportPage from './ReportPage';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const V = (n: number) => `33333333-3333-4333-8333-33333333333${n}`;

const settings = (over: object = {}) => ({ projectId: P, enabled: false, windowDays: 90, slowSeconds: 5, trashUnused: true, repairRenames: true, runAs: null, pausedReason: null, ...over });
const run = (over: object = {}) => ({ id: RUN, projectId: P, week: '2026-11-16', manual: false, state: 'done', ranAs: 'priya@acme.test', windowDays: 90, coveredFrom: null, counts: { trashed: 1, repaired: 1, broken: 1, slow: 1 }, startedAt: '2026-11-16T07:00:00.000Z', finishedAt: '2026-11-16T07:00:05.000Z', ...over });
const project = (over: { settings?: object; latest?: object | null; firstCleanup?: string | null } = {}) => ({ id: P, name: 'Sales', settings: settings(over.settings), latest: over.latest ?? null, firstCleanup: over.firstCleanup ?? null });
const overview = (...projects: object[]) => ({ body: { ok: true, projects } });

function wrap(ui: React.ReactNode, at = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/autopilot/:projectId/:runId" element={ui} />
          <Route path="*" element={ui} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Admin → Autopilot', () => {
  it('is off by default: one card per project, the switch off, nothing else to set yet', async () => {
    serve({ 'autopilot:overview': overview(project()) });
    wrap(<AutopilotTab />);
    expect(screen.getByRole('status', { name: 'Loading Autopilot' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Autopilot for Sales' })).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Autopilot' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.queryByLabelText('Unused after (days)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
  });

  it('switching it on sends one patch; on, it shows the window, the threshold and the two things it may do, and when it can start', async () => {
    const calls = serve({ 'autopilot:overview': overview(project({ settings: { enabled: true, runAs: 'priya@acme.test' }, firstCleanup: '2099-02-01' })), 'autopilot:save': { body: { ok: true, settings: settings() } } });
    wrap(<AutopilotTab />);
    expect(await screen.findByText(/Waiting for data: the first cleanup can happen on/)).toBeTruthy();
    expect((screen.getByLabelText('Unused after (days)') as HTMLInputElement).value).toBe('90');
    expect((screen.getByLabelText('Slow above (seconds)') as HTMLInputElement).value).toBe('5');
    expect(screen.getByRole('checkbox', { name: 'Move unused charts to Trash' })).toBeTruthy();
    expect(screen.getByText(/Runs as priya@acme.test/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Repair exact column renames' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'autopilot:save').map((c) => c.payload)).toEqual([{ projectId: P, repairRenames: false }]));
  });

  it('refuses a window outside 30 to 365 days at the field, and sends nothing', async () => {
    const calls = serve({ 'autopilot:overview': overview(project({ settings: { enabled: true, runAs: 'priya@acme.test' } })), 'autopilot:save': { body: { ok: true } } });
    wrap(<AutopilotTab />);
    const days = (await screen.findByLabelText('Unused after (days)')) as HTMLInputElement;
    fireEvent.change(days, { target: { value: '20' } });
    fireEvent.blur(days);
    expect(await screen.findByText('A whole number of days from 30 to 365.')).toBeTruthy();
    expect(calls.some((c) => c.channel === 'autopilot:save')).toBe(false);
    fireEvent.change(days, { target: { value: '120' } });
    fireEvent.blur(days);
    await waitFor(() => expect(calls.find((c) => c.channel === 'autopilot:save')?.payload).toEqual({ projectId: P, windowDays: 120 }));
  });

  it('says it is paused, why, and offers to run it as the person looking', async () => {
    const calls = serve({ 'autopilot:overview': overview(project({ settings: { enabled: true, runAs: 'gone@acme.test', pausedReason: 'lost_admin' } })), 'autopilot:save': { body: { ok: true } } });
    wrap(<AutopilotTab />);
    expect(await screen.findByText('Paused')).toBeTruthy();
    expect(screen.getByText(/gone@acme.test switched it on and is no longer an admin/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run it as me' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'autopilot:save')?.payload).toEqual({ projectId: P, enabled: true }));
  });

  it('designs the error and the empty state', async () => {
    serve({ 'autopilot:overview': { body: { ok: false, error: 'needs_database' } } });
    const { unmount } = wrap(<AutopilotTab />);
    expect(await screen.findByRole('heading', { name: 'Autopilot could not be loaded' })).toBeTruthy();
    expect(screen.getByText(/needs the organization.s database/)).toBeTruthy();
    unmount();
    serve({ 'autopilot:overview': overview() });
    wrap(<AutopilotTab />);
    expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeTruthy();
  });
});

const items = [
  { seq: 1, kind: 'trashed', visualId: V(1), name: 'Q2 test chart', state: 'applied', detail: { days: 90 } },
  { seq: 2, kind: 'repaired', visualId: V(2), name: 'Revenue by month', state: 'applied', detail: { fixes: [{ from: 'amount', to: 'revenue' }], datasetName: 'Orders' } },
  { seq: 3, kind: 'broken', visualId: V(3), name: 'Margin by rep', state: 'listed', detail: { gone: [{ column: 'cost', why: 'none' }], datasetName: 'Orders' } },
  { seq: 4, kind: 'slow', visualId: V(4), name: 'Orders by day', state: 'listed', detail: { avgMs: 9100, maxMs: 14000, computes: 6, datasetName: 'Orders' } },
];

describe('The weekly report', () => {
  const open = () => wrap(<ReportPage />, `/autopilot/${P}/${RUN}`);

  it('counts what happened and words every row; a move and a repair have Undo, the rest have Open', async () => {
    serve({ 'autopilot:run': { body: { ok: true, run: run(), items } }, 'autopilot:runs': { body: { ok: true, runs: [run()] } } });
    open();
    expect(await screen.findByRole('heading', { name: 'Autopilot report' })).toBeTruthy();
    expect(screen.getByText('Moved to Trash: not opened in 90 days')).toBeTruthy();
    expect(screen.getByText('Now uses revenue (was amount)')).toBeTruthy();
    expect(screen.getByText('Uses cost, which is gone from Orders')).toBeTruthy();
    expect(screen.getByText('No rename of it was recorded, so Autopilot cannot tell what it became.')).toBeTruthy();
    expect(screen.getByText('Takes about 9.1 s on Orders')).toBeTruthy();
    expect(screen.getByText('Slowest 14 s, over 6 runs this week.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Undo for / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Undo for Q2 test chart', 'Undo for Revenue by month']);
    expect(screen.getByRole('link', { name: 'Open Margin by rep' }).getAttribute('href')).toBe(`/visuals/${P}/${V(3)}`);
    expect(screen.queryByRole('button', { name: 'Undo for Margin by rep' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo all repairs' })).toBeTruthy();
  });

  it('Undo sends that row only, then the row reads Undone', async () => {
    let undone = false;
    const calls = serve({
      'autopilot:run': () => ({ body: { ok: true, run: run(), items: items.map((i) => (i.seq === 2 && undone ? { ...i, state: 'undone' } : i)) } }),
      'autopilot:runs': { body: { ok: true, runs: [run()] } },
      'autopilot:undo': () => { undone = true; return { body: { ok: true } }; },
    });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo for Revenue by month' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'autopilot:undo')?.payload).toEqual({ projectId: P, runId: RUN, seq: 2 }));
    const row = (await screen.findAllByText('Undone'))[0].closest('li') as HTMLElement;
    expect(within(row).getByText('Revenue by month')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Undo for/ })).toBeNull();
  });

  it('Undo all repairs sends no row number; a chart changed since is said to be left as it is', async () => {
    const calls = serve({
      'autopilot:run': { body: { ok: true, run: run(), items } }, 'autopilot:runs': { body: { ok: true, runs: [run()] } },
      'autopilot:undo': { body: { ok: true, undone: 0, refused: 1 } },
    });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo all repairs' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'autopilot:undo')?.payload).toEqual({ projectId: P, runId: RUN }));
    expect(await screen.findByText(/1 left as they are because the chart changed/)).toBeTruthy();
  });

  it('a refused Undo says why (the chart was edited since)', async () => {
    serve({ 'autopilot:run': { body: { ok: true, run: run(), items } }, 'autopilot:runs': { body: { ok: true, runs: [run()] } }, 'autopilot:undo': { body: { ok: false, error: 'changed' } } });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo for Revenue by month' }));
    expect(await screen.findByText('The chart was changed since, so it was left as it is.')).toBeTruthy();
  });

  it('an empty run says it is still watching until the first day it may call a chart unused', async () => {
    serve({ 'autopilot:run': { body: { ok: true, run: run({ counts: {}, coveredFrom: '2099-03-01' }), items: [] } }, 'autopilot:runs': { body: { ok: true, runs: [run()] } } });
    open();
    expect(await screen.findByRole('heading', { name: 'Nothing to do this time' })).toBeTruthy();
    expect(screen.getByText(/Autopilot is still watching. It starts calling charts unused on/)).toBeTruthy();
  });

  it('a paused run says nothing was changed and why', async () => {
    serve({ 'autopilot:run': { body: { ok: true, run: run({ state: 'paused', ranAs: 'gone@acme.test', counts: {} }), items: [] } }, 'autopilot:runs': { body: { ok: true, runs: [run()] } } });
    open();
    expect(await screen.findByText(/stopped without changing anything/)).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
  });

  it('an unknown report is an error state, not a blank page', async () => {
    serve({ 'autopilot:run': { body: { ok: false, error: 'not_found' } }, 'autopilot:runs': { body: { ok: true, runs: [] } } });
    open();
    expect(await screen.findByRole('heading', { name: 'This report could not be opened' })).toBeTruthy();
  });
});
