// The Data model's Source tables tab: its list, its strip, and who may see it (docs/semantic-layer/02-source-tables.md D3-D5).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../../test-utils';
import { sourceTodoText } from './api';
import { body, daysAgo, LAZY, ORD, P, PUB, S, serve, W } from './testServe';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const nav = () => screen.findByRole('navigation', { name: 'Source tables' }, LAZY);
const params = (r: { state: { location: { search: string } } }) => new URLSearchParams(r.state.location.search);

describe('The Data model: source tables', () => {
  it('is a tab for an editor, second after Datasets', async () => {
    serve();
    renderApp(`/model/${P}?tab=sources`);
    await nav();
    const tabs = within(screen.getByRole('tablist', { name: 'Data model views' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Datasets', 'Source tables', 'Metrics', 'Glossary', 'Relationships', 'Assistant']); // part 3's Assistant tab last
    expect(screen.getByText('Tables in your databases and warehouses that datasets are built from. Only editors of this project see this tab.')).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('lists the tables under their connection, and marks a used table with no doc', async () => {
    serve();
    renderApp(`/model/${P}?tab=sources`);
    const list = await nav();
    const captions = within(list).getAllByRole('list').map((l) => document.getElementById(l.getAttribute('aria-labelledby') ?? '')?.textContent);
    expect(captions).toEqual(['Warehouse', 'Shop DB']);
    expect(within(list).getByText('Snowflake')).toBeTruthy();
    const returns = within(list).getByRole('button', { name: /RETURNS/ });
    expect(within(returns).getByText('no doc')).toBeTruthy();
    expect(within(returns).getByRole('img', { name: 'Datasets are built from it, and it has no doc' })).toBeTruthy();
    const orders = within(list).getByRole('link', { name: /ANALYTICS\.ORDERS/ });
    expect(within(orders).getByText('2 datasets')).toBeTruthy();
    expect(within(orders).queryByRole('img')).toBeNull();
    expect(within(list).getByRole('link', { name: /ANALYTICS\.CUSTOMERS/ }).textContent).toContain('1 dataset');
    // Nothing picked: the first documented one is, and it says so.
    expect(orders.getAttribute('aria-current')).toBe('true');
  });

  it('shows the server\'s gaps and how many more; a used table with no doc opens in the page, never in the URL', async () => {
    serve();
    const router = renderApp(`/model/${P}?tab=sources`);
    const s = await screen.findByRole('region', { name: 'To fill in next' }, LAZY);
    const buttons = within(s).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['RETURNS: no doc', 'ANALYTICS.CUSTOMERS: no owner', 'public.orders: never read', 'ANALYTICS.CUSTOMERS: no guide']);
    expect(within(s).getByText('+2 more')).toBeTruthy();
    fireEvent.click(within(s).getByRole('button', { name: 'RETURNS: no doc' }));
    const panel = await screen.findByRole('region', { name: 'About RETURNS' });
    expect(within(panel).getByRole('heading', { level: 2, name: 'RETURNS' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Start its notes' })).toBeTruthy();
    expect(within(await nav()).getByRole('button', { name: /RETURNS/ }).getAttribute('aria-current')).toBe('true');
    expect(router.state.location.search).not.toContain('RETURNS');
    expect(params(router).get('doc')).toBeNull();
    // A documented one is a link: conn and doc ids, never its name.
    fireEvent.click(within(s).getByRole('button', { name: 'public.orders: never read' }));
    await waitFor(() => expect(params(router).get('doc')).toBe(PUB));
    expect(params(router).get('conn')).toBe(S);
    expect(router.state.location.search).not.toContain('orders');
  });

  it('a project with no source tables says how they get here', async () => {
    serve({ 'sourceTable:list': body({ ok: true, connections: [], todo: [], more: 0 }) });
    renderApp(`/model/${P}?tab=sources`);
    expect(await screen.findByRole('heading', { name: 'No source tables yet' }, LAZY)).toBeTruthy();
    expect(screen.getByText('Datasets you import from a connection show their tables here. Add one from a connection.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Connections' }).getAttribute('href')).toBe(`/connections/${P}`);
    expect(screen.queryByRole('region', { name: 'To fill in next' })).toBeNull();
  });

  it('an old server without the channel shows the error state, and Retry asks again', async () => {
    const calls = serve({ 'sourceTable:list': { status: 404, body: { error: 'not_found', message: 'Unknown channel' } } });
    renderApp(`/model/${P}?tab=sources`);
    const alert = await screen.findByRole('alert', {}, LAZY);
    expect(alert.textContent).toContain('Source tables could not be loaded');
    expect(calls.filter((c) => c.channel === 'sourceTable:list')).toHaveLength(1);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'sourceTable:list')).toHaveLength(2));
  });

  it('NEGATIVE CONTROL: a viewer has no tab, its address lands on Datasets, and the channel is never asked', async () => {
    const calls = serve({}, 'viewer');
    const router = renderApp(`/model/${P}?tab=sources&conn=${W}&doc=${ORD}`);
    await waitFor(() => expect(params(router).get('tab')).toBe('datasets'), LAZY);
    expect(params(router).get('doc')).toBeNull();
    await screen.findByRole('tablist', { name: 'Data model views' }, LAZY);
    expect(screen.queryByRole('tab', { name: 'Source tables' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Datasets' }).getAttribute('aria-selected')).toBe('true');
    expect(calls.some((c) => c.channel.startsWith('sourceTable:'))).toBe(false);
  });

  it('an editor\'s deep link waits for the roles, and is not bounced', async () => {
    serve();
    // Hold the roles' answer: until it lands, the caller may be an editor or a viewer.
    const inner = globalThis.fetch;
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes(encodeURIComponent('projects:roles'))) await held;
      return inner(url, init);
    });
    const router = renderApp(`/model/${P}?tab=sources`);
    expect(await screen.findByRole('status', { name: 'Loading the source tables' }, LAZY)).toBeTruthy();
    expect(params(router).get('tab')).toBe('sources');
    release();
    await nav();
    expect(params(router).get('tab')).toBe('sources');
  }, 30_000);
});

describe('sourceTodoText', () => {
  it('words each gap from the table name; a stale read says how long ago', () => {
    const t = (kind: Parameters<typeof sourceTodoText>[0]['kind'], table: string, readAt?: string) => sourceTodoText({ connId: W, docId: ORD, table, kind }, readAt);
    expect([t('used_no_doc', 'RETURNS'), t('no_owner', 'CUSTOMERS'), t('never_read', 'public.orders'), t('no_guide', 'ORDERS'), t('stale_read', 'FCT_SALES', daysAgo(41))]).toEqual([
      'RETURNS: no doc',
      'CUSTOMERS: no owner',
      'public.orders: never read',
      'ORDERS: no guide',
      'FCT_SALES: read 41d ago',
    ]);
  });
});
