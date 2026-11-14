// The Data model's Agents section and an agent's page (docs/assistant-agents/00-design.md): the Project assistant always
// first; agents with their teams, topic and what they may do; the empty state's way in for an admin only; the page's
// settings an admin's, its instructions an editor's too, nothing to change for a viewer. Replies are canned.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';
import type { AgentRow } from '../../assistant/agents';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const FIN = 'a1111111-1111-4111-8111-111111111111';
const TOPIC = 'c1111111-1111-4111-8111-111111111111';
const TEAM = 'e1111111-1111-4111-8111-111111111111';
const LAZY = { timeout: 15_000 };
const FINANCE: AgentRow = {
  id: FIN, name: 'Finance assistant', description: 'Invoices, costs and payroll', usable: true,
  topic: { id: TOPIC, name: 'Finance', datasetIds: [] }, model: null, build: false, teams: [{ id: TEAM, name: 'Finance' }],
  instructions: [{ id: 'f1111111-1111-4111-8111-111111111111', text: 'Revenue means recognized revenue', updatedBy: 'ana@acme.test', updatedAt: '2026-11-01T10:00:00Z' }],
  tag: 'tag-1',
};

function serve(role: 'admin' | 'editor' | 'viewer', agents: AgentRow[], routes: Record<string, RpcReply> = {}) {
  const body = (b: unknown) => ({ body: b });
  const mine = (a: AgentRow): AgentRow => (role === 'admin' ? a : { ...a, tag: undefined });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 0, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'catalog:instructions': body({ ok: true, instructions: [] }),
    'verified:list': body({ ok: true, broken: 0, questions: [] }),
    'agent:list': body({ ok: true, agents: agents.map(mine), preselected: null, canManage: role === 'admin', canInstruct: role !== 'viewer' }),
    'model:navigation': body({ ok: true, tables: [], dateLadder: [], topics: [{ id: TOPIC, name: 'Finance', datasets: [], metricIds: [], termIds: [] }] }),
    'project:shareTargets': body({ users: [], teams: [{ id: TEAM, name: 'Finance' }, { id: 'e2222222-2222-4222-8222-222222222222', name: 'Sales' }] }),
    'ai:status': body({ ready: true, models: [{ provider: 'anthropic', model: 'claude-opus', label: 'Claude Opus', isDefault: true }], mine: { provider: 'anthropic', model: 'claude-opus' }, copilotEnabled: true, keyStore: null }),
    ...routes,
  });
}
const agentsSection = async () => {
  await screen.findByRole('heading', { level: 2, name: 'Agents' }, LAZY);
  return screen.getByRole('region', { name: 'Agents' });
};
const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.payload);

describe('The Data model: Agents', () => {
  it('no agents: the Project assistant, default, and the way in for an admin', async () => {
    serve('admin', []);
    renderApp(`/model/${P}?tab=assistant`);
    const s = await agentsSection();
    const rows = await within(s).findAllByTestId('agent-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Project assistant');
    expect(rows[0].textContent).toContain('Everyone');
    expect(rows[0].textContent).toContain('All data');
    expect(rows[0].textContent).toContain('Default');
    const empty = within(s).getByTestId('agents-empty');
    expect(empty.textContent).toContain('No agents yet');
    expect(within(empty).getByRole('button', { name: 'New agent' })).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('a viewer: the same list, no way to make one', async () => {
    serve('viewer', []);
    renderApp(`/model/${P}?tab=assistant`);
    const s = await agentsSection();
    await within(s).findByTestId('agents-empty');
    expect(within(s).queryByRole('button', { name: 'New agent' })).toBeNull();
    expect(within(s).getByTestId('agents-empty').textContent).toContain('A project admin can give a team its own assistant');
  });

  it('with an agent: its teams, its topic, "answers only", and its row opens its page', async () => {
    serve('admin', [FINANCE]);
    const router = renderApp(`/model/${P}?tab=assistant`);
    const s = await agentsSection();
    const row = await within(s).findByRole('button', { name: 'Open Finance assistant' });
    expect(row.textContent).toContain('Invoices, costs and payroll');
    expect(row.textContent).toContain('Finance');
    expect(row.textContent).toContain('Finance topic');
    expect(row.textContent).toContain('Answers only');
    expect(within(s).queryByTestId('agents-empty')).toBeNull();
    expect(within(s).getByRole('button', { name: 'New agent' })).toBeTruthy();
    fireEvent.click(row);
    await screen.findByTestId('agent-page');
    expect(router.state.location.search).toContain(`agent=${FIN}`);
  });

  it('an admin\'s page: the settings, saved with the tag the list gave', async () => {
    const calls = serve('admin', [FINANCE], { 'agent:save': { body: { ok: true, agent: { id: FIN, name: 'Finance assistant' }, tag: 'tag-2' } } });
    renderApp(`/model/${P}?tab=assistant&agent=${FIN}`);
    const page = await screen.findByTestId('agent-page', {}, LAZY);
    expect(within(page).getByRole('heading', { level: 2, name: 'Finance assistant' })).toBeTruthy();
    expect(within(page).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect((within(page).getByRole('combobox', { name: 'Topic' }) as HTMLElement).textContent).toBe('Finance');
    expect((within(page).getByRole('combobox', { name: 'Model' }) as HTMLElement).textContent).toBe('Each person’s own');
    const save = within(page).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing changed yet
    fireEvent.click(within(page).getByRole('checkbox', { name: /Build charts and dashboards/ }));
    fireEvent.click(save);
    await waitFor(() => expect(sent(calls, 'agent:save')).toEqual([{
      projectId: P, id: FIN, base: 'tag-1',
      agent: { name: 'Finance assistant', description: 'Invoices, costs and payroll', topicId: TOPIC, model: null, build: true, teamIds: [TEAM] },
    }]));
  });

  it('an editor\'s page: the settings to read, and an instruction to add', async () => {
    const calls = serve('editor', [FINANCE], { 'agent:instructions': { body: { ok: true, instructions: FINANCE.instructions } } });
    renderApp(`/model/${P}?tab=assistant&agent=${FIN}`);
    const page = await screen.findByTestId('agent-page', {}, LAZY);
    expect(within(page).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(page).queryByRole('combobox', { name: 'Topic' })).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(page).getByText('A project admin sets these. You can change its instructions below.')).toBeTruthy();
    expect(within(page).getByText('Revenue means recognized revenue')).toBeTruthy();
    const region = within(page).getByRole('region', { name: 'Instructions' });
    fireEvent.click(within(region).getByRole('button', { name: 'Instruction' }));
    const box = within(region).getByRole('textbox', { name: 'New instruction' });
    fireEvent.change(box, { target: { value: 'Our year starts in February' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(sent(calls, 'agent:instructions')).toEqual([{ projectId: P, id: FIN, op: { kind: 'add', text: 'Our year starts in February' } }]));
  });

  it('a viewer\'s page: nothing to change, its instructions to read', async () => {
    serve('viewer', [FINANCE]);
    renderApp(`/model/${P}?tab=assistant&agent=${FIN}`);
    const page = await screen.findByTestId('agent-page', {}, LAZY);
    expect(within(page).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Instruction' })).toBeNull();
    expect(within(page).queryByRole('textbox')).toBeNull();
    expect((within(page).getByRole('checkbox', { name: /Build charts and dashboards/ }) as HTMLInputElement).disabled).toBe(true);
    expect(within(page).getByText('Revenue means recognized revenue')).toBeTruthy();
    expect(within(page).getByText('A project admin sets these.')).toBeTruthy();
  });

  it('an agent that is gone: says so, with the way back', async () => {
    serve('admin', []);
    renderApp(`/model/${P}?tab=assistant&agent=${FIN}`);
    await screen.findByRole('heading', { name: 'This assistant no longer exists' }, LAZY);
    fireEvent.click(screen.getAllByRole('button', { name: 'All assistants' })[0]);
    await screen.findByRole('heading', { level: 2, name: 'Agents' });
  });
});
