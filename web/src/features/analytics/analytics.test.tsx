import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { fmtP, fmtPct, fmtShare, fmtStat, stars } from './format';
import { seedMetrics } from './scenarios/ScenarioParts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333333';
const S2 = '44444444-4444-4444-8444-444444444444';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };
const PROJECT = { id: PID, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false };
const COLUMNS = {
  id: DID,
  name: 'Orders',
  rowCount: 120,
  columns: [
    { name: 'region', type: 'text' },
    { name: 'units', type: 'number' },
    { name: 'revenue', type: 'number' },
  ],
};

type Reply = { status?: number; body?: unknown };

function serve(routes: Record<string, Reply>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      calls.push(channel);
      const r = routes[channel] ?? { body: [] };
      return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

const base = (extra: Record<string, Reply> = {}) => ({
  '/api/auth/me': { body: ME },
  'projects:overview': { body: [PROJECT] },
  'projects:roles': { body: { [PID]: 'admin' } },
  'dataset:columns': { body: COLUMNS },
  'dataset:list': { body: [{ id: DID, name: 'Orders', sourceKind: 'csv', rowCount: 120, columnCount: 3, updatedAt: '' }] },
  ...extra,
});

describe('formatting a figure the server computed', () => {
  it('writes statistics, p-values and stars as the desktop did', () => {
    expect(fmtStat(1234.5)).toBe('1,235');
    expect(fmtStat(12.345)).toBe('12.35');
    expect(fmtStat(0.00001)).toBe('1.00e-5');
    expect(fmtStat(Number.NaN)).toBe('—');
    expect(fmtStat(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(fmtP(0.0004)).toBe('< 0.001');
    expect(fmtP(0.04213)).toBe('0.042');
    expect(stars(0.004)).toBe('**');
    expect(stars(0.07)).toBe('·');
    expect(fmtShare(0.0004)).toBe('<0.1%');
    expect(fmtShare(0.25)).toBe('25%');
    expect(fmtPct(-3.456)).toBe('−3.5%');
    expect(fmtPct(12.4)).toBe('+12%');
  });

  it('seeds a new scenario with column metrics first, formulas next, counts last, four at most', () => {
    const m = (id: string, kind: 'column' | 'formula' | 'count') => ({ id, name: id, kind });
    expect(seedMetrics([m('cnt', 'count'), m('f', 'formula'), m('a', 'column'), m('b', 'column'), m('c', 'column'), m('d', 'column')])).toEqual(['a', 'b', 'c', 'f']);
  });
});

describe('Statistics', () => {
  it('runs the first tab on open and words a refusal as its designed state', async () => {
    const calls = serve(base({ 'stats:run': { body: { ok: true, result: { ok: false, kind: 'correlation', error: 'Need at least 3 rows where both columns have a value.' }, datasetName: 'Orders', figures: {} } } }));
    renderApp(`/analytics/${PID}/${DID}/stats`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Statistics' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Not enough data' })).toBeTruthy();
    expect(calls.filter((c) => c === 'stats:run')).toHaveLength(1);
  });
});

describe('Scenarios', () => {
  it('shows the designed empty list', async () => {
    serve(base({ 'scenario:list': { body: [] } }));
    renderApp(`/analytics/scenarios/${PID}`);
    expect(await screen.findByRole('heading', { name: 'No scenarios yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New scenario' })).toBeTruthy();
  });

  it('marks the column the SERVER calls best, and only that one', async () => {
    const cell = (display: string) => ({ display, delta: 1, deltaDisplay: '+1', pct: 1, tone: 'good' });
    serve(
      base({
        'scenario:list': {
          body: [
            { id: S1, name: 'Up 5', driverCount: 1, metricCount: 1, driverNames: ['price +5%'], updatedAt: '' },
            { id: S2, name: 'Up 10', driverCount: 1, metricCount: 1, driverNames: ['price +10%'], updatedAt: '' },
          ],
        },
        'scenario:compare': {
          body: {
            ok: true,
            scenarios: [
              { id: S1, name: 'Up 5', drivers: ['price +5%'] },
              { id: S2, name: 'Up 10', drivers: ['price +10%'] },
            ],
            // `best` is the server's: the browser never ranks the figures.
            rows: [{ metricId: 'm', name: 'Revenue', missing: false, baselineDisplay: '$10', best: 0, cells: [cell('$9'), cell('$11')] }],
          },
        },
      }),
    );
    renderApp(`/analytics/scenarios/${PID}/compare`);
    const table = await screen.findByRole('table', { name: 'Baseline and scenarios, side by side' });
    const cells = within(table).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(['$10', '$9+1 (+1%)Best', '$11+1 (+1%)']);
    expect(screen.getByText('2 of 4 picked')).toBeTruthy();
  });
});
