// A Live dataset's calculated fields on its Schema tab (./CalculatedFieldsPanel) and as the chart builder's
// Column kind (../calc/CalcDialog), with every RPC answered per channel. The server checks and types each
// field; the screens send the whole list and show what the server says.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { serveRpc, type RpcReply } from '../../test-utils';
import { CalculatedFieldsPanel } from './CalculatedFieldsPanel';
import { CalcDialog, type CalcCreated } from '../calc/CalcDialog';
import type { LiveSchema, SchemaColumn } from './liveApi';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const COLUMNS: SchemaColumn[] = [
  { name: 'revenue', type: 'number', filled: 10, filledPct: 100, distinct: 10, values: [], more: 0, withheld: false },
  { name: 'cost', type: 'number', filled: 10, filledPct: 100, distinct: 10, values: [], more: 0, withheld: false },
  { name: 'sku', type: 'text', filled: 10, filledPct: 100, distinct: 10, values: [], more: 0, withheld: false },
];
const BAND = { name: 'Band', expression: "IF [revenue] > 10 THEN 'big' ELSE 'small' END", type: 'text' as const };
const schema = (calculated: LiveSchema['calculated']): LiveSchema => ({
  ok: true, schemaSyncedAt: '2026-11-04T10:00:00Z', syncing: false, sampledAt: null, sampleRows: null, method: null, note: null,
  columns: COLUMNS.map((c) => ({ ...c })), missing: [], ...(calculated ? { calculated } : {}),
});
const LEN_WHY = "len() can't run on a Live table: warehouses count characters differently.";
const DOCS = [
  { name: 'abs', category: 'number', signature: 'abs(number)', summary: 'The absolute value.', example: 'abs(-1)', live: true },
  { name: 'len', category: 'string', signature: 'len(text)', summary: 'How many characters.', example: 'len("a")', live: false, liveWhy: LEN_WHY },
];
const CHECK = { tokens: [{ kind: 'column', value: 'revenue', start: 0, end: 9 }], ok: true, refs: ['revenue', 'cost'], unknownRefs: [], resultType: 'number', sample: { columns: [], rows: [], note: 'A Live calculated field shows no preview rows.' } };

function serve(calculated: LiveSchema['calculated'], extra: Record<string, RpcReply> = {}, role = 'editor') {
  return serveRpc({
    'dataset:liveSchema': { body: schema(calculated) },
    'projects:roles': { body: { [P]: role } },
    'formula:functions': { body: DOCS },
    'live:checkCalc': { body: CHECK },
    'live:setCalculated': (payload) => ({ body: { ok: true, calculated: (payload as { calculated: { name: string; expression: string }[] }).calculated.map((c) => ({ ...c, type: 'number' })) } }),
    ...extra,
  });
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CalculatedFieldsPanel projectId={P} datasetId={D} />
    </QueryClientProvider>,
  );
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value, selectionStart: value.length } });
const sent = (calls: { channel: string; payload: unknown }[]) => (calls.find((c) => c.channel === 'live:setCalculated')?.payload as { calculated: unknown[] } | undefined)?.calculated;

describe('a Live dataset’s calculated fields', () => {
  it('lists each field with its formula in mono and its type; a broken one shows its problem', async () => {
    serve({ allowed: true, fields: [BAND, { name: 'Margin', expression: '[revenue] - [gone]', type: 'number', problem: '“gone” is not a column of this live dataset.' }] });
    renderPanel();
    const table = await screen.findByRole('table');
    expect(screen.getByRole('heading', { name: 'Calculated fields · run in the warehouse' })).toBeTruthy();
    expect(within(table).getByText(BAND.expression).tagName).toBe('CODE');
    expect(table.querySelector('[data-calc="Margin"]')?.textContent).toContain('“gone” is not a column of this live dataset.');
    expect(table.querySelector('[data-calc="Band"]')?.className).toBe('');
  });

  it('an empty list says what a field is for', async () => {
    serve({ allowed: true, fields: [] });
    renderPanel();
    expect(await screen.findByText('Add one to compute a column in the warehouse, such as [revenue] - [cost].')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add calculated field' })).toBeTruthy();
  });

  it('Add sends live:setCalculated with the old list plus the new field', async () => {
    const calls = serve({ allowed: true, fields: [BAND] });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Add calculated field' }));
    type('New column name', 'Margin');
    type('Expression', '[revenue] - [cost]');
    await waitFor(() => expect(calls.some((c) => c.channel === 'live:checkCalc')).toBe(true));
    expect(calls.find((c) => c.channel === 'live:checkCalc')?.payload).toMatchObject({ projectId: P, datasetId: D, before: 1 });
    expect(await screen.findByText('A Live calculated field shows no preview rows.')).toBeTruthy();
    expect(screen.queryByText('This dataset has no rows to preview.')).toBeNull();
    const add = screen.getByRole('button', { name: 'Add field' });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    await waitFor(() => expect(sent(calls)).toEqual([{ name: BAND.name, expression: BAND.expression }, { name: 'Margin', expression: '[revenue] - [cost]' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => ['formula:check', 'dataset:addStep', 'dataset:page'].includes(c.channel))).toBe(false);
  });

  it('a check refusal shows the server’s sentence and its underline; a save refusal keeps the dialog open', async () => {
    const at = { start: 0, end: 3 };
    serve({ allowed: true, fields: [] }, {
      'live:checkCalc': (payload) => (String((payload as { expression: string }).expression).startsWith('len')
        ? { body: { ...CHECK, ok: false, error: LEN_WHY, at, resultType: null } } : { body: CHECK }),
      'live:setCalculated': { body: { ok: false, code: 'calc_invalid', index: 0, error: '“Revenue” is already a column of this dataset.' } },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Add calculated field' }));
    type('New column name', 'Revenue');
    type('Expression', 'len([sku])');
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(LEN_WHY, { selector: 'p' })).toBeTruthy();
    expect(dialog.querySelector('[class*="tErr"]')?.textContent).toBe('len');
    type('Expression', '[revenue] - [cost]');
    const add = within(dialog).getByRole('button', { name: 'Add field' });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('“Revenue” is already a column of this dataset.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('len is greyed in the function list, its title the server’s reason; abs is not', async () => {
    serve({ allowed: true, fields: [] });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Add calculated field' }));
    const len = await screen.findByRole('button', { name: 'len(text)' });
    expect(len.getAttribute('aria-disabled')).toBe('true');
    expect(len.getAttribute('title')).toContain(LEN_WHY);
    expect(screen.getByRole('button', { name: 'abs(number)' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('a viewer reads the list only; a hidden formula reads “formula hidden”', async () => {
    serve({ allowed: true, fields: [{ name: 'Flag', expression: '', type: 'number', hidden: true }] }, {}, 'viewer');
    renderPanel();
    expect(await screen.findByText('formula hidden')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add calculated field' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('Databricks: the panel says why, and has no Add', async () => {
    const why = "Calculated fields can't run on a Databricks Live table yet. Make a copy to chart them.";
    serve({ allowed: false, why, fields: [] });
    renderPanel();
    expect(await screen.findByText(why)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add calculated field' })).toBeNull();
  });

  it('Delete asks first, then sends the list without it', async () => {
    const calls = serve({ allowed: true, fields: [BAND, { name: 'Margin', expression: '[revenue] - [cost]', type: 'number' }] });
    renderPanel();
    await screen.findByRole('table');
    fireEvent.click(within(document.querySelector('[data-calc="Band"]') as HTMLElement).getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent(calls)).toEqual([{ name: 'Margin', expression: '[revenue] - [cost]' }]));
  });

  it('an older server (no calculated block) shows no panel', async () => {
    const calls = serve(undefined);
    renderPanel();
    await waitFor(() => expect(calls.some((c) => c.channel === 'dataset:liveSchema')).toBe(true));
    expect(screen.queryByRole('heading', { name: /Calculated fields/ })).toBeNull();
  });
});

describe('the chart builder’s Column kind on a Live dataset', () => {
  function open() {
    const onCreated = vi.fn<(made: CalcCreated) => void>();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: '/', element: <CalcDialog projectId={P} datasetId={D} columns={COLUMNS.map((c) => ({ name: c.name, type: c.type }))} metrics={[]} live chart onCreated={onCreated} onClose={vi.fn()} /> }]);
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return onCreated;
  }

  it('is on where the server allows calcs, and appends through live:setCalculated', async () => {
    const calls = serve({ allowed: true, fields: [BAND] });
    const onCreated = open();
    const column = screen.getByRole('radio', { name: /Column \(calculated on every row\)/ });
    await waitFor(() => expect(column.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(column);
    type('New column name', 'Margin');
    type('Expression', '[revenue] - [cost]');
    const add = await screen.findByRole('button', { name: 'Add column' });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ kind: 'column', name: 'Margin', type: 'number' }));
    expect(sent(calls)).toEqual([{ name: BAND.name, expression: BAND.expression }, { name: 'Margin', expression: '[revenue] - [cost]' }]);
    expect(calls.some((c) => ['formula:check', 'dataset:addStep'].includes(c.channel))).toBe(false);
  });

  it('is off on Databricks, with the server’s why', async () => {
    const why = "Calculated fields can't run on a Databricks Live table yet. Make a copy to chart them.";
    serve({ allowed: false, why, fields: [] });
    open();
    expect(await screen.findByText(new RegExp(why.slice(0, 40)))).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Column \(calculated on every row\)/ }).getAttribute('aria-disabled')).toBe('true');
  });
});
