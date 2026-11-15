// "Not what I asked" on an answer that matched a verified question (the turn's `guidance.verifiedId`): beside the
// card's "Matched …" line (the server's `verified.kind`), or alone where that line is gone or the card cannot be
// drawn. It hands the same words back to be asked of the model; `ask` sends them with `skipVerified`. No button
// under a model's answer, or where no model can take the question.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { serveRpc } from '../../test-utils';
import { ask, type Turn } from './api';
import type { Card } from './AnswerCard';
import { Transcript } from './Transcript';

vi.mock('../../charts/Chart', () => ({ Chart: ({ label }: { label?: string }) => <div role="img" aria-label={label ?? 'Chart'} /> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-14T10:00:00Z';
const SPEC = { datasetId: DID, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Revenue last month' };
const CARD: Card = {
  ok: true, title: 'Revenue last month', chartType: 'column', datasetName: 'Orders', data: { labels: ['West'], series: [{ name: 'sum of amount', values: [3] }] } as Card['data'],
  caption: '', headline: [], bullets: [], chips: [], filterLabels: [], notes: [],
};
const MARK = { id: 'v1', question: 'Revenue last month', by: 'Maria', at: NOW };
const asked: Turn = { id: 'u1', role: 'user', text: 'revenue last month?', createdAt: NOW };
const verified: Turn = { id: 'a1', role: 'assistant', text: '', createdAt: NOW, answer: SPEC, card: { ...CARD, verified: { ...MARK, kind: 'matched' } }, guidance: { verifiedId: 'v1', instructions: 0, examples: [] } };
const modelled: Turn = { id: 'a2', role: 'assistant', text: 'West leads.', createdAt: NOW, answer: SPEC, card: { ...CARD, verified: { ...MARK, kind: 'based_on' } }, guidance: { instructions: 0, examples: ['v1'] } };

function draw(turns: Turn[], onNotThis?: (q: string) => void, rpcs: Parameters<typeof serveRpc>[0] = {}) {
  serveRpc(rpcs);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Transcript turns={turns} pending={null} lastSteps={null} projectId={PID} threadId="t1" onFollowUp={async () => {}} onNotThis={onNotThis} />
    </QueryClientProvider>,
  );
}

describe('Not what I asked', () => {
  it('on a matched answer: names the verified question, and hands back the question that was asked', () => {
    const onNotThis = vi.fn();
    draw([asked, verified], onNotThis);
    expect(screen.getByTestId('verified-matched').textContent).toBe('✓ Matched Maria\'s verified question: “Revenue last month”Not what I asked');
    fireEvent.click(screen.getByRole('button', { name: 'Not what I asked' }));
    expect(onNotThis).toHaveBeenCalledWith('revenue last month?');
  });

  it('NEGATIVE CONTROL: none under a model answer, even one based on a verified question, and none when no model can take it', () => {
    draw([asked, modelled], vi.fn());
    expect(screen.getByTestId('verified-matched').textContent).toContain('Based on Maria');
    expect(screen.queryByRole('button', { name: 'Not what I asked' })).toBeNull();
    cleanup();
    draw([asked, verified]);
    expect(screen.getByTestId('verified-matched').textContent).toContain('Matched Maria');
    expect(screen.queryByRole('button', { name: 'Not what I asked' })).toBeNull();
  });

  it('the question deleted since: the card claims nothing, and Not what I asked stays, alone', () => {
    const onNotThis = vi.fn();
    draw([asked, { ...verified, card: CARD }], onNotThis);
    expect(screen.queryByTestId('verified-matched')).toBeNull();
    expect(screen.queryByText(/verified question/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not what I asked' }));
    expect(onNotThis).toHaveBeenCalledWith('revenue last month?');
  });

  it('the card cannot be drawn: its reason, and Not what I asked under it', async () => {
    const { card: _c, ...bare } = verified;
    draw([asked, bare], vi.fn(), { 'answer:refresh': { body: { ok: false, reason: 'Orders is gone.' } } });
    expect(await screen.findByText('Orders is gone.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not what I asked' })).toBeTruthy();
  });

  it('NEGATIVE CONTROL: a model answer that cannot be drawn offers none', async () => {
    const { card: _c, ...bare } = modelled;
    draw([asked, bare], vi.fn(), { 'answer:refresh': { body: { ok: false, reason: 'Orders is gone.' } } });
    expect(await screen.findByText('Orders is gone.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Not what I asked' })).toBeNull();
  });

  it('ask sends skipVerified only when set', async () => {
    const calls = serveRpc({ 'copilot:ask': { body: { ok: false, notReady: true } } });
    await ask(PID, { kind: '' }, 'Revenue last month', 't1', 'a', null, true);
    await ask(PID, { kind: '' }, 'Revenue last month', 't1', 'b');
    const sent = calls.filter((c) => c.channel === 'copilot:ask').map((c) => c.payload as Record<string, unknown>);
    expect(sent[0].skipVerified).toBe(true);
    expect('skipVerified' in sent[1]).toBe(false);
  });
});
