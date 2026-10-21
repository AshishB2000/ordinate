// The doors (docs/design-floor §4): where people look for a database, a
// warehouse, an app, a URL or a new dashboard, there is a way — for an editor.
// A viewer is shown none of them (each is a write the server refuses a viewer).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc } from '../test-utils';

const P = '11111111-1111-4111-8111-111111111111';
const LAZY = { timeout: 15_000 };
const DATASET = { id: 'd1', name: 'Orders', sourceKind: 'csv', rowCount: 5, columnCount: 2, updatedAt: '' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve(role: 'editor' | 'viewer', extra: Record<string, unknown> = {}) {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'publish:sites': body({ ok: true, sites: [], publicLinks: false }),
    'catalog:tags': body({ ok: true, tags: [], refs: {} }),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, body(v)])),
  });
}
const main = () => within(screen.getByRole('main'));
const href = (name: string | RegExp) => main().getByRole('link', { name }).getAttribute('href');

describe('Data → Import: the databases, warehouses, apps and URLs', () => {
  it('an editor sees both doors, to the 40-source picker and to its URL form', async () => {
    serve('editor');
    renderApp(`/data/import?project=${P}`);
    await screen.findByRole('link', { name: /^Database, warehouse or app/ }, LAZY);
    expect(href(/^Database, warehouse or app/)).toBe(`/connections/${P}`);
    expect(href(/^From a URL/)).toBe(`/connections/${P}?source=url`);
  });

  it('a viewer sees neither (control)', async () => {
    serve('viewer');
    renderApp(`/data/import?project=${P}`);
    await screen.findByRole('heading', { name: 'Bringing data in is for editors' }, LAZY);
    expect(main().queryByRole('link', { name: /Database, warehouse or app/ })).toBeNull();
    expect(main().queryByRole('link', { name: /From a URL/ })).toBeNull();
  });
});

describe('Data: Connect a database, in the header and the empty state', () => {
  it('an editor with datasets sees it in the header', async () => {
    serve('editor', { 'dataset:list': [DATASET] });
    renderApp(`/data/${P}`);
    await main().findByText('Orders', undefined, LAZY);
    expect(href('Connect a database')).toBe(`/connections/${P}`);
  });

  it('an editor with no dataset sees it in the empty state (once: the header leaves the doors to it)', async () => {
    serve('editor', { 'dataset:list': [] });
    renderApp(`/data/${P}`);
    await screen.findByRole('heading', { name: 'No datasets yet' }, LAZY);
    expect(main().getAllByRole('link', { name: 'Connect a database' })).toHaveLength(1);
    expect(href('Connect a database')).toBe(`/connections/${P}`);
  });

  it('a viewer sees it in neither (control)', async () => {
    serve('viewer', { 'dataset:list': [] });
    renderApp(`/data/${P}`);
    await screen.findByRole('heading', { name: 'No datasets yet' }, LAZY);
    expect(main().queryByRole('link', { name: 'Connect a database' })).toBeNull();
    cleanup();
    serve('viewer', { 'dataset:list': [DATASET] });
    renderApp(`/data/${P}`);
    await main().findByText('Orders', undefined, LAZY);
    expect(main().queryByRole('link', { name: 'Connect a database' })).toBeNull();
  });
});

describe('Dashboards: Create dashboard beside Publish…', () => {
  it('an editor sees it in the header and in the empty state, and it opens the wizard', async () => {
    serve('editor');
    renderApp(`/dashboards?project=${P}`);
    await screen.findByRole('heading', { name: 'Nothing published yet' }, LAZY);
    const links = main().getAllByRole('link', { name: 'Create dashboard' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/analyses?project=${P}&new=1`, `/analyses?project=${P}&new=1`]);
    expect(main().getByRole('button', { name: 'Publish…' })).toBeTruthy();
  });

  it('a viewer sees neither (control)', async () => {
    serve('viewer');
    renderApp(`/dashboards?project=${P}`);
    await screen.findByRole('heading', { name: 'Nothing published yet' }, LAZY);
    expect(main().queryByRole('link', { name: 'Create dashboard' })).toBeNull();
    expect(main().queryByRole('button', { name: 'Publish…' })).toBeNull();
  });
});

describe('Home → New → Dashboard', () => {
  it('opens the new-dashboard wizard in Home’s project, not the published list', async () => {
    serve('editor', { 'home:overview': { counts: { datasets: 1, dashboards: 0, captures: 0, visuals: 0 }, datasets: [], comments: [] } });
    const router = renderApp('/');
    const trigger = await screen.findByRole('button', { name: 'New' }, LAZY);
    await screen.findByTestId('home-sub');
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Dashboard' }));
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(`/analyses?project=${P}&new=1`));
  });

  it('a viewer has no New menu (control)', async () => {
    serve('viewer');
    renderApp('/');
    await screen.findByTestId('home-sub', undefined, LAZY);
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
  });
});
