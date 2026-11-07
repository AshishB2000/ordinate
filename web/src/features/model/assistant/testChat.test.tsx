// The Data model's test chat (semantic part 3 D11): an editor asks as their team would and sees how each answer was
// found. Its thread is the caller's own, titled "Data model test", made on the first ask; a viewer never sees it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';
import { specWords } from './specWords';
import type { VerifiedRow } from './api';

// Chart.js needs a canvas jsdom does not have; the card's words are what is under test.
vi.mock('../../../charts/Chart', () => ({ Chart: ({ label }: { label?: string }) => <div role="img" aria-label={label ?? 'Chart'} /> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const V1 = '3c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const E = '4c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const T = '5d6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };
const SPEC = { datasetId: D, category: 'region', measures: [{ column: 'net_amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Revenue by region' };
const CARD = {
  ok: true, title: 'Revenue by region', chartType: 'column', datasetName: 'Orders', data: { labels: ['West'], series: [{ name: 'sum', values: [3] }] },
  caption: '', headline: [], bullets: [], chips: [], filterLabels: [], notes: [],
};
const NOW = '2026-10-12T10:00:00Z';
const row = (id: string, question: string): VerifiedRow => ({
  id, question, phrasings: [], datasetId: D, datasetName: 'Orders', describe: 'sum of net_amount by region', filters: [], spec: { ...SPEC, title: question },
  verifiedBy: 'priya@acme.test', verifiedAt: NOW, runs: true, tag: `tag-${id}`,
});
const user = (id: string, text: string) => ({ id, role: 'user', text, createdAt: NOW });
const bot = (id: string, text: string, more: object = {}) => ({ id, role: 'assistant', text, createdAt: NOW, answer: SPEC, provenance: { kind: 'dataset', name: 'Orders', note: 'chart app-computed' }, ...more });
const THREAD = { id: T, title: 'Data model test', updatedAt: NOW, turnCount: 2 };
const READY = { ready: true, models: [], mine: null, copilotEnabled: true, keyStore: null };
const NO_MODEL = { ready: false, reason: 'no_model', models: [], mine: null, copilotEnabled: true, keyStore: null };

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor', questions: VerifiedRow[] = [row(V1, 'Revenue by region'), row(E, 'Sales by state')]) {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'catalog:instructions': body({ ok: true, instructions: [] }),
    'verified:list': body({ ok: true, broken: 0, questions }),
    'ai:status': body(READY),
    'copilot:threads': body({ ok: true, threads: [] }),
    'answer:card': body(CARD),
    ...routes,
  });
}
const history = (turns: unknown[]) => ({ 'copilot:threads': { body: { ok: true, threads: [THREAD] } }, 'copilot:history': { body: { ok: true, turns, threadId: T, title: 'Data model test' } } });
const section = () => screen.findByRole('region', { name: 'Try a question' }, LAZY);
const names = (calls: { channel: string }[]) => calls.map((c) => c.channel).filter((c) => c.startsWith('copilot:'));

describe('The Data model: the test chat', () => {
  it('an editor sees it empty, and opening the tab writes nothing', async () => {
    const calls = serve();
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    expect(await within(s).findByText(/Ask the way your team does/)).toBeTruthy();
    await waitFor(() => expect((within(s).getByRole('textbox', { name: 'Question to try' }) as HTMLTextAreaElement).disabled).toBe(false));
    expect(names(calls)).toEqual(['copilot:threads']);
    expect(calls.filter((c) => c.channel === 'verified:list')).toHaveLength(1); // the chat reads the list above, it does not ask again
  }, 30_000);

  it('the first ask makes the thread, names it, then asks in it', async () => {
    let made = false;
    const calls = serve({
      'copilot:threads': () => ({ body: { ok: true, threads: made ? [THREAD] : [] } }),
      'copilot:newThread': { body: { ok: true, thread: { id: T } } },
      'copilot:renameThread': () => { made = true; return { body: { ok: true } }; },
      'copilot:ask': { body: { ok: true, answer: 'x', threadId: T, turns: [user('u1', 'revenue by region'), bot('a1', 'West leads.', { guidance: { verifiedId: V1, instructions: 0, examples: [] } })] } },
    });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    fireEvent.change(await within(s).findByRole('textbox', { name: 'Question to try' }), { target: { value: 'revenue by region' } });
    fireEvent.click(within(s).getByRole('button', { name: 'Ask' }));
    expect(await within(s).findByText('A verified question — no model call.')).toBeTruthy();
    const mine = calls.filter((c) => ['copilot:newThread', 'copilot:renameThread', 'copilot:ask'].includes(c.channel));
    expect(mine.map((c) => c.channel)).toEqual(['copilot:newThread', 'copilot:renameThread', 'copilot:ask']);
    expect(mine[1].payload).toEqual({ projectId: P, threadId: T, title: 'Data model test' });
    expect(mine[2].payload).toMatchObject({ projectId: P, threadId: T, question: 'revenue by region', context: { kind: '' } });
  }, 30_000);

  it('an existing thread of that title is reused: no newThread', async () => {
    const calls = serve({
      ...history([user('u1', 'revenue by region'), bot('a1', 'West leads.')]),
      'copilot:ask': { body: { ok: true, answer: 'x', threadId: T, turns: [] } },
    });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    await within(s).findByText('West leads.');
    fireEvent.change(within(s).getByRole('textbox', { name: 'Question to try' }), { target: { value: 'again' } });
    fireEvent.click(within(s).getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'copilot:ask')).toBe(true));
    expect(calls.some((c) => c.channel === 'copilot:newThread')).toBe(false);
    expect(calls.find((c) => c.channel === 'copilot:ask')?.payload).toMatchObject({ threadId: T });
  }, 30_000);

  it('a verified turn says so, with the question; the spec is in words and its JSON is folded', async () => {
    serve(history([user('u1', 'revenue by region'), bot('a1', 'West leads.', { guidance: { verifiedId: V1, instructions: 0, examples: [] } })]));
    renderApp(`/model/${P}?tab=assistant`);
    const how = await screen.findByTestId('how-answered', {}, LAZY);
    expect(within(how).getByText('A verified question — no model call.')).toBeTruthy();
    expect(within(how).getByText('Revenue by region')).toBeTruthy();
    expect(how.textContent).toContain('Spec: Orders · sum of net_amount by region');
    const json = how.querySelector('details') as HTMLDetailsElement;
    expect(json.open).toBe(false);
    expect(json.textContent).toContain('"category": "region"');
  }, 30_000);

  it('a verified turn a model narrated says so, not "no model call"', async () => {
    serve(history([user('u1', 'revenue by region'), bot('a1', 'West leads.', { guidance: { verifiedId: V1, instructions: 0, examples: [], narrated: true } })]));
    renderApp(`/model/${P}?tab=assistant`);
    const how = await screen.findByTestId('how-answered', {}, LAZY);
    expect(within(how).getByText('A verified question — the app drew it; a model only wrote the words.')).toBeTruthy();
    expect(how.textContent).not.toContain('no model call');
  }, 30_000);

  it('a removed verified question reads "since removed"', async () => {
    serve(history([user('u1', 'x'), bot('a1', 'y', { guidance: { verifiedId: '9c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', instructions: 0, examples: [] } })]));
    renderApp(`/model/${P}?tab=assistant`);
    expect((await screen.findByTestId('how-answered', {}, LAZY)).textContent).toContain('a verified question since removed');
  }, 30_000);

  it('a model turn says how many instructions and which examples it had', async () => {
    serve(history([user('u1', 'sales by state'), bot('a1', 'Fine.', { guidance: { instructions: 3, examples: [E] } })]));
    renderApp(`/model/${P}?tab=assistant`);
    const how = await screen.findByTestId('how-answered', {}, LAZY);
    expect(within(how).getByText('The model, with 3 instructions and 1 verified example.')).toBeTruthy();
    expect(within(how).getByText('Sales by state')).toBeTruthy();
  }, 30_000);

  it('a turn with no guidance (a chip, a follow-up, an older turn) says nothing about how, and still has its spec', async () => {
    serve(history([user('u1', 'Split'), bot('a1', 'Fine.')]));
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    await within(s).findByText('Fine.');
    expect(within(s).queryByText(/no model call|The model, with/)).toBeNull();
    expect(s.textContent).toContain('Spec: Orders · sum of net_amount by region');
    expect(await within(s).findByRole('button', { name: 'Save as verified' })).toBeTruthy(); // the card's, with the question before it
  }, 30_000);

  it('NEGATIVE CONTROL: a viewer sees no test chat and makes no copilot: call', async () => {
    const calls = serve({}, 'viewer');
    renderApp(`/model/${P}?tab=assistant`);
    await screen.findByRole('region', { name: 'Verified questions' }, LAZY);
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    expect(screen.queryByRole('region', { name: 'Try a question' })).toBeNull();
    expect(names(calls)).toEqual([]);
  }, 30_000);

  it('a question the app cannot answer without a model keeps its text and says to connect one', async () => {
    serve({ 'copilot:newThread': { body: { ok: true, thread: { id: T } } }, 'copilot:renameThread': { body: { ok: true } }, 'copilot:ask': { body: { ok: false, notReady: true } } });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    const box = (await within(s).findByRole('textbox', { name: 'Question to try' })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'profit by state' } });
    fireEvent.click(within(s).getByRole('button', { name: 'Ask' }));
    expect(await within(s).findByText('Connect a model to ask anything else.')).toBeTruthy();
    expect(box.value).toBe('profit by state');
  }, 30_000);

  it('with no model and no working verified question the box is off and says why', async () => {
    serve({ 'ai:status': { body: NO_MODEL } }, 'editor', []);
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    expect(await within(s).findByText('Connect a model to try questions.')).toBeTruthy();
    expect((within(s).getByRole('textbox', { name: 'Question to try' }) as HTMLTextAreaElement).disabled).toBe(true);
  }, 30_000);
});

describe('specWords', () => {
  const base = { datasetId: D, category: 'region', measures: [{ column: 'net_amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 't' };
  it('names the dataset, the measures, the split, a period and the top N', () => {
    expect(specWords({ ...base, series: 'channel', top: 5, filters: [{ column: 'order_date', period: 'last_quarter' }] }, 'Orders'))
      .toBe('Orders · sum of net_amount by region · split by channel · order_date last quarter · top 5');
  });
  it('words measures and filters: several measures, a year back, in, a comparison, a value-free op', () => {
    expect(specWords({ ...base, measures: [{ column: 'units', aggregation: 'avg' }, { column: 'id', aggregation: 'count' }], filters: [
      { column: 'order_date', period: 'last_year', yearsBack: 2 },
      { column: 'region', op: 'in', values: ['West', 'East'] },
      { column: 'amount', op: '>=', value: 10 },
      { column: 'note', op: 'is_empty' },
    ] }, 'Orders')).toBe('Orders · average of units, count of id by region · order_date last year, 2 years back · region in West, East · amount >= 10 · note is empty');
  });
  it('a term reads as its name when known, else "a glossary term"', () => {
    const spec = { ...base, filters: [{ term: 'T1' }] };
    expect(specWords(spec, 'Orders', { T1: 'EMEA' })).toBe('Orders · sum of net_amount by region · EMEA');
    expect(specWords(spec, 'Orders')).toBe('Orders · sum of net_amount by region · a glossary term');
  });
  it('NEGATIVE CONTROL: a spec with nothing in it still gives the dataset, and never throws', () => {
    expect(specWords({}, 'Orders')).toBe('Orders');
    expect(specWords({ filters: 7, measures: [null] }, 'Orders')).toBe('Orders');
  });
});
