// A card's chrome on the canvas, through the whole editor: a KPI says its name
// once (the head), and the head's actions are in the DOM — reachable by Tab
// and by assistive tech — while the stylesheet keeps them faded until the card
// is hovered or focused. Every figure is the stubbed server's.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { decode } from '../../../../../src/server/wire.ts';
import type { Analysis } from '../api';
import { Editor } from './Editor';

// The stylesheet as written, comments out (Vitest hands a CSS module over as class names only; it runs from web/).
const css = readFileSync('src/features/analyses/editor/Cards.module.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const A = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';

const analysis: Analysis = {
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
      cards: [
        { id: 'k-revenue', type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: D, column: 'amount', aggregation: 'sum', label: 'Revenue' } },
        // No label: the head says "Sum of profit"; the saved metric's name under the figure is news.
        { id: 'k-named', type: 'metric', layout: { x: 3, y: 0, w: 3, h: 2 }, metric: { datasetId: D, column: 'profit', aggregation: 'sum' } },
        { id: 'k-orders', type: 'metric', layout: { x: 6, y: 0, w: 3, h: 2 }, metric: { datasetId: D, column: 'orders', aggregation: 'sum', label: 'Orders', compare: { mode: 'previous_period' } } },
      ],
    },
  ],
};

type Item = { kind: string; column?: string };

function open() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const channel = decodeURIComponent(/\/api\/rpc\/([^?]+)/.exec(String(url))?.[1] ?? String(url));
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (channel === 'analysis:tiles') {
        const items = (decode(String(init?.body)) as { args: [{ items: Item[] }] }).args[0].items;
        return reply(
          items.map((it) =>
            it.column === 'amount'
              ? { ok: true, value: 5_200_000, display: '$5.2M', asOf: { at: '2026-01-15T12:00:00.000Z', mode: 'extract' } } // months old: the warning tone
              : it.column === 'profit'
                ? { ok: true, value: 686_200, display: '$686.2K', name: 'Net profit' }
                : { ok: true, value: 5000, display: '5K', compare: { ok: true, delta: 400, deltaDisplay: '400', pct: 8.7, previous: 4600, label: 'vs previous period', direction: 'up_good' } },
          ),
        );
      }
      if (channel === 'projects:roles') return reply({ [P]: 'owner' });
      if (channel === 'fx:get') return reply({ settings: { dashboards: {} } });
      if (channel === 'comment:list') return reply({ comments: [] });
      if (channel === 'alerts:list') return reply({ rules: [], events: [] });
      return reply({});
    }),
  );
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Editor projectId={P} analysis={analysis} visuals={[]} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('a KPI card says its name once', () => {
  it('drops the label under the figure when it is the title, keeps one that adds something, and the server’s comparison', async () => {
    open();
    const revenue = await screen.findByRole('group', { name: 'Revenue card' });
    await within(revenue).findByText('$5.2M');
    expect(within(revenue).getAllByText('Revenue')).toHaveLength(1); // the head's title, not again under the figure

    const named = screen.getByRole('group', { name: 'Sum of profit card' });
    await within(named).findByText('$686.2K');
    expect(within(named).getByText('Net profit')).toBeTruthy();

    const orders = screen.getByRole('group', { name: 'Orders card' });
    await within(orders).findByText('5K');
    expect(within(orders).getAllByText('Orders')).toHaveLength(1);
    expect(within(orders).getByText('400')).toBeTruthy(); // the server's deltaDisplay, never a sum done here
    expect(within(orders).getByText('(+8.7%)')).toBeTruthy();
    expect(within(orders).getByText('vs previous period')).toBeTruthy();
  });
});

describe('an old figure’s freshness note in the head', () => {
  it('is still there, with its words and title, as muted text and a warning dot instead of an orange line', async () => {
    open();
    const revenue = await screen.findByRole('group', { name: 'Revenue card' });
    const note = await within(revenue).findByTestId('as-of');
    expect(note.dataset.tone).toBe('warn');
    expect(note.textContent).toMatch(/^As of Jan 1[45]/);
    expect(note.getAttribute('title')).toMatch(/more than a day old/);
    const warn = (part: string) => new RegExp(`\\.head \\.asOf\\[data-tone='warn'\\]${part}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    expect(warn('')).toMatch(/color:\s*var\(--muted\)/);
    expect(warn('::before')).toMatch(/background:\s*var\(--warn\)/);
  });
});

describe('a card head’s actions', () => {
  it('are in the DOM and reachable, in the row the stylesheet fades until hover or focus', async () => {
    open();
    const card = await screen.findByRole('group', { name: 'Revenue card' });
    const props = within(card).getByRole('button', { name: 'Card properties' });
    const more = within(card).getByRole('button', { name: 'Revenue card actions' });
    const comment = within(card).getByRole('button', { name: 'Comment on this' });
    for (const b of [props, more, comment]) {
      expect(b.closest('[aria-hidden="true"], [hidden]')).toBeNull();
      expect(b.tabIndex).toBe(0);
      expect(b.closest('[class*="ctrls"]')).toBeTruthy();
    }
    // No open comments: nothing in the row asks to stay shown.
    expect(comment.hasAttribute('data-keep')).toBe(false);
  });

  it('are faded, not removed, until the card is hovered or focused — and always shown without hover', () => {
    const rule = (sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{[^}]*opacity:\\s*([\\d.]+)`).exec(css)?.[1];
    expect(rule('.ctrls > *')).toBe('0');
    expect(rule('[data-card-id]:hover > .head .ctrls > *')).toBe('1');
    expect(rule('[data-card-id]:focus-within > .head .ctrls > *')).toBe('1');
    expect(css).toMatch(/@media \(hover: none\)\s*\{\s*\.ctrls > \*\s*\{\s*opacity: 1;/);
    // Faded only: display: none or visibility: hidden would take them out of Tab and away from screen readers.
    expect(/\n\.ctrls > \* \{([^}]*)\}/.exec(css)?.[1]).not.toMatch(/display|visibility/);
  });
});
