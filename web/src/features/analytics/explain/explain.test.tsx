import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { appRoutes } from '../../../app/routes';
import type { ChartHandle } from '../../../charts/Chart';
import { ExplainPanel, type ExplainTarget } from './ExplainPanel';
import { PointMenu } from './PointMenu';
import { pointAt } from './pointAt';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };

type Reply = { status?: number; body?: unknown };
type Sent = { channel: string; payload: Record<string, unknown> };

/** Stubs fetch per channel; a route may be a function of the payload. Returns every RPC sent, with its payload. */
function serve(routes: Record<string, Reply | ((payload: Record<string, unknown>) => Reply)>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const rpc = path.startsWith('/api/rpc/');
      const channel = rpc ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = rpc && typeof init?.body === 'string' ? ((JSON.parse(init.body) as { args?: Record<string, unknown>[] }).args?.[0] ?? {}) : {};
      if (rpc) sent.push({ channel, payload });
      const route = routes[channel];
      const r = typeof route === 'function' ? route(payload) : (route ?? { body: [] });
      return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
    }),
  );
  return sent;
}

const SPEC = {
  datasetId: DID,
  metric: { column: 'revenue', aggregation: 'sum', label: 'Sum of revenue' },
  filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }],
  compare: { mode: 'bucket', column: 'day', label: '2025-03', prev: '2025-02', grain: 'month' },
  path: [],
  dimension: 'product',
};
const SENTENCE = 'Sum of revenue fell 18% in Mar 2025 vs Feb 2025 (from 1K to 820)';
const step = (key: string, delta: number, from: number, to: number) => ({ key, label: key, delta, deltaText: `−${Math.abs(delta)}`, share: 50, moveShare: 50, from, to });
/** A drivers answer as the server writes it: every figure and sentence already there. */
const result = (over: Record<string, unknown> = {}) => ({
  ok: true,
  token: 't',
  metric: { name: 'Sum of revenue', kind: 'additive' },
  periods: { a: 'Mar 2025', b: 'Feb 2025', column: 'day' },
  totals: { delta: -180, pct: -18, aText: '820', bText: '1K', deltaText: '−180' },
  dimensions: [
    { column: 'product', explained: 0.9, memberCount: 2, lead: 'Desks' },
    { column: 'channel', explained: 0.2, memberCount: 3, lead: 'Web' },
  ],
  selected: {
    column: 'product',
    offsetting: false,
    waterfall: { start: 1000, end: 820, startText: '1K', endText: '820', steps: [step('Desks', -130, 1000, 870), step('Chairs', -50, 870, 820)], other: { delta: 0, deltaText: '0', count: 0, from: 820, to: 820 } },
  },
  headline: 'Sum of revenue fell 180',
  sentence: SENTENCE,
  caption: 'Sum of revenue fell 180; Desks explains 72%.',
  path: [],
  alert: null,
  spec: SPEC,
  ...over,
});
const PERIODS = [
  { label: '2024-03', text: 'Mar 2024' },
  { label: '2025-02', text: 'Feb 2025' },
  { label: '2025-03', text: 'Mar 2025' },
];
const answer = (over: Record<string, unknown> = {}) => ({
  ok: true,
  bucket: '2025-03',
  baseline: '2025-02',
  periods: PERIODS,
  baselines: [
    { label: '2025-02', text: 'Feb 2025 · previous period', kind: 'previous' },
    { label: '2024-03', text: 'Mar 2024 · same period last year', kind: 'year' },
  ],
  result: result(),
  ...over,
});

const target = (over: Partial<ExplainTarget> = {}): ExplainTarget => ({
  name: 'Revenue by month',
  projectId: PID,
  datasetId: DID,
  encoding: { category: 'day', values: [{ column: 'revenue', aggregation: 'sum' }], grain: 'month' },
  filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }],
  params: [],
  point: { bucket: '2025-03', series: 'West' },
  readOnly: false,
  ...over,
});

function show(t: ExplainTarget, onClose = vi.fn()) {
  const router = createMemoryRouter([{ path: '*', element: <ExplainPanel target={t} onClose={onClose} /> }], { initialEntries: ['/'] });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, onClose };
}

describe('ExplainPanel', () => {
  it('shows the server’s sentence, periods and breakdown from ONE call, and sends only what was pointed at', async () => {
    const sent = serve({ 'drivers:explainPoint': { body: answer() } });
    show(target());
    // Loading first: the designed skeleton, not a blank.
    expect(screen.getByRole('status', { name: 'Explaining the change' })).toBeTruthy();
    const panel = await screen.findByRole('dialog', { name: 'Explain a change · Revenue by month' });
    expect(await within(panel).findByRole('heading', { name: SENTENCE })).toBeTruthy();
    // The pickers read the server's words for the server's labels.
    expect(within(panel).getByRole('combobox', { name: 'Period' }).textContent).toContain('Mar 2025');
    expect(within(panel).getByRole('combobox', { name: 'Compared with' }).textContent).toContain('Feb 2025 · previous period');
    // Dimensions ranked, contributors as bars, the actions.
    expect(within(panel).getByRole('button', { name: 'product: explains 90% of the change' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(within(panel).getByRole('list', { name: 'Waterfall of contributors' })).getAllByRole('listitem')).toHaveLength(4);
    expect(within(panel).getByRole('button', { name: 'Add as a waterfall tile' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Open in Analytics' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Ask the Assistant' })).toBeTruthy();
    // One call: the answer came with the question, so DriversView never asks drivers:explain.
    expect(sent.map((s) => s.channel)).toEqual(['drivers:explainPoint']);
    // …and it carried the tile and the point — no period arithmetic, no figure.
    expect(sent[0].payload).toEqual({
      projectId: PID,
      datasetId: DID,
      encoding: target().encoding,
      filters: target().filters,
      params: [],
      point: { bucket: '2025-03', series: 'West' },
    });
  });

  it('opened from the tile menu it names no bucket: the server picks the latest', async () => {
    const sent = serve({ 'drivers:explainPoint': { body: answer() } });
    show(target({ point: {} }));
    await screen.findByRole('heading', { name: SENTENCE });
    expect(sent[0].payload.point).toEqual({});
  });

  it('switching the baseline sends back the label the server listed, and shows the new answer', async () => {
    const yearSentence = 'Sum of revenue fell 8.9% in Mar 2025 vs Mar 2024 (from 900 to 820)';
    const year = result({ sentence: yearSentence, spec: { ...SPEC, compare: { ...SPEC.compare, prev: '2024-03' } }, periods: { a: 'Mar 2025', b: 'Mar 2024', column: 'day' } });
    const sent = serve({
      'drivers:explainPoint': (p) => ({ body: (p.point as { baseline?: string }).baseline === '2024-03' ? answer({ baseline: '2024-03', result: year }) : answer() }),
    });
    show(target());
    await screen.findByRole('heading', { name: SENTENCE });
    fireEvent.click(screen.getByRole('combobox', { name: 'Compared with' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Mar 2024 · same period last year' }));
    expect(await screen.findByRole('heading', { name: yearSentence })).toBeTruthy();
    expect(sent.at(-1)?.payload.point).toEqual({ bucket: '2025-03', series: 'West', baseline: '2024-03' });
    expect(sent.every((s) => s.channel === 'drivers:explainPoint')).toBe(true);
  });

  it('a viewer’s panel offers nothing that saves', async () => {
    serve({ 'drivers:explainPoint': { body: answer() } });
    show(target({ readOnly: true }));
    await screen.findByRole('heading', { name: SENTENCE });
    expect(screen.queryByRole('button', { name: 'Add as a waterfall tile' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open in Analytics' })).toBeTruthy();
  });

  it('a refusal is the server’s sentence, with the period picker still there to choose another', async () => {
    const sentence = 'Mar 2024 is the first period on this chart, so there is nothing before it to compare with. Choose a later period.';
    const sent = serve({
      'drivers:explainPoint': (p) => ({ body: (p.point as { bucket?: string }).bucket === '2024-03' ? { ok: false, code: 'first_bucket', error: sentence, bucket: '2024-03', periods: PERIODS } : answer() }),
    });
    show(target({ point: { bucket: '2024-03' } }));
    expect(await screen.findByRole('heading', { name: 'This change can’t be explained' })).toBeTruthy();
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Waterfall of contributors' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Compared with' }).hasAttribute('disabled')).toBe(true);
    // The way out: another period.
    fireEvent.click(screen.getByRole('combobox', { name: 'Period' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Mar 2025' }));
    expect(await screen.findByRole('heading', { name: SENTENCE })).toBeTruthy();
    expect(sent.at(-1)?.payload.point).toEqual({ bucket: '2025-03' });
  });

  it('a refusal with no periods (not a chart over time) is still a sentence, never an empty panel', async () => {
    const sentence = 'A change is explained between two periods, so this needs a chart with a date on its axis.';
    serve({ 'drivers:explainPoint': { body: { ok: false, code: 'not_time_series', error: sentence } } });
    show(target({ point: {} }));
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Period' })).toBeNull();
  });

  it('a Live dataset shows the typed refusal with "Make a copy", not a retry', async () => {
    const sentence = 'Key drivers cannot be worked out from a live dataset yet.';
    serve({ 'drivers:explainPoint': { body: { ok: false, code: 'live_refused', reason: 'drivers', error: sentence } }, '/api/auth/me': { body: ME }, 'projects:roles': { body: { [PID]: 'admin' } } });
    show(target());
    expect(await screen.findByRole('heading', { name: 'Off for this Live dataset' })).toBeTruthy();
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make a copy' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a failed call is an error with a retry', async () => {
    let fail = true;
    const sent = serve({ 'drivers:explainPoint': () => (fail ? { status: 500, body: { error: 'internal', message: 'The server could not answer.' } } : { body: answer() }) });
    show(target());
    expect(await screen.findByRole('heading', { name: 'This change could not be explained' })).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: SENTENCE })).toBeTruthy();
    expect(sent).toHaveLength(2);
  });

  it('"Open in Analytics" hands the server’s question to the workbench in router state, never the URL', async () => {
    serve({ 'drivers:explainPoint': { body: answer() } });
    const { router } = show(target());
    await screen.findByRole('heading', { name: SENTENCE });
    fireEvent.click(screen.getByRole('button', { name: 'Open in Analytics' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/analytics/${PID}/${DID}/drivers`));
    expect(router.state.location.search).toBe('');
    expect(router.state.location.state).toEqual({ request: SPEC });
  });
});

describe('the workbench, opened with a handed question', () => {
  it('asks the handed question as it is, says where it came from, and goes back to its own on request', async () => {
    const sent = serve({
      '/api/auth/me': { body: ME },
      'projects:overview': { body: [{ id: PID, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] },
      'projects:roles': { body: { [PID]: 'admin' } },
      'dataset:columns': { body: { id: DID, name: 'Orders', rowCount: 120, columns: [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }] } },
      'dataset:list': { body: [{ id: DID, name: 'Orders', sourceKind: 'csv', rowCount: 120, columnCount: 3, updatedAt: '' }] },
      'drivers:explain': (p) => ({ body: result({ spec: p.request }) }),
    });
    const router = createMemoryRouter(appRoutes(), { initialEntries: [{ pathname: `/analytics/${PID}/${DID}/drivers`, state: { request: SPEC } }] });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: SENTENCE })).toBeTruthy();
    const asked = () => sent.filter((s) => s.channel === 'drivers:explain');
    expect(asked()[0].payload.request).toEqual(SPEC);
    expect(screen.getByRole('note').textContent).toContain('the change you opened from a chart');
    fireEvent.click(screen.getByRole('button', { name: 'Compare the latest two periods instead' }));
    await waitFor(() => expect((asked().at(-1)?.payload.request as { compare?: { mode?: string } } | undefined)?.compare?.mode).toBe('latest'));
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('PointMenu', () => {
  it('opens at the point with the caller’s items, runs one and closes', () => {
    const onExplain = vi.fn();
    const onClose = vi.fn();
    render(<PointMenu at={{ x: 120, y: 80 }} label="Chart point actions" items={[{ label: 'Explain this change', icon: 'activity', onSelect: onExplain }]} onClose={onClose} />);
    const menu = screen.getByRole('menu', { name: 'Chart point actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Explain this change' }));
    expect(onExplain).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes it without running anything', () => {
    const onExplain = vi.fn();
    const onClose = vi.fn();
    render(<PointMenu at={{ x: 1, y: 1 }} label="Chart point actions" items={[{ label: 'Explain this change', onSelect: onExplain }]} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(onExplain).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: with no point there is no menu', () => {
    render(<PointMenu at={null} label="Chart point actions" items={[{ label: 'Explain this change', onSelect: vi.fn() }]} onClose={vi.fn()} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('pointAt', () => {
  /** A drawn chart: its labels and datasets, and what a hit-test at the event returns (exact, then nearest). */
  const chart = (labels: string[], sets: string[], exact: { index: number; datasetIndex: number }[], nearest: { index: number; datasetIndex: number }[] = [], type = 'bar') =>
    ({
      config: { type },
      data: { labels, datasets: sets.map((label) => ({ label })) },
      getElementsAtEventForMode: (_e: unknown, _mode: string, opts: { intersect: boolean }) => (opts.intersect ? exact : nearest),
    }) as unknown as ChartHandle;
  const ev = new MouseEvent('contextmenu');

  it('names the bucket by the SERVER’s label, not the drawn one (a first-of-month axis is rewritten for display)', () => {
    const server = ['2025-01-01', '2025-02-01', '2025-03-01'];
    const drawn = chart(['Jan 2025', 'Feb 2025', 'Mar 2025'], ['Revenue'], [{ index: 1, datasetIndex: 0 }]);
    // jsdom's locale may print the month differently; the lookup goes through the same rewrite the chart used.
    const c = drawn as unknown as { data: { labels: string[] } };
    c.data.labels = server.map((l) => new Date(l + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }));
    expect(pointAt(drawn, ev, server)).toEqual({ bucket: '2025-02-01' });
  });

  it('follows a re-sorted axis: the drawn position is not the server’s', () => {
    const drawn = chart(['2025-03', '2025-01', '2025-02'], ['Revenue'], [{ index: 0, datasetIndex: 0 }]);
    expect(pointAt(drawn, ev, ['2025-01', '2025-02', '2025-03'])).toEqual({ bucket: '2025-03' });
  });

  it('carries the series only when the chart has several', () => {
    const drawn = chart(['2025-01', '2025-02'], ['West', 'East'], [{ index: 1, datasetIndex: 1 }]);
    expect(pointAt(drawn, ev, ['2025-01', '2025-02'])).toEqual({ bucket: '2025-02', series: 'East' });
  });

  it('off a mark but inside the plot: the nearest point', () => {
    const drawn = chart(['2025-01', '2025-02'], ['Revenue'], [], [{ index: 0, datasetIndex: 0 }]);
    expect(pointAt(drawn, ev, ['2025-01', '2025-02'])).toEqual({ bucket: '2025-01' });
  });

  it('a label the server never sent (a forecast) goes back as drawn, for the server to refuse', () => {
    const drawn = chart(['2025-01', '2025-02', '2025-03'], ['Revenue'], [{ index: 2, datasetIndex: 0 }]);
    expect(pointAt(drawn, ev, ['2025-01', '2025-02'])).toEqual({ bucket: '2025-03' });
  });

  it('NEGATIVE CONTROL: nothing under the pointer, or no chart, is no point', () => {
    expect(pointAt(chart(['2025-01'], ['Revenue'], [], []), ev, ['2025-01'])).toBeNull();
    expect(pointAt(null, ev, ['2025-01'])).toBeNull();
    // A heatmap's marks are not indexed by axis label: a hit there names no bucket.
    expect(pointAt(chart(['2025-01'], ['Revenue'], [{ index: 0, datasetIndex: 0 }], [], 'matrix'), ev, ['2025-01'])).toBeNull();
    expect(pointAt(chart(['2025-01'], ['Revenue'], [{ index: 0, datasetIndex: 0 }], [], 'line'), ev, ['2025-01'])).toEqual({ bucket: '2025-01' });
  });
});
