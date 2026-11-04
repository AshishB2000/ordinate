// Value labels in the web (semantic layer PR 06, D6): the Columns tab's "Value labels" cell and its dialog — fill from the
// data, label, save, the server's refusal and the server's rules said before a save — and the three filter pickers, which
// show a value by its label and still send the stored value.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serveRpc, type RpcReply } from '../../test-utils';
import { Toaster } from '../../ui/Toast';
import { ColumnsTab } from './ColumnsTab';
import { LABEL_DRAWN_BY, problemText } from './ValueLabelsDialog';
import { valueLabelProblem } from '../../../../src/analysis/valueLabels.ts';
import { FilterDialog } from '../visuals/filters/FilterDialog';
import { ControlWidget } from '../analyses/editor/ControlWidget';
import { EditorCtx, type EditorApi } from '../analyses/editor/context';
import type { Card, ControlValue } from '../analyses/api';
import { QuickFilters } from '../dashboards/ControlsExtras';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const HEADER = { id: D, name: 'Orders', rowCount: 4, columns: [{ name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }] };
const L = [{ value: 'EU', label: 'Europe' }, { value: 'NA', label: 'North America' }];
const SET = 'catalog:setColumn';
const EN = JSON.parse(readFileSync(path.resolve(process.cwd(), '..', 'src', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;

function wrap(ui: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
      <Toaster />
    </QueryClientProvider>,
  );
}

/** The Columns tab over canned replies; an editor unless `role` says otherwise. */
function renderTab(routes: Record<string, RpcReply>, role = 'editor', live = false) {
  const calls = serveRpc({
    'projects:roles': { body: { [P]: role } },
    'catalog:columns': { body: { columns: {} } },
    'dataset:stats': { body: { ok: true, summaries: [], issues: [], filledPct: [] } },
    ...routes,
  });
  wrap(<ColumnsTab projectId={P} datasetId={D} header={HEADER} live={live} />);
  return calls;
}
const labelled = { 'catalog:columns': { body: { columns: { region: { values: L } } } } };
const saves = (calls: { channel: string; payload: unknown }[]) => calls.filter((c) => c.channel === SET).map((c) => c.payload);
const open = async (name: RegExp) => {
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog', { name: 'Value labels of region' });
};
const labelBox = (dialog: HTMLElement, value: string) => within(dialog).getByRole('textbox', { name: `Label for ${value}` }) as HTMLInputElement;

describe('the Columns tab’s "Value labels" cell', () => {
  it('a text column reads "Add labels", or how many once set; a number column has no cell', async () => {
    renderTab({});
    expect(await screen.findByRole('button', { name: 'Value labels of region: Add labels' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Value labels of amount/ })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Value labels' })).toBeTruthy();
  });

  it('says "2 labels" once two are set', async () => {
    renderTab(labelled);
    expect((await screen.findByRole('button', { name: 'Value labels of region: 2 labels' })).textContent).toBe('2 labels');
  });
});

describe('the value labels dialog: an editor', () => {
  it('nothing yet: a designed empty state that says what to do, with both ways in', async () => {
    renderTab({});
    const dialog = await open(/Add labels/);
    expect(within(dialog).getByRole('heading', { name: 'No labels yet' })).toBeTruthy();
    expect(dialog.textContent).not.toContain('—'); // no em dash in what a person reads
    expect(within(dialog).getAllByRole('button', { name: 'Fill from the data' }).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByRole('button', { name: 'Add a value' }).length).toBeGreaterThan(0);
  });

  it('lists value / label rows; "Fill from the data" adds a row per value not listed yet; Save sends the labelled rows only', async () => {
    const calls = renderTab({ ...labelled, 'dataset:distinct': { body: { values: ['EU', 'APAC', 'NA', 'LATAM'], total: 4 } }, [SET]: { body: { ok: true, column: { values: L } } } });
    const dialog = await open(/2 labels/);
    expect(labelBox(dialog, 'EU').value).toBe('Europe');
    expect(labelBox(dialog, 'NA').value).toBe('North America');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fill from the data' }));
    await waitFor(() => expect(within(dialog).getAllByRole('textbox', { name: /^Label for / }).map((x) => x.getAttribute('aria-label'))).toEqual(['Label for EU', 'Label for NA', 'Label for APAC', 'Label for LATAM']));
    expect(calls.find((c) => c.channel === 'dataset:distinct')?.payload).toEqual({ projectId: P, datasetId: D, column: 'region', limit: 200 });
    expect(within(dialog).getByRole('status').textContent).toContain('Added 2 values.');
    fireEvent.change(labelBox(dialog, 'APAC'), { target: { value: '  Asia Pacific ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves(calls)).toEqual([{ projectId: P, datasetId: D, column: 'region', patch: { values: [...L, { value: 'APAC', label: 'Asia Pacific' }] } }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // saved: the dialog closes
  });

  it('removes a row, and an unchanged list has nothing to save', async () => {
    const calls = renderTab({ ...labelled, [SET]: { body: { ok: true, column: {} } } });
    const dialog = await open(/2 labels/);
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove NA' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves(calls)).toEqual([{ projectId: P, datasetId: D, column: 'region', patch: { values: [L[0]] } }]));
  });

  it('shows the server\'s refusal in the dialog and keeps the rows', async () => {
    const refusal = 'Value labels are for text columns. region is a number column.';
    renderTab({ ...labelled, [SET]: { body: { ok: false, error: refusal } } });
    const dialog = await open(/2 labels/);
    fireEvent.change(labelBox(dialog, 'EU'), { target: { value: 'Europa' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(refusal);
    expect(labelBox(dialog, 'EU').value).toBe('Europa');
    expect(screen.getAllByText(refusal)).toHaveLength(1); // in the dialog, not in a toast beside it
  });

  it('says the server\'s rules before a save, in its sentences, and sends nothing: one label on two values', async () => {
    const calls = renderTab(labelled);
    const dialog = await open(/2 labels/);
    fireEvent.change(labelBox(dialog, 'NA'), { target: { value: 'Europe' } });
    expect(within(dialog).getByRole('alert').textContent).toBe('“Europe” would name both “EU” and “NA”. A label can name one value only.');
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(saves(calls)).toHaveLength(0);
  });

  it('a value typed by hand: blank, repeated or over 256 characters is said; one with no label is left out', async () => {
    const calls = renderTab({ ...labelled, [SET]: { body: { ok: true, column: {} } } });
    const dialog = await open(/2 labels/);
    const eu = labelBox(dialog, 'EU');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a value' }));
    const value = within(dialog).getByRole('textbox', { name: 'New value' }) as HTMLInputElement;
    const label = within(dialog).getByRole('textbox', { name: 'Label for the new value' }) as HTMLInputElement;
    fireEvent.change(label, { target: { value: 'Somewhere' } });
    expect(within(dialog).getByRole('alert').textContent).toBe('A value cannot be blank.');
    fireEvent.change(value, { target: { value: 'EU' } });
    expect(within(dialog).getByRole('alert').textContent).toBe('“EU” is listed twice.');
    fireEvent.change(value, { target: { value: 'v'.repeat(257) } });
    expect(within(dialog).getByRole('alert').textContent).toBe('A value can have at most 256 characters.');
    fireEvent.change(value, { target: { value: 'EU ' } }); // a stored value is matched exactly: "EU " is another one
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.change(label, { target: { value: '   ' } }); // no label: the row is left out
    fireEvent.change(eu, { target: { value: 'Europa' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves(calls)).toEqual([{ projectId: P, datasetId: D, column: 'region', patch: { values: [{ value: 'EU', label: 'Europa' }, L[1]] } }]));
  });

  it('more than 500 rows is the server\'s sentence too: the dialog checks with the server\'s own rule', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `l${i}` }));
    const problem = valueLabelProblem(rows(501));
    expect(problem && problemText(problem)).toBe('A column can have at most 500 value labels.');
    expect(valueLabelProblem(rows(500))).toBeNull(); // NEGATIVE CONTROL: 500 is allowed
  });

  it('a Live column with no list to give: "Fill from the data" says the server\'s sentence', async () => {
    const why = 'This column has not been synced yet. Sync the schema to list its values.';
    renderTab({ 'dataset:distinct': { body: { ok: false, code: 'live_refused', reason: 'notSynced', error: why } }, 'dataset:liveSchema': { body: { ok: true, columns: [] } } }, 'editor', true);
    const dialog = await open(/Add labels/);
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Fill from the data' })[0]);
    expect((await within(dialog).findByRole('alert')).textContent).toContain(why);
  });

  it('a save refreshes everything that draws a label, by the keys those screens are cached under', () => {
    expect([...LABEL_DRAWN_BY]).toEqual(expect.arrayContaining(['catalog:columns', 'visual:data', 'analysis:tile', 'visual:thumbs', 'visual:preview', 'explore:answer', 'answer:card', 'dataset:distinct']));
    expect(LABEL_DRAWN_BY).not.toContain('visual:dataBatch'); // not a query key
  });
});

describe('the value labels dialog: a viewer', () => {
  it('reads the list, with nothing to change', async () => {
    renderTab(labelled, 'viewer');
    const dialog = await open(/2 labels/);
    expect(dialog.textContent).toContain('Europe');
    expect(dialog.textContent).toContain('North America');
    expect(within(dialog).queryAllByRole('textbox')).toEqual([]);
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Fill from the data' })).toBeNull();
  });

  it('a column without labels is a dash, not a button', async () => {
    renderTab({}, 'viewer');
    await screen.findByRole('columnheader', { name: 'Value labels' });
    expect(screen.queryByRole('button', { name: /Value labels of region/ })).toBeNull();
  });
});

describe('the server\'s sentences, said before a save', () => {
  it('are the catalog\'s English, word for word', () => {
    const fill = (key: string, params: Record<string, string>) => Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, v), EN[key]);
    expect(problemText({ kind: 'repeatValue', value: 'EU' })).toBe(fill('valueLabelMessages.is_listed_twice', { value: 'EU' }));
    expect(problemText({ kind: 'sharedLabel', label: 'Europe', values: ['EU', 'NA'] })).toBe(fill('valueLabelMessages.would_name_both_and_a_label', { label: 'Europe', a: 'EU', b: 'NA' }));
    expect(problemText({ kind: 'tooMany' })).toBe(fill('valueLabelMessages.a_column_can_have_at_most', { count: '500' }));
    expect(problemText({ kind: 'blankValue' })).toBe(fill('valueLabelMessages.a_value_cannot_be_blank', {}));
    expect(problemText({ kind: 'valueTooLong', value: 'x' })).toBe(fill('valueLabelMessages.a_value_can_have_at_most', { max: '256' }));
    expect(problemText({ kind: 'emptyLabel', value: 'EU' })).toBe(fill('valueLabelMessages.needs_a_label', { value: 'EU' }));
  });
});

describe('filter pickers show the label and send the stored value', () => {
  const distinct = (payload: unknown): { body: unknown } => {
    const search = String((payload as { search?: string }).search ?? '').toLowerCase();
    const values = ['EU', 'APAC', 'NA'].filter((v) => !search || v.toLowerCase().includes(search) || (v === 'EU' && 'europe'.includes(search)));
    const pairs = [['EU', 'Europe'], ['NA', 'North America']].filter(([v]) => values.includes(v));
    return { body: { values, total: values.length, ...(pairs.length ? { valueLabels: pairs } : {}) } };
  };

  it('a dashboard dropdown: the option reads Europe, picking it sends EU, and the chip says Europe', async () => {
    serveRpc({ 'projects:roles': { body: { [P]: 'editor' } }, 'dataset:distinct': distinct });
    const changes: (ControlValue | undefined)[] = [];
    function Host() {
      const [v, setV] = useState<ControlValue | undefined>();
      const control = { kind: 'dropdown', datasetId: D, column: 'region', label: 'Region' } as NonNullable<Card['control']>;
      return <ControlWidget projectId={P} control={control} value={v} onChange={(next) => (changes.push(next), setV(next))} />;
    }
    wrap(<Host />);
    fireEvent.click(await screen.findByRole('button', { name: 'Region: All' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Europe' }));
    expect(changes).toEqual([{ value: 'EU' }]);
    expect(await screen.findByRole('button', { name: 'Region: Europe' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'EU' })).toBeNull();
  });

  it('the filter dialog: the checkbox reads Europe and the step filters EU', async () => {
    serveRpc({ 'dataset:distinct': distinct });
    const onApply = vi.fn();
    wrap(<FilterDialog projectId={P} datasetId={D} column="region" type="text" onClose={() => undefined} onApply={onApply} />);
    fireEvent.click(await screen.findByLabelText('Europe'));
    expect(screen.getByLabelText('APAC')).toBeTruthy(); // a value with no label says itself
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith([{ type: 'filter', column: 'region', op: 'in', values: ['EU'] }]);
  });

  it('the quick "Category…" filter: the option reads Europe and the filter is region = EU', async () => {
    serveRpc({ 'dataset:distinct': distinct });
    const edit = vi.fn();
    wrap(
      <EditorCtx.Provider value={{ projectId: P, edit } as unknown as EditorApi}>
        <QuickFilters datasetId={D} cols={[{ name: 'region', type: 'text' }]} />
      </EditorCtx.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Category…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Category: pick a value' });
    await waitFor(() => expect((within(dialog).getByRole('combobox', { name: 'Value' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Value' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Europe' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    const d = { filters: [] as unknown[] };
    edit.mock.calls[0][1](d);
    expect(d.filters).toEqual([{ type: 'filter', column: 'region', op: '=', value: 'EU' }]);
  });
});
