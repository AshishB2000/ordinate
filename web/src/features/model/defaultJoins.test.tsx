import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import type { Relationship } from '../data/api';
import { defaultJoinLines } from './relationships/DefaultJoins';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const SALES = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const DATES = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const REGIONS = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };

const rel = (id: string, from: [string, string], to: [string, string], more: Partial<Relationship> = {}): Relationship => ({
  id, from: { datasetId: from[0], column: from[1] }, to: { datasetId: to[0], column: to[1] }, cardinality: 'many_to_one',
  verified: { matched: 40, unmatchedFrom: 0 }, matchPct: 100, ...more,
});
const ORDER = rel('r1', [SALES, 'order_date'], [DATES, 'date'], { label: 'Order date' });
const SHIP = rel('r2', [SALES, 'ship_date'], [DATES, 'date'], { label: 'Ship date' });
const NAMES: Record<string, string> = { [SALES]: 'Sales', [DATES]: 'Dates', [REGIONS]: 'Regions' };
const name = (id: string) => NAMES[id];

describe('defaultJoinLines', () => {
  it('names the first join of a pair, then the ones a chart must pick', () => {
    expect(defaultJoinLines([ORDER, SHIP], name)).toEqual(['Charts use Order date unless they pick Ship date.']);
  });

  it('an unlabelled join is named by its lookup table and its column, as step 09 names it', () => {
    const plain = (r: Relationship) => ({ ...r, label: undefined });
    expect(defaultJoinLines([plain(ORDER), plain(SHIP)], name)).toEqual(['Charts use Dates (order_date) unless they pick Dates (ship_date).']);
  });

  it('NEGATIVE CONTROL: one join, or two between different pairs, says nothing', () => {
    expect(defaultJoinLines([ORDER], name)).toEqual([]);
    expect(defaultJoinLines([ORDER, rel('r3', [SALES, 'region'], [REGIONS, 'region'])], name)).toEqual([]);
  });
});

function serve(routes: Record<string, RpcReply> = {}) {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 2, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: 'editor' }),
    'catalog:tags': body({ ok: true, tags: [], refs: {} }),
    'dataset:list': body([SALES, DATES].map((id) => ({ id, name: NAMES[id], sourceKind: 'csv', rowCount: 40, columnCount: 3, updatedAt: '' }))),
    'relationship:list': body({ ok: true, relationships: [{ ...ORDER, warning: { kind: 'repeats', repeats: 2 } }, SHIP] }),
    ...routes,
  });
}

describe('The Data model: relationships', () => {
  it('draws the relationships with their warning and label, then which one charts use', async () => {
    vi.stubGlobal('CSS', { escape: (x: string) => x }); // the diagram's edge lookup; jsdom has no CSS.escape
    serve();
    renderApp(`/model/${P}?tab=relationships`);
    const section = await screen.findByRole('region', { name: 'Relationships' }, LAZY);
    expect(within(section).getByText('Dates repeats some date values. Each lookup uses the first matching row.')).toBeTruthy(); // step 01's sentence
    expect(within(section).getAllByText('Order date').length).toBeGreaterThan(0);
    const note = await screen.findByRole('note', { name: 'Which join charts use' });
    expect(within(note).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Charts use Order date unless they pick Ship date.']);
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('/data/P?tab=relationships and /data?tab=relationships both land on the Data model', async () => {
    vi.stubGlobal('CSS', { escape: (x: string) => x });
    serve();
    for (const from of [`/data/${P}?tab=relationships`, '/data?tab=relationships']) {
      const router = renderApp(from);
      await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(`/model/${P}?tab=relationships`), LAZY);
      cleanup();
    }
  }, 30_000);

  it('Data keeps Datasets, Captures and Catalog', async () => {
    serve();
    renderApp(`/data/${P}`);
    const tabs = await screen.findByRole('tablist', { name: 'Data views' }, LAZY);
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Datasets', 'Captures', 'Catalog']);
  }, 30_000);
});
