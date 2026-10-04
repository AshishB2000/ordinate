import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { fmtP, fmtPct, fmtShare, fmtStat, stars } from './format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
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
