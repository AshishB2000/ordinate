// Click-to-filter through the whole editor, as a VIEWER (readOnly) — the path
// the Playwright spec for viewers needs Postgres to reach. A click on a mark of
// one chart must:
//   · filter every OTHER card — its step is in their `analysis:tiles` request;
//   · leave the clicked chart whole — the step is NOT in its own request;
//   · show the chip, and go away on Esc;
//   · write nothing: no `analysis:update` (or any other write) is ever sent.
// The figures are the server's: this only reads what the browser ASKED for.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { decode } from '../../../../../src/server/wire.ts';
import type { Analysis, VisualDef } from '../api';
import { Editor } from './Editor';

// The hit-test needs Chart.js on a real canvas; every click here lands on the "West" mark.
vi.mock('../../visuals/drill/mark', () => ({ markAt: () => ({ category: 'West' }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const A = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const visual = (id: string, name: string, category: string): VisualDef => ({ id, name, datasetId: D, chartType: 'column', encoding: { category, values: [{ column: 'amount', aggregation: 'sum' }] }, overrides: {}, filters: [], updatedAt: '' });
const VISUALS = [visual('v-region', 'Amount by region', 'region'), visual('v-month', 'Amount by month', 'month')];

function analysis(clickFilter: boolean | undefined): Analysis {
  return {
    id: A,
    projectId: P,
    name: 'Weekly review',
    filters: [],
    style: {},
    parameters: [],
    updatedAt: '',
    sheets: [
      {
        id: 's1',
        name: 'Overview',
        ...(clickFilter === undefined ? {} : { clickFilter }),
        cards: [
          { id: 'card-region', type: 'visual', layout: { x: 0, y: 0, w: 6, h: 6 }, visualId: 'v-region' },
          { id: 'card-month', type: 'visual', layout: { x: 6, y: 0, w: 6, h: 6 }, visualId: 'v-month' },
          { id: 'card-kpi', type: 'metric', layout: { x: 0, y: 6, w: 3, h: 2 }, metric: { datasetId: D, column: 'amount', aggregation: 'sum', label: 'Revenue' } },
        ],
      },
    ],
  };
}

type Item = { kind: string; encoding?: { category: string }; filters?: { column: string; op: string; value?: unknown }[] };

/** A server that answers every tile and records every channel called and every tile asked for. */
function serve() {
  const channels: string[] = [];
  const asked: Item[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const channel = decodeURIComponent(/\/api\/rpc\/([^?]+)/.exec(String(url))?.[1] ?? String(url));
      channels.push(channel);
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (channel === 'analysis:tiles') {
        const items = (decode(String(init?.body)) as { args: [{ items: Item[] }] }).args[0].items;
        asked.push(...items);
        return reply(items.map((it) => (it.kind === 'metric' ? { ok: true, value: 1, display: '1' } : { ok: true, data: { labels: ['East', 'West'], series: [{ name: 'amount', values: [1, 2] }] }, warnings: [] })));
      }
      if (channel === 'projects:roles') return reply({ [P]: 'viewer' });
      if (channel === 'fx:get') return reply({ settings: { dashboards: {} } });
      if (channel === 'comment:list') return reply({ comments: [] });
      if (channel === 'alerts:list') return reply({ rules: [], events: [] });
      return reply({});
    }),
  );
  return { channels, asked };
}

function open(clickFilter: boolean | undefined) {
  const server = serve();
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Editor projectId={P} analysis={analysis(clickFilter)} visuals={VISUALS} readOnly />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return server;
}

/** The drawn body of a visual card — where a click on a mark lands. */
async function body(name: string): Promise<HTMLElement> {
  const card = await screen.findByRole('group', { name: `${name} card` });
  return waitFor(() => {
    const el = card.querySelector<HTMLElement>('canvas')?.closest<HTMLElement>('[class*="drawn"]');
    if (!el) throw new Error(`${name} has not drawn yet`);
    return el;
  });
}
const stepsOn = (item: Item | undefined) => (item?.filters ?? []).map((f) => `${f.column} ${f.op} ${String(f.value)}`);
const lastFor = (asked: Item[], category: string) => asked.filter((i) => i.kind === 'visual' && i.encoding?.category === category).at(-1);

describe('click-to-filter in a viewer’s dashboard', () => {
  it('filters the other cards, leaves the clicked chart whole, shows the chip, clears on Esc — and writes nothing', async () => {
    const { channels, asked } = open(true);
    const region = await body('Amount by region');
    await body('Amount by month');
    expect(screen.getByRole('group', { name: 'Click filters' }).textContent).toContain('Click a mark on a chart');
    const before = asked.length;

    fireEvent.click(region);
    const chip = await screen.findByRole('button', { name: 'Remove click filter region: West' });
    expect(chip.getAttribute('title')).toContain('clicked on “Amount by region”');

    // The other cards asked again, WITH the click; the clicked chart did not ask again at all (its request is unchanged).
    await waitFor(() => expect(stepsOn(lastFor(asked.slice(before), 'month'))).toEqual(['region = West']));
    await waitFor(() => expect(stepsOn(asked.slice(before).filter((i) => i.kind === 'metric').at(-1))).toEqual(['region = West']));
    expect(asked.slice(before).filter((i) => i.encoding?.category === 'region')).toEqual([]);
    expect(stepsOn(lastFor(asked, 'region'))).toEqual([]);

    // Esc clears every click-filter: the others ask once more, without it.
    const cleared = asked.length;
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Remove click filter/ })).toBeNull());
    await waitFor(() => expect(stepsOn(lastFor(asked.slice(cleared), 'month'))).toEqual([]));
    expect(lastFor(asked.slice(cleared), 'month')).toBeTruthy();

    // A viewer's click is view state: nothing but reads ever left the page.
    expect(channels.filter((c) => /^(analysis:(update|create|rename|delete)|visual:(save|update|delete))$/.test(c))).toEqual([]);
    expect(channels).toContain('analysis:tiles');
  });

  it('⌘-click adds a second chart’s value; each chart is exempt from its own click only', async () => {
    const { asked } = open(true);
    const region = await body('Amount by region');
    const month = await body('Amount by month');
    fireEvent.click(region);
    await screen.findByRole('button', { name: 'Remove click filter region: West' });
    fireEvent.click(month, { metaKey: true });
    await screen.findByRole('button', { name: 'Remove click filter month: West' });
    await waitFor(() => expect(stepsOn(lastFor(asked, 'region'))).toEqual(['month = West']));
    expect(stepsOn(lastFor(asked, 'month'))).toEqual(['region = West']);
    await waitFor(() => expect(stepsOn(asked.filter((i) => i.kind === 'metric').at(-1))).toEqual(['region = West', 'month = West']));
  });

  it('NEGATIVE CONTROL: a sheet saved before the switch does not filter on a click — no chip row, no new request', async () => {
    const { asked } = open(undefined);
    const region = await body('Amount by region');
    await body('Amount by month');
    const before = asked.length;
    fireEvent.click(region);
    // The click drills instead (the rows behind the mark), exactly as it did before.
    await screen.findByRole('dialog');
    expect(screen.queryByRole('group', { name: 'Click filters' })).toBeNull();
    expect(asked.slice(before).filter((i) => (i.filters ?? []).some((f) => f.column === 'region'))).toEqual([]);
  });
});
