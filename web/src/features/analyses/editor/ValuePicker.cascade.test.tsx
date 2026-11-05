// A picker below a higher level of its hierarchy asks the server for the values under the parent's pick (p6-05).
// NEGATIVE CONTROLS: a capped list claims nothing about a pick it lacks; a picker with no siblings never asks
// model:navigation; an unnarrowed Live reply tags nothing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Card, ControlValue } from '../api';
import { ControlWidget } from './ControlWidget';
import type { Sibling } from './cascade';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
type Control = NonNullable<Card['control']>;
const state = { kind: 'dropdown', datasetId: D, column: 'state', label: 'State' } as Control;
const region = { kind: 'dropdown', datasetId: D, column: 'region', label: 'Region' } as Control;
const west: Sibling = { control: region, value: { value: 'West' } };
const NAV = { ok: true, tables: [{ datasetId: D, hierarchies: [{ id: 'g', name: 'Geography', levels: ['region', 'state'] }] }], dateLadder: [] };

function serve(reply: Record<string, unknown>) {
  const calls: Array<{ channel: string; input: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const channel = decodeURIComponent(String(url).split('?')[0].slice('/api/rpc/'.length));
      if (channel === 'projects:roles') return new Response(JSON.stringify({ [P]: 'admin' }), { status: 200 });
      calls.push({ channel, input: (JSON.parse(String(init?.body)) as { args: Array<Record<string, unknown>> }).args[0] });
      return new Response(JSON.stringify(channel === 'model:navigation' ? NAV : reply), { status: 200 });
    }),
  );
  return calls;
}

function draw(value: ControlValue | undefined, siblings: Sibling[] | undefined) {
  const changes: Array<ControlValue | undefined> = [];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ControlWidget projectId={P} control={state} value={value} siblings={siblings} onChange={(v) => changes.push(v)} />
    </QueryClientProvider>,
  );
  return changes;
}
const panel = () => screen.getByRole('group', { name: 'State values' });
const count = (calls: Array<{ channel: string }>, ch: string) => calls.filter((c) => c.channel === ch).length;

describe('the cascading picker', () => {
  it('opens narrowed: sends the parent step, loads model:navigation once, and says what it narrowed to', async () => {
    const calls = serve({ values: ['CA', 'OR'], total: 2 });
    draw(undefined, [west]);
    expect(count(calls, 'model:navigation')).toBe(0); // not with the page
    fireEvent.click(await screen.findByRole('button', { name: 'State: All' }));
    await screen.findByText('Narrowed to Region: West');
    expect(count(calls, 'model:navigation')).toBe(1);
    const last = calls.filter((c) => c.channel === 'dataset:distinct').at(-1)!;
    expect(last.input.filters).toEqual([{ type: 'filter', column: 'region', op: '=', value: 'West' }]);
  });

  it('a stored pick the region rules out sits on top as "not in West", and Clear removes it', async () => {
    serve({ values: ['CA', 'OR'], total: 2 });
    const changes = draw({ value: 'Ohio' }, [west]);
    fireEvent.click(await screen.findByRole('button', { name: 'State: Ohio' }));
    await screen.findByText('not in West');
    expect(within(panel()).getAllByRole('button')[1].textContent).toBe('Ohio');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Clear Ohio' }));
    expect(changes).toEqual([undefined]);
  });

  it('NEGATIVE: on a capped list the pick is pinned with no claim', async () => {
    serve({ values: ['CA', 'OR'], total: 50 });
    draw({ value: 'Ohio' }, [west]);
    fireEvent.click(await screen.findByRole('button', { name: 'State: Ohio' }));
    await screen.findByText(/Showing the first 2 of 50/);
    expect(within(panel()).getByRole('button', { name: 'Ohio' })).toBeTruthy();
    expect(screen.queryByText('not in West')).toBeNull();
  });

  it('a Live list that cannot be narrowed says so and tags nothing', async () => {
    serve({ values: ['CA', 'OR'], total: 2, approximate: true, sampleRows: 100, narrowed: false });
    draw({ value: 'Ohio' }, [west]);
    fireEvent.click(await screen.findByRole('button', { name: 'State: Ohio' }));
    await screen.findByText('Not narrowed by Region: values come from a sample');
    expect(screen.queryByText('not in West')).toBeNull();
    expect(screen.queryByText('Narrowed to Region: West')).toBeNull();
  });

  it('NEGATIVE: with no siblings (the control dialog preview) it never asks model:navigation or sends filters', async () => {
    const calls = serve({ values: ['CA'], total: 1 });
    draw(undefined, undefined);
    fireEvent.click(await screen.findByRole('button', { name: 'State: All' }));
    await waitFor(() => within(panel()).getByRole('button', { name: 'CA' }));
    expect(count(calls, 'model:navigation')).toBe(0);
    expect(calls.every((c) => !('filters' in c.input))).toBe(true);
  });
});
