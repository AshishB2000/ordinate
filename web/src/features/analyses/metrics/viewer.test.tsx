// A project viewer on the metrics table and a metric's tree: the figures, the
// period and Compare stay theirs; defining, editing and adding a tree are an
// editor's — so a tree-less metric asks a viewer's browser for no suggestions.
// Each case has its editor negative control.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const N = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = 15_000;
const PROJECT = { id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false };
const metric = (id: string, name: string, hasTree?: true) => ({
  id, name, datasetId: D, datasetName: 'Orders', definition: { kind: 'column' }, definitionText: `sum of ${name}`, format: { type: 'number' }, updatedAt: '', ...(hasTree ? { hasTree } : {}),
});
const ROOT = {
  key: 'r', kind: 'metric', name: 'Revenue', current: 2, previous: 1, change: 1, pct: 100, display: '2', previousDisplay: '1', changeDisplay: '+1', pctDisplay: '+100%', spark: null, children: [],
};
const TREE = { ok: true, root: ROOT, tree: null, headline: 'Revenue rose by 1.', period: { key: 'latest_month', label: 'Sep 2026' }, prior: { label: 'Aug 2026' }, compareLabel: 'vs Aug 2026' };

const routes = (role: string, extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
  'projects:overview': { body: [PROJECT] },
  'projects:roles': { body: { [P]: role } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'metric:table': { body: { ok: true, metrics: [metric(M, 'Revenue', true), metric(N, 'Orders')], rows: {} } },
  'metricTree:compute': { body: TREE },
  'metricTree:suggest': { body: { ok: true, suggestions: {}, metrics: [], columns: ['region'] } },
  ...extra,
});

async function openMenu(name: string) {
  const trigger = await screen.findByRole('button', { name });
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return (await screen.findAllByRole('menuitem')).map((m) => m.textContent);
}

describe('a viewer on the metrics', () => {
  it('reads the table; the only row action is a tree that exists', async () => {
    serveRpc(routes('viewer'));
    renderApp(`/data/metrics?project=${P}`);
    const table = await screen.findByRole('table', {}, { timeout: LAZY });
    expect(within(table).getByText('Revenue')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New metric' })).toBeNull();
    expect(within(table).queryByRole('button', { name: 'Revenue' })).toBeNull(); // the name is text, not the editor's door
    expect(screen.queryByRole('button', { name: 'Actions for Orders' })).toBeNull(); // no tree: nothing to offer
    expect(await openMenu('Actions for Revenue')).toEqual(['Open tree']);
    cleanup();
    serveRpc(routes('editor'));
    renderApp(`/data/metrics?project=${P}`);
    expect(await screen.findByRole('button', { name: 'New metric' }, { timeout: LAZY })).toBeTruthy();
    expect(await openMenu('Actions for Orders')).toEqual(['Edit', 'Break it down…', 'Duplicate', 'Delete']);
  }, 30_000);

  it('a tree-less metric: a compact note, no Edit tree, no Add to dashboard, and no metricTree:suggest', async () => {
    const calls = serveRpc(routes('viewer'));
    renderApp(`/data/metrics/${P}/${M}/tree`);
    expect(await screen.findByRole('heading', { name: 'No tree yet' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByText('Revenue rose by 1.')).toBeTruthy();
    for (const name of ['Edit tree', 'Add to dashboard', 'Build it yourself']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(calls.some((c) => c.channel === 'metricTree:suggest')).toBe(false);
    cleanup();
    const editor = serveRpc(routes('editor'));
    renderApp(`/data/metrics/${P}/${M}/tree`);
    expect(await screen.findByRole('button', { name: 'Build it yourself' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit tree' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to dashboard' })).toBeTruthy();
    await waitFor(() => expect(editor.some((c) => c.channel === 'metricTree:suggest')).toBe(true));
  }, 30_000);
});
