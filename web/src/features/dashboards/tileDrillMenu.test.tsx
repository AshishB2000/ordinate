// Drill on a dashboard tile (semantic layer D5-D7): where the dashboard is READ, a click on a mark of a drillable tile
// offers "Drill into East · by state" beside "Show the rows behind East"; the drilled tile has crumbs and Up; the rows
// drawer, ⋯ and Explain read the drilled definition. The browser only asks: every figure is the server's.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { createElement } from 'react';
import { asMonthLabels } from '../../charts/build';
import { Toaster } from '../../ui/Toast';
import { decode } from '../../../../src/server/wire.ts';
import type { Analysis, Card, VisualDef } from '../analyses/api';
import { Editor } from '../analyses/editor/Editor';

// The hit-tests need Chart.js on a real canvas; every click lands on this mark.
const hit = vi.hoisted(() => ({ category: 'East', bucket: 'East' }));
vi.mock('../visuals/drill/mark', () => ({ markAt: () => ({ category: hit.category }) }));
vi.mock('../analytics/explain/pointAt', () => ({ pointAt: () => ({ bucket: hit.bucket }) }));
// What the tile body was handed: the pins drawn on it.
const seen = vi.hoisted(() => ({ defs: [] as { chartType: string; overrides?: Record<string, unknown>; encoding: { category: string } }[] }));
vi.mock('../analyses/VisualTile', async (orig) => {
  const m = await orig<typeof import('../analyses/VisualTile')>();
  return { ...m, VisualTileBody: (p: Parameters<typeof m.VisualTileBody>[0]) => (seen.defs.push(p.def), createElement(m.VisualTileBody, p)) };
});

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 8_000 });

beforeEach(() => {
  seen.defs.length = 0;
  hit.category = hit.bucket = 'East';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const A = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const REV = { column: 'revenue', aggregation: 'sum' };
const visual = (id: string, name: string, category: string, chartType = 'column'): VisualDef => ({ id, name, datasetId: D, chartType, encoding: { category, values: [REV] }, overrides: {}, filters: [], updatedAt: '' });
const VISUALS = [visual('v-region', 'Revenue by region', 'region'), visual('v-month', 'Revenue by month', 'month', 'line')];
const [MAR] = asMonthLabels(['2024-03-01']) as string[];

const cards = (): Card[] => [
  { id: 'card-region', type: 'visual', layout: { x: 0, y: 0, w: 6, h: 6 }, visualId: 'v-region' },
  { id: 'card-month', type: 'visual', layout: { x: 6, y: 0, w: 6, h: 6 }, visualId: 'v-month' },
];
const analysis = (clickFilter: boolean): Analysis => ({ id: A, projectId: P, name: 'Weekly review', filters: [], style: {}, parameters: [], updatedAt: '', sheets: [{ id: 's1', name: 'Overview', clickFilter, cards: cards() }] });

type Item = { kind: string; encoding?: { category: string }; filters?: { column: string; op: string; value?: unknown }[] };
const GEO = { id: 'h1', name: 'Geography', levels: ['region', 'state'] };
const DRILLED = { ok: true, available: true, encoding: { category: 'state', values: [REV] }, steps: [{ type: 'filter', column: 'region', op: '=', value: 'East' }], crumb: { column: 'region', label: 'East', next: 'state' } };
const LABELS: Record<string, { labels: string[]; category: object }> = {
  region: { labels: ['East', 'West'], category: { kind: 'text' } },
  state: { labels: ['Ohio', 'Texas'], category: { kind: 'text' } },
  month: { labels: ['2024-03-01', '2024-04-01'], category: { kind: 'date', grain: 'month' } },
};

interface Serve {
  nav?: number;
  drill?: { status?: number; body: unknown };
}
/** A server that answers the tiles and records every channel called, every tile asked for and every payload. */
function serve(o: Serve = {}) {
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  const asked: Item[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const channel = decodeURIComponent(/\/api\/rpc\/([^?]+)/.exec(String(url))?.[1] ?? String(url));
      const body = init?.body ? (decode(String(init.body)) as { args: [Record<string, unknown>] }).args[0] : {};
      calls.push({ channel, payload: body });
      const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (channel === 'analysis:tiles') {
        const items = (body as { items: Item[] }).items;
        asked.push(...items);
        return reply(items.map((it) => ({ ok: true, data: { labels: LABELS[it.encoding?.category ?? 'region']?.labels ?? ['x'], series: [{ name: 'revenue', values: [1, 2] }] }, category: LABELS[it.encoding?.category ?? 'region']?.category, warnings: [] })));
      }
      if (channel === 'model:navigation') return o.nav ? reply({ error: 'gone' }, o.nav) : reply({ ok: true, tables: [{ datasetId: D, hierarchies: [GEO] }], dateLadder: ['year', 'quarter', 'month', 'day'] });
      if (channel === 'visual:drillDown') return o.drill ? reply(o.drill.body, o.drill.status) : reply(DRILLED);
      if (channel === 'visual:rows') return reply({ ok: true, available: false, reason: 'stub rows' });
      if (channel === 'projects:roles') return reply({ [P]: 'viewer' });
      if (channel === 'projects:overview') return reply([]);
      if (channel === 'fx:get') return reply({ settings: { dashboards: {} } });
      if (channel === 'comment:list') return reply({ ok: true, comments: [{ id: 'c1', target: { kind: 'card', id: 'card-region', point: { label: 'East' } }, author: 'me', body: 'check', createdAt: '', mine: true, replies: [] }] });
      if (channel === 'alerts:list') return reply({ rules: [], events: [] });
      return reply({});
    }),
  );
  return { calls, asked };
}
const on = (calls: { channel: string; payload: Record<string, unknown> }[], channel: string) => calls.filter((c) => c.channel === channel);

function open(o: { clickFilter?: boolean; viewing?: boolean } & Serve = {}) {
  const s = serve(o);
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Editor projectId={P} analysis={analysis(o.clickFilter ?? false)} visuals={VISUALS} readOnly viewing={o.viewing ?? true} />
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return s;
}
async function body(name: string): Promise<HTMLElement> {
  const card = await screen.findByRole('group', { name: `${name} card` });
  return waitFor(() => {
    const el = card.querySelector<HTMLElement>('canvas')?.closest<HTMLElement>('[class*="drawn"]');
    if (!el) throw new Error(`${name} has not drawn yet`);
    return el;
  });
}
const menuItems = async () => within(await screen.findByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent);
const lastFor = (asked: Item[], category: string) => asked.filter((i) => i.kind === 'visual' && i.encoding?.category === category).at(-1);
const stepsOn = (item: Item | undefined) => (item?.filters ?? []).map((f) => `${f.column} ${f.op} ${String(f.value)}`);
const crumbs = () => within(screen.getByRole('navigation', { name: 'Drill path' })).getAllByRole('listitem').map((i) => i.textContent);

/** Drill East on the region tile and wait for the state tile. */
async function drillEast(s: ReturnType<typeof serve>) {
  fireEvent.click(await body('Revenue by region'));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Drill into East/ }));
  await waitFor(() => expect(lastFor(s.asked, 'state')).toBeTruthy());
}
const cardActions = async (name: string) => {
  fireEvent.pointerDown(await screen.findByRole('button', { name: `${name} card actions` }), { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
};

describe('a plain click on a drillable mark', () => {
  it('opens the point menu, and "Drill into" asks the server then draws the next level for that tile', async () => {
    const s = open();
    fireEvent.click(await body('Revenue by region'));
    expect(await menuItems()).toEqual(['Drill into East · by state', 'Show the rows behind East']);
    fireEvent.click(screen.getByRole('menuitem', { name: /Drill into East/ }));
    await waitFor(() => expect(lastFor(s.asked, 'state')).toBeTruthy());
    const sent = on(s.calls, 'visual:drillDown')[0].payload as { mark: unknown; encoding: { category: string } };
    expect(sent.mark).toEqual({ category: 'East' });
    expect(sent.encoding.category).toBe('region');
    expect(stepsOn(lastFor(s.asked, 'state'))).toEqual(['region = East']);
    // Another tile reads nothing of it (NEGATIVE CONTROL).
    expect(stepsOn(lastFor(s.asked, 'month'))).toEqual([]);
  });

  it('draws the crumbs, and Up goes back a level: the rows behind read the saved encoding again', async () => {
    const s = open();
    await drillEast(s);
    expect(crumbs()).toEqual(['Geography', 'East', '· by state']);
    fireEvent.click(screen.getByRole('button', { name: 'Up' }));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Drill path' })).toBeNull());
    fireEvent.click(within(await cardActions('Revenue by region')).getByRole('menuitem', { name: 'Show the rows' }));
    await waitFor(() => expect(on(s.calls, 'visual:rows').length).toBeGreaterThan(0));
    const rows = on(s.calls, 'visual:rows').at(-1)?.payload as { encoding: { category: string } } | undefined;
    expect(rows?.encoding.category).toBe('region');
  });

  it('after the drill, ⋯ "Show the rows" reads the drilled encoding and the region step', async () => {
    const s = open();
    await drillEast(s);
    fireEvent.click(within(await cardActions('Revenue by region')).getByRole('menuitem', { name: 'Show the rows' }));
    await waitFor(() => expect(on(s.calls, 'visual:rows').length).toBeGreaterThan(0));
    const rows = on(s.calls, 'visual:rows')[0].payload as { encoding: { category: string }; filters: { column: string; value: unknown }[] };
    expect(rows.encoding.category).toBe('state');
    expect(rows.filters.map((f) => `${f.column}=${String(f.value)}`)).toEqual(['region=East']);
  });

  it('NEGATIVE CONTROL: at the last level there is nothing to drill, so the click opens the rows drawer as today', async () => {
    const s = open();
    await drillEast(s);
    hit.category = hit.bucket = 'Ohio';
    fireEvent.click(await body('Revenue by region'));
    await waitFor(() => expect(on(s.calls, 'visual:rows').length).toBeGreaterThan(0));
    expect(screen.queryByRole('menu')).toBeNull();
    expect((on(s.calls, 'visual:rows')[0].payload as { mark: unknown }).mark).toEqual({ category: 'Ohio' });
  });

  it('a month line chart with no hierarchy offers the next grain', async () => {
    open();
    hit.category = MAR;
    hit.bucket = '2024-03-01';
    fireEvent.click(await body('Revenue by month'));
    expect(await menuItems()).toEqual([`Drill into ${MAR} · by day`, `Show the rows behind ${MAR}`, 'Explain this change']);
  });

  it('while a tile is drilled its click-to-filter is off, and its comment pins are not drawn', async () => {
    const s = open({ clickFilter: true });
    await body('Revenue by region');
    fireEvent.contextMenu(await body('Revenue by region'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Drill into East/ }));
    await waitFor(() => expect(lastFor(s.asked, 'state')).toBeTruthy());
    fireEvent.click(await body('Revenue by region'));
    await waitFor(() => expect(on(s.calls, 'visual:rows').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Remove click filter/ })).toBeNull();
    // The pin at East is drawn on the saved level (the control), and on none of the drilled one.
    expect(seen.defs.some((d) => d.encoding.category === 'region' && d.overrides?.commentPins)).toBe(true);
    expect(seen.defs.filter((d) => d.encoding.category === 'state').length).toBeGreaterThan(0);
    expect(seen.defs.filter((d) => d.encoding.category === 'state').every((d) => !d.overrides?.commentPins)).toBe(true);
  });
});

describe('click-to-filter keeps its order (D7)', () => {
  it('on, a plain click filters, and the right-click menu holds the drill', async () => {
    const s = open({ clickFilter: true });
    fireEvent.click(await body('Revenue by region'));
    await screen.findByRole('button', { name: 'Remove click filter region: East' });
    expect(on(s.calls, 'visual:drillDown')).toEqual([]);
    fireEvent.contextMenu(await body('Revenue by region'));
    expect(await menuItems()).toEqual(['Drill into East · by state', 'Show the rows behind East']);
  });
});

describe('where it does not drill', () => {
  it('the editor’s canvas: a click opens the drawer and never asks model:navigation', async () => {
    const s = open({ viewing: false });
    fireEvent.click(await body('Revenue by region'));
    await waitFor(() => expect(on(s.calls, 'visual:rows').length).toBeGreaterThan(0));
    expect(on(s.calls, 'model:navigation')).toEqual([]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('an older pod without model:navigation: the drawer, as today', async () => {
    const s = open({ nav: 404 });
    fireEvent.click(await body('Revenue by region'));
    await waitFor(() => expect(on(s.calls, 'visual:rows').length).toBeGreaterThan(0));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('an older pod without visual:drillDown: an error toast, and the tile is unchanged', async () => {
    const s = open({ drill: { status: 404, body: { error: 'no such channel' } } });
    fireEvent.click(await body('Revenue by region'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Drill into East/ }));
    expect(await screen.findByText(/could not drill down/i)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Drill path' })).toBeNull();
    expect(lastFor(s.asked, 'state')).toBeUndefined();
  });

  it('a refusal shows the server’s sentence and leaves the tile alone', async () => {
    const s = open({ drill: { body: { ok: true, available: false, reason: 'region is the last level of Geography.' } } });
    fireEvent.click(await body('Revenue by region'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Drill into East/ }));
    expect(await screen.findByText('region is the last level of Geography.')).toBeTruthy();
    expect(lastFor(s.asked, 'state')).toBeUndefined();
  });
});
