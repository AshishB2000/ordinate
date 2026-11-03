import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { setDockOpen, takePendingQuestion } from '../assistant/dockState';

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => {
    setDockOpen(false);
    takePendingQuestion();
  });
  localStorage.clear();
});

const P = '11111111-1111-4111-8111-111111111111';
const Q = '22222222-2222-4222-8222-222222222222';
const NOW = new Date().toISOString();

const recent = [
  { type: 'dataset', id: 'd1', projectId: P, projectName: 'My project', name: 'Orders', updatedAt: NOW, meta: { rowCount: 5000, columnCount: 9, qualityFailing: 1 } },
  { type: 'analysis', id: 'a1', projectId: P, projectName: 'My project', name: 'Sales overview', updatedAt: NOW, meta: { sheetCount: 2 } },
  { type: 'visual', id: 'v1', projectId: P, projectName: 'My project', name: 'Revenue by month', updatedAt: NOW, meta: { chartType: 'line' } },
  { type: 'dataset', id: 'd2', projectId: Q, projectName: 'Other', name: 'Elsewhere', updatedAt: NOW },
];

/** The tour as a server with no AI model sends it: no Assistant stop, Explore visited. */
const TOUR = [{ id: 'explore', done: true }, { id: 'dashboards', done: false }, { id: 'reports', done: false }, { id: 'data', done: false }];

const MINE = {
  counts: { datasets: 2, dashboards: 1, captures: 0, visuals: 1 },
  datasets: [
    { id: 'd1', name: 'Orders', rowCount: 5000, columnCount: 9, qualityFailing: 1 },
    { id: 'd3', name: 'Returns', rowCount: 12, columnCount: 3 },
  ],
};

type Reply = unknown; // a canned reply, or a (payload) => reply function
type ListRow = { id: string; name: string; updatedAt: string; lastOpenedAt?: string; archivedAt?: string };
const answer = (r: Reply, payload: unknown) => (typeof r === 'function' ? (r as (p: unknown) => unknown)(payload) : r);

/** fetch, answered per RPC channel; records each call's payload. `{ status, body }` replies fail. */
function stubServer(replies: Record<string, Reply>, role = 'admin') {
  const calls: { channel: string; payload: unknown }[] = [];
  const all: Record<string, Reply> = {
    'projects:list': [{ id: P, name: 'My project', createdAt: NOW, updatedAt: NOW }],
    // The caller's role on the project follows the org role these tests pass.
    'projects:roles': { [P]: role === 'viewer' ? 'viewer' : 'admin' },
    'recent:list': recent,
    'starred:get': ['analysis:a1'],
    'home:overview': MINE,
    'onboarding:status': { show: true, collapsed: false, steps: TOUR, doneCount: 1, total: 4 },
    'jobs:list': { active: [], recent: [] },
    'prefs:get': { formats: {}, branding: { accent: '' } },
    // The Assistant dock (T2.12): not set up, unless a test says otherwise.
    'ai:status': { ready: false, reason: 'no_model', models: [], mine: null, copilotEnabled: true, keyStore: null },
    'copilot:history': { ok: true, turns: [], threadId: null },
    'dataset:list': [],
    ...replies,
  };
  // The switcher's rows (Home's project is the current one): the same projects, unless a test gives them.
  all['projects:overview'] ??= (payload: unknown) => {
    const v = answer(all['projects:list'], payload);
    if (!Array.isArray(v)) return v;
    return (v as ListRow[]).map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, lastOpenedAt: p.lastOpenedAt ?? null, archived: !!p.archivedAt, datasets: 0, dashboards: 0, sample: false }));
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') {
        return Response.json({ user: { email: 'dev@local', role }, org: 'default', mode: 'dev', canSignOut: false });
      }
      const channel = decodeURIComponent(url.replace('/api/rpc/', ''));
      const payload = (JSON.parse(String(init?.body ?? '{}')) as { args?: unknown[] }).args?.[0];
      calls.push({ channel, payload });
      const v = answer(all[channel], payload);
      if (v && typeof v === 'object' && 'status' in v) {
        const fail = v as unknown as { status: number; body: unknown };
        return Response.json(fail.body, { status: fail.status });
      }
      return Response.json(v ?? null);
    }),
  );
  return calls;
}

describe('Home', () => {
  it('opens each way of bringing data in from the New menu, in Home\'s project', async () => {
    const doors: [string, string][] = [
      ['CSV / Excel', `/data/import?project=${P}&source=file`],
      ['Paste data', `/data/import?project=${P}&source=paste`],
      ['Screenshot', `/data/import?project=${P}&source=screenshot`],
      ['Database', `/connections/${P}`],
    ];
    for (const [name, to] of doors) {
      stubServer({});
      const router = renderApp('/');
      const trigger = await screen.findByRole('button', { name: 'New' });
      await waitFor(() => expect(screen.getByTestId('project-switcher').textContent).toContain('My project')); // the project is known, so the doors open in it
      act(() => trigger.focus());
      fireEvent.keyDown(trigger, { key: 'Enter' });
      fireEvent.click(await screen.findByRole('menuitem', { name }));
      await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(to));
      cleanup();
    }
  });

  it('greets, then fills the hero, the preview cards and the table from the server', async () => {
    stubServer({});
    renderApp('/');
    expect(await screen.findByRole('status', { name: 'Loading recent work' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('home-greet').textContent).toMatch(/^(Good (morning|afternoon|evening)|Good to see you), Dev$/));

    // Starred: the caller's pins as cards (one here), each opening the record itself, then the way to add one.
    const pinsRow = await screen.findByRole('region', { name: 'Starred' });
    const cards = await within(pinsRow).findAllByRole('link');
    expect(cards.map((a) => a.getAttribute('href'))).toEqual([`/analyses/${P}/a1`]);
    expect(cards[0]!.getAttribute('aria-label')).toMatch(/^Sales overview, Dashboard, 2 sheets, in My project, /);
    expect(within(pinsRow).getByText('Star what you come back to')).toBeTruthy();

    // The table: this project only (the scope), every type in one list, a pin shown on its own row.
    const rec = screen.getByRole('region', { name: 'Recent' });
    const links = within(rec).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/data/${P}/d1`, `/analyses/${P}/a1`, `/visuals/${P}/v1`]);
    expect(links[0]!.getAttribute('aria-label')).toMatch(/^Orders, Dataset, 5,000 rows × 9 columns, in My project, /);
    expect(links[1]!.getAttribute('aria-label')).toMatch(/^Sales overview, Dashboard, 2 sheets, in My project, /);
    expect(within(rec).getByRole('button', { name: 'Unstar Sales overview' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(rec).getByRole('button', { name: 'Star Orders' }).getAttribute('aria-pressed')).toBe('false');
    expect(within(rec).getByRole('img', { name: 'Data quality: 1 rule failing' })).toBeTruthy();
    // Nothing on the page repeats the New menu's doors, and there is no side column.
    expect(screen.queryByRole('complementary', { name: 'This project' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'CSV / Excel' })).toBeNull();
  });

  it('widens Recent to every project and narrows it by type, without asking the server again', async () => {
    const calls = stubServer({});
    renderApp('/');
    const rec = await screen.findByRole('region', { name: 'Recent' });
    await within(rec).findByRole('link', { name: /^Orders/ });
    const names = () => within(rec).getAllByRole('link').map((a) => a.getAttribute('aria-label')!.split(',')[0]);
    const before = calls.filter((c) => c.channel === 'recent:list' || c.channel === 'starred:get').length;
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(names()).toEqual(['Orders', 'Sales overview', 'Revenue by month', 'Elsewhere']);
    expect(localStorage.getItem('ordinate.recentAllProjects')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Dashboards' }));
    expect(names()).toEqual(['Sales overview']);
    fireEvent.click(screen.getByRole('button', { name: 'Visuals' }));
    expect(names()).toEqual(['Revenue by month']);
    fireEvent.click(screen.getByRole('button', { name: 'Datasets' }));
    expect(names()).toEqual(['Orders', 'Elsewhere']);
    // No Starred filter: the pins are the row above.
    expect(within(screen.getByRole('group', { name: 'Filter recent' })).queryByRole('button', { name: 'Starred' })).toBeNull();
    expect(calls.filter((c) => c.channel === 'recent:list' || c.channel === 'starred:get').length).toBe(before);
    localStorage.removeItem('ordinate.recentAllProjects');
  });

  it('stars and unstars a row as the caller\'s own pins', async () => {
    const calls = stubServer({ 'starred:set': (p: unknown) => ({ ok: true, starred: (p as { ids: string[] }).ids }) });
    renderApp('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Star Orders' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'starred:set')?.payload).toEqual({ ids: ['analysis:a1', 'dataset:d1'] }));
    const rec = screen.getByRole('region', { name: 'Recent' });
    expect(await within(rec).findByRole('button', { name: 'Unstar Orders' })).toBeTruthy();
    // The Starred row follows: the newest pin first.
    const pinned = () => within(screen.getByRole('region', { name: 'Starred' })).queryAllByRole('link').map((a) => a.getAttribute('aria-label')!.split(',')[0]);
    await waitFor(() => expect(pinned()).toEqual(['Orders', 'Sales overview']));
    fireEvent.click(within(rec).getByRole('button', { name: 'Unstar Orders' }));
    await waitFor(() => expect(pinned()).toEqual(['Sales overview']));
  });

  it('shows the pins from any project, saying where, or the way to make the first one', async () => {
    stubServer({ 'starred:get': ['analysis:a1', 'dataset:d2'] });
    renderApp('/');
    const row = await screen.findByRole('region', { name: 'Starred' });
    const cards = await within(row).findAllByRole('link');
    expect(cards.map((a) => a.getAttribute('aria-label')!.split(',')[0])).toEqual(['Elsewhere', 'Sales overview']);
    // A pin from another project names it; one from Home's own does not repeat it.
    expect(cards[0]!.textContent).toContain('Other');
    expect(cards[1]!.textContent).not.toContain('My project');
    cleanup();
    stubServer({ 'starred:get': [] });
    renderApp('/');
    const empty = await screen.findByRole('region', { name: 'Starred' });
    expect(await within(empty).findByText('Nothing starred yet')).toBeTruthy();
    expect(within(empty).queryAllByRole('link')).toEqual([]);
  });

  it('hands a question to the Assistant dock, which asks it; a chip only fills the bar', async () => {
    const calls = stubServer({
      'ai:status': {
        ready: true,
        models: [{ provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', isDefault: true }],
        mine: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        copilotEnabled: true,
        keyStore: null,
      },
      'copilot:ask': { ok: true, turns: [], threadId: 't' },
    });
    renderApp('/');
    // The hero: the bar sits in its own region, first on the page; with a model ready it has nothing to explain.
    const hero = screen.getByRole('region', { name: 'What do you want to do?' });
    const input = within(hero).getByRole('textbox', { name: 'Ask a question or say what to build' });
    const chips = within(await within(hero).findByRole('group', { name: 'Suggestions' })).getAllByRole('button');
    // An editor's: two that build, two that ask, each naming the dataset it is about.
    expect(chips.map((b) => b.textContent)).toEqual(['Build a dashboard from @Orders', 'Clean up @Orders', 'Summarise @Orders', 'What is in @Returns?']);
    await waitFor(() => expect(calls.some((c) => c.channel === 'ai:status')).toBe(true));
    expect(within(hero).queryByTestId('ai-not-ready')).toBeNull();
    const asked = () => calls.filter((c) => c.channel === 'copilot:ask').map((c) => c.payload);

    // A chip fills the bar and tags its dataset; it never sends. Let the tag go and the question is the whole project's.
    fireEvent.click(screen.getByRole('button', { name: 'What is in @Returns?' }));
    expect((input as HTMLInputElement).value).toBe('What is in Returns?');
    expect(within(hero).getByTestId('ask-about').textContent).toBe('@Returns');
    expect(asked()).toEqual([]);
    fireEvent.click(within(hero).getByRole('button', { name: 'Ask about the whole project instead' }));
    expect(within(hero).queryByTestId('ask-about')).toBeNull();
    fireEvent.submit(input.closest('form')!);
    expect((input as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(asked()[0]).toMatchObject({ projectId: P, question: 'What is in Returns?', context: { kind: '' } }));
    expect(screen.getByRole('button', { name: 'Assistant' }).getAttribute('aria-expanded')).toBe('true');

    // Kept, the tag points the Assistant at that dataset, as `@` does, and the dock shows it pinned.
    fireEvent.click(screen.getByRole('button', { name: 'Summarise @Orders' }));
    fireEvent.submit(input.closest('form')!);
    expect(within(hero).queryByTestId('ask-about')).toBeNull();
    await waitFor(() => expect(asked()[1]).toMatchObject({ projectId: P, question: 'Summarise Orders', context: { kind: 'dataset', id: 'd1' } }));
    expect(screen.getByTestId('dock-context').textContent).toContain('Orders');
  });

  it('keeps the question in the dock\'s composer when the Assistant is not set up, focus in the dock', async () => {
    const calls = stubServer({});
    renderApp('/');
    const input = await screen.findByRole('textbox', { name: 'Ask a question or say what to build' });
    // No model: the hero says so, and gives an admin the one way to fix it.
    const note = await within(screen.getByRole('region', { name: 'What do you want to do?' })).findByTestId('ai-not-ready');
    expect(note.textContent).toContain('AI isn’t set up yet');
    expect(within(note).getByRole('link', { name: 'Connect a provider' }).getAttribute('href')).toBe('/admin?tab=ai');
    // …and suggests nothing it could not answer (the same project, with a model, has four: above).
    await waitFor(() => expect(calls.some((c) => c.channel === 'home:overview')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('group', { name: 'Suggestions' })).toBeNull();
    fireEvent.change(input, { target: { value: 'Which month was worst?' } });
    fireEvent.submit(input.closest('form')!);
    const composer = await screen.findByRole('textbox', { name: 'Ask the Assistant' });
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe('Which month was worst?'));
    expect(document.getElementById('dock-panel')!.contains(document.activeElement)).toBe(true);
    expect(calls.some((c) => c.channel === 'copilot:ask')).toBe(false);
  });

  it('shows the tour from the server, the next stop first in blue, and folds it', async () => {
    const calls = stubServer({ 'onboarding:set': { ok: true } });
    renderApp('/');
    const card = await screen.findByRole('region', { name: 'Get started' });
    expect(within(card).getByText('1 of 4')).toBeTruthy();
    expect(within(card).getAllByRole('img', { name: 'Done' }).length).toBe(1);
    expect(within(card).getByText('Visited')).toBeTruthy();
    // The next stop is the first not visited, in the server's order: Dashboards, with the card's one filled button.
    const next = within(card).getByText('Next').closest('li')!;
    expect(next.getAttribute('data-step')).toBe('dashboards');
    expect(within(next).getByRole('link', { name: 'Open Dashboards' }).getAttribute('href')).toBe('/dashboards');
    expect(within(card).getByRole('link', { name: 'Open Data' }).getAttribute('href')).toBe('/data');
    fireEvent.click(within(card).getByRole('button', { name: 'Fold the checklist into a progress pill' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'onboarding:set')?.payload).toEqual({ collapsed: true }));
  });

  it('gives a viewer their own tour, folded to the pill, and lets them hide it', async () => {
    const calls = stubServer({ 'onboarding:status': { show: true, collapsed: true, steps: TOUR, doneCount: 1, total: 4 }, 'onboarding:set': { ok: true } }, 'viewer');
    renderApp('/');
    const pill = await screen.findByRole('button', { name: 'Get started: 1 of 4 done, show the checklist' });
    expect(calls.some((c) => c.channel === 'onboarding:status')).toBe(true);
    fireEvent.click(pill);
    await waitFor(() => expect(calls.find((c) => c.channel === 'onboarding:set')?.payload).toEqual({ collapsed: false }));
  });

  it('puts Data first while the project has no data, and the Assistant’s Ask opens the dock', async () => {
    const steps = [{ id: 'assistant', done: false }, ...TOUR.map((x) => ({ ...x, done: false }))];
    stubServer({
      'home:overview': { ...MINE, counts: { datasets: 0, dashboards: 0, captures: 0, visuals: 0 }, datasets: [] },
      'onboarding:status': { show: true, collapsed: false, steps, doneCount: 0, total: 5 },
    });
    renderApp('/');
    const card = await screen.findByRole('region', { name: 'Get started' });
    await waitFor(() => expect(card.querySelector('li')?.getAttribute('data-step')).toBe('data'));
    expect(within(card).getByText('Next').closest('li')!.getAttribute('data-step')).toBe('data');
    expect([...card.querySelectorAll('li')].map((li) => li.getAttribute('data-step'))).toEqual(['data', 'assistant', 'explore', 'dashboards', 'reports']);
    fireEvent.click(within(card).getByRole('button', { name: 'Ask' }));
    expect(await screen.findByRole('complementary', { name: 'Assistant' })).toBeTruthy();
  });

  it('designs the empty states: no project, no work', async () => {
    stubServer({ 'projects:list': [], 'recent:list': [], 'starred:get': [], 'onboarding:status': { show: false } });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'No project yet' })).toBeTruthy();
    // An org admin may create one, right here.
    expect(await screen.findByRole('button', { name: 'New project' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Your work will collect here' })).toBeTruthy();
    // No work at all: nothing to bring data into yet, and no Starred row to fill.
    expect(screen.queryByRole('link', { name: 'Bring in some data' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Starred' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
  });

  it('gives an editor of an empty project the doors to bring data in', async () => {
    stubServer({ 'recent:list': [], 'home:overview': { counts: { datasets: 0, dashboards: 0, captures: 0, visuals: 0 }, datasets: [] } });
    renderApp('/');
    expect((await screen.findByRole('link', { name: 'Bring in some data' })).getAttribute('href')).toBe(`/data/import?project=${P}`);
    expect(screen.getByRole('link', { name: 'Browse sources' }).getAttribute('href')).toBe(`/connections/${P}`);
    expect(screen.queryByRole('region', { name: 'Starred' })).toBeNull();
  });

  it('shows a project viewer Home without the controls that change the project', async () => {
    stubServer({ 'onboarding:status': { show: false } }, 'viewer');
    renderApp('/');
    const rec = await screen.findByRole('region', { name: 'Recent' });
    expect(await within(rec).findByRole('link', { name: /^Orders/ })).toBeTruthy(); // the work is still theirs to read
    expect(within(rec).getByRole('button', { name: 'Star Orders' })).toBeTruthy(); // and to pin: a pin is their own
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
    cleanup();
    stubServer({ 'recent:list': [], 'onboarding:status': { show: false } }, 'viewer');
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Your work will collect here' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Bring in some data' })).toBeNull();
    // Negative control: the same page, as an editor, has them.
    cleanup();
    stubServer({ 'recent:list': [], 'onboarding:status': { show: false } });
    renderApp('/');
    expect(await screen.findByRole('button', { name: 'New' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Bring in some data' })).toBeTruthy();
  });

  it('shows each failed read with its own retry', async () => {
    stubServer({ 'recent:list': { status: 500, body: { error: 'disk on fire' } }, 'projects:list': { status: 500, body: { error: 'no projects for you' } } });
    renderApp('/');
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBe(2));
    const text = screen.getAllByRole('alert').map((a) => a.textContent).join(' | ');
    expect(text).toContain('Recent work could not be loaded');
    expect(text).toContain('disk on fire');
    expect(text).toContain('Your projects could not be loaded');
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the page up when only the overview fails: the work is still listed', async () => {
    stubServer({ 'home:overview': { status: 403, body: { error: 'forbidden' } } });
    renderApp('/');
    const rec = await screen.findByRole('region', { name: 'Recent' });
    expect(await within(rec).findByRole('link', { name: /^Orders/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('project-switcher').textContent).toContain('My project'));
  });
  it('follows the switcher: a new empty project, then back to the one with the work', async () => {
    const B = '33333333-3333-4333-8333-333333333333';
    const OLD = '2026-10-01T10:00:00.000Z';
    const opened: Record<string, string> = { [P]: OLD };
    let made = false;
    // The server lists the newest EDITED first: once made, the empty project leads (projects:open stamps only lastOpenedAt).
    const projects = () => [
      ...(made ? [{ id: B, name: 'Empty New Project', createdAt: NOW, updatedAt: NOW, lastOpenedAt: opened[B] }] : []),
      { id: P, name: 'Sales', createdAt: OLD, updatedAt: OLD, lastOpenedAt: opened[P] },
    ];
    stubServer({
      'projects:list': projects,
      'projects:roles': { [P]: 'admin', [B]: 'admin' },
      'projects:create': () => ((made = true), { id: B, name: 'Empty New Project' }),
      'projects:open': (p: unknown) => {
        const id = (p as { id: string }).id;
        opened[id] = new Date(Date.now() + Object.keys(opened).length * 1000).toISOString();
        return projects().find((x) => x.id === id) ?? null;
      },
      'home:overview': (p: unknown) => ((p as { projectId: string }).projectId === P ? MINE : { counts: { datasets: 0, dashboards: 0, captures: 0, visuals: 0 }, datasets: [] }),
      'onboarding:status': { show: false },
    });
    renderApp('/');
    const mine = [`/data/${P}/d1`, `/analyses/${P}/a1`, `/visuals/${P}/v1`];
    const links = (name: string) => within(screen.getByRole('region', { name })).getAllByRole('link').map((a) => a.getAttribute('href'));
    await waitFor(() => expect(links('Recent')).toEqual(mine));

    fireEvent.click(screen.getByTestId('project-switcher'));
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(await screen.findByLabelText('Project name'), { target: { value: 'Empty New Project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByTestId('project-switcher').textContent).toContain('Empty New Project'));
    expect((await screen.findByRole('link', { name: 'Bring in some data' })).getAttribute('href')).toBe(`/data/import?project=${B}`);
    // Recent follows too: nothing of Sales's, only the empty project's ways in.
    expect(links('Recent')).toEqual([`/data/import?project=${B}`, `/connections/${B}`]);

    // Back to the project with the work: the switcher and every part of Home follow at once.
    fireEvent.click(screen.getByTestId('project-switcher'));
    const pop = await screen.findByRole('dialog', { name: 'Projects' });
    fireEvent.click(within(pop).getByRole('button', { name: /^Sales.*opened/ }));
    await waitFor(() => expect(screen.getByTestId('project-switcher').textContent).toContain('Sales'));
    await waitFor(() => expect(links('Recent')).toEqual(mine));
    // And it stays there once the lists refetch.
    await new Promise((r) => setTimeout(r, 50));
    expect(links('Recent')).toEqual(mine);
  });
});
