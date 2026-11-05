// What a viewer a column rule hides columns from sees (semantic layer part 4, step 07): the server marks the
// columns `hidden` in the header and nulls their cells IN PLACE. The Data tab's grid draws the other columns
// only, each over its own cell (never a neighbour's null), and says how many are hidden; the Columns tab locks a
// hidden column's row; the rows behind a mark leave hidden columns out. NEGATIVE CONTROL for each: without the
// flags (an editor) every column draws and nothing says hidden.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { serveRpc } from '../../test-utils';
import type { DatasetColumns } from '../../api/datasets';
import { DataTab } from './DataTab';
import { ColumnsTab } from './ColumnsTab';
import { DrillPanel } from '../visuals/drill/DrillPanel';

// jsdom has no layout: give every box a client size so the grid's virtualizers draw.
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
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
// salary first: a grid that drew by position would put its null under "dept".
const COLUMNS = [{ name: 'salary', type: 'number' as const }, { name: 'dept', type: 'text' as const }, { name: 'ssn', type: 'text' as const }, { name: 'employee_id', type: 'text' as const }];
const hiddenHeader = (): DatasetColumns => ({ id: D, name: 'Staff', rowCount: 1, columns: COLUMNS.map((c) => (c.name === 'salary' || c.name === 'ssn' ? { ...c, hidden: true as const } : c)) });
const openHeader = (): DatasetColumns => ({ id: D, name: 'Staff', rowCount: 1, columns: COLUMNS });
const ROW_HIDDEN = [null, 'Ops', null, 'c0'];
const ROW_OPEN = [1037, 'Ops', 'SSN_1', 'c0'];

const wrap = (node: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
const routes = (role: string, row: unknown[], hidden?: string[]) => ({
  'projects:roles': { body: { [P]: role } },
  'dataset:page': { body: { ok: true, rows: [row], total: 1, offset: 0, ...(hidden ? { hidden } : {}) } },
  'catalog:columns': { body: { columns: {} } },
  'quality:list': { body: { ok: true, rules: [], latest: null, history: [] } },
  'dataset:stats': { body: { ok: true, summaries: [], issues: [], filledPct: [] } },
});
const heads = (name: string) => within(screen.getByRole('grid', { name })).getAllByRole('columnheader').map((h) => h.textContent ?? '');
const firstRow = async (name: string) => {
  const grid = screen.getByRole('grid', { name });
  await within(grid).findByText('Ops');
  return within(within(grid).getAllByRole('row').find((r) => within(r).queryAllByRole('gridcell').length > 0)!).getAllByRole('gridcell').map((c) => c.textContent ?? '');
};

describe('the Data tab, for a viewer a column rule hides columns from', () => {
  it('draws the other columns only, each over its own cell, and says how many are hidden', async () => {
    serveRpc(routes('viewer', ROW_HIDDEN, ['salary', 'ssn']));
    wrap(<DataTab projectId={P} datasetId={D} header={hiddenHeader()} />);
    expect(heads('Staff rows').map((h) => h.split(/Abc|123/)[0])).toEqual(['dept', 'employee_id']);
    expect(await firstRow('Staff rows')).toEqual(['Ops', 'c0']);
    const note = screen.getByText('2 columns hidden');
    expect(note.closest('[title]')?.getAttribute('title')).toBe('Hidden from you: salary, ssn');
    expect((screen.getByRole('searchbox', { name: 'Search rows' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('NEGATIVE CONTROL: without the flags (an editor) every column draws, with no note', async () => {
    serveRpc(routes('editor', ROW_OPEN));
    wrap(<DataTab projectId={P} datasetId={D} header={openHeader()} />);
    expect(heads('Staff rows').map((h) => h.split(/Abc|123/)[0])).toEqual(['salary', 'dept', 'ssn', 'employee_id']);
    expect(await firstRow('Staff rows')).toEqual(['1,037', 'Ops', 'SSN_1', 'c0']);
    expect(screen.queryByText(/columns? hidden/)).toBeNull();
    expect((screen.getByRole('searchbox', { name: 'Search rows' }) as HTMLInputElement).disabled).toBe(false);
  });
});

describe('the Columns tab, for that viewer', () => {
  it('locks a hidden column: "Hidden from you" in place of its example and value labels', async () => {
    serveRpc(routes('viewer', ROW_HIDDEN, ['salary', 'ssn']));
    wrap(<ColumnsTab projectId={P} datasetId={D} header={hiddenHeader()} />);
    const salary = (await screen.findByText('salary')).closest('tr')!;
    expect(within(salary).getByText('Hidden from you')).toBeTruthy();
    expect(within(salary).getByRole('img', { name: 'Hidden from you' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Example of salary' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Example of ssn' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Example of dept' })).toBeTruthy();
  });

  it('NEGATIVE CONTROL: without the flags there is no lock', async () => {
    serveRpc(routes('editor', ROW_OPEN));
    wrap(<ColumnsTab projectId={P} datasetId={D} header={openHeader()} />);
    expect(await screen.findByRole('textbox', { name: 'Example of salary' })).toBeTruthy();
    expect(screen.queryByText('Hidden from you')).toBeNull();
  });
});

describe('the rows behind a mark, for that viewer', () => {
  const target = { name: 'Pay', projectId: P, datasetId: D, encoding: { category: 'dept', values: [] }, filters: [], mark: null } as unknown as Parameters<typeof DrillPanel>[0]['target'];
  const rows = (row: unknown[], hidden?: string[]) => ({ 'visual:rows': { body: { ok: true, available: true, filters: [], columns: COLUMNS, rows: [row], total: 1, offset: 0, ...(hidden ? { hidden } : {}) } } });

  it('leaves the hidden columns out of the header, and out of the sort', async () => {
    serveRpc(rows(ROW_HIDDEN, ['salary', 'ssn']));
    wrap(<DrillPanel target={target} onClose={() => undefined} />);
    await screen.findByRole('grid', { name: 'Underlying rows' });
    expect(heads('Underlying rows').map((h) => h.split(/Abc|123/)[0])).toEqual(['dept', 'employee_id']);
    expect(await firstRow('Underlying rows')).toEqual(['Ops', 'c0']);
    expect(screen.getByText('2 columns hidden')).toBeTruthy();
  });

  it('NEGATIVE CONTROL: without `hidden` every column draws', async () => {
    serveRpc(rows(ROW_OPEN));
    wrap(<DrillPanel target={target} onClose={() => undefined} />);
    await screen.findByRole('grid', { name: 'Underlying rows' });
    expect(heads('Underlying rows').map((h) => h.split(/Abc|123/)[0])).toEqual(['salary', 'dept', 'ssn', 'employee_id']);
    expect(screen.queryByText(/columns? hidden/)).toBeNull();
  });
});
