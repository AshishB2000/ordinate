// Evaluation suites in the web (docs/eval-suites/00-design.md): the thumbs and what a thumbs-down says before it sends, Add to tests, the
// Tests section and its prompts, the thumbs-down inbox, the results page for the person who ran it and for another editor, and the Judge
// model card. Every reply is canned: the outcomes, counts and checks are the server's.

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
const RID = 'c1111111-1111-4111-8111-111111111111';
const SID = 's1111111-1111-4111-8111-111111111111'.replace('s', 'a');
const AID = 'a2222222-2222-4222-8222-222222222222';
const LAZY = { timeout: 15_000 };
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', isDefault: true };
const body = (b: unknown) => ({ body: b });
const ME = (role: string) => ({ user: { email: 'ed@acme.test', role }, org: 'acme', mode: 'oidc', canSignOut: true });
const common = (role = 'editor', extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  '/api/auth/me': body(ME(role === 'admin' ? 'admin' : 'member')),
  'projects:list': body([{ id: PID, name: 'Ledger', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }]),
  'projects:overview': body([{ id: PID, name: 'Ledger', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 0, dashboards: 0, sample: false }]),
  'projects:roles': body({ [PID]: role === 'admin' ? 'admin' : role }),
  'ai:status': body({ ready: true, models: [SONNET], mine: { provider: 'anthropic', model: SONNET.model }, copilotEnabled: true, keyStore: null }),
  'dataset:list': body([]),
  'agent:list': body({ ok: true, agents: [], preselected: null, canManage: false, canInstruct: false }),
  'research:list': body({ ok: true, activeRunId: null, limits: { steps: 8, queries: 12, minutes: 10 }, runs: [] }),
  'catalog:instructions': body({ ok: true, instructions: [] }),
  'verified:list': body({ ok: true, broken: 0, questions: [] }),
  'knowledge:list': body({ ok: true, docs: [], total: 0, max: 100, projectDocs: null, canEdit: true }),
  ...extra,
});
const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.payload);

// ── the thumbs, in the dock ────────────────────────────────────────────────────────────────────────────────────────────────
const TURNS = (feedback?: object) => ({ ok: true, threadId: 't1', turns: [
  { id: 'u1', role: 'user', text: 'Why are East sales low?', createdAt: '2026-11-20T10:00:00Z' },
  { id: 'a1', role: 'assistant', text: 'East sold less.', createdAt: '2026-11-20T10:00:01Z', ...(feedback ? { feedback } : {}) },
] });
async function openDock() {
  fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
  await screen.findByRole('textbox', { name: 'Ask the Assistant' });
  return document.getElementById('dock-panel') as HTMLElement;
}

describe('the thumbs under an answer', () => {
  it('a thumbs-down says "Editors will see this question" BEFORE anything is sent, and sends only on Send', async () => {
    const calls = serveRpc(common('viewer', { 'copilot:history': body(TURNS()), 'feedback:rate': body({ ok: true, feedback: { value: 'down', reason: 'wrong_number' } }) }));
    renderApp('/');
    const dock = await openDock();
    fireEvent.click(await within(dock).findByRole('button', { name: 'Bad answer' }));
    const panel = await within(dock).findByRole('group', { name: 'Why was it a bad answer?' });
    expect(within(panel).getByText('Editors will see this question. They never see the answer.')).toBeTruthy();
    expect(sent(calls, 'feedback:rate')).toHaveLength(0);
    fireEvent.click(within(panel).getByRole('button', { name: 'Wrong number' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent(calls, 'feedback:rate')).toEqual([{ projectId: PID, threadId: 't1', turnId: 'a1', value: 'down', reason: 'wrong_number' }]));
    expect(await within(dock).findByText('Thanks. The question went to the editors.')).toBeTruthy();
    expect(within(dock).getByRole('button', { name: 'Bad answer' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('NEGATIVE CONTROL: Cancel sends nothing, and the question is never in the payload', async () => {
    const calls = serveRpc(common('viewer', { 'copilot:history': body(TURNS()) }));
    renderApp('/');
    const dock = await openDock();
    fireEvent.click(await within(dock).findByRole('button', { name: 'Bad answer' }));
    fireEvent.click(await within(dock).findByRole('button', { name: 'Cancel' }));
    expect(sent(calls, 'feedback:rate')).toHaveLength(0);
    expect(within(dock).queryByRole('group', { name: 'Why was it a bad answer?' })).toBeNull();
  });

  it('a thumbs-up sends at once, and pressing it again takes it back', async () => {
    const calls = serveRpc(common('viewer', { 'copilot:history': body(TURNS()), 'feedback:rate': (p) => body({ ok: true, feedback: (p as { value: string }).value === 'none' ? null : { value: 'up' } }) }));
    renderApp('/');
    const dock = await openDock();
    const up = await within(dock).findByRole('button', { name: 'Good answer' });
    fireEvent.click(up);
    await waitFor(() => expect(up.getAttribute('aria-pressed')).toBe('true'));
    fireEvent.click(up);
    await waitFor(() => expect(up.getAttribute('aria-pressed')).toBe('false'));
    expect(sent(calls, 'feedback:rate').map((p) => (p as { value: string }).value)).toEqual(['up', 'none']);
  });

  it('a thumb given before shows pressed after a reload', async () => {
    serveRpc(common('viewer', { 'copilot:history': body(TURNS({ value: 'down', reason: 'other' })) }));
    renderApp('/');
    const dock = await openDock();
    expect((await within(dock).findByRole('button', { name: 'Bad answer' })).getAttribute('aria-pressed')).toBe('true');
  });

  it('a refused rating says why', async () => {
    serveRpc(common('viewer', { 'copilot:history': body(TURNS()), 'feedback:rate': body({ ok: false, error: 'That answer could not be rated.' }) }));
    renderApp('/');
    const dock2 = await openDock();
    fireEvent.click(await within(dock2).findByRole('button', { name: 'Good answer' }));
    expect(await within(dock2).findByRole('alert')).toBeTruthy();
  });
});

// ── Add to tests, on an answer ─────────────────────────────────────────────────────────────────────────────────────────────
const CHART_TURNS = { ok: true, threadId: 't1', turns: [
  { id: 'u1', role: 'user', text: 'Sales by region?', createdAt: '2026-11-20T10:00:00Z' },
  { id: 'a1', role: 'assistant', text: 'West leads.', createdAt: '2026-11-20T10:00:01Z', answer: { datasetId: PID, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Sales by region' } },
] };
const SUITES = (over: object = {}) => ({ ok: true, available: true, activeRunId: null, suites: [{ id: SID, name: 'Revenue', agentId: null, caseCount: 3, createdAt: '2026-11-01T00:00:00Z', liveQueries: 0, last: null, stale: [], runningId: null, ...over }] });

describe('Add to tests', () => {
  it('an editor adds an answer to a suite with words for the judge; the browser sends ids and words, never a spec', async () => {
    const calls = serveRpc(common('editor', { 'copilot:history': body(CHART_TURNS), 'eval:suites': body(SUITES()), 'eval:caseFrom': body({ ok: true, suiteId: SID, caseId: 'x' }) }));
    renderApp('/');
    const dock = await openDock();
    fireEvent.click(await within(dock).findByRole('button', { name: 'Add to tests' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to tests' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'What it should say (optional)' }), { target: { value: 'says West leads' } });
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(sent(calls, 'eval:caseFrom')).toEqual([{ projectId: PID, suiteId: SID, from: { kind: 'turn', threadId: 't1', turnId: 'a1', say: 'says West leads' } }]));
  });

  it('a viewer has no Add to tests', async () => {
    serveRpc(common('viewer', { 'copilot:history': body(CHART_TURNS) }));
    renderApp('/');
    const dock = await openDock();
    await within(dock).findByRole('button', { name: 'Good answer' });
    expect(within(dock).queryByRole('button', { name: 'Add to tests' })).toBeNull();
  });
});

// ── the Tests section and the inbox ────────────────────────────────────────────────────────────────────────────────────────
const tab = () => renderApp(`/assistant/setup/${PID}`);
const tests = async () => (await screen.findByRole('heading', { level: 2, name: 'Tests' }, LAZY)).closest('section') as HTMLElement;

describe('Model → Assistant → Tests', () => {
  it('lists the suites with the last run, and Run tests starts one', async () => {
    const calls = serveRpc(common('editor', {
      'eval:suites': body(SUITES({ last: { runId: RID, state: 'done', startedAt: '2026-11-20T10:00:00Z', casesDone: 3, casesTotal: 3, passed: 2, failed: 1, notScored: 0 } })),
      'eval:runStart': body({ ok: true, runId: RID }),
    }));
    tab();
    const s = await tests();
    const row = await within(s).findByTestId('suite-row');
    expect(within(row).getByText('Revenue')).toBeTruthy();
    expect(row.textContent).toContain('3 test cases');
    expect(within(row).getByRole('link', { name: /2 passed, 1 failed/ }).getAttribute('href')).toBe(`/evals/${PID}/${RID}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Run tests' }));
    await waitFor(() => expect(sent(calls, 'eval:runStart')).toEqual([{ projectId: PID, suiteId: SID }]));
  });

  it('after the instructions changed it says so and makes Run tests the main action; with nothing changed it does not', async () => {
    serveRpc(common('editor', { 'eval:suites': body(SUITES({ last: { runId: RID, state: 'done', startedAt: '2026-11-20T10:00:00Z', casesDone: 3, casesTotal: 3, passed: 3, failed: 0, notScored: 0 }, stale: ['instructions', 'model'] })) }));
    tab();
    const row = await within(await tests()).findByTestId('suite-row');
    expect(within(row).getByRole('status').textContent).toContain('Instructions changed and Model changed since the last run');
    cleanup();
    serveRpc(common('editor', { 'eval:suites': body(SUITES({ last: { runId: RID, state: 'done', startedAt: '2026-11-20T10:00:00Z', casesDone: 3, casesTotal: 3, passed: 3, failed: 0, notScored: 0 } })) }));
    tab();
    const calm = await within(await tests()).findByTestId('suite-row');
    expect(within(calm).queryByRole('status')).toBeNull();
  });

  it('warns how many warehouse queries a run can make on Live data, before it starts', async () => {
    serveRpc(common('editor', { 'eval:suites': body(SUITES({ liveQueries: 9 })) }));
    tab();
    const row = await within(await tests()).findByTestId('suite-row');
    expect(row.textContent).toContain('up to 9 warehouse queries on Live data');
  });

  it('a running suite shows its run card with Stop, and Run tests is disabled', async () => {
    const calls = serveRpc(common('editor', {
      'eval:suites': body(SUITES({ runningId: RID })),
      'eval:runGet': body({ ok: true, suite: { id: SID, name: 'Revenue' }, run: { id: RID, projectId: PID, suiteId: SID, agentId: null, state: 'running', errorCode: null, mine: true, resumable: false, casesTotal: 3, casesDone: 1, passed: 1, failed: 0, notScored: 0, modelCalls: 1, judge: null, judgeOwn: true, version: {}, startedAt: '2026-11-20T10:00:00Z', finishedAt: null, elapsedSec: 12 }, cases: [], compare: null }),
      'eval:runStop': body({ ok: true }),
    }));
    tab();
    const row = await within(await tests()).findByTestId('suite-row');
    const card = await within(row).findByTestId('run-card');
    expect(card.textContent).toContain('1 of 3');
    expect((within(row).getByRole('button', { name: 'Run tests' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByRole('button', { name: 'Stop run' }));
    await waitFor(() => expect(sent(calls, 'eval:runStop')).toEqual([{ projectId: PID, runId: RID }]));
  });

  it('is an empty state that says what a suite is, and one for a server without a database', async () => {
    serveRpc(common('editor', { 'eval:suites': body({ ok: true, available: true, activeRunId: null, suites: [] }) }));
    tab();
    expect(await within(await tests()).findByRole('heading', { name: 'No tests yet' })).toBeTruthy();
    cleanup();
    serveRpc(common('editor', { 'eval:suites': body({ ok: true, available: false, suites: [], activeRunId: null }) }));
    tab();
    expect(await within(await tests()).findByRole('heading', { name: 'Tests need a database' })).toBeTruthy();
  });

  it('a viewer sees no Tests and no inbox', async () => {
    serveRpc(common('viewer'));
    tab();
    await screen.findByRole('heading', { level: 2, name: 'Instructions' }, LAZY);
    expect(screen.queryByRole('heading', { level: 2, name: 'Tests' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'Thumbs-down questions' })).toBeNull();
  });

  it('a case list shows what each should compute, say or refuse, and adds a typed case', async () => {
    const calls = serveRpc(common('editor', {
      'eval:suites': body(SUITES()),
      'eval:cases': body({ ok: true, suite: { id: SID, name: 'Revenue', agentId: null }, max: 100, cases: [
        { id: 'c1', position: 1, question: 'Sales by region?', source: 'verified', say: null, refuse: false, compute: { spec: { datasetId: PID, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [] }, datasetName: 'Orders' } },
        { id: 'c2', position: 2, question: 'Delete everything', source: 'typed', say: null, refuse: true, compute: null },
        { id: 'c3', position: 3, question: 'Why is revenue net?', source: 'inbox', say: 'says it is net of refunds', refuse: false, compute: null },
      ] }),
      'eval:caseSave': body({ ok: true, id: 'c4' }),
    }));
    tab();
    fireEvent.click(await within(await tests()).findByRole('button', { name: 'Open Revenue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revenue' });
    const rows = await within(dialog).findAllByTestId('case-row');
    expect(rows[0].textContent).toContain('Should compute Orders · sum of sales by region');
    expect(rows[1].textContent).toContain('Should be refused');
    expect(rows[2].textContent).toContain('Should say says it is net of refunds');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Question' }), { target: { value: 'Is margin up?' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /It should be refused/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add test case' }));
    await waitFor(() => expect(sent(calls, 'eval:caseSave')).toEqual([{ projectId: PID, suiteId: SID, question: 'Is margin up?', refuse: true }]));
  });

  it('the inbox holds the question, the assistant and the reason (never an answer) and adds one to a suite', async () => {
    const calls = serveRpc(common('editor', {
      'eval:suites': body(SUITES()),
      'feedback:inbox': body({ ok: true, items: [{ turnId: 'T1', question: 'Why did refunds jump?', agentId: null, agentName: null, reason: 'wrong_number', createdAt: '2026-11-19T10:00:00Z' }] }),
      'eval:caseFrom': body({ ok: true, suiteId: SID, caseId: 'x' }),
    }));
    tab();
    const row = await screen.findByTestId('inbox-row', {}, LAZY);
    expect(row.textContent).toContain('Why did refunds jump?');
    expect(row.textContent).toContain('Wrong number');
    fireEvent.click(within(row).getByRole('button', { name: 'Add to tests' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to tests' });
    expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true); // words or a refusal are needed
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'What a good answer says' }), { target: { value: 'explains the refund spike' } });
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(sent(calls, 'eval:caseFrom')).toEqual([{ projectId: PID, suiteId: SID, from: { kind: 'inbox', turnId: 'T1', say: 'explains the refund spike' } }]));
  });

  it('on an agent\'s page the section is that agent\'s and its suites only', async () => {
    serveRpc(common('editor', {
      'agent:list': body({ ok: true, canManage: true, canInstruct: true, preselected: null, agents: [{ id: AID, name: 'Finance', description: '', topic: null, instructions: [], model: null, build: false, teams: [], usable: true, tag: 't', order: 0 }] }),
      'eval:suites': body({ ok: true, available: true, activeRunId: null, suites: [
        { id: SID, name: 'Project suite', agentId: null, caseCount: 1, createdAt: '', liveQueries: 0, last: null, stale: [], runningId: null },
        { id: 'b3333333-3333-4333-8333-333333333333', name: 'Finance suite', agentId: AID, caseCount: 2, createdAt: '', liveQueries: 0, last: null, stale: [], runningId: null },
      ] }),
    }));
    renderApp(`/assistant/setup/${PID}?agent=${AID}`);
    const s = await tests();
    expect(await within(s).findByText('Finance suite')).toBeTruthy();
    expect(within(s).queryByText('Project suite')).toBeNull();
  });
});

// ── the results page ───────────────────────────────────────────────────────────────────────────────────────────────────────
const RUN = (over: object = {}) => ({
  id: RID, projectId: PID, suiteId: SID, agentId: null, state: 'done', errorCode: null, mine: true, resumable: false,
  casesTotal: 4, casesDone: 4, passed: 2, failed: 1, notScored: 1, modelCalls: 6, judge: 'anthropic/claude-sonnet-4-6', judgeOwn: true,
  version: { instructions: 'a' }, startedAt: '2026-11-20T10:00:00Z', finishedAt: '2026-11-20T10:02:00Z', elapsedSec: 120, ...over,
});
const LINES = (mine: boolean) => [
  { caseId: 'c1', position: 1, question: 'Sales by region?', outcome: 'pass', score: null, judged: 'none', checks: [{ id: 'answered', ok: true }, { id: 'question', ok: true }, { id: 'figure', ok: true }, { id: 'audit', ok: true }], errorCode: null, calls: 1, move: 'better', ...(mine ? { reply: 'West leads this quarter.' } : {}) },
  { caseId: 'c2', position: 2, question: 'Orders last week?', outcome: 'fail', score: null, judged: 'none', checks: [{ id: 'answered', ok: true }, { id: 'question', ok: false, code: 'different' }, { id: 'figure', ok: false, code: 'different' }, { id: 'audit', ok: true }], errorCode: null, calls: 1, move: 'worse' },
  { caseId: 'c3', position: 3, question: 'Why is revenue net?', outcome: 'not_scored', score: null, judged: 'not_scored', checks: [{ id: 'audit', ok: true }], errorCode: null, calls: 2, move: 'same' },
  { caseId: 'c4', position: 4, question: 'Explain churn', outcome: 'pass', score: 5, judged: 'scored', checks: [{ id: 'audit', ok: true }], errorCode: null, calls: 2, move: 'same', ...(mine ? { why: 'says it', reply: 'Churn fell.' } : {}) },
];
const results = async (mine: boolean, over: object = {}, more: Record<string, RpcReply> = {}) => {
  const calls = serveRpc(common('editor', {
    'eval:runGet': body({ ok: true, suite: { id: SID, name: 'Revenue questions' }, run: RUN({ mine, ...over }), cases: LINES(mine), compare: { runId: 'prev', better: 1, worse: 1, same: 2, new: 0, changed: ['instructions'], judgeDiffers: false } }),
    ...more,
  }));
  renderApp(`/evals/${PID}/${RID}`);
  await screen.findByTestId('eval-results', {}, LAZY);
  return calls;
};

describe('the results page', () => {
  it('shows each case pass, fail and score, the counts, the cost, and the comparison with the last run', async () => {
    await results(true);
    const rows = screen.getAllByTestId('result-row');
    expect(rows.map((r) => r.getAttribute('data-outcome'))).toEqual(['pass', 'fail', 'not_scored', 'pass']);
    expect(screen.getByText('5/5')).toBeTruthy();
    expect(screen.getByTestId('compare').textContent).toContain('1 better, 1 worse, 2 the same');
    expect(screen.getByTestId('compare').textContent).toContain('Instructions changed');
    expect(screen.getByText('Model calls').nextSibling?.textContent).toBe('6');
    expect(screen.getByText(/The Assistant’s own model judged the words/)).toBeTruthy();
    expect(within(rows[1]).getByText('Orders last week?')).toBeTruthy();
    expect(rows[1].textContent).toContain('Same question · Same figure: not met');
  });

  it('a "not scored" case says so and that it is not a pass', async () => {
    await results(true);
    fireEvent.click(within(screen.getAllByTestId('result-row')[2]).getByRole('button'));
    expect(await screen.findByText(/could not be read, so the words were not scored\. This is not a pass\./)).toBeTruthy();
  });

  it('the person who ran it reads the answer\'s words and the judge\'s line', async () => {
    await results(true);
    fireEvent.click(within(screen.getAllByTestId('result-row')[3]).getByRole('button'));
    expect(await screen.findByText('Churn fell.')).toBeTruthy();
    expect(screen.getByText(/says it/)).toBeTruthy();
  });

  it('NEGATIVE CONTROL: another editor sees each outcome but never the words, and is told why', async () => {
    await results(false);
    expect(screen.getAllByTestId('result-row')).toHaveLength(4);
    fireEvent.click(within(screen.getAllByTestId('result-row')[0]).getByRole('button'));
    expect(await screen.findByText('The answer’s words are shown only to the person who ran these tests.')).toBeTruthy();
    expect(screen.queryByText('West leads this quarter.')).toBeNull();
  });

  it('a running run has Stop, and a run that stopped short has Resume for its runner only', async () => {
    const calls = await results(true, { state: 'running', casesDone: 2 }, { 'eval:runStop': body({ ok: true }) });
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    await waitFor(() => expect(sent(calls, 'eval:runStop')).toEqual([{ projectId: PID, runId: RID }]));
    cleanup();
    await results(true, { state: 'partial', errorCode: 'limited', resumable: true });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByText(/AI request limit was reached/)).toBeTruthy();
    cleanup();
    await results(false, { state: 'partial', errorCode: 'limited', resumable: false });
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('a run nobody may read is an error state, not a blank page', async () => {
    serveRpc(common('editor', { 'eval:runGet': body({ ok: false, error: 'That suite, case or run was not found.' }) }));
    renderApp(`/evals/${PID}/${RID}`);
    expect(await screen.findByText('That suite, case or run was not found.', {}, LAZY)).toBeTruthy();
  });
});

// ── Admin → AI → Judge model ───────────────────────────────────────────────────────────────────────────────────────────────
describe('Admin → AI → Judge model', () => {
  const ai = { keyStore: null, providers: [{ provider: 'anthropic', connected: true, saved: true, hasKey: true, baseUrl: '', verifiedAt: '2026-11-01T00:00:00Z' }], models: [SONNET, { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', isDefault: false }], fingerprintModel: null };
  it('defaults to the Assistant\'s own model and saves a pick; a refusal is said', async () => {
    const calls = serveRpc(common('admin', { 'ai:admin': body(ai), 'research:limits': body({ ok: true, limits: { steps: 8, queries: 12, minutes: 10 }, ceilings: { steps: 20, queries: 30, minutes: 30 } }), 'eval:judge': body({ ok: true, pick: null }), 'eval:setJudge': body({ ok: true, pick: { provider: 'anthropic', model: 'claude-haiku-4-5' } }) }));
    renderApp('/admin?tab=ai');
    const card = (await screen.findByRole('heading', { name: 'Judge model' }, LAZY)).closest('div')!.parentElement as HTMLElement;
    const select = await within(card).findByRole('combobox', { name: 'Judged by' });
    expect(select.textContent).toContain('The Assistant’s own model');
    fireEvent.click(select);
    fireEvent.click(screen.getByRole('option', { name: 'Claude Haiku 4.5' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Save judge model' }));
    await waitFor(() => expect(sent(calls, 'eval:setJudge')).toEqual([{ pick: { provider: 'anthropic', model: 'claude-haiku-4-5' } }]));
  });

  it('is not shown to an editor: it is the admin\'s page', async () => {
    serveRpc(common('editor'));
    renderApp('/admin?tab=ai');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Judge model' })).toBeNull());
  });
});
