import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { dur, relTime } from './pipelineFormat';
import type { PipelineView } from './pipelinesApi';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DS = '22222222-2222-4222-8222-222222222222';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };
const STAGES = ['Sources', 'Datasets', 'Derived datasets', 'Quality checks', 'Alerts', 'Reports & publish'];

describe('pipeline wording', () => {
  it('words times and durations without computing a figure of the data', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(relTime('2026-10-03T11:55:00Z', now)).toBe('5 min ago');
    expect(relTime('2026-10-03T15:00:00Z', now)).toBe('in 3 h');
    expect(relTime('2026-10-03T11:59:40Z', now)).toBe('just now');
    expect(dur(1234)).toBe('1.2 s');
    expect(dur(125_000)).toBe('2 min 5 s');
  });
});

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });
function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      const r = routes[channel] ?? { body: [] };
      const out = typeof r === 'function' ? r(payload) : r;
      return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
    }),
  );
  return calls;
}

const VIEW: PipelineView = {
  ok: true,
  stages: STAGES,
  nodes: [
    {
      id: `dataset:${DS}`,
      kind: 'dataset',
      stage: 1,
      name: 'Orders',
      sub: 'Database · 240 rows',
      ref: { type: 'dataset', id: DS },
      schedule: { text: 'Daily', edit: 'dataset', every: 'daily' },
      lastRun: { at: '2026-10-03T09:00:00Z', status: 'failed', durationMs: 1200 },
      nextRunAt: null,
      paused: false,
      runs: [
        {
          id: 'r1',
          trigger: 'manual',
          status: 'failed',
          startedAt: '2026-10-03T08:59:59Z',
          finishedAt: '2026-10-03T09:00:00Z',
          durationMs: 1200,
          attempts: 2,
          rows: 240,
          rowsBefore: 250,
          rowsDelta: -10,
          warnings: [],
          errors: ['connection refused'],
        },
      ],
    },
  ],
  edges: [],
  schedule: null,
  policy: { retries: 1, backoffMs: 30_000 },
  tz: 'UTC',
  live: {},
  // The strip prints these as they come: the browser counts nothing.
  summary: { stages: 1, scheduled: 7, failed: 3, lastActivityAt: '2026-10-03T09:00:00Z' },
};

const base = (extra: Record<string, Reply> = {}) => ({
  '/api/auth/me': { body: ME },
  'projects:overview': { body: [{ id: PID, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] },
  'pipelines:get': { body: VIEW },
  ...extra,
});

describe('Pipelines', () => {
  it('prints the server’s summary, and a step’s panel with its run log', async () => {
    const calls = serve(base({ 'pipelines:setPaused': { body: { ok: true } } }));
    renderApp('/pipelines');
    expect(await screen.findByText('7 on their own schedule')).toBeTruthy();
    expect(screen.getByText('3 failed or blocked last time')).toBeTruthy();
    expect(screen.getByText('1 step in 1 stage')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Dataset: Orders\. Failed\./ }));
    const panel = await screen.findByRole('region', { name: 'Step: Orders' });
    fireEvent.click(within(panel).getByRole('button', { name: /Run now/ }));
    expect(within(panel).getByText('250 rows before, 240 after (-10)')).toBeTruthy();
    expect(within(panel).getByText('connection refused')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Pause' }));
    await screen.findByText('7 on their own schedule');
    expect(calls.find((c) => c.channel === 'pipelines:setPaused')?.payload).toEqual({ projectId: PID, nodeId: `dataset:${DS}`, paused: true });
  });

  it('a step\'s refresh picker: the fast cadences only with incremental refresh, and "Behind schedule" from the server', async () => {
    const step = (schedule: object) => ({ ...VIEW, nodes: [{ ...VIEW.nodes[0], schedule }] });
    const calls = serve(base({
      'pipelines:get': { body: step({ text: 'Every 15 minutes · behind schedule', edit: 'dataset', every: '15min', incremental: true, behind: true }) },
      'pipelines:setNodeSchedule': { body: { ok: true } },
    }));
    renderApp('/pipelines');
    fireEvent.click(await screen.findByRole('button', { name: /^Dataset: Orders\./ }));
    const panel = await screen.findByRole('region', { name: 'Step: Orders' });
    expect(within(panel).getByText('Behind schedule')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('combobox', { name: 'Refresh this dataset' }));
    const opts = await screen.findAllByRole('option');
    expect(opts.filter((o) => o.getAttribute('aria-disabled') === 'true')).toHaveLength(0);
    fireEvent.click(opts.find((o) => o.textContent === 'Refresh every 5 minutes')!);
    await waitFor(() => expect(calls.some((c) => c.channel === 'pipelines:setNodeSchedule')).toBe(true));
    expect(calls.find((c) => c.channel === 'pipelines:setNodeSchedule')?.payload).toEqual({ projectId: PID, nodeId: `dataset:${DS}`, every: '5min' });
  });

  it('…without incremental refresh the fast cadences are greyed, saying why', async () => {
    serve(base({ 'pipelines:get': { body: { ...VIEW, nodes: [{ ...VIEW.nodes[0], schedule: { text: 'Daily', edit: 'dataset', every: 'daily', incremental: false } }] } } }));
    renderApp('/pipelines');
    fireEvent.click(await screen.findByRole('button', { name: /^Dataset: Orders\./ }));
    const panel = await screen.findByRole('region', { name: 'Step: Orders' });
    expect(within(panel).queryByText('Behind schedule')).toBeNull();
    fireEvent.click(within(panel).getByRole('combobox', { name: 'Refresh this dataset' }));
    const greyed = (await screen.findAllByRole('option')).filter((o) => o.getAttribute('aria-disabled') === 'true').map((o) => o.textContent);
    expect(greyed).toEqual(['Refresh every 5 minutes — needs incremental refresh', 'Refresh every 15 minutes — needs incremental refresh']);
  });

  it('an empty pipeline shows the six stages waiting, and where to start', async () => {
    serve(base({ 'pipelines:get': { body: { ...VIEW, nodes: [], summary: { stages: 0, scheduled: 0, failed: 0, lastActivityAt: null } } } }));
    renderApp('/pipelines');
    expect(await screen.findByRole('heading', { name: 'Nothing runs on its own yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect data' }).getAttribute('href')).toBe(`/connections/${PID}`);
  });

  it('a loop names the records that read each other', async () => {
    serve(base({ 'pipelines:get': { body: { ok: false, error: 'These records read each other in a circle, so nothing can run first.', cycle: ['A', 'B'] } } }));
    renderApp('/pipelines');
    expect(await screen.findByRole('heading', { name: 'This pipeline has a loop' })).toBeTruthy();
    expect(screen.getByText(/A\s+→\s+B\s+→\s+A/)).toBeTruthy();
  });

  it('the cron editor asks the server for the next runs and saves them', async () => {
    const calls = serve(
      base({
        'pipelines:preview': { body: { ok: true, text: 'Every day at 06:00', next: ['2026-10-04T06:00:00Z'] } },
        'pipelines:setSchedule': { body: { ok: true } },
      }),
    );
    renderApp('/pipelines');
    fireEvent.click(await screen.findByRole('button', { name: 'Set a schedule' }));
    expect(await screen.findByText('Every day at 06:00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await screen.findByText('7 on their own schedule');
    expect(calls.find((c) => c.channel === 'pipelines:setSchedule')?.payload).toEqual({ projectId: PID, cron: '0 6 * * *', tz: 'UTC' });
  });
});
