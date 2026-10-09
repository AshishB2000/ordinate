import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IncrementalButton, type IncrementalTarget } from './Incremental';
import { lookbackFields, splitLookback, type IncrementalView } from './incrementalApi';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D: IncrementalTarget = { id: '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', name: 'Orders', originKind: 'connection' };

const VIEW: IncrementalView = {
  ok: true,
  blocked: null,
  settings: null,
  log: [],
  cursorColumns: [{ name: 'id', type: 'number' }, { name: 'updated_at', type: 'date' }],
  keyColumns: ['id', 'updated_at', 'region'],
  fetch: 'server',
  source: 'PostgreSQL',
  fullEvery: 7,
  nextFull: null,
};

/** fetch answered per RPC channel; records each call's payload. */
function serve(routes: Record<string, unknown>) {
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const channel = decodeURIComponent(url.split('?')[0].slice('/api/rpc/'.length));
    calls.push({ channel, payload: init?.body ? (JSON.parse(String(init.body)) as { args: Record<string, unknown>[] }).args[0] : {} });
    return new Response(JSON.stringify(routes[channel] ?? null), { status: 200 });
  }));
  return calls;
}

function draw(d: IncrementalTarget = D) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IncrementalButton projectId={P} d={d} />
    </QueryClientProvider>,
  );
}

const pick = (name: string | RegExp, option: string | RegExp) => {
  fireEvent.click(screen.getByRole('combobox', { name }));
  fireEvent.click(screen.getByRole('option', { name: option }));
};

describe('Incremental refresh', () => {
  it('a lookback is shown in the largest whole unit', () => {
    expect(splitLookback(0)).toEqual({ amount: '0', unit: '3600' });
    expect(splitLookback(172_800)).toEqual({ amount: '2', unit: '86400' });
    expect(splitLookback(5400)).toEqual({ amount: '90', unit: '60' });
  });

  it('only for a dataset from a connection, and never for a Live one; says on or off', () => {
    serve({});
    const a = draw({ ...D, originKind: 'url' });
    expect(screen.queryByRole('button')).toBeNull();
    a.unmount();
    const b = draw({ ...D, mode: 'live' });
    expect(screen.queryByRole('button')).toBeNull();
    b.unmount();
    draw({ ...D, incrementalOn: true });
    expect(screen.getByRole('button', { name: 'Incremental refresh for Orders: on' }).textContent).toContain('Incremental on');
  });

  it('turns it on by key: the cursor from the server\'s columns, the lookback in seconds', async () => {
    const calls = serve({ 'incremental:get': VIEW, 'incremental:set': { ...VIEW, settings: { enabled: true, cursorColumn: 'updated_at', keyColumn: 'id', lookback: 7200, highWater: null, runsSinceFull: 0, lastFullAt: null, lastRunAt: null }, nextFull: 'The first run sets the high-water mark' } });
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'Incremental refresh for Orders: off' }));
    const dialog = await screen.findByRole('dialog', { name: 'Incremental refresh · Orders' });
    await within(dialog).findByText(/Each run asks PostgreSQL only for rows at or past the mark/);
    expect(within(dialog).getByText('No runs yet. The first refresh is a full one: it reads the whole source and sets the mark.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Refresh incrementally' }));
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Cursor column' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['id · number', 'updated_at · date']);
    fireEvent.click(screen.getByRole('option', { name: 'updated_at · date' }));
    pick('Key column', 'id');
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Lookback' }), { target: { value: '2' } });
    expect(within(dialog).getByRole('combobox', { name: 'Lookback unit' }).textContent).toContain('hours');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'incremental:set')).toBeTruthy());
    expect(calls.find((c) => c.channel === 'incremental:set')?.payload).toEqual({ projectId: P, datasetId: D.id, enabled: true, cursorColumn: 'updated_at', mode: 'upsert', keyColumn: 'id', lookback: 7200 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('append takes no key, and a number cursor\'s lookback is a count of ids', async () => {
    const calls = serve({ 'incremental:get': VIEW, 'incremental:set': VIEW });
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Incremental refresh for Orders/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('switch', { name: 'Refresh incrementally' });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Refresh incrementally' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: /Append new rows/ }));
    expect(within(dialog).queryByRole('combobox', { name: 'Key column' })).toBeNull();
    expect(within(dialog).getByText('ids')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Lookback' }), { target: { value: '50' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'incremental:set')?.payload).toEqual({ projectId: P, datasetId: D.id, enabled: true, cursorColumn: 'id', mode: 'append', lookback: 50 }));
  });

  it('shows the server\'s refusal in words, and keeps the panel open', async () => {
    serve({ 'incremental:get': VIEW, 'incremental:set': { ok: false, error: 'Pick a number or date column of this dataset as the cursor.' } });
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Incremental refresh for Orders/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('switch', { name: 'Refresh incrementally' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: /Append new rows/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Pick a number or date column of this dataset as the cursor.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a source that cannot take the cursor: "filtered after fetch", and nothing to turn on', async () => {
    serve({ 'incremental:get': { ...VIEW, blocked: 'ClickHouse cannot filter by a column, so every incremental run would still read the whole source and filter after the fetch. Use a refresh schedule for it instead.', fetch: 'after', source: 'ClickHouse' } });
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Incremental refresh for Orders/ }));
    const dialog = await screen.findByRole('dialog');
    const note = await within(dialog).findByRole('note');
    expect(note.textContent).toMatch(/^Filtered after fetch\. ClickHouse cannot filter by a column/);
    expect(within(dialog).getByRole('switch', { name: 'Refresh incrementally' }).hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('on over a connection since deleted: says why, without "filtered after fetch", and can only be turned off', async () => {
    const gone = 'The connection this dataset was imported from is gone, so it cannot refresh incrementally.';
    const settings = { enabled: true, cursorColumn: 'updated_at', keyColumn: 'id', lookback: 3600, highWater: '2026-10-09', runsSinceFull: 2, lastFullAt: null, lastRunAt: null };
    const calls = serve({ 'incremental:get': { ...VIEW, blocked: gone, fetch: null, source: '', settings }, 'incremental:set': { ...VIEW, blocked: gone, fetch: null, source: '', settings: { ...settings, enabled: false } } });
    draw({ ...D, incrementalOn: true });
    fireEvent.click(screen.getByRole('button', { name: /Incremental refresh for Orders/ }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('note')).textContent).toBe(gone);
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Refresh incrementally' }));
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.channel === 'incremental:set')?.payload).toEqual({ projectId: P, datasetId: D.id, enabled: false, cursorColumn: 'updated_at', mode: 'upsert', keyColumn: 'id', lookback: 3600 }));
  });

  it('draws the run log and the next full run from the record', async () => {
    serve({
      'incremental:get': {
        ...VIEW,
        settings: { enabled: true, cursorColumn: 'id', keyColumn: 'id', lookback: 0, highWater: 1204, runsSinceFull: 6, lastFullAt: null, lastRunAt: null },
        nextFull: 'Every 7th run is a full refresh',
        log: [
          { at: '2026-10-09T01:05:00.000Z', mode: 'incremental', fetched: 12, inserted: 10, updated: 2, highWater: 1204, how: 'server' },
          { at: '2026-10-09T01:00:00.000Z', mode: 'full', fetched: 1192, inserted: null, updated: null, highWater: 1192, how: 'full', note: 'The first run sets the high-water mark' },
        ],
      },
    });
    draw({ ...D, incrementalOn: true });
    fireEvent.click(screen.getByRole('button', { name: /Incremental refresh for Orders/ }));
    const dialog = await screen.findByRole('dialog');
    const log = await within(dialog).findByRole('table', { name: 'Refresh log' });
    const rows = within(log).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(within(log).getAllByRole('row')[1].querySelectorAll('td')[1].textContent).toBe('Incrementalfiltered at the source');
    expect(rows[0]).toContain('1,204');
    expect(within(log).getAllByRole('row')[2].querySelectorAll('td')[1].textContent).toBe('FullThe first run sets the high-water mark');
    expect(rows[1]).toContain('1,192');
    expect(within(dialog).getByText('Next refresh: full')).toBeTruthy();
    expect(within(dialog).getByText('Every 7th run is a full refresh.')).toBeTruthy();
  });

  it('a stored lookback reads back in its cursor\'s unit: ids for a number cursor, the largest whole unit for a date one', async () => {
    expect(lookbackFields(5, 'number')).toEqual({ amount: '5', unit: '3600' });
    expect(lookbackFields(120, 'number')).toEqual({ amount: '120', unit: '3600' });
    expect(lookbackFields(7200, 'date')).toEqual({ amount: '2', unit: '3600' });
    const settings = { enabled: true, cursorColumn: 'id', keyColumn: 'id', lookback: 120, highWater: 1204, runsSinceFull: 1, lastFullAt: null, lastRunAt: null };
    const calls = serve({ 'incremental:get': { ...VIEW, settings }, 'incremental:set': { ...VIEW, settings } });
    draw({ ...D, incrementalOn: true });
    fireEvent.click(screen.getByRole('button', { name: /Incremental refresh for Orders/ }));
    const dialog = await screen.findByRole('dialog');
    const amount = await within(dialog).findByRole('spinbutton', { name: 'Lookback' });
    expect((amount as HTMLInputElement).value).toBe('120');
    expect(within(dialog).getByText('ids')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'incremental:set')?.payload).toEqual({ projectId: P, datasetId: D.id, enabled: true, cursorColumn: 'id', mode: 'upsert', keyColumn: 'id', lookback: 120 }));
  });

  it('a negative lookback cannot be saved', async () => {
    serve({ 'incremental:get': VIEW });
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Incremental refresh for Orders/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('switch', { name: 'Refresh incrementally' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: /Append new rows/ }));
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Lookback' }), { target: { value: '-3' } });
    expect(save.hasAttribute('disabled')).toBe(true);
  });

  it('a refused read is the error state', async () => {
    serve({ 'incremental:get': { ok: false, error: 'Could not read the incremental refresh settings.' } });
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Incremental refresh for Orders/ }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByText('The settings could not be loaded'))).toBeTruthy();
    expect(within(dialog).getByText('Could not read the incremental refresh settings.')).toBeTruthy();
  });
});
