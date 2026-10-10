import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { MetricSummary } from '../analyses/metrics/api';
import type { Column } from '../prepare/api';
import { metricMeasure, templateText } from './api';
import { CalcDialog, type CalcCreated } from './CalcDialog';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const MID = '33333333-3333-4333-8333-333333333333';
const COLS: Column[] = [
  { name: 'Region', type: 'text' },
  { name: 'Profit', type: 'number' },
  { name: 'Revenue', type: 'number' },
];
const REVENUE: MetricSummary = { id: MID, name: 'Total revenue', datasetId: DID, datasetName: 'Sales', definition: { column: 'Revenue', aggregation: 'sum' }, definitionText: 'sum of Revenue', format: { kind: 'currency' }, updatedAt: '' };
const MARGIN: MetricSummary = { ...REVENUE, id: '44444444-4444-4444-8444-444444444444', name: 'Margin %', definition: { formula: 'sum([Profit]) / sum([Revenue])' }, definitionText: 'sum([Profit]) / sum([Revenue])', format: { kind: 'percent', decimals: 1 }, description: 'What we keep' };
const TOKENS = [{ kind: 'name', value: 'sum', start: 0, end: 3 }];
const GOOD = { ok: true, valid: true, tokens: TOKENS, preview: { ok: true, value: 0.25, display: '25.0%', definitionText: 'sum([Profit]) / sum([Revenue])' } };

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });
function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: Record<string, unknown>[] }).args[0] : {};
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      const r = routes[channel] ?? { body: [] };
      const out = typeof r === 'function' ? r(payload) : r;
      return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
    }),
  );
  return calls;
}
const base = (extra: Record<string, Reply> = {}): Record<string, Reply> => ({
  'formula:functions': { body: [{ name: 'round', category: 'number', signature: 'round(number, decimals?)', summary: 'Rounds a number.', example: 'round(1.5)' }] },
  'projects:roles': { body: { [PID]: 'editor' } },
  'metric:check': { body: GOOD },
  ...extra,
});

function open(props: Partial<Parameters<typeof CalcDialog>[0]> = {}) {
  const onCreated = vi.fn<(made: CalcCreated) => void>();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/', element: <CalcDialog projectId={PID} datasetId={DID} columns={COLS} metrics={[REVENUE]} live={false} chart onCreated={onCreated} onClose={onClose} {...props} /> }]);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { onCreated, onClose };
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value, selectionStart: value.length } });
const pick = (name: string, option: string) => {
  fireEvent.click(screen.getByRole('combobox', { name }));
  fireEvent.click(screen.getByRole('option', { name: option }));
};
const checks = (calls: { channel: string; payload: Record<string, unknown> }[]) => calls.filter((c) => c.channel === 'metric:check');

describe('quick starts only write formula text', () => {
  const profit = { kind: 'column', name: 'Profit' } as const;
  const revenue = { kind: 'column', name: 'Revenue' } as const;
  it('totals a column in a measure and leaves it bare on a row', () => {
    expect(templateText('difference', profit, revenue, true)).toEqual({ expression: 'sum([Profit]) - sum([Revenue])', name: 'Profit minus Revenue', percent: false });
    expect(templateText('ratio', profit, revenue, false).expression).toBe('[Profit] / [Revenue]');
    expect(templateText('ratio', { kind: 'metric', name: 'Net' }, revenue, true).expression).toBe('[Net] / sum([Revenue])');
  });
  it('"percent of" is a format on a measure and × 100 on a row', () => {
    expect(templateText('percent', profit, revenue, true)).toMatchObject({ expression: 'sum([Profit]) / sum([Revenue])', percent: true });
    expect(templateText('percent', profit, revenue, false)).toMatchObject({ expression: '[Profit] / [Revenue] * 100', percent: false });
  });
  it('a formula metric becomes a measure named for it; a simple one keeps its column', () => {
    expect(metricMeasure(MARGIN, { column: 'Profit', aggregation: 'sum', calc: { kind: 'rank' } })).toEqual({ column: 'Margin %', aggregation: 'count', metricId: MARGIN.id, calc: { kind: 'rank' } });
    expect(metricMeasure(REVENUE)).toEqual({ column: 'Revenue', aggregation: 'sum', metricId: MID });
  });
});

describe('the calculated-field dialog — a measure', () => {
  it('explains both kinds and shows why Margin % must be a measure', () => {
    serve(base());
    open();
    const kinds = screen.getByRole('radiogroup', { name: 'Kind of calculated field' });
    expect(within(kinds).getByRole('radio', { name: /Measure \(calculated after totals\)/ }).getAttribute('aria-checked')).toBe('true');
    expect(within(kinds).getByRole('radio', { name: /Column \(calculated on every row\)/ }).getAttribute('aria-checked')).toBe('false');
    const why = screen.getByRole('figure', { name: 'Why Margin % must be a measure' });
    expect(why.textContent).toContain('As a measure: 100 ÷ 400 = 25%');
    expect(why.textContent).toContain('As a column, then averaged: (10% + 30%) ÷ 2 = 20%');
    // Empty: nothing has been asked of the server, and the preview says what to do.
    expect(screen.getByLabelText('Preview').textContent).toContain('Write a formula, or pick a quick start');
    expect((screen.getByRole('button', { name: 'Create measure' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks the server on a pause, shows ITS value, and saving creates the metric in one step', async () => {
    const calls = serve(base({ 'metric:save': (p) => ({ body: { ok: true, metric: { id: MID, datasetId: DID, updatedAt: '', filters: [], ...((p as { input: object }).input) } } }) }));
    const { onCreated, onClose } = open();
    type('Name', 'Margin %');
    type('Formula', 'sum([Profit]) / sum([Revenue])');
    // Loading: a skeleton, not a guessed number.
    expect(screen.getByRole('status', { name: 'Calculating the value' })).toBeTruthy();
    await screen.findByText('25.0%');
    expect(checks(calls).at(-1)?.payload).toEqual({ projectId: PID, datasetId: DID, expression: 'sum([Profit]) / sum([Revenue])', name: 'Margin %', format: { kind: 'number', decimals: 0 }, chart: true });
    expect(screen.getByLabelText('Preview').textContent).toContain('Calculated by the server, over every row.');

    fireEvent.click(screen.getByRole('button', { name: 'Create measure' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const save = calls.find((c) => c.channel === 'metric:save');
    expect(save?.payload).toEqual({ projectId: PID, input: { name: 'Margin %', definition: { formula: 'sum([Profit]) / sum([Revenue])' }, format: { kind: 'number', decimals: 0 }, description: '', direction: '', datasetId: DID } });
    expect(onCreated.mock.calls[0][0]).toMatchObject({ kind: 'measure', metric: { id: MID, name: 'Margin %' } });
    expect(onClose).toHaveBeenCalled();
  });

  it('a refusal is the server’s sentence under the formula, underlined at the server’s position', async () => {
    const error = 'No metric is called “Revenu”. Did you mean [Total revenue]?';
    serve(base({ 'metric:check': { body: { ok: false, valid: false, code: 'unknown', error, at: { start: 14, end: 22 }, tokens: [{ kind: 'col', value: 'Revenu', start: 14, end: 22 }] } } }));
    open();
    type('Name', 'Margin %');
    type('Formula', 'sum([Profit]) [Revenu]');
    const said = await screen.findByText(error);
    const box = screen.getByLabelText('Formula');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.contains(said)).toBe(true);
    // The underline covers exactly the span the server named.
    const marked = [...document.querySelectorAll('pre span')].filter((el) => /tErr/.test(el.className)).map((el) => el.textContent).join('');
    expect(marked).toBe('[Revenu]');
    expect((screen.getByRole('button', { name: 'Create measure' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText('Preview').textContent).toContain('No value until the formula is fixed.');
  });

  it('a taken name is said beside the Name field — from the check, and again from the save', async () => {
    const taken = 'A metric called "Margin %" already exists.';
    const calls = serve(base({ 'metric:check': (p) => ({ body: (p as { name?: string }).name === 'Margin %' ? { ...GOOD, nameError: taken } : GOOD }), 'metric:save': { body: { ok: false, error: taken, field: 'name' } } }));
    const { onCreated, onClose } = open();
    type('Name', 'Margin %');
    type('Formula', 'sum([Profit])');
    const said = await screen.findByText(taken);
    const name = screen.getByLabelText('Name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(name.getAttribute('aria-describedby') ?? '')?.contains(said)).toBe(true);
    expect((screen.getByRole('button', { name: 'Create measure' }) as HTMLButtonElement).disabled).toBe(true);

    // A name the check passed but the save refuses (someone else took it meanwhile).
    type('Name', 'Margin');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create measure' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Create measure' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:save')).toBe(true));
    await waitFor(() => expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText(taken)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a quick start fills the formula, the name and the percent format — and the server still checks it', async () => {
    const calls = serve(base());
    open();
    expect((screen.getByRole('button', { name: /Percent of/ }) as HTMLButtonElement).disabled).toBe(true);
    pick('A', 'Profit');
    pick('B', 'Total revenue');
    fireEvent.click(screen.getByRole('button', { name: /Percent of/ }));
    expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).value).toBe('sum([Profit]) / [Total revenue]');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Profit % of Total revenue');
    expect(screen.getByRole('combobox', { name: 'Format' }).textContent).toBe('Percent');
    await waitFor(() => expect(checks(calls).at(-1)?.payload).toMatchObject({ expression: 'sum([Profit]) / [Total revenue]', format: { kind: 'percent', decimals: 1 } }));
  });

  it('completes columns and metrics after "[" and functions with their signature and one line', () => {
    serve(base());
    open();
    type('Formula', 'sum([Re');
    const list = screen.getByRole('listbox', { name: 'Completions' });
    // Metrics first, then the columns whose name holds the fragment.
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Total revenuemetric · sum of Revenue', 'Regiontext', 'Revenuenumber']);
    type('Formula', 'av');
    expect(within(screen.getByRole('listbox', { name: 'Completions' })).getByRole('option').textContent).toBe('avg(column)The average of a number column.');
  });

  it('editing a formula metric: no kind to choose, the fields prefilled, an update that leaves its filters alone', async () => {
    const calls = serve(base({ 'metric:update': { body: { ok: true, metric: { ...MARGIN, filters: [] } } } }));
    const { onCreated } = open({ editing: MARGIN, metrics: [REVENUE, MARGIN] });
    expect(screen.queryByRole('radiogroup', { name: 'Kind of calculated field' })).toBeNull();
    expect((screen.getByLabelText('Formula') as HTMLTextAreaElement).value).toBe('sum([Profit]) / sum([Revenue])');
    await screen.findByText('25.0%');
    expect(checks(calls).at(-1)?.payload).toMatchObject({ id: MARGIN.id, name: 'Margin %', format: { kind: 'percent', decimals: 1 } });
    fireEvent.click(screen.getByRole('button', { name: 'Save measure' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const patch = (calls.find((c) => c.channel === 'metric:update')?.payload as { id: string; patch: Record<string, unknown> });
    expect(patch.id).toBe(MARGIN.id);
    expect(patch.patch).toMatchObject({ name: 'Margin %', description: 'What we keep', definition: { formula: 'sum([Profit]) / sum([Revenue])' } });
    expect('filters' in patch.patch).toBe(false);
  });
});

describe('the calculated-field dialog — a column', () => {
  const CHECK = { tokens: [], ok: true, refs: ['Profit', 'Revenue'], unknownRefs: [], resultType: 'number', sample: { columns: ['Profit', 'Revenue'], rows: [{ inputs: [10, 100], result: 0.1 }] } };
  const added = (columns: Column[], warnings: string[] = []) => ({ ok: true, dataset: { id: DID, name: 'Sales', columns, rowCount: 3, steps: [], updatedAt: '' }, preview: { columns, rowCount: 3, warnings } });

  it('appends one step through Prepare’s own channel, says it is recomputing, then hands back the new column', async () => {
    const after = [...COLS, { name: 'Row margin', type: 'number' as const }];
    const calls = serve(base({ 'formula:check': { body: CHECK }, 'dataset:addStep': { body: added(after) }, 'dataset:columns': { body: { id: DID, name: 'Sales', rowCount: 3, columns: after } } }));
    const { onCreated, onClose } = open();
    fireEvent.click(screen.getByRole('radio', { name: /Column \(calculated on every row\)/ }));
    type('New column name', 'Row margin');
    type('Expression', '[Profit] / [Revenue]');
    // The server's eight-row sample, not a browser's arithmetic.
    expect(await screen.findByRole('cell', { name: '0.1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(await screen.findByText('Recomputing the dataset with the new column…')).toBeTruthy();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ kind: 'column', name: 'Row margin', type: 'number' }));
    expect(calls.find((c) => c.channel === 'dataset:addStep')?.payload).toEqual({ projectId: PID, datasetId: DID, step: { type: 'calculated_field', name: 'Row margin', expression: '[Profit] / [Revenue]' } });
    expect(onClose).toHaveBeenCalled();
    expect(calls.some((c) => c.channel === 'metric:save')).toBe(false);
  });

  it('a step the server dropped is said, and the dialog stays with the work in it', async () => {
    serve(base({ 'formula:check': { body: CHECK }, 'dataset:addStep': { body: added(COLS, ['Calculated field "Row margin" was skipped: Unknown function: nope']) } }));
    const { onCreated, onClose } = open();
    fireEvent.click(screen.getByRole('radio', { name: /Column/ }));
    type('New column name', 'Row margin');
    type('Expression', '[Profit] / [Revenue]');
    await screen.findByRole('cell', { name: '0.1' });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Calculated field "Row margin" was skipped: Unknown function: nope');
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a row quick start writes bare columns', () => {
    serve(base({ 'formula:check': { body: CHECK } }));
    open();
    fireEvent.click(screen.getByRole('radio', { name: /Column/ }));
    pick('A', 'Profit');
    pick('B', 'Revenue');
    fireEvent.click(screen.getByRole('button', { name: /Difference/ }));
    expect((screen.getByLabelText('Expression') as HTMLTextAreaElement).value).toBe('[Profit] - [Revenue]');
    expect((screen.getByLabelText('New column name') as HTMLInputElement).value).toBe('Profit minus Revenue');
  });
});

describe('the calculated-field dialog — a Live dataset', () => {
  it('the Column kind is off, with why and "Make a copy"; nothing that reads rows is asked', async () => {
    const calls = serve(base());
    open({ live: true });
    const column = screen.getByRole('radio', { name: /Column \(calculated on every row\)/ });
    expect(column.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/a Live dataset keeps none here/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Make a copy' })).toBeTruthy();
    fireEvent.click(column);
    expect(column.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByLabelText('New column name')).toBeNull();
    expect(screen.getByLabelText('Formula')).toBeTruthy();
    expect(calls.some((c) => ['formula:check', 'dataset:addStep', 'prepare:get', 'dataset:suggestCalcField'].includes(c.channel))).toBe(false);
  });

  it('a measure is asked of the warehouse; a refused figure is the server’s sentence with the copy, and the definition can still be saved', async () => {
    const refusal = 'Converting currencies is not available on a Live dataset yet.';
    serve(base({ 'metric:check': { body: { ok: false, valid: true, tokens: TOKENS, code: 'live_refused', error: refusal, reason: 'fx' } } }));
    open({ live: true });
    type('Name', 'Margin %');
    type('Formula', 'sum([Profit]) / sum([Revenue])');
    expect(await screen.findByText(refusal)).toBeTruthy();
    expect(document.querySelector('[data-live-refusal]')).toBeTruthy();
    expect(screen.getByLabelText('Formula').getAttribute('aria-invalid')).toBeNull();
    expect((screen.getByRole('button', { name: 'Create measure' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a Live figure dated by the warehouse says so', async () => {
    serve(base({ 'metric:check': { body: { ...GOOD, preview: { ...GOOD.preview, asOf: { mode: 'live' } } } } }));
    open({ live: true });
    type('Name', 'Margin %');
    type('Formula', 'sum([Profit]) / sum([Revenue])');
    await screen.findByText('25.0%');
    expect(screen.getByLabelText('Preview').textContent).toContain('Calculated by the warehouse, over all its rows.');
  });
});
