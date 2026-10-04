import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { renderApp } from '../../test-utils';
import { chipsOf, sparkGeometry } from './insights/InsightCard';
import {
  dropValue,
  encodingFromPivot,
  engineEncoding,
  engineName,
  engineNeeds,
  fitCohort,
  fitFunnel,
  fitPivot,
  pivotFromEncoding,
  sortSummary,
  switchEncoding,
  type Pivot,
} from './grids/gridEncoding';
import { PivotShelves } from './grids/PivotShelves';
import { collectParams, guessKind, ident, insertAt, referencedIds, scan, starter, type SchemaDataset } from './sql/sqlText';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };
const PROJECT = { id: PID, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false };
const COLS = [
  { name: 'customer_id', type: 'text' as const },
  { name: 'event', type: 'text' as const },
  { name: 'region', type: 'text' as const },
  { name: 'order_date', type: 'date' as const },
  { name: 'revenue', type: 'number' as const },
];

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });

function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      const r = routes[channel] ?? { body: [] };
      const out = typeof r === 'function' ? r(payload) : r;
      return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
    }),
  );
  return calls;
}

const base = (extra: Record<string, Reply> = {}) => ({
  '/api/auth/me': { body: ME },
  'projects:overview': { body: [PROJECT] },
  'projects:roles': { body: { [PID]: 'admin' } },
  'dataset:columns': { body: { id: DID, name: 'Orders', rowCount: 120, columns: COLS } },
  'dataset:list': { body: [{ id: DID, name: 'Orders', sourceKind: 'csv', rowCount: 120, columnCount: 5, updatedAt: '', originKind: 'sql' }] },
  'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
  'lineage:get': { body: null },
  'dataset:source': { body: { kind: 'sql', label: 'SQL', refreshable: true } },
  ...extra,
});

describe('grid encodings (pivotBuilder / cohortBuilder, pure)', () => {
  it('carries a chart encoding into a pivot and back, the calc axis swapped both ways', () => {
    const p = pivotFromEncoding({ category: 'region', series: 'event', values: [{ column: 'revenue', aggregation: 'none', calc: { kind: 'running_total', axis: 'across' } }] });
    expect(p.rows).toEqual([{ column: 'region' }]);
    expect(p.columns).toEqual([{ column: 'event' }]);
    expect(p.values).toEqual([{ column: 'revenue', aggregation: 'sum', calc: { kind: 'running_total', axis: 'down' } }]);
    expect(p.totals).toEqual({ rows: true, columns: true, grand: true });
    expect(encodingFromPivot({ ...p, rows: [{ column: 'order_date', grain: 'month' }, { column: 'region' }] })).toEqual({
      category: 'order_date',
      series: 'event',
      grain: 'month',
      values: [{ column: 'revenue', aggregation: 'sum', calc: { kind: 'running_total', axis: 'across' } }],
    });
  });
  it('a fresh pivot gets the first dimension and the first measure; a saved one keeps what still fits', () => {
    const fresh = fitPivot({}, COLS);
    expect(fresh.rows).toEqual([{ column: 'customer_id' }]);
    expect(fresh.values).toEqual([{ column: 'revenue', aggregation: 'sum' }]);
    const saved = fitPivot(
      { rows: [{ column: 'gone' }, { column: 'region' }], values: [{ column: 'revenue', aggregation: 'avg', showAs: 'pct_row' }], totals: { rows: false, columns: true, grand: false }, sort: { by: 0, dir: 'desc' }, topN: { n: 5.7 }, conditional: [{ valueIdx: 0, kind: 'threshold' }, { valueIdx: 4, kind: 'bars' }] },
      COLS,
    );
    expect(saved.rows).toEqual([{ column: 'region' }]);
    expect(saved.values[0]).toEqual({ column: 'revenue', aggregation: 'avg', showAs: 'pct_row' });
    expect(saved.totals).toEqual({ rows: false, columns: true, grand: false });
    expect(saved.sort).toEqual({ by: 0, dir: 'desc' });
    expect(saved.topN).toEqual({ n: 5, byValueIdx: 0 });
    expect(saved.conditional).toEqual([{ valueIdx: 0, kind: 'threshold', threshold: 0 }]);
  });
  it('removing a value shifts the formatting rules that point past it', () => {
    const p: Pivot = { ...fitPivot({}, COLS), values: [{ column: 'a', aggregation: 'sum' }, { column: 'b', aggregation: 'sum' }, { column: 'c', aggregation: 'sum' }], conditional: [{ valueIdx: 0, kind: 'scale' }, { valueIdx: 2, kind: 'bars' }] };
    expect(dropValue(p, 1).conditional).toEqual([{ valueIdx: 0, kind: 'scale' }, { valueIdx: 1, kind: 'bars' }]);
    expect(dropValue(dropValue(p, 0), 1).conditional).toBeUndefined();
  });
  it('switches the encoding only between families, and hands mirrored fields back', () => {
    const chart = { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' as const }] };
    expect(switchEncoding(chart, 'column', 'bar', COLS)).toBe(chart);
    const piv = switchEncoding(chart, 'column', 'pivot', COLS);
    expect(piv.pivot).toBeTruthy();
    expect(switchEncoding(piv, 'pivot', 'pivot', COLS)).toBe(piv);
    expect(switchEncoding(piv, 'pivot', 'column', COLS)).toEqual(chart);
    const coh = switchEncoding(chart, 'column', 'cohort', COLS);
    expect(coh).toEqual({ category: 'order_date', values: [{ column: 'customer_id', aggregation: 'count' }], cohort: { entity: 'customer_id', date: 'order_date', grain: 'month', show: 'retention', curve: false } });
    expect(switchEncoding(coh, 'cohort', 'line', COLS)).toEqual({ category: 'order_date', values: [{ column: 'customer_id', aggregation: 'count' }] });
  });
  it('guesses an entity and an event column, and says what a funnel still needs', () => {
    const f = fitFunnel(null, COLS);
    expect(f).toMatchObject({ entity: 'customer_id', event: 'event', time: 'order_date', steps: [], window: { n: 7, unit: 'days' } });
    const enc = engineEncoding('event_funnel', f);
    expect(engineNeeds('event_funnel', enc)).toBe('Add at least two steps before saving the funnel.');
    const done = engineEncoding('event_funnel', { ...f, steps: ['visit', 'cart', 'buy'] });
    expect(engineNeeds('event_funnel', done)).toBe('');
    expect(engineName('event_funnel', done)).toBe('Funnel: visit → buy');
    const c = fitCohort({ entity: 'customer_id', date: 'order_date', value: 'revenue', show: 'value', grain: 'week' }, COLS);
    expect(engineEncoding('cohort', c).values).toEqual([{ column: 'revenue', aggregation: 'sum' }]);
    expect(engineName('cohort', engineEncoding('cohort', c))).toBe('revenue per customer_id cohorts (weekly)');
    expect(fitCohort({ show: 'value' }, COLS).show).toBe('retention'); // no value column: retention
  });
  it('summarises the sort as the desktop did', () => {
    expect(sortSummary(undefined)).toBe('First seen');
    expect(sortSummary({ by: 'label', dir: 'desc' })).toBe('Row labels, descending');
    expect(sortSummary({ by: 1, dir: 'asc' })).toBe('Column 2, ascending');
  });
});

describe('SQL text helpers (queryEditor / queryParams, cosmetic)', () => {
  const schema: SchemaDataset[] = [
    { id: 'a', name: 'Retail orders', alias: 'Retail orders', slug: 'retail_orders', rowCount: 5, queryable: true, columns: [{ name: 'order id', type: 'text' }, { name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }] },
    { id: 'b', name: 'Targets', alias: null, slug: 'targets', rowCount: 2, queryable: true, columns: [] },
  ];
  it('finds parameters and names outside strings and comments', () => {
    const r = scan("select * from retail_orders where region = [[r]] and note = '[[not]]' -- [[nor]]\n and x = [[ r ]] and y = [[min_n]]");
    expect(r.params).toEqual(['r', 'min_n']);
    expect(r.names).toContain('retail_orders');
    expect(referencedIds('select * from targets join "Retail orders" using (x)', schema)).toEqual(['b', 'a']);
  });
  it('quotes a name only when DuckDB would not read it as written', () => {
    expect(ident('region')).toBe('region');
    expect(ident('order id')).toBe('"order id"');
    expect(ident('select')).toBe('"select"');
    expect(ident('a"b')).toBe('"a""b"');
  });
  it('collects typed parameters, names the first one missing, and keeps list elements text', () => {
    const state = new Map([
      ['r', { kind: 'text' as const, value: ' West ' }],
      ['ids', { kind: 'list' as const, value: '1, 2,,3' }],
    ]);
    expect(collectParams('[[r]] [[ids]]', state)).toEqual({ params: [{ name: 'r', kind: 'text', value: 'West' }, { name: 'ids', kind: 'list', value: ['1', '2', '3'] }], error: '' });
    expect(collectParams('[[since]]', new Map()).error).toBe('Give [[since]] a value in the parameters row.');
    expect(collectParams('[[n]]', new Map([['n', { kind: 'number' as const, value: '12' }]])).params).toEqual([{ name: 'n', kind: 'number', value: 12 }]);
    expect([guessKind('start_date'), guessKind('max_units'), guessKind('regions'), guessKind('r')]).toEqual(['date', 'number', 'list', 'text']);
  });
  it('inserts a name spaced so it never runs into a word, and suggests a starter from real columns', () => {
    expect(insertAt('select from', 6, 6, 'x')).toEqual({ value: 'select x from', caret: 8 });
    expect(insertAt('f(', 2, 2, 'x')).toEqual({ value: 'f(x', caret: 3 });
    expect(starter(schema)).toBe('select region, sum(revenue) as revenue\nfrom retail_orders\ngroup by 1\norder by 2 desc');
    expect(starter([])).toBe('select * from …');
  });
});

describe('insight chips', () => {
  it('prints the first three numeric facts as written for reading, never derived', () => {
    expect(chipsOf({ facts: { prev: 1200, now: 1500.5, pctChange: 0.25, total: 9, title: 'x' } })).toEqual([
      { label: 'prev', value: '1,200' },
      { label: 'now', value: '1,500.5' },
      { label: 'change', value: '25.0%' },
    ]);
    expect(chipsOf({ facts: { share: 0.123, total: Number.NaN } })).toEqual([{ label: 'share', value: '12.3%' }]);
  });
});

describe('the sparkline', () => {
  it('draws the first series that carries numbers, as given — a gap stays a gap', () => {
    const g = sparkGeometry({ series: [{ name: 'empty', values: [null, null] }, { name: 'rev', values: [3, null, 7.5, -1] }] } as never);
    expect(g).toEqual({ values: [3, null, 7.5, -1], min: -1, max: 7.5 });
    expect(sparkGeometry({ series: [] } as never)).toBeNull();
  });
});

describe('the pivot shelves', () => {
  function Host({ onPivot }: { onPivot: (p: Pivot) => void }) {
    const [p, setP] = useState<Pivot>(fitPivot({}, COLS));
    return (
      <PivotShelves
        projectId={PID}
        cols={COLS}
        pivot={p}
        onChange={(n) => {
          setP(n);
          onPivot(n);
        }}
      />
    );
  }
  const mount = (onPivot: (p: Pivot) => void) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <Host onPivot={onPivot} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  const M1 = '66666666-6666-4666-8666-666666666666';
  const M2 = '77777777-7777-4777-8777-777777777777';
  const metricsRoutes = {
    'metric:list': {
      body: {
        ok: true,
        metrics: [
          { id: M1, name: 'Margin %', datasetId: DID, datasetName: 'Orders', definition: { formula: '[Profit] / [Revenue]' }, definitionText: 'Profit ÷ Revenue', format: { kind: 'percent' }, updatedAt: '' },
          { id: M2, name: 'Total revenue', datasetId: DID, datasetName: 'Orders', definition: { column: 'revenue', aggregation: 'avg' }, definitionText: 'Average of revenue', format: { kind: 'currency' }, updatedAt: '' },
        ],
      },
    },
    'metric:values': { body: [{ id: M1, ok: true, display: '12.5%' }, { id: M2, ok: true, display: '$1.2K' }] },
  };
  it('adds a dimension, sets a total and a formatting rule — the pivot it reports is what the server will fold', async () => {
    serve(metricsRoutes);
    const seen: Pivot[] = [];
    mount((p) => seen.push(p));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add a field to Columns' }), { button: 0, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'region' }));
    expect(seen.at(-1)?.columns).toEqual([{ column: 'region' }]);
    fireEvent.click(screen.getByLabelText('Grand total'));
    expect(seen.at(-1)?.totals.grand).toBe(false);
    fireEvent.click(screen.getByRole('combobox', { name: 'Conditional formatting for revenue' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Above / below' }));
    expect(seen.at(-1)?.conditional).toEqual([{ valueIdx: 0, kind: 'threshold', threshold: 0 }]);
    fireEvent.change(screen.getByLabelText('Threshold for revenue'), { target: { value: '250' } });
    expect(seen.at(-1)?.conditional).toEqual([{ valueIdx: 0, kind: 'threshold', threshold: 250 }]);
    fireEvent.change(screen.getByLabelText('Keep only the top N of the first row dimension'), { target: { value: '3' } });
    expect(seen.at(-1)?.topN).toEqual({ n: 3, byValueIdx: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sum of revenue' }));
    expect(seen.at(-1)?.values).toEqual([]);
    expect(seen.at(-1)?.conditional).toBeUndefined();
  });
  it('"Use a metric…": a formula metric is refused, a column metric fills the value and names the chip', async () => {
    serve(metricsRoutes);
    const seen: Pivot[] = [];
    mount((p) => seen.push(p));
    const open = async (chip: string) => {
      fireEvent.pointerDown(screen.getByRole('button', { name: `Options for ${chip}` }), { button: 0, pointerType: 'mouse' });
      fireEvent.click(await screen.findByRole('menuitem', { name: /^(Use a|Change) metric…$/ }));
      return screen.findByRole('dialog', { name: 'Use a metric' });
    };
    let dlg = await open('Sum of revenue');
    // Each row's figure is the server's display string, printed as given.
    expect(await within(dlg).findByText('12.5%')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: /^Margin %/ }));
    expect(seen).toHaveLength(0); // refused: nothing changed
    dlg = await open('Sum of revenue');
    fireEvent.click(await within(dlg).findByRole('button', { name: /^Total revenue/ }));
    expect(seen.at(-1)?.values[0]).toEqual({ column: 'revenue', aggregation: 'avg', metricId: M2 });
    expect(await screen.findByRole('button', { name: 'Remove Total revenue' })).toBeTruthy();
    // Picking a raw aggregation drops the metric link, as on the desktop.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Options for Total revenue' }), { button: 0, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Sum' }));
    expect(seen.at(-1)?.values[0]).toEqual({ column: 'revenue', aggregation: 'sum' });
  });
});

describe('the screens print the server’s figures', () => {
  it('snapshots: "vs now" is the server’s delta, not a subtraction here', async () => {
    serve(
      base({
        'snapshots:list': {
          body: {
            ok: true, eligible: true, refreshable: true, keep: 10,
            current: { at: '2026-10-04T10:00:00.000Z', rowCount: 100, columns: ['region'] },
            // A delta that is NOT 100 − 40: the browser must print what it was given.
            items: [{ stamp: '2026-10-03T10-00-00-000Z', at: '2026-10-03T10:00:00.000Z', rowCount: 40, columns: ['region'], hasSource: false, delta: 7 }],
          },
        },
      }),
    );
    renderApp(`/data/${PID}/${DID}?tab=snapshots`);
    expect(await screen.findByText('+7 since')).toBeTruthy();
    expect(screen.getByText('1 kept · each is the table as it was before a refresh replaced it')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore…' })).toBeTruthy();
  });
  it('snapshots: a dataset with no schedule says why there are none', async () => {
    serve(base({ 'snapshots:list': { body: { ok: true, eligible: false, refreshable: true, keep: 10, current: { at: '2026-10-04T10:00:00.000Z', rowCount: 1, columns: [] }, items: [] } } }));
    renderApp(`/data/${PID}/${DID}?tab=snapshots`);
    expect(await screen.findByText('Only datasets with a schedule or a connection keep snapshots.')).toBeTruthy();
  });
  it('events: the "when" line and the day count are the server’s', async () => {
    serve(
      base({
        'events:list': {
          body: {
            ok: true,
            events: [{ id: '55555555-5555-4555-8555-555555555555', title: 'Black Friday', kind: 'campaign', date: '2024-11-29', end: '2024-12-02', when: 'SERVER WHEN', days: 9 }],
            calendars: [],
            available: [{ code: 'US', name: 'United States', note: '', perYear: 11 }],
          },
        },
      }),
    );
    renderApp(`/analytics/${PID}/events`);
    expect(await screen.findByText('SERVER WHEN')).toBeTruthy();
    expect(screen.getByText('9 days · drawn as a band')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'United States' })).toBeTruthy();
  });
  it('insights: grouped by kind in the desktop’s order, each count shown', async () => {
    const ins = (id: string, kind: string, title: string) => ({ id, kind, title, detail: '', severity: 'info', datasetId: DID, column: 'revenue', facts: { now: 5 } });
    serve(base({ 'insights:list': { body: { ok: true, insights: [ins('1', 'trend', 'T one'), ins('2', 'mover', 'M one'), ins('3', 'trend', 'T two')] } } }));
    renderApp(`/data/${PID}/${DID}?tab=insights`);
    const heads = await screen.findAllByRole('heading', { level: 2 });
    const names = heads.map((h) => h.textContent);
    expect(names.indexOf('Biggest movers1')).toBeLessThan(names.indexOf('Trends2'));
    expect(screen.getAllByRole('button', { name: 'Explain' })).toHaveLength(3);
  });
  it('sql: Run sends the user’s own text and BOUND parameter values; the gate is the server’s', async () => {
    const calls = serve(
      base({
        'sql:schema': { body: { ok: true, datasets: [{ id: DID, name: 'Orders', alias: 'Orders', slug: 'orders', rowCount: 120, queryable: true, columns: COLS }] } },
        'sql:run': { body: { ok: true, columns: [{ name: 'n', type: 'number' }], rows: [[3]], rowCount: 1, truncated: false, elapsedMs: 4 } },
      }),
    );
    renderApp(`/analytics/${PID}/sql`);
    const sql = (await screen.findByRole('combobox', { name: 'SQL' })) as HTMLTextAreaElement;
    fireEvent.change(sql, { target: { value: "select count(*) as n from orders where region = [[r]]" } });
    fireEvent.change(await screen.findByLabelText('Value of r'), { target: { value: "West' or 1=1 --" } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'sql:run')).toBe(true));
    expect(calls.find((c) => c.channel === 'sql:run')!.payload).toEqual({
      projectId: PID,
      sql: 'select count(*) as n from orders where region = [[r]]',
      params: [{ name: 'r', kind: 'text', value: "West' or 1=1 --" }],
    });
    expect(await screen.findByText('1 row · 4 ms')).toBeTruthy();
    expect(within(screen.getByRole('tree', { name: 'Datasets and columns' })).getByText('orders')).toBeTruthy();
  });
});
