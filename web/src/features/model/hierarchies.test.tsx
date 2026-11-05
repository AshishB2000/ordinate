import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import type { Navigation, NavHierarchy } from './navigation';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const H1 = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };

const GEO: NavHierarchy = { id: H1, name: 'Geography', levels: ['region', 'state'] };
const COLUMNS = ['region', 'state', 'city', 'category', 'sub_category'].map((name) => ({ name, type: 'text' as const })).concat([{ name: 'amount', type: 'number' as never }]);
const nav = (hierarchies: NavHierarchy[], dateLadder: Navigation['dateLadder'] = ['year', 'quarter', 'month', 'day']): Navigation => ({
  ok: true, tables: hierarchies.length ? [{ datasetId: D, hierarchies }] : [], dateLadder,
});

function serve(opts: { role?: 'editor' | 'viewer'; nav?: Navigation; routes?: Record<string, RpcReply> } = {}) {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: opts.role ?? 'editor' }),
    'dataset:list': body([{ id: D, name: 'Orders', sourceKind: 'csv', rowCount: 10, columnCount: 6, updatedAt: '' }]),
    'model:overview': body({ ok: true, tables: [{ datasetId: D, role: 'fact', key: '', keyState: '', description: '', alwaysApplied: { kind: 'prepare', steps: [] }, calculated: [] }], todo: [], more: 0 }),
    'model:navigation': body(opts.nav ?? nav([GEO])),
    'catalog:getTable': body({ ok: true, table: { role: 'fact', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '' } }),
    'catalog:setTable': body({ ok: true, table: {} }),
    'dataset:columns': body({ id: D, name: 'Orders', rowCount: 10, columns: COLUMNS }),
    'quality:list': body({ ok: true, rules: [], latest: null, history: [] }),
    'catalog:columns': body({ ok: true, columns: {} }),
    'lineage:get': body(null),
    'dataset:stats': body({ ok: true, summaries: [] }),
    ...opts.routes,
  });
}
const open = () => renderApp(`/model/${P}?dataset=${D}&panel=fields`);
const block = () => screen.findByRole('region', { name: 'Hierarchies' }, LAZY);
const addLevel = async (dialog: HTMLElement, column: string) => {
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Add level' }));
  fireEvent.click(await screen.findByRole('option', { name: column }));
};

describe('The Data model: hierarchies on the Fields tab', () => {
  it('draws each hierarchy as its name and its levels, and the date ladder under them', async () => {
    serve();
    open();
    const b = await block();
    expect(await within(b).findByText('Geography')).toBeTruthy();
    expect(within(b).getByText('region › state')).toBeTruthy();
    expect(within(b).getByText('Dates drill by themselves: year › quarter › month › day')).toBeTruthy();
  });

  it('under a week calendar the ladder reads period and week', async () => {
    serve({ nav: nav([GEO], ['year', 'quarter', 'month', 'week', 'day']) });
    open();
    expect(await within(await block()).findByText('Dates drill by themselves: year › quarter › period › week › day')).toBeTruthy();
  });

  it('+ Hierarchy saves the whole list, levels in order; a number column is not offered', async () => {
    const calls = serve({ nav: nav([GEO]) });
    open();
    const b = await block();
    fireEvent.click(await within(b).findByRole('button', { name: 'Hierarchy' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Product' } });
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Add level' }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).not.toContain('amount');
    expect(names).toContain('city');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await addLevel(dialog, 'category');
    await addLevel(dialog, 'sub_category');
    expect(within(dialog).getAllByRole('listitem').map((li) => li.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('category'), expect.stringContaining('sub_category')]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'catalog:setTable')).toBe(true));
    const sent = calls.find((c) => c.channel === 'catalog:setTable')!.payload as { patch: { hierarchies: unknown } };
    expect(sent.patch.hierarchies).toEqual([{ id: H1, name: 'Geography', levels: ['region', 'state'] }, { name: 'Product', levels: ['category', 'sub_category'] }]);
  });

  it('a column in another hierarchy is disabled, with whose it is', async () => {
    serve();
    open();
    fireEvent.click(await within(await block()).findByRole('button', { name: 'Hierarchy' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Add level' }));
    const taken = await screen.findByRole('option', { name: /^region/ });
    expect(taken.textContent).toContain('Already a level of Geography');
    expect(taken.getAttribute('aria-disabled')).toBe('true');
  });

  it('a refusal keeps the dialog open and says the server\'s sentence', async () => {
    serve({ routes: { 'catalog:setTable': { body: { ok: false, error: 'Hierarchy levels are text columns. amount is a number column.' } } } });
    open();
    fireEvent.click(await within(await block()).findByRole('button', { name: 'Hierarchy' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'X' } });
    await addLevel(dialog, 'city');
    await addLevel(dialog, 'category');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Hierarchy levels are text columns. amount is a number column.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a level that is gone is warned, and the hierarchy stays editable', async () => {
    serve({ nav: nav([{ ...GEO, levels: ['region', 'city'], missing: ['city'] }]) });
    open();
    const b = await block();
    expect(await within(b).findByText('city is no longer a text column')).toBeTruthy();
    expect(within(b).getByRole('button', { name: 'Edit Geography' })).toBeTruthy();
  });

  it('Remove sends the list without it', async () => {
    const calls = serve();
    open();
    fireEvent.click(await within(await block()).findByRole('button', { name: 'Remove Geography' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'catalog:setTable')?.payload).toEqual({ projectId: P, datasetId: D, patch: { hierarchies: [] } }));
  });

  it('empty: an editor is told what a hierarchy is and can add one', async () => {
    serve({ nav: nav([]) });
    open();
    const b = await block();
    expect(await within(b).findByText('Group levels like region › state so charts can drill from one to the next.')).toBeTruthy();
    expect(within(b).getByRole('button', { name: 'Hierarchy' })).toBeTruthy();
  });

  it('NEGATIVE CONTROL: a viewer reads them and gets no way to change them', async () => {
    serve({ role: 'viewer' });
    open();
    const b = await block();
    expect(await within(b).findByText('Geography')).toBeTruthy();
    expect(within(b).queryByRole('button', { name: 'Hierarchy' })).toBeNull();
    expect(within(b).queryByRole('button', { name: 'Edit Geography' })).toBeNull();
    expect(within(b).queryByRole('button', { name: 'Remove Geography' })).toBeNull();
  });

  it('a viewer with none reads a plain empty line', async () => {
    serve({ role: 'viewer', nav: nav([]) });
    open();
    const b = await block();
    expect(await within(b).findByText('No hierarchies yet')).toBeTruthy();
    expect(within(b).queryByRole('button', { name: 'Hierarchy' })).toBeNull();
  });

  it('an old server without model:navigation shows the error state, and Try again asks again', async () => {
    const calls = serve({ routes: { 'model:navigation': { status: 404, body: { error: 'not_found', message: 'Unknown channel' } } } });
    open();
    const b = await block();
    expect((await within(b).findByRole('alert')).textContent).toContain('The hierarchies could not be loaded');
    fireEvent.click(within(b).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'model:navigation').length).toBeGreaterThan(1));
  });
});
