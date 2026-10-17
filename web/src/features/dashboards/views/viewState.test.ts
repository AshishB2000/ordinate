// The browser's reading of a saved view against the server's
// (src/analysis/savedViews.ts, its compiled JS — never shipped to the browser):
// the view a dashboard opens on, and the value each control takes under a view,
// compared with Object.is. A gathered state survives the server's whitelist
// unchanged and puts the same state back; NEGATIVE CONTROL: a pick the record
// cannot hold is changed by the server, so the round trip would show it.

import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Card, ControlValue, Parameter, SavedView, Sheet, Step } from '../../analyses/api';
import { gatherView, openingView, seedFromView, viewOptions, AUTHORED, type LiveState } from './viewState';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
type Server = {
  openingView(views: SavedView[], defaultViewId: string, requested?: string | null): SavedView | null;
  sanitizeViewState(raw: unknown, scope: { sheets: Sheet[]; parameters: Parameter[] }): SavedView['state'];
  viewControlValue(view: SavedView | null, card: Card): ControlValue | null;
};
const server = require(path.join(ROOT, 'src/analysis/savedViews.js')) as Server;

const P1 = '22222222-2222-4222-8222-222222222221';
const P2 = '22222222-2222-4222-8222-222222222222';
const REGION = '33333333-3333-4333-8333-333333333331';
const SEGS = '33333333-3333-4333-8333-333333333332';
const DATES = '33333333-3333-4333-8333-333333333333';
const PCTRL = '33333333-3333-4333-8333-333333333334';
const CHART = '33333333-3333-4333-8333-333333333335';
const TABS = '33333333-3333-4333-8333-333333333336';
const TAB_B = '44444444-4444-4444-8444-444444444442';
const DS = '55555555-5555-4555-8555-555555555555';
const PARAM = '66666666-6666-4666-8666-666666666666';
const V1 = '77777777-7777-4777-8777-777777777771';
const V2 = '77777777-7777-4777-8777-777777777772';
const layout = { x: 0, y: 0, w: 3, h: 1 };

const sheets: Sheet[] = [
  {
    id: P1,
    name: 'Overview',
    cards: [
      { id: REGION, type: 'control', layout, control: { kind: 'dropdown', label: 'Region', datasetId: DS, column: 'region', default: { value: 'East' } } },
      { id: SEGS, type: 'control', layout, control: { kind: 'multi', label: 'Segment', datasetId: DS, column: 'segment' } },
      { id: DATES, type: 'control', layout, control: { kind: 'date_range', label: 'Order date', datasetId: DS, column: 'order_date', default: { preset: 'ytd' } } },
      { id: PCTRL, type: 'control', layout, control: { kind: 'parameter', label: 'Target', datasetId: '', column: '', paramId: PARAM } },
      { id: CHART, type: 'visual', layout, visualId: DS },
    ],
  },
  { id: P2, name: 'Detail', cards: [{ id: TABS, type: 'tabs', layout, tabs: { items: [{ id: '44444444-4444-4444-8444-444444444441', name: 'A' }, { id: TAB_B, name: 'B' }] } }] },
];
const parameters: Parameter[] = [{ id: PARAM, name: 'target', kind: 'number', value: 100, min: 0, max: 500 }];
const step = (column: string, value: string): Step => ({ type: 'filter', column, op: '=', value });

const live: LiveState = {
  sheets,
  sheet: 1,
  controls: new Map<string, ControlValue>([
    [REGION, { value: 'West' }],
    [DATES, { preset: 'last_n_days', n: 30 }],
  ]),
  parameters,
  params: new Map<string, unknown>([[PARAM, 250]]),
  selection: [step('category', 'Technology')],
  narrowed: new Map([[CHART, [step('quarter', 'Q4')]]]),
  groupTabs: new Map([[TABS, TAB_B]]),
  asOf: '2026-09-30T12:00:00.000Z',
};
const view = (id: string, name: string, state: unknown): SavedView => ({ id, name, state: state as SavedView['state'], createdAt: '', updatedAt: '' });

describe('a saved view, the browser’s half', () => {
  it('gathers every control (null = All), the moved parameters, the page, selection, narrowing, tabs and As of', () => {
    expect(gatherView(live)).toEqual({
      page: P2,
      controls: { [REGION]: { value: 'West' }, [SEGS]: null, [DATES]: { preset: 'last_n_days', n: 30 } },
      params: { [PARAM]: 250 },
      selection: [step('category', 'Technology')],
      tiles: { [CHART]: [step('quarter', 'Q4')] },
      groupTabs: { [TABS]: TAB_B },
      asOf: '2026-09-30T12:00:00.000Z',
    });
    // A parameter moved back to its saved value is not a change.
    expect(gatherView({ ...live, params: new Map([[PARAM, 100]]) }).params).toEqual({});
  });

  it('round trip: what is gathered survives the server’s whitelist unchanged, and seeds the same state back', () => {
    const state = gatherView(live);
    const stored = server.sanitizeViewState(JSON.parse(JSON.stringify(state)), { sheets, parameters });
    expect(stored).toEqual(state);
    const seed = seedFromView(view(V1, 'West', stored), sheets, parameters);
    expect(gatherView({ ...live, sheet: seed.sheet, controls: seed.controls, params: seed.params, selection: seed.selection, narrowed: seed.narrowed, groupTabs: seed.groupTabs, asOf: seed.asOf })).toEqual(state);
  });

  it('NEGATIVE CONTROL: a pick the record cannot hold is changed by the server — the round trip would show it', () => {
    const bad = gatherView({ ...live, controls: new Map<string, ControlValue>([[REGION, { values: ['West'] }]]) });
    const stored = server.sanitizeViewState(JSON.parse(JSON.stringify(bad)), { sheets, parameters });
    expect(stored).not.toEqual(bad);
    expect(Object.prototype.hasOwnProperty.call(stored.controls, REGION)).toBe(false);
  });

  it('DIFFERENTIAL: every control’s value under a view is the server’s viewControlValue (Object.is at each leaf)', () => {
    const views = [null, view(V1, 'West', server.sanitizeViewState(gatherView(live), { sheets, parameters })), view(V2, 'Bare', server.sanitizeViewState({ controls: { [SEGS]: { values: ['Consumer'] } } }, { sheets, parameters }))];
    let compared = 0;
    for (const v of views) {
      const seed = seedFromView(v, sheets, parameters);
      for (const card of sheets[0].cards.filter((c) => c.type === 'control' && c.control?.kind !== 'parameter')) {
        const mine = JSON.stringify(seed.controls.get(card.id) ?? null);
        const theirs = JSON.stringify(server.viewControlValue(v, card));
        expect(Object.is(mine, theirs)).toBe(true);
        compared++;
      }
    }
    expect(compared).toBe(9);
  });

  it('DIFFERENTIAL: the view a dashboard opens on is the server’s openingView, ids case-folded', () => {
    const list = [view(V1, 'West', {}), view(V2, 'East', {})];
    for (const [def, req] of [
      [V2, V1],
      [V2, null],
      [V2, '77777777-7777-4777-8777-000000000000'],
      ['', null],
      ['', V1.toUpperCase()],
      [V2.toUpperCase(), undefined],
    ] as Array<[string, string | null | undefined]>) {
      expect(Object.is(openingView(list, def, req), server.openingView(list, def, req))).toBe(true);
    }
    expect(openingView(list, '', V1.toUpperCase())?.id).toBe(V1);
  });

  it('as authored: the author’s defaults, the saved parameters, nothing selected, on the sheet already open', () => {
    const seed = seedFromView(null, sheets, parameters);
    expect(seed.sheet).toBe(-1);
    expect([...seed.controls]).toEqual([
      [REGION, { value: 'East' }],
      [DATES, { preset: 'ytd' }],
    ]);
    expect(seed.params.size + seed.selection.length + seed.narrowed.size + seed.groupTabs.size).toBe(0);
    expect(seed.asOf).toBeNull();
  });

  it('a pick on a card that is gone is skipped, and a gone page opens the first', () => {
    const seed = seedFromView(view(V1, 'Old', { page: 'nope', controls: {}, params: {}, selection: [], tiles: { '99999999-9999-4999-8999-999999999999': [step('x', '1')] }, groupTabs: {}, asOf: null }), sheets, parameters);
    expect(seed.sheet).toBe(0);
    expect(seed.narrowed.size).toBe(0);
  });

  it('lists As authored first, then each view, the default marked', () => {
    expect(viewOptions([view(V1, 'West', {}), view(V2, 'East', {})], V2)).toEqual([
      { value: AUTHORED, label: 'As authored' },
      { value: V1, label: 'West' },
      { value: V2, label: 'East (default)' },
    ]);
  });
});
