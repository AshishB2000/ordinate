import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { freshness, fromControl, pctText } from './format';
import { laneLayout } from './RelationshipsTab';
import { columnsFor, ruleWords } from './ruleWords';
import { normTag } from './tags';
import type { Relationship } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';

type Reply = { status?: number; body?: unknown };

/** The Data routes are lazy chunks: their first render waits on a transform (long under load). */
const LAZY = 15_000;

/** fetch answered per RPC channel; records each call's payload. */
function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      calls.push({ channel, payload });
      const r = routes[channel] ?? { body: null };
      return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

const ORDERS = {
  id: D,
  name: 'Orders',
  sourceKind: 'json',
  rowCount: 1200,
  columnCount: 4,
  updatedAt: '2026-10-01T10:00:00Z',
  originKind: 'url',
  lastRefreshStatus: 'error',
  lastRefreshError: 'Could not fetch https://api.example.com: 401',
  autoRefresh: { every: 'daily' },
  qualityFailing: 2,
};

describe('Data list', () => {
  it('draws a dataset row: quality dot, rows, source, schedule, the refresh reason', async () => {
    serve({
      'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
      'dataset:list': { body: [ORDERS] },
      'catalog:tags': { body: { ok: true, tags: [{ name: 'finance', color: 2, count: 1 }], refs: { [`dataset:${D}`]: ['finance'] } } },
    });
    renderApp(`/data/${P}`);
    const row = (await screen.findByRole('link', { name: 'Orders' }, { timeout: LAZY })).closest('tr')!;
    expect(within(row).getByRole('img', { name: 'Data quality: 2 rules failing' })).toBeTruthy();
    expect(within(row).getByText('1,200 rows')).toBeTruthy();
    expect(within(row).getByText('JSON')).toBeTruthy();
    expect(within(row).getByText(/^Refreshes daily · last/)).toBeTruthy();
    expect(within(row).getByRole('img', { name: 'Last refresh failed' })).toBeTruthy();
    expect(within(row).getByText('finance')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Watch' })).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('designs the empty state, and says so once (no header Import beside it)', async () => {
    serve({ 'projects:list': { body: [] }, 'dataset:list': { body: [] }, 'catalog:tags': { body: { ok: true, tags: [], refs: {} } } });
    renderApp(`/data/${P}`);
    expect(await screen.findByRole('heading', { name: 'No datasets yet' }, { timeout: LAZY })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Import file' })).toHaveLength(1));
  }, 30_000);

  it('a refusal from the catalog is an error state with a retry', async () => {
    serve({ 'projects:list': { body: [] }, 'catalog:list': { body: { ok: false, error: 'The catalog could not be read.', rows: [] } } });
    renderApp(`/data/${P}?tab=catalog`);
    const alert = await screen.findByRole('alert', {}, { timeout: LAZY });
    expect(alert.textContent).toContain('The catalog could not be read.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
  }, 30_000);
});

describe('Data helpers', () => {
  it('words a rule as the desktop does', () => {
    expect(ruleWords({ kind: 'not_null', column: 'day', args: {}, severity: 'fail' })).toBe('day is never empty');
    expect(ruleWords({ kind: 'range', column: 'discount', args: { min: 0, max: 1 }, severity: 'warn' })).toBe('discount is between 0 and 1');
    expect(ruleWords({ kind: 'regex', column: 'email', args: { preset: 'email' }, severity: 'fail' })).toBe('email matches Email');
    expect(ruleWords({ kind: 'in_set', column: 'r', args: { values: ['a', 'b', 'c', 'd', 'e'] }, severity: 'fail' })).toBe('r is one of a, b, c and 2 more');
    expect(ruleWords({ kind: 'references', column: 'r', args: { datasetId: 'x', column: 'id' }, severity: 'fail' }, new Map([['x', 'Regions']]))).toBe('r exists in Regions.id');
  });

  it('offers only the columns a kind can run on', () => {
    const cols = [{ name: 'a', type: 'text' as const }, { name: 'b', type: 'number' as const }, { name: 'c', type: 'date' as const }];
    expect(columnsFor('range', cols).map((c) => c.name)).toEqual(['b', 'c']);
    expect(columnsFor('regex', cols).map((c) => c.name)).toEqual(['a', 'c']);
  });

  it('lays a lookup out one lane right of what reads it; the unrelated last', () => {
    const rel = (from: string, to: string) => ({ id: `${from}${to}`, from: { datasetId: from, column: 'k' }, to: { datasetId: to, column: 'k' } }) as Relationship;
    expect(laneLayout(['f', 'r', 'c', 'x'], [rel('f', 'r'), rel('r', 'c')])).toEqual({ lanes: [['f'], ['r'], ['c']], loose: ['x'] });
  });

  it('formats without computing', () => {
    expect(normTag('  #Sales Team! ')).toBe('sales-team');
    expect(pctText(91.7)).toBe('91.7%');
    expect(freshness({ updatedAt: '2026-10-01T10:00:00Z', sourceKind: 'paste' })).toMatch(/^Imported /);
    const b = document.createElement('button');
    expect(fromControl(b)).toBe(true);
    expect(fromControl(document.createElement('td'))).toBe(false);
  });
});
