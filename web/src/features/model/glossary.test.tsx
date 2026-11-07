import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const EMEA = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const APAC = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };

const term = (id: string, name: string) => ({ id, name, aliases: [], datasetId: D, datasetName: 'Orders', definition: 'region in EU, ME', updatedAt: '' });
const ref = (kind: string, name: string) => ({ kind, id: name, name });
const USAGE = { [EMEA]: { total: 3, summary: '2 visuals and 1 dashboard', refs: [ref('visual', 'EU sales'), ref('visual', 'EU trend'), ref('dashboard', 'Board')] } };

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor') {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'dataset:list': body([{ id: D, name: 'Orders', sourceKind: 'csv', rowCount: 10, columnCount: 3, updatedAt: '' }]),
    'term:list': body({ ok: true, terms: [term(EMEA, 'EMEA'), term(APAC, 'APAC')] }),
    'term:usage': body({ ok: true, usage: USAGE }),
    ...routes,
  });
}
/** The term's Used by cell (its name re-renders as a button once the role is read, so wait for a row). */
const usedBy = (name: string) => waitFor(() => within(screen.getByText(name).closest('tr')!).getAllByRole('cell')[4], LAZY);

describe('The Data model: glossary', () => {
  it('says where each term is used, with the names on hover', async () => {
    serve();
    renderApp(`/model/${P}?tab=glossary`);
    const emea = await usedBy('EMEA');
    await waitFor(() => expect(emea.textContent).toBe('2 visuals and 1 dashboard'));
    expect(emea.getAttribute('title')).toBe('EU sales, EU trend, Board');
    expect((await usedBy('APAC')).textContent).toBe('Not used yet');
    expect(screen.getByText('2 terms')).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('NEGATIVE CONTROL: an older pod without term:usage leaves both terms listed, Used by "—"', async () => {
    const calls = serve({ 'term:usage': { status: 404, body: { error: 'not_found' } } });
    renderApp(`/model/${P}?tab=glossary`);
    await waitFor(() => expect(calls.some((c) => c.channel === 'term:usage')).toBe(true), LAZY);
    expect((await usedBy('EMEA')).textContent).toBe('—');
    expect((await usedBy('APAC')).textContent).toBe('—');
  });

  it('an empty glossary shows one New term (the header\'s), and it opens the term dialog', async () => {
    serve({ 'term:list': { body: { ok: true, terms: [] } } });
    const router = renderApp(`/model/${P}?tab=glossary`);
    await screen.findByRole('heading', { name: 'No terms yet' }, LAZY);
    expect(screen.getAllByRole('button', { name: 'New term' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'New term' }));
    expect(await screen.findByRole('dialog', { name: 'New term' })).toBeTruthy();
    expect(new URLSearchParams(router.state.location.search).get('tab')).toBe('glossary');
  });

  it('a viewer sees no New term', async () => {
    const calls = serve({}, 'viewer');
    renderApp(`/model/${P}?tab=glossary`);
    await usedBy('EMEA');
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    expect(screen.queryByRole('button', { name: 'New term' })).toBeNull();
  });
});
