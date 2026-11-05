import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { startDownload } from '../../api/files';

vi.mock('../../api/files', () => ({ startDownload: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(startDownload).mockClear();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const O = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
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
    'dataset:list': body([{ id: O, name: 'Orders', sourceKind: 'csv', rowCount: 10, columnCount: 3, updatedAt: '2026-10-01T10:00:00Z' }]),
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

/** Opens Import… and picks a zip: the dialog, once the dry run is shown. */
async function pick() {
  fireEvent.click(await screen.findByRole('button', { name: 'Import…' }, LAZY));
  const dialog = await screen.findByRole('dialog', { name: 'Import model files' });
  const file = new File(['zip!'], 'retail-model.zip', { type: 'application/zip' });
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
