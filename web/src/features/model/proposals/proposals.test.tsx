// Metric proposals in the web (docs/metric-proposals/00-design.md): the queue under Data model, the card (its live preview is
// the server's, its Approve / Edit / Decline), and the Assistant's button. Every reply is canned: the cards, their figures and
// every sentence of a refusal are the server's.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc } from '../../../test-utils';
import { ProposeDefinition } from '../../assistant/ProposeDefinition';
import type { ProposalRow } from '../../dashboards/mentionsApi';
import { ProposalsTab } from './ProposalsTab';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const card = (over: Record<string, unknown> = {}) => ({
  id: 'a1111111-1111-4111-8111-111111111111', kind: 'metric', name: 'Gross margin', datasetId: 'b1111111-1111-4111-8111-111111111111', datasetName: 'Orders',
  description: 'Revenue minus cost, over revenue.', aliases: ['margin', 'GM'], formula: '(sum(revenue) - sum(cost)) / sum(revenue)', format: 'percent', asks: 7,
  questions: ['Gross margin by region last quarter', 'What is our margin?'], state: 'open', decidedBy: '', answer: '', edited: false, savedId: null, createdAt: '2026-11-21T10:00:00Z', ...over,
});
const wrap = (ui: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>,
);
const CHECK = { valid: true, ok: true, preview: { ok: true, value: 0.412, display: '41.2%' } };

describe('Proposals queue', () => {
  it('shows the definition, the count, the questions and the server\'s own figure', async () => {
    const calls = serveRpc({ 'proposal:list': { body: { ok: true, proposals: [card()] } }, 'metric:check': { body: CHECK } });
    wrap(<ProposalsTab projectId={PID} />);
    const c = await screen.findByTestId('proposal-card');
    expect(within(c).getByText('Needed 7 times')).toBeTruthy();
    expect(within(c).getByText('(sum(revenue) - sum(cost)) / sum(revenue)')).toBeTruthy();
    expect(within(c).getByText('Gross margin by region last quarter')).toBeTruthy();
    expect(await within(c).findByTestId('proposal-figure')).toHaveProperty('textContent', '41.2%'); // the server's display string, never computed here
    const check = calls.find((x) => x.channel === 'metric:check');
    expect(check?.payload).toMatchObject({ projectId: PID, expression: '(sum(revenue) - sum(cost)) / sum(revenue)' });
    expect(calls.some((x) => x.channel === 'proposal:approve')).toBe(false);
  });

  it('approves as drafted, and says what the editor did', async () => {
    const calls = serveRpc({ 'proposal:list': { body: { ok: true, proposals: [card()] } }, 'metric:check': { body: CHECK }, 'proposal:approve': { body: { ok: true, savedId: 'c1' } } });
    wrap(<ProposalsTab projectId={PID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find((x) => x.channel === 'proposal:approve')?.payload).toEqual({ projectId: PID, id: card().id }));
  });

  it('edits the formula and sends only what changed; the preview follows the box once it is left', async () => {
    const calls = serveRpc({ 'proposal:list': { body: { ok: true, proposals: [card()] } }, 'metric:check': { body: CHECK }, 'proposal:approve': { body: { ok: true, savedId: 'c1' } } });
    wrap(<ProposalsTab projectId={PID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Formula');
    fireEvent.change(box, { target: { value: 'sum(revenue) - sum(cost)' } });
    fireEvent.blur(box);
    await waitFor(() => expect(calls.some((x) => x.channel === 'metric:check' && (x.payload as { expression: string }).expression === 'sum(revenue) - sum(cost)')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Approve with edits' }));
    await waitFor(() => expect(calls.find((x) => x.channel === 'proposal:approve')?.payload).toEqual({ projectId: PID, id: card().id, edit: { formula: 'sum(revenue) - sum(cost)' } }));
  });

  it('declines only with a note, and shows a refusal in the server\'s words', async () => {
    const calls = serveRpc({ 'proposal:list': { body: { ok: true, proposals: [card()] } }, 'metric:check': { body: CHECK }, 'proposal:decline': { body: { ok: false, error: 'That proposal was already decided.' } } });
    wrap(<ProposalsTab projectId={PID} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    const go = screen.getByRole('button', { name: 'Decline' });
    expect((go as HTMLButtonElement).disabled).toBe(true); // no note, no decline (negative control: with a note it goes)
    fireEvent.change(screen.getByLabelText(/Why not/), { target: { value: 'Tracked elsewhere' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(calls.find((x) => x.channel === 'proposal:decline')?.payload).toEqual({ projectId: PID, id: card().id, note: 'Tracked elsewhere' }));
    expect(await screen.findByText('That proposal was already decided.')).toBeTruthy();
  });

  it('a draft that no longer passes is shown with why, asks for no figure and cannot be approved as is', async () => {
    const calls = serveRpc({ 'proposal:list': { body: { ok: true, proposals: [card({ problem: '"cost" is not a column of Orders that you can use.' })] } }, 'metric:check': { body: CHECK } });
    wrap(<ProposalsTab projectId={PID} />);
    expect(await screen.findByText('"cost" is not a column of Orders that you can use.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((x) => x.channel === 'metric:check')).toBe(false);
  });

  it('a term\'s preview is a count of the rows it matches, asked of metric:preview', async () => {
    const term = card({ kind: 'term', name: 'EMEA', formula: undefined, format: undefined, filters: [{ column: 'region', op: 'in', values: ['EU', 'ME'] }] });
    const calls = serveRpc({ 'proposal:list': { body: { ok: true, proposals: [term] } }, 'metric:preview': { body: { ok: true, value: 12, display: '12' } } });
    wrap(<ProposalsTab projectId={PID} />);
    expect(await screen.findByText('Rows it matches, counted for you now')).toBeTruthy();
    expect((await screen.findByTestId('proposal-figure')).textContent).toBe('12');
    expect(calls.find((x) => x.channel === 'metric:preview')?.payload).toMatchObject({ definition: { aggregation: 'count' }, filters: [{ type: 'filter', column: 'region', op: 'in', values: ['EU', 'ME'] }] });
  });

  it('has real empty and error states', async () => {
    serveRpc({ 'proposal:list': { body: { ok: true, proposals: [] } } });
    wrap(<ProposalsTab projectId={PID} />);
    expect(await screen.findByText('No proposals waiting')).toBeTruthy();
    cleanup();
    serveRpc({ 'proposal:list': { body: { ok: false, error: 'Boom' } } });
    wrap(<ProposalsTab projectId={PID} />);
    expect(await screen.findByText('Boom')).toBeTruthy();
  });
});

describe('Propose a definition', () => {
  const T = 'd1111111-1111-4111-8111-111111111111';
  it('asks the server once for the caller\'s own turn and says what happens next', async () => {
    const calls = serveRpc({ 'proposal:propose': { body: { ok: true, id: 'x', raised: false, asks: 1 } } });
    wrap(<ProposeDefinition projectId={PID} threadId={T} turnId={T} />);
    expect(screen.getByText(/never your figures/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Propose a definition' }));
    expect(await screen.findByTestId('propose-done')).toBeTruthy();
    expect(calls.filter((x) => x.channel === 'proposal:propose')).toHaveLength(1);
    expect(calls[0].payload).toEqual({ projectId: PID, threadId: T, turnId: T });
  });
  it('says a repeat was added to the existing card', async () => {
    serveRpc({ 'proposal:propose': { body: { ok: true, id: 'x', raised: true, asks: 4 } } });
    wrap(<ProposeDefinition projectId={PID} threadId={T} turnId={T} />);
    fireEvent.click(screen.getByRole('button', { name: 'Propose a definition' }));
    expect((await screen.findByTestId('propose-done')).textContent).toMatch(/already proposed.*4 so far/);
  });
  it('shows the app\'s refusal, and the button stays for another try', async () => {
    serveRpc({ 'proposal:propose': { body: { ok: false, error: '"nope" is not a column of Orders that you can use.' } } });
    wrap(<ProposeDefinition projectId={PID} threadId={T} turnId={T} />);
    fireEvent.click(screen.getByRole('button', { name: 'Propose a definition' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '"nope" is not a column of Orders that you can use.');
    expect(screen.getByRole('button', { name: 'Propose a definition' })).toBeTruthy();
  });
});

describe('The bell\'s definition proposals', () => {
  const row = (over: Partial<ProposalRow> = {}): ProposalRow => ({ projectId: PID, id: 'a1111111-1111-4111-8111-111111111111', kind: 'metric', name: 'Gross margin', state: 'approved' as const, decidedBy: 'Ana', answer: '', asks: 7, question: 'Gross margin by region last quarter', at: new Date().toISOString(), mine: true, seen: false, ...over });
  it('tells an asker it is defined, and Ask again hands the same question back to the Assistant', async () => {
    const { ProposalsForYou } = await import('../../dashboards/ProposalsForYou');
    const { usePendingQuestion, takePendingQuestion } = await import('../../assistant/dockState');
    serveRpc({ 'mentions:seen': { body: { ok: true } }, 'projects:overview': { body: [] } });
    function Probe() { return <span data-testid="handed">{usePendingQuestion('dock')}</span>; }
    wrap(<><ProposalsForYou items={[row()]} onOpened={() => undefined} /><Probe /></>);
    expect(screen.getByText('“Gross margin” is now defined')).toBeTruthy();
    expect(screen.getByText('Gross margin by region last quarter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Ask again/ }));
    await waitFor(() => expect(screen.getByTestId('handed').textContent).toBe('Gross margin by region last quarter'));
    takePendingQuestion();
  });
  it('an editor\'s row opens the Proposals tab and has no Ask again; a decline shows the note', async () => {
    const { ProposalsForYou } = await import('../../dashboards/ProposalsForYou');
    serveRpc({ 'mentions:seen': { body: { ok: true } }, 'projects:overview': { body: [] } });
    wrap(<ProposalsForYou items={[row({ mine: false, state: 'open', decidedBy: '', question: '' }), row({ id: 'e1111111-1111-4111-8111-111111111111', state: 'declined', answer: 'Tracked elsewhere' })]} onOpened={() => undefined} />);
    expect(screen.getByText('A metric was proposed: Gross margin')).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /Ask again/ })).toHaveLength(0);
    expect(screen.getByText('Tracked elsewhere')).toBeTruthy();
  });
});
