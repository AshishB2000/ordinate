import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { buildParam } from './ParamDialog';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const A1 = '33333333-3333-4333-8333-333333333333';
const A2 = '44444444-4444-4444-8444-444444444444';
const M1 = '55555555-5555-4555-8555-555555555555';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };
const PROJECT = { id: PID, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 2, sample: false };
const TAGS = { ok: true, tags: [{ name: 'finance', color: 2, count: 2 }], refs: { [`analysis:${A1}`]: ['finance'], [`metric:${M1}`]: ['finance'] } };
const NO_MODEL = { ready: false, reason: 'no_model', models: [], mine: null, keyStore: null };

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
  'dataset:list': { body: [{ id: DID, name: 'Orders', sourceKind: 'csv', rowCount: 120, columnCount: 3, updatedAt: '2026-10-01T10:00:00Z' }] },
  'catalog:tags': { body: TAGS },
  'ai:status': { body: NO_MODEL },
  ...extra,
});

const board = (id: string, name: string) => ({ id, name, sheetCount: 1, updatedAt: '2026-10-01T10:00:00Z', previews: [], sheets: [{ id: A1, name: 'Overview' }] });

describe('Analyses list', () => {
  it('shows each dashboard’s catalog tags and narrows the grid to one tag', async () => {
    serve(base({ 'analysis:gallery': { body: [board(A1, 'Revenue board'), board(A2, 'Ops board')] } }));
    renderApp(`/analyses?project=${PID}`);
    const list = await screen.findByRole('list', { name: 'Dashboards' });
    expect(within(list).getByText('Ops board')).toBeTruthy();
    const bar = await screen.findByRole('toolbar', { name: 'Filter by tag' });
    fireEvent.click(within(bar).getByRole('button', { name: 'finance' }));
    expect(within(screen.getByRole('list', { name: 'Dashboards' })).queryByText('Ops board')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Dashboards' })).getByText('Revenue board')).toBeTruthy();
  });

  it('shuts the Assistant’s doors with no model, and sends an admin to Admin → AI', async () => {
    serve(base({ 'analysis:gallery': { body: [] } }));
    renderApp(`/analyses?project=${PID}`);
    await screen.findByRole('heading', { name: 'No dashboards yet' });
    await screen.findByText(/AI isn’t set up for your organization yet/);
    for (const b of screen.getAllByRole('button', { name: 'Draft with the Assistant' })) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect((await screen.findByRole('link', { name: /Set up AI/ })).getAttribute('href')).toBe('/admin?tab=ai');
  });

  it('shows a viewer the dashboards without Create, Rename or Delete — and an editor all three', async () => {
    const gallery = { 'analysis:gallery': { body: [board(A1, 'Revenue board')] } };
    serve(base({ ...gallery, 'projects:roles': { body: { [PID]: 'viewer' } } }));
    renderApp(`/analyses?project=${PID}`);
    await screen.findByRole('list', { name: 'Dashboards' });
    await screen.findByRole('link', { name: /Metrics/ });
    expect(screen.queryByRole('button', { name: 'Create dashboard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Draft with the Assistant' })).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Dashboard options' }), { button: 0, ctrlKey: false });
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Open', 'History', 'Lineage']);
    cleanup();
    serve(base(gallery)); // the base role is admin
    renderApp(`/analyses?project=${PID}`);
    expect(await screen.findByRole('button', { name: 'Create dashboard' })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Dashboard options' }), { button: 0, ctrlKey: false });
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Open', 'Rename', 'History', 'Lineage', 'Delete']);
  });

  it('a viewer following a “New dashboard” link gets no wizard, and is told who can build one', async () => {
    serve(base({ 'analysis:gallery': { body: [] }, 'projects:roles': { body: { [PID]: 'viewer' } } }));
    renderApp(`/analyses?project=${PID}&new=1&dataset=${DID}`);
    expect(await screen.findByText(/An editor of this project can build dashboards/)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Create dashboard' })).toBeNull();
  });

  it('opens the wizard on “Start from” for a dataset named in the URL (a dataset page’s New dashboard)', async () => {
    serve(base({ 'analysis:gallery': { body: [] }, 'template:list': { body: { ok: true, datasetId: DID, datasetName: 'Orders', columns: [], templates: [] } } }));
    renderApp(`/analyses?project=${PID}&new=1&dataset=${DID}`);
    const wiz = await screen.findByRole('dialog', { name: 'Create dashboard' });
    expect(await within(wiz).findByRole('radiogroup', { name: 'Layouts' })).toBeTruthy();
    // No template fits these columns: said, not left blank.
    expect(await within(wiz).findByText(/No template fits this dataset/)).toBeTruthy();
  });

  it('a failed dataset list is an error with a retry, not “no datasets yet”', async () => {
    serve(base({ 'analysis:gallery': { body: [] }, 'dataset:list': { status: 500, body: { error: 'boom' } } }));
    renderApp(`/analyses?project=${PID}&new=1`);
    const wiz = await screen.findByRole('dialog', { name: 'Create dashboard' });
    expect(await within(wiz).findByRole('heading', { name: 'Datasets could not be loaded' })).toBeTruthy();
    expect(within(wiz).queryByText(/no datasets yet/)).toBeNull();
  });
});

describe('Metrics list', () => {
  it('carries each metric’s tags and filters by one', async () => {
    const m = (id: string, name: string) => ({ id, name, datasetId: DID, datasetName: 'Orders', definitionText: `sum of ${name}`, format: { kind: 'number' }, description: '' });
    const M2 = '66666666-6666-4666-8666-666666666666';
    serve(base({ 'metric:table': { body: { ok: true, metrics: [m(M1, 'Revenue'), m(M2, 'Units')], rows: { [M1]: { display: '$5', series: null, usage: null }, [M2]: { display: '7', series: null, usage: null } } } } }));
    renderApp(`/data/metrics?project=${PID}`);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Units')).toBeTruthy();
    fireEvent.click(within(await screen.findByRole('toolbar', { name: 'Filter by tag' })).getByRole('button', { name: 'finance' }));
    expect(within(screen.getByRole('table')).queryByText('Units')).toBeNull();
    expect(within(screen.getByRole('table')).getByText('$5')).toBeTruthy();
  });
});

describe('buildParam (paramDialog.ts validation)', () => {
  const f = (o: Partial<Parameters<typeof buildParam>[0]>) => ({ name: 'min', kind: 'number' as const, value: '5', min: '0', max: '10', step: '1', options: '', ...o });
  const free = () => false;
  it('keeps a valid number parameter with its bounds', () => {
    expect(buildParam(f({}), free).param).toEqual({ name: 'min', kind: 'number', value: 5, min: 0, max: 10, step: 1 });
  });
  it('refuses a bad name, a clash, inverted bounds, a default outside them and a zero step', () => {
    expect(buildParam(f({ name: '1x' }), free).error).toMatch(/starts with a letter/);
    expect(buildParam(f({}), (n) => n.toLowerCase() === 'min').error).toMatch(/already has/);
    expect(buildParam(f({ min: '9', max: '1' }), free).error).toMatch(/minimum is above/);
    expect(buildParam(f({ value: '50' }), free).error).toMatch(/outside the bounds/);
    expect(buildParam(f({ step: '0' }), free).error).toMatch(/above zero/);
  });
  it('a text default must be one of its options; a list splits on commas', () => {
    expect(buildParam(f({ kind: 'text', value: 'z', options: 'a\nb' }), free).error).toMatch(/not one of the options/);
    expect(buildParam(f({ kind: 'list', value: 'a, b', options: '' }), free).param?.value).toEqual(['a', 'b']);
  });
});
