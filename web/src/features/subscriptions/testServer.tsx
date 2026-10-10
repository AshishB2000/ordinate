// A stubbed server for the subscriptions and channels component tests: fetch
// answered per RPC channel (the wire codec reads plain JSON), every call's
// payload recorded. Not a suite.

import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { Toaster } from '../../ui/Toast';
import type { Channel, MessageModel, Preview, Subscription } from './api';

export type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });

export function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: any }[] = []; // any: each channel's own input
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
    const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
    if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
    const r = routes[channel] ?? { body: [] };
    const out = typeof r === 'function' ? r(payload) : r;
    return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
  });
  vi.stubGlobal('fetch', spy);
  return calls;
}

/** One component with a fresh query cache, a router (for its links) and the toast stack. */
export function mount(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {ui}
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export const PID = '11111111-1111-4111-8111-111111111111';
export const AID = '22222222-2222-4222-8222-222222222222';
export const SLACK: Channel = { id: '33333333-3333-4333-8333-333333333333', name: '#sales-weekly', kind: 'slack', secretSet: true };
export const TEAMS: Channel = { id: '44444444-4444-4444-8444-444444444444', name: 'Leadership', kind: 'teams', secretSet: true };
export const CARDS = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', type: 'metric' as const, title: 'Revenue', sheet: 'Overview' },
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', type: 'visual' as const, title: 'Sales by region', sheet: 'Overview', chartType: 'bar' },
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', type: 'visual' as const, title: 'Monthly sales', sheet: 'Trend', chartType: 'line' },
];

export const MODEL: MessageModel = {
  title: 'Retail overview',
  subtitle: ['Oct 12, 2026', 'Data as of Oct 12, 2026, 6:00 AM UTC'],
  kpis: [{ label: 'Revenue', value: '$5.2M', change: '▲ +4.3% vs previous period · good', tone: 'good' }],
  sections: [{ title: 'Sales by region', caption: 'West leads with 400.', columns: ['', 'sum of amount', 'Share of total'], rows: [['West', '400', '40%'], ['South', '300', '30%']], more: 2 }],
  more: 0,
  link: { url: 'https://bi.example.com/analyses/x/y', label: 'Open in Ordinate' },
  footer: 'Sent by Ordinate · Retail overview — weekdays · Every weekday at 08:00 (UTC)',
};

export function preview(over: Partial<Preview> = {}): { body: { ok: true } & Preview } {
  return {
    body: {
      ok: true,
      scheduleText: 'Every weekday at 08:00 (UTC)',
      nextRuns: [{ at: '2026-10-12T08:00:00.000Z', text: 'Mon 12 Oct, 08:00' }, { at: '2026-10-13T08:00:00.000Z', text: 'Tue 13 Oct, 08:00' }, { at: '2026-10-14T08:00:00.000Z', text: 'Wed 14 Oct, 08:00' }],
      cards: CARDS,
      views: [],
      linkNote: null,
      empty: null,
      slack: { model: MODEL, bytes: 1300, size: '1 KB', blocks: 7, notes: [] },
      teams: { model: { ...MODEL, title: 'Retail overview (Teams cut)' }, bytes: 3400, size: '3 KB', notes: ['Shortened to fit Teams (about 28 KB a message); the rest is in the dashboard.'] },
      ...over,
    },
  };
}

export function subscription(over: Partial<Subscription> = {}): Subscription {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    projectId: PID,
    name: 'Weekly board',
    analysisId: AID,
    dashboard: 'Retail overview',
    content: { mode: 'all', cardIds: [] },
    viewId: null,
    schedule: { cadence: 'weekdays', at: '08:00' },
    timezone: 'UTC',
    channelIds: [SLACK.id, TEAMS.id],
    message: { title: '', note: '', includeLink: true },
    conditions: { skipUnchanged: false, onlyWhenRefreshed: false },
    enabled: true,
    owner: 'ana@acme.test',
    scheduleText: 'Every weekday at 08:00 (UTC)',
    nextRuns: [{ at: '2026-10-12T08:00:00.000Z', text: 'Mon 12 Oct, 08:00' }],
    lastRun: { at: '2026-10-09T08:00:20.000Z', trigger: 'schedule', outcome: 'sent', text: 'Sent to 2 channels.' },
    paused: null,
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...over,
  };
}
