// An answer keeps its figures (docs/assistant/00-design.md, "Answers keep the figures they had"): a card its
// conversation brought draws with no call, dated "As of … · first asked …", a relative period with its days, and
// Refresh (busy, failed, done); a card it did not bring is drawn by `answer:refresh` and kept, says so when the
// person's access changed, and says "Updates on open" when it is too big to keep. Every time and figure is the server's.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { AnswerCard, type Card } from './AnswerCard';
import type { Turn } from './api';

vi.mock('../../charts/Chart', () => ({ Chart: ({ label }: { label?: string }) => <div role="img" aria-label={label ?? 'Chart'} /> }));
// The card's own buttons, not who may save: an editor's roles are not what is under test.
vi.mock('../projects/api', () => ({ useCanEdit: () => false }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const TID = '33333333-3333-4333-8333-333333333333';
const TURN = '44444444-4444-4444-8444-444444444444';
const SPEC = { datasetId: DID, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [{ column: 'day', period: 'yesterday' }], chartType: 'column', title: 'Revenue by region' };
const FIRST = '2026-11-01T12:00:00Z';
const KEPT_AT = '2026-11-15T09:10:00Z';
const card = (display: string, snapshot?: Card['snapshot']): Card => ({
  ok: true, title: 'Revenue by region', chartType: 'column', datasetName: 'Orders',
  data: { labels: ['West', 'East'], series: [{ name: 'sum of amount', values: [3, 2] }] }, caption: 'West leads.',
  headline: [{ label: 'Total amount', display }], bullets: [], chips: [], filterLabels: ['day: 2026-10-31'], notes: [],
  asOf: { at: '2026-11-15T01:00:00Z', mode: 'extract' }, ...(snapshot ? { snapshot } : {}),
});
const YESTERDAY = [{ name: 'Yesterday', from: '2026-10-31', to: '2026-10-31' }];
const KEPT = card('5', { asOf: KEPT_AT, firstAsked: FIRST, periods: YESTERDAY });

/** Each channel answers with a body, or what a function of the payload returns (a promise holds it open). */
function serve(routes: Record<string, unknown>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const channel = decodeURIComponent(url.split('?')[0].slice('/api/rpc/'.length));
    const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
    calls.push({ channel, payload });
    const r = routes[channel];
    const body = typeof r === 'function' ? await (r as (p: unknown) => unknown)(payload) : r;
    return new Response(JSON.stringify(body ?? null), { status: 200 });
  }));
  return calls;
}

/** The card as the transcript draws it: from the conversation's copy of its turn, which a kept card patches. */
function Conversation() {
  const h = useQuery<{ ok: true; turns: Turn[] }>({ queryKey: ['copilot:history', PID, TID], queryFn: () => new Promise(() => undefined), enabled: false });
  const t = h.data?.turns[0];
  if (!t?.answer) return null;
  return <AnswerCard projectId={PID} spec={t.answer} turn={{ threadId: TID, turnId: t.id }} card={t.card} narrated={false} onFollowUp={async () => {}} />;
}

function draw(kept?: Card) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const turn: Turn = { id: TURN, role: 'assistant', text: '', createdAt: FIRST, answer: SPEC, ...(kept ? { card: kept } : {}) };
  client.setQueryData(['copilot:history', PID, TID], { ok: true, turns: [turn] });
  const view = render(
    <QueryClientProvider client={client}>
      <Conversation />
    </QueryClientProvider>,
  );
  return { client, view };
}
const keptTurn = (client: QueryClient) => (client.getQueryData(['copilot:history', PID, TID]) as { turns: Turn[] }).turns[0];

describe('An answer that kept its card', () => {
  it('draws with no call: "As of … · first asked Nov 1", and Yesterday names its day', async () => {
    const calls = serve({});
    draw(KEPT);
    const c = await screen.findByTestId('answer-card');
    expect(within(c).getByText('5')).toBeTruthy();
    const line = within(c).getByTestId('answer-kept');
    expect(line.textContent).toMatch(/^As of .+· first asked Nov 1$/);
    expect(within(line).getByTestId('as-of').getAttribute('datetime')).toBe(KEPT_AT); // the time it was computed, not its data's
    expect(within(c).getAllByTestId('as-of')).toHaveLength(1);
    expect(within(c).getByText('Yesterday: Oct 31, 2026')).toBeTruthy();
    expect(within(c).queryByTestId('answer-access-changed')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('an answer kept as it was first given says no "first asked"', async () => {
    serve({});
    draw(card('5', { asOf: FIRST, periods: [] }));
    expect((await screen.findByTestId('answer-kept')).textContent).not.toMatch(/first asked/);
  });

  it('Refresh says it is refreshing, sends the turn, then draws the server\'s new card in its place', async () => {
    let reply = (_: unknown): void => undefined;
    const calls = serve({ 'answer:refresh': () => new Promise((r) => (reply = r)) });
    const { client } = draw(KEPT);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    const busy = await screen.findByRole('button', { name: 'Refreshing…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(calls.map((x) => x.payload)).toEqual([{ projectId: PID, threadId: TID, turnId: TURN }]);
    const NOW = '2026-11-15T10:00:00Z';
    await act(async () => reply(card('9', { asOf: NOW, firstAsked: FIRST, periods: [{ name: 'Yesterday', from: '2026-11-14', to: '2026-11-14' }] })));
    expect(await screen.findByText('9')).toBeTruthy();
    expect(screen.queryByText('5')).toBeNull();
    expect(screen.getByTestId('as-of').getAttribute('datetime')).toBe(NOW);
    expect(screen.getByText('Yesterday: Nov 14, 2026')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(keptTurn(client).card?.headline[0].display).toBe('9'); // the conversation keeps the new one
  });

  it('a failed Refresh says why in the server\'s words, keeps the card it had, and can be tried again', async () => {
    serve({ 'answer:refresh': { ok: false, reason: '"region" is no longer a column of Orders.' } });
    draw(KEPT);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect((await screen.findByRole('alert')).textContent).toBe('"region" is no longer a column of Orders.');
    expect(screen.getByText('5')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('An answer that brought no card', () => {
  it('is drawn now and kept: one call naming the turn, while a skeleton stands in; a remount asks nothing', async () => {
    let reply = (_: unknown): void => undefined;
    const calls = serve({ 'answer:refresh': () => new Promise((r) => (reply = r)) });
    const { client, view } = draw();
    expect(await screen.findByRole('status', { name: 'Drawing the answer' })).toBeTruthy();
    await act(async () => reply(card('7', { asOf: KEPT_AT, firstAsked: FIRST, periods: [] })));
    expect(await screen.findByText('7')).toBeTruthy();
    expect(screen.getByTestId('answer-kept').textContent).toMatch(/first asked Nov 1$/);
    expect(calls.map((x) => [x.channel, x.payload])).toEqual([['answer:refresh', { projectId: PID, threadId: TID, turnId: TURN }]]);
    expect(keptTurn(client).card?.headline[0].display).toBe('7');
    view.unmount();
    render(
      <QueryClientProvider client={client}>
        <Conversation />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('7')).toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it('says so when the person\'s access changed since, so the figures are today\'s', async () => {
    serve({ 'answer:refresh': card('4', { asOf: KEPT_AT, firstAsked: FIRST, periods: [], accessChanged: true }) });
    draw();
    const notice = await screen.findByTestId('answer-access-changed');
    expect(notice.textContent).toBe('Your access changed since this answer, so it shows today’s figures.');
    expect(notice.getAttribute('role')).toBe('status');
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('NEGATIVE CONTROL: a refreshed card whose access held carries no notice', async () => {
    serve({ 'answer:refresh': card('4', { asOf: KEPT_AT, firstAsked: FIRST, periods: [] }) });
    draw();
    await screen.findByText('4');
    expect(screen.queryByTestId('answer-access-changed')).toBeNull();
  });

  it('too big to keep: labelled Updates on open, with its data\'s own time and no Refresh, and the conversation keeps nothing', async () => {
    serve({ 'answer:refresh': card('6', { asOf: null, periods: YESTERDAY }) });
    const { client } = draw();
    const live = await screen.findByTestId('answer-live');
    expect(live.textContent).toBe('Updates on open');
    expect(live.getAttribute('title')).toMatch(/computed each time it opens/);
    expect(screen.getByTestId('as-of').getAttribute('datetime')).toBe('2026-11-15T01:00:00Z');
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(screen.getByText('Yesterday: Oct 31, 2026')).toBeTruthy();
    expect(keptTurn(client).card).toBeUndefined();
  });

  it('a dataset gone since: the server\'s sentence, no figure', async () => {
    serve({ 'answer:refresh': { ok: false, reason: 'The dataset this answer was built on no longer exists.' } });
    draw();
    expect(await screen.findByText('The dataset this answer was built on no longer exists.')).toBeTruthy();
    expect(screen.queryByTestId('answer-card')).toBeNull();
  });
});

it('wears the theme\'s tokens only — every colour the kept line, Live and the notice use is defined for light AND dark', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const theme = read('../../theme.css');
  const at = theme.search(/^\[data-theme="dark"\]/m);
  const [light, dark] = [theme.slice(0, at), theme.slice(at)];
  const css = read('./AnswerCard.module.css');
  const ours = css.slice(css.indexOf('.kept {'), css.indexOf('.verified {'));
  const used = [...new Set([...ours.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]))];
  expect(used).toEqual(expect.arrayContaining(['--muted', '--border-2', '--warn-soft', '--warn-text']));
  for (const token of used) expect(light.includes(`${token}:`), `${token} is a theme token`).toBe(true);
  for (const token of ['--muted', '--border-2', '--warn-soft', '--warn-text']) expect(dark.includes(`${token}:`), `${token} has a dark value`).toBe(true);
  expect(ours).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});
