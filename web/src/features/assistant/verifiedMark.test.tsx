// "✓ Verified · <who>" on an answer card (semantic part 3 D9): the server's `verified` on the `answer:card` reply,
// and nothing without it. The card never decides it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { serveRpc } from '../../test-utils';
import { AnswerCard } from './AnswerCard';

// Chart.js needs a canvas jsdom does not have; the card's head is what is under test.
vi.mock('../../charts/Chart', () => ({ Chart: ({ label }: { label?: string }) => <div role="img" aria-label={label ?? 'Chart'} /> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const SPEC = { datasetId: DID, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Revenue by region' };
const CARD = {
  ok: true, spec: SPEC, title: 'Revenue by region', chartType: 'column', datasetName: 'Orders',
  data: { labels: ['West', 'East'], series: [{ name: 'sum of amount', values: [3, 2] }] }, caption: 'West leads.',
  headline: [{ label: 'Total amount', value: 5, display: '5' }], bullets: [], chips: [], filterLabels: [], steps: [], notes: [],
};
const MARK = { id: '33333333-3333-4333-8333-333333333333', question: 'Revenue by region', by: 'priya@x', at: '2026-10-12T10:00:00Z' };

function draw(reply: unknown) {
  serveRpc({ 'answer:card': { body: reply } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AnswerCard projectId={PID} spec={SPEC} narrated={false} onFollowUp={async () => {}} />
    </QueryClientProvider>,
  );
}

describe('The verified mark', () => {
  it('a card the server marks shows "✓ Verified · who" in its head, titled with the date and the question', async () => {
    draw({ ...CARD, verified: MARK });
    const badge = await screen.findByText('✓ Verified · priya@x');
    expect(badge.closest('[data-testid="answer-card"]')).toBeTruthy();
    expect(badge.getAttribute('title')).toMatch(/^Verified Oct 12: Revenue by region$/);
  });

  it('NEGATIVE CONTROL: a card without it shows no badge', async () => {
    draw(CARD);
    await screen.findByText('Orders');
    expect(screen.queryByText(/Verified/)).toBeNull();
  });
});
