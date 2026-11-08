// The Assistant full width (/assistant): the same conversation as the dock, given the page. Its empty
// state and its column of conversations; the dock's expand button into it and "Back to the side panel"
// out of it, on the same conversation each way; and the not-set-up state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { forgetPageThread, setDockOpen, takePendingQuestion, takePendingSpec } from './dockState';

// The page's last conversation is module state the dock reads: a page still settling as a test ends can leave one.
beforeEach(() => forgetPageThread());
afterEach(() => {
  act(() => {
    setDockOpen(false);
    takePendingQuestion();
    takePendingSpec();
    forgetPageThread();
  });
  window.history.replaceState(null, '');
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const BLANK = '00000001-0000-4000-8000-000000000000';
const REGION = '00000002-0000-4000-8000-000000000000';
const CHURN = '00000003-0000-4000-8000-000000000000';
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', isDefault: true };
const READY = { ready: true, models: [SONNET], mine: { provider: SONNET.provider, model: SONNET.model }, copilotEnabled: true, keyStore: null };
const NOT_READY = { ready: false, reason: 'no_model', models: [], mine: null, copilotEnabled: true, keyStore: null };
const now = new Date().toISOString();
/** Newest-touched first, as the server lists them: two today (one still blank), one long ago. */
const THREADS = [
  { id: BLANK, title: '', updatedAt: now, turnCount: 0 },
  { id: REGION, title: 'Revenue by region', updatedAt: now, turnCount: 2 },
  { id: CHURN, title: 'Churn last month', updatedAt: '2026-01-05T10:00:00Z', turnCount: 2 },
];
const TURNS: Record<string, unknown[]> = {
  [REGION]: [
    { id: 'r1', role: 'user', text: 'Revenue by region?', createdAt: now },
    { id: 'r2', role: 'assistant', text: 'North leads.', createdAt: now },
  ],
  [CHURN]: [
    { id: 'c1', role: 'user', text: 'Churn last month?', createdAt: now },
    { id: 'c2', role: 'assistant', text: 'It fell.', createdAt: now },
  ],
};

/** The server's thread resolution: an asked-for id, else the most recent (`newest`). */
function serve(newest: string, extra: Record<string, RpcReply> = {}) {
  return serveRpc({
    '/api/auth/me': { body: { user: { email: 'pat@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true } },
    'projects:list': { body: [{ id: PID, name: 'Ledger', updatedAt: now, lastOpenedAt: now, archived: false, datasets: 2, dashboards: 1, sample: false }] },
    'projects:overview': { body: [{ id: PID, name: 'Ledger', updatedAt: now, lastOpenedAt: now, archived: false, datasets: 2, dashboards: 1, sample: false }] },
    'projects:roles': { body: { [PID]: 'admin' } },
    'ai:status': { body: READY },
    'dataset:list': { body: [{ id: 'd1', name: 'Retail orders' }] },
    'copilot:threads': { body: { ok: true, threads: THREADS } },
    'copilot:history': (p) => {
      const id = (p as { threadId?: string }).threadId || newest;
      return { body: { ok: true, turns: TURNS[id] ?? [], threadId: id, title: THREADS.find((t) => t.id === id)?.title || null } };
    },
    ...extra,
  });
}

const historyOf = (calls: { channel: string; payload: unknown }[], id: string) => calls.some((c) => c.channel === 'copilot:history' && (c.payload as { threadId?: string }).threadId === id);

describe('the Assistant’s page', () => {
  it('starts on a greeting, the project in a line, the composer and the starters; the conversations run down the left, grouped and searchable', async () => {
    const calls = serve(BLANK);
    const router = renderApp('/assistant');
    const page = await screen.findByRole('region', { name: 'Assistant' });
    expect(within(page).getByRole('heading', { level: 1, name: 'Assistant' })).toBeTruthy();
    expect(await within(page).findByText(/^(Good (morning|afternoon|evening)|Good to see you), Pat$/)).toBeTruthy();
    expect(await within(page).findByText('Ledger · 2 datasets · 1 dashboard. Ask a question, or say what to build.')).toBeTruthy();
    expect(within(page).getByTestId('assistant-title').textContent).toBe('New conversation');
    const box = within(page).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.placeholder).toBe('Ask about your data, or say what to build…');
    expect(within(page).getByTestId('dock-context').textContent).toBe('@ Whole project');
    // A starter fills the composer; it never sends.
    fireEvent.click(await within(page).findByRole('button', { name: 'Which region had the worst month?' }));
    expect(box.value).toBe('Which region had the worst month?');
    expect(calls.some((c) => c.channel === 'copilot:ask')).toBe(false);

    // The project's conversations, by day, the open one marked.
    const list = within(page).getByRole('complementary', { name: 'Conversations' });
    const today = await within(list).findByRole('region', { name: 'Today' });
    expect(within(today).getAllByRole('button').map((b) => b.textContent)).toEqual(['Conversation', 'Revenue by region']);
    expect(within(within(list).getByRole('region', { name: 'Earlier' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Churn last month']);
    expect(within(today).getByRole('button', { name: 'Conversation' }).getAttribute('aria-current')).toBe('true');
    // Titles are searched.
    const search = within(list).getByRole('textbox', { name: 'Search conversations' });
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(within(list).getByText('No conversation matches that search')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'REGION' } });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['Revenue by region']);

    // Opening one shows it, marks it, and keeps it in the URL (a reload comes back to it).
    fireEvent.click(within(list).getByRole('button', { name: 'Revenue by region' }));
    await waitFor(() => expect(within(page).getByTestId('assistant-title').textContent).toBe('Revenue by region'));
    expect(historyOf(calls, REGION)).toBe(true);
    expect(await within(page).findByText('North leads.')).toBeTruthy();
    expect(within(list).getByRole('button', { name: 'Revenue by region' }).getAttribute('aria-current')).toBe('true');
    await waitFor(() => expect(router.state.location.search).toBe(`?thread=${REGION}`));
    expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull(); // no dock beside it
  });

  it('says so when there are no conversations yet; a thread id in the URL that is not one is ignored', async () => {
    const calls = serve(BLANK, { 'copilot:threads': { body: { ok: true, threads: [] } } });
    renderApp('/assistant?thread=../../etc');
    const list = await screen.findByRole('complementary', { name: 'Conversations' });
    expect(await within(list).findByText('No conversations yet')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.channel === 'copilot:history')).toBe(true));
    expect(calls.filter((c) => c.channel === 'copilot:history').every((c) => (c.payload as { threadId?: string }).threadId === undefined)).toBe(true);
  });

  it('without a model, explains it in the page, and asks nothing', async () => {
    const calls = serve(BLANK, { 'ai:status': { body: NOT_READY } });
    renderApp('/assistant');
    const page = await screen.findByRole('region', { name: 'Assistant' });
    expect(await within(page).findByTestId('ai-not-ready')).toBeTruthy();
    expect((within(page).getByRole('textbox', { name: 'Ask the Assistant' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(within(page).queryByRole('button', { name: 'Which region had the worst month?' })).toBeNull();
    expect(calls.some((c) => c.channel === 'copilot:ask')).toBe(false);
  });
});

describe('between the dock and the page', () => {
  it('the dock’s expand button opens its conversation full width, and the dock steps aside; the top bar’s toggle takes it back', async () => {
    const calls = serve(REGION);
    const router = renderApp('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
    const dock = await screen.findByRole('complementary', { name: 'Assistant' });
    await within(dock).findByRole('button', { name: 'Conversations: Revenue by region' });
    fireEvent.click(within(dock).getByRole('button', { name: 'Open the Assistant full width' }));

    const page = await screen.findByRole('region', { name: 'Assistant' });
    expect(router.state.location.pathname).toBe('/assistant');
    expect(router.state.location.search).toBe(`?thread=${REGION}`);
    expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBeNull();
    await waitFor(() => expect(within(page).getByTestId('assistant-title').textContent).toBe('Revenue by region'));
    expect(historyOf(calls, REGION)).toBe(true);
    expect(await within(page).findByText('North leads.')).toBeTruthy();

    // On the page the top bar's toggle is pressed, and it means "back to the side panel".
    const toggle = screen.getByRole('button', { name: 'Assistant' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const back = await screen.findByRole('complementary', { name: 'Assistant' });
    expect(await within(back).findByRole('button', { name: 'Conversations: Revenue by region' })).toBeTruthy();
  });

  it('"Back to the side panel" opens the dock on the page’s conversation and returns to the screen before', async () => {
    const calls = serve(REGION);
    const router = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: /Good|Welcome|Home/ });
    await act(() => router.navigate(`/assistant?thread=${CHURN}`));
    const page = await screen.findByRole('region', { name: 'Assistant' });
    await waitFor(() => expect(within(page).getByTestId('assistant-title').textContent).toBe('Churn last month'));
    // The browser router's place in history: one entry in (React Router keeps `idx` in history.state).
    window.history.replaceState({ idx: 1 }, '');
    fireEvent.click(within(page).getByRole('button', { name: 'Back to the side panel' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const dock = await screen.findByRole('complementary', { name: 'Assistant' });
    // The page's conversation, not the most recent one (the server's pick without an id).
    await within(dock).findByRole('button', { name: 'Conversations: Churn last month' });
    expect(historyOf(calls, CHURN)).toBe(true);
  });

  it('"Back to the side panel" on a page opened first lands on Home, not outside the app', async () => {
    serve(REGION);
    const router = renderApp(`/assistant?thread=${CHURN}`);
    const page = await screen.findByRole('region', { name: 'Assistant' });
    await waitFor(() => expect(within(page).getByTestId('assistant-title').textContent).toBe('Churn last month'));
    fireEvent.click(within(page).getByRole('button', { name: 'Back to the side panel' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const dock = await screen.findByRole('complementary', { name: 'Assistant' });
    await within(dock).findByRole('button', { name: 'Conversations: Churn last month' });
  });
});
