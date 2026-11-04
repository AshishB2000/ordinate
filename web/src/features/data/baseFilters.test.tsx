// A Live dataset's "Always applied" filters on its Schema tab (semantic layer part 1, D13): an editor
// edits and saves them (`live:setBaseFilters`), a refusal shows the server's sentence and keeps the
// edit, a viewer reads them, and an empty list is the designed empty state.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = 15_000;
const A = { type: 'filter', column: 'region', op: 'not in', values: ['North'] };
const B = { type: 'filter', column: 'amount', op: '>=', value: 10 };
const LIVE = { id: D, name: 'Orders (live)', sourceKind: 'postgres', rowCount: 0, columnCount: 3, updatedAt: '2026-10-09T10:00:00Z', originKind: 'connection', mode: 'live', maxCacheAgeSec: 300 };
const COLUMNS = [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'day', type: 'date' }];
const schema = (baseFilters: unknown[]) => ({
  ok: true, schemaSyncedAt: '2026-10-09T10:00:00Z', syncing: false, sampledAt: '2026-10-09T10:00:00Z', sampleRows: 240, method: 'sample', note: null,
  columns: COLUMNS.map((c) => ({ ...c, filled: 240, filledPct: 100, distinct: 4, values: [], more: 0, withheld: false })), missing: [], baseFilters,
});

/** Every channel answered by name (an unlisted one answers null, as livePage.test.tsx serves); returns the calls. */
function serve(role: 'admin' | 'viewer', baseFilters: unknown[], extra: Record<string, unknown> = {}) {
  const calls: { channel: string; payload: unknown }[] = [];
  const routes: Record<string, unknown> = {
    'projects:list': [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }],
    'projects:roles': { [P]: role },
    'dataset:list': [LIVE],
    'dataset:columns': { id: D, name: LIVE.name, rowCount: 0, mode: 'live', columns: COLUMNS },
    'dataset:source': { kind: 'connection', label: 'Fake warehouse', refreshable: true, live: true, maxCacheAgeSec: 300 },
    'catalog:tags': { ok: true, tags: [], refs: {} },
    'catalog:columns': { ok: true, columns: {} },
    'dataset:liveSchema': schema(baseFilters),
    ...extra,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      calls.push({ channel, payload: init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined });
      return new Response(JSON.stringify(routes[channel] ?? null), { status: 200 });
    }),
  );
  return calls;
}

const panel = async () => screen.findByRole('region', { name: 'Always applied' }, { timeout: LAZY });
const saves = (calls: { channel: string; payload: unknown }[]) => calls.filter((c) => c.channel === 'live:setBaseFilters').map((c) => c.payload);

describe('Always applied, on a Live dataset’s Schema tab', () => {
  it('an editor removes a filter and saves the rest', async () => {
    const calls = serve('admin', [A, B], { 'live:setBaseFilters': { ok: true, baseFilters: [B], epoch: 2 } });
    renderApp(`/data/${P}/${D}?tab=schema`);
    const box = await panel();
    expect(within(box).getByText(/Every chart, KPI, answer and value list on this dataset leaves out the rows these filters exclude/)).toBeTruthy();
    expect(within(box).queryByRole('button', { name: 'Save' })).toBeNull(); // nothing to save until something changes
    fireEvent.click(within(box).getAllByRole('button', { name: 'Remove filter' })[0]);
    fireEvent.click(within(box).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves(calls)).toEqual([{ projectId: P, datasetId: D, filters: [B] }]));
  });

  it('a refusal shows the server’s sentence and keeps the edit', async () => {
    const sentence = 'These filters can’t be always applied. Each needs a column of this dataset.';
    const calls = serve('admin', [A, B], { 'live:setBaseFilters': { ok: false, code: 'live_refused', reason: 'baseFilter', error: sentence } });
    renderApp(`/data/${P}/${D}?tab=schema`);
    const box = await panel();
    fireEvent.click(within(box).getAllByRole('button', { name: 'Remove filter' })[0]);
    fireEvent.click(within(box).getByRole('button', { name: 'Save' }));
    await screen.findByText(sentence);
    expect(saves(calls)).toHaveLength(1);
    expect(within(box).getAllByRole('button', { name: 'Remove filter' })).toHaveLength(1);
    expect(within(box).getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('Cancel puts the saved filters back without a call', async () => {
    const calls = serve('admin', [A, B]);
    renderApp(`/data/${P}/${D}?tab=schema`);
    const box = await panel();
    fireEvent.click(within(box).getAllByRole('button', { name: 'Remove filter' })[0]);
    fireEvent.click(within(box).getByRole('button', { name: 'Cancel' }));
    expect(within(box).getAllByRole('button', { name: 'Remove filter' })).toHaveLength(2);
    expect(saves(calls)).toEqual([]);
  });

  it('a viewer reads the filters and gets no Add filter and no Save', async () => {
    serve('viewer', [A, { type: 'filter', column: 'amount', op: '>=' }]);
    renderApp(`/data/${P}/${D}?tab=schema`);
    const box = await panel();
    const items = within(box).getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('region');
    expect(items[0]).toContain('North');
    expect(items[1]).toContain('amount');
    expect(items[1]).toContain('value hidden'); // a viewer row access rules restrict gets no value (REDACT)
    expect(within(box).queryByRole('button', { name: 'Add filter' })).toBeNull();
    expect(within(box).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('empty: the designed empty state, not a blank panel — and an editor can start one', async () => {
    serve('admin', []);
    renderApp(`/data/${P}/${D}?tab=schema`);
    const box = await panel();
    expect(within(box).getByText('No always-applied filters. Add one to keep rows such as test accounts or void orders out of every figure.')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'Add filter' }));
    expect(within(box).getByRole('button', { name: 'Edit the filter on region' })).toBeTruthy();
  });

  it('empty, for a viewer: the same words, no button', async () => {
    serve('viewer', []);
    renderApp(`/data/${P}/${D}?tab=schema`);
    const box = await panel();
    expect(within(box).getByText(/^No always-applied filters\./)).toBeTruthy();
    expect(within(box).queryByRole('button')).toBeNull();
  });
});
