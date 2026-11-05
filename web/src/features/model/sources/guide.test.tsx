// A source table's Guide and its notes form: markdown, edits through the edit guard, deleting the notes (02-source-tables.md D1, D5).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../../test-utils';
import { body, CUS, doc, got, LAZY, LIST, ORD, P, serve, W } from './testServe';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (panel = '') => renderApp(`/model/${P}?tab=sources&conn=${W}&doc=${ORD}${panel ? `&panel=${panel}` : ''}`);
const count = (calls: { channel: string }[], channel: string) => calls.filter((c) => c.channel === channel).length;
const form = () => screen.findByRole('dialog', { name: 'Notes on ANALYTICS.ORDERS' });
const CHANGED = { status: 409, body: { error: 'record_changed', code: 'record_changed', message: 'This was changed in another tab or by someone else.', tag: 'ELSEWHERE' } };

describe('A source table\'s guide', () => {
  it('renders the guide as markdown, with who edited it last', async () => {
    serve({ 'sourceTable:get': got() });
    open('guide');
    expect(await screen.findByRole('heading', { level: 3, name: 'Filter on ORDER_DATE' }, LAZY)).toBeTruthy();
    expect(screen.getByText(/^Last edited by pat@acme\.test, 1d ago$/)).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('no guide: says what to write, and Write guide opens the form at the guide', async () => {
    serve({ 'sourceTable:get': got(doc({ guide: '' })) });
    open('guide');
    expect(await screen.findByText('Write this table’s guide: partitions, filters to always use, load times. Datasets built from it show it in their own Guide.', {}, LAZY)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write guide' }));
    const f = await form();
    expect(document.activeElement).toBe(within(f).getByLabelText('Guide'));
  });

  it('Edit: a save sends the open copy\'s tag and only what changed, then refreshes the list', async () => {
    const calls = serve({ 'sourceTable:get': got(doc({ owner: '' }), 'TAG-1'), 'sourceTable:save': body({ ok: true, docId: ORD, tag: 'TAG-2' }) });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }, LAZY));
    const f = await form();
    const lists = count(calls, 'sourceTable:list');
    fireEvent.change(within(f).getByLabelText('Owner'), { target: { value: 'Data platform' } });
    fireEvent.click(within(f).getByRole('button', { name: 'Save notes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((c) => c.channel === 'sourceTable:save')?.payload).toEqual({ projectId: P, connId: W, docId: ORD, patch: { owner: 'Data platform' }, base: 'TAG-1' });
    await waitFor(() => expect(count(calls, 'sourceTable:list')).toBe(lists + 1));
  });

  it('someone else saved first: the conflict banner, and what was typed stays', async () => {
    serve({ 'sourceTable:get': got(), 'sourceTable:save': CHANGED });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }, LAZY));
    const f = await form();
    fireEvent.change(within(f).getByLabelText('Refreshes'), { target: { value: 'Every night at 2' } });
    fireEvent.click(within(f).getByRole('button', { name: 'Save notes' }));
    const banner = await within(f).findByRole('alert');
    expect(banner.textContent).toContain('This source table doc was changed in another tab or by someone else.');
    expect(within(banner).queryByRole('button', { name: 'Save mine as a copy' })).toBeNull();
    expect((within(f).getByLabelText('Refreshes') as HTMLInputElement).value).toBe('Every night at 2');
  });

  it('the guide counts up to 8,000 and takes no more', async () => {
    serve({ 'sourceTable:get': got() });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }, LAZY));
    const g = within(await form()).getByLabelText('Guide') as HTMLTextAreaElement;
    fireEvent.change(g, { target: { value: 'x'.repeat(8_000) } });
    expect(screen.getByText(/8,000 of 8,000 characters/)).toBeTruthy();
    fireEvent.change(g, { target: { value: 'x'.repeat(8_001) } });
    expect(g.value).toHaveLength(8_000);
  });

  it('Delete notes asks first, deletes, and moves to the next table', async () => {
    let deleted = false;
    const [wh, shop] = LIST.connections;
    const calls = serve({
      'sourceTable:list': () => body(deleted ? { ...LIST, connections: [{ ...wh, rows: wh.rows.filter((r) => r.docId !== ORD) }, shop] } : LIST),
      'sourceTable:get': (p) => got(doc((p as { docId: string }).docId === CUS ? { docId: CUS, table: 'ANALYTICS.CUSTOMERS' } : {})),
      'sourceTable:delete': () => {
        deleted = true;
        return body({ ok: true });
      },
    });
    const router = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }, LAZY));
    fireEvent.click(within(await form()).getByRole('button', { name: 'Delete notes' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete the notes on ANALYTICS.ORDERS?' });
    fireEvent.change(within(confirm).getByRole('textbox'), { target: { value: 'ANALYTICS.ORDERS' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete notes' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'sourceTable:delete')?.payload).toEqual({ projectId: P, connId: W, docId: ORD }));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('doc')).toBeNull());
    expect(await screen.findByRole('region', { name: 'About ANALYTICS.CUSTOMERS' })).toBeTruthy();
    expect(count(calls, 'sourceTable:delete')).toBe(1);
  });
});
