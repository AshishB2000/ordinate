import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { accentFor, defaultEncoding, fitEncoding, parseKey, suggestName, fieldKey } from './model';
import { dataToTsv } from './ChartControls';

// Whole-app renders through the router and two lazy chunks: generous under a loaded machine.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const VID = '33333333-3333-4333-8333-333333333333';
const REL = '44444444-4444-4444-8444-444444444444';
const ME = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false };
const COLS = [
  { name: 'region', type: 'text' },
  { name: 'amount', type: 'number' },
  { name: 'units', type: 'number' },
] as const;

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

const TABLE_REPLY = { ok: true, data: { labels: ['East', 'North'], series: [{ name: 'sum of amount', values: [3, 4] }] }, recommendedShape: 'unstructured', warnings: [] };

const base = (extra: Record<string, Reply> = {}) => ({
  '/api/auth/me': { body: ME },
  'projects:overview': {
    body: [{ id: PID, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }],
  },
  'projects:roles': { body: { [PID]: 'admin' } },
  'ai:status': { body: { ready: false, models: [], mine: null, keyStore: null } },
  'dataset:list': { body: [{ id: DID, name: 'Orders', sourceKind: 'csv', rowCount: 1234, columnCount: 3, updatedAt: '' }] },
  'dataset:columns': { body: { id: DID, name: 'Orders', rowCount: 1234, columns: COLS } },
  'relationship:related': { body: { ok: true, groups: [] } },
  'boundary:list': { body: { ok: true, boundaries: [] } },
  'visual:preview': { body: TABLE_REPLY },
  ...extra,
});

const summary = (over: object = {}) => ({ id: VID, name: 'Amount by region', chartType: 'table', datasetId: DID, updatedAt: '2026-01-02T10:00:00Z', favorite: false, ...over });

describe('the model', () => {
  const cols = COLS.map((c) => ({ ...c }));
  it('defaults to the first text column and the first measure, summed', () => {
    expect(defaultEncoding(cols)).toEqual({ category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] });
  });
  it('fits a saved encoding to the columns the dataset still has, keeping unknown shelves', () => {
    const fitted = fitEncoding({ category: 'gone', values: [{ column: 'gone', aggregation: 'avg' }, { column: 'units', aggregation: 'max' }], pivot: { rows: [] } }, cols, []);
    expect(fitted.category).toBe('region');
    expect(fitted.values).toEqual([{ column: 'units', aggregation: 'max' }]);
    expect(fitted.pivot).toEqual({ rows: [] });
  });
  it('keeps a related column the relationship still reaches, and round-trips its key', () => {
    const related = [{ key: `@${REL}/tier`, column: 'tier', type: 'text', datasetId: REL, group: 'Customers' }];
    const fitted = fitEncoding({ category: 'tier', categoryDatasetId: REL, values: [{ column: 'amount', aggregation: 'sum' }] }, cols, related);
    expect(fitted.category).toBe('tier');
    expect(fitted.categoryDatasetId).toBe(REL);
    expect(parseKey(fieldKey('tier', REL))).toEqual({ column: 'tier', datasetId: REL });
    expect(parseKey('plain/col')).toEqual({ column: 'plain/col' });
  });
  it('names a visual from its encoding, and gives a type one stable accent', () => {
    expect(suggestName({ category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, 'column')).toBe('amount by region');
    expect(suggestName({ category: '', values: [] }, 'pie')).toBe('Pie');
    expect(accentFor('line')).toBe(accentFor('line'));
    expect(accentFor('line')).toMatch(/^var\(--chart-[1-5]\)$/);
  });
  it('copies the figures as tab-separated text, blanks for nulls', () => {
    expect(dataToTsv({ labels: ['a', 'b'], series: [{ name: 'x', values: [1, null] }] })).toBe('Label\tx\na\t1\nb\t');
  });
});

describe('the gallery', () => {
  it('cards the saved visuals, counts them, and stars one', async () => {
    const calls = serve(
      base({
        'visual:list': { body: [summary(), summary({ id: '55555555-5555-4555-8555-555555555555', name: 'Units', favorite: true })] },
        'visual:update': { body: { ok: true, visual: summary({ favorite: true }) } },
      }),
    );
    renderApp(`/visuals/${PID}`);
    expect(await screen.findByRole('button', { name: /^Amount by region/ })).toBeTruthy();
    expect(screen.getByText('2 visuals')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unfavourite Units' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Favourite Amount by region' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'visual:update')).toBe(true));
    expect(calls.find((c) => c.channel === 'visual:update')!.payload).toEqual({ projectId: PID, id: VID, favorite: true });
  });

  it('shows a viewer the gallery without New visual, the star, or Rename / Duplicate / Delete', async () => {
    serve(base({ 'projects:roles': { body: { [PID]: 'viewer' } }, 'visual:list': { body: [summary()] } }));
    renderApp(`/visuals/${PID}`);
    expect(await screen.findByRole('button', { name: /^Amount by region/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New visual' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Favourite Amount by region' })).toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions for Amount by region' }), { button: 0, ctrlKey: false });
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Open', 'Explain', 'History']);
  });

  it('…and an editor has all of them (negative control)', async () => {
    serve(base({ 'projects:roles': { body: { [PID]: 'editor' } }, 'visual:list': { body: [summary()] } }));
    renderApp(`/visuals/${PID}`);
    expect(await screen.findByRole('button', { name: 'New visual' })).toBeTruthy();
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions for Amount by region' }), { button: 0, ctrlKey: false });
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Open', 'Rename', 'Duplicate', 'Explain', 'History', 'Delete']);
  });

  it('tells a viewer of a project with no visuals who can build one', async () => {
    serve(base({ 'projects:roles': { body: { [PID]: 'viewer' } }, 'visual:list': { body: [] } }));
    renderApp(`/visuals/${PID}`);
    expect(await screen.findByText(/An editor of this project can build visuals/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New visual' })).toBeNull();
  });

  it('starts from a dataset when there are no visuals, and gates the Assistant door', async () => {
    serve(base({ 'visual:list': { body: [] } }));
    renderApp(`/visuals/${PID}`);
    expect(await screen.findByRole('heading', { name: 'No visuals yet' })).toBeTruthy();
    const card = await screen.findByRole('button', { name: /Orders/ });
    expect(card.textContent).toContain('1,234 rows · 3 columns');
    expect((screen.getByRole('button', { name: 'Start with the Assistant' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText(/AI isn’t set up for your organization yet/)).toBeTruthy();
    fireEvent.click(card);
    expect(await screen.findByRole('dialog', { name: 'New visual' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the builder' })).toBeTruthy();
  });

  it('shows a retry when the list fails', async () => {
    serve(base({ 'visual:list': { status: 500, body: { error: 'boom' } } }));
    renderApp(`/visuals/${PID}`);
    expect(await screen.findByRole('heading', { name: 'Your visuals could not be loaded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('the builder', () => {
  it('previews the default encoding, recomputes on an edit, and saves with a name', async () => {
    const calls = serve(base({ 'visual:save': { body: { ...summary(), encoding: {}, overrides: {}, filters: [] } }, 'visual:list': { body: [] } }));
    renderApp(`/visuals/${PID}/new?dataset=${DID}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'New visual' })).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.channel === 'visual:preview')).toBe(true));
    expect((calls.find((c) => c.channel === 'visual:preview')!.payload as { encoding: unknown }).encoding).toEqual({
      category: 'region',
      values: [{ column: 'amount', aggregation: 'sum' }],
    });
    expect(await screen.findByRole('table')).toBeTruthy(); // the reply's shape offers the table

    fireEvent.click(screen.getByRole('combobox', { name: 'Aggregation' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Average' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'visual:preview').some((c) => JSON.stringify(c.payload).includes('"avg"'))).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save visual' }));
    const dialog = await screen.findByRole('dialog', { name: 'Name this visual' });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('amount by region');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'visual:save')).toBe(true));
    expect(dialog).toBeTruthy();
    expect(calls.find((c) => c.channel === 'visual:save')!.payload).toMatchObject({
      projectId: PID,
      datasetId: DID,
      name: 'amount by region',
      chartType: 'table',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'avg' }] },
    });
  });

  it('draws a saved pivot through the grid, on its own shelves, and keeps the saved type (T2.11)', async () => {
    const grid = {
      rowHeaders: [['East'], ['North']], colHeaders: [['Sum of amount']], cells: [[3], [4]], rowTotals: null, colTotals: null, grand: null,
      rowKinds: ['leaf', 'leaf'], valueNames: ['Sum of amount'], valueCount: 1, showAs: ['value'], formats: [''], conditional: [], sort: null,
      rowGroupCount: 2, colGroupCount: 1, truncated: false,
    };
    const calls = serve(
      base({
        'visual:get': { body: { ...summary({ chartType: 'pivot' }), encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }], pivot: { rows: [{ column: 'region' }], values: [] } }, overrides: {}, filters: [] } },
        'visual:preview': { body: { ...TABLE_REPLY, data: { ...TABLE_REPLY.data, pivot: grid } } },
      }),
    );
    renderApp(`/visuals/${PID}/${VID}`);
    // The pivot's shelves replace Category / Measures: Rows holds region, Values was filled with the first measure.
    expect(await screen.findByRole('group', { name: 'Rows' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Sum of amount' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Category (dimension)' })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.channel === 'visual:preview' && JSON.stringify(c.payload).includes('"pivot"'))).toBe(true));
    // The grid is the server's: a semantic table with the reply's own cells.
    expect(await screen.findByRole('rowheader', { name: 'North' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Pivot table/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('says so when the visual is gone', async () => {
    serve(base({ 'visual:get': { body: null } }));
    renderApp(`/visuals/${PID}/${VID}`);
    expect(await screen.findByRole('heading', { name: 'That visual could not be loaded' })).toBeTruthy();
  });
});
