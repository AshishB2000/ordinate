import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    // a test stubbed it
  }
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const id = (n: number) => `${n}b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b`;
const [O, R, X] = [id(1), id(2), id(3)];
const SALES = id(4);
const LAZY = { timeout: 15_000 };

const ds = (dsId: string, name: string, columnCount = 3) => ({ id: dsId, name, sourceKind: 'csv', rowCount: 10, columnCount, updatedAt: '' });
const metric = (mId: string, name: string) => ({ id: mId, name, datasetId: O, datasetName: 'Orders', definition: { column: 'amount', aggregation: 'sum' }, definitionText: `sum of ${name}`, format: { kind: 'number' }, updatedAt: '' });
const METRICS = [metric('m1', 'Revenue'), metric('m2', 'Profit'), metric('m3', 'Order count'), metric('m4', 'Returns'), metric('m5', 'Margin')];
const ROWS = Object.fromEntries(METRICS.map((m) => [m.id, { display: '2', series: null, usage: null }]));
const TERMS = [{ id: 't1', name: 'EMEA', aliases: [], datasetId: O, datasetName: 'Orders', definition: 'region in EU', updatedAt: '' }];
const sales = { id: SALES, name: 'Sales', description: 'What the sales team reads first', datasets: [{ id: O, fields: ['region', 'amount'] }], metricIds: ['m2', 'm1'], termIds: ['t1'] };
const navigation = (topics: unknown[] = [sales]) => ({ ok: true, tables: [], dateLadder: ['year', 'quarter', 'month', 'day'], topics });
const record = (more: Record<string, unknown> = {}) => ({ ...sales, projectId: P, updatedBy: 'pat@acme.test', updatedAt: '', schemaVersion: 1, ...more });

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor') {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Retail', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Retail', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 2, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'catalog:tags': body({ ok: true, tags: [], refs: {} }),
    'dataset:list': body([ds(O, 'Orders'), ds(R, 'Regions', 2)]),
    'dataset:columns': body({ id: O, name: 'Orders', rowCount: 10, columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'state', type: 'text' }] }),
    'model:overview': body({ ok: true, tables: [], todo: [], more: 0 }),
    'model:navigation': body(navigation()),
    'metric:table': body({ ok: true, metrics: METRICS, rows: ROWS }),
    'metric:list': body({ ok: true, metrics: METRICS }),
    'term:list': body({ ok: true, terms: TERMS }),
    'topic:get': body({ ok: true, topic: record(), tag: 'tag-1', stale: 0, kept: record() }),
    'topic:save': (p) => ({ body: { ok: true, topic: { ...record(), ...(p as { topic: object }).topic, id: (p as { id?: string }).id ?? id(9) }, tag: 'tag-2' } }),
    'quality:list': body({ ok: true, rules: [], latest: null }),
    'catalog:getTable': body({ ok: true, table: { role: '', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '' } }),
    'catalog:columns': body({ ok: true, columns: {} }),
    'lineage:get': body(null),
    ...routes,
  });
}

const picker = () => screen.findByRole('combobox', { name: 'Topic' }, LAZY);
async function pick(label: string) {
  fireEvent.click(await picker());
  fireEvent.click(await screen.findByRole('option', { name: label }));
}
const metricNames = () => within(screen.getByRole('table')).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);
const line = () => screen.getByTestId('topic-line').textContent;
const drawer = () => screen.findByRole('dialog', {}, LAZY);
const saved = (calls: { channel: string; payload: unknown }[]) => calls.filter((c) => c.channel === 'topic:save').map((c) => c.payload as { id?: string; base?: string; topic: { datasets: { id: string; fields?: string[] }[]; metricIds: string[]; termIds: string[]; name: string } });

describe('The Data model: topics', () => {
  it('under Sales the strip keeps only its datasets\' gaps and its members\' review chips, and no project-wide count', async () => {
    const table = (datasetId: string) => ({ datasetId, role: 'fact', key: '', keyState: '', description: '', alwaysApplied: { kind: 'prepare', steps: [] }, calculated: [] });
    serve({
      'projects:roles': { body: { [P]: 'admin' } },
      'model:overview': { body: { ok: true, tables: [table(O), table(R)], todo: [{ datasetId: O, kind: 'no_key' }, { datasetId: R, kind: 'no_key' }], more: 0,
        review: [{ ref: 'metric:m1', name: 'Revenue', kind: 'needs_review' }, { ref: 'metric:m5', name: 'Margin', kind: 'needs_review' }, { ref: `dataset:${R}`, name: 'Regions', kind: 'needs_review' }] } },
      'catalog:suggestions': { body: { ok: true, suggestions: [{ connId: O, docId: O, table: 'ORDERS', datasetId: R, kind: 'column', column: 'amt', text: 'Amount', hash: 'AbCdEf012345' }], total: 2, datasets: 1 } },
    });
    const chips = async () => within(await screen.findByRole('region', { name: 'To fill in next' }, LAZY)).getAllByRole('button').map((b) => b.textContent);
    renderApp(`/model/${P}`);
    await screen.findByRole('button', { name: '2 suggested meanings' }, LAZY);
    expect(await chips()).toEqual(['Set a key on Orders', 'Set a key on Regions', 'Revenue changed since certified', 'Margin changed since certified', 'Regions changed since certified', '2 suggested meanings']); // NEGATIVE CONTROL: All
    cleanup();
    renderApp(`/model/${P}?topic=${SALES}`);
    await screen.findByTestId('topic-line', {}, LAZY);
    await waitFor(async () => expect(await chips()).toEqual(['Set a key on Orders', 'Revenue changed since certified']));
  }, 30_000);

  it('picking Sales puts topic= in the URL and narrows Metrics to its two, in its order; Show all lists five', async () => {
    serve();
    const router = renderApp(`/model/${P}?tab=metrics`);
    await screen.findByText('Margin', {}, LAZY);
    await pick('Sales');
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('topic')).toBe(SALES));
    await waitFor(() => expect(metricNames()).toEqual(['Profit', 'Revenue']));
    expect(line()).toBe('Sales · 2 of 5 metrics · Show all');
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(metricNames()).toHaveLength(5));
    expect(new URLSearchParams(router.state.location.search).get('topic')).toBeNull();
    expect(screen.queryByTestId('topic-line')).toBeNull();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('a reload with no topic= reopens the remembered topic; a remembered id that is gone reads as All', async () => {
    serve();
    localStorage.setItem(`ordinate.topic:${P}`, SALES);
    renderApp(`/model/${P}?tab=glossary`);
    await waitFor(() => expect(screen.getByTestId('topic-line').textContent).toBe('Sales · 1 of 1 term · Show all'), LAZY);
    cleanup();
    localStorage.setItem(`ordinate.topic:${P}`, id(8));
    renderApp(`/model/${P}?tab=metrics`);
    await screen.findByText('Margin', {}, LAZY);
    expect((await picker()).textContent).toContain('All');
    expect(screen.queryByTestId('topic-line')).toBeNull();
  });

  it('a throwing localStorage still renders All', async () => {
    serve();
    const boom = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom, clear: boom });
    renderApp(`/model/${P}?tab=metrics`);
    await screen.findByText('Margin', {}, LAZY);
    expect((await picker()).textContent).toContain('All');
    await pick('Sales');
    await waitFor(() => expect(metricNames()).toEqual(['Profit', 'Revenue']));
  });

  it('New topic…: a name, two datasets and a field subset; Save sends the fields checked, and none for the dataset left whole', async () => {
    const calls = serve();
    const router = renderApp(`/model/${P}?tab=metrics`);
    await pick('New topic…');
    const d = await drawer();
    expect(within(d).getByRole('heading', { name: 'New topic' })).toBeTruthy();
    fireEvent.change(within(d).getByRole('textbox', { name: 'Name' }), { target: { value: 'Ops' } });
    fireEvent.click(await within(d).findByRole('checkbox', { name: 'Orders' }));
    fireEvent.click(within(d).getByRole('checkbox', { name: 'Regions' }));
    fireEvent.click(within(d).getByRole('button', { name: 'Fields of Orders: all 3' }));
    const pop = await screen.findByRole('dialog', { name: 'Fields of Orders' });
    fireEvent.click(await within(pop).findByRole('checkbox', { name: 'state' }));
    fireEvent.keyDown(pop, { key: 'Escape' });
    await waitFor(() => expect(within(d).getByRole('button', { name: 'Fields of Orders: 2 of 3' })).toBeTruthy());
    fireEvent.click(await within(d).findByRole('checkbox', { name: 'Revenue' }));
    fireEvent.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved(calls)).toHaveLength(1));
    const [s] = saved(calls);
    expect(s.id).toBeUndefined();
    expect(s.topic).toEqual({ name: 'Ops', datasets: [{ id: O, fields: ['region', 'amount'] }, { id: R }], metricIds: ['m1'], termIds: [] });
    // The new topic is the one picked.
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('topic')).toBe(id(9)));
  });

  it('a 13th dataset checkbox is disabled, saying why', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ds(`${String(i + 10).padStart(8, '0')}-2f0a-4b8e-9d34-1c2d3e4f5a6b`, `Set ${i + 1}`));
    serve({ 'dataset:list': { body: many } });
    renderApp(`/model/${P}?tab=metrics`);
    await pick('New topic…');
    const d = await drawer();
    await within(d).findByRole('checkbox', { name: 'Set 1' });
    for (let i = 1; i <= 12; i++) fireEvent.click(within(d).getByRole('checkbox', { name: `Set ${i}` }));
    const last = within(d).getByRole('checkbox', { name: 'Set 13' }) as HTMLInputElement;
    expect(last.disabled).toBe(true);
    expect(document.getElementById(last.getAttribute('aria-describedby') ?? '')?.textContent).toBe('A topic holds at most 12 datasets.');
    expect(within(d).getByText(/up to 12/)).toBeTruthy();
  });

  it('says a topic is no access control, word for word; NEGATIVE CONTROL: nothing on the page says hidden, restricted or private', async () => {
    serve();
    renderApp(`/model/${P}?tab=metrics&topic=${SALES}`);
    await pick('Edit Sales…');
    const d = await drawer();
    await within(d).findByRole('textbox', { name: 'Name' });
    expect(within(d).getByText("Topics tidy what people see first. They don't limit access: anyone who can open this project can still reach every dataset. Use project sharing or row access rules for that.")).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/hidden|restrict|private/i);
  });

  it('stale: 2 says so, and a save sends the cleaned lists with the tag it opened with', async () => {
    const kept = record({ datasets: [{ id: O, fields: ['region'] }], metricIds: ['m1'] });
    const calls = serve({ 'topic:get': { body: { ok: true, topic: record({ metricIds: ['m2', 'm1', id(7)], datasets: [{ id: O, fields: ['region', 'gone'] }] }), tag: 'tag-1', stale: 2, kept } } });
    renderApp(`/model/${P}?tab=metrics&topic=${SALES}`);
    await pick('Edit Sales…');
    const d = await drawer();
    expect(await within(d).findByText('2 items no longer exist. Saving removes them.')).toBeTruthy();
    expect(within(d).getByRole('heading', { name: 'Topic · Sales' })).toBeTruthy();
    fireEvent.click(within(d).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved(calls)).toHaveLength(1));
    const [s] = saved(calls);
    expect(s.id).toBe(SALES);
    expect(s.base).toBe('tag-1');
    expect(s.topic.datasets).toEqual([{ id: O, fields: ['region'] }]);
    expect(s.topic.metricIds).toEqual(['m1']);
  });

  it('a refusal shows the server\'s sentence under its field, the drawer kept', async () => {
    serve({ 'topic:save': { body: { ok: false, field: 'name', error: 'This project already has a topic called “Ops”.' } } });
    renderApp(`/model/${P}?tab=metrics`);
    await pick('New topic…');
    const d = await drawer();
    fireEvent.change(within(d).getByRole('textbox', { name: 'Name' }), { target: { value: 'Ops' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Save' }));
    expect(await within(d).findByText('This project already has a topic called “Ops”.')).toBeTruthy();
  });

  it('a 409 shows the conflict banner and keeps the drawer', async () => {
    serve({ 'topic:save': { status: 409, body: { error: 'record_changed', code: 'record_changed', message: 'This topic was changed in another tab or by someone else.' } } });
    renderApp(`/model/${P}?tab=metrics&topic=${SALES}`);
    await pick('Edit Sales…');
    const d = await drawer();
    await within(d).findByRole('textbox', { name: 'Name' });
    fireEvent.click(within(d).getByRole('button', { name: 'Save' }));
    expect(await within(d).findByText('This topic was changed in another tab or by someone else.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((within(d).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Delete asks first, then moves the topic to the Trash and picks All', async () => {
    const calls = serve({ 'topic:delete': { body: { ok: true } } });
    const router = renderApp(`/model/${P}?tab=metrics&topic=${SALES}`);
    await pick('Edit Sales…');
    const d = await drawer();
    fireEvent.click(await within(d).findByRole('button', { name: 'Delete' }));
    const ask = await screen.findByRole('dialog', { name: 'Delete “Sales”?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'topic:delete')).toBe(true));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('topic')).toBeNull());
  });

  it('a viewer sees the picker, but no New topic… or Edit', async () => {
    serve({}, 'viewer');
    renderApp(`/model/${P}?tab=metrics&topic=${SALES}`);
    await waitFor(() => expect(line()).toBe('Sales · 2 of 5 metrics · Show all'), LAZY);
    fireEvent.click(await picker());
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toEqual(['All', 'Sales']);
  });

  it('a viewer with no topics sees no picker; an editor with none sees All and New topic…', async () => {
    serve({ 'model:navigation': { body: navigation([]) } }, 'viewer');
    renderApp(`/model/${P}?tab=metrics`);
    await screen.findByText('Margin', {}, LAZY);
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Topic' })).toBeNull());
    cleanup();
    serve({ 'model:navigation': { body: navigation([]) } });
    renderApp(`/model/${P}?tab=metrics`);
    fireEvent.click(await picker());
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['All', 'New topic…']);
  });

  it('model:navigation answering 404 shows no picker, and every tab unnarrowed', async () => {
    serve({ 'model:navigation': { status: 404, body: { error: 'not_found', message: 'Unknown channel' } } });
    renderApp(`/model/${P}?tab=metrics&topic=${SALES}`);
    await screen.findByText('Margin', {}, LAZY);
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Topic' })).toBeNull());
    expect(metricNames()).toHaveLength(5);
    expect(screen.queryByTestId('topic-line')).toBeNull();
  });

  it('narrows the Datasets list and the Glossary too, in the topic\'s order', async () => {
    serve({ 'model:navigation': { body: navigation([{ ...sales, datasets: [{ id: R }, { id: O }] }]) }, 'dataset:list': { body: [ds(O, 'Orders'), ds(R, 'Regions'), ds(X, 'Extra')] } });
    renderApp(`/model/${P}?topic=${SALES}`);
    const list = await screen.findByRole('navigation', { name: 'Datasets' }, LAZY);
    await waitFor(() => expect(within(list).getAllByRole('link').map((a) => a.textContent)).toEqual(['Regions', 'Orders']));
    expect(line()).toBe('Sales · 2 of 3 datasets · Show all');
  });
});
