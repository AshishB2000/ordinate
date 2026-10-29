// The Dashboards page (docs/superpowers/specs/2026-10-29-dashboard-drafts-publish-design.md): an editor's two tabs,
// Published (with "Edits not live" where it applies) and Drafts, and no All; Create dashboard's arrow with its other ways
// in; each card's ⋯ and what each step writes; a viewer's grid with nothing to create; the empty and error states; and
// the old Analyses address sending its asks here. Each lazy route's first render is slow on a loaded machine: 30 s, as
// the alert and viewer suites allow.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const A1 = '33333333-3333-4333-8333-333333333333';
const A2 = '44444444-4444-4444-8444-444444444444';
const A3 = '55555555-5555-4555-8555-555555555555';
const A4 = '66666666-6666-4666-8666-666666666666';
const LAZY = { timeout: 15_000 };
const PROJECT = { id: P, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 3, sample: false };
const NO_MODEL = { ready: false, reason: 'no_model', models: [], mine: null, keyStore: null };
const MODEL = { ready: true, models: [{ provider: 'anthropic', model: 'm', label: 'M', isDefault: true }], mine: { provider: 'anthropic', model: 'm' }, copilotEnabled: true, keyStore: null };
const TAGS = { ok: true, tags: [{ name: 'finance', color: 2, count: 1 }], refs: { [`analysis:${A1}`]: ['finance'] } };

type Status = 'draft' | 'published' | 'edited';
const board = (id: string, name: string, status: Status) => ({
  id, name, status, sheetCount: 2, updatedAt: '2026-10-01T10:00:00Z', previews: [], sheets: [],
  ...(status === 'draft' ? {} : { publishedAt: '2026-09-30T10:00:00Z', publishedBy: 'ana.ruiz@acme.test' }),
});
const GALLERY = [board(A1, 'Revenue board', 'published'), board(A2, 'Pipeline health', 'edited'), board(A3, 'Churn by region', 'draft')];

function serve(role: 'admin' | 'viewer', extra: Record<string, RpcReply> = {}) {
  return serveRpc({
    '/api/auth/me': { body: { user: { email: 'dev@local', role }, org: 'default', mode: 'dev', canSignOut: false } },
    'projects:overview': { body: [PROJECT] },
    'projects:roles': { body: { [P]: role } },
    'analysis:gallery': { body: role === 'viewer' ? GALLERY.filter((b) => b.status !== 'draft').map((b) => ({ ...b, status: 'published' })) : GALLERY },
    'dataset:list': { body: [{ id: D, name: 'Orders', sourceKind: 'csv', rowCount: 120, columnCount: 3, updatedAt: '2026-10-01T10:00:00Z' }] },
    'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
    'ai:status': { body: NO_MODEL },
    'template:list': { body: { ok: true, datasetId: D, datasetName: 'Orders', columns: [], templates: [] } },
    ...extra,
  });
}

// Radix opens a menu on pointerdown or Enter, and selects a tab on mousedown — never on a plain click.
async function openMenu(name: string) {
  const trigger = await screen.findByRole('button', { name }, LAZY);
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return within(await screen.findByRole('menu'));
}
const names = (list: HTMLElement) => within(list).getAllByRole('listitem').map((li) => within(li).getAllByRole('link')[0]!.textContent);
const items = (menu: ReturnType<typeof within>) => menu.getAllByRole('menuitem').map((m: HTMLElement) => m.textContent);

describe('an editor’s Dashboards page', { timeout: 30_000 }, () => {
  it('opens on Published — the published ones, "Edits not live" only where it is so — and Drafts holds the rest; no All tab', async () => {
    serve('admin');
    const router = renderApp(`/dashboards?project=${P}`);
    const published = await screen.findByRole('list', { name: 'Published dashboards' }, LAZY);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Published2', 'Drafts1']);
    expect(names(published)).toEqual([expect.stringContaining('Revenue board'), expect.stringContaining('Pipeline health')]);
    // A published card opens its view page and says who published it; the edited one wears the one badge.
    const revenue = within(published).getByRole('link', { name: /Revenue board/ });
    expect(revenue.getAttribute('href')).toBe(`/dashboards/${P}/${A1}`);
    expect(revenue.textContent).toMatch(/2 sheets · Published .+ by Ana/);
    expect(within(revenue).queryByText('Edits not live')).toBeNull();
    const pipeline = within(published).getByRole('link', { name: /Pipeline health/ });
    expect(within(pipeline).getByText('Edits not live')).toBeTruthy();
    expect(pipeline.textContent).toMatch(/Edited/);
    expect(screen.queryByText('Churn by region')).toBeNull();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Drafts/ }), { button: 0 });
    const drafts = await screen.findByRole('list', { name: 'Draft dashboards' });
    const churn = within(drafts).getByRole('link', { name: /Churn by region/ });
    expect(churn.getAttribute('href')).toBe(`/analyses/${P}/${A3}`); // a draft opens in the editor
    expect(within(drafts).queryByText('Draft')).toBeNull(); // the tab already says so
    expect(router.state.location.search).toBe(`?project=${P}&tab=drafts`);
    expect(screen.queryByText(/Made by AI|From a screenshot/)).toBeNull();
  });

  it('with nothing published yet it opens on Drafts, and an empty tab says what belongs in it', async () => {
    serve('admin', { 'analysis:gallery': { body: [board(A3, 'Churn by region', 'draft')] } });
    renderApp(`/dashboards?project=${P}`);
    await screen.findByRole('list', { name: 'Draft dashboards' }, LAZY);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^Published/ }), { button: 0 });
    await screen.findByRole('heading', { name: 'Nothing published yet' });
    expect(screen.getByText(/Viewers see only published dashboards/)).toBeTruthy();
    cleanup();
    serve('admin', { 'analysis:gallery': { body: [board(A1, 'Revenue board', 'published')] } });
    renderApp(`/dashboards?project=${P}&tab=drafts`);
    await screen.findByRole('heading', { name: 'No drafts' }, LAZY);
  });

  it('Create dashboard opens the wizard; its arrow offers a blank dashboard and a screenshot rebuilt — no Rebuild button in the header', async () => {
    serve('admin');
    const router = renderApp(`/dashboards?project=${P}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Create dashboard' }, LAZY));
    await screen.findByRole('dialog', { name: 'Create dashboard' });
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Create dashboard' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create dashboard' })).toBeNull());
    expect(screen.queryByRole('button', { name: /Rebuild/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Draft with AI' }) as HTMLButtonElement).disabled).toBe(true); // no model

    let menu = await openMenu('More ways to create');
    expect(items(menu)).toEqual(['Blank dashboard', 'Rebuild from a screenshot']);
    fireEvent.click(menu.getByRole('menuitem', { name: 'Blank dashboard' }));
    await screen.findByRole('dialog', { name: 'Create dashboard' });
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Create dashboard' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create dashboard' })).toBeNull());
    menu = await openMenu('More ways to create');
    fireEvent.click(menu.getByRole('menuitem', { name: 'Rebuild from a screenshot' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/analyses/${P}/rebuild`));
  });

  it('a card’s ⋯: every way on for a published one; a draft has no Open published and no Unpublish', async () => {
    serve('admin');
    const router = renderApp(`/dashboards?project=${P}`);
    let menu = await openMenu('Pipeline health options');
    expect(items(menu)).toEqual(['Open published', 'Edit', 'Preview', 'Duplicate', 'Rename', 'History', 'Lineage', 'Unpublish…', 'Delete…']);
    fireEvent.click(menu.getByRole('menuitem', { name: 'Preview' }));
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(`/dashboards/${P}/${A2}?draft=1`));
    cleanup();
    serve('admin');
    const again = renderApp(`/dashboards?project=${P}&tab=drafts`);
    menu = await openMenu('Churn by region options');
    expect(items(menu)).toEqual(['Edit', 'Preview', 'Duplicate', 'Rename', 'History', 'Lineage', 'Delete…']);
    fireEvent.click(menu.getByRole('menuitem', { name: 'History' }));
    await waitFor(() => expect(again.state.location.pathname).toBe(`/versions/${P}/dashboard/${A3}`));
  });

  it('Unpublish asks first, says the draft stays, then writes analysis:unpublish alone', async () => {
    const calls = serve('admin', { 'analysis:unpublish': { body: { ok: true, status: 'draft' } } });
    renderApp(`/dashboards?project=${P}`);
    const menu = await openMenu('Revenue board options');
    fireEvent.click(menu.getByRole('menuitem', { name: 'Unpublish…' }));
    const dlg = await screen.findByRole('dialog', { name: 'Unpublish “Revenue board”?' });
    expect(dlg.textContent).toMatch(/comes off the Dashboards page.*The draft stays/);
    expect(calls.some((c) => c.channel === 'analysis:unpublish')).toBe(false);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'analysis:unpublish')?.payload).toEqual({ projectId: P, id: A1 }));
    await screen.findByText('“Revenue board” is a draft again.');
    expect(calls.some((c) => c.channel === 'analysis:delete' || c.channel === 'analysis:update')).toBe(false);
  });

  it('Delete asks first, then sends it to the Trash; Keep it writes nothing (control)', async () => {
    const calls = serve('admin', { 'analysis:delete': { body: { ok: true } } });
    renderApp(`/dashboards?project=${P}`);
    let menu = await openMenu('Revenue board options');
    fireEvent.click(menu.getByRole('menuitem', { name: 'Delete…' }));
    let dlg = await screen.findByRole('dialog', { name: 'Delete “Revenue board”?' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.channel === 'analysis:delete')).toBe(false);
    menu = await openMenu('Revenue board options');
    fireEvent.click(menu.getByRole('menuitem', { name: 'Delete…' }));
    dlg = await screen.findByRole('dialog', { name: 'Delete “Revenue board”?' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'analysis:delete')?.payload).toEqual({ projectId: P, id: A1 }));
  });

  it('Duplicate makes the draft as it stands a new draft, and shows Drafts', async () => {
    const sheets = [{ id: 's1', name: 'Sheet 1', cards: [] }];
    const draft = { id: A2, projectId: P, name: 'Pipeline health', sheets, filters: [], style: { theme: 'dark' }, parameters: [], views: [], defaultViewId: '', updatedAt: '' };
    const calls = serve('admin', {
      'analysis:open': { body: { ok: true, analysis: draft, visuals: [], tag: 'T', status: 'edited', showing: 'draft' } },
      'analysis:create': { body: { ...draft, id: A4, name: 'Pipeline health (copy)' } },
    });
    const router = renderApp(`/dashboards?project=${P}`);
    const menu = await openMenu('Pipeline health options');
    fireEvent.click(menu.getByRole('menuitem', { name: 'Duplicate' }));
    await screen.findByText('“Pipeline health (copy)” is a new draft.');
    expect(calls.find((c) => c.channel === 'analysis:open')?.payload).toEqual({ projectId: P, id: A2 }); // the draft, not the published copy
    expect(calls.find((c) => c.channel === 'analysis:create')?.payload).toEqual({ projectId: P, name: 'Pipeline health (copy)', sheets, filters: [], parameters: [], style: { theme: 'dark' } });
    expect(router.state.location.search).toBe(`?project=${P}&tab=drafts`);
  });

  it('narrows a tab’s cards to one tag', async () => {
    serve('admin', { 'catalog:tags': { body: TAGS } });
    renderApp(`/dashboards?project=${P}`);
    const bar = await screen.findByRole('toolbar', { name: 'Filter by tag' }, LAZY);
    fireEvent.click(within(bar).getByRole('button', { name: 'finance' }));
    const list = screen.getByRole('list', { name: 'Published dashboards' });
    expect(within(list).getByText('Revenue board')).toBeTruthy();
    expect(within(list).queryByText('Pipeline health')).toBeNull();
  });

  it('a failed list is an error with a retry', async () => {
    serve('admin', { 'analysis:gallery': { status: 500, body: { error: 'boom' } } });
    renderApp(`/dashboards?project=${P}`);
    await screen.findByRole('heading', { name: 'Dashboards could not be loaded' }, LAZY);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('an editor’s first dashboard', { timeout: 30_000 }, () => {
  it('offers Create, Draft with AI and the screenshot rebuild, once each — and says why AI is shut with no model', async () => {
    serve('admin', { 'analysis:gallery': { body: [] } });
    renderApp(`/dashboards?project=${P}`);
    await screen.findByRole('heading', { name: 'Start your first dashboard' }, LAZY);
    expect(screen.getAllByRole('button', { name: 'Create dashboard' })).toHaveLength(1); // the panel's, not the header's too
    expect(screen.queryByRole('button', { name: 'More ways to create' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Draft with AI' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'Rebuild it here' }).getAttribute('href')).toBe(`/analyses/${P}/rebuild`);
    await screen.findByText(/AI isn’t set up for your organization yet/);
    expect(screen.queryByRole('group', { name: 'Or start from a dataset' })).toBeNull();
  });

  it('with a model, Draft with AI and a dataset chip open the draft flow', async () => {
    const calls = serve('admin', { 'analysis:gallery': { body: [] }, 'ai:status': { body: MODEL }, 'analysis:draft': { body: { ok: false, error: 'Not in this test.' } } });
    renderApp(`/dashboards?project=${P}`);
    const chips = await screen.findByRole('group', { name: 'Or start from a dataset' }, LAZY);
    fireEvent.click(within(chips).getByRole('button', { name: 'Orders' }));
    await screen.findByRole('dialog', { name: 'Draft a dashboard' });
    expect(calls.some((c) => c.channel === 'analysis:create')).toBe(false); // nothing is made before the review
  });
});

describe('a viewer’s Dashboards page', { timeout: 30_000 }, () => {
  it('is the published dashboards alone: no tabs, nothing to create, each card opens its view page, and Copy link is all its menu holds', async () => {
    serve('viewer');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp(`/dashboards?project=${P}`);
    const list = await screen.findByRole('list', { name: 'Dashboards' }, LAZY);
    expect(within(list).getByRole('link', { name: /Pipeline health/ }).getAttribute('href')).toBe(`/dashboards/${P}/${A2}`);
    await screen.findByText('The dashboards published in this project.');
    expect(screen.queryByRole('tab')).toBeNull();
    for (const name of ['Create dashboard', 'Draft with AI', 'More ways to create', 'Revenue board options']) expect(screen.queryByRole('button', { name })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link to Revenue board' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/dashboards/${P}/${A1}`));
  });

  it('with nothing published, says so — and NEGATIVE CONTROL: no first-dashboard doors', async () => {
    serve('viewer', { 'analysis:gallery': { body: [] } });
    renderApp(`/dashboards?project=${P}`);
    await screen.findByRole('heading', { name: 'Nothing published yet' }, LAZY);
    expect(screen.getByText(/When an editor publishes a dashboard in this project, it shows up here/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Start your first dashboard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create dashboard' })).toBeNull();
  });

  it('following a “New dashboard” link gets no wizard', async () => {
    serve('viewer');
    renderApp(`/dashboards?project=${P}&new=1&dataset=${D}`);
    await screen.findByRole('list', { name: 'Dashboards' }, LAZY);
    expect(screen.queryByRole('dialog', { name: 'Create dashboard' })).toBeNull();
  });
});

describe('the old Analyses address', { timeout: 30_000 }, () => {
  it('sends the list here, keeping the project and the wizard’s ask: the wizard opens on Start from', async () => {
    serve('admin');
    const router = renderApp(`/analyses?project=${P}&new=1&dataset=${D}`);
    const wiz = await screen.findByRole('dialog', { name: 'Create dashboard' }, LAZY);
    expect(await within(wiz).findByRole('radiogroup', { name: 'Layouts' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/dashboards');
    await waitFor(() => expect(router.state.location.search).toBe(`?project=${P}`)); // the ask is taken, then stripped
  });

  it('sends a bare /analyses here too', async () => {
    serve('admin');
    const router = renderApp(`/analyses?project=${P}`);
    await screen.findByRole('list', { name: 'Published dashboards' }, LAZY);
    expect(router.state.location.pathname + router.state.location.search).toBe(`/dashboards?project=${P}`);
  });
});

describe('the published links', { timeout: 30_000 }, () => {
  it('keep their address but no tab: &dashboard= opens Publish on it, and closing stays on the list', async () => {
    const calls = serve('admin', {
      'publish:sites': { body: { sites: [], publicLinks: false } },
      'publish:targets': { body: { dashboards: [{ id: A1, name: 'Revenue board' }], stories: [], scorecards: [] } },
      'publish:plan': { body: { ok: true, plan: { pages: [], bytes: 0, combos: 0, tooBig: false } } },
    });
    const router = renderApp(`/dashboards?project=${P}&dashboard=${A1}`);
    await screen.findByRole('dialog', { name: 'Publish' }, LAZY);
    expect(screen.queryByRole('tab', { name: /Shared links/, hidden: true })).toBeNull();
    expect(calls.some((c) => c.channel === 'analysis:gallery')).toBe(false); // the dashboards list is never asked for
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Publish' }), { key: 'Escape' });
    await waitFor(() => expect(router.state.location.search).toBe(`?project=${P}&tab=links`));
    await screen.findByRole('heading', { name: 'Nothing published yet' });
  });
});
