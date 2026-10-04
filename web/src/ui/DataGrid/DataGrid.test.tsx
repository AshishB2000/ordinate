import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { DataGrid, type CellEdit, type GridColumn, type GridRange } from './DataGrid';
import type { Cell, FetchPage } from './pageCache';

// jsdom has no layout: give every box a client size so the virtualizers draw.
const sizes = { clientHeight: 400, clientWidth: 800 };
const saved: Partial<Record<keyof typeof sizes, PropertyDescriptor>> = {};
beforeAll(() => {
  for (const k of Object.keys(sizes) as (keyof typeof sizes)[]) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => sizes[k] });
  }
});
afterAll(() => {
  for (const k of Object.keys(sizes) as (keyof typeof sizes)[]) {
    const d = saved[k];
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]; // jsdom keeps it on Element
  }
});

const COLUMNS: GridColumn[] = [
  { name: 'amount', type: 'number' },
  { name: 'name', type: 'text' },
  { name: 'day', type: 'date' },
];

/** A source of `n` rows: [i × 1000.5, "r<i>", "2024-01-01"]. */
function rowsSource(n: number) {
  return vi.fn<FetchPage>(async (offset, limit) => ({
    rows: Array.from({ length: Math.max(0, Math.min(limit, n - offset)) }, (_, k): Cell[] => [(offset + k) * 1000.5, `r${offset + k}`, '2024-01-01']),
    total: n,
  }));
}

const grid = () => screen.getByRole('grid', { name: 'Orders' });
const activeId = () => grid().getAttribute('aria-activedescendant') ?? '';
const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(grid(), { key: k, ...mods });

describe('DataGrid', () => {
  it('draws the real header with type badges over loading rows, then the rows', async () => {
    let release: () => void = () => {};
    const src = rowsSource(50);
    const held: FetchPage = (o, l) => new Promise((r) => (release = () => r(src(o, l))));
    render(<DataGrid columns={COLUMNS} source={held} label="Orders" />);
    expect(grid().getAttribute('aria-busy')).toBe('true');
    expect(grid().getAttribute('aria-rowcount')).toBe('-1');
    const heads = screen.getAllByRole('columnheader');
    expect(heads.map((h) => h.textContent)).toEqual(['amount123, Number', 'nameAbc, Text', 'dayDate, Date']);
    await act(async () => release());
    expect(await screen.findByText('r0')).toBeTruthy();
    expect(grid().getAttribute('aria-busy')).toBeNull();
    expect(grid().getAttribute('aria-rowcount')).toBe('51');
    expect(screen.getByText('1,000.5')).toBeTruthy(); // grouped, not 1000.5
  });

  it('shows the error state, and Try again fetches again', async () => {
    let fail = true;
    const src = rowsSource(3);
    const flaky: FetchPage = (o, l) => (fail ? Promise.reject(new Error('The table file is missing.')) : src(o, l));
    render(<DataGrid columns={COLUMNS} source={flaky} label="Orders" />);
    expect(await screen.findByRole('heading', { name: 'Rows could not be loaded' })).toBeTruthy();
    expect(screen.getByText('The table file is missing.')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('r2')).toBeTruthy();
  });

  it('shows the empty state for no rows, and for no columns', async () => {
    const { unmount } = render(<DataGrid columns={COLUMNS} source={rowsSource(0)} label="Orders" emptyTitle="No matches" />);
    expect(await screen.findByRole('heading', { name: 'No matches' })).toBeTruthy();
    unmount();
    render(<DataGrid columns={[]} source={rowsSource(3)} label="Orders" />);
    expect(screen.getByRole('heading', { name: 'No columns' })).toBeTruthy();
  });

  it('moves the active cell with the keyboard, reaches the header and resizes from it', async () => {
    render(<DataGrid columns={COLUMNS} source={rowsSource(50)} label="Orders" />);
    await screen.findByText('r0');
    expect(activeId()).toMatch(/-r0c0$/);
    key('ArrowDown');
    key('ArrowRight');
    expect(activeId()).toMatch(/-r1c1$/);
    expect(document.getElementById(activeId())?.textContent).toBe('r1');
    key('End', { ctrlKey: true });
    expect(activeId()).toMatch(/-r49c2$/);
    key('Home', { metaKey: true });
    key('ArrowUp');
    expect(activeId()).toMatch(/-h0$/);
    const head = document.getElementById(activeId())!;
    expect(head.style.width).toBe('130px');
    key('ArrowRight', { shiftKey: true });
    expect(head.style.width).toBe('146px');
  });

  it('is read-only unless editable: Enter does not open an editor', async () => {
    const onEdit = vi.fn();
    render(<DataGrid columns={COLUMNS} source={rowsSource(5)} label="Orders" onEdit={onEdit} />);
    await screen.findByText('r0');
    expect(grid().getAttribute('aria-readonly')).toBe('true');
    key('Enter');
    key('x');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('editable: reports an edit through onEdit and never applies it itself', async () => {
    const onEdit = vi.fn();
    render(<DataGrid columns={COLUMNS} source={rowsSource(5)} label="Orders" editable onEdit={onEdit} />);
    await screen.findByText('r0');
    key('ArrowRight');
    key('Enter');
    const box = screen.getByRole('textbox', { name: 'Edit name, row 1' }) as HTMLInputElement;
    expect(box.value).toBe('r0');
    fireEvent.change(box, { target: { value: 'Ada' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onEdit).toHaveBeenCalledExactlyOnceWith({ row: 0, column: 1, value: 'Ada' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('r0')).toBeTruthy(); // the server's value until the caller re-sources
    expect(activeId()).toMatch(/-r1c1$/); // Enter moves down

    // Escape cancels; committing an unchanged value reports nothing.
    key('F2');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'nope' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    key('Enter');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(activeId()).toMatch(/-r1c2$/); // Tab moves right

    // Typing starts an edit with what was typed.
    key('7');
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('7');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onEdit).toHaveBeenLastCalledWith({ row: 1, column: 2, value: '7' });
    // A double-click opens the clicked cell.
    fireEvent.doubleClick(within(grid()).getByText('r3'));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('r3');
  });

  it('shows an edit once the caller re-sources, keeping the row count (no skeleton collapse)', async () => {
    function Harness() {
      const [data, setData] = useState<Cell[][]>(() => Array.from({ length: 40 }, (_, i) => [i, `r${i}`, '2024-01-01']));
      // The caller owns the rows: it applies the edit and hands the grid a new source.
      const source = useMemo<FetchPage>(() => async (o, l) => ({ rows: data.slice(o, o + l), total: data.length }), [data]);
      const onEdit = (e: CellEdit) => setData((d) => d.map((r, i) => (i === e.row ? r.map((v, c) => (c === e.column ? e.value : v)) : r)));
      return <DataGrid columns={COLUMNS} source={source} label="Orders" editable onEdit={onEdit} />;
    }
    render(<Harness />);
    await screen.findByText('r0');
    key('ArrowRight');
    key('F2');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ada' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(grid().getAttribute('aria-rowcount')).toBe('41'); // the old count while the new source loads
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(screen.queryByText('r0')).toBeNull();
  });

  it('with a selection: Shift+arrows and Shift+click grow a range from the anchor; the caller can move it', async () => {
    const seen: GridRange[] = [];
    function Harness({ jump }: { jump?: GridRange }) {
      const [sel, setSel] = useState<GridRange>({ r0: 0, c0: 0, r1: 0, c1: 0 });
      const src = useMemo(() => rowsSource(30), []);
      return (
        <>
          <button onClick={() => jump && setSel(jump)}>jump</button>
          <DataGrid columns={COLUMNS} source={src} label="Orders" selection={sel} onSelectionChange={(r) => (seen.push(r), setSel(r))} />
        </>
      );
    }
    render(<Harness jump={{ r0: 5, c0: 2, r1: 5, c1: 2 }} />);
    await screen.findByText('r0');
    key('ArrowDown', { shiftKey: true });
    key('ArrowRight', { shiftKey: true });
    expect(seen.at(-1)).toEqual({ r0: 0, c0: 0, r1: 1, c1: 1 });
    expect(grid().querySelectorAll('[aria-selected="true"]').length).toBe(4);
    fireEvent.mouseDown(within(grid()).getByText('r3'), { shiftKey: true });
    expect(seen.at(-1)).toEqual({ r0: 0, c0: 0, r1: 3, c1: 1 });
    key('ArrowUp'); // no Shift: a single cell again
    expect(seen.at(-1)).toEqual({ r0: 2, c0: 1, r1: 2, c1: 1 });
    fireEvent.click(screen.getByText('jump'));
    expect(activeId()).toMatch(/-r5c2$/);
  });

  it('draws a server flag as an invalid cell with its reason, and a header can open a menu', async () => {
    const onHeader = vi.fn();
    const flag = (r: number, c: number) => (r === 1 && c === 0 ? { tone: 'bad' as const, text: 'Not a number' } : undefined);
    render(<DataGrid columns={COLUMNS} source={rowsSource(5)} label="Orders" cellFlag={flag} onHeaderActivate={onHeader} />);
    await screen.findByText('r0');
    const bad = grid().querySelectorAll('[aria-invalid="true"]');
    expect(bad.length).toBe(1);
    expect(bad[0]?.getAttribute('title')).toBe('Not a number');
    fireEvent.click(screen.getAllByRole('columnheader')[1]!);
    expect(onHeader).toHaveBeenLastCalledWith(1, expect.any(HTMLElement));
    key('ArrowUp'); // to the header row
    key('Enter');
    expect(onHeader).toHaveBeenLastCalledWith(0, expect.any(HTMLElement));
  });
});
