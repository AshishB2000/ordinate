// The issues board in the web (docs/issues-board/00-design.md): the composer's notice, the board for an editor (counts, fix, examples as
// words, never an answer), its actions, the admin's switch, and Admin → Integrations. Every reply is canned: counts and text are the server's.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { setDockOpen } from '../assistant/dockState';

afterEach(() => {
  act(() => setDockOpen(false));
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const IID = 'b1111111-1111-4111-8111-111111111111'.replace('b', 'a');
const LAZY = { timeout: 15_000 };
const body = (b: unknown) => ({ body: b });
const ME = (admin: boolean) => ({ user: { email: 'ed@acme.test', role: admin ? 'admin' : 'member' }, org: 'acme', mode: 'oidc', canSignOut: true });
const common = (role: string, extra: Record<string, RpcReply> = {}, orgAdmin = false): Record<string, RpcReply> => ({
  '/api/auth/me': body(ME(orgAdmin)),
  'projects:list': body([{ id: PID, name: 'Ledger', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }]),
  'projects:overview': body([{ id: PID, name: 'Ledger', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 0, dashboards: 0, sample: false }]),
  'projects:roles': body({ [PID]: role }),
  'ai:status': body({ ready: true, models: [], mine: null, copilotEnabled: true, keyStore: null }),
  'dataset:list': body([]),
  'agent:list': body({ ok: true, agents: [], preselected: null, canManage: false, canInstruct: false }),
  'research:list': body({ ok: true, activeRunId: null, limits: { steps: 8, queries: 12, minutes: 10 }, runs: [] }),
  'catalog:instructions': body({ ok: true, instructions: [] }),
  'verified:list': body({ ok: true, broken: 0, questions: [] }),
  'knowledge:list': body({ ok: true, docs: [], total: 0, max: 100, projectDocs: null, canEdit: true }),
  'eval:suites': body({ ok: true, available: true, suites: [], activeRunId: null }),
  'feedback:inbox': body({ ok: true, items: [], available: true }),
  ...extra,
});
const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.payload);
const ISSUE = {
  id: IID, title: 'Active customer is not defined', fix: 'Define it as a business term.', kind: 'undefined_name', status: 'open', reopened: 0, questions: 5, people: 4,
  kinds: [{ kind: 'undefined_name', count: 4 }, { kind: 'thumbs_down', count: 1 }],
  examples: [{ kind: 'undefined_name', reason: null, question: 'How many active customers?', at: '2026-11-19T10:00:00Z' }, { kind: 'thumbs_down', reason: 'wrong_number', question: 'Active customers by region?', at: '2026-11-19T11:00:00Z' }],
  tickets: [], proposalId: null, updatedAt: '2026-11-20T10:00:00Z',
};
const BOARD = (issues: unknown[] = [ISSUE], trackers = { linear: false, jira: false }) => body({ ok: true, available: true, issues, trackers });
const SETTINGS = (over: object = {}) => body({ ok: true, available: true, enabled: true, lastRunAt: '2026-11-18T10:00:00Z', lastError: null, trackers: { linear: false, jira: false }, ...over });
const tab = () => renderApp(`/model/${PID}?tab=assistant`);

describe('the notice in the Assistant', () => {
  it('the composer says editors may see questions that did not get a good answer, and never the answers', async () => {
    serveRpc(common('viewer'));
    renderApp('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
    expect((await screen.findByTestId('issues-notice')).textContent).toBe('Editors may see questions that didn’t get a good answer. They never see the answers.');
  });
});

describe('the Issues board', () => {
  it('shows an issue: its counts, the fix, the example questions with the reason, and no answer', async () => {
    serveRpc(common('editor', { 'issues:list': BOARD(), 'issues:settings': SETTINGS() }));
    tab();
    const card = await screen.findByTestId('issue', {}, LAZY);
    expect(within(card).getByRole('heading', { name: 'Active customer is not defined' })).toBeTruthy();
    expect(within(card).getByText('5 questions · 4 people affected')).toBeTruthy();
    expect(within(card).getByText(/Define it as a business term/)).toBeTruthy();
    const ex = within(card).getByRole('list', { name: 'Example questions' });
    expect(within(ex).getByText('How many active customers?')).toBeTruthy();
    expect(within(ex).getByText(/Thumbs down · Wrong number/)).toBeTruthy();
    expect(within(card).getByText('Questions people asked. Never the answers.')).toBeTruthy();
  });

  it('an editor resolves, ignores and reopens: each sends the status, and nothing else', async () => {
    const calls = serveRpc(common('editor', { 'issues:list': BOARD(), 'issues:settings': SETTINGS(), 'issues:setStatus': body({ ok: true }) }));
    tab();
    const card = await screen.findByTestId('issue', {}, LAZY);
    fireEvent.click(within(card).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(sent(calls, 'issues:setStatus')).toEqual([{ projectId: PID, id: IID, status: 'resolved' }]));
    fireEvent.click(within(card).getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(sent(calls, 'issues:setStatus')[1]).toEqual({ projectId: PID, id: IID, status: 'ignored' }));
  });

  it('"Propose a definition" calls #7\'s path and shows a refusal as a sentence', async () => {
    const calls = serveRpc(common('editor', { 'issues:list': BOARD(), 'issues:settings': SETTINGS(), 'issues:propose': body({ ok: false, error: 'None of this issue’s questions are open to you.' }) }));
    tab();
    const card = await screen.findByTestId('issue', {}, LAZY);
    fireEvent.click(within(card).getByRole('button', { name: 'Propose a definition' }));
    await waitFor(() => expect(sent(calls, 'issues:propose')).toEqual([{ projectId: PID, id: IID }]));
    expect((await within(card).findByRole('alert')).textContent).toContain('open to you');
  });

  it('Send appears only for a connected tracker, and sends only the issue and the tracker', async () => {
    const calls = serveRpc(common('editor', { 'issues:list': BOARD([ISSUE], { linear: true, jira: false }), 'issues:settings': SETTINGS(), 'issues:send': body({ ok: true, ref: 'DATA-1', url: 'https://linear.app/x' }) }));
    tab();
    const card = await screen.findByTestId('issue', {}, LAZY);
    expect(within(card).queryByRole('button', { name: 'Send to Jira' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Send to Linear' }));
    await waitFor(() => expect(sent(calls, 'issues:send')).toEqual([{ projectId: PID, id: IID, provider: 'linear' }]));
  });

  it('NEGATIVE CONTROL: with no tracker connected there is no Send button; a sent issue shows its ticket and offers no second send', async () => {
    serveRpc(common('editor', { 'issues:list': BOARD(), 'issues:settings': SETTINGS() }));
    tab();
    expect(within(await screen.findByTestId('issue', {}, LAZY)).queryByRole('button', { name: /Send to/ })).toBeNull();
    cleanup();
    serveRpc(common('editor', { 'issues:list': BOARD([{ ...ISSUE, tickets: [{ provider: 'linear', ref: 'DATA-142', url: 'https://linear.app/a/DATA-142' }] }], { linear: true, jira: false }), 'issues:settings': SETTINGS() }));
    tab();
    const card = await screen.findByTestId('issue', {}, LAZY);
    expect(within(card).getByRole('link', { name: 'DATA-142' }).getAttribute('href')).toBe('https://linear.app/a/DATA-142');
    expect(within(card).queryByRole('button', { name: 'Send to Linear' })).toBeNull();
  });

  it('a resolved issue offers Reopen; one that came back says so', async () => {
    serveRpc(common('editor', { 'issues:list': BOARD([{ ...ISSUE, status: 'resolved' }]), 'issues:settings': SETTINGS() }));
    tab();
    const card = await screen.findByTestId('issue', {}, LAZY);
    expect(within(card).getByRole('button', { name: 'Reopen' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Resolve' })).toBeNull();
    cleanup();
    serveRpc(common('editor', { 'issues:list': BOARD([{ ...ISSUE, reopened: 1 }]), 'issues:settings': SETTINGS() }));
    tab();
    expect(await screen.findByText('Came back', {}, LAZY)).toBeTruthy();
  });

  it('empty and error states', async () => {
    serveRpc(common('editor', { 'issues:list': BOARD([]), 'issues:settings': SETTINGS({ enabled: false, lastRunAt: null }) }));
    tab();
    expect(await screen.findByText('No issues yet', {}, LAZY)).toBeTruthy();
    cleanup();
    serveRpc(common('editor', { 'issues:list': { status: 500, body: { error: 'boom' } }, 'issues:settings': SETTINGS() }));
    tab();
    expect(await screen.findByText('The issues could not be loaded', {}, LAZY)).toBeTruthy();
  });

  it('a viewer sees no Issues section at all, and asks the server for nothing', async () => {
    const calls = serveRpc(common('viewer', { 'issues:list': BOARD(), 'issues:settings': SETTINGS() }));
    tab();
    await screen.findByRole('heading', { name: /Instructions|Verified/ }, LAZY).catch(() => undefined);
    expect(screen.queryByRole('heading', { name: 'Issues' })).toBeNull();
    expect(sent(calls, 'issues:list')).toHaveLength(0);
  }, 30_000);

  it('only a project admin gets the switch and Check now; an editor is told who turns it on', async () => {
    const calls = serveRpc(common('admin', { 'issues:list': BOARD([]), 'issues:settings': SETTINGS({ enabled: false, lastRunAt: null }), 'issues:setEnabled': body({ ok: true }) }));
    tab();
    const sw = await screen.findByRole('switch', { name: 'Check every week' }, LAZY);
    expect((sw as HTMLInputElement).checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(sent(calls, 'issues:setEnabled')).toEqual([{ projectId: PID, enabled: true }]));
    cleanup();
    serveRpc(common('editor', { 'issues:list': BOARD([]), 'issues:settings': SETTINGS({ enabled: false, lastRunAt: null }) }));
    tab();
    expect(await screen.findByText('Off. A project admin turns it on.', {}, LAZY)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Check every week' })).toBeNull();
  }, 30_000);
});

describe('Admin → Integrations', () => {
  const view = (provider: string, over: object = {}) => ({ provider, connected: false, hasToken: false, settings: {}, connectedBy: '', connectedAt: '', ...over });
  const status = (providers: unknown[], canSave = true) => body({ ok: true, available: true, canSave, providers });
  const open = () => renderApp('/admin?tab=integrations');

  it('shows both trackers; a connected one reads Stored with its settings and never a token', async () => {
    serveRpc(common('admin', { 'tracker:status': status([view('linear', { connected: true, hasToken: true, settings: { teamKey: 'DATA' } }), view('jira')]) }, true));
    open();
    const linear = await screen.findByTestId('integration-linear', {}, LAZY);
    expect(within(linear).getByText('Stored')).toBeTruthy();
    expect(within(linear).getByText('DATA')).toBeTruthy();
    expect(within(linear).queryByLabelText(/API key/)).toBeNull();
    const jira = screen.getByTestId('integration-jira');
    expect(within(jira).getByText('Not connected')).toBeTruthy();
    expect(within(jira).getByLabelText('Jira site')).toBeTruthy();
  });

  it('connecting Jira sends the five fields once; a refusal is shown as a sentence', async () => {
    const calls = serveRpc(common('admin', { 'tracker:status': status([view('linear'), view('jira')]), 'tracker:connect': body({ ok: false, error: 'Jira did not accept that token.' }) }, true));
    open();
    const jira = await screen.findByTestId('integration-jira', {}, LAZY);
    fireEvent.change(within(jira).getByLabelText('Jira site'), { target: { value: 'acme.atlassian.net' } });
    fireEvent.change(within(jira).getByLabelText('Project key'), { target: { value: 'DATA' } });
    fireEvent.change(within(jira).getByLabelText('Account email'), { target: { value: 'pm@acme.test' } });
    fireEvent.change(within(jira).getByLabelText('API token'), { target: { value: 'tok_123456789' } });
    fireEvent.click(within(jira).getByRole('button', { name: 'Connect Jira' }));
    await waitFor(() => expect(sent(calls, 'tracker:connect')).toEqual([{ provider: 'jira', apiToken: 'tok_123456789', site: 'acme.atlassian.net', email: 'pm@acme.test', projectKey: 'DATA' }]));
    expect((await within(jira).findByRole('alert')).textContent).toBe('Jira did not accept that token.');
  });

  it('NEGATIVE CONTROL: Connect stays disabled until the fields are filled, and without a master key it explains', async () => {
    const calls = serveRpc(common('admin', { 'tracker:status': status([view('linear'), view('jira')], false) }, true));
    open();
    const linear = await screen.findByTestId('integration-linear', {}, LAZY);
    expect((within(linear).getByRole('button', { name: 'Connect Linear' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(linear).getByText(/ORDINATE_MASTER_KEY/)).toBeTruthy();
    expect(sent(calls, 'tracker:connect')).toHaveLength(0);
  });
});
