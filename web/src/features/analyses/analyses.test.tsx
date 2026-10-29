import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { buildParam } from './ParamDialog';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const A1 = '33333333-3333-4333-8333-333333333333';
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

// The list itself is the Dashboards page now (dashboards/list/dashboardList.test.tsx); its wizard is still this feature's.
describe('the new-dashboard wizard, from the list', () => {
  it('a failed dataset list is an error with a retry, not “no datasets yet”', async () => {
    serve(base({ 'analysis:gallery': { body: [] }, 'dataset:list': { status: 500, body: { error: 'boom' } } }));
    renderApp(`/dashboards?project=${PID}&new=1`);
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
