// Click-to-filter where it is seen and used: the chip row (one removable,
// focusable chip per click-filter, then Clear), which visuals a click filters
// from (the sheet's switch, a visual's opt-out, never a table or a map), and
// how a click on a mark is routed (plain, ⌘/Ctrl, ⌥).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { asMonthLabels } from '../../charts/build';
import type { VisualDef } from '../analyses/api';
import type { EditorApi } from '../analyses/editor/context';
import type { ClickFilter } from '../analyses/editor/filters';
import { serverLabel, VisualTileBody } from '../analyses/VisualTile';
import { clickColumns } from './CardRuntime';
import { ClickFilterBar, clickValues } from './ClickFilters';

// The chart's hit-test (Chart.js on a real canvas) is not what is under test: every click lands on this mark.
const MONTHS = ['2023-01-01', '2023-02-01'];
/** The axis text of those months in THIS runtime's locale ("Jan 2023" in en-US). */
const [JAN, FEB] = asMonthLabels(MONTHS) as string[];
const hit = vi.hoisted(() => ({ category: '' }));
vi.mock('../visuals/drill/mark', () => ({ markAt: () => ({ category: hit.category, series: 'B2B' }) }));
hit.category = JAN;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const def = (over: Partial<VisualDef> = {}): VisualDef => ({ id: 'v', name: 'Revenue by state', datasetId: D, chartType: 'column', encoding: { category: 'state', values: [{ column: 'revenue', aggregation: 'sum' }] }, overrides: {}, filters: [], updatedAt: '', ...over });

/** As much of the editor as the chip row and the rule read. */
function editor(clicks: ClickFilter[], sheet: { clickFilter?: boolean } = {}) {
  const clearClicks = vi.fn();
  const ed = {
    sheet: 0,
    doc: { sheets: [{ id: 's', name: 'Sheet 1', cards: [], ...sheet }] },
    cards: [{ id: 'card-a', type: 'visual', visualId: 'v', layout: { x: 0, y: 0, w: 6, h: 6 } }],
    visuals: new Map([['v', def()]]),
    view: { clicks, clearClicks },
  } as unknown as EditorApi;
  return { ed, clearClicks };
}

describe('the click-filter chips', () => {
  const state: ClickFilter = { origin: 'card-a', column: 'state', values: ['California'] };
  const cat: ClickFilter = { origin: 'card-a', column: 'category', values: ['Furniture', 'Technology', '', 'Toys', 'Garden'] };

  it('nothing clicked, on a sheet whose charts can be: the row is already there and says what a click does', () => {
    render(<ClickFilterBar ed={editor([], { clickFilter: true }).ed} />);
    const bar = screen.getByRole('group', { name: 'Click filters' });
    expect(bar.textContent).toContain('Click a mark on a chart to filter the other cards.');
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('NEGATIVE CONTROL: a sheet with no chart to click (the switch never set) has no row at all', () => {
    const { container } = render(<ClickFilterBar ed={editor([]).ed} />);
    expect(container.firstChild).toBeNull();
  });

  it('one chip per click-filter, "column: value", each a button that removes just that one', () => {
    const { ed, clearClicks } = editor([state, cat]);
    render(<ClickFilterBar ed={ed} />);
    const bar = screen.getByRole('group', { name: 'Click filters' });
    expect(bar.textContent).toContain('state:California');
    expect(bar.textContent).toContain('category:Furniture, Technology, (blank) +2');
    const chip = screen.getByRole('button', { name: 'Remove click filter state: California' });
    expect(chip.getAttribute('title')).toContain('clicked on “Revenue by state”');
    // A real <button>: Tab reaches it, Enter and Space press it.
    expect(chip.tagName).toBe('BUTTON');
    fireEvent.click(chip);
    expect(clearClicks).toHaveBeenCalledExactlyOnceWith(state);
    // The accessible name spells every value, not the "+2".
    expect(screen.getByRole('button', { name: 'Remove click filter category: Furniture, Technology, (blank), Toys, Garden' })).toBeTruthy();
  });

  it('Clear takes them all away', () => {
    const { ed, clearClicks } = editor([state, cat]);
    render(<ClickFilterBar ed={ed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clearClicks).toHaveBeenCalledExactlyOnceWith();
  });

  it('spells three values, then counts', () => {
    expect(clickValues({ origin: 'a', column: 'c', values: ['x'] })).toBe('x');
    expect(clickValues({ origin: 'a', column: 'c', values: ['a', 'b', 'c'] })).toBe('a, b, c');
    expect(clickValues({ origin: 'a', column: 'c', values: ['a', 'b', 'c', 'd'] })).toBe('a, b, c +1');
  });
});

describe('which visuals a click filters from', () => {
  it('the sheet’s switch turns it on for every chart; a visual opts out', () => {
    expect(clickColumns(editor([], { clickFilter: true }).ed, def())).toEqual({ column: 'state' });
    expect(clickColumns(editor([], { clickFilter: true }).ed, def({ overrides: { crossFilter: false } }))).toBeNull();
  });

  it('a sheet saved before the switch: only a visual that opted in, as before', () => {
    expect(clickColumns(editor([]).ed, def())).toBeNull();
    expect(clickColumns(editor([]).ed, def({ overrides: { crossFilter: true } }))).toEqual({ column: 'state' });
  });

  it('a split chart filters on its category and its series together', () => {
    const split = def({ encoding: { category: 'state', series: 'segment', values: [{ column: 'revenue', aggregation: 'sum' }] } });
    expect(clickColumns(editor([], { clickFilter: true }).ed, split)).toEqual({ column: 'state', seriesColumn: 'segment' });
  });

  it('NEGATIVE CONTROL: never a table, a map, or a visual with no category — whatever the switch says', () => {
    const on = editor([], { clickFilter: true }).ed;
    expect(clickColumns(on, def({ chartType: 'table' }))).toBeNull();
    expect(clickColumns(on, def({ chartType: 'map_choropleth', overrides: { crossFilter: true } }))).toBeNull();
    expect(clickColumns(on, def({ encoding: { category: '', values: [] } }))).toBeNull();
  });
});

describe('a click on a mark', () => {
  const TILE = { ok: true, data: { labels: MONTHS, series: [{ name: 'B2B', values: [1, 2] }] }, warnings: [] };

  async function draw(filterMark: boolean) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([TILE]), { status: 200 })));
    const onMark = vi.fn();
    const onPinAt = vi.fn();
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <VisualTileBody projectId={P} def={def()} filters={[]} params={[]} asTable onMark={onMark} onPinAt={onPinAt} filterMark={filterMark} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const table = await screen.findByRole('table');
    return { onMark, onPinAt, target: table.parentElement as HTMLElement };
  }

  it('click-to-filter: a plain click and a ⌘/Ctrl-click both reach onMark, with the server’s label and the click', async () => {
    const { onMark, onPinAt, target } = await draw(true);
    fireEvent.click(target);
    fireEvent.click(target, { metaKey: true });
    fireEvent.click(target, { ctrlKey: true });
    expect(onPinAt).not.toHaveBeenCalled();
    expect(onMark).toHaveBeenCalledTimes(3);
    // JAN is the axis text; the filter carries what the server sent for that position.
    expect(onMark.mock.calls.map((c) => [c[0], c[1], !!(c[2].metaKey || c[2].ctrlKey)])).toEqual([
      ['2023-01-01', 'B2B', false],
      ['2023-01-01', 'B2B', true],
      ['2023-01-01', 'B2B', true],
    ]);
  });

  it('…and ⌥-click still pins a comment there', async () => {
    const { onMark, onPinAt, target } = await draw(true);
    fireEvent.click(target, { altKey: true });
    expect(onMark).not.toHaveBeenCalled();
    expect(onPinAt).toHaveBeenCalledExactlyOnceWith(JAN, 'B2B');
  });

  it('NEGATIVE CONTROL: without click-to-filter ⌘-click pins, as it always did, and the mark keeps its axis text', async () => {
    const { onMark, onPinAt, target } = await draw(false);
    fireEvent.click(target, { metaKey: true });
    expect(onMark).not.toHaveBeenCalled();
    expect(onPinAt).toHaveBeenCalledExactlyOnceWith(JAN, 'B2B');
    fireEvent.click(target);
    expect(onMark.mock.calls[0].slice(0, 2)).toEqual([JAN, 'B2B']);
  });

  it('serverLabel maps axis text back by position, and leaves anything else alone', () => {
    expect(serverLabel(MONTHS, FEB)).toBe('2023-02-01');
    expect(serverLabel(['East', 'West'], 'West')).toBe('West');
    expect(serverLabel([2023, 2024], 2024)).toBe(2024);
    expect(serverLabel(undefined, 'West')).toBe('West');
    expect(serverLabel(['East'], 'Other')).toBe('Other');
  });
});
