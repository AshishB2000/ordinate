// The value picker of a dropdown / multi control (docs/dashboard-filters/
// 00-design.md) over a 250-value column the server caps at 200: the note line
// carries the server's total, typing searches in ONE debounced request, a
// current value outside the list is pinned at the top, and a Live column's
// sample says so and lets typed text be used. NEGATIVE CONTROL: an extract,
// whose search is exhaustive, never offers "Use".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { Card, ControlValue } from '../api';
import { ControlWidget } from './ControlWidget';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const ALL = Array.from({ length: 250 }, (_, i) => `V${String(i + 1).padStart(3, '0')}`);
type Control = NonNullable<Card['control']>;

/** `dataset:distinct` as the server answers it: searched, capped at the limit, with the pre-cap total. */
function serve(live?: { sampleRows: number; values: string[] }) {
  const asked: Array<{ search?: string; limit?: number }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const channel = decodeURIComponent(String(url).split('?')[0].slice('/api/rpc/'.length));
      if (channel === 'projects:roles') return new Response(JSON.stringify({ [P]: 'admin' }), { status: 200 });
      const input = (JSON.parse(String(init?.body)) as { args: Array<{ search?: string; limit?: number }> }).args[0];
      asked.push(input);
      const pool = live ? live.values : ALL;
      const hits = input.search ? pool.filter((v) => v.toLowerCase().includes(input.search!.toLowerCase())) : pool;
      const body = { values: hits.slice(0, input.limit ?? 200), total: hits.length, ...(live ? { approximate: true, sampleRows: live.sampleRows } : {}) };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return asked;
}

/** The control in a host that keeps its value, as the editor does; every change is recorded. */
function draw(kind: 'dropdown' | 'multi', initial?: ControlValue) {
  const changes: Array<ControlValue | undefined> = [];
  function Host() {
    const [v, setV] = useState<ControlValue | undefined>(initial);
    const control = { kind, datasetId: D, column: 'code', label: 'Code' } as Control;
    return (
      <ControlWidget
        projectId={P}
        control={control}
        value={v}
        onChange={(next) => {
          changes.push(next);
          setV(next);
        }}
      />
    );
  }
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Host />
    </QueryClientProvider>,
  );
  return changes;
}

const panel = () => screen.getByRole('group', { name: 'Code values' });
const sleep = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('a dropdown / multi control’s value picker', () => {
  it('lists the first 200 and says how many there are, from the server’s total', async () => {
    const asked = serve();
    draw('dropdown');
    fireEvent.click(await screen.findByRole('button', { name: 'Code: All' }));
    await screen.findByText('Showing the first 200 of 250 — search to narrow.');
    expect(within(panel()).getAllByRole('button')).toHaveLength(201); // All + 200
    expect(asked).toEqual([{ projectId: P, datasetId: D, column: 'code', limit: 200 }]);
  });

  it('four keystrokes send ONE searched request, debounced; the search box is capped at the server’s 200 characters', async () => {
    const asked = serve();
    draw('dropdown');
    fireEvent.click(await screen.findByRole('button', { name: 'Code: All' }));
    const box = await screen.findByRole('searchbox', { name: 'Search values' });
    expect(box.getAttribute('maxlength')).toBe('200');
    for (const t of ['V', 'V2', 'V24', 'V249']) fireEvent.change(box, { target: { value: t } });
    await within(panel()).findByRole('button', { name: 'V249' });
    await sleep(400);
    expect(asked.filter((a) => a.search !== undefined)).toEqual([{ projectId: P, datasetId: D, column: 'code', limit: 200, search: 'V249' }]);
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it('a dropdown: a pick sets the value and closes; All clears it', async () => {
    serve();
    const changes = draw('dropdown');
    fireEvent.click(await screen.findByRole('button', { name: 'Code: All' }));
    fireEvent.click(await within(panel()).findByRole('button', { name: 'V002' }));
    expect(changes).toEqual([{ value: 'V002' }]);
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Code values' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Code: V002' }));
    expect(within(panel()).getByRole('button', { name: 'V002' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(panel()).getByRole('button', { name: 'All' }));
    expect(changes).toEqual([{ value: 'V002' }, undefined]);
  });

  it('a current value outside the first 200 is pinned at the top, picked', async () => {
    serve();
    draw('dropdown', { value: 'V249' });
    fireEvent.click(await screen.findByRole('button', { name: 'Code: V249' }));
    await screen.findByText(/Showing the first 200/);
    const rows = within(panel()).getAllByRole('button');
    expect(rows.slice(0, 3).map((b) => b.textContent)).toEqual(['All', 'V249', 'V001']);
    expect(rows[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('a multi: checkboxes add and remove; the last one off is All', async () => {
    serve();
    const changes = draw('multi');
    fireEvent.click(await screen.findByRole('button', { name: 'Code: All' }));
    // Narrowed first: nine rows re-render per click, not two hundred.
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search values' }), { target: { value: 'V00' } });
    await waitFor(() => expect(within(panel()).getAllByRole('checkbox')).toHaveLength(9));
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'V003' }));
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'V007' }));
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'V003' }));
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'V007' }));
    expect(changes).toEqual([{ values: ['V003'] }, { values: ['V003', 'V007'] }, { values: ['V007'] }, undefined]);
  });

  it('a Live column: the sample is named, and text it does not list can be used — on a multi it is appended', async () => {
    serve({ sampleRows: 240, values: ['North', 'South'] });
    const changes = draw('multi', { values: ['North'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Code: North' }));
    await screen.findByText('Values from a sample of 240 rows.');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search values' }), { target: { value: 'Northeast ' } });
    fireEvent.click(await within(panel()).findByRole('button', { name: 'Use “Northeast ”' }));
    expect(changes).toEqual([{ values: ['North', 'Northeast '] }]); // typed text is not trimmed
  });

  it('a Live dropdown: Use sets the value', async () => {
    serve({ sampleRows: 240, values: ['North', 'South'] });
    const changes = draw('dropdown');
    fireEvent.click(await screen.findByRole('button', { name: 'Code: All' }));
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search values' }), { target: { value: 'West' } });
    fireEvent.click(await within(panel()).findByRole('button', { name: 'Use “West”' }));
    expect(changes).toEqual([{ value: 'West' }]);
  });

  it('NEGATIVE CONTROL: an extract never offers Use — its search is exhaustive', async () => {
    serve();
    draw('dropdown');
    fireEvent.click(await screen.findByRole('button', { name: 'Code: All' }));
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search values' }), { target: { value: 'Zed' } });
    await screen.findByText('No value matches “Zed”.');
    expect(screen.queryByText(/^Use “/)).toBeNull();
    expect(screen.queryByText(/sample of/)).toBeNull();
  });
});
