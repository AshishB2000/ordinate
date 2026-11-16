// An answer read straight from a warehouse table (./AnswerCard with `spec.table`, ./KeepTable) and the checked link
// (./LinkCard), phase D: the card says it is a table, not a dataset, links no Data page and offers no Also on, Save as
// visual or Verify; an editor's Keep as a dataset sends the turn and refreshes the conversation, a refusal says the
// server's words; the link card shows the server's checks, adds the link through `relationship:save` and asks again,
// Cancel puts it away, a refusal keeps it; a viewer is offered neither.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { AnswerCard, type Card } from './AnswerCard';
import { LinkCard, linkChecks } from './LinkCard';
import type { AnswerLink } from './api';

const canEdit = vi.hoisted(() => ({ value: true }));
vi.mock('../../charts/Chart', () => ({ Chart: ({ label }: { label?: string }) => <div role="img" aria-label={label ?? 'Chart'} /> }));
vi.mock('../projects/api', () => ({ useCanEdit: () => canEdit.value, useRoles: () => ({ data: undefined }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  canEdit.value = true;
});

const PID = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const CONN = '33333333-3333-4333-8333-333333333333';
const THREAD = '44444444-4444-4444-8444-444444444444';
const SPEC = { datasetId: DOC, table: CONN, category: 'reason', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Returns by reason' };
const CARD: Card = {
  ok: true, title: 'Returns by reason', chartType: 'column', datasetName: 'ANALYTICS.RETURNS',
  data: { labels: ['Damaged', 'Late'], series: [{ name: 'sum of amount', values: [12.6, 7.2] }] }, caption: 'Damaged leads.',
  headline: [], bullets: [], chips: [], filterLabels: [], notes: [], asOf: { at: '2026-11-15T01:00:00Z', mode: 'live' },
  answeredFrom: { datasetId: DOC, origin: 'Connection · Warehouse · ANALYTICS.RETURNS' },
};
const LINK: AnswerLink = {
  from: { datasetId: DOC, dataset: 'Shipments', column: 'country_id' }, to: { datasetId: CONN, dataset: 'Countries', column: 'country_id' },
  cardinality: 'many_to_one', checks: { names: true, types: true, foundPct: 98, unique: true },
};

function serve(routes: Record<string, unknown>) {
  const calls: { channel: string; body: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const channel = decodeURIComponent(url.split('?')[0].slice('/api/rpc/'.length));
    calls.push({ channel, body: init?.body ?? '' });
    return new Response(JSON.stringify(routes[channel] ?? null), { status: 200 });
  }));
  return calls;
}

function withClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}>{node}</QueryClientProvider></MemoryRouter>);
}

describe('an answer read straight from a table', () => {
  it('says it is a warehouse table, links no Data page and offers only Keep as a dataset', () => {
    serve({});
    withClient(<AnswerCard projectId={PID} spec={SPEC} card={CARD} turn={{ threadId: THREAD, turnId: 't1' }} narrated={false} onFollowUp={async () => {}} />);
    expect(screen.getByTestId('answered-from').textContent).toBe('Answered fromANALYTICS.RETURNS');
    expect(screen.getByText('Warehouse table, not a dataset')).toBeTruthy();
    expect(screen.queryByTestId('also-on')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as visual' })).toBeNull();
    expect(screen.queryByRole('button', { name: /verified/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Answered from ANALYTICS.RETURNS' }));
    const panel = screen.getByRole('dialog', { name: 'Answered from ANALYTICS.RETURNS' });
    expect(within(panel).queryByRole('link')).toBeNull();
    expect(within(panel).getByText('Table', { selector: 'dt' })).toBeTruthy();
  });

  it('Keep as a dataset sends the turn, and a refusal says the server\'s words', async () => {
    const calls = serve({ 'answer:keepTable': { ok: false, reason: 'This answer is not read straight from a warehouse table.' } });
    withClient(<AnswerCard projectId={PID} spec={SPEC} card={CARD} turn={{ threadId: THREAD, turnId: 't1' }} narrated={false} onFollowUp={async () => {}} />);
    fireEvent.click(screen.getByTestId('answer-keep-table'));
    expect((await screen.findByRole('alert')).textContent).toBe('This answer is not read straight from a warehouse table.');
    const sent = calls.find((c) => c.channel === 'answer:keepTable');
    expect(sent?.body).toContain(THREAD);
    expect(sent?.body).toContain('t1');
  });

  it('a viewer is not offered Keep as a dataset', () => {
    canEdit.value = false;
    serve({});
    withClient(<AnswerCard projectId={PID} spec={SPEC} card={CARD} turn={{ threadId: THREAD, turnId: 't1' }} narrated={false} onFollowUp={async () => {}} />);
    expect(screen.queryByTestId('answer-keep-table')).toBeNull();
  });

  it('a dataset\'s answer keeps Save as visual and Also on (NEGATIVE CONTROL)', () => {
    serve({});
    canEdit.value = true;
    const { table: _t, ...onDataset } = SPEC;
    withClient(<AnswerCard projectId={PID} spec={onDataset} card={CARD} turn={{ threadId: THREAD, turnId: 't1' }} narrated={false} onFollowUp={async () => {}} />);
    expect(screen.getByRole('button', { name: 'Save as visual' })).toBeTruthy();
    expect(screen.getByTestId('also-on')).toBeTruthy();
    expect(screen.queryByTestId('answer-keep-table')).toBeNull();
  });
});

describe('the checked link', () => {
  it('shows the server\'s checks as they came', () => {
    expect(linkChecks(LINK)).toEqual(['Names match', 'Types match', '98% of sampled values found', 'Unique in Countries']);
    expect(linkChecks({ ...LINK, checks: { names: false, types: true, foundPct: null, unique: false } })).toEqual(['Names differ', 'Types match', 'Repeats in Countries']);
  });

  it('adds the link through relationship:save and asks the question again', async () => {
    const calls = serve({ 'relationship:save': { ok: true } });
    const asked: string[] = [];
    withClient(<LinkCard projectId={PID} link={LINK} question="amount by territory" onAsk={(q) => asked.push(q)} busy={false} />);
    expect(screen.getByTestId('answer-link').textContent).toContain('Link Shipments.country_id → Countries.country_id?');
    fireEvent.click(screen.getByRole('button', { name: 'Add link and answer' }));
    await waitFor(() => expect(asked).toEqual(['amount by territory']));
    const body = calls.find((c) => c.channel === 'relationship:save')?.body ?? '';
    expect(body).toContain('many_to_one');
    expect(screen.queryByTestId('answer-link')).toBeNull();
  });

  it('a refused save keeps the card with the server\'s words; Cancel puts it away', async () => {
    serve({ 'relationship:save': { ok: false, error: 'A column of this link is gone.' } });
    const asked: string[] = [];
    withClient(<LinkCard projectId={PID} link={LINK} question="amount by territory" onAsk={(q) => asked.push(q)} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add link and answer' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A column of this link is gone.');
    expect(asked).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('answer-link')).toBeNull();
  });

  it('a viewer is not offered it', () => {
    canEdit.value = false;
    serve({});
    withClient(<LinkCard projectId={PID} link={LINK} question="q" busy={false} />);
    expect(screen.queryByTestId('answer-link')).toBeNull();
  });
});
