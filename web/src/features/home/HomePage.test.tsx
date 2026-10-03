import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  { type: 'dataset', id: 'd1', projectId: P, projectName: 'My project', name: 'Orders', updatedAt: NOW, meta: { rowCount: 5000, columnCount: 9 } },
  { type: 'analysis', id: 'a1', projectId: P, projectName: 'My project', name: 'Sales overview', updatedAt: NOW, meta: { sheetCount: 2 } },
  { type: 'dataset', id: 'd2', projectId: Q, projectName: 'Other', name: 'Elsewhere', updatedAt: NOW },
];

type Reply = unknown; // a canned reply, or a (payload) => reply function

/** fetch, answered per RPC channel; records each call's payload. `{ status, body }` replies fail. */
function stubServer(replies: Record<string, Reply>, role = 'admin') {
  const calls: { channel: string; payload: unknown }[] = [];
  const all: Record<string, Reply> = {
    'projects:list': [{ id: P, name: 'My project', createdAt: NOW, updatedAt: NOW }],
    'recent:list': recent,
    'starred:get': ['analysis:a1'],
    'home:overview': {
      counts: { datasets: 2, dashboards: 1, captures: 0, visuals: 1 },
      datasets: [
        { id: 'd1', name: 'Orders', rowCount: 5000, columnCount: 9, qualityFailing: 1 },
        { id: 'd3', name: 'Returns', rowCount: 12, columnCount: 3 },
      ],
      visuals: [{ id: 'v1', name: 'Revenue by month', chartType: 'line' }],
    },
    'onboarding:status': { show: true, collapsed: false, steps: [{ id: 'import', done: true }], doneCount: 1, total: 4 },
    'jobs:list': { active: [], recent: [] },
    'prefs:get': { formats: {}, branding: { accent: '' } },
    // The Assistant dock (T2.12): not set up, unless a test says otherwise.
    'key:status': { isReady: false, copilotEnabled: true, byok: { activeProvider: null, providers: {} }, allowedProviders: [], keyStore: null },
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
  it('greets, then fills the hero, Starred, Recent and the side column from the server', async () => {
    stubServer({});
    renderApp('/');
    expect(await screen.findByRole('status', { name: 'Loading recent work' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('home-greet').textContent).toMatch(/^(Good (morning|afternoon|evening)|Good to see you), Dev$/));
    expect((await screen.findByTestId('home-sub')).textContent).toBe('My project  ·  2 datasets  ·  1 dashboard');

    const starred = screen.getByRole('region', { name: 'Starred' });
    expect(await within(starred).findByRole('link', { name: /^Sales overview, Dashboard, 2 sheets, in My project/ })).toBeTruthy();
    const rec = screen.getByRole('region', { name: /Recent/ });
    // This project only (the scope), and not the pinned dashboard.
    const links = within(rec).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/data/${P}/d1`]);
    expect(links[0]!.getAttribute('aria-label')).toMatch(/^Orders, Dataset, 5,000 rows × 9 columns, in My project, /);

    const side = screen.getByRole('complementary', { name: 'This project' });
    expect(within(side).getByRole('link', { name: /Orders/ }).getAttribute('href')).toBe(`/data/${P}/d1`);
    expect(within(side).getByRole('img', { name: 'Data quality: 1 rule failing' })).toBeTruthy();
    expect(within(side).getByText('12 rows × 3 cols')).toBeTruthy();
    expect(within(side).getByRole('link', { name: 'Revenue by month' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What stands out in Orders?' })).toBeTruthy();
  });

  it('widens Recent to every project and narrows it by type, without asking the server again', async () => {
    const calls = stubServer({});
    renderApp('/');
    const rec = await screen.findByRole('region', { name: /Recent/ });
    await within(rec).findByRole('link', { name: /^Orders/ });
    const before = calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(within(rec).getAllByRole('link').map((a) => a.textContent)).toEqual([expect.stringContaining('Orders'), expect.stringContaining('Elsewhere')]);
    expect(localStorage.getItem('ordinate.recentAllProjects')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Dashboards' }));
    expect(within(rec).queryByRole('list')).toBeNull();
    expect(within(rec).getByRole('heading', { name: 'Your work will collect here' })).toBeTruthy();
    expect(calls.length).toBe(before);
  });

  it('stars and unstars a row as the caller\'s own pins', async () => {
    const calls = stubServer({ 'starred:set': (p: unknown) => ({ ok: true, starred: (p as { ids: string[] }).ids }) });
    renderApp('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Star Orders' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'starred:set')?.payload).toEqual({ ids: ['analysis:a1', 'dataset:d1'] }));
    const starred = screen.getByRole('region', { name: 'Starred' });
    expect(await within(starred).findByRole('button', { name: 'Unstar Orders' })).toBeTruthy();
  });

  it('hands a question to the Assistant dock, which asks it; a chip only fills the bar', async () => {
    const calls = stubServer({
      'key:status': { isReady: true, copilotEnabled: true, byok: { activeProvider: 'anthropic', providers: {} }, allowedProviders: ['anthropic'], keyStore: null },
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
    expect(await screen.findByText('No project yet — bring some data in to begin.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Your work will collect here' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Nothing pinned yet' })).toBeTruthy();
    expect(screen.getByText('No datasets yet — connect one below.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Bring in some data' }).getAttribute('href')).toBe('/data');
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
  });

  it('shows each failed read with its own retry', async () => {
    stubServer({ 'recent:list': { status: 500, body: { error: 'disk on fire' } }, 'home:overview': { status: 403, body: { error: 'forbidden' } } });
    renderApp('/');
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBe(2));
    const text = screen.getAllByRole('alert').map((a) => a.textContent).join(' | ');
    expect(text).toContain('Recent work could not be loaded');
    expect(text).toContain('disk on fire');
    expect(text).toContain('Your data could not be loaded');
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThanOrEqual(2);
  });
});
