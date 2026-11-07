// Status on the Data model's screens: badges, the Retired filter, admin-only actions and the review items in the strip.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };
const at = { by: 'ana@acme.com', at: '2026-11-03T10:00:00Z', note: '' };
const metric = (id: string, name: string, status?: object) => ({
  id, name, datasetId: D, datasetName: 'Orders', definition: { column: 'amount', aggregation: 'sum' }, definitionText: `sum of ${name}`, format: { kind: 'number' }, updatedAt: '', ...(status && { status }),
});
const METRICS = [
  metric('m1', 'Revenue', { state: 'certified', ...at }),
  metric('m2', 'Margin', { state: 'needs_review', ...at }),
  metric('m3', 'Gross revenue', { state: 'retired', ...at, replacedBy: { ref: 'metric:m1', name: 'Revenue' } }),
  metric('m4', 'Plain'),
];
const ROWS = Object.fromEntries(METRICS.map((m) => [m.id, { display: '2', series: null, usage: { total: 0, summary: '', refs: [] } }]));

function serve(role: 'admin' | 'editor' | 'viewer', routes: Record<string, RpcReply> = {}) {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'catalog:tags': body({ ok: true, tags: [], refs: {} }),
    'dataset:list': body([{ id: D, name: 'Orders', sourceKind: 'csv', rowCount: 10, columnCount: 3, updatedAt: '' }]),
    'metric:table': body({ ok: true, metrics: METRICS, rows: ROWS }),
    ...routes,
  });
}
const rowOf = async (name: string) => (await screen.findByText(name, {}, LAZY)).closest('tr')!;

describe('the Metrics tab', () => {
  it('draws each badge and filters to Certified or Retired', async () => {
    serve('editor');
    renderApp(`/model/${P}?tab=metrics`);
    expect(within(await rowOf('Revenue')).getByText('Certified')).toBeTruthy();
    expect(within(await rowOf('Margin')).getByText('Changed since certified')).toBeTruthy();
    expect(within(await rowOf('Gross revenue')).getByText('Retired · use Revenue')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retired' }));
    expect(screen.queryByText('Revenue', { selector: 'button, span' })).toBeNull();
    expect(screen.getByText('Gross revenue')).toBeTruthy();
    expect(screen.queryByText('Plain')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Certified' }));
    expect(screen.getByText('Revenue')).toBeTruthy();
    expect(screen.queryByText('Gross revenue')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Plain')).toBeTruthy();
  }, 30_000);
  it('only an admin gets the status actions', async () => {
    serve('editor');
    renderApp(`/model/${P}?tab=metrics`);
    await rowOf('Revenue');
    expect(screen.queryByRole('button', { name: 'Status of Revenue' })).toBeNull();
    cleanup();
    serve('admin');
    renderApp(`/model/${P}?tab=metrics`);
    expect(await screen.findByRole('button', { name: 'Status of Revenue' }, LAZY)).toBeTruthy();
  }, 30_000);
});

describe('the strip', () => {
  it('draws the review items after the gaps, in words', async () => {
    serve('admin', {
      'model:overview': { body: { ok: true, tables: [{ datasetId: D, role: 'fact', key: '', keyState: '', description: '', alwaysApplied: { kind: 'prepare', steps: [] }, calculated: [] }], todo: [{ datasetId: D, kind: 'no_key' }], more: 0, review: [{ ref: 'metric:m1', name: 'Revenue', kind: 'needs_review' }, { ref: 'metric:m3', name: 'Gross revenue', kind: 'retired_used', uses: 6 }] } },
    });
    renderApp(`/model/${P}`);
    const strip = await screen.findByRole('region', { name: 'To fill in next' }, LAZY);
    const chips = within(strip).getAllByRole('button').map((b) => b.textContent);
    expect(chips).toEqual(['Set a key on Orders', 'Revenue changed since certified', 'Gross revenue is retired, used by 6']);
  }, 30_000);

  it('draws the gaps, then the review items, then the suggested meanings chip (part 2)', async () => {
    serve('admin', {
      'model:overview': { body: { ok: true, tables: [{ datasetId: D, role: 'fact', key: '', keyState: '', description: '', alwaysApplied: { kind: 'prepare', steps: [] }, calculated: [] }], todo: [{ datasetId: D, kind: 'no_key' }], more: 0, review: [{ ref: 'metric:m1', name: 'Revenue', kind: 'needs_review' }] } },
      'catalog:suggestions': { body: { ok: true, suggestions: [{ connId: D, docId: D, table: 'ANALYTICS.ORDERS', datasetId: D, kind: 'column', column: 'amt', text: 'Order amount', hash: 'AbCdEf012345' }], total: 2, datasets: 1 } },
    });
    renderApp(`/model/${P}`);
    const strip = await screen.findByRole('region', { name: 'To fill in next' }, LAZY);
    await within(strip).findByRole('button', { name: '2 suggested meanings' }, LAZY);
    expect(within(strip).getAllByRole('button').map((b) => b.textContent)).toEqual(['Set a key on Orders', 'Revenue changed since certified', '2 suggested meanings']);
  }, 30_000);

  it('opens the Metrics tab from a review chip (the shared chip strip routes it)', async () => {
    serve('admin', {
      'model:overview': { body: { ok: true, tables: [{ datasetId: D, role: 'fact', key: '', keyState: '', description: '', alwaysApplied: { kind: 'prepare', steps: [] }, calculated: [] }], todo: [{ datasetId: D, kind: 'no_key' }], more: 0, review: [{ ref: 'metric:m1', name: 'Revenue', kind: 'needs_review' }] } },
    });
    renderApp(`/model/${P}`);
    const strip = await screen.findByRole('region', { name: 'To fill in next' }, LAZY);
    fireEvent.click(within(strip).getByRole('button', { name: 'Revenue changed since certified' }));
    expect(await screen.findByRole('tab', { name: 'Metrics', selected: true }, LAZY)).toBeTruthy();
  }, 30_000);
});

describe('the Prepare page of a certified dataset', () => {
  it('shows the standing banner, and not for an uncertified one', async () => {
    const { CertifiedBanner } = await import('./CertifiedBanner');
    const { render } = await import('@testing-library/react');
    const { container, rerender } = render(<CertifiedBanner status={{ state: 'certified', ...at }} />);
    expect(screen.getByRole('note').textContent).toBe('Certified by ana@acme.com. Changes here need a project admin to certify it again.');
    rerender(<CertifiedBanner status={{ state: 'needs_review', ...at }} />);
    expect(container.firstChild).toBeNull();
    rerender(<CertifiedBanner />);
    expect(container.firstChild).toBeNull();
  });
});
