import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderApp } from '../../test-utils';
import { Toaster } from '../../ui/Toast';
import { ColumnsTab } from './ColumnsTab';
import { ColumnDetails } from './Details';
import { everyWord, freshness, fromControl, pctText, SCHEDULES } from './format';
import { cadenceOptions } from './cadence';
import { laneLayout } from './RelationshipsTab';
import { columnsFor, ruleWords } from './ruleWords';
import { normTag } from './tags';
import type { Relationship } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';

type Reply = { status?: number; body?: unknown };

/** The Data routes are lazy chunks: their first render waits on a transform (long under load). */
const LAZY = 15_000;

/** fetch answered per RPC channel; records each call's payload. */
function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      calls.push({ channel, payload });
      // The caller edits this project unless a test says otherwise: the screens gate their change controls on it.
      const r = routes[channel] ?? (channel === 'projects:roles' ? { body: { [P]: 'editor' } } : { body: null });
      return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

const ORDERS = {
  id: D,
  name: 'Orders',
  sourceKind: 'json',
  rowCount: 1200,
  columnCount: 4,
  updatedAt: '2026-10-01T10:00:00Z',
  originKind: 'url',
  lastRefreshStatus: 'error',
  lastRefreshError: 'Could not fetch https://api.example.com: 401',
  autoRefresh: { every: 'daily' },
  qualityFailing: 2,
};

describe('Data list', () => {
  it('draws a dataset row: quality dot, rows, source, schedule, the refresh reason', async () => {
    serve({
      'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
      'dataset:list': { body: [ORDERS] },
      'catalog:tags': { body: { ok: true, tags: [{ name: 'finance', color: 2, count: 1 }], refs: { [`dataset:${D}`]: ['finance'] } } },
    });
    renderApp(`/data/${P}`);
    const row = (await screen.findByRole('link', { name: 'Orders' }, { timeout: LAZY })).closest('tr')!;
    expect(within(row).getByRole('img', { name: 'Data quality: 2 rules failing' })).toBeTruthy();
    expect(within(row).getByText('1,200 rows')).toBeTruthy();
    expect(within(row).getByText('JSON')).toBeTruthy();
    expect(within(row).getByText(/^Refreshes daily · last/)).toBeTruthy();
    expect(within(row).getByRole('img', { name: 'Last refresh failed' })).toBeTruthy();
    expect(within(row).getByText('finance')).toBeTruthy();
    // An editor's row (the stub's default role): the schedule, Watch, Refresh, the Trash.
    expect(await within(row).findByRole('button', { name: 'Watch' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Refresh Orders' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Move Orders to the Trash' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Import file' })).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('shows a viewer the datasets without the controls that change them', async () => {
    serve({
      'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
      'projects:roles': { body: { [P]: 'viewer' } },
      'dataset:list': { body: [ORDERS] },
      'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
    });
    renderApp(`/data/${P}`);
    const row = (await screen.findByRole('link', { name: 'Orders' }, { timeout: LAZY })).closest('tr')!;
    expect(within(row).getByText(/^Refreshes daily · last/)).toBeTruthy(); // what it is stays readable
    await screen.findByRole('link', { name: /Metrics/ });
    for (const name of ['Watch', 'Refresh Orders', 'Move Orders to the Trash', 'Refresh all']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(within(row).queryByRole('combobox')).toBeNull();
    for (const name of ['Import file', 'Paste data', 'New visual', 'Combine']) expect(screen.queryByRole('link', { name })).toBeNull();
  }, 30_000);

  it('tells a viewer of an empty project who can bring data in', async () => {
    serve({ 'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] }, 'projects:roles': { body: { [P]: 'viewer' } }, 'dataset:list': { body: [] }, 'catalog:tags': { body: { ok: true, tags: [], refs: {} } } });
    renderApp(`/data/${P}`);
    expect(await screen.findByText(/An editor of this project can import/, undefined, { timeout: LAZY })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Import file' })).toBeNull();
  }, 30_000);

  it('a 5-minute schedule: its words, the server\'s "Behind schedule", and the fast options only with incremental refresh', async () => {
    const LIVE = { ...ORDERS, id: '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', name: 'Live orders', lastRefreshStatus: 'ok', lastRefreshError: null, qualityFailing: undefined,
      originKind: 'connection', autoRefresh: { every: '5min' }, incrementalOn: true, behindSchedule: true };
    const PLAIN = { ...ORDERS, id: '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', name: 'Plain', lastRefreshStatus: 'ok', lastRefreshError: null, qualityFailing: undefined,
      originKind: 'connection', autoRefresh: { every: 'hourly' } };
    serve({
      'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
      'dataset:list': { body: [LIVE, PLAIN] },
      'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
    });
    renderApp(`/data/${P}`);
    const live = (await screen.findByRole('link', { name: 'Live orders' }, { timeout: LAZY })).closest('tr')!;
    expect(within(live).getByText(/^Refreshes every 5 minutes · last/)).toBeTruthy();
    expect(within(live).getByText('Behind schedule')).toBeTruthy();
    const plain = screen.getByRole('link', { name: 'Plain' }).closest('tr')!;
    expect(within(plain).queryByText('Behind schedule')).toBeNull();

    // One read of the open list: the popover hides itself once jsdom's layout says its anchor is detached.
    fireEvent.click(within(plain).getByRole('combobox', { name: 'Auto-refresh Plain' }));
    const opts = await screen.findAllByRole('option');
    const state = (label: RegExp) => opts.filter((o) => label.test(o.textContent ?? '')).map((o) => `${o.textContent}:${o.getAttribute('aria-disabled') ?? 'on'}`);
    expect(state(/^Every 5 minutes/)).toEqual(['Every 5 minutes — needs incremental refresh:true']);
    expect(state(/^Every 15 minutes/)).toEqual(['Every 15 minutes — needs incremental refresh:true']);
    expect(state(/^Hourly/)).toEqual(['Hourly:on']);
    fireEvent.keyDown(within(plain).getByRole('combobox', { name: 'Auto-refresh Plain' }), { key: 'Escape' });

    fireEvent.click(within(live).getByRole('combobox', { name: 'Auto-refresh Live orders' }));
    const liveOpts = await screen.findAllByRole('option');
    expect(liveOpts.filter((o) => /^Every (5|15) minutes$/.test(o.textContent ?? '') && !o.getAttribute('aria-disabled'))).toHaveLength(2);
  }, 30_000);

  it('designs the empty state, and says so once (no header Import beside it)', async () => {
    serve({ 'projects:list': { body: [] }, 'dataset:list': { body: [] }, 'catalog:tags': { body: { ok: true, tags: [], refs: {} } } });
    renderApp(`/data/${P}`);
    expect(await screen.findByRole('heading', { name: 'No datasets yet' }, { timeout: LAZY })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Import file' })).toHaveLength(1));
  }, 30_000);

  it('a refusal from the catalog is an error state with a retry', async () => {
    serve({ 'projects:list': { body: [] }, 'catalog:list': { body: { ok: false, error: 'The catalog could not be read.', rows: [] } } });
    renderApp(`/data/${P}?tab=catalog`);
    const alert = await screen.findByRole('alert', {}, { timeout: LAZY });
    expect(alert.textContent).toContain('The catalog could not be read.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
  }, 30_000);
});

describe('Live datasets (L2.1)', () => {
  const COLS = { id: D, name: 'Orders live', rowCount: 0, columns: [{ name: 'region', type: 'text' }], mode: 'live' };
  const LIVE = { ...ORDERS, name: 'Orders live', rowCount: 0, originKind: 'connection', lastRefreshStatus: undefined, lastRefreshError: undefined, autoRefresh: undefined, qualityFailing: undefined, mode: 'live', maxCacheAgeSec: 300 };
  const common = {
    'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
    'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
    'lineage:get': { body: null },
    'catalog:columns': { body: { columns: {} } },
  };

  it('a Live row says Live, not "0 rows", and offers no schedule', async () => {
    serve({ ...common, 'dataset:list': { body: [LIVE] } });
    renderApp(`/data/${P}`);
    const row = (await screen.findByRole('link', { name: 'Orders live' }, { timeout: LAZY })).closest('tr')!;
    expect(within(row).getByText('Live')).toBeTruthy();
    expect(within(row).queryByText('0 rows')).toBeNull();
    expect(within(row).queryByRole('combobox')).toBeNull();
  }, 30_000);

  it('the dataset page: a Live badge, the row-reading tabs say why they are off, and no request for rows', async () => {
    const calls = serve({
      ...common,
      'dataset:list': { body: [LIVE] },
      'dataset:columns': { body: COLS },
      'dataset:source': { body: { kind: 'connection', label: 'Connection · Warehouse · orders', refreshable: true, live: true, maxCacheAgeSec: 300 } },
    });
    renderApp(`/data/${P}/${D}`);
    expect(await screen.findByRole('heading', { name: 'Live — the rows stay in the warehouse' }, { timeout: LAZY })).toBeTruthy();
    expect(await screen.findByText('Live · cached up to 5 min')).toBeTruthy();
    // L2.6: Quality, Insights and Snapshots stay as tabs, each saying why it is off and offering a copy.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Quality/ }), { button: 0 });
    expect(await screen.findByRole('heading', { name: 'Quality checks are off for Live datasets' })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Data' }), { button: 0 });
    await screen.findByRole('heading', { name: 'Live — the rows stay in the warehouse' });
    expect(screen.queryByRole('link', { name: 'Prepare' })).toBeNull();
    expect(calls.some((c) => ['dataset:page', 'dataset:stats', 'quality:list', 'insights:list'].includes(c.channel))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Copy the data instead' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'dataset:setMode')?.payload).toEqual({ projectId: P, datasetId: D, mode: 'extract' }));
  }, 30_000);

  it('switching an extract to Live asks first, then sends the confirm', async () => {
    const calls = serve({
      ...common,
      'dataset:list': { body: [{ ...ORDERS, originKind: 'connection' }] },
      'dataset:columns': { body: { ...COLS, name: 'Orders', rowCount: 1200, mode: undefined } },
      'dataset:source': { body: { kind: 'connection', label: 'Connection · Warehouse · orders', refreshable: true, canGoLive: true } },
      'dataset:page': { body: { ok: true, rows: [], total: 0, offset: 0 } },
      'dataset:stats': { body: { ok: true, columns: [] } },
      'dataset:setMode': { body: { ok: true, mode: 'live' } },
    });
    renderApp(`/data/${P}/${D}`);
    await screen.findByText('Connection · Warehouse · orders', {}, { timeout: LAZY }); // the source says it can go Live
    const more = screen.getByRole('button', { name: 'More dataset actions' });
    act(() => more.focus());
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Switch to Live…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Switch to Live?' });
    expect(dialog.textContent).toContain('The stored copy of 1,200 rows is deleted.');
    expect(calls.some((c) => c.channel === 'dataset:setMode')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete the copy and go Live' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'dataset:setMode')?.payload).toEqual({ projectId: P, datasetId: D, mode: 'live', confirmDrop: true }));
  }, 30_000);
});

describe('Columns tab: "Also called"', () => {
  const HEADER = { id: D, name: 'Orders', rowCount: 3, columns: [{ name: 'gross', type: 'number' as const }, { name: 'net_amount', type: 'number' as const }] };
  const SET = 'catalog:setColumn';
  const TAKEN = '"gross" is already what people call Gross Sales.';
  const routes = (more: Record<string, Reply> = {}): Record<string, Reply> => ({
    'catalog:columns': { body: { columns: { gross: { displayName: 'Gross Sales' }, net_amount: { displayName: 'Net Amount', aliases: ['sales'] } } } },
    'dataset:stats': { body: { ok: true, summaries: [], issues: [], filledPct: [] } },
    ...more,
  });
  function renderTab(table: Record<string, Reply>) {
    const calls = serve(table);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ColumnsTab projectId={P} datasetId={D} header={HEADER} />
        <Toaster />
      </QueryClientProvider>,
    );
    return calls;
  }
  const field = async (column: string) => (await screen.findByRole('textbox', { name: `Also called, for ${column}` })) as HTMLInputElement;
  const saves = (calls: { channel: string; payload: unknown }[]) => calls.filter((c) => c.channel === SET).map((c) => c.payload);

  it('saves what was typed as a list of names and shows back what the server stored', async () => {
    const calls = renderTab(routes({ [SET]: { body: { ok: true, column: { displayName: 'Net Amount', aliases: ['Revenue', 'sales'] } } } }));
    const input = await field('net_amount');
    expect(input.value).toBe('sales');
    expect((await field('gross')).value).toBe(''); // a column nobody has named yet: an empty field, not an error
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent)
      .toBe('Also called — Other names people use for this column. The Assistant understands them in questions. Separate names with commas.');
    await waitFor(() => expect(input.readOnly).toBe(false)); // the roles arrived: an editor
    fireEvent.change(input, { target: { value: ' Revenue,  sales ,, revenue' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input); // Enter and the blur after it are ONE save
    await waitFor(() => expect(input.value).toBe('Revenue, sales'));
    expect(saves(calls)).toEqual([{ projectId: P, datasetId: D, column: 'net_amount', patch: { aliases: ['Revenue', 'sales', 'revenue'] } }]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the server\'s refusal at the field, keeps what was typed, and does not send it again', async () => {
    const calls = renderTab(routes({ [SET]: { body: { ok: false, error: TAKEN } } }));
    const input = await field('net_amount');
    await waitFor(() => expect(input.readOnly).toBe(false));
    fireEvent.change(input, { target: { value: 'sales, gross' } });
    fireEvent.blur(input);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(TAKEN);
    expect(screen.getAllByText(TAKEN)).toHaveLength(1); // at the field only — no toast beside it
    expect(input.value).toBe('sales, gross');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
    fireEvent.blur(input);
    expect(saves(calls)).toHaveLength(1);
    // Put right (back to what is stored): the sentence goes, and nothing is sent.
    fireEvent.change(input, { target: { value: 'sales' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(saves(calls)).toHaveLength(1);
  });

  it('sends a refused line again once the field is come back to — the other column may have let the name go', async () => {
    const table = routes({ [SET]: { body: { ok: false, error: TAKEN } } });
    const calls = renderTab(table);
    const input = await field('net_amount');
    await waitFor(() => expect(input.readOnly).toBe(false));
    fireEvent.change(input, { target: { value: 'sales, gross' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByRole('alert');
    fireEvent.blur(input); // leaving for the other column: the refused line is not sent a second time
    expect(saves(calls)).toHaveLength(1);
    table[SET] = { body: { ok: true, column: { aliases: ['sales', 'gross'] } } }; // gross is no longer called that
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' }); // the very line that was refused, untouched
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(saves(calls)).toHaveLength(2);
    expect(input.value).toBe('sales, gross');
    expect(input.title).toBe('sales, gross'); // a list longer than the cell is still readable, by a viewer too
  });

  it('does not write the server\'s reply over what was typed while it saved', async () => {
    renderTab(routes({ [SET]: { body: { ok: true, column: { aliases: ['top line'] } } } }));
    const input = await field('gross');
    await waitFor(() => expect(input.readOnly).toBe(false));
    // Hold the reply until more has been typed.
    const answer = globalThis.fetch;
    let release = () => {};
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('setColumn')) await new Promise<void>((go) => (release = go));
      return answer(url, init);
    });
    fireEvent.change(input, { target: { value: 'top line' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.getAttribute('aria-busy')).toBe('true'));
    fireEvent.change(input, { target: { value: 'top line, turn' } });
    release();
    await waitFor(() => expect(input.getAttribute('aria-busy')).toBeNull());
    expect(input.value).toBe('top line, turn');
  });

  it('a display name another column is also called: the sentence is said, and the cell goes back to what is stored', async () => {
    const REFUSED = '"Sales" is already what people call Net Amount.';
    const calls = renderTab(routes({ [SET]: { body: { ok: false, error: REFUSED } } }));
    const input = (await screen.findByRole('textbox', { name: 'Display name of gross' })) as HTMLInputElement;
    await waitFor(() => expect(input.readOnly).toBe(false));
    fireEvent.change(input, { target: { value: 'Sales' } });
    fireEvent.blur(input);
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    await waitFor(() => expect(input.value).toBe('Gross Sales'));
    fireEvent.change(input, { target: { value: 'Sales' } }); // typed again, it is asked again — never taken for saved
    fireEvent.blur(input);
    await waitFor(() => expect(saves(calls)).toHaveLength(2));
  });

  it('says the limits at the field instead of sending a list the server would refuse', async () => {
    const calls = renderTab(routes());
    const input = await field('gross');
    await waitFor(() => expect(input.readOnly).toBe(false));
    fireEvent.change(input, { target: { value: 'a, b, c, d, e, f, g, h, i' } });
    fireEvent.blur(input);
    expect((await screen.findByRole('alert')).textContent).toBe('A column can have at most 8 other names.');
    fireEvent.change(input, { target: { value: 'x'.repeat(61) } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A name can be at most 60 characters.'));
    expect(saves(calls)).toHaveLength(0);
  });

  it('shows a viewer the names, and every note, with nothing to change', async () => {
    const calls = renderTab(routes({ 'projects:roles': { body: { [P]: 'viewer' } } }));
    const input = await field('net_amount');
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    await act(async () => {}); // the roles reply settles: still a viewer
    expect(input.value).toBe('sales');
    for (const name of ['Also called, for net_amount', 'Also called, for gross', 'Display name of net_amount', 'Description of net_amount', 'Example of net_amount']) {
      expect((screen.getByRole('textbox', { name }) as HTMLInputElement).readOnly).toBe(true);
    }
    expect((screen.getByRole('combobox', { name: 'Sensitivity of net_amount' }) as HTMLButtonElement).disabled).toBe(true);
    expect((await field('gross')).placeholder).toBe('—'); // no invitation to add one
    fireEvent.blur(input);
    expect(saves(calls)).toHaveLength(0);
  });

  it('the column Details popover, which edits the display name, shows the names beside it — to read, not to edit', async () => {
    serve({});
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ColumnDetails projectId={P} datasetId={D} column="net_amount" doc={{ displayName: 'Net Amount', aliases: ['sales', 'revenue'] }} trigger={<button type="button">Notes</button>} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    const pop = await screen.findByRole('dialog', { name: 'Details for column net_amount' });
    expect((within(pop).getByRole('textbox', { name: 'Display name' }) as HTMLInputElement).value).toBe('Net Amount');
    expect(within(pop).getByText('sales, revenue')).toBeTruthy();
    expect(within(pop).queryByRole('textbox', { name: /Also called/ })).toBeNull();
  });

  it('the Details popover puts a refused display name back, with a description saved in the same breath', async () => {
    const calls = serve({ [SET]: { body: { ok: false, error: '"Sales" is already what people call gross.' } } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ColumnDetails projectId={P} datasetId={D} column="net_amount" doc={{ displayName: 'Net Amount' }} trigger={<button type="button">Notes</button>} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    const pop = await screen.findByRole('dialog', { name: 'Details for column net_amount' });
    const name = within(pop).getByRole('textbox', { name: 'Display name' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Sales' } });
    fireEvent.blur(name);
    fireEvent.change(within(pop).getByRole('textbox', { name: 'Description' }), { target: { value: 'After discounts' } });
    fireEvent.blur(within(pop).getByRole('textbox', { name: 'Description' })); // a second write before the first is answered
    await waitFor(() => expect(name.value).toBe('Net Amount'));
    expect(saves(calls)).toHaveLength(2);
  });
});

describe('Data helpers', () => {
  it('words a rule as the desktop does', () => {
    expect(ruleWords({ kind: 'not_null', column: 'day', args: {}, severity: 'fail' })).toBe('day is never empty');
    expect(ruleWords({ kind: 'range', column: 'discount', args: { min: 0, max: 1 }, severity: 'warn' })).toBe('discount is between 0 and 1');
    expect(ruleWords({ kind: 'regex', column: 'email', args: { preset: 'email' }, severity: 'fail' })).toBe('email matches Email');
    expect(ruleWords({ kind: 'in_set', column: 'r', args: { values: ['a', 'b', 'c', 'd', 'e'] }, severity: 'fail' })).toBe('r is one of a, b, c and 2 more');
    expect(ruleWords({ kind: 'references', column: 'r', args: { datasetId: 'x', column: 'id' }, severity: 'fail' }, new Map([['x', 'Regions']]))).toBe('r exists in Regions.id');
  });

  it('offers only the columns a kind can run on', () => {
    const cols = [{ name: 'a', type: 'text' as const }, { name: 'b', type: 'number' as const }, { name: 'c', type: 'date' as const }];
    expect(columnsFor('range', cols).map((c) => c.name)).toEqual(['b', 'c']);
    expect(columnsFor('regex', cols).map((c) => c.name)).toEqual(['a', 'c']);
  });

  it('lays a lookup out one lane right of what reads it; the unrelated last', () => {
    const rel = (from: string, to: string) => ({ id: `${from}${to}`, from: { datasetId: from, column: 'k' }, to: { datasetId: to, column: 'k' } }) as Relationship;
    expect(laneLayout(['f', 'r', 'c', 'x'], [rel('f', 'r'), rel('r', 'c')])).toEqual({ lanes: [['f'], ['r'], ['c']], loose: ['x'] });
  });

  it('words a cadence and greys the fast ones without incremental refresh', () => {
    expect(everyWord('5min')).toBe('every 5 minutes');
    expect(everyWord('15min')).toBe('every 15 minutes');
    expect(everyWord('daily')).toBe('daily');
    expect(freshness({ updatedAt: '2026-10-01T10:00:00Z', sourceKind: 'json', originKind: 'connection', autoRefresh: { every: '15min' } })).toMatch(/^Refreshes every 15 minutes · last /);
    const off = cadenceOptions(SCHEDULES, false);
    expect(off.filter((o) => o.disabled).map((o) => o.value)).toEqual(['5min', '15min']);
    expect(off.find((o) => o.value === '5min')?.label).toBe('Every 5 minutes — needs incremental refresh');
    expect(cadenceOptions(SCHEDULES, true).some((o) => o.disabled)).toBe(false);
    expect(cadenceOptions(SCHEDULES, true).map((o) => o.value)).toEqual(['off', '5min', '15min', 'hourly', 'daily', 'weekly']);
  });

  it('formats without computing', () => {
    expect(normTag('  #Sales Team! ')).toBe('sales-team');
    expect(pctText(91.7)).toBe('91.7%');
    expect(freshness({ updatedAt: '2026-10-01T10:00:00Z', sourceKind: 'paste' })).toMatch(/^Imported /);
    const b = document.createElement('button');
    expect(fromControl(b)).toBe(true);
    expect(fromControl(document.createElement('td'))).toBe(false);
  });
});
