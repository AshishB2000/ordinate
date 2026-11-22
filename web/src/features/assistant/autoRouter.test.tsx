// Auto in the Assistant (docs/agent-router/00-design.md, phase 3): the picker's Auto, the ask that carries it, the agent
// buttons when the server could not tell two apart, and "Answered by … · Change" under a routed answer. Every reply is canned
// (serve): who is routed, and why, is the server's.

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
const agent = (id: string, name: string): AgentRow => ({ id, name, usable: true, topic: null, model: null, build: false, teams: [] });
const AGENTS = [agent(FIN, 'Finance assistant'), agent(SALES, 'Sales assistant')];

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
const base = (agents: AgentRow[], history: unknown = { ok: true, turns: [], threadId: null }): Record<string, Reply> => ({
  '/api/auth/me': { body: ME },
  'projects:list': { body: [{ id: PID, name: 'Ledger', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }] },
  'ai:status': { body: { ready: true, models: [SONNET], mine: { provider: 'anthropic', model: SONNET.model }, copilotEnabled: true, keyStore: null } },
  'copilot:history': { body: history },
  'dataset:list': { body: [] },
  'projects:roles': { body: { [PID]: 'viewer' } },
  'agent:list': { body: { ok: true, agents, preselected: agents[0]?.id ?? null, canManage: false, canInstruct: false } },
});
async function openDock() {
  fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
  await screen.findByRole('textbox', { name: 'Ask the Assistant' });
  return document.getElementById('dock-panel') as HTMLElement;
}
const picked = (dock: HTMLElement) => within(dock).getByRole('combobox', { name: 'Assistant' }).textContent;
const ask = (dock: HTMLElement, text: string) => {
  const box = within(dock).getByRole('textbox', { name: 'Ask the Assistant' });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
};

describe('the picker\'s Auto', () => {
  it('is the first option for two or more agents, and says so when it is the one shown', async () => {
    const onAuto = vi.fn();
    render(<AgentPicker agents={AGENTS} value={null} auto onAuto={onAuto} onChange={() => undefined} />);
    const box = screen.getByRole('combobox', { name: 'Assistant' });
    expect(box.textContent).toBe('Auto');
    fireEvent.click(box);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['AutoPicks the agent from your question', 'Project assistantAll data', 'Finance assistantAll data', 'Sales assistantAll data']);
    fireEvent.click(options[2]);
    expect(onAuto).not.toHaveBeenCalled();
  });

  it('picking Auto from an agent says so', async () => {
    const onAuto = vi.fn();
    render(<AgentPicker agents={AGENTS} value={SALES} onAuto={onAuto} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Assistant' }));
    fireEvent.click((await screen.findAllByRole('option'))[0]);
    expect(onAuto).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE CONTROL: with one agent there is no Auto', async () => {
    render(<AgentPicker agents={AGENTS.slice(0, 1)} value={FIN} auto onAuto={() => undefined} onChange={() => undefined} />);
    const box = screen.getByRole('combobox', { name: 'Assistant' });
    expect(box.textContent).toBe('Finance assistant');
    fireEvent.click(box);
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).not.toContain('AutoPicks the agent from your question');
  });
});

describe('Auto in the dock', () => {
  it('is the default with two agents: the ask carries auto and names no agent', async () => {
    const calls = serve({ ...base(AGENTS), 'copilot:ask': { body: { ok: true, answer: 'Fine.', turns: [], threadId: T1, agent: { id: FIN, name: 'Finance assistant' } } } });
    renderApp('/');
    const dock = await openDock();
    await waitFor(() => expect(picked(dock)).toBe('Auto'));
    ask(dock, 'What was payroll cost?');
    await waitFor(() => expect(calls.find((c) => c.channel === 'copilot:ask')).toBeTruthy());
    const sent = calls.find((c) => c.channel === 'copilot:ask')?.payload as Record<string, unknown>;
    expect(sent).toMatchObject({ projectId: PID, question: 'What was payroll cost?', auto: true });
    expect(sent).not.toHaveProperty('agentId');
  });

  it('picking an agent turns Auto off for the conversation: the ask names it and carries no auto', async () => {
    const calls = serve({ ...base(AGENTS), 'copilot:ask': { body: { ok: true, answer: 'Fine.', turns: [], threadId: T1, agent: { id: SALES, name: 'Sales assistant' } } } });
    renderApp('/');
    const dock = await openDock();
    await waitFor(() => expect(picked(dock)).toBe('Auto'));
    fireEvent.click(within(dock).getByRole('combobox', { name: 'Assistant' }));
    fireEvent.click(await screen.findByRole('option', { name: /^Sales assistant/ }));
    await waitFor(() => expect(picked(dock)).toBe('Sales assistant'));
    ask(dock, 'Pipeline?');
    await waitFor(() => expect(calls.find((c) => c.channel === 'copilot:ask')).toBeTruthy());
    const sent = calls.find((c) => c.channel === 'copilot:ask')?.payload as Record<string, unknown>;
    expect(sent).toMatchObject({ agentId: SALES });
    expect(sent).not.toHaveProperty('auto');
  });

  it('a close call shows the agents as buttons, asks nothing, and a click asks the same question with that agent', async () => {
    const calls = serve({
      ...base(AGENTS),
      'copilot:ask': (p) => ((p as { auto?: boolean }).auto
        ? { body: { ok: true, choose: [{ id: FIN, name: 'Finance assistant', description: 'Money' }, { id: SALES, name: 'Sales assistant' }] } }
        : { body: { ok: true, answer: 'West leads.', turns: [], threadId: T1, agent: { id: SALES, name: 'Sales assistant' } } }),
      'copilot:newThread': { body: { ok: true, thread: { id: T1, title: 'Conversation', updatedAt: '', turnCount: 0, agentId: SALES } } },
    });
    renderApp('/');
    const dock = await openDock();
    await waitFor(() => expect(picked(dock)).toBe('Auto'));
    ask(dock, 'Revenue per employee?');
    const group = await within(dock).findByTestId('agent-choices');
    expect(group.textContent).toContain('Revenue per employee?');
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Finance assistant', 'Sales assistant', 'Cancel']);
    expect(within(dock).queryByTestId('dock-pending')).toBeNull(); // nothing is being answered
    fireEvent.click(within(group).getByRole('button', { name: 'Sales assistant' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'copilot:ask')).toHaveLength(2));
    const second = calls.filter((c) => c.channel === 'copilot:ask')[1].payload as Record<string, unknown>;
    expect(second).toMatchObject({ question: 'Revenue per employee?', threadId: T1 });
    expect(calls.find((c) => c.channel === 'copilot:newThread')?.payload).toEqual({ projectId: PID, agentId: SALES });
    expect(second).not.toHaveProperty('auto');
    await waitFor(() => expect(within(dock).queryByTestId('agent-choices')).toBeNull());
  });

  it('Cancel on the buttons drops them and keeps nothing asked', async () => {
    const calls = serve({ ...base(AGENTS), 'copilot:ask': { body: { ok: true, choose: [{ id: FIN, name: 'Finance assistant' }, { id: SALES, name: 'Sales assistant' }] } } });
    renderApp('/');
    const dock = await openDock();
    await waitFor(() => expect(picked(dock)).toBe('Auto'));
    ask(dock, 'Revenue per employee?');
    fireEvent.click(within(await within(dock).findByTestId('agent-choices')).getByRole('button', { name: 'Cancel' }));
    expect(within(dock).queryByTestId('agent-choices')).toBeNull();
    expect(calls.filter((c) => c.channel === 'copilot:ask')).toHaveLength(1);
  });

  it('a routed answer says who answered and why; Change asks the same question with another agent in a new conversation', async () => {
    const turns = [
      { id: 'u1', role: 'user', text: 'Payroll cost?', createdAt: '' },
      { id: 'a1', role: 'assistant', text: 'Here.', createdAt: '', route: { why: 'Matched the Payroll dataset and the payroll cost metric.' } },
    ];
    const calls = serve({
      ...base(AGENTS, { ok: true, turns, threadId: T1, title: 'Payroll cost?', agent: { id: FIN, name: 'Finance assistant' } }),
      'copilot:newThread': { body: { ok: true, thread: { id: T2, title: 'Conversation', updatedAt: '', turnCount: 0, agentId: SALES } } },
      'copilot:ask': { body: { ok: true, answer: 'Fine.', turns: [], threadId: T2, agent: { id: SALES, name: 'Sales assistant' } } },
    });
    renderApp('/');
    const dock = await openDock();
    const line = await within(dock).findByTestId('routed-line');
    expect(line.textContent).toContain('Answered by Finance assistant');
    expect(line.textContent).toContain('Matched the Payroll dataset and the payroll cost metric.');
    fireEvent.click(within(line).getByRole('button', { name: 'Change' }));
    const others = within(line).getAllByRole('button').filter((b) => b.textContent !== 'Change');
    expect(others.map((b) => b.textContent)).toEqual(['Sales assistant']); // never the agent that answered
    fireEvent.click(others[0]);
    await waitFor(() => expect(calls.find((c) => c.channel === 'copilot:ask')?.payload).toMatchObject({ question: 'Payroll cost?', threadId: T2 }));
    expect(calls.find((c) => c.channel === 'copilot:newThread')?.payload).toEqual({ projectId: PID, agentId: SALES });
    expect(calls.find((c) => c.channel === 'copilot:ask')?.payload).not.toHaveProperty('auto');
  });

  it('NEGATIVE CONTROL: an answer Auto did not route has no "Answered by" line', async () => {
    const turns = [{ id: 'u1', role: 'user', text: 'Payroll cost?', createdAt: '' }, { id: 'a1', role: 'assistant', text: 'Here.', createdAt: '' }];
    serve(base(AGENTS, { ok: true, turns, threadId: T1, title: 'Payroll cost?', agent: { id: FIN, name: 'Finance assistant' } }));
    renderApp('/');
    const dock = await openDock();
    await waitFor(() => expect(picked(dock)).toBe('Finance assistant'));
    expect(within(dock).queryByTestId('routed-line')).toBeNull();
  });
});
