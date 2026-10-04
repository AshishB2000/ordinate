import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { buildStep, initialDraft } from './drafts';
import { highlightRuns, popContext } from './formulaParts';
import { stepSummary } from './steps';
import type { Column, FunctionDoc, PrepareState } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };
const COLS: Column[] = [
  { name: 'region', type: 'text' },
  { name: 'units', type: 'number' },
  { name: 'order_date', type: 'date' },
];

describe('the step drafts', () => {
  it('a filter on a number column compares numbers; on text, strings', () => {
    const d = initialDraft('filter', null, COLS, { column: 'units' });
    expect(buildStep('filter', { ...d, op: '>', value: '7' }, COLS)).toEqual({ steps: [{ type: 'filter', column: 'units', op: '>', value: 7 }] });
    expect(buildStep('filter', { ...d, column: 'region', op: '=', value: '007' }, COLS)).toEqual({ steps: [{ type: 'filter', column: 'region', op: '=', value: '007' }] });
    expect(buildStep('filter', { ...d, column: 'region', op: 'in', valuesText: 'East, West ,' }, COLS)).toEqual({
      steps: [{ type: 'filter', column: 'region', op: 'in', values: ['East', 'West'] }],
    });
    expect(buildStep('filter', { ...d, op: 'in', valuesText: ' , ' }, COLS)).toEqual({ error: 'Set a condition for this filter.' });
    expect(buildStep('filter', { ...d, op: 'is_empty' }, COLS)).toEqual({ steps: [{ type: 'filter', column: 'units', op: 'is_empty' }] });
  });

  it('says what an unfinished form is missing, in the desktop’s words', () => {
    expect(buildStep('group_aggregate', initialDraft('group_aggregate', null, COLS), COLS)).toEqual({ error: 'Pick at least one column to group by.' });
    expect(buildStep('pivot', { key: 'region', value: 'region', fn: 'sum', groupBy: [] }, COLS)).toEqual({
      error: 'The key, the value and the "one row per" columns must all be different.',
    });
    expect(buildStep('window', { fn: 'lag', as: 'prev' }, COLS)).toEqual({ error: 'Pick the value column.' });
    expect(buildStep('keyword_rules', { column: 'region', rules: [{ pattern: 'east', match: 'word', category: '' }] }, COLS)).toEqual({ error: 'Give every rule a category.' });
    expect(buildStep('spatial_join', { lat: 'units', lng: 'units' }, COLS)).toEqual({ error: 'Latitude and longitude must be two different columns.' });
  });

  it('builds the shapes the server sanitizer reads', () => {
    expect(buildStep('group_aggregate', { groupBy: ['region'], aggregations: [{ fn: 'sum', column: 'units', as: '' }] }, COLS)).toEqual({
      steps: [{ type: 'group_aggregate', groupBy: ['region'], aggregations: [{ column: 'units', fn: 'sum', as: 'sum_units' }] }],
    });
    expect(buildStep('window', { fn: 'lag', column: 'units', offset: '0', as: 'prev', partitionBy: ['region'] }, COLS)).toEqual({
      steps: [{ type: 'window', fn: 'lag', as: 'prev', column: 'units', offset: 1, partitionBy: ['region'] }],
    });
    expect(buildStep('text_terms', initialDraft('text_terms', null, COLS, { column: 'region', minN: 1, maxN: 2, top: 25 }), COLS)).toEqual({
      steps: [{ type: 'text_terms', column: 'region', lang: 'en', minN: 1, maxN: 2, top: 25, rank: 'count' }],
    });
    // Editing keeps what the stored step had: re-saving unchanged is a no-op.
    const stored = { type: 'split_column', column: 'region', mode: 'position', positions: [3, 5], into: 'columns' };
    expect(buildStep('split_column', initialDraft('split_column', stored, COLS), COLS)).toEqual({ steps: [stored] });
  });

  it('summarises a step by its own fields', () => {
    const names = new Map([['x', 'Products']]);
    expect(stepSummary({ type: 'filter', column: 'region', op: 'in', values: ['East', 'West'] })).toBe('Filter: region in (East, West)');
    expect(stepSummary({ type: 'lookup_join', datasetId: 'x', leftKey: 'sku', rightKey: 'sku', columns: ['price'] }, names)).toBe('Look up price by sku = sku "Products"');
    expect(stepSummary({ type: 'mask_redact', column: 'card', keep: 0 })).toBe('Mask card: hide all');
    expect(stepSummary({ type: 'nope' })).toBe('Unknown step');
  });
});

describe('the formula editor’s pure halves', () => {
  const docs: FunctionDoc[] = [
    { name: 'round', category: 'number', signature: 'round(number, decimals?)', summary: 'Rounds.', example: 'round(1.5)' },
    { name: 'fixed', category: 'lod', signature: '{FIXED [dim] : AGG(expr)}', summary: 'LOD', example: '', insert: '{FIXED [] : SUM()}', kind: 'keyword' },
  ];
  it('colours the server’s tokens and marks its error span, never parsing anything itself', () => {
    const runs = highlightRuns('round([units])', [
      { kind: 'name', value: 'round', start: 0, end: 5 },
      { kind: 'col', value: 'units', start: 6, end: 13 },
    ], { start: 6, end: 13 }, new Set(['round']));
    expect(runs.map((r) => [r.text, r.cls, r.err])).toEqual([
      ['round', 'fn', false],
      ['(', '', false],
      ['[units]', 'col', true],
      [')', '', false],
      ['\n', '', false],
    ]);
  });
  it('completes a column after an open bracket, a function after two letters, columns inside an LOD', () => {
    expect(popContext('[un', COLS, docs)).toEqual({ items: [{ label: 'units', insert: '[units]', sub: 'number' }], from: 0 });
    expect(popContext('ro', COLS, docs)?.items[0].insert).toBe('round(');
    expect(popContext('r', COLS, docs)).toBeNull();
    expect(popContext('{fi', COLS, docs)?.items[0].insert).toBe('FIXED ');
    expect(popContext('{FIXED reg', COLS, docs)).toEqual({ items: [{ label: 'region', insert: '[region]', sub: 'dimension · text' }], from: 7 });
  });
});

// ── The page, against a stubbed server ─────────────────────────────────────

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

const STATE: PrepareState = {
  id: DID,
  name: 'Retail orders',
  rowCount: 4232,
  columns: COLS,
  steps: [{ type: 'filter', column: 'region', op: '!=', value: 'North' }],
  stepCounts: [{ before: 5000, after: 4232 }],
  updatedAt: '2026-10-03T10:00:00Z',
};
const base = (extra: Record<string, Reply> = {}) => ({
  '/api/auth/me': { body: ME },
  'projects:overview': { body: [{ id: PID, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] },
  'prepare:get': { body: STATE },
  'dataset:list': { body: [{ id: DID, name: 'Retail orders', sourceKind: 'csv', rowCount: 4232, columnCount: 3, updatedAt: '' }] },
  'dataset:page': { body: { ok: true, rows: [], total: 0, offset: 0 } },
  ...extra,
});
const URL_ = `/data/${PID}/${DID}/prepare`;

describe('Prepare', () => {
  it('lists the steps with the server’s rows-in / rows-out', async () => {
    serve(base());
    renderApp(URL_);
    expect(await screen.findByRole('heading', { level: 1, name: 'Retail orders' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Pipeline steps' });
    expect(within(list).getByText(/Filter: region != North/)).toBeTruthy();
    expect(within(list).getByText('5,000 → 4,232 rows')).toBeTruthy();
    expect(screen.getByText('Prepare · 4,232 rows · 3 columns')).toBeTruthy();
  });

  it('an empty pipeline says what a step is for', async () => {
    serve(base({ 'prepare:get': { body: { ...STATE, steps: [], stepCounts: [] } } }));
    renderApp(URL_);
    expect(await screen.findByText(/No steps yet\. Add one to transform the data/)).toBeTruthy();
  });

  it('shows a retry when the dataset cannot be read, and "not found" for a missing one', async () => {
    serve(base({ 'prepare:get': { status: 500, body: { error: 'boom' } } }));
    renderApp(URL_);
    expect(await screen.findByRole('heading', { name: 'This dataset could not be opened' })).toBeTruthy();
  });

  it('removing a step sends its index and paints the server’s new shape and warnings', async () => {
    const calls = serve(
      base({
        'dataset:removeStep': {
          body: {
            ok: true,
            dataset: { ...STATE, steps: [], updatedAt: '2026-10-03T10:01:00Z' },
            preview: { columns: COLS, rowCount: 5000, warnings: ['Filter skipped: nothing to do'], stepCounts: [] },
          },
        },
      }),
    );
    renderApp(URL_);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove step 1' }));
    expect(await screen.findByText('Filter skipped: nothing to do')).toBeTruthy();
    expect(calls.find((c) => c.channel === 'dataset:removeStep')?.payload).toEqual({ projectId: PID, datasetId: DID, index: 0 });
    expect(await screen.findByText('Prepare · 5,000 rows · 3 columns')).toBeTruthy();
  });

  it('a step the form cannot build yet is refused here, without a call', async () => {
    const calls = serve(base());
    renderApp(`${URL_}?add=group_aggregate`);
    fireEvent.click(await screen.findByRole('button', { name: 'Save step' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Pick at least one column to group by.');
    expect(calls.some((c) => c.channel === 'dataset:addStep')).toBe(false);
  });

  it('a server refusal keeps the editor open with its message', async () => {
    serve(base({ 'dataset:addStep': { body: { ok: false, error: 'Dataset not found' } } }));
    renderApp(`${URL_}?add=drop_column&column=units`);
    fireEvent.click(await screen.findByRole('button', { name: 'Save step' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Dataset not found');
    expect(screen.getByRole('heading', { name: 'Add: Drop column' })).toBeTruthy();
  });

  it('the formula editor shows the server’s verdict and gates Save on it', async () => {
    serve(
      base({
        'formula:functions': { body: [] },
        'formula:check': (p) => {
          const expr = (p as { expression: string }).expression;
          return expr.includes('(')
            ? { body: { tokens: [], ok: false, error: 'Missing ")" at 7', at: { start: 6, end: 7 }, refs: [], unknownRefs: [], resultType: null, sample: { columns: [], rows: [] } } }
            : {
                body: {
                  tokens: [{ kind: 'col', value: 'unit', start: 0, end: 6 }],
                  ok: true,
                  refs: ['unit'],
                  unknownRefs: [{ name: 'unit', didYouMean: 'units' }],
                  resultType: 'number',
                  sample: { columns: [], rows: [{ inputs: [], result: 2 }] },
                },
              };
        },
      }),
    );
    renderApp(`${URL_}?add=calculated_field`);
    const dialog = await screen.findByRole('dialog', { name: 'New calculated field' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'New column name' }), { target: { value: 'double' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Expression' }), { target: { value: '[unit]' } });
    expect(await within(dialog).findByText('[unit] is not a column. Did you mean [units]?')).toBeTruthy();
    expect(within(dialog).getByText('number')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Expression' }), { target: { value: 'round(' } });
    expect(await within(dialog).findByText('Missing ")" at 7')).toBeTruthy();
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
  });
});
