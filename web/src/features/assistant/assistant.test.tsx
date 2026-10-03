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
const provider = (connected: boolean) => ({ hasKey: connected, verified: connected, connected, baseUrl: '', maxTokens: '', model: '' });
const status = (ready: boolean) => ({
  isReady: ready,
  copilotEnabled: true,
  byok: { activeProvider: ready ? 'anthropic' : null, providers: { anthropic: provider(ready), openai: provider(false), gemini: provider(false), gateway: provider(false) } },
  allowedProviders: ['anthropic', 'openai'],
  keyStore: null,
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
  'key:status': { body: status(ready) },
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
    expect(await within(dock).findByText('Powered by Anthropic')).toBeTruthy();
    expect(await within(dock).findByRole('button', { name: 'Which region had the worst month?' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull());
    expect(document.activeElement?.id).toBe('dock-toggle');
  });

  it('not set up, for an admin: connects with a write-only key — save, test, activate', async () => {
    let ready = false;
    const calls = serve({
      ...base(ADMIN, false),
      'key:status': () => ({ body: status(ready) }),
      'byok:saveProvider': { body: { ok: true } },
      'byok:test': { body: { ok: true, message: 'Connected' } },
      'byok:activate': () => {
        ready = true;
        return { body: { ok: true } };
      },
    });
    renderApp('/');
    const dock = await openDock();
    expect(await within(dock).findByText('The Assistant isn’t set up yet.')).toBeTruthy();
    expect((within(dock).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement).disabled).toBe(true);
    const key = within(dock).getByLabelText('API key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    fireEvent.change(key, { target: { value: 'sk-test-123' } });
    fireEvent.click(within(dock).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls.map((c) => c.channel).filter((c) => c.startsWith('byok:'))).toEqual(['byok:saveProvider', 'byok:test', 'byok:activate']));
    expect(calls.find((c) => c.channel === 'byok:saveProvider')?.payload).toEqual({ provider: 'anthropic', fields: { apiKey: 'sk-test-123' } });
    await waitFor(() => expect((within(dock).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement).disabled).toBe(false));
    expect(screen.queryByDisplayValue('sk-test-123')).toBeNull();
  });

  it('not set up, for a member: says an org admin connects one, and offers no key field', async () => {
    serve(base(VIEWER, false));
    renderApp('/');
    const dock = await openDock();
    expect(await within(dock).findByText(/An org admin connects a provider/)).toBeTruthy();
    expect(within(dock).queryByLabelText('API key')).toBeNull();
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
