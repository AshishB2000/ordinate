import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import type { Lineage } from '../data/api';
import type { TableDoc } from '../data/tableApi';
import { stepSummary } from '../visuals/filters/filterText';
import type { ModelOverview, ModelTable } from './api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };

const STEP = { type: 'filter' as const, column: 'is_test', op: '=' as const, value: 'yes' };
const doc = (more: Partial<TableDoc> = {}): TableDoc => ({ role: 'fact', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '', ...more });
const table = (more: Partial<ModelTable> = {}): ModelTable => ({
  datasetId: D, role: 'fact', key: '', keyState: '', description: '', alwaysApplied: { kind: 'prepare', steps: [STEP] }, calculated: [{ name: 'double', formula: '[amt] * 2' }], ...more,
});
const LINEAGE: Lineage = {
  nodes: [{ id: `dataset:${D}`, kind: 'dataset', name: 'Orders', sub: '', ref: { type: 'dataset', id: D }, col: 0, row: 0 }],
  edges: [], focus: `dataset:${D}`, usedIn: { visual: 3, dashboard: 1 }, columns: 1, upstream: 0,
};

function serve(opts: { live?: boolean; role?: 'editor' | 'viewer'; table?: Partial<ModelTable>; doc?: Partial<TableDoc>; routes?: Record<string, RpcReply> } = {}) {
  const body = (b: unknown) => ({ body: b });
  const live = opts.live ? { mode: 'live' as const } : {};
  const ov = (): ModelOverview => ({ ok: true, tables: [table(opts.table)], todo: [], more: 0 });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: opts.role ?? 'editor' }),
    'dataset:list': body([{ id: D, name: 'Orders', sourceKind: 'csv', rowCount: 10, columnCount: 2, updatedAt: '', ...live }]),
    'model:overview': body(ov()),
    'catalog:getTable': body({ ok: true, table: doc(opts.doc) }),
    'catalog:setTable': (payload) => ({ body: { ok: true, table: doc({ ...opts.doc, ...(payload as { patch: Partial<TableDoc> }).patch }) } }),
    'dataset:columns': body({ id: D, name: 'Orders', rowCount: 10, columns: [{ name: 'order_id', type: 'text' }, { name: 'email', type: 'text' }], ...live }),
    'quality:list': body({ ok: true, rules: [], latest: null, history: [] }),
    'catalog:columns': body({ ok: true, columns: { email: { sensitivity: 'personal' } } }),
    'lineage:get': body(LINEAGE),
    'dataset:stats': body({ ok: true, summaries: [] }),
    'dataset:liveSchema': body({ ok: true, columns: [] }),
    ...opts.routes,
  });
}
const open = (panel = '') => renderApp(`/model/${P}?dataset=${D}${panel ? `&panel=${panel}` : ''}`);
const tabpanel = (name: string) => screen.findByRole('tabpanel', { name }, LAZY);

describe('The Data model: a dataset\'s panel', () => {
  it('lays the Overview out as one row per fact, in order', async () => {
    serve();
    open();
    const p = await tabpanel('Overview');
    expect(within(p).getAllByRole('term').map((t) => t.textContent)).toEqual(['What one row is', 'Role', 'Key', 'Always applied', 'Quality', 'Access', 'Used by']);
    // The editor's fields, named by the row they sit in.
    expect(within(p).getByRole('group', { name: 'Role' })).toBeTruthy();
    expect(within(p).getByRole('combobox', { name: 'Key' })).toBeTruthy();
    expect(within(p).getByRole('textbox', { name: 'What one row is' })).toBeTruthy();
    expect(await within(p).findByText('Personal: email')).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('a copy\'s always-applied filter reads as the filter pill does, and opens Prepare', async () => {
    serve();
    open();
    const p = await tabpanel('Overview');
    expect(within(p).getByRole('listitem').textContent).toBe(`is_test ${stepSummary(STEP)}`);
    expect(stepSummary(STEP)).toBe('equals yes');
    expect(within(p).getByRole('link', { name: 'Open Prepare' }).getAttribute('href')).toBe(`/data/${P}/${D}/prepare`);
    expect((await within(p).findByRole('link', { name: 'Quality checks' })).getAttribute('href')).toBe(`/data/${P}/${D}?tab=quality`);
    expect(within(p).getByText('No checks yet')).toBeTruthy();
  });

  it('a Live dataset\'s base filters open its Schema tab', async () => {
    serve({ live: true, table: { alwaysApplied: { kind: 'live', steps: [STEP] }, calculated: [] } });
    open();
    const p = await tabpanel('Overview');
    expect(within(p).getByRole('link', { name: 'Open the Schema tab' }).getAttribute('href')).toBe(`/data/${P}/${D}?tab=schema`);
    expect(within(p).queryByRole('link', { name: 'Open Prepare' })).toBeNull();
  });

  it('hides the values row access rules hide, and keeps the column', async () => {
    serve({ table: { valuesHidden: true, alwaysApplied: { kind: 'prepare', steps: [{ type: 'filter', column: 'region', op: '=' }] }, calculated: [{ name: 'double', formula: '' }] } });
    open();
    const p = await tabpanel('Overview');
    expect(within(p).getByText('region · values hidden by row access rules')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Fields' }));
    const f = await tabpanel('Fields');
    expect(within(f).getByText('formula hidden')).toBeTruthy();
  });

  it('says what is built on it, in the server\'s counts, and "See lineage" opens the graph', async () => {
    serve();
    open();
    const p = await tabpanel('Overview');
    expect(await within(p).findByText('Used in 3 visuals · 1 dashboard')).toBeTruthy();
    fireEvent.click(within(p).getByRole('button', { name: 'See lineage' }));
    const l = await tabpanel('Lineage');
    expect(within(l).getByRole('group', { name: 'Lineage graph' })).toBeTruthy();
  });

  it('Fields: what Prepare calculates, then the column notes', async () => {
    serve();
    open('fields');
    const f = await tabpanel('Fields');
    const calc = within(f).getByRole('region', { name: 'Calculated in Prepare' });
    expect(within(calc).getByText('double')).toBeTruthy();
    expect(within(calc).getByText('[amt] * 2')).toBeTruthy();
    expect(await within(f).findByRole('region', { name: 'Column notes' })).toBeTruthy();
  });

  it('Fields: says what uses each field, in the server\'s counts', async () => {
    serve({ routes: { 'lineage:fields': { body: { ok: true, fields: { order_id: { usedIn: { metric: 2, visual: 6 } }, double: { usedIn: { term: 1 } } }, steps: [] } } } });
    open('fields');
    const f = await tabpanel('Fields');
    const row = async (c: string) => within(await within(f).findByRole('region', { name: 'Column notes' }, LAZY)).getByText(c).closest('tr')!;
    await waitFor(async () => expect((await row('order_id')).textContent).toContain('Used by 2 metrics · 6 visuals'));
    expect((await row('email')).textContent).toContain('Not used yet');
    expect(within(within(f).getByRole('region', { name: 'Calculated in Prepare' })).getByText('Used by 1 term')).toBeTruthy();
  });

  it('NEGATIVE CONTROL: with lineage:fields a 404, Used by reads \u2014 and the notes stay editable', async () => {
    serve({ routes: { 'lineage:fields': { status: 404, body: { error: 'nope' } } } });
    open('fields');
    const f = await tabpanel('Fields');
    const notes = await within(f).findByRole('region', { name: 'Column notes' }, LAZY);
    await waitFor(() => expect(within(notes).getAllByText('\u2014').length).toBeGreaterThanOrEqual(2));
    expect(within(notes).queryByText('Not used yet')).toBeNull();
    expect((within(notes).getByRole('textbox', { name: 'Description of email' }) as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it('Guide: the rendered article; a viewer is offered nothing to write', async () => {
    serve({ doc: { guide: '# Orders\n\nUse **net** revenue.' } });
    open('guide');
    const g = await tabpanel('Guide');
    expect(within(g).getByRole('heading', { name: 'Orders' })).toBeTruthy();
    expect(within(g).getByRole('button', { name: 'Edit' })).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    serve({ role: 'viewer', doc: { guide: '' } });
    open('guide');
    const v = await tabpanel('Guide');
    expect(within(v).getByText('Nobody has written a guide for this table.')).toBeTruthy();
    expect(within(v).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(v).queryByRole('button', { name: /^Write/ })).toBeNull();
  });

  it('a viewer reads the role and key as text', async () => {
    serve({ role: 'viewer', doc: { role: 'dimension', key: 'order_id' } });
    open();
    const p = await tabpanel('Overview');
    expect(within(p).getByText('Dimension')).toBeTruthy();
    expect(within(p).getByText('Key order_id · not checked yet')).toBeTruthy();
    for (const role of ['radio', 'combobox', 'textbox']) expect(within(p).queryAllByRole(role), role).toHaveLength(0);
  });

  it('saving a role reads the overview again, so the strip is never stale', async () => {
    const calls = serve();
    open();
    const p = await tabpanel('Overview');
    const reads = () => calls.filter((c) => c.channel === 'model:overview').length;
    await waitFor(() => expect(reads()).toBe(1));
    fireEvent.click(within(within(p).getByRole('group', { name: 'Role' })).getByRole('radio', { name: 'Dimension' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'catalog:setTable')).toBe(true));
    await waitFor(() => expect(reads()).toBe(2));
  });

  it('a Live dataset\'s panel asks no row channel on any tab', async () => {
    const calls = serve({ live: true, table: { alwaysApplied: { kind: 'live', steps: [] }, calculated: [] } });
    open();
    await tabpanel('Overview');
    for (const name of ['Fields', 'Guide', 'Lineage']) {
      fireEvent.mouseDown(screen.getByRole('tab', { name }));
      await tabpanel(name);
    }
    await screen.findByRole('group', { name: 'Lineage graph' });
    const rows = ['dataset:page', 'dataset:stats', 'dataset:profile', 'prepare:get'];
    expect(calls.filter((c) => rows.includes(c.channel)).map((c) => c.channel)).toEqual([]);
  });

  it('NEGATIVE CONTROL: a copy\'s Fields tab does read its column statistics', async () => {
    const calls = serve();
    open('fields');
    await tabpanel('Fields');
    await waitFor(() => expect(calls.some((c) => c.channel === 'dataset:stats')).toBe(true));
  });
});
