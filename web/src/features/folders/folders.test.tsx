// Shared folders on the web (docs/team-folders E7): the move warning in words, the rail beside Data and Dashboards (its
// filter, counts, lock and empty folder), Move to… (the warning first, the hash on the move, the server's refusal shown
// when access changed), the chip on an item's page, and a duplicate landing in its original's folder.
// NEGATIVE CONTROLS: with no folder besides Everyone there is no rail, tag, chip or Move; Move is off until a
// destination is picked and its warning has loaded. With folders off on the server (ORDINATE_FOLDERS), the rail's New
// folder, Move to…, the chip's Move and Share → Folders' and Admin → Teams → Folders' changes give way to one line.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { impactLines } from './MoveParts';
import { FOLDERS_OFF } from './api';
import type { FolderTree, MoveImpact } from './api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30_000 });

const P = '11111111-1111-4111-8111-111111111111';
const D1 = '22222222-2222-4222-8222-222222222222';
const D2 = '33333333-3333-4333-8333-333333333333';
const A1 = '44444444-4444-4444-8444-444444444444';
const FIN = '55555555-5555-4555-8555-555555555555';
const Q1 = '66666666-6666-4666-8666-666666666666';
const HR = '77777777-7777-4777-8777-777777777777';
const LAZY = { timeout: 15_000 };
const PROJECT = { id: P, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 2, dashboards: 1, sample: false };
const ds = (id: string, name: string) => ({ id, name, sourceKind: 'csv', rowCount: 10, columnCount: 3, updatedAt: '2026-10-01T10:00:00Z' });

const TREE: FolderTree = {
  available: true,
  enabled: true,
  everyone: 'edit',
  admin: true,
  folders: [
    { id: FIN, parentId: null, name: 'Finance', level: 'manage', items: 1, shareFigures: true, grants: [{ teamId: 't1', team: 'Finance', level: 'view' }, { teamId: 't2', team: 'Finance leads', level: 'edit' }] },
    { id: Q1, parentId: FIN, name: 'Q1', level: 'manage', items: 0 },
    { id: HR, parentId: null, name: 'HR', level: 'manage', items: 0, shareFigures: false, grants: [], adminOnly: true },
  ],
  placed: { dataset: { [D2]: FIN }, dashboard: {} },
};
const IMPACT: MoveImpact = {
  ok: true, to: 'Finance', moving: { datasets: 1, dashboards: 0 }, lose: [{ team: null, people: 14 }], gain: [{ team: 'Finance', people: 3 }],
  viewOnly: 2, canEdit: 0, published: 0, recipients: 0, reachers: { dashboards: 2, keeps: true }, hash: 'a'.repeat(64),
};

function serve(extra: Record<string, RpcReply> = {}, tree: FolderTree | [] = TREE) {
  return serveRpc({
    '/api/auth/me': { body: { user: { email: 'pat@acme.test', role: 'editor' }, org: 'default', mode: 'header', canSignOut: false } },
    'projects:overview': { body: [PROJECT] },
    'projects:roles': { body: { [P]: 'admin' } },
    'dataset:list': { body: [ds(D1, 'Orders'), ds(D2, 'Ledger')] },
    'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
    'folder:tree': { body: tree },
    'folder:moveImpact': { body: IMPACT },
    'folder:move': { body: { ok: true, moved: 1 } },
    ...extra,
  });
}

const rail = async () => within(await screen.findByRole('navigation', { name: 'Folders' }, LAZY));
const rowNames = () => within(screen.getByRole('table')).getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith(`/data/${P}/`)).map((a) => a.textContent);

describe('the move warning, in words', () => {
  it('says who loses and gains, by team and head count, and what keeps showing', () => {
    render(<ul>{impactLines(IMPACT).map((l, i) => <li key={i}>{l.text}</li>)}</ul>);
    expect(screen.getByText(/will lose access/).textContent).toBe('Everyone else in the project (14 people) will lose access.');
    expect(screen.getByText(/will be able to open it/).textContent).toBe('Finance (3 people) will be able to open it.');
    expect(screen.getByText(/only be able to view/).textContent).toBe('2 people will only be able to view it.');
    expect(screen.getByText(/2 dashboards in other folders show its charts: their viewers keep seeing those charts/)).toBeTruthy();
  });
  it('names a published link, recipients and a closed destination\'s charts', () => {
    const lines = impactLines({ ...IMPACT, lose: [{ team: 'Ops analysts', people: 1 }], gain: [], viewOnly: 0, published: 1, recipients: 3, reachers: { dashboards: 1, keeps: false }, to: 'HR' });
    render(<ul>{lines.map((l, i) => <li key={i}>{l.text}</li>)}</ul>);
    expect(screen.getByText(/Ops analysts/).closest('li')?.textContent).toBe('Ops analysts (1 person) will lose access.');
    expect(screen.getByText(/published link/)).toBeTruthy();
    expect(screen.getByText(/3 subscription recipients/).closest('li')?.textContent).toBe('3 subscription recipients will stop receiving it.');
    expect(screen.getByText(/will stop seeing those charts, because HR does not let other folders show its data/)).toBeTruthy();
  });
  it('NEGATIVE CONTROL: a move that changes nothing says so', () => {
    const lines = impactLines({ ...IMPACT, lose: [], gain: [], viewOnly: 0, reachers: { dashboards: 0, keeps: true } });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Nobody gains or loses access. Who can open it stays the same.');
  });
});

describe('the Data page with folders', () => {
  it('shows the rail: All, Everyone, the folders nested, counts, and the admin-only lock', async () => {
    serve();
    renderApp(`/data/${P}`);
    const r = await rail();
    expect(r.getByRole('button', { name: 'All datasets (2)' })).toBeTruthy();
    expect(r.getByRole('button', { name: 'Everyone in the project (1)' })).toBeTruthy();
    expect(r.getByRole('button', { name: 'Finance (1)' })).toBeTruthy();
    expect(r.getByRole('button', { name: 'Q1 (0)' }).getAttribute('data-depth')).toBe('1');
    expect(r.getByRole('button', { name: 'HR (0), admin access' })).toBeTruthy();
    expect(await screen.findByText('Ledger')).toBeTruthy();
    expect(screen.getAllByText('Finance').length).toBeGreaterThan(1); // the row's tag under All
  });
  it('a folder picked filters the list and says who it is shared with', async () => {
    serve();
    renderApp(`/data/${P}?folder=${FIN}`);
    await screen.findByText('Ledger', {}, LAZY);
    expect(rowNames()).toEqual(['Ledger']);
    expect(screen.getByText('· Finance can view, Finance leads can edit')).toBeTruthy();
  });
  it('an empty folder has its own designed state, with Import into this folder', async () => {
    serve();
    renderApp(`/data/${P}?folder=${Q1}`);
    expect(await screen.findByRole('heading', { name: 'No datasets in Q1 yet' }, LAZY)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Import into this folder' }).getAttribute('href')).toBe(`/data/import?project=${P}&folder=${Q1}`);
  });
  it('with folders off on the server: the rail stays, without New folder or Move, and one line says why', async () => {
    serve({}, { ...TREE, enabled: false });
    renderApp(`/data/${P}`);
    const r = await rail();
    expect(r.getByRole('button', { name: 'Finance (1)' })).toBeTruthy();
    expect(r.getByText(FOLDERS_OFF)).toBeTruthy();
    expect(r.queryByRole('button', { name: 'New folder' })).toBeNull();
    await screen.findByText('Ledger');
    expect(screen.queryByRole('button', { name: 'Move Orders to another folder' })).toBeNull();
  });
  it('CONTROL: with folders on, the rail has New folder and each row its Move', async () => {
    serve();
    renderApp(`/data/${P}`);
    const r = await rail();
    expect(r.getByRole('button', { name: 'New folder' })).toBeTruthy();
    expect(r.queryByText(FOLDERS_OFF)).toBeNull();
    expect(await screen.findByRole('button', { name: 'Move Orders to another folder' })).toBeTruthy();
  });
  it('NEGATIVE CONTROL: with no folder besides Everyone there is no rail, tag or Move', async () => {
    serve({}, []);
    renderApp(`/data/${P}`);
    await screen.findByText('Ledger', {}, LAZY);
    expect(screen.queryByRole('navigation', { name: 'Folders' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move Orders to another folder' })).toBeNull();
  });
});

describe('Move to…', () => {
  it('shows the warning before anything moves, then moves with its hash', async () => {
    const calls = serve();
    renderApp(`/data/${P}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Orders to another folder' }, LAZY));
    const dialog = within(await screen.findByRole('dialog', { name: 'Move “Orders”' }));
    const move = dialog.getByRole('button', { name: 'Move' });
    expect(move.hasAttribute('disabled')).toBe(true); // NEGATIVE CONTROL: nothing picked, nothing to agree to
    expect(dialog.getByRole('radio', { name: /Everyone in the project/ }).hasAttribute('disabled')).toBe(true); // where it is now
    fireEvent.click(dialog.getByRole('radio', { name: /Finance/ }));
    expect(await dialog.findByText(/will lose access/)).toBeTruthy();
    expect(calls.find((c) => c.channel === 'folder:moveImpact')?.payload).toEqual({ projectId: P, items: [{ kind: 'dataset', id: D1 }], to: FIN });
    fireEvent.click(dialog.getByRole('button', { name: 'Move to Finance' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'folder:move')?.payload).toEqual({ projectId: P, items: [{ kind: 'dataset', id: D1 }], to: FIN, hash: IMPACT.hash }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Move “Orders”' })).toBeNull());
  });
  it('when access changed since the warning, says so in the server\'s words and checks again', async () => {
    const changed = 'Who can open these changed since you checked. Check again before moving.';
    const calls = serve({ 'folder:move': { status: 409, body: { code: 'folder', reason: 'move_changed', message: changed } } });
    renderApp(`/data/${P}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Orders to another folder' }, LAZY));
    const dialog = within(await screen.findByRole('dialog', { name: 'Move “Orders”' }));
    fireEvent.click(dialog.getByRole('radio', { name: /Finance/ }));
    await dialog.findByText(/will lose access/);
    fireEvent.click(dialog.getByRole('button', { name: 'Move to Finance' }));
    expect(await dialog.findByText(changed)).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.channel === 'folder:moveImpact').length).toBeGreaterThan(1));
    expect(screen.getByRole('dialog', { name: 'Move “Orders”' })).toBeTruthy();
  });
});

describe('the chip on an item\'s page', () => {
  const routes = {
    'dataset:columns': { body: { id: D2, name: 'Ledger', rowCount: 10, columns: [{ name: 'region', type: 'text' }] } },
    'dataset:source': { body: { kind: 'csv', label: 'CSV', refreshable: false } },
    'dataset:stats': { body: { ok: true, summaries: [], issues: [], filledPct: [] } },
    'dataset:page': { body: { ok: true, rows: [], total: 0, offset: 0 } },
    'catalog:columns': { body: { ok: true, columns: {} } },
    'catalog:get': { body: { ok: true, doc: { description: '', tags: [], owner: '', updatedBy: '', updatedAt: '' } } },
    'lineage:get': { body: null },
  };
  it('says which folder and who opens it', async () => {
    serve(routes);
    renderApp(`/data/${P}/${D2}`);
    const chip = await screen.findByRole('button', { name: /In Finance/ }, LAZY);
    expect(chip.textContent).toBe('In Finance· Finance can view, Finance leads can edit');
  });
  it('with folders off, the chip still says where it is, but is no Move button', async () => {
    serve(routes, { ...TREE, enabled: false });
    renderApp(`/data/${P}/${D2}`);
    expect(await screen.findByText('In Finance', {}, LAZY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /In Finance/ })).toBeNull();
  });
  it('NEGATIVE CONTROL: no chip without folders', async () => {
    serve(routes, []);
    renderApp(`/data/${P}/${D2}`);
    await screen.findByRole('heading', { name: 'Ledger' }, LAZY);
    expect(screen.queryByText(/^In /)).toBeNull();
  });
});

describe('the Dashboards page with folders', () => {
  const board = { id: A1, name: 'Ledger board', status: 'draft', sheetCount: 1, updatedAt: '2026-10-01T10:00:00Z', previews: [], sheets: [] };
  it('a duplicate lands in its original\'s folder', async () => {
    const calls = serve({
      'analysis:gallery': { body: [board] },
      'ai:status': { body: { ready: false, reason: 'no_model', models: [], mine: null, keyStore: null } },
      'analysis:open': { body: { ok: true, analysis: { id: A1, name: 'Ledger board', sheets: [], filters: [], parameters: [], style: {} } } },
      'analysis:create': { body: { id: 'x', name: 'Ledger board (copy)' } },
    }, { ...TREE, placed: { dataset: {}, dashboard: { [A1]: FIN } } });
    renderApp(`/dashboards?project=${P}`);
    const trigger = await screen.findByRole('button', { name: 'Ledger board options' }, LAZY);
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = within(await screen.findByRole('menu'));
    expect(menu.getByRole('menuitem', { name: 'Move to…' })).toBeTruthy();
    fireEvent.click(menu.getByRole('menuitem', { name: 'Duplicate' }));
    await waitFor(() => expect((calls.find((c) => c.channel === 'analysis:create')?.payload as { folderId?: string } | undefined)?.folderId).toBe(FIN));
  });
});

describe('Share → Folders', () => {
  const ACCESS = {
    ok: true, enabled: true, everyone: 23,
    folders: [{ id: FIN, name: 'Finance', shareFigures: true, items: 1, people: 5, grants: [{ teamId: 't1', team: 'Finance', level: 'view', people: 3 }, { teamId: 't2', team: 'Finance leads', level: 'edit', people: 2 }] }],
    teams: [{ id: 't1', name: 'Finance', members: 3, inProject: 3 }, { id: 't2', name: 'Finance leads', members: 2, inProject: 2 }, { id: 't3', name: 'Ops analysts', members: 14, inProject: 14 }],
  };
  const mount = async () => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { SharedFolders } = await import('./SharedFolders');
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SharedFolders projectId={P} /></QueryClientProvider>);
  };
  it('lists each top-level folder with its teams, the people they add up to, and the reach switch', async () => {
    const calls = serve({ 'folder:access': { body: ACCESS }, 'folder:grant': { body: { ok: true } }, 'folder:setShareFigures': { body: { ok: true } } });
    await mount();
    const card = within(await screen.findByRole('listitem', { name: 'Finance' }, LAZY));
    expect(card.getByText('5 people through 2 teams · 1 item')).toBeTruthy();
    expect(card.getByRole('combobox', { name: 'Level of Finance leads' }).textContent).toBe('Can edit');
    fireEvent.click(card.getByRole('button', { name: 'Take Finance away from Finance' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'folder:grant')?.payload).toEqual({ projectId: P, folderId: FIN, teamId: 't1', level: null }));
    fireEvent.click(card.getByRole('switch', { name: 'Dashboards in other folders may show this folder’s data' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'folder:setShareFigures')?.payload).toEqual({ projectId: P, folderId: FIN, on: false }));
    expect(screen.getByRole('button', { name: 'Move everything to Everyone' })).toBeTruthy(); // a dataset sits in Finance
  });
  it('with folders off: the folders and their teams as they are, no change offered, and one line says why', async () => {
    serve({ 'folder:access': { body: { ...ACCESS, enabled: false } } }, { ...TREE, enabled: false });
    await mount();
    const card = within(await screen.findByRole('listitem', { name: 'Finance' }, LAZY));
    expect(card.getByText('Finance leads')).toBeTruthy();
    expect(card.getByText('Can edit')).toBeTruthy();
    expect(card.queryByRole('combobox', { name: 'Level of Finance leads' })).toBeNull();
    expect(card.queryByRole('button', { name: 'Take Finance away from Finance' })).toBeNull();
    expect(card.queryByRole('combobox', { name: 'Give it to a team' })).toBeNull();
    expect(card.queryByRole('switch')).toBeNull();
    expect(card.getByText('Dashboards in other folders may show this folder’s data.')).toBeTruthy();
    expect(screen.getAllByText(FOLDERS_OFF)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move everything to Everyone' })).toBeNull();
  });
  it('with folders off and none made: the empty state says why, with no New folder', async () => {
    serve({ 'folder:access': { body: { ...ACCESS, enabled: false, folders: [] } } }, { ...TREE, enabled: false, folders: [], placed: { dataset: {}, dashboard: {} } });
    await mount();
    expect(await screen.findByRole('heading', { name: 'No folders yet' }, LAZY)).toBeTruthy();
    expect(screen.getAllByText(FOLDERS_OFF)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
  });
  it('Admin → Teams → Folders: with folders off, each level as text, no picker, and one line says why', async () => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { TeamFoldersDialog } = await import('./TeamFolders');
    const view = (enabled: boolean) => {
      serve({ 'admin:projects': { body: [{ id: P, name: 'Sales', archived: false }] }, 'folder:access': { body: { ...ACCESS, enabled } } });
      return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TeamFoldersDialog team={{ id: 't2', name: 'Finance leads' }} onClose={() => undefined} /></QueryClientProvider>);
    };
    const off = view(false);
    const dialog = within(await screen.findByRole('dialog', { name: 'Folders for Finance leads' }, LAZY));
    expect(await dialog.findByText(FOLDERS_OFF)).toBeTruthy();
    expect(dialog.getByText('Can edit')).toBeTruthy();
    expect(dialog.queryByRole('combobox', { name: 'Finance leads on Finance' })).toBeNull();
    off.unmount();
    view(true);
    const on = within(await screen.findByRole('dialog', { name: 'Folders for Finance leads' }, LAZY));
    expect((await on.findByRole('combobox', { name: 'Finance leads on Finance' })).textContent).toBe('Can edit'); // CONTROL
    expect(on.queryByText(FOLDERS_OFF)).toBeNull();
  });
  it('NEGATIVE CONTROL: with no folders, a designed empty state and no rollback step', async () => {
    serve({ 'folder:access': { body: { ...ACCESS, folders: [] } } }, { ...TREE, folders: [], placed: { dataset: {}, dashboard: {} } });
    await mount();
    expect(await screen.findByRole('heading', { name: 'No folders yet' }, LAZY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Move everything to Everyone' })).toBeNull();
  });
});
