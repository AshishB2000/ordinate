import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { setDockOpen } from './dockState';
import { groupThreads } from './History';
import { starterPrompts } from './prompts';
import { provenanceLine } from './Transcript';

afterEach(() => {
  act(() => setDockOpen(false));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const ADMIN = { user: { email: 'boss@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true };
const VIEWER = { user: { email: 'pat@acme.test', role: 'viewer' }, org: 'acme', mode: 'oidc', canSignOut: true };
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', isDefault: true };
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', isDefault: false };
const FLASH = { provider: 'gemini', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', isDefault: false };
/** `ai:status`: ready with `models` (the first the caller's), or not set up. */
const status = (ready: boolean, models = [SONNET], keyStore: string | null = null) => ({
  ready,
  ...(ready ? {} : { reason: keyStore ? 'no_key_store' : 'no_model' }),
  models: ready ? models : [],
  mine: ready ? { provider: models[0].provider, model: models[0].model } : null,
  copilotEnabled: true,
  keyStore,
});

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });

function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      const r = routes[channel] ?? { body: [] };
      const out = typeof r === 'function' ? r(payload) : r;
      return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
    }),
  );
  return calls;
}

const base = (me: unknown, ready: boolean): Record<string, Reply> => ({
  '/api/auth/me': { body: me },
  'projects:list': { body: [{ id: PID, name: 'Ledger', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }] },
  'ai:status': { body: status(ready) },
  'copilot:history': { body: { ok: true, turns: [], threadId: null } },
  'dataset:list': { body: [{ id: 'd1', name: 'Retail orders' }] },
});

async function openDock() {
  fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
  // The panel is its own lazy chunk: wait for it, not for its loading frame.
  await screen.findByRole('textbox', { name: 'Ask the Assistant' });
  return document.getElementById('dock-panel') as HTMLElement;
}

describe('starter prompts', () => {
  it('writes the sample its own questions, leads with the context, never more than three', () => {
    expect(starterPrompts(['Retail orders'])).toEqual(['Which region had the worst month?', 'Revenue by category this year']);
    expect(starterPrompts([])).toEqual([]);
    expect(starterPrompts(['Sales', 'Costs'], 'Costs')).toEqual(['What stands out in Costs?', 'How do Costs and Sales compare?', 'Summarise Costs in plain terms']);
  });
});

describe('provenance', () => {
  it('is one footnote line, columns capped at six, the app named as the source', () => {
    expect(provenanceLine({ kind: 'dataset', name: 'Sales', columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).toBe('dataset: Sales · columns: a, b, c, d, e, f… · stats app-computed');
  });
});

describe('history groups', () => {
  it('splits by the viewer’s calendar day, keeps the server’s order inside a group, drops empty groups', () => {
    const at = (id: string, d: Date) => ({ id, title: id, updatedAt: d.toISOString(), turnCount: 1 });
    const now = new Date(2026, 9, 10, 9, 0);
    const groups = groupThreads(
      [at('a', new Date(2026, 9, 10, 8, 59)), at('b', new Date(2026, 9, 10, 0, 0)), at('c', new Date(2026, 9, 9, 23, 59)), at('d', new Date(2026, 9, 8, 23, 59)), { id: 'e', title: 'e', updatedAt: '', turnCount: 0 }],
      now,
    );
    expect(groups.map((g) => [g.label, g.threads.map((t) => t.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['Earlier', ['d', 'e']],
    ]);
    expect(groupThreads([at('a', now)], now).map((g) => g.label)).toEqual(['Today']);
  });
});

/** Seven conversations, newest first — two more than the title's menu shows. */
const THREADS = ['Revenue by region', 'Churn last month', 'Upload data', 'Top customers', 'Margin outliers', 'Q2 forecast check', 'Refund spikes'].map((title, i) => ({
  id: `0000000${i}-0000-4000-8000-000000000000`,
  title,
  updatedAt: new Date(Date.now() - i * 36 * 3600_000).toISOString(),
  turnCount: i + 1,
}));

describe('the dock header', () => {
  it('the title’s menu offers the five most recent conversations, then History for all of them, searchable', async () => {
    const calls = serve({ ...base(ADMIN, true), 'copilot:threads': { body: { ok: true, threads: THREADS } } });
    renderApp('/');
    const dock = await openDock();
    fireEvent.keyDown(within(dock).getByRole('button', { name: /^Conversations —/ }), { key: 'Enter' });
    await screen.findByRole('menuitem', { name: /Revenue by region/ });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Revenue by region1 turn', 'Churn last month2 turns', 'Upload data3 turns', 'Top customers4 turns', 'Margin outliers5 turns', 'All conversations']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'All conversations' }));
    const history = await screen.findByRole('dialog', { name: 'Conversation history' });
    expect(within(history).getAllByRole('button').length).toBe(THREADS.length);
    expect(within(history).getByText('Today')).toBeTruthy();
    expect(within(history).getByText('Earlier')).toBeTruthy();
    fireEvent.change(within(history).getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'refund' } });
    expect(within(history).getAllByRole('button').map((b) => b.textContent)).toEqual(['Refund spikes7 turns']);
    fireEvent.change(within(history).getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'zzz' } });
    expect(within(history).getByText('No conversation matches that search.')).toBeTruthy();
    fireEvent.change(within(history).getByRole('textbox', { name: 'Search conversations' }), { target: { value: 'refund' } });
    fireEvent.click(within(history).getByRole('button', { name: /Refund spikes/ }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'copilot:history' && (c.payload as { threadId?: string }).threadId === THREADS[6].id)).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Conversation history' })).toBeNull());
  });

  it('the clock opens History on its own; the ⋯ menu carries the org switch and Admin → AI for an admin', async () => {
    const calls = serve({ ...base(ADMIN, true), 'copilot:threads': { body: { ok: true, threads: THREADS.slice(0, 2) } }, 'copilot:setEnabled': { body: null } });
    renderApp('/');
    const dock = await openDock();
    expect(within(dock).queryByText(/Assistant: On/)).toBeNull(); // the pill is gone from the header
    fireEvent.click(within(dock).getByRole('button', { name: 'Conversation history' }));
    const history = await screen.findByRole('dialog', { name: 'Conversation history' });
    await within(history).findByRole('button', { name: /Churn last month/ });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Conversation history' })).toBeNull());
    expect(screen.getByRole('complementary', { name: 'Assistant' })).toBeTruthy(); // Escape closed History, not the dock

    await within(dock).findByText('Powered by Claude Sonnet 4.6'); // ai:status is in: the switch is offered
    fireEvent.keyDown(within(dock).getByRole('button', { name: 'More' }), { key: 'Enter' });
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Copy conversation', 'Turn the Assistant off', 'AI models']);
    expect(screen.getByRole('menuitem', { name: 'Copy conversation' }).getAttribute('aria-disabled')).toBe('true'); // nothing to copy yet
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn the Assistant off' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'copilot:setEnabled')?.payload).toEqual({ enabled: false }));
  });

  it('a member’s ⋯ menu has no org switch and no way to Admin', async () => {
    serve(base(VIEWER, true));
    renderApp('/');
    const dock = await openDock();
    await within(dock).findByTitle('Model: Claude Sonnet 4.6 · Default');
    fireEvent.keyDown(within(dock).getByRole('button', { name: 'More' }), { key: 'Enter' });
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Copy conversation']);
  });
});

describe('the composer', () => {
  it('@ points the Assistant at one thing: the chip names it, the ask carries its reference, × follows the screen again', async () => {
    const calls = serve({
      ...base(ADMIN, true),
      'visual:list': { body: [{ id: 'v1', name: 'Revenue by region' }, { id: 'v2', name: 'Orders per month' }] },
      'analysis:gallery': { body: [{ id: 'a1', name: 'Board pack' }] },
      'copilot:ask': { body: { ok: true, answer: 'ok', threadId: null, turns: [], suggestedAction: { kind: 'none', intent: '' } } },
    });
    renderApp('/');
    const dock = await openDock();
    const box = within(dock).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(false));

    // Inside a word — an email address — `@` is a character, not the picker.
    fireEvent.change(box, { target: { value: 'me' } });
    fireEvent.change(box, { target: { value: 'me@' } });
    expect(box.value).toBe('me@');
    expect(screen.queryByRole('dialog', { name: 'Point the Assistant at' })).toBeNull();

    // Where a word starts it opens the picker, and the `@` is not kept.
    fireEvent.change(box, { target: { value: 'Compare ' } });
    fireEvent.change(box, { target: { value: 'Compare @' } });
    expect(box.value).toBe('Compare ');
    const picker = await screen.findByRole('dialog', { name: 'Point the Assistant at' });
    await within(picker).findByRole('button', { name: 'Board pack' });
    await within(picker).findByRole('button', { name: 'Revenue by region' });
    expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(['What’s on screenDefault', 'Retail orders', 'Revenue by region', 'Orders per month', 'Board pack']);
    const search = within(picker).getByRole('textbox', { name: 'Search the project' });
    fireEvent.change(search, { target: { value: 'orders per' } });
    fireEvent.keyDown(search, { key: 'Enter' }); // the first match
    await waitFor(() => expect(within(dock).getByTestId('dock-context').textContent).toBe('Orders per month'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Point the Assistant at' })).toBeNull());

    fireEvent.change(box, { target: { value: 'Why the dip?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect((calls.find((c) => c.channel === 'copilot:ask')?.payload as { context: unknown } | undefined)?.context).toEqual({ kind: 'visual', id: 'v2' }));
    fireEvent.click(await within(dock).findByRole('button', { name: 'Follow what’s on screen again' }));
    expect(within(dock).getByTestId('dock-context').textContent).toBe('whole project');
  });

  it('Add data opens the import page’s doors in the dock’s project', async () => {
    serve(base(ADMIN, true));
    const router = renderApp('/');
    const dock = await openDock();
    const add = within(dock).getByRole('button', { name: 'Add data' }) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.keyDown(add, { key: 'Enter' });
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Import a file', 'Paste a table', 'Read a screenshot', 'Connect a source']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paste a table' }));
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(`/data/import?project=${PID}&source=paste`));
  });
});

describe('the dock', () => {
  it('opens from the top bar, shows its context, and closes on Escape back to the toggle', async () => {
    serve(base(ADMIN, true));
    renderApp('/');
    const dock = await openDock();
    expect(within(dock).getByTestId('dock-context').textContent).toBe('whole project');
    expect(await within(dock).findByText('Powered by Claude Sonnet 4.6')).toBeTruthy();
    expect(await within(dock).findByRole('button', { name: 'Which region had the worst month?' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull());
    expect(document.activeElement?.id).toBe('dock-toggle');
  });

  it('not set up, for an admin: the sentence and a Set up AI button to Admin → AI — no key field in the dock', async () => {
    serve(base(ADMIN, false));
    renderApp('/');
    const dock = await openDock();
    expect(await within(dock).findByText(/AI isn’t set up for your organization yet/)).toBeTruthy();
    const setUp = await within(dock).findByRole('link', { name: /Set up AI/ });
    expect(setUp.getAttribute('href')).toBe('/admin?tab=ai');
    expect((within(dock).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(within(dock).queryByLabelText('API key')).toBeNull();
  });

  it('not set up, for a member: the sentence alone — no button, no key field', async () => {
    serve(base(VIEWER, false));
    renderApp('/');
    const dock = await openDock();
    expect(await within(dock).findByText(/AI isn’t set up for your organization yet/)).toBeTruthy();
    await waitFor(() => expect(within(dock).queryByRole('link', { name: /Set up AI/ })).toBeNull());
    expect(within(dock).queryByLabelText('API key')).toBeNull();
  });

  it('not set up, on a server with no key store: an admin gets the operator line instead of the button', async () => {
    serve({ ...base(ADMIN, false), 'ai:status': { body: status(false, [], 'This server has no database, so it cannot store API keys.') } });
    renderApp('/');
    const dock = await openDock();
    expect(await within(dock).findByText(/An operator sets DATABASE_URL and ORDINATE_MASTER_KEY/)).toBeTruthy();
    expect(within(dock).queryByRole('link', { name: /Set up AI/ })).toBeNull();
  });

  it('one model: its name as text, no dropdown', async () => {
    serve(base(VIEWER, true));
    renderApp('/');
    const dock = await openDock();
    expect(await within(dock).findByTitle('Model: Claude Sonnet 4.6 · Default')).toBeTruthy();
    expect(within(dock).queryByRole('combobox', { name: 'Model' })).toBeNull();
  });

  it('several models: a picker grouped by provider, the default marked; choosing one saves YOUR pick', async () => {
    const calls = serve({ ...base(VIEWER, true), 'ai:status': { body: status(true, [SONNET, FLASH, HAIKU]) }, 'ai:setMine': { body: { ok: true } } });
    renderApp('/');
    const dock = await openDock();
    const picker = await within(dock).findByRole('combobox', { name: 'Model' });
    fireEvent.click(picker);
    const options = screen.getAllByRole('option'); // read and pick in one go: the list closes on the next layout check
    expect(options.map((o) => o.textContent)).toEqual(['Claude Sonnet 4.6 (Anthropic) · Default', 'Claude Haiku 4.5 (Anthropic)', 'Gemini 3.8 Flash (Google Gemini)']);
    fireEvent.click(options[2]);
    await waitFor(() => expect(calls.find((c) => c.channel === 'ai:setMine')?.payload).toEqual({ provider: 'gemini', model: 'gemini-3.8-flash' }));
  });

  it('asks, and draws the stored turns as TEXT — markup in an answer is never HTML', async () => {
    const answer = 'Revenue rose. <img src=x onerror="alert(1)"> <b>bold</b>';
    const calls = serve({
      ...base(ADMIN, true),
      'copilot:ask': {
        body: {
          ok: true,
          answer,
          threadId: '22222222-2222-4222-8222-222222222222',
          turns: [
            { id: 't1', role: 'user', text: 'What changed?', createdAt: '' },
            { id: 't2', role: 'assistant', text: answer, createdAt: '', provenance: { kind: 'project', name: 'Ledger', note: 'stats app-computed' } },
          ],
          suggestedAction: { kind: 'none', intent: '' },
        },
      },
    });
    renderApp('/');
    const dock = await openDock();
    const box = within(dock).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.change(box, { target: { value: 'What changed?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await within(dock).findByText(answer)).toBeTruthy();
    expect(dock.querySelector('img, b')).toBeNull();
    expect(within(dock).getByText('project: Ledger · stats app-computed')).toBeTruthy();
    const ask = calls.find((c) => c.channel === 'copilot:ask')?.payload as { askId: string; context: unknown; projectId: string };
    expect(ask.projectId).toBe(PID);
    expect(ask.context).toEqual({ kind: '' });
    expect(ask.askId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
