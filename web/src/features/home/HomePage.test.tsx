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

type Reply = unknown; // a canned reply, or a (payload) => reply function

/** fetch, answered per RPC channel; records each call's payload. `{ status, body }` replies fail. */
function stubServer(replies: Record<string, Reply>, role = 'admin') {
  const calls: { channel: string; payload: unknown }[] = [];
  const all: Record<string, Reply> = {
    'projects:list': [{ id: P, name: 'My project', createdAt: NOW, updatedAt: NOW }],
    // The caller's role on the project follows the org role these tests pass.
    'projects:roles': { [P]: role === 'viewer' ? 'viewer' : 'admin' },
    'recent:list': recent,
    'starred:get': ['analysis:a1'],
    'home:overview': {
      counts: { datasets: 2, dashboards: 1, captures: 0, visuals: 1 },
      datasets: [
        { id: 'd1', name: 'Orders', rowCount: 5000, columnCount: 9, qualityFailing: 1 },
        { id: 'd3', name: 'Returns', rowCount: 12, columnCount: 3 },
      ],
    },
    'onboarding:status': { show: true, collapsed: false, steps: [{ id: 'import', done: true }], doneCount: 1, total: 4 },
    'jobs:list': { active: [], recent: [] },
    'prefs:get': { formats: {}, branding: { accent: '' } },
    // The Assistant dock (T2.12): not set up, unless a test says otherwise.
    'ai:status': { ready: false, reason: 'no_model', models: [], mine: null, copilotEnabled: true, keyStore: null },
    'copilot:history': { ok: true, turns: [], threadId: null },
    'dataset:list': [],
    ...replies,
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
      const r = all[channel];
      const v = typeof r === 'function' ? (r as (p: unknown) => unknown)(payload) : r;
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
      await screen.findByTestId('home-sub'); // the project is known, so the doors open in it
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
    expect((await screen.findByTestId('home-sub')).textContent).toBe('My project  ·  2 datasets  ·  1 dashboard');

    // Jump back in: this project's newest records, each opening the record itself.
    const jump = await screen.findByRole('region', { name: 'Jump back in' });
    const cards = within(jump).getAllByRole('link');
    expect(cards.map((a) => a.getAttribute('href'))).toEqual([`/data/${P}/d1`, `/analyses/${P}/a1`, `/visuals/${P}/v1`]);
    expect(cards[0]!.getAttribute('aria-label')).toMatch(/^Orders, Dataset, 5,000 rows × 9 columns, /);
    expect(cards[2]!.getAttribute('aria-label')).toMatch(/^Revenue by month, Visual, Line( chart)?, /);

    // The table: this project only (the scope), every type in one list, a pin shown on its own row.
    const rec = screen.getByRole('region', { name: 'Recent' });
    const links = within(rec).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/data/${P}/d1`, `/analyses/${P}/a1`, `/visuals/${P}/v1`]);
    expect(links[0]!.getAttribute('aria-label')).toMatch(/^Orders, Dataset, 5,000 rows × 9 columns, in My project, /);
    expect(links[1]!.getAttribute('aria-label')).toMatch(/^Sales overview, Dashboard, 2 sheets, in My project, /);
    expect(within(rec).getByRole('button', { name: 'Unstar Sales overview' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(rec).getByRole('button', { name: 'Star Orders' }).getAttribute('aria-pressed')).toBe('false');
    expect(within(rec).getByRole('img', { name: 'Data quality: 1 rule failing' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What stands out in Orders?' })).toBeTruthy();
    // Nothing on the page repeats the New menu's doors, and there is no side column.
    expect(screen.queryByRole('complementary', { name: 'This project' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'CSV / Excel' })).toBeNull();
  });

  it('widens Recent to every project and narrows it by type or to the pins, without asking the server again', async () => {
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
    // Starred: the caller's pins, in every project — so the scope has nothing to say there.
    fireEvent.click(screen.getByRole('button', { name: 'Starred' }));
    expect(names()).toEqual(['Sales overview']);
    expect(screen.queryByRole('button', { name: 'All projects' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Starred' }));
    expect(within(rec).getAllByRole('link').length).toBe(2);
    fireEvent.click(within(rec).getByRole('button', { name: 'Unstar Orders' }));
    await waitFor(() => expect(within(rec).getAllByRole('link').length).toBe(1));
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
    const input = screen.getByRole('textbox', { name: 'Ask about your data' });
    fireEvent.click(await screen.findByRole('button', { name: 'Summarise Orders in plain terms' }));
    expect((input as HTMLInputElement).value).toBe('Summarise Orders in plain terms');
    expect(calls.some((c) => c.channel === 'copilot:ask')).toBe(false);
    fireEvent.submit(input.closest('form')!);
    expect((input as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(calls.find((c) => c.channel === 'copilot:ask')?.payload).toMatchObject({ projectId: P, question: 'Summarise Orders in plain terms' }));
    expect(screen.getByRole('button', { name: 'Assistant' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the question in the dock\'s composer when the Assistant is not set up, focus in the dock', async () => {
    const calls = stubServer({});
    renderApp('/');
    const input = await screen.findByRole('textbox', { name: 'Ask about your data' });
    fireEvent.change(input, { target: { value: 'Which month was worst?' } });
    fireEvent.submit(input.closest('form')!);
    const composer = await screen.findByRole('textbox', { name: 'Ask the Assistant' });
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe('Which month was worst?'));
    expect(document.getElementById('dock-panel')!.contains(document.activeElement)).toBe(true);
    expect(calls.some((c) => c.channel === 'copilot:ask')).toBe(false);
  });

  it('shows the Get-started checklist from the server, folds it for an editor and not for a viewer', async () => {
    const calls = stubServer({ 'onboarding:set': { ok: true } });
    renderApp('/');
    const card = await screen.findByRole('region', { name: 'Get started' });
    expect(within(card).getByText('1 of 4')).toBeTruthy();
    expect(within(card).getAllByRole('img', { name: 'Done' }).length).toBe(1);
    expect(within(card).getByRole('link', { name: 'Open the builder' }).getAttribute('href')).toBe('/visuals');
    fireEvent.click(within(card).getByRole('button', { name: 'Fold the checklist into a progress pill' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'onboarding:set')?.payload).toEqual({ collapsed: true }));
  });

  it('gives a viewer the checklist without the controls that change the org\'s card', async () => {
    stubServer({}, 'viewer');
    renderApp('/');
    const card = await screen.findByRole('region', { name: 'Get started' });
    await waitFor(() => expect(screen.getByTestId('home-greet').textContent).toMatch(/Dev$/));
    expect(within(card).queryByRole('button', { name: 'Hide Get started' })).toBeNull();
  });

  it('designs the empty states: no project, no work, no pins', async () => {
    stubServer({ 'projects:list': [], 'recent:list': [], 'starred:get': [], 'onboarding:status': { show: false } });
    renderApp('/');
    expect(await screen.findByText('No project yet.')).toBeTruthy();
    // An org admin may create one, right here.
    expect(await screen.findByRole('button', { name: 'New project' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Your work will collect here' })).toBeTruthy();
    // No project: nothing to bring data into yet, and no cards to jump back to.
    expect(screen.queryByRole('link', { name: 'Bring in some data' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Jump back in' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Starred' }));
    expect(screen.getByRole('heading', { name: 'Nothing starred yet' })).toBeTruthy();
  });

  it('gives an editor of an empty project the doors to bring data in', async () => {
    stubServer({ 'recent:list': [], 'home:overview': { counts: { datasets: 0, dashboards: 0, captures: 0, visuals: 0 }, datasets: [] } });
    renderApp('/');
    expect((await screen.findByRole('link', { name: 'Bring in some data' })).getAttribute('href')).toBe(`/data/import?project=${P}`);
    expect(screen.getByRole('link', { name: 'Browse sources' }).getAttribute('href')).toBe(`/connections/${P}`);
    expect(screen.queryByRole('region', { name: 'Jump back in' })).toBeNull();
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
    expect((await screen.findByTestId('home-sub')).textContent).toBe('My project');
  });
});
