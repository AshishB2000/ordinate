// Row access rules in the web app (docs/row-policy/00-design.md, UI): the Row
// access tab is a project ADMIN's — hidden, never disabled, for an editor or a
// viewer (each case has its admin control) — it edits and saves the rules; a
// viewer the rules restrict sees the chip and the designed off states; a
// refused figure says so in the refusal state, with no "Make a copy".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { isRowRefusal, liveRefusalOf } from '../live/refusal';
import { LiveRefusal } from '../live/LiveOff';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const TEAM = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = 15_000;

const ORDERS = { id: D, name: 'Orders', sourceKind: 'csv', rowCount: 3, columnCount: 2, updatedAt: '2026-10-01T10:00:00Z' };
const COLS = { id: D, name: 'Orders', rowCount: 3, columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }] };
const POLICY = { ok: true, policy: { column: 'region', rules: [{ teamId: TEAM, values: ['East'] }] }, state: 'ok', builtFrom: [] };

const routes = (role: string, extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
  'projects:roles': { body: { [P]: role } },
  'dataset:list': { body: [ORDERS] },
  'dataset:columns': { body: COLS },
  'dataset:source': { body: { kind: 'csv', label: 'CSV', refreshable: false } },
  'dataset:page': { body: { ok: true, rows: [], total: 0, offset: 0 } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'lineage:get': { body: null },
  'dataset:rowPolicy': { body: POLICY },
  'project:shareTargets': { body: { users: [{ id: '4b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', email: 'west@acme.test' }], teams: [{ id: TEAM, name: 'East' }] } },
  'dataset:distinct': { body: { values: ['East', 'West'], total: 2 } },
  ...extra,
});

describe('the Row access tab', () => {
  it('is an admin\'s: hidden from an editor and a viewer, who never ask for the rules', async () => {
    for (const role of ['editor', 'viewer']) {
      const calls = serveRpc(routes(role));
      renderApp(`/data/${P}/${D}`);
      expect(await screen.findByRole('tab', { name: 'Data' }, { timeout: LAZY })).toBeTruthy();
      expect(screen.queryByRole('tab', { name: 'Row access' })).toBeNull();
      expect(calls.some((c) => c.channel === 'dataset:rowPolicy')).toBe(false);
      cleanup();
    }
    // Negative control: an admin has the tab.
    serveRpc(routes('admin'));
    renderApp(`/data/${P}/${D}`);
    expect(await screen.findByRole('tab', { name: 'Row access' }, { timeout: LAZY })).toBeTruthy();
  }, 30_000);

  it('shows the saved rules and who sees what, and saves an edit', async () => {
    const calls = serveRpc(routes('admin', { 'dataset:setRowPolicy': { body: { ok: true, policy: null } } }));
    renderApp(`/data/${P}/${D}?tab=access`);
    expect(await screen.findByText('East', { selector: 'span' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByText(/Editors and admins see every row/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true); // nothing changed yet
    fireEvent.click(screen.getByRole('button', { name: 'Remove East' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Type a value' }), { target: { value: 'North' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.some((c) => c.channel === 'dataset:setRowPolicy')).toBe(true));
    const sent = calls.find((c) => c.channel === 'dataset:setRowPolicy')!.payload as { policy: { column: string; rules: unknown[] } };
    expect(sent.policy).toEqual({ column: 'region', rules: [{ teamId: TEAM, values: ['North'] }] });
  }, 30_000);

  it('says when the saved rules no longer hold', async () => {
    serveRpc(routes('admin', { 'dataset:rowPolicy': { body: { ...POLICY, state: 'writers' } } }));
    renderApp(`/data/${P}/${D}?tab=access`);
    expect(await screen.findByText(/changed since these rules were saved/, {}, { timeout: LAZY })).toBeTruthy();
  }, 30_000);

  it('with no rules: the empty state, and Add rules starts one', async () => {
    serveRpc(routes('admin', { 'dataset:rowPolicy': { body: { ...POLICY, policy: null } } }));
    renderApp(`/data/${P}/${D}?tab=access`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add rules' }, { timeout: LAZY }));
    expect(screen.getByRole('combobox', { name: 'Who' })).toBeTruthy();
  }, 30_000);
});

describe('a viewer the rules restrict', () => {
  it('sees the chip, and Quality is the designed off state (never asked)', async () => {
    const calls = serveRpc(routes('viewer', { 'dataset:columns': { body: { ...COLS, scoped: true } } }));
    renderApp(`/data/${P}/${D}?tab=quality`);
    expect(await screen.findByText('Rows limited to your access', {}, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByText('Quality checks are off for your access')).toBeTruthy();
    expect(calls.some((c) => c.channel === 'quality:list')).toBe(false);
    cleanup();
    // Negative control: unscoped, no chip.
    serveRpc(routes('viewer', { 'quality:list': { body: { ok: true, rules: [], latest: null, history: [] } } }));
    renderApp(`/data/${P}/${D}?tab=quality`);
    expect(await screen.findByRole('tab', { name: 'Quality' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.queryByText('Rows limited to your access')).toBeNull();
  }, 30_000);
});

describe('a refused figure', () => {
  const refusal = { ok: false, code: 'row_policy', reason: 'reader', error: 'This reads the whole dataset, and your access covers only some of its rows, so it\'s off for you.' };
  it('is recognised, and drawn about access with no Make a copy', () => {
    expect(isRowRefusal(refusal)).toBe(true);
    expect(liveRefusalOf(refusal)).toBe(refusal.error);
    expect(isRowRefusal({ ok: false, code: 'live_dataset', error: 'Live.' })).toBe(false); // control
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <LiveRefusal message={refusal.error} projectId={P} datasetId={D} row />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Limited by your access')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
  });
});
