// An SQL answer's card (./AnswerSql, docs/assistant/00-design.md "The SQL lane"): the table the server ran, marked
// "Not checked · SQL written by the AI" until verified, Show SQL, Verify for editors only, a chart for a label and a
// number, and the line that says it is not a chart where Save as visual would be. Every cell is the server's.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnswerSql, NOT_A_CHART, NOT_CHECKED, type SqlCard } from './AnswerSql';

vi.mock('../../charts/Chart', () => ({ Chart: ({ label }: { label?: string }) => <div role="img" aria-label={label ?? 'Chart'} /> }));
const role = vi.hoisted(() => ({ editor: false }));
vi.mock('../projects/api', () => ({ useCanEdit: () => role.editor }));

// jsdom has no layout: give every box a client size so the grid's virtualizers draw rows.
const sizes = { clientHeight: 400, clientWidth: 800 };
const saved: Partial<Record<keyof typeof sizes, PropertyDescriptor>> = {};
beforeAll(() => {
  for (const k of Object.keys(sizes) as (keyof typeof sizes)[]) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => sizes[k] });
  }
});
afterAll(() => {
  for (const k of Object.keys(sizes) as (keyof typeof sizes)[]) {
    const d = saved[k];
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  role.editor = false;
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const TURN = { threadId: '33333333-3333-4333-8333-333333333333', turnId: '44444444-4444-4444-8444-444444444444' };
const SQL = 'SELECT customer, count(*) AS orders FROM orders GROUP BY customer HAVING count(*) > 1';
const STORED = { text: SQL, datasetIds: [DID], title: 'Customers with repeat orders' };
const TABLE: SqlCard = {
  ok: true, kind: 'sql', title: 'Customers with repeat orders', sql: SQL, datasets: ['Orders'],
  columns: [{ name: 'customer', type: 'text' }, { name: 'first', type: 'date' }, { name: 'orders', type: 'number' }],
  rows: [['Acme', '2026-01-04', 3], ['Globex', '2026-02-01', 2]], rowCount: 2, truncated: false,
  caption: '2 rows · 3 columns', bullets: ['Reads “Orders”.'],
  snapshot: { asOf: '2026-11-15T09:10:00Z', periods: [] },
};

function serve(routes: Record<string, unknown>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const channel = decodeURIComponent(url.split('?')[0].slice('/api/rpc/'.length));
    const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
    calls.push({ channel, payload });
    return new Response(JSON.stringify(routes[channel] ?? null), { status: 200 });
  }));
  return calls;
}

const draw = (card?: SqlCard) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AnswerSql projectId={PID} turn={TURN} sql={STORED} card={card} question="Which customers ordered more than once?" />
    </QueryClientProvider>,
  );

describe('AnswerSql', () => {
  it('draws the kept table with no call: the badge, the cells, the app\'s caption and bullets, and why it is no chart', async () => {
    const calls = serve({});
    draw(TABLE);
    const card = screen.getByTestId('answer-sql');
    expect(within(card).getByText('Customers with repeat orders')).toBeTruthy();
    expect(screen.getByTestId('answer-sql-unchecked').textContent).toBe(NOT_CHECKED);
    expect(NOT_CHECKED).toBe('Not checked · SQL written by the AI');
    expect(screen.getByRole('grid', { name: 'Customers with repeat orders' })).toBeTruthy();
    expect(await within(card).findByText('Acme')).toBeTruthy(); // the grid's rows arrive a page at a time
    expect(within(card).getByText('2 rows · 3 columns')).toBeTruthy();
    expect(within(card).getByText('Reads “Orders”.')).toBeTruthy();
    expect(within(card).getByText(NOT_A_CHART)).toBeTruthy();
    expect(within(card).queryByText(/Save as visual/)).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('Show SQL opens the statement and closes it again', () => {
    serve({});
    draw(TABLE);
    expect(screen.queryByTestId('answer-sql-text')).toBeNull();
    const button = screen.getByRole('button', { name: 'Show SQL' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByTestId('answer-sql-text').textContent).toBe(SQL);
    fireEvent.click(screen.getByRole('button', { name: 'Hide SQL' }));
    expect(screen.queryByTestId('answer-sql-text')).toBeNull();
  });

  it('offers Verify to an editor, which sends the statement, never to a viewer', async () => {
    serve({});
    draw(TABLE);
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    cleanup();
    role.editor = true;
    const calls = serve({ 'verified:save': { ok: true, question: { id: 'x' } } });
    draw(TABLE);
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'verified:save')).toBe(true));
    const sent = calls.find((c) => c.channel === 'verified:save')!.payload as { input: Record<string, unknown> };
    expect(sent.input.sql).toBe(SQL);
    expect('spec' in sent.input).toBe(false);
    expect(sent.input.question).toBe('Which customers ordered more than once?');
  });

  it('a table the warehouse answered (Live) is offered Verify to an editor (phase F, F4), never to a viewer', async () => {
    serve({});
    const LIVE: SqlCard = { ...TABLE, asOf: { at: '2026-11-15T02:05:00Z', mode: 'live' } };
    draw(LIVE);
    expect(screen.getByTestId('answer-sql-unchecked').textContent).toBe(NOT_CHECKED);
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull(); // a viewer
    cleanup();
    role.editor = true;
    const calls = serve({ 'verified:save': { ok: true, question: { id: 'x' } } });
    draw(LIVE);
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'verified:save')).toBe(true));
    const sent = calls.find((c) => c.channel === 'verified:save')!.payload as { input: Record<string, unknown> };
    expect(sent.input.sql).toBe(SQL);
    expect(Object.keys(sent.input).sort()).toEqual(['note', 'phrasings', 'question', 'sql']); // the datasets are the server's, never sent
  });

  it('a verified statement says who verified it, and is neither Not checked nor offered Verify', () => {
    serve({});
    role.editor = true;
    draw({ ...TABLE, verified: { id: 'v', question: 'Repeat customers', by: 'maria', at: '2026-11-10T10:00:00Z' } });
    expect(screen.getByText('✓ Verified · maria')).toBeTruthy();
    expect(screen.queryByTestId('answer-sql-unchecked')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
  });

  it('a label and one number come with a chart; the table is a click away', () => {
    serve({});
    draw({
      ...TABLE, columns: [{ name: 'customer', type: 'text' }, { name: 'orders', type: 'number' }], rows: [['Acme', 3], ['Globex', 2]],
      chart: { type: 'column', data: { labels: ['Acme', 'Globex'], series: [{ name: 'orders', values: [3, 2] }] } },
    });
    expect(screen.getByRole('img', { name: 'Customers with repeat orders' })).toBeTruthy();
    expect(screen.queryByRole('grid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(screen.getByRole('grid')).toBeTruthy();
  });

  it('a table the conversation did not bring runs again through answer:refresh; a refusal says why', async () => {
    const calls = serve({ 'answer:refresh': TABLE });
    draw(undefined);
    expect(await screen.findByText('2 rows · 3 columns')).toBeTruthy();
    expect(calls).toEqual([{ channel: 'answer:refresh', payload: { projectId: PID, ...TURN } }]);
    cleanup();
    serve({ 'answer:refresh': { ok: false, reason: 'Row access rules limit what you see in “Orders”.' } });
    draw(undefined);
    expect(await screen.findByText('Row access rules limit what you see in “Orders”.')).toBeTruthy();
  });

  it('a Live table not kept says the warehouse answered it, dated; a kept one by its kept time', () => {
    serve({});
    draw({ ...TABLE, asOf: { at: '2026-11-15T02:05:00Z', mode: 'live' }, snapshot: { asOf: null, periods: [] } });
    expect(screen.getByTestId('as-of').textContent).toMatch(/^Live · /);
    expect(screen.getByTestId('answer-live')).toBeTruthy();
    cleanup();
    draw({ ...TABLE, asOf: { at: '2026-11-15T09:10:00Z', mode: 'live' } });
    expect(screen.getByTestId('answer-kept')).toBeTruthy();
    expect(screen.getAllByTestId('as-of')).toHaveLength(1); // the kept time's, not a second caption
  });
});
