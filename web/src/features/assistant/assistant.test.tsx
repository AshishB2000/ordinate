import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { setDockOpen } from './dockState';
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

describe('the dock', () => {
  it('opens from the top bar, shows its context, and closes on Escape back to the toggle', async () => {
    serve(base(ADMIN, true));
    renderApp('/');
    const dock = await openDock();
    expect(within(dock).getByText('Based on whole project')).toBeTruthy();
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

  it('a reply that proposes bringing data in shows the three ways in, as links into this project', async () => {
    const turns = [
      { id: 't1', role: 'user', text: 'upload data', createdAt: '' },
      { id: 't2', role: 'assistant', text: 'Pick a file and I will take it from there.', createdAt: '' },
    ];
    serve({ ...base(ADMIN, true), 'copilot:ask': { body: { ok: true, answer: turns[1].text, threadId: null, turns, suggestedAction: { kind: 'import', intent: 'upload data' } } } });
    renderApp('/');
    const dock = await openDock();
    const box = within(dock).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(within(dock).queryByTestId('dock-get-data')).toBeNull(); // negative control: nothing proposed yet
    fireEvent.change(box, { target: { value: 'upload data' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const href = async (name: string) => (await within(dock).findByRole('link', { name })).getAttribute('href');
    expect(await href('Import a file')).toBe(`/data/import?project=${PID}`);
    expect(await href('Paste data')).toBe(`/data/import?project=${PID}&source=paste`);
    expect(await href('Connect a source')).toBe(`/connections/${PID}`);
  });
});
