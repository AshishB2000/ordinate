// Assistant agents in the dock (docs/assistant-agents/00-design.md, "The composer", "History"): the picker is there only
// when the person may use an agent; it shows the preselected one before a conversation exists and the conversation's own
// after; switching starts a new conversation; an out-of-scope reply's button asks the Project assistant in a new one.
// Every reply is canned (serve): who may use what is the server's.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { AgentPicker } from './AgentPicker';
import type { AgentRow } from './agents';
import { setDockOpen } from './dockState';

afterEach(() => {
  act(() => setDockOpen(false));
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const FIN = 'a1111111-1111-4111-8111-111111111111';
const SALES = 'a2222222-2222-4222-8222-222222222222';
const T1 = 'b1111111-1111-4111-8111-111111111111';
const T2 = 'b2222222-2222-4222-8222-222222222222';
const ME = { user: { email: 'fay@acme.test', role: 'viewer' }, org: 'acme', mode: 'oidc', canSignOut: true };
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', isDefault: true };
const OPUS = { provider: 'anthropic', model: 'claude-opus', label: 'Claude Opus', isDefault: false };
const agent = (id: string, name: string, extra: Partial<AgentRow> = {}): AgentRow => ({
  id, name, usable: true, topic: { id: 'c1111111-1111-4111-8111-111111111111', name: name.split(' ')[0], datasetIds: ['d1'] }, model: null, build: false, teams: [{ id: 't', name: 'Finance' }], ...extra,
});
const AGENTS = [agent(FIN, 'Finance assistant', { model: { provider: 'anthropic', model: 'claude-opus' } }), agent(SALES, 'Sales assistant')];

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
const base = (agents: AgentRow[], preselected: string | null, history: unknown = { ok: true, turns: [], threadId: null }): Record<string, Reply> => ({
  '/api/auth/me': { body: ME },
  'projects:list': { body: [{ id: PID, name: 'Ledger', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }] },
  'ai:status': { body: { ready: true, models: [SONNET, OPUS], mine: { provider: 'anthropic', model: SONNET.model }, copilotEnabled: true, keyStore: null } },
  'copilot:history': { body: history },
  'dataset:list': { body: [{ id: 'd1', name: 'Invoices' }, { id: 'd2', name: 'Orders' }] },
  'projects:roles': { body: { [PID]: 'viewer' } },
  'agent:list': { body: { ok: true, agents, preselected, canManage: false, canInstruct: false } },
});
async function openDock() {
  fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
  await screen.findByRole('textbox', { name: 'Ask the Assistant' });
  return document.getElementById('dock-panel') as HTMLElement;
}
const picked = (dock: HTMLElement) => within(dock).getByRole('combobox', { name: 'Assistant' }).textContent;

describe('the agent picker', () => {
  it('draws nothing when there is no agent to pick: nothing on screen changes', () => {
    const { container } = render(<AgentPicker agents={[]} value={null} onChange={() => undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('offers the Project assistant first, then each agent with what it answers from; a pick says which', async () => {
    const onChange = vi.fn();
    render(<AgentPicker agents={[...AGENTS, agent('a3333333-3333-4333-8333-333333333333', 'Everything', { topic: null })]} value={FIN} onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Assistant' });
    expect(box.textContent).toBe('Finance assistant');
    fireEvent.click(box);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Project assistantAll data', 'Finance assistantFinance topic', 'Sales assistantSales topic', 'EverythingAll data']);
    fireEvent.click(options[2]);
    expect(onChange).toHaveBeenLastCalledWith(SALES);
    fireEvent.click(box);
    fireEvent.click((await screen.findAllByRole('option'))[0]);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('an agent the list does not hold (gone, not this person\'s) shows as the Project assistant', () => {
    render(<AgentPicker agents={AGENTS} value="a9999999-9999-4999-8999-999999999999" onChange={() => undefined} />);
    expect(screen.getByRole('combobox', { name: 'Assistant' }).textContent).toBe('Project assistant');
  });
});

describe('agents in the dock', () => {
  it('no agent for this person: no picker, the model picker as before', async () => {
    serve(base([], null));
    renderApp('/');
    const dock = await openDock();
    await within(dock).findByText('Powered by Claude Sonnet 4.6');
    expect(within(dock).queryByTestId('agent-picker')).toBeNull();
  });

  it('before any conversation: the preselected agent, its topic as what answers are based on, and its model named', async () => {
    const calls = serve({ ...base(AGENTS, FIN), 'copilot:ask': { body: { ok: true, answer: 'Fine.', turns: [], threadId: T1, agent: { id: FIN, name: 'Finance assistant' } } } });
    renderApp('/');
    const dock = await openDock();
    await waitFor(() => expect(picked(dock)).toBe('Finance assistant'));
    expect(within(dock).getByTestId('dock-context').textContent).toBe('Finance');
    expect(within(dock).getByText('Powered by Claude Opus')).toBeTruthy(); // the agent's own model, which answers everyone in it
    expect(within(dock).getByTitle('Model: Claude Opus, set by Finance assistant')).toBeTruthy();
    const box = within(dock).getByRole('textbox', { name: 'Ask the Assistant' });
    fireEvent.change(box, { target: { value: 'What was payroll cost?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls.find((c) => c.channel === 'copilot:ask')?.payload).toMatchObject({ projectId: PID, question: 'What was payroll cost?', agentId: FIN }));
  });

  it('a conversation shows its own agent; switching starts a new conversation with the one picked', async () => {
    const turns = [{ id: 'u1', role: 'user', text: 'Pipeline?', createdAt: '' }, { id: 'a1', role: 'assistant', text: 'Here.', createdAt: '' }];
    const calls = serve({
      ...base(AGENTS, FIN, { ok: true, turns, threadId: T1, title: 'Pipeline?', agent: { id: SALES, name: 'Sales assistant' } }),
      'copilot:newThread': { body: { ok: true, thread: { id: T2, title: 'Conversation', updatedAt: '', turnCount: 0, agentId: FIN } } },
    });
    renderApp('/');
    const dock = await openDock();
    await waitFor(() => expect(picked(dock)).toBe('Sales assistant')); // the conversation's, not the preselected one
    fireEvent.click(within(dock).getByRole('combobox', { name: 'Assistant' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Finance assistant/ }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'copilot:newThread').map((c) => c.payload)).toEqual([{ projectId: PID, agentId: FIN }]));
    await waitFor(() => expect(picked(dock)).toBe('Finance assistant'));
    expect(calls.some((c) => c.channel === 'copilot:deleteThread')).toBe(false); // the conversation left had turns: it is kept
  });

  it('a conversation whose agent was deleted says so, and its questions go to the Project assistant', async () => {
    const turns = [{ id: 'u1', role: 'user', text: 'Costs?', createdAt: '' }];
    serve(base(AGENTS.slice(1), null, { ok: true, turns, threadId: T1, title: 'Costs?', agent: { id: FIN, name: 'Finance assistant', gone: true } }));
    renderApp('/');
    const dock = await openDock();
    const note = await within(dock).findByTestId('agent-note');
    expect(note.textContent).toBe('“Finance assistant” was deleted. Questions here go to the Project assistant.');
    expect(picked(dock)).toBe('Project assistant');
  });

  it('out of scope: the card names the dataset, and one click asks the Project assistant the same question in a new conversation', async () => {
    const turns = [
      { id: 'u1', role: 'user', text: 'Revenue by region?', createdAt: '' },
      { id: 'a1', role: 'assistant', text: 'This isn’t in the Finance data.\nThe Project assistant can answer it from “orders”.', createdAt: '', outside: { dataset: 'orders' } },
    ];
    const calls = serve({
      ...base(AGENTS, FIN, { ok: true, turns, threadId: T1, title: 'Revenue by region?', agent: { id: FIN, name: 'Finance assistant' } }),
      'copilot:newThread': { body: { ok: true, thread: { id: T2, title: 'Conversation', updatedAt: '', turnCount: 0 } } },
      'copilot:ask': { body: { ok: true, answer: 'West leads.', turns: [], threadId: T2, agent: null } },
    });
    renderApp('/');
    const dock = await openDock();
    const card = await within(dock).findByTestId('agent-outside');
    expect(within(card).getByText('Finance assistant')).toBeTruthy();
    expect(within(card).getByText('This isn’t in the Finance data.')).toBeTruthy();
    expect(within(card).getByText('The Project assistant can answer it from “orders”.')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Ask the Project assistant' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'copilot:ask')?.payload).toMatchObject({ projectId: PID, question: 'Revenue by region?', threadId: T2 }));
    expect(calls.find((c) => c.channel === 'copilot:newThread')?.payload).toEqual({ projectId: PID });
    expect(calls.find((c) => c.channel === 'copilot:ask')?.payload).not.toHaveProperty('agentId');
  });

  it('the first verified chip, before any conversation, starts it with the preselected agent; one outside its topic is not offered', async () => {
    const spec = (datasetId: string, title: string) => ({ datasetId, category: 'vendor', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title });
    const row = (id: string, datasetId: string, question: string) => ({ id, question, phrasings: [], datasetId, datasetName: '', describe: '', filters: [], spec: spec(datasetId, question), verifiedBy: 'a', verifiedAt: new Date().toISOString(), runs: true, tag: 't' });
    const calls = serve({
      ...base(AGENTS, FIN),
      'verified:list': { body: { ok: true, broken: 0, questions: [row('v1', 'd1', 'Amount by vendor'), row('v2', 'd2', 'Revenue by region')] } },
      'copilot:newThread': { body: { ok: true, thread: { id: T1, title: 'Conversation', updatedAt: '', turnCount: 0, agentId: FIN } } },
      'answer:rerun': { body: { ok: true, turns: [], threadId: T1 } },
    });
    renderApp('/');
    const dock = await openDock();
    await waitFor(() => expect(picked(dock)).toBe('Finance assistant'));
    expect(within(dock).queryByRole('button', { name: '✓ Revenue by region' })).toBeNull(); // Orders is outside its topic
    fireEvent.click(await within(dock).findByRole('button', { name: '✓ Amount by vendor' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'answer:rerun')?.payload).toMatchObject({ projectId: PID, threadId: T1 }));
    expect(calls.find((c) => c.channel === 'copilot:newThread')?.payload).toEqual({ projectId: PID, agentId: FIN });
  });

  it('History names each conversation\'s agent once this person has one', async () => {
    const threads = [
      { id: T1, title: 'Payroll', updatedAt: new Date().toISOString(), turnCount: 2, agentId: FIN, agentName: 'Finance assistant' },
      { id: T2, title: 'Anything', updatedAt: new Date().toISOString(), turnCount: 2 },
    ];
    serve({ ...base(AGENTS, FIN), 'copilot:threads': { body: { ok: true, threads } } });
    renderApp('/');
    const dock = await openDock();
    await waitFor(() => expect(picked(dock)).toBe('Finance assistant'));
    fireEvent.click(within(dock).getByRole('button', { name: 'Conversation history' }));
    const history = await screen.findByRole('dialog', { name: 'Conversation history' });
    await within(history).findByRole('button', { name: /^Payroll/ });
    expect(within(history).getAllByTestId('history-agent').map((t) => t.textContent)).toEqual(['Finance assistant', 'Project assistant']);
  });
});
