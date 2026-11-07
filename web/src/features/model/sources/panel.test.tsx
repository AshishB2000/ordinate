// A source table's panel: Overview, Columns, and reading from the warehouse on a click only (02-source-tables.md D5, D8).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../../test-utils';
import { body, daysAgo, doc, FACTS, got, LAZY, listWith, ORD, P, serve, W, X } from './testServe';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (panel = '') => renderApp(`/model/${P}?tab=sources&conn=${W}&doc=${ORD}${panel ? `&panel=${panel}` : ''}`);
const panel = () => screen.findByRole('region', { name: 'About ANALYTICS.ORDERS' }, LAZY);
const rowText = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
const count = (calls: { channel: string }[], channel: string) => calls.filter((c) => c.channel === channel).length;

describe('A source table\'s panel', () => {
  it('Overview: the facts in order, a row with no value left out', async () => {
    serve({ 'sourceTable:get': got() });
    open();
    const p = await panel();
    expect(within(p).getByRole('heading', { level: 2, name: 'ANALYTICS.ORDERS' })).toBeTruthy();
    await within(p).findByText('Primary key', { selector: 'dt' });
    expect([...p.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Connection', 'Owner', 'Refreshes', 'Required', 'Primary key', 'Partitioned by', 'Clustered by', 'Rows', 'Built from it']);
    expect(rowText('Connection')).toBe('Warehouse (Snowflake)');
    expect(rowText('Primary key')).toBe('LINE_ID (declared, not enforced)');
    expect(rowText('Partitioned by')).toBe('ORDER_DATE (DAY) · queries must filter on it');
    expect(rowText('Clustered by')).toBe('ORDER_DATE, REGION');
    expect(rowText('Rows')).toBe('~48,200,000 (the warehouse\'s estimate) · ~12.4 GB');
    expect(within(p).getByRole('link', { name: 'Orders (copy)' }).getAttribute('href')).toBe(`/model/${P}?tab=datasets&dataset=${X}`);
    expect(within(p).getByText(/^Read 3d ago by sam@acme\.test$/)).toBeTruthy();
    expect(within(p).getByRole('button', { name: 'Read again' })).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('Overview: what nobody wrote says so', async () => {
    serve({ 'sourceTable:get': got(doc({ owner: '', refresh: '', requiredFilters: '', facts: undefined })) });
    open();
    await panel();
    await screen.findByText('Owner', { selector: 'dt' });
    expect(rowText('Owner')).toBe('Not written yet');
    expect(rowText('Refreshes')).toBe('Not written yet');
    expect(rowText('Required')).toBe('Not written yet');
    expect(screen.queryByText('Primary key', { selector: 'dt' })).toBeNull();
    expect(screen.getByText('Never read')).toBeTruthy();
  });

  it('Columns: type, comment and the key, from the stored facts', async () => {
    serve({ 'sourceTable:get': got() });
    open('columns');
    const table = await screen.findByRole('table', { name: 'Columns of ANALYTICS.ORDERS' }, LAZY);
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Column', 'Warehouse type', 'Comment', 'Key']);
    expect(within(table).getByText('Discount in USD, after tax')).toBeTruthy();
    expect(within(table).getAllByText('key')).toHaveLength(1);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('never read: says so; Read sends one read and refreshes the list', async () => {
    const calls = serve({
      'sourceTable:get': got(doc({ facts: undefined })),
      'sourceTable:read': body({ ok: true, doc: doc() }),
    });
    open('columns');
    const empty = await screen.findByRole('heading', { name: 'Not read from the warehouse yet' }, LAZY);
    const lists = count(calls, 'sourceTable:list');
    const card = empty.parentElement as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Read from warehouse' }));
    expect(await screen.findByText('Discount in USD, after tax')).toBeTruthy();
    expect(count(calls, 'sourceTable:read')).toBe(1);
    expect(calls.find((c) => c.channel === 'sourceTable:read')?.payload).toEqual({ projectId: P, connId: W, docId: ORD });
    await waitFor(() => expect(count(calls, 'sourceTable:list')).toBe(lists + 1));
  });

  it('a refused read says the server\'s sentence and keeps the columns it had', async () => {
    const said = 'This connection’s tables were read 60 times in the last hour. Try again in 12 min.';
    const calls = serve({ 'sourceTable:get': got(), 'sourceTable:read': body({ ok: false, error: said, retryAfterSec: 700 }) });
    open('columns');
    await screen.findByRole('table', { name: 'Columns of ANALYTICS.ORDERS' }, LAZY);
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(said);
    expect(screen.getByText('Discount in USD, after tax')).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(count(calls, 'sourceTable:read')).toBe(2));
  });

  it('a source with no catalog: notes by hand, and no read button', async () => {
    serve({ 'sourceTable:list': body(listWith({ connectorId: 'hubspot', label: 'HubSpot', readsFacts: false })), 'sourceTable:get': got(doc({ facts: undefined })) });
    open('columns');
    expect(await screen.findByText('This source has no catalog Ordinate can read. Write its notes by hand.', {}, LAZY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Read/ })).toBeNull();
  });

  it('Databricks: the button says a read can start the warehouse', async () => {
    serve({ 'sourceTable:list': body(listWith({ connectorId: 'databricks-sql', label: 'Databricks SQL', factsWake: true })), 'sourceTable:get': got() });
    open();
    expect(await screen.findByText('Reading runs on the SQL warehouse and can start it.', {}, LAZY)).toBeTruthy();
  });

  it('NEGATIVE CONTROL: no wake line for a warehouse a read cannot start', async () => {
    serve({ 'sourceTable:get': got() });
    open();
    await screen.findByRole('button', { name: 'Read again' }, LAZY);
    expect(screen.queryByText('Reading runs on the SQL warehouse and can start it.')).toBeNull();
  });

  it('a read over 30 days old is flagged', async () => {
    serve({ 'sourceTable:get': got(doc({ facts: { ...FACTS, readAt: daysAgo(41) } })) });
    open();
    expect(await screen.findByText('read 41d ago', {}, LAZY)).toBeTruthy();
  });

  it('a used table with no doc: its overview, and Start its notes puts the new doc\'s id in the address', async () => {
    const calls = serve({ 'sourceTable:save': body({ ok: true, docId: ORD, created: true, tag: 'T0' }), 'sourceTable:get': got() });
    const router = renderApp(`/model/${P}?tab=sources`);
    const list = await screen.findByRole('navigation', { name: 'Source tables' }, LAZY);
    fireEvent.click(within(list).getByRole('button', { name: /RETURNS/ }));
    const p = await screen.findByRole('region', { name: 'About RETURNS' });
    expect([...p.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Connection', 'Owner', 'Refreshes', 'Required', 'Built from it']);
    expect(rowText('Built from it')).toBe('1 dataset');
    fireEvent.click(within(p).getByRole('button', { name: 'Start its notes' }));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('doc')).toBe(ORD));
    expect(calls.find((c) => c.channel === 'sourceTable:save')?.payload).toEqual({ projectId: P, connId: W, table: 'RETURNS', patch: {} });
  }, 30_000);

  it('NEGATIVE CONTROL: opening every tab of the panel asks the warehouse nothing', async () => {
    const calls = serve({ 'sourceTable:get': got() });
    open();
    await screen.findByRole('button', { name: 'Read again' }, LAZY);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Columns' }));
    await screen.findByRole('table', { name: 'Columns of ANALYTICS.ORDERS' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Overview' }));
    await screen.findByText('Primary key', { selector: 'dt' });
    expect(calls.filter((c) => c.channel === 'sourceTable:read' || c.channel.startsWith('connection:'))).toEqual([]);
    expect(count(calls, 'sourceTable:get')).toBe(1);
  });
});
