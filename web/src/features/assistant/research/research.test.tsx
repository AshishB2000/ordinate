// Deep research in the web (docs/deep-research/00-design.md, "Screens"): the composer's switch, the run card in each state, the report
// page, and Admin → AI's limits. Every reply is canned: the run, its steps and every number in them are the server's.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../../test-utils';
import { setDockOpen } from '../dockState';

afterEach(() => {
  act(() => setDockOpen(false));
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const RID = 'c1111111-1111-4111-8111-111111111111';
const STORY = 'd1111111-1111-4111-8111-111111111111';
const ME = (role: string) => ({ user: { email: 'ed@acme.test', role }, org: 'acme', mode: 'oidc', canSignOut: true });
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', isDefault: true };
const LIMITS = { steps: 8, queries: 12, minutes: 10 };

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });
function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
    const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
    if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
    const r = routes[channel] ?? { body: [] };
    const out = typeof r === 'function' ? r(payload) : r;
    return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
  }));
  return calls;
}

const run = (over: Record<string, unknown> = {}) => ({
  id: RID, projectId: PID, threadId: 't1', agentId: null, question: 'Why did sales move in the West?', state: 'running',
  plan: ['How do sales split by region?', 'What changed between the last two periods?', 'Which customers drive it?'],
  steps: [
    { n: 1, kind: 'answer', title: 'Sales by region', status: 'done' },
    { n: 2, kind: 'answer', title: '', status: 'refused', reason: 'The model replied with words instead of one step.' },
  ],
  report: null, storyId: null, errorCode: null, stepsUsed: 3, queriesUsed: 1, limits: LIMITS, elapsedSec: 83, resumable: false, startedAt: '2026-11-20T10:00:00Z', finishedAt: null, ...over,
});
const REPORT = {
  title: 'Where West sales come from', summary: 'West leads the regions.', conclusion: 'Keep watching West.', writtenAt: '2026-11-20T10:05:00Z',
  sections: [{ heading: 'By region', text: 'West is highest.', steps: [1] }], caveats: ['The data is monthly.'],
};
const CARD = { ok: true, title: 'Sales by region', chartType: 'column', caption: 'West leads sales.', data: { labels: ['West', 'East'], series: [{ name: 'sum of sales', values: [1784, 1664] }] } };

const common = (role = 'editor', extra: Record<string, Reply> = {}): Record<string, Reply> => ({
  '/api/auth/me': { body: ME(role) },
  'projects:list': { body: [{ id: PID, name: 'Ledger', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }] },
  'ai:status': { body: { ready: true, models: [SONNET], mine: { provider: 'anthropic', model: SONNET.model }, copilotEnabled: true, keyStore: null } },
  'copilot:history': { body: { ok: true, turns: [], threadId: null } },
  'dataset:list': { body: [] },
  'projects:roles': { body: { [PID]: role } },
  'agent:list': { body: { ok: true, agents: [], preselected: null, canManage: false, canInstruct: false } },
  'research:list': { body: { ok: true, activeRunId: null, limits: LIMITS, runs: [] } },
  ...extra,
});
async function openDock() {
  fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
  await screen.findByRole('textbox', { name: 'Ask the Assistant' });
  return document.getElementById('dock-panel') as HTMLElement;
}
const turnsWithRun = { ok: true, threadId: 't1', turns: [
  { id: 'u1', role: 'user', text: 'Why did sales move in the West?', createdAt: '2026-11-20T10:00:00Z' },
  { id: 'a1', role: 'assistant', text: 'Deep research on this question; the report opens from here.', createdAt: '2026-11-20T10:00:01Z', research: { runId: RID } },
] };

describe('the composer\'s Deep research switch', () => {
  it('is there for an editor, off, and says what it does when pressed', async () => {
    serve(common());
    const dock = await (async () => { renderApp('/'); return openDock(); })();
    const toggle = await within(dock).findByRole('button', { name: 'Deep research' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(await within(dock).findByText('Runs several steps and writes a report. Up to 10 minutes.')).toBeTruthy();
  });

  it('is not drawn for a viewer, who cannot start one', async () => {
    serve(common('viewer'));
    renderApp('/');
    const dock = await openDock();
    expect(within(dock).queryByRole('button', { name: 'Deep research' })).toBeNull();
  });

  it('is disabled, with its reason, while a run is going', async () => {
    serve(common('editor', { 'research:list': { body: { ok: true, activeRunId: RID, limits: LIMITS, runs: [] } } }));
    renderApp('/');
    const dock = await openDock();
    const toggle = await within(dock).findByRole('button', { name: 'Deep research' });
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(true));
    expect(within(dock).getByText('A research run is in progress. Stop it or wait for it to finish.')).toBeTruthy();
  });

  it('is not drawn when AI is not ready (the composer already says why)', async () => {
    serve(common('editor', { 'ai:status': { body: { ready: false, reason: 'no_model', models: [], mine: null, copilotEnabled: true, keyStore: null } } }));
    renderApp('/');
    const dock = await openDock();
    expect(within(dock).queryByRole('button', { name: 'Deep research' })).toBeNull();
  });

  it('a message sent with it on starts a run, not an ask, and the toggle goes back off', async () => {
    const calls = serve(common('editor', {
      'research:start': { body: { ok: true, runId: RID, threadId: 't1', turns: turnsWithRun.turns } },
      'research:get': { body: { ok: true, run: run({ steps: [], plan: [], stepsUsed: 0, queriesUsed: 0, state: 'queued' }) } },
    }));
    renderApp('/');
    const dock = await openDock();
    fireEvent.click(await within(dock).findByRole('button', { name: 'Deep research' }));
    fireEvent.change(within(dock).getByRole('textbox', { name: 'Ask the Assistant' }), { target: { value: 'Why did sales move in the West?' } });
    fireEvent.click(within(dock).getByRole('button', { name: 'Send' }));
    expect(await within(dock).findByTestId('research-card')).toBeTruthy();
    expect(calls.find((c) => c.channel === 'research:start')?.payload).toMatchObject({ projectId: PID, question: 'Why did sales move in the West?' });
    expect(calls.some((c) => c.channel === 'copilot:ask')).toBe(false);
    expect(within(dock).getByRole('button', { name: 'Deep research' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('a refused start keeps the question and says why', async () => {
    serve(common('editor', { 'research:start': { body: { ok: false, error: 'You already have a research run in progress. Stop it or wait for it to finish.' } } }));
    renderApp('/');
    const dock = await openDock();
    fireEvent.click(await within(dock).findByRole('button', { name: 'Deep research' }));
    const box = within(dock).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Another one' } });
    fireEvent.click(within(dock).getByRole('button', { name: 'Send' }));
    expect(await within(dock).findByRole('alert')).toBeTruthy();
    expect(box.value).toBe('Another one');
  });
});

describe('the run card', () => {
  const withRun = async (r: unknown, more: Record<string, Reply> = {}) => {
    const calls = serve(common('editor', { 'copilot:history': { body: turnsWithRun }, 'research:get': { body: { ok: true, run: r } }, ...more }));
    renderApp('/');
    const dock = await openDock();
    return { calls, dock, card: await within(dock).findByTestId('research-card') };
  };

  it('while running: the question, the plan, a meter against the limits, the steps with their reasons, and Stop', async () => {
    const { calls, card } = await withRun(run(), { 'research:stop': { body: { ok: true } } });
    expect(within(card).getByText('Why did sales move in the West?')).toBeTruthy();
    expect(within(card).getByText('Researching')).toBeTruthy();
    expect(within(card).getByText('How do sales split by region?')).toBeTruthy();
    const meter = within(card).getByTestId('research-meter');
    expect(within(meter).getByText('3 of 8')).toBeTruthy();
    expect(within(meter).getByText('1 of 12')).toBeTruthy();
    expect(within(meter).getByText('1:23 of 10:00')).toBeTruthy();
    const steps = within(card).getByRole('list', { name: 'Steps' });
    expect(within(steps).getByText('Sales by region')).toBeTruthy();
    expect(within(steps).getByText('The model replied with words instead of one step.')).toBeTruthy();
    expect(within(steps).getByLabelText('Running')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Stop research' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'research:stop')?.payload).toEqual({ projectId: PID, runId: RID }));
  });

  it('queued: says it is waiting, with no steps yet', async () => {
    const { card } = await withRun(run({ state: 'queued', steps: [], plan: [], stepsUsed: 0, queriesUsed: 0 }));
    expect(within(card).getByText('Waiting to start')).toBeTruthy();
    expect(within(card).getByText('Waiting for a free worker')).toBeTruthy();
  });

  it('finished: Open report (to the report page), private until added, and no Stop', async () => {
    const { card } = await withRun(run({ state: 'done', report: REPORT, stepsUsed: 4 }));
    expect(within(card).getByText('Finished')).toBeTruthy();
    expect((within(card).getByRole('link', { name: 'Open report' }) as HTMLAnchorElement).getAttribute('href')).toBe(`/research/${PID}/${RID}`);
    expect(within(card).getByText('Only you can see this report')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Stop research' })).toBeNull();
  });

  it('added: Open story replaces the private line', async () => {
    const { card } = await withRun(run({ state: 'done', report: REPORT, storyId: STORY }));
    expect((within(card).getByRole('link', { name: 'Open story' }) as HTMLAnchorElement).getAttribute('href')).toBe(`/stories/${PID}/${STORY}`);
    expect(within(card).queryByText('Only you can see this report')).toBeNull();
  });

  it('stopped early by a limit: says which, offers the report and Resume', async () => {
    const { calls, card } = await withRun(run({ state: 'partial', errorCode: 'steps', report: REPORT, resumable: true }), { 'research:resume': { body: { ok: true } } });
    expect(within(card).getByText('Stopped at the step limit.')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open report' })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'research:resume')).toBe(true));
  });

  it('failed: says why, with Resume', async () => {
    const failed = await withRun(run({ state: 'failed', errorCode: 'model', resumable: true }));
    expect(within(failed.card).getByText('The AI model did not answer.')).toBeTruthy();
    expect(within(failed.card).getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('failed on access: says so, and has no Resume', async () => {
    const lost = await withRun(run({ state: 'failed', errorCode: 'access', resumable: false }));
    expect(within(lost.card).getByText('You no longer have access to run research here.')).toBeTruthy();
    expect(within(lost.card).queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('a run that cannot be loaded is a calm state with a retry, not a crash', async () => {
    const { card } = await withRun(null, { 'research:get': { body: { ok: false, error: 'That research run was not found.' } } });
    expect(within(card).getByText('That research run was not found.')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('the report page', () => {
  const open = (r: unknown, more: Record<string, Reply> = {}) => {
    const calls = serve(common('editor', { 'research:get': { body: { ok: true, run: r } }, 'research:card': { body: CARD }, ...more }));
    renderApp(`/research/${PID}/${RID}`);
    return calls;
  };

  it('shows the title, summary, sections with live charts and prose, caveats in a callout, and how it was made', async () => {
    const calls = open(run({ state: 'done', report: REPORT }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Where West sales come from' })).toBeTruthy();
    expect(screen.getByText('West leads the regions.')).toBeTruthy();
    const section = screen.getByRole('region', { name: 'By region' });
    expect(within(section).getByText('West is highest.')).toBeTruthy();
    expect(await within(section).findByTestId('report-chart')).toBeTruthy();
    expect(calls.find((c) => c.channel === 'research:card')?.payload).toEqual({ projectId: PID, runId: RID, step: 1 });
    const caveats = screen.getByTestId('research-caveats');
    expect(within(caveats).getByText('The data is monthly.')).toBeTruthy();
    expect(screen.getByText('Keep watching West.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'How this was made' })).toBeTruthy();
    expect(screen.getByText('Only you can see this report')).toBeTruthy();
  });

  it('Add to project makes the story, then offers it', async () => {
    let added = false;
    const calls = open(run({ state: 'done', report: REPORT }), {
      'research:addToProject': () => { added = true; return { body: { ok: true, storyId: STORY, created: true } }; },
      'research:get': () => ({ body: { ok: true, run: run({ state: 'done', report: REPORT, storyId: added ? STORY : null }) } }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to project' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'research:addToProject')).toBe(true));
    const link = await screen.findAllByRole('link', { name: 'Open story' });
    expect(link[0].getAttribute('href')).toBe(`/stories/${PID}/${STORY}`);
    await waitFor(() => expect(screen.queryByText('Only you can see this report')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Add to project' })).toBeNull();
  });

  it('a chart the server cannot draw now says so inside its frame; the rest of the report stands', async () => {
    open(run({ state: 'done', report: REPORT }), { 'research:card': { body: { ok: false, reason: 'You no longer have access to that data.' } } });
    expect(await screen.findByTestId('report-chart-error')).toBeTruthy();
    expect(screen.getByText('You no longer have access to that data.')).toBeTruthy();
    expect(screen.getByText('West is highest.')).toBeTruthy();
  });

  it('a report of charts only says why it has no words', async () => {
    open(run({ state: 'partial', errorCode: 'write', report: { ...REPORT, summary: '', conclusion: '', caveats: [], chartsOnly: true, sections: [{ heading: 'Sales by region', text: '', steps: [1] }] } }));
    expect(await screen.findByText(/The report could not be written, so it holds the charts only/)).toBeTruthy();
  });

  it('someone else\'s report (or a removed one) is a clear error with a retry, never its content', async () => {
    open(null, { 'research:get': { body: { ok: false, error: 'That research run was not found.' } } });
    expect(await screen.findByRole('heading', { name: 'This report is not available' })).toBeTruthy();
    expect(screen.getByText('That research run was not found.')).toBeTruthy();
  });

  it('a run still going has no report yet; a run that wrote none says why', async () => {
    open(run());
    expect(await screen.findByRole('heading', { name: 'The report is not ready yet' })).toBeTruthy();
    cleanup();
    open(run({ state: 'failed', errorCode: 'no_steps' }));
    expect(await screen.findByRole('heading', { name: 'This run wrote no report' })).toBeTruthy();
    expect(screen.getByText('No step could be computed.')).toBeTruthy();
  });
});

describe('Admin → AI: deep research limits', () => {
  const open = (more: Record<string, Reply> = {}) => {
    const calls = serve({
      '/api/auth/me': { body: ME('admin') },
      'ai:admin': { body: { keyStore: null, providers: [], models: [] } },
      'research:limits': { body: { ok: true, limits: LIMITS, ceilings: { steps: 20, queries: 30, minutes: 30 } } },
      ...more,
    });
    renderApp('/admin?tab=ai');
    return calls;
  };

  it('shows the three limits with their ceilings and defaults', async () => {
    open();
    const form = await screen.findByRole('form', { name: 'Deep research limits' });
    expect((within(form).getByLabelText('Steps') as HTMLInputElement).value).toBe('8');
    expect((within(form).getByLabelText('Engine queries') as HTMLInputElement).value).toBe('12');
    expect((within(form).getByLabelText('Minutes') as HTMLInputElement).value).toBe('10');
    expect(within(form).getByText(/Up to 20; the default is 8/)).toBeTruthy();
    expect((within(form).getByRole('button', { name: 'Save limits' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a value past its ceiling is refused on the spot, and nothing is sent', async () => {
    const calls = open();
    const form = await screen.findByRole('form', { name: 'Deep research limits' });
    fireEvent.change(within(form).getByLabelText('Steps'), { target: { value: '21' } });
    expect(within(form).getByText('A whole number from 1 to 20.')).toBeTruthy();
    const save = within(form).getByRole('button', { name: 'Save limits' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(form);
    expect(calls.some((c) => c.channel === 'research:setLimits')).toBe(false);
  });

  it('saves a changed limit', async () => {
    const calls = open({ 'research:setLimits': { body: { ok: true, limits: { steps: 12, queries: 12, minutes: 10 }, ceilings: { steps: 20, queries: 30, minutes: 30 } } } });
    const form = await screen.findByRole('form', { name: 'Deep research limits' });
    fireEvent.change(within(form).getByLabelText('Steps'), { target: { value: '12' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'research:setLimits')?.payload).toEqual({ steps: 12, queries: 12, minutes: 10 }));
  });

  it('a server refusal is shown in the form', async () => {
    open({ 'research:setLimits': { body: { ok: false, error: 'Each limit must be a whole number from 1 up to its ceiling.' } } });
    const form = await screen.findByRole('form', { name: 'Deep research limits' });
    fireEvent.change(within(form).getByLabelText('Minutes'), { target: { value: '15' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save limits' }));
    expect(await within(form).findByRole('alert')).toBeTruthy();
  });

  it('a load failure is an error state with a retry', async () => {
    open({ 'research:limits': { status: 500, body: { error: 'boom' } } });
    expect(await screen.findByRole('heading', { name: 'The limits could not load' })).toBeTruthy();
  });
});
