// The builder on a Live dataset (docs/live-data/00-plan.md L2.6): a figure the
// server refuses shows ITS sentence and "Make a copy"; pivot, cohort and funnel
// are off before any request; a chart the warehouse answered says "Live · …".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp } from '../../test-utils';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const VID = '33333333-3333-4333-8333-333333333333';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };
const COLS = [
  { name: 'region', type: 'text' },
  { name: 'amount', type: 'number' },
] as const;
const SENTENCE = 'This is a Live dataset — this isn’t available on Live yet. Make a copy to use it.';
const DRAWN = { ok: true, data: { labels: ['East', 'North', 'South'], series: [{ name: 'sum of amount', values: [3, 4, 5] }] }, recommendedShape: 'categorical', warnings: [] };

function serve(live: boolean, extra: Record<string, unknown> = {}) {
  const calls: { channel: string; payload: unknown }[] = [];
  const routes: Record<string, unknown> = {
    '/api/auth/me': ME,
    'projects:overview': [{ id: PID, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }],
    'projects:roles': { [PID]: 'admin' },
    'key:status': { isReady: false },
    'dataset:list': [{ id: DID, name: 'Orders', sourceKind: 'postgres', rowCount: live ? 0 : 10, columnCount: 2, updatedAt: '', ...(live ? { mode: 'live', maxCacheAgeSec: 300 } : {}) }],
    'dataset:columns': { id: DID, name: 'Orders', rowCount: live ? 0 : 10, columns: COLS, ...(live ? { mode: 'live' } : {}) },
    'relationship:related': { ok: true, groups: [] },
    'boundary:list': { ok: true, boundaries: [] },
    'visual:preview': DRAWN,
    ...extra,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      return new Response(JSON.stringify(channel in routes ? routes[channel] : []), { status: 200 });
    }),
  );
  return calls;
}

describe('the builder on a Live dataset', () => {
  it('a refused figure: the server’s sentence and "Make a copy", no retry; no "As of" picker', async () => {
    serve(true, { 'visual:preview': { ok: false, code: 'live_dataset', error: SENTENCE } });
    renderApp(`/visuals/${PID}/new?dataset=${DID}`);
    expect(await screen.findByRole('heading', { name: 'Off for this Live dataset' })).toBeTruthy();
    expect(screen.getByText(SENTENCE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make a copy' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /As of/ })).toBeNull();
  });

  it('NEGATIVE CONTROL: an ordinary failure is still an error with a retry', async () => {
    serve(true, { 'visual:preview': { ok: false, error: 'Pick a measure.' } });
    renderApp(`/visuals/${PID}/new?dataset=${DID}`);
    expect(await screen.findByRole('heading', { name: 'Could not compute the visual' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make a copy' })).toBeNull();
  });

  it('a saved pivot is off before any request — and "Draw a column chart instead" asks for a chart', async () => {
    const calls = serve(true, {
      'visual:get': { id: VID, name: 'Pivot', chartType: 'pivot', datasetId: DID, updatedAt: '', favorite: false, encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }], pivot: { rows: [{ column: 'region' }], values: [] } }, overrides: {}, filters: [] },
    });
    renderApp(`/visuals/${PID}/${VID}`);
    expect(await screen.findByRole('heading', { name: 'Pivot tables are off for Live datasets' })).toBeTruthy();
    expect(calls.some((c) => c.channel === 'visual:preview')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Draw a column chart instead' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'visual:preview')).toBe(true));
    expect(JSON.stringify(calls.find((c) => c.channel === 'visual:preview')!.payload)).not.toContain('"pivot"');
  });

  it('a chart the warehouse answered says "Live · …"; the grid types are not offered', async () => {
    serve(true, { 'visual:preview': { ...DRAWN, asOf: { at: new Date().toISOString(), mode: 'live' } } });
    renderApp(`/visuals/${PID}/new?dataset=${DID}`);
    const caption = await screen.findByTestId('as-of');
    expect(caption.textContent).toMatch(/^Live · /);
    expect(screen.queryByRole('radio', { name: /Pivot table/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More chart types' }));
    await screen.findByText('Other charts');
    expect(screen.queryByRole('button', { name: /Pivot table/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cohort/ })).toBeNull();
  });

  it('NEGATIVE CONTROL: on an extract the pivot is offered', async () => {
    serve(false);
    renderApp(`/visuals/${PID}/new?dataset=${DID}`);
    expect(await screen.findByRole('radio', { name: /Pivot table/ })).toBeTruthy();
  });
});
