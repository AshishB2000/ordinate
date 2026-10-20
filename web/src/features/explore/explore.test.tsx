// Explore (docs/explore/00-design.md), the whole app through the router with
// canned replies: who is offered what, the question in the URL (and Back), the
// states a figure can come back in, the AI hand-off, and that every figure on
// the page is asked of `visual:data` — the door item 5's row policy covers.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { decodeQuestion, encodeQuestion, type Question } from './spec';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const ME = { user: { email: 'dev@local', role: 'viewer' }, org: 'default', mode: 'header', canSignOut: false };
const SENTENCE = 'This is a Live dataset — this isn’t available on Live yet. Make a copy to use it.';
const BY_REGION = { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' as const }] };
const BY_MONTH = { category: 'order_date', grain: 'month', values: [{ column: 'revenue', aggregation: 'sum' as const }] };
const SUGGEST = {
  ok: true,
  dimensions: [{ name: 'region', type: 'text' }, { name: 'segment', type: 'text' }],
  dates: [{ name: 'order_date' }],
  measures: [{ name: 'revenue', aggregation: 'sum' }, { name: 'discount', aggregation: 'avg' }],
  suggestions: [{ chartType: 'column', encoding: BY_REGION }, { chartType: 'line', encoding: BY_MONTH }],
};
/** The server's answer: figures it computed, which the page must show as they came. */
const ANSWER = { ok: true, data: { labels: ['East', 'West'], series: [{ name: 'sum of revenue', values: [1406441.74, 1565150.46] }] }, recommendedShape: 'categorical', warnings: [] };

/** The read channels this page may send — the shell's and Explore's own. Anything else fails the test. */
const READS = new Set(['projects:overview', 'projects:roles', 'ai:status', 'dataset:list', 'explore:suggest', 'visual:data', 'visual:dataBatch', 'format:colors:get', 'onboarding:get', 'alerts:events', 'jobs:list', 'prefs:get', 'period:picker']);
/** Channels that compute a figure: Explore uses only the two that run vizDataFor. */
const FIGURES = new Set(['visual:data', 'visual:dataBatch']);

function serve(role: 'viewer' | 'editor', extra: Record<string, RpcReply> = {}) {
  return serveRpc({
    '/api/auth/me': { body: ME },
    'projects:overview': { body: [{ id: PID, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] },
    'projects:roles': { body: { [PID]: role } },
    'ai:status': { body: { ready: false, models: [], mine: null, keyStore: null } },
    'dataset:list': { body: [{ id: DID, name: 'Retail orders', sourceKind: 'csv', rowCount: 5000, columnCount: 5, updatedAt: '' }] },
    'explore:suggest': { body: SUGGEST },
    'visual:data': { body: ANSWER },
    'visual:dataBatch': (p) => ({ body: ((p as { items: unknown[] }).items ?? []).map(() => ANSWER) }),
    ...extra,
  });
}

const url = (q?: Question) => `/explore?project=${PID}&dataset=${DID}${q ? `&q=${encodeQuestion(q)}` : ''}`;
const REGION_Q: Question = { chartType: 'column', encoding: BY_REGION, filters: [] };
const answerTitle = () => screen.findByRole('heading', { level: 2, name: 'Total revenue by region' });

describe('Explore: who is offered what', () => {
  it('a viewer asks, reads and shares — and is offered neither Save as visual nor Open in the builder', async () => {
    const calls = serve('viewer');
    renderApp(url(REGION_Q));
    await answerTitle();
    const table = await screen.findByRole('table', { name: 'Total revenue by region, as a table' });
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    // The server's figures, formatted, never recomputed.
    expect(within(table).getByText('1,406,441.74')).toBeTruthy();
    expect(within(table).getByText('1,565,150.46')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Group by: region/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Save as visual' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open in the builder' })).toBeNull();
  });

  it('CONTROL: an editor is offered both, once the roles arrive', async () => {
    serve('editor');
    renderApp(url(REGION_Q));
    await answerTitle();
    expect(await screen.findByRole('button', { name: 'Save as visual' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open in the builder' })).toBeTruthy();
  });

  it('no dataset: a viewer reads who can bring data in (CONTROL: an editor gets the import door)', async () => {
    serve('viewer', { 'dataset:list': { body: [] } });
    renderApp(`/explore?project=${PID}`);
    expect(await screen.findByText('An editor of this project can bring in data. You have view-only access.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Import data' })).toBeNull();
  });

  it('CONTROL: no dataset, as an editor: Import data and Connect a database', async () => {
    serve('editor', { 'dataset:list': { body: [] } });
    renderApp(`/explore?project=${PID}`);
    expect(await screen.findByRole('link', { name: 'Import data' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect a database' })).toBeTruthy();
    expect(screen.queryByText(/You have view-only access/)).toBeNull();
  });
});

describe('Explore: the question is the URL', () => {
  it('a suggestion becomes the question in the URL; a field click is a new URL; Back restores the last question', async () => {
    serve('viewer');
    const router = renderApp(url());
    const card = await screen.findByRole('button', { name: /^Total revenue by region/ });
    fireEvent.click(card);
    await answerTitle();
    const first = decodeQuestion(new URLSearchParams(router.state.location.search).get('q'));
    expect(first).toEqual(REGION_Q);
    expect(new URLSearchParams(router.state.location.search).get('dataset')).toBe(DID);

    fireEvent.click(within(screen.getByRole('complementary', { name: 'Fields' })).getByRole('button', { name: 'segment' }));
    await screen.findByRole('heading', { level: 2, name: 'Total revenue by segment' });
    expect(decodeQuestion(new URLSearchParams(router.state.location.search).get('q'))?.encoding.category).toBe('segment');

    await act(() => router.navigate(-1));
    await answerTitle();
    expect(decodeQuestion(new URLSearchParams(router.state.location.search).get('q'))).toEqual(REGION_Q);
  });

  it('a link’s chart type is checked too: one the picker does not offer draws the first that suits (CONTROL: a real one is kept)', async () => {
    serve('viewer');
    renderApp(url({ ...REGION_Q, chartType: '<img src=x>' }));
    await answerTitle();
    expect((await screen.findByRole('radio', { name: /^Column$/ })).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('<img src=x>')).toBeNull();
  });

  it('CONTROL: a chart type the picker offers is kept from the link', async () => {
    serve('viewer');
    renderApp(url({ ...REGION_Q, chartType: 'bar' }));
    await answerTitle();
    expect((await screen.findByRole('radio', { name: /^Bar$/ })).getAttribute('aria-checked')).toBe('true');
  });

  it('a link with a question that is not one opens on the suggestions, asking nothing of it', async () => {
    const calls = serve('viewer');
    renderApp(`/explore?project=${PID}&dataset=${DID}&q=not-a-question`);
    expect(await screen.findByRole('heading', { name: 'Start with a question' })).toBeTruthy();
    expect(calls.some((c) => c.channel === 'visual:data')).toBe(false); // the thumbnails go out as one batch
  });
});

describe('Explore: what a figure can come back as', () => {
  it('a Live refusal renders <LiveRefusal> with the server’s sentence, and no retry', async () => {
    serve('viewer', { 'visual:data': { body: { ok: false, code: 'live_refused', error: SENTENCE, reason: 'pivot' } } });
    renderApp(url(REGION_Q));
    expect(await screen.findByRole('heading', { name: 'Off for this Live dataset' })).toBeTruthy();
    expect(screen.getByText(SENTENCE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('CONTROL: an ordinary failure is an error with Try again', async () => {
    serve('viewer', { 'visual:data': { body: { ok: false, error: 'That column is gone.' } } });
    renderApp(url(REGION_Q));
    expect(await screen.findByRole('heading', { name: 'This question could not be answered' })).toBeTruthy();
    expect(screen.getByText('That column is gone.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Off for this Live dataset' })).toBeNull();
  });

  it('an empty answer says so, and offers to clear the filters', async () => {
    serve('viewer', { 'visual:data': { body: { ...ANSWER, data: { labels: [], series: [] } } } });
    renderApp(url({ ...REGION_Q, filters: [{ type: 'filter', column: 'region', op: '=', value: 'Mars' }] }));
    expect(await screen.findByRole('heading', { name: 'No rows match this question' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });
});

describe('Explore: the AI hand-off', () => {
  it('without a model there is no ask box at all', async () => {
    serve('viewer');
    renderApp(url(REGION_Q));
    await answerTitle();
    expect(screen.queryByRole('textbox', { name: 'Ask in your own words' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Ask the Assistant' })).toBeNull();
  });

  it('CONTROL: with a model ready the box shows, and the words go to the Assistant in this project', async () => {
    serve('viewer', { 'ai:status': { body: { ready: true, models: [], mine: null, keyStore: null } } });
    renderApp(url(REGION_Q));
    const box = await screen.findByRole('textbox', { name: 'Ask in your own words' });
    fireEvent.change(box, { target: { value: 'why is the West ahead?' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Ask the Assistant' }));
    await waitFor(() => expect(localStorage.getItem('ordinate.dock')).toBe('1'));
    expect(localStorage.getItem('ordinate.dockProject')).toBe(PID);
  });
});

describe('Explore: every figure is asked of visual:data', () => {
  it('the suggestions and the answer: only read channels, and only the two figure doors that run vizDataFor', async () => {
    const calls = serve('viewer');
    renderApp(url());
    fireEvent.click(await screen.findByRole('button', { name: /^Total revenue by region/ }));
    await screen.findByRole('table', { name: 'Total revenue by region, as a table' });
    const channels = [...new Set(calls.map((c) => c.channel))];
    expect(channels.filter((c) => !READS.has(c))).toEqual([]);
    expect(channels.filter((c) => FIGURES.has(c)).length).toBeGreaterThan(0);
    // The thumbnails left in one batch, each item exactly a suggestion's question.
    const batch = calls.find((c) => c.channel === 'visual:dataBatch')?.payload as { items: { encoding: unknown; filters: unknown[] }[] } | undefined;
    expect(batch?.items.map((i) => i.encoding)).toEqual([BY_REGION, BY_MONTH]);
  });
});
