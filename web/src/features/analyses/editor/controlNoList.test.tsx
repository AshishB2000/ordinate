// A dashboard control over a Live column with no list of values (docs/live-data/
// log.md, L2.6's leftover): the widget says which case it is and, in its panel,
// the server's sentence; an editor gets "Sync schema" where a sync can list the
// values, a viewer the sentence only. Never an empty menu.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveRefusalError } from '../../live/refusal';
import type { Card } from '../api';
import { ControlWidget, noListOf } from './ControlWidget';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const NOT_SYNCED = 'This Live dataset has not been synced yet, so there is no list of values for this column. Sync its schema to list them.';
const NOT_SAMPLED = 'The last schema sync read no sample of this column, so there is no list of its values. Sync the schema again to list them.';
const NOT_LISTED = 'The values of this column are not listed: a Live dataset keeps a list only for a text column with up to 50 different values.';
const refusal = (reason: string, error: string) => ({ ok: false, code: 'live_refused', reason, error });
const LIST = { values: ['North', 'South'], total: 2, approximate: true, sampleRows: 240 };
const SYNCED = { ok: true, status: 'synced', columns: 3, added: [], removed: [], retyped: [], missing: [], sample: { ok: true, rows: 240 } };

type Control = NonNullable<Card['control']>;

/** Draws one control; `distinct` answers each `dataset:distinct` in turn (the last one repeats). Returns the channels called. */
function draw(kind: 'dropdown' | 'multi', distinct: unknown[], role: 'admin' | 'viewer' = 'admin', sync: unknown = SYNCED, status = 200): string[] {
  const calls: string[] = [];
  let asked = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const channel = decodeURIComponent(url.split('?')[0].slice('/api/rpc/'.length));
      calls.push(channel);
      if (channel === 'projects:roles') return new Response(JSON.stringify({ [P]: role }), { status: 200 });
      if (channel === 'dataset:syncLiveSchema') return new Response(JSON.stringify(sync), { status: 200 });
      return new Response(JSON.stringify(distinct[Math.min(asked++, distinct.length - 1)]), { status });
    }),
  );
  const control = { kind, datasetId: D, column: 'region', label: 'Region' } as Control;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ControlWidget projectId={P} control={control} value={undefined} onChange={() => undefined} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('a control over a Live column with no list of values', () => {
  it('not synced yet, an editor: says so, the server’s sentence, and Sync schema — which refetches the values', async () => {
    const calls = draw('dropdown', [refusal('notSynced', NOT_SYNCED), LIST]);
    const chip = await screen.findByRole('button', { name: 'Region: not synced yet' });
    expect(chip.textContent).toBe('Not synced yet');
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(chip);
    expect(await screen.findByText(NOT_SYNCED)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync schema' }));
    const menu = await screen.findByRole('combobox', { name: 'Region' });
    await waitFor(() => expect([...menu.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['All', 'North', 'South']));
    expect(calls.filter((c) => c === 'dataset:syncLiveSchema')).toHaveLength(1);
    expect(calls.filter((c) => c === 'dataset:distinct')).toHaveLength(2);
  });

  it('not synced yet, a viewer: the sentence only', async () => {
    const calls = draw('dropdown', [refusal('notSynced', NOT_SYNCED)], 'viewer');
    fireEvent.click(await screen.findByRole('button', { name: 'Region: not synced yet' }));
    expect(await screen.findByText(NOT_SYNCED)).toBeTruthy();
    await waitFor(() => expect(calls).toContain('projects:roles'));
    expect(screen.queryByRole('button', { name: 'Sync schema' })).toBeNull();
  });

  it('values not sampled (a multi-select): says so, and a sync that still reads no sample says why', async () => {
    const failed = { ...SYNCED, sample: { ok: false, error: 'The columns were synced, but the warehouse did not answer the sample query.' } };
    draw('multi', [refusal('notSampled', NOT_SAMPLED)], 'admin', failed);
    fireEvent.click(await screen.findByRole('button', { name: 'Region: values not sampled' }));
    expect(await screen.findByText(NOT_SAMPLED)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Sync schema' }));
    expect(await screen.findByText(/did not answer the sample query/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Region: values not sampled' })).toBeTruthy();
  });

  it('too many values to list: says so and what an editor can do — no sync, it would not list them', async () => {
    draw('dropdown', [refusal('notListed', NOT_LISTED)]);
    const chip = await screen.findByRole('button', { name: 'Region: values not listed' });
    expect(chip.getAttribute('data-no-list')).toBe('notListed');
    fireEvent.click(chip);
    expect(await screen.findByText(NOT_LISTED)).toBeTruthy();
    expect(await screen.findByText(/another kind, or a column with fewer values/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sync schema' })).toBeNull();
  });

  it('NEGATIVE CONTROL: a listed column is the ordinary menu, and nothing is retried', async () => {
    const calls = draw('dropdown', [LIST]);
    const menu = await screen.findByRole('combobox', { name: 'Region' });
    await waitFor(() => expect(menu.querySelectorAll('option')).toHaveLength(3));
    expect(document.querySelector('[data-no-list]')).toBeNull();
    expect(calls.filter((c) => c === 'dataset:distinct')).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: any other failure stays the menu’s own "values unavailable"', async () => {
    draw('dropdown', [{ error: 'handler failed' }], 'admin', SYNCED, 500);
    expect(await screen.findByRole('option', { name: 'All (values unavailable)' })).toBeTruthy();
    expect(document.querySelector('[data-no-list]')).toBeNull();
  });

  it('noListOf reads only the three reasons', () => {
    expect(noListOf(new LiveRefusalError('live_refused', NOT_SYNCED, 'notSynced'))?.reason).toBe('notSynced');
    expect(noListOf(new LiveRefusalError('live_refused', 'A pivot table cannot be drawn from a Live dataset yet.', 'pivot'))).toBeNull();
    expect(noListOf(new LiveRefusalError('live_dataset', 'Off for Live.'))).toBeNull();
    expect(noListOf(new Error(NOT_SYNCED))).toBeNull();
  });
});
