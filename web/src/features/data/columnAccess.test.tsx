// Who sees each column (semantic layer part 4, step 07) on the dataset's Access tab — a project ADMIN's: the
// ruled columns and the carriers the server added (read-only), editing a rule (only the admin's own rules are
// sent, never a carrier), Save again when the rules no longer hold, a suggestion for a marked column, and a
// remove that asks first. The negative controls: the empty reply draws the empty state and no rows; an editor
// never sees the tab or asks for the rules.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const HR = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const FIN = '5b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = 15_000;

const STAFF = { id: D, name: 'Staff', sourceKind: 'csv', rowCount: 3, columnCount: 4, updatedAt: '2026-10-01T10:00:00Z' };
const COLS = { id: D, name: 'Staff', rowCount: 3, columns: [{ name: 'dept', type: 'text' }, { name: 'salary', type: 'number' }, { name: 'ssn', type: 'text' }, { name: 'bonus_pct', type: 'number' }] };
const RULED = {
  ok: true,
  rules: [{ column: 'salary', visibleTo: [{ teamId: HR }] }, { column: 'bonus_pct', visibleTo: [{ teamId: HR }], from: 'salary' }],
  state: 'ok',
  suggest: [],
  builtFrom: [{ id: '6b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', name: 'Pay summary' }],
};
const NONE = { ok: true, rules: [], state: 'none', suggest: [], builtFrom: [] };

const routes = (role: string, extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:list': { body: [{ id: P, name: 'People', createdAt: '', updatedAt: '' }] },
  'projects:roles': { body: { [P]: role } },
  'dataset:list': { body: [STAFF] },
  'dataset:columns': { body: COLS },
  'dataset:source': { body: { kind: 'csv', label: 'CSV', refreshable: false } },
  'dataset:page': { body: { ok: true, rows: [], total: 0, offset: 0 } },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'lineage:get': { body: null },
  'dataset:rowPolicy': { body: { ok: true, policy: null, state: 'ok', builtFrom: [] } },
  'dataset:columnAccess': { body: RULED },
  'project:shareTargets': { body: { users: [{ id: '4b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', email: 'ana@acme.test' }], teams: [{ id: HR, name: 'HR' }, { id: FIN, name: 'Finance' }] } },
  ...extra,
});

const section = async () => within(await screen.findByRole('region', { name: 'Who sees each column' }, { timeout: LAZY }));
const sent = (calls: { channel: string; payload: unknown }[]) => calls.filter((c) => c.channel === 'dataset:setColumnAccess').map((c) => (c.payload as { columns: unknown }).columns);
const pick = (box: HTMLElement, text: string) => {
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
};

describe('who sees each column', () => {
  it('lists each ruled column and the carrier the server added, which has no edit', async () => {
    serveRpc(routes('admin'));
    renderApp(`/data/${P}/${D}?tab=access`);
    const s = await section();
    expect(await s.findByText('salary', {}, { timeout: LAZY })).toBeTruthy();
    expect(s.getByText('bonus_pct')).toBeTruthy();
    expect(s.getAllByText('Only: HR')).toHaveLength(2);
    expect(s.getByText('(hidden too: computed from salary)')).toBeTruthy();
    expect(s.getByRole('button', { name: 'Edit who sees salary' })).toBeTruthy();
    expect(s.queryByRole('button', { name: 'Edit who sees bonus_pct' })).toBeNull();
    expect(s.queryByRole('button', { name: 'Stop hiding bonus_pct' })).toBeNull();
    expect(s.getByText('Pay summary')).toBeTruthy();
  }, 30_000);

  it('saves an edit with the admin\'s own rules only, never a carrier', async () => {
    const calls = serveRpc(routes('admin', { 'dataset:setColumnAccess': { body: { ok: true, rules: [] } } }));
    renderApp(`/data/${P}/${D}?tab=access`);
    fireEvent.click((await section()).getByRole('button', { name: 'Edit who sees salary' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Who sees salary' }));
    pick(dlg.getByRole('combobox', { name: 'Add a person or team' }), 'Finance');
    expect(dlg.getByText('Finance')).toBeTruthy();
    fireEvent.click(dlg.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(sent(calls)).toHaveLength(1));
    expect(sent(calls)[0]).toEqual([{ column: 'salary', visibleTo: [{ teamId: HR }, { teamId: FIN }] }]);
  }, 30_000);

  it('hides a new column: pick it and a team, and the rules sent are the old ones plus it', async () => {
    const calls = serveRpc(routes('admin', { 'dataset:setColumnAccess': { body: { ok: true, rules: [] } } }));
    renderApp(`/data/${P}/${D}?tab=access`);
    fireEvent.click((await section()).getByRole('button', { name: 'Hide a column…' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Hide a column' }));
    fireEvent.click(dlg.getByRole('combobox', { name: 'Column' }));
    // Ruled columns and carriers are not offered again.
    expect(screen.queryByRole('option', { name: 'salary' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'bonus_pct' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'ssn' }));
    pick(dlg.getByRole('combobox', { name: 'Add a person or team' }), 'HR');
    fireEvent.click(dlg.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(sent(calls)).toHaveLength(1));
    expect(sent(calls)[0]).toEqual([{ column: 'salary', visibleTo: [{ teamId: HR }] }, { column: 'ssn', visibleTo: [{ teamId: HR }] }]);
  }, 30_000);

  it('says when a Prepare step changed, and Save again sends the same rules', async () => {
    const calls = serveRpc(routes('admin', { 'dataset:columnAccess': { body: { ...RULED, state: 'pipeline' } }, 'dataset:setColumnAccess': { body: { ok: true, rules: [] } } }));
    renderApp(`/data/${P}/${D}?tab=access`);
    const s = await section();
    expect(await s.findByText(/A Prepare step that reads a hidden column changed/, {}, { timeout: LAZY })).toBeTruthy();
    fireEvent.click(s.getByRole('button', { name: 'Save again' }));
    await vi.waitFor(() => expect(sent(calls)).toHaveLength(1));
    expect(sent(calls)[0]).toEqual([{ column: 'salary', visibleTo: [{ teamId: HR }] }]);
  }, 30_000);

  it('names a hidden column the dataset no longer has', async () => {
    serveRpc(routes('admin', { 'dataset:columnAccess': { body: { ...RULED, rules: [{ column: 'pay', visibleTo: [] }], state: 'gone' } } }));
    renderApp(`/data/${P}/${D}?tab=access`);
    expect(await (await section()).findByText(/pay is no longer a column of this dataset/, {}, { timeout: LAZY })).toBeTruthy();
  }, 30_000);

  it('suggests a marked column, and one click hides it from every viewer', async () => {
    const calls = serveRpc(routes('admin', { 'dataset:columnAccess': { body: { ...RULED, suggest: ['ssn'] } }, 'dataset:setColumnAccess': { body: { ok: true, rules: [] } } }));
    renderApp(`/data/${P}/${D}?tab=access`);
    const s = await section();
    expect(await s.findByText(/ssn is marked sensitive/, {}, { timeout: LAZY })).toBeTruthy();
    fireEvent.click(s.getByRole('button', { name: 'Hide ssn' }));
    await vi.waitFor(() => expect(sent(calls)).toHaveLength(1));
    expect(sent(calls)[0]).toEqual([{ column: 'salary', visibleTo: [{ teamId: HR }] }, { column: 'ssn', visibleTo: [] }]);
  }, 30_000);

  it('asks before it stops hiding a column, and sends nothing until confirmed', async () => {
    const calls = serveRpc(routes('admin', { 'dataset:setColumnAccess': { body: { ok: true, rules: [] } } }));
    renderApp(`/data/${P}/${D}?tab=access`);
    fireEvent.click((await section()).getByRole('button', { name: 'Stop hiding salary' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Stop hiding salary?' }));
    expect(sent(calls)).toHaveLength(0);
    fireEvent.click(dlg.getByRole('button', { name: 'Stop hiding' }));
    await vi.waitFor(() => expect(sent(calls)).toHaveLength(1));
    expect(sent(calls)[0]).toBeNull();
  }, 30_000);

  it('NEGATIVE CONTROL: with no rules, the empty state and no rows', async () => {
    serveRpc(routes('admin', { 'dataset:columnAccess': { body: NONE } }));
    renderApp(`/data/${P}/${D}?tab=access`);
    const s = await section();
    expect(await s.findByText('Every column is visible to everyone who can open this dataset.', {}, { timeout: LAZY })).toBeTruthy();
    expect(s.queryByRole('list', { name: 'Hidden columns' })).toBeNull();
    expect(s.getByRole('button', { name: 'Hide a column…' })).toBeTruthy();
  }, 30_000);

  it('NEGATIVE CONTROL: an editor has no Access tab and never asks for the column rules', async () => {
    const calls = serveRpc(routes('editor'));
    renderApp(`/data/${P}/${D}?tab=access`);
    expect(await screen.findByRole('tab', { name: 'Data' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Access' })).toBeNull();
    expect(calls.some((c) => c.channel === 'dataset:columnAccess')).toBe(false);
    cleanup();
  }, 30_000);
});
