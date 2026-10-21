// A held answer is never drawn as another ask's (docs/chart-figures): while the next answer computes, the builder
// and a dashboard tile keep the last one on screen — but when the chart type or a figure override changed, that
// answer carries the other ask's figures (or none), so it shows as loading, never as "Nothing to draw" or a stale %.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { renderApp } from '../../test-utils';
import { VisualTileBody } from '../analyses/VisualTile';
import type { VisualDef } from '../analyses/api';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const VID = '33333333-3333-4333-8333-333333333333';
const ENC = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };
const DATA = { labels: ['East', 'North', 'South'], series: [{ name: 'sum of amount', values: [3, 4, 5] }] };
const NEVER = () => new Promise<Response>(() => {});

/** The builder's server: `hang(payload)` true leaves that preview unanswered (the next answer still computing). */
function serveBuilder(hang: (p: { chartType?: string }) => boolean) {
  const routes: Record<string, unknown> = {
    '/api/auth/me': { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false },
    'projects:overview': [{ id: PID, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }],
    'projects:roles': { [PID]: 'admin' },
    'ai:status': { ready: false, models: [], mine: null, keyStore: null },
    'dataset:list': [{ id: DID, name: 'Orders', sourceKind: 'csv', rowCount: 3, columnCount: 2, updatedAt: '' }],
    'dataset:columns': { id: DID, name: 'Orders', rowCount: 3, columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }] },
    'relationship:related': { ok: true, groups: [] },
    'boundary:list': { ok: true, boundaries: [] },
    'visual:get': { id: VID, name: 'Amount by region', chartType: 'column', datasetId: DID, updatedAt: '', favorite: false, encoding: ENC, overrides: {}, filters: [] },
    'visual:preview': { ok: true, data: DATA, recommendedShape: 'categorical', warnings: [] },
  };
  const asked: { chartType?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = (init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined) as { chartType?: string };
      if (channel === 'visual:preview') {
        asked.push(payload);
        if (hang(payload)) return NEVER();
      }
      return new Response(JSON.stringify(channel in routes ? routes[channel] : []), { status: 200 });
    }),
  );
  return asked;
}

describe('the builder never draws a held answer as another figure ask', () => {
  it('switching a column chart to a waterfall: "Computing the visual" from the click on — through the settle — not "Nothing to draw"', async () => {
    const asked = serveBuilder((p) => p.chartType === 'waterfall');
    renderApp(`/visuals/${PID}/${VID}`);
    await waitFor(() => expect(screen.getByRole('radio', { name: /Column/ }).getAttribute('aria-checked')).toBe('true'));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Computing the visual' })).toBeNull()); // the column chart is drawn
    fireEvent.click(screen.getByRole('button', { name: 'More chart types' }));
    fireEvent.click(await screen.findByRole('button', { name: /Waterfall/ }));
    // Inside the 160 ms settle: no request has gone yet, the column answer is still the one held.
    expect(asked.some((p) => p.chartType === 'waterfall')).toBe(false);
    expect(screen.getByRole('status', { name: 'Computing the visual' })).toBeTruthy();
    // The waterfall's own request goes; until it answers, still loading.
    await waitFor(() => expect(asked.some((p) => p.chartType === 'waterfall')).toBe(true));
    expect(screen.getByRole('status', { name: 'Computing the visual' })).toBeTruthy();
    expect(screen.queryByText('Nothing to draw')).toBeNull();
  });

  it('NEGATIVE CONTROL: a change that keeps the ask (a non-figure type) keeps the held answer on screen', async () => {
    serveBuilder(() => false);
    renderApp(`/visuals/${PID}/${VID}`);
    await waitFor(() => expect(screen.getByRole('radio', { name: /Column/ }).getAttribute('aria-checked')).toBe('true'));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Computing the visual' })).toBeNull());
    fireEvent.click(screen.getByRole('radio', { name: /^Bar/ }));
    expect(screen.queryByRole('status', { name: 'Computing the visual' })).toBeNull();
  });
});

const BULLET = (target: number): VisualDef => ({ id: 'v', name: 'Amount to target', datasetId: DID, chartType: 'bullet', encoding: ENC, overrides: { bulletTarget: target }, filters: [], updatedAt: '' });

/** A tile whose first answer comes back and whose next one is still computing. */
function tile(first: unknown) {
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('projects%3Aroles') || url.includes('projects:roles')) return new Response(JSON.stringify({ [PID]: 'viewer' }), { status: 200 });
    if (n++ > 0) return NEVER();
    return new Response(JSON.stringify([first]), { status: 200 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const at = (def: VisualDef) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <VisualTileBody projectId={PID} def={def} filters={[]} params={[]} />
      </QueryClientProvider>
    </MemoryRouter>
  );
  return { ...render(at(BULLET(100))), at };
}

describe('a dashboard tile never draws a held answer as another figure ask', () => {
  const answer = { ok: true, data: { ...DATA, figures: { bullet: { ofTargetPct: [3, 4, 5] } } }, warnings: [] };

  it('a new bullet target: the answer for the old target shows as loading, not its percentages', async () => {
    const t = tile(answer);
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading Amount to target' })).toBeNull()); // drawn for target 100
    t.rerender(t.at(BULLET(200)));
    expect(screen.getByRole('status', { name: 'Loading Amount to target' })).toBeTruthy();
  });

  it('NEGATIVE CONTROL: the same ask under a new filter keeps the held answer on screen', async () => {
    const t = tile(answer);
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading Amount to target' })).toBeNull());
    t.rerender(t.at({ ...BULLET(100), filters: [{ type: 'filter', column: 'region', op: '=', value: 'East' }] }));
    expect(screen.queryByRole('status', { name: 'Loading Amount to target' })).toBeNull();
  });
});
