import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { todoText, type ModelOverview, type ModelTable, type TodoItem } from './api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const O = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const R = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
/** The Data model is a lazy chunk: its first render waits on a transform (long under load). */
const LAZY = { timeout: 15_000 };

const ds = (id: string, name: string) => ({ id, name, sourceKind: 'csv', rowCount: 10, columnCount: 3, updatedAt: '2026-10-01T10:00:00Z' });
const table = (datasetId: string, more: Partial<ModelTable> = {}): ModelTable => ({
  datasetId, role: '', key: '', keyState: '', description: '', alwaysApplied: { kind: 'prepare', steps: [] }, calculated: [], ...more,
});
const ORDERS = table(O, { role: 'fact', key: 'order_id', keyState: 'repeats', description: 'One row per order line' });
const REGIONS = table(R, { role: 'dimension' });
const TODO: TodoItem[] = [
  { datasetId: O, kind: 'key_repeats', repeats: 12 },
  { datasetId: R, kind: 'no_key' },
  { datasetId: R, kind: 'no_guide' },
  { datasetId: R, kind: 'no_description' },
];
const overview = (more: Partial<ModelOverview> = {}): ModelOverview => ({ ok: true, tables: [ORDERS, REGIONS], todo: TODO, more: 3, ...more });

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor') {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 2, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'dataset:list': body([ds(O, 'Orders'), ds(R, 'Regions')]),
    'model:overview': body(overview()),
    'catalog:getTable': body({ ok: true, table: { role: '', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '' } }),
    'dataset:columns': body({ id: O, name: 'Orders', rowCount: 10, columns: [{ name: 'order_id', type: 'text' }] }),
    'quality:list': body({ ok: true, rules: [], latest: null }),
    'catalog:columns': body({ ok: true, columns: {} }),
    'lineage:get': body(null),
    ...routes,
  });
}
const strip = () => screen.findByRole('region', { name: 'To fill in next' }, LAZY);
const nav = () => screen.findByRole('navigation', { name: 'Datasets' }, LAZY);

describe('The Data model: datasets', () => {
  it('/model lands on the current project', async () => {
    serve();
    const router = renderApp('/model');
    await waitFor(() => expect(router.state.location.pathname).toBe(`/model/${P}`), LAZY);
    expect(await screen.findByRole('heading', { level: 1, name: 'Data model' }, LAZY)).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('lists the datasets under their role, and flags a key that repeats', async () => {
    serve();
    renderApp(`/model/${P}`);
    const list = await nav();
    const captions = within(list).getAllByRole('list').map((l) => document.getElementById(l.getAttribute('aria-labelledby') ?? '')?.textContent);
    expect(captions).toEqual(['Facts', 'Dimensions']);
    const orders = within(list).getByRole('link', { name: /Orders/ });
    expect(within(orders).getByText('key repeats')).toBeTruthy();
    expect(within(list).getByRole('link', { name: 'Regions' }).textContent).not.toContain('key repeats');
    // Nothing picked: the first one listed is, and its panel says what the server said.
    expect(orders.getAttribute('aria-current')).toBe('true');
    const panel = screen.getByRole('region', { name: 'About Orders' });
    expect(within(panel).getByRole('heading', { level: 2, name: 'Orders' })).toBeTruthy();
    expect(within(panel).getByText('Fact')).toBeTruthy();
    expect(within(panel).getByText('One row per order line')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Open dataset' }).getAttribute('href')).toBe(`/data/${P}/${O}`);
  });

  it('shows the server\'s four gaps and how many more, worded; a click opens the dataset where it is filled in', async () => {
    serve();
    const router = renderApp(`/model/${P}`);
    const s = await strip();
    const buttons = within(s).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Orders: 12 keys repeat', 'Set a key on Regions', 'Write a guide for Regions', 'Describe Regions']);
    expect(within(s).getByText('+3 more')).toBeTruthy();
    fireEvent.click(within(s).getByRole('button', { name: 'Write a guide for Regions' }));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('panel')).toBe('guide'));
    expect(new URLSearchParams(router.state.location.search).get('dataset')).toBe(R);
    expect(await screen.findByRole('heading', { level: 2, name: 'Regions' })).toBeTruthy();
    expect(within(await nav()).getByRole('link', { name: 'Regions' }).getAttribute('aria-current')).toBe('true');
  });

  it('draws no strip when nothing is missing', async () => {
    serve({ 'model:overview': { body: overview({ todo: [], more: 0 }) } });
    renderApp(`/model/${P}`);
    await nav();
    expect(screen.queryByRole('region', { name: 'To fill in next' })).toBeNull();
  });

  it('NEGATIVE CONTROL: a viewer gets no strip, even with gaps', async () => {
    const calls = serve({}, 'viewer');
    renderApp(`/model/${P}`);
    await nav();
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    await screen.findByRole('region', { name: 'About Orders' });
    expect(screen.queryByRole('region', { name: 'To fill in next' })).toBeNull();
  });

  it('an old server without model:overview shows the error state, and Retry asks again', async () => {
    const calls = serve({ 'model:overview': { status: 404, body: { error: 'not_found', message: 'Unknown channel' } } });
    renderApp(`/model/${P}`);
    const alert = await screen.findByRole('alert', {}, LAZY);
    expect(alert.textContent).toContain('The data model could not be loaded');
    expect(calls.filter((c) => c.channel === 'model:overview')).toHaveLength(1);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'model:overview')).toHaveLength(2));
  });

  it('a project with no datasets says so, and an editor gets the way in', async () => {
    serve({ 'dataset:list': { body: [] }, 'model:overview': { body: overview({ tables: [], todo: [], more: 0 }) } });
    renderApp(`/model/${P}`);
    expect(await screen.findByRole('heading', { name: 'No datasets to describe yet' }, LAZY)).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'Import file' })).getAttribute('href')).toBe(`/data/import?project=${P}`);
  });

  it('a viewer of an empty project is told who can bring data in', async () => {
    serve({ 'dataset:list': { body: [] }, 'model:overview': { body: overview({ tables: [], todo: [], more: 0 }) } }, 'viewer');
    renderApp(`/model/${P}`);
    expect(await screen.findByText('An editor of this project can bring data in.', {}, LAZY)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Import file' })).toBeNull();
  });

  it('loads as skeletons, not a blank', async () => {
    serve({ 'model:overview': () => new Promise(() => {}) as never });
    renderApp(`/model/${P}`);
    expect(await screen.findByRole('status', { name: 'Loading the data model' }, LAZY)).toBeTruthy();
  });

  it('the nav has Data model right after Data', async () => {
    serve();
    renderApp(`/model/${P}`);
    const link = await screen.findByRole('link', { name: 'Data model' }, LAZY);
    expect(link.getAttribute('href')).toBe('/model');
  });
});

describe('todoText', () => {
  it('words each kind, and one repeating key in the singular', () => {
    const t = (kind: TodoItem['kind'], repeats?: number) => todoText({ datasetId: O, kind, repeats }, 'Orders');
    expect([t('key_repeats', 12), t('key_repeats', 1), t('no_key'), t('no_guide'), t('no_description'), t('no_role')]).toEqual([
      'Orders: 12 keys repeat',
      'Orders: 1 key repeats',
      'Set a key on Orders',
      'Write a guide for Orders',
      'Describe Orders',
      'Set a role for Orders',
    ]);
    expect(t('key_repeats', 1234)).toBe('Orders: 1,234 keys repeat');
  });
});
