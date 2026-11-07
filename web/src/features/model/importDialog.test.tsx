import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { startDownload } from '../../api/files';
import { importRefresh, type ImportPlan } from './api';

vi.mock('../../api/files', () => ({ startDownload: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(startDownload).mockClear();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const O = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const V = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const A = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const TOKEN = 'u'.repeat(43);
/** The Data model is a lazy chunk: its first render waits on a transform (long under load). */
const LAZY = { timeout: 15_000 };

const COUNTS = { unchanged: 14, updated: 3, renamed: 1, new: 2, conflict: 1, skipped: 2, onlyHere: 4 };
const PLAN = {
  hash: 'h1',
  counts: COUNTS,
  source: { appVersion: '0.1.0', project: 'Retail model' },
  notCarried: ['metricTrees'],
  items: [
    { key: 'table:o', kind: 'table', name: 'Orders', status: 'unchanged', newerHere: true },
    { key: 'metric:r', kind: 'metric', name: 'Revenue', status: 'updated', changes: [{ field: 'filters', here: [], file: [{}] }] },
    { key: 'table:o2', kind: 'table', name: 'Orders', status: 'updated', changes: [{ field: 'guide', here: 'a', file: 'b' }] },
    { key: 'field:o:region', kind: 'field', name: 'EMEA', status: 'updated', changes: [{ field: 'values', file: [] }] },
    { key: 'metric:a', kind: 'metric', name: 'Average basket', status: 'renamed', changes: [{ field: 'name', here: 'Avg basket', file: 'Average basket' }] },
    { key: 'term:e', kind: 'term', name: 'Enterprise', status: 'new' },
    { key: 'metric:g', kind: 'metric', name: 'Gross margin', status: 'new' },
    { key: 'metric:s', kind: 'metric', name: 'Stock on hand', status: 'conflict', changes: [{ field: 'description', here: 'x', file: 'y' }] },
    { key: 'dataset:ret', kind: 'dataset', name: 'Returns', status: 'skipped', reason: 'dataset_missing' },
    { key: 'metric:ref', kind: 'metric', name: 'Refunds', status: 'skipped', reason: 'depends_on_skipped', because: 'dataset:ret' },
    { key: 'term:here:1', kind: 'term', name: 'VIP', status: 'onlyHere' },
  ],
};
const UNCHANGED = { ...PLAN, hash: 'h0', counts: { unchanged: 3, updated: 0, renamed: 0, new: 0, conflict: 0, skipped: 0, onlyHere: 0 }, items: [], notCarried: [] };
const STALE = 'This project changed since the dry run. Check again.';
const TAKEN = 'A metric called "Stock level" already exists.';

/** Every upload's file name, in order. */
let uploads: string[] = [];

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor') {
  const body = (b: unknown) => ({ body: b });
  const calls = serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'dataset:list': body([
      { id: O, name: 'Orders', sourceKind: 'csv', rowCount: 10, columnCount: 3, updatedAt: '2026-10-01T10:00:00Z' },
      { id: V, name: 'visits', sourceKind: 'csv', rowCount: 8, columnCount: 3, updatedAt: '2026-10-01T10:00:00Z' },
      { id: A, name: 'Orders archive', sourceKind: 'csv', rowCount: 10, columnCount: 3, updatedAt: '2026-10-01T10:00:00Z' },
    ]),
    'model:overview': body({ ok: true, tables: [], todo: [], more: 0 }),
    'model:importPlan': body({ ok: true, plan: PLAN }),
    ...routes,
  });
  // An upload is multipart, which serveRpc does not read: answered here, the rest passed on.
  const rpcFetch = globalThis.fetch;
  uploads = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== '/api/files') return rpcFetch(url, init);
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error('an upload is multipart');
    uploads.push((form.get('file') as File).name);
    return new Response(JSON.stringify({ fileToken: TOKEN, name: 'retail-model.zip', size: 4 }), { status: 200 });
  }));
  return calls;
}

/** Opens Import… and picks a file (a zip unless said): the dialog, once the dry run is shown. */
async function pick(name = 'retail-model.zip', type = 'application/zip') {
  fireEvent.click(await screen.findByRole('button', { name: 'Import…' }, LAZY));
  const dialog = await screen.findByRole('dialog', { name: 'Import model files' });
  const file = new File(['zip!'], name, { type });
  await act(async () => fireEvent.change(within(dialog).getByLabelText('Model files'), { target: { files: [file] } }));
  return dialog;
}

describe('The Data model: Import…', () => {
  it('shows the dry run: one row per status with the names, a conflict that keeps this project\'s, skips in words, the only-here note', async () => {
    const calls = serve();
    renderApp(`/model/${P}`);
    const dialog = await pick();
    const d = within(dialog);
    for (const t of ['14 unchanged', '3 updated', '1 renamed', '2 new', '1 conflict', '2 skipped', '4 only here']) expect(await d.findByText(t)).toBeTruthy();
    expect(d.getByText('Revenue')).toBeTruthy();
    expect(d.getByText('filters')).toBeTruthy();
    expect(d.getByText('"Avg basket" → "Average basket"')).toBeTruthy();
    expect(d.getByText('Term "Enterprise"')).toBeTruthy();
    expect(d.getByText('Metric "Gross margin"')).toBeTruthy();
    expect(d.getByText('changed here and in the file')).toBeTruthy();
    expect(d.getByRole('combobox', { name: 'Stock on hand' }).textContent).toContain('Keep this project\'s');
    expect(d.getByText('Dataset "Returns" is not in this project')).toBeTruthy();
    expect(d.getByText('and 1 metric on it')).toBeTruthy();
    expect(d.queryByText('Refunds')).toBeNull(); // counted under the dataset it fell with
    expect(d.getByText('Not in the files. An import never deletes.')).toBeTruthy();
    expect(d.getByText('1 is newer in this project and stays as it is.')).toBeTruthy();
    expect(d.getByRole('button', { name: 'Apply 6 changes' })).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'model:importPlan').map((c) => c.payload)).toEqual([{ projectId: P, fileToken: TOKEN }]);
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('Apply sends the plan\'s hash and the side picked for a conflict, then says what landed and what did not, with the model as it was', async () => {
    const calls = serve({ 'model:importApply': { body: { ok: true, written: ['metric:r', 'table:o2', 'field:o:region', 'metric:a', 'term:e', 'metric:g'], failed: [{ key: 'metric:s', error: TAKEN }], before: { downloadToken: 'before-1' } } } });
    renderApp(`/model/${P}`);
    const d = within(await pick());
    fireEvent.click(await d.findByRole('combobox', { name: 'Stock on hand' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Use the file\'s' }));
    await act(async () => fireEvent.click(d.getByRole('button', { name: 'Apply 7 changes' })));
    expect(calls.filter((c) => c.channel === 'model:importApply').map((c) => c.payload)).toEqual([{ projectId: P, fileToken: TOKEN, planHash: 'h1', choices: { 'metric:s': 'file' } }]);
    expect(uploads).toEqual(['retail-model.zip', 'retail-model.zip']); // the same file again: an upload is used once
    expect(await d.findByText('Applied 6 of 7 changes.')).toBeTruthy();
    expect(d.getByText('Stock on hand')).toBeTruthy();
    expect(d.getByText(TAKEN)).toBeTruthy();
    fireEvent.click(d.getByRole('button', { name: 'Download the model as it was before' }));
    expect(startDownload).toHaveBeenCalledWith('before-1');
  });

  it('after Apply only the reads the written kinds change are fetched again, never the whole page', async () => {
    const calls = serve({ 'model:importApply': { body: { ok: true, written: ['table:o2'], failed: [] } } });
    renderApp(`/model/${P}`);
    const d = within(await pick());
    await waitFor(() => expect(calls.some((c) => c.channel === 'model:overview')).toBe(true));
    const before = calls.length;
    await act(async () => fireEvent.click(d.getByRole('button', { name: 'Apply 6 changes' })));
    expect(await d.findByText(/^Applied 1 change/)).toBeTruthy();
    await waitFor(() => expect(calls.slice(before).some((c) => c.channel === 'model:overview')).toBe(true)); // the summary the description is counted in
    const again = calls.slice(before).map((c) => c.channel).filter((c) => c !== 'model:importApply');
    // NEGATIVE CONTROL: invalidating every query refetched these too (the project list, the roles, the datasets).
    for (const untouched of ['projects:overview', 'projects:roles', 'dataset:list']) expect(again).not.toContain(untouched);
  }, 15_000);

  it('a plan_changed reply shows its sentence with Check again, which runs the dry run again', async () => {
    const calls = serve({ 'model:importApply': { body: { ok: false, code: 'plan_changed', error: STALE } } });
    renderApp(`/model/${P}`);
    const d = within(await pick());
    await act(async () => fireEvent.click(await d.findByRole('button', { name: 'Apply 6 changes' })));
    expect(await d.findByText(STALE)).toBeTruthy();
    expect(d.getByRole('button', { name: 'Apply 6 changes' }).hasAttribute('disabled')).toBe(true);
    await act(async () => fireEvent.click(d.getByRole('button', { name: 'Check again' })));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'model:importPlan')).toHaveLength(2));
    await waitFor(() => expect(d.queryByText(STALE)).toBeNull());
    expect(d.getByRole('button', { name: 'Apply 6 changes' }).hasAttribute('disabled')).toBe(false);
  });

  it('an all-unchanged plan disables Apply with "Nothing to apply"', async () => {
    serve({ 'model:importPlan': { body: { ok: true, plan: UNCHANGED } } });
    renderApp(`/model/${P}`);
    const d = within(await pick());
    expect(await d.findByText('3 unchanged')).toBeTruthy();
    expect(d.getByRole('button', { name: 'Nothing to apply' }).hasAttribute('disabled')).toBe(true);
  });

  it('a refused file shows the server\'s sentence, and Try again plans it again', async () => {
    const sentence = 'This is not a model export from Ordinate: its model.json is missing or can\'t be read.';
    const calls = serve({ 'model:importPlan': { body: { ok: false, error: sentence } } });
    renderApp(`/model/${P}`);
    const d = within(await pick());
    expect(await d.findByText(sentence)).toBeTruthy();
    await act(async () => fireEvent.click(d.getByRole('button', { name: 'Try again' })));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'model:importPlan')).toHaveLength(2));
  });

  it('a viewer sees no Import button', async () => {
    serve({}, 'viewer');
    renderApp(`/model/${P}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Data model' }, LAZY)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Datasets/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Import…' })).toBeNull();
  });
});

describe('importRefresh', () => {
  const plan = PLAN as unknown as ImportPlan;
  it('names the reads of each kind written, and the Data model summary, once each', () => {
    const keys = importRefresh(plan, ['table:o2', 'metric:r', 'metric:g']);
    expect(keys).toEqual(expect.arrayContaining(['catalog:getTable', 'metric:list', 'metric:table', 'model:overview', 'model:navigation']));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('term:list'); // no term was written
  });
  it('nothing written, nothing refetched; a key the plan does not hold is no kind', () => {
    expect(importRefresh(plan, [])).toEqual([]);
    expect(importRefresh(plan, ['metric:nope'])).toEqual([]);
  });
});

// dbt's semantic manifest (part 7, f1): the datasets confirmed per semantic model, the copy notice, skips in words.
const DBT_PLAN = {
  hash: 'd1',
  counts: { unchanged: 2, updated: 3, renamed: 0, new: 3, conflict: 0, skipped: 7, onlyHere: 0 },
  source: { appVersion: '', project: '', kind: 'dbt' },
  notCarried: [],
  items: [
    { key: `dataset:${O}`, kind: 'dataset', name: 'orders', status: 'unchanged', targetId: O, changes: [{ field: 'matchedByName', here: 'Orders' }] },
    { key: `dataset:${V}`, kind: 'dataset', name: 'visits', status: 'unchanged', targetId: V },
    { key: `table:${O}`, kind: 'table', name: 'Orders', status: 'updated', changes: [{ field: 'key', file: 'id' }] },
    { key: `field:${O}:region`, kind: 'field', name: 'Orders · region', status: 'updated', changes: [{ field: 'description', file: 'x' }, { field: 'name', file: 'region' }] },
    { key: 'metric:o', kind: 'metric', name: 'Orders', status: 'updated', changes: [{ field: 'importedFrom', file: { kind: 'dbt', name: 'orders' } }, { field: 'timeColumn', file: 'order_date' }] },
    { key: 'metric:r', kind: 'metric', name: 'Revenue', status: 'new' },
    { key: 'metric:a', kind: 'metric', name: 'AOV', status: 'new' },
    { key: 'metric:v', kind: 'metric', name: 'Visits', status: 'new' },
    { key: 'metric:dbt:visit_to_buy', kind: 'metric', name: 'Visit to buy', status: 'skipped', reason: 'conversion' },
    { key: 'metric:dbt:revenue_per_visit', kind: 'metric', name: 'Revenue per visit', status: 'skipped', reason: 'cross_model' },
    { key: 'metric:dbt:median_order', kind: 'metric', name: 'Median order', status: 'skipped', reason: 'unknown_aggregation' },
    { key: 'metric:dbt:median_gap', kind: 'metric', name: 'Median gap', status: 'skipped', reason: 'depends_on_skipped', because: 'metric:dbt:median_order' },
    { key: 'metric:dbt:revenue_filled', kind: 'metric', name: 'Revenue (filled)', status: 'skipped', reason: 'fill_nulls' },
    { key: 'field:dbt:orders.order_month', kind: 'field', name: 'orders · order_month', status: 'skipped', reason: 'not_a_column' },
    { key: 'table:dbt:orders.order', kind: 'table', name: 'orders · order', status: 'skipped', reason: 'not_a_column' },
  ],
};

describe('The Data model: Import… a dbt semantic manifest', () => {
  it('takes a .json file and shows each semantic model\'s dataset, a loose match marked, the copy notice and the skips in words', async () => {
    const calls = serve({ 'model:importPlan': { body: { ok: true, plan: DBT_PLAN } } });
    renderApp(`/model/${P}`);
    const dialog = await pick('semantic_manifest.json', 'application/json');
    const d = within(dialog);
    expect((within(dialog).getByLabelText('Model files') as HTMLInputElement).accept).toContain('.json');
    expect(uploads).toEqual(['semantic_manifest.json']);
    expect(await d.findByText('A copy: dbt stays the source of truth only through a live dbt connection.')).toBeTruthy();
    const datasets = d.getByRole('region', { name: 'Datasets' });
    expect(within(datasets).getByRole('combobox', { name: 'Dataset for orders' }).textContent).toContain('Orders');
    expect(within(datasets).getByText('matched by name: check it')).toBeTruthy();
    expect(within(datasets).getByRole('combobox', { name: 'Dataset for visits' }).textContent).toContain('visits');
    expect(d.queryByText('2 unchanged')).toBeNull(); // the datasets are said under Datasets, not counted as unchanged objects
    expect(d.getByText('7 skipped')).toBeTruthy();
    expect(d.getByText('description')).toBeTruthy(); // a field's name is what it is, never a change
    expect(d.getByText('link to dbt, date')).toBeTruthy();
    expect(d.getByText('Dimension orders · order_month')).toBeTruthy();
    expect(d.getByText('Primary entity orders · order')).toBeTruthy();
    expect(d.getByText(/dbt pairs each conversion with the closest base event before it/)).toBeTruthy();
    expect(d.getByText('its inputs are on more than one semantic model')).toBeTruthy();
    expect(d.getByText('dbt shows a value where there are no rows (fill_nulls_with); Ordinate shows no figure')).toBeTruthy();
    expect(d.getAllByText('its expr is SQL, not one column of the dataset, or a column of another type')).toHaveLength(2);
    expect(d.getByText(/an aggregation Ordinate doesn't compute exactly \(median, percentile, sum_boolean\)/)).toBeTruthy();
    expect(d.getByText(/with 1 metric built on it/)).toBeTruthy();
    expect(d.queryByText('Median gap')).toBeNull(); // counted under the input it needs
    expect(calls.filter((c) => c.channel === 'model:importPlan').map((c) => c.payload)).toEqual([{ projectId: P, fileToken: TOKEN }]);
  });

  it('changing a semantic model\'s dataset plans again with datasetMap, and Apply sends the same map', async () => {
    const calls = serve({ 'model:importPlan': { body: { ok: true, plan: DBT_PLAN } }, 'model:importApply': { body: { ok: true, written: ['metric:r'], failed: [] } } });
    renderApp(`/model/${P}`);
    const d = within(await pick('semantic_manifest.json', 'application/json'));
    fireEvent.click(await d.findByRole('combobox', { name: 'Dataset for orders' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Orders archive' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'model:importPlan').map((c) => c.payload)).toEqual([{ projectId: P, fileToken: TOKEN }, { projectId: P, fileToken: TOKEN, datasetMap: { orders: A } }]));
    expect(uploads).toEqual(['semantic_manifest.json', 'semantic_manifest.json']);
    await act(async () => fireEvent.click(await d.findByRole('button', { name: 'Apply 6 changes' })));
    expect(calls.filter((c) => c.channel === 'model:importApply').map((c) => c.payload)).toEqual([{ projectId: P, fileToken: TOKEN, planHash: 'd1', choices: {}, datasetMap: { orders: A } }]);
  });

  // f2: part 5's shapes. Each reason's words.
  const F2_WORDS: Array<[string, string]> = [
    ['all_time', 'a running total since the first day: Ordinate\'s windows are "to date" or "last N days"'],
    ['period_agg', 'dbt reads each week or month at its first day (period_agg: first, its default) or averages its days; Ordinate reads a period at its last day'],
    ['period_agg_last', 'dbt reads each period at its last day whose window holds rows (period_agg: last); Ordinate at the period\'s last day, which has no figure when that window is empty, so the figures part there'],
    ['window_unit', 'a window in months, quarters, years or hours, or a custom grain: Ordinate\'s rolling windows count whole days, up to 366'],
    ['calendar_differs', 'a week to date, or a to-date on a calendar unlike dbt\'s: dbt\'s weeks are its warehouse\'s, and its quarters and years start in January'],
    ['no_base_metric', 'no unfiltered simple metric with a date on its measure to build a window on'],
    ['count_window', 'a count over a window: with no rows in it, Ordinate counts 0 where dbt shows no figure'],
    ['conversion', 'dbt pairs each conversion with the closest base event before it and counts conversions; Ordinate\'s funnel counts people from their first, so the figures differ'],
    ['time_offset', 'dbt shifts each day and then adds the days up, so its periods don\'t line up with Ordinate\'s "same period last year". Make it here as a change on last year'],
    ['cumulative', 'not a window over a plain metric: over a balance, or with both a window and a grain'],
    ['window_groupings', 'a balance kept per entity (window_groupings): how dbt groups it by other fields isn\'t documented, so Ordinate can\'t match it yet'],
  ];
  const F2_PLAN = {
    ...DBT_PLAN,
    counts: { ...DBT_PLAN.counts, skipped: F2_WORDS.length },
    items: [...DBT_PLAN.items.filter((i) => i.status !== 'skipped'), ...F2_WORDS.map(([reason]) => ({ key: `metric:dbt:${reason}`, kind: 'metric', name: `m_${reason}`, status: 'skipped', reason }))],
  };

  it('says each part 5 shape\'s reason in words', async () => {
    serve({ 'model:importPlan': { body: { ok: true, plan: F2_PLAN } } });
    renderApp(`/model/${P}`);
    const d = within(await pick('semantic_manifest.json', 'application/json'));
    expect(await d.findByText('A copy: dbt stays the source of truth only through a live dbt connection.')).toBeTruthy();
    for (const [, words] of F2_WORDS) expect(d.getByText(words)).toBeTruthy();
  });

  it('says where an imported metric\'s figure can differ from dbt\'s, on its line', async () => {
    const items = DBT_PLAN.items.map((i) => (i.key === 'metric:r' ? { ...i, differs: ['empty_text'] } : i.key === 'metric:o' ? { ...i, differs: ['whole_division'] } : i));
    serve({ 'model:importPlan': { body: { ok: true, plan: { ...DBT_PLAN, items } } } });
    renderApp(`/model/${P}`);
    const d = within(await pick('semantic_manifest.json', 'application/json'));
    expect(await d.findByText("a text cell that is '' or only spaces is empty here, where dbt counts it")).toBeTruthy();
    expect(d.getByText('link to dbt, date · it divides with decimals here, where dbt on Postgres, Redshift or Trino divides whole numbers as whole numbers')).toBeTruthy();
  });

  it('a model zip shows no Datasets section and no copy notice', async () => {
    serve();
    renderApp(`/model/${P}`);
    const d = within(await pick());
    expect(await d.findByText('14 unchanged')).toBeTruthy();
    expect(d.queryByRole('region', { name: 'Datasets' })).toBeNull();
    expect(d.queryByText(/A copy: dbt/)).toBeNull();
  });
});
