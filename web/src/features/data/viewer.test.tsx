// A project viewer on the dataset page's sub-screens: every value stays
// readable, nothing that writes is offered (hidden, not disabled), and the
// stored fields of the Details popover are read-only. Each case has its editor
// negative control: the same screen, as an editor, offers the controls.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const R = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = 15_000;

const ORDERS = { id: D, name: 'Orders', sourceKind: 'csv', rowCount: 3, columnCount: 2, updatedAt: '2026-10-01T10:00:00Z', qualityFailing: 1 };
const COLS = { id: D, name: 'Orders', rowCount: 3, columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }] };
const QUALITY = {
  ok: true,
  rules: [{ id: R, kind: 'not_null', column: 'region', args: {}, severity: 'fail' }],
  latest: { at: '2026-10-01T10:00:00Z', results: [{ ruleId: R, passed: false, failing: 1 }] },
  history: [],
};
const SNAPSHOTS = {
  ok: true, eligible: true, refreshable: true, keep: 10,
  current: { at: '2026-10-04T10:00:00.000Z', rowCount: 3, columns: ['region'] },
  items: [{ stamp: '2026-10-03T10-00-00-000Z', at: '2026-10-03T10:00:00.000Z', rowCount: 2, columns: ['region'], hasSource: false, delta: 1 }],
};

const routes = (role: string, extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
  'projects:roles': { body: { [P]: role } },
  'dataset:list': { body: [ORDERS] },
  'dataset:columns': { body: COLS },
  'dataset:source': { body: { kind: 'csv', label: 'CSV', refreshable: false } },
  'dataset:stats': { body: { ok: true, summaries: [], issues: [], filledPct: [] } },
  'dataset:page': { body: { ok: true, rows: [], total: 0, offset: 0 } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'catalog:columns': { body: { ok: true, columns: {} } },
  'catalog:get': { body: { ok: true, doc: { description: 'Orders shipped.', tags: [{ name: 'finance', color: 2 }], owner: '', updatedBy: '', updatedAt: '' } } },
  'lineage:get': { body: null },
  'quality:list': { body: QUALITY },
  'snapshots:list': { body: SNAPSHOTS },
  ...extra,
});

const WRITES = /^(quality:(run|save|delete)|catalog:set|dataset:update|snapshots:)/;

describe('a viewer on the dataset page', () => {
  it('Quality: reads the rules and the failing rows, offers no Run, Add or row menu', async () => {
    const calls = serveRpc(routes('viewer'));
    renderApp(`/data/${P}/${D}?tab=quality`);
    expect(await screen.findByRole('button', { name: 'Show failing rows' }, { timeout: LAZY })).toBeTruthy();
    for (const name of ['Run checks', 'Add rule']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull();
    expect(calls.filter((c) => WRITES.test(c.channel))).toEqual([]);
    // Negative control: an editor gets them.
    cleanup();
    serveRpc(routes('editor'));
    renderApp(`/data/${P}/${D}?tab=quality`);
    expect(await screen.findByRole('button', { name: 'Run checks' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Actions for / })).toBeTruthy();
  }, 30_000);

  it('Details: the stored description is read-only and the tags are chips, never an editor', async () => {
    const calls = serveRpc(routes('viewer'));
    renderApp(`/data/${P}/${D}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }, { timeout: LAZY }));
    const desc = (await screen.findByRole('textbox', { name: 'Description' })) as HTMLTextAreaElement;
    expect(desc.value).toBe('Orders shipped.');
    expect(desc.readOnly).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Owner' }) as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText('finance')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /tag/i })).toBeNull();
    expect(screen.getByText('Not documented yet.')).toBeTruthy();
    fireEvent.keyDown(desc, { key: 'Escape' });
    expect(calls.filter((c) => WRITES.test(c.channel))).toEqual([]);
    // Negative control: an editor types into the same field.
    cleanup();
    serveRpc(routes('editor'));
    renderApp(`/data/${P}/${D}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }, { timeout: LAZY }));
    expect(((await screen.findByRole('textbox', { name: 'Description' })) as HTMLTextAreaElement).readOnly).toBe(false);
  }, 30_000);

  it('Snapshots: compares, never restores; how many are kept is shown, not changed', async () => {
    serveRpc(routes('viewer'));
    renderApp(`/data/${P}/${D}?tab=snapshots`);
    expect(await screen.findByRole('button', { name: 'Compare' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore…' })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Snapshots' })).getByRole('combobox', { name: 'Keep' }).hasAttribute('disabled')).toBe(true);
    cleanup();
    serveRpc(routes('editor'));
    renderApp(`/data/${P}/${D}?tab=snapshots`);
    expect(await screen.findByRole('button', { name: 'Restore…' }, { timeout: LAZY })).toBeTruthy();
  }, 30_000);

  it('Live: says who can make a copy, and offers neither copy', async () => {
    const live = {
      'dataset:list': { body: [{ ...ORDERS, originKind: 'connection', mode: 'live', maxCacheAgeSec: 300 }] },
      'dataset:columns': { body: { ...COLS, rowCount: 0, mode: 'live' } },
      'dataset:source': { body: { kind: 'connection', label: 'Warehouse', refreshable: true, live: true, maxCacheAgeSec: 300 } },
    };
    serveRpc(routes('viewer', live));
    renderApp(`/data/${P}/${D}`);
    expect(await screen.findByRole('heading', { name: 'Live — the rows stay in the warehouse' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByText(/An editor of this project can make a copy that keeps its rows here/)).toBeTruthy();
    for (const name of ['Make a copy', 'Copy the data instead', 'Refresh now']) expect(screen.queryByRole('button', { name })).toBeNull();
    cleanup();
    serveRpc(routes('editor', live));
    renderApp(`/data/${P}/${D}`);
    expect(await screen.findByRole('button', { name: 'Copy the data instead' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make a copy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeTruthy();
  }, 30_000);
});
