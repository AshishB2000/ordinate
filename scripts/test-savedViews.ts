// Saved views — the pure half (src/analysis/savedViews.ts): what a stored view
// may hold, the edits to a view list, which view a dashboard opens on, the
// filters a view stands for, and the ordinate:// deep link.
//
// Expected values are written out by hand. The renderer's gather/apply is the
// smoke's (scripts/r10Views.ts); what this pins is that a captured state
// survives the whitelist unchanged, and that everything else does not.
//
//   npm run build:ts && node scripts/test-savedViews.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import {
  sanitizeViewState, sanitizeViews, sanitizeDefaultViewId, openingView, applyViewOp,
  viewScope, viewPageIndex, parseDeepLink, viewLink, MAX_VIEWS,
} from '../src/analysis/savedViews';
import type { ViewScope } from '../src/analysis/savedViews';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const DASH = '11111111-1111-4111-8111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222221';
const P2 = '22222222-2222-4222-8222-222222222222';
const REGION = '33333333-3333-4333-8333-333333333331';
const SEGS = '33333333-3333-4333-8333-333333333332';
const DATES = '33333333-3333-4333-8333-333333333333';
const PCTRL = '33333333-3333-4333-8333-333333333334';
const CHART = '33333333-3333-4333-8333-333333333335';
const TABS = '33333333-3333-4333-8333-333333333336';
const TAB_A = '44444444-4444-4444-8444-444444444441';
const TAB_B = '44444444-4444-4444-8444-444444444442';
const DS = '55555555-5555-4555-8555-555555555555';
const PARAM = '66666666-6666-4666-8666-666666666666';
const V1 = '77777777-7777-4777-8777-777777777771';
const V2 = '77777777-7777-4777-8777-777777777772';
const V3 = '77777777-7777-4777-8777-777777777773';

const layout = { x: 0, y: 0, w: 3, h: 1 };
const scope: any = {
  sheets: [
    {
      id: P1, name: 'Overview', cards: [
        { id: REGION, type: 'control', layout, control: { kind: 'dropdown', label: 'Region', datasetId: DS, column: 'region', default: { value: 'East' } } },
        { id: SEGS, type: 'control', layout, control: { kind: 'multi', label: 'Segment', datasetId: DS, column: 'segment' } },
        { id: DATES, type: 'control', layout, control: { kind: 'date_range', label: 'Order date', datasetId: DS, column: 'order_date' } },
        { id: PCTRL, type: 'control', layout, control: { kind: 'parameter', label: 'Target', datasetId: '', column: '', paramId: PARAM } },
        { id: CHART, type: 'visual', layout, visualId: DS },
      ],
    },
    { id: P2, name: 'Detail', cards: [{ id: TABS, type: 'tabs', layout, tabs: { items: [{ id: TAB_A, name: 'A' }, { id: TAB_B, name: 'B' }] } }] },
  ],
  parameters: [{ id: PARAM, name: 'target', kind: 'number', value: 100, min: 0, max: 500 }],
  filters: [{ type: 'filter', column: 'status', op: '=', value: 'Shipped' }],
};

// ── Capture → store → restore is the identity ────────────────────────────────
const captured = {
  page: P2,
  controls: { [REGION]: { value: 'West' }, [SEGS]: null, [DATES]: { preset: 'last_n_days', n: 30 } },
  params: { [PARAM]: 250 },
  selection: [{ type: 'filter', column: 'category', op: '=', value: 'Technology' }],
  tiles: { [CHART]: [{ type: 'filter', column: 'quarter', op: '=', value: 'Q4' }] },
  groupTabs: { [TABS]: TAB_B },
  asOf: '2026-09-30T12:00:00.000Z',
};
const stored = sanitizeViewState(captured, scope);
ok('round trip: a captured state comes back from the whitelist unchanged', same(stored, captured), JSON.stringify(stored));
ok('round trip: storing it again changes nothing', same(sanitizeViewState(JSON.parse(JSON.stringify(stored)), scope), captured));
ok('round trip: the view opens on its page (index 1, "Detail")', viewPageIndex({ state: stored } as any, scope.sheets) === 1);

// ── …and everything that is not a view is dropped ───────────────────────────
const hostile = sanitizeViewState({
  page: '../etc',
  controls: {
    [REGION]: { values: ['West'] },          // the multi shape on a dropdown
    [SEGS]: { values: ['Consumer', 7] },     // a number in a list of strings
    [PCTRL]: { value: 'x' },                 // a parameter control is not a control pick
    '99999999-9999-4999-8999-999999999999': { value: 'Ghost' }, // no such card
  },
  params: { [PARAM]: 9000, nope: 1 },
  selection: [{ type: 'rename', from: 'a', to: 'b' }, { type: 'filter', column: 'x', op: '=', value: '1' }],
  tiles: { '99999999-9999-4999-8999-999999999999': [{ type: 'filter', column: 'x', op: '=', value: '1' }] },
  groupTabs: { [TABS]: 'not-a-tab', [CHART]: TAB_A },
  asOf: 'yesterday-ish',
  secret: 'sk-live',
}, scope);
ok('refuse: unknown keys are dropped', !('secret' in hostile));
ok('refuse: a page that is not on the dashboard → the first page', hostile.page === '');
ok('refuse: a control value of the wrong shape and a parameter control are dropped; a list keeps only strings',
  same(hostile.controls, { [SEGS]: { values: ['Consumer'] }, '99999999-9999-4999-8999-999999999999': { value: 'Ghost' } }), JSON.stringify(hostile.controls));
ok('refuse: a parameter value is clamped to its max (500); an unknown parameter is dropped', same(hostile.params, { [PARAM]: 500 }), JSON.stringify(hostile.params));
ok('refuse: only filter steps make a selection', same(hostile.selection, [{ type: 'filter', column: 'x', op: '=', value: '1' }]), JSON.stringify(hostile.selection));
ok('keep: narrowing on a card not on the board is kept (inert) so an Undo brings it back',
  same(hostile.tiles, { '99999999-9999-4999-8999-999999999999': [{ type: 'filter', column: 'x', op: '=', value: '1' }] }));
// A control deleted, saved, then restored with the SAME id gets its pick back.
const noRegion: ViewScope = { ...scope, sheets: scope.sheets.map((p: any) => ({ ...p, cards: p.cards.filter((c: any) => c.id !== REGION) })) };
const afterDelete = sanitizeViewState({ controls: { [REGION]: { value: 'West' } } }, noRegion);
ok('undo: a pick survives a save while its card is deleted', same(afterDelete.controls, { [REGION]: { value: 'West' } }), JSON.stringify(afterDelete.controls));
ok('undo: …and is a real pick again once the card is back', same(sanitizeViewState(afterDelete, scope).controls, { [REGION]: { value: 'West' } }));
ok('undo: an orphan that fits no control shape is dropped',
  same(sanitizeViewState({ controls: { [REGION]: { nonsense: 1 } } }, noRegion).controls, {}));
ok('undo: a non-UUID orphan id is dropped', same(sanitizeViewState({ controls: { ghost: { value: 'x' } } }, noRegion).controls, {}));
ok('refuse: a tab that the tabs card does not have, or on a card that is not tabs, is dropped', same(hostile.groupTabs, {}));
ok('refuse: an "as of" that is not a time → Latest', hostile.asOf === null);
ok('refuse: garbage in → an empty view, not a throw',
  same(sanitizeViewState('nonsense', scope), { page: '', controls: {}, params: {}, selection: [], tiles: {}, groupTabs: {}, asOf: null }));

// ── The list: ids, names, count ──────────────────────────────────────────────
const list = sanitizeViews([
  { id: V1, name: '  West Q4  ', state: captured, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', extra: 1 },
  { id: V1, name: 'Duplicate id', state: {} },
  { id: 'not-a-uuid', name: 'Bad id', state: {} },
  { id: V2, name: '   ', state: {} },
  { id: V3, name: 'x'.repeat(200), state: {} },
], scope);
ok('list: bad ids, a repeated id and a blank name are dropped', list.length === 2 && list[0].id === V1 && list[1].id === V3);
ok('list: names are trimmed', list[0].name === 'West Q4');
ok('list: names are capped at 80 characters', list[1].name.length === 80);
ok('list: unknown keys on a view are dropped', same(Object.keys(list[0]), ['id', 'name', 'state', 'createdAt', 'updatedAt']));
const many = Array.from({ length: 70 }, (_, i) => ({ id: `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`, name: 'v' + i, state: {} }));
ok('list: at most 50 views', sanitizeViews(many, scope).length === 50 && MAX_VIEWS === 50);
ok('list: a default naming no view is cleared', sanitizeDefaultViewId(V2, list) === '' && sanitizeDefaultViewId(V3, list) === V3);

// ── Default selection ────────────────────────────────────────────────────────
ok('open: the requested view wins', openingView(list, V3, V1)?.id === V1);
ok('open: no request → the default', openingView(list, V3)?.id === V3);
ok('open: a request for a view that is gone → the default', openingView(list, V3, V2)?.id === V3);
ok('open: no request and no default → as authored (null)', openingView(list, '') === null);

// ── Edits ────────────────────────────────────────────────────────────────────
const NOW = '2026-10-02T09:00:00.000Z';
let next = 0;
const ids = [V2, '88888888-8888-4888-8888-888888888888'];
const newId = (): string => ids[next++];
const rec0 = { views: list, defaultViewId: V3 };
const created: any = applyViewOp(rec0, { op: 'create', name: 'East H1', state: { page: P1 } }, scope, NOW, newId);
ok('edit: create appends a view with a fresh id and stamps', created.ok && created.viewId === V2 && created.views.length === 3
  && created.views[2].createdAt === NOW && created.views[2].state.page === P1, JSON.stringify(created));
ok('edit: a second view with the same name (any case) is refused',
  same(applyViewOp(created, { op: 'create', name: 'east h1', state: {} }, scope, NOW, newId), { ok: false, error: 'There is already a view called “east h1”.' }));
ok('edit: a blank name is refused', !applyViewOp(created, { op: 'create', name: '  ', state: {} }, scope, NOW, newId).ok);
const renamed: any = applyViewOp(created, { op: 'rename', viewId: V2, name: 'East — first half' }, scope, NOW, newId);
ok('edit: rename', renamed.ok && renamed.views[2].name === 'East — first half');
const updated: any = applyViewOp(renamed, { op: 'update', viewId: V1, state: { page: P1, asOf: null } }, scope, '2026-10-03T00:00:00.000Z', newId);
ok('edit: update replaces the state and bumps updatedAt, keeps createdAt', updated.ok && updated.views[0].state.page === P1
  && same(updated.views[0].state.controls, {}) && updated.views[0].updatedAt === '2026-10-03T00:00:00.000Z' && updated.views[0].createdAt === '2026-10-01T00:00:00.000Z');
const def: any = applyViewOp(updated, { op: 'default', viewId: V2 }, scope, NOW, newId);
ok('edit: set default', def.ok && def.defaultViewId === V2);
const deleted: any = applyViewOp(def, { op: 'delete', viewId: V2 }, scope, NOW, newId);
ok('edit: deleting the default view clears the default', deleted.ok && deleted.views.length === 2 && deleted.defaultViewId === '');
ok('edit: clear the default', (applyViewOp(def, { op: 'default', viewId: '' }, scope, NOW, newId) as any).defaultViewId === '');
ok('edit: a view that is gone is refused', same(applyViewOp(deleted, { op: 'rename', viewId: V2, name: 'x' }, scope, NOW, newId), { ok: false, error: 'That view no longer exists.' }));
ok('edit: an unknown action is refused', !applyViewOp(deleted, { op: 'explode', viewId: V1 } as any, scope, NOW, newId).ok);
const full = { views: sanitizeViews(many, scope), defaultViewId: '' };
ok('edit: a 51st view is refused', same(applyViewOp(full, { op: 'create', name: 'One more', state: {} }, scope, NOW, newId), { ok: false, error: 'A dashboard keeps at most 50 views.' }));

// ── What a view stands for (reports) ─────────────────────────────────────────
const sc = viewScope(list[0], scope);
ok('scope: dashboard filters, then each control\'s pick, then the selection', same(sc.filters, [
  { type: 'filter', column: 'status', op: '=', value: 'Shipped' },
  { type: 'filter', column: 'region', op: '=', value: 'West' },
  { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'last_n_days', n: 30 } },
  { type: 'filter', column: 'category', op: '=', value: 'Technology' },
]), JSON.stringify(sc.filters));
ok('scope: parameters at the view\'s values', same(sc.params, [{ name: 'target', kind: 'number', value: 250, min: 0, max: 500 }]));
const none = viewScope(null, scope);
ok('scope: no view → the author\'s defaults (Region = East)', same(none.filters, [
  { type: 'filter', column: 'status', op: '=', value: 'Shipped' },
  { type: 'filter', column: 'region', op: '=', value: 'East' },
]) && none.params[0].value === 100, JSON.stringify(none));

// ── Deep links ───────────────────────────────────────────────────────────────
ok('link: dashboard only', same(parseDeepLink(`ordinate://dashboard/${DASH}`), { dashboardId: DASH }));
ok('link: dashboard and view', same(parseDeepLink(`ordinate://dashboard/${DASH}?view=${V1}`), { dashboardId: DASH, viewId: V1 }));
ok('link: unknown parameters are ignored', same(parseDeepLink(`ordinate://dashboard/${DASH}?utm=mail&view=${V1}&x=1#top`), { dashboardId: DASH, viewId: V1 }));
ok('link: a trailing slash is fine', same(parseDeepLink(`ordinate://dashboard/${DASH}/`), { dashboardId: DASH }));
ok('link: ids are case-folded', same(parseDeepLink(`ORDINATE://dashboard/${DASH.toUpperCase()}?view=${V1.toUpperCase()}`), { dashboardId: DASH, viewId: V1 }));
ok('link: viewLink writes what parseDeepLink reads', same(parseDeepLink(viewLink(DASH, V1)), { dashboardId: DASH, viewId: V1 }));
const refused: Array<[string, unknown]> = [
  ['another scheme', `https://dashboard/${DASH}`],
  ['another host', `ordinate://visual/${DASH}`],
  ['no id', 'ordinate://dashboard/'],
  ['a second segment', `ordinate://dashboard/${DASH}/edit`],
  ['path traversal', `ordinate://dashboard/../${DASH}`],
  ['an encoded traversal', 'ordinate://dashboard/%2e%2e%2fsecrets'],
  ['a non-UUID id', 'ordinate://dashboard/retail-overview'],
  ['a non-UUID view', `ordinate://dashboard/${DASH}?view=west`],
  ['view given twice', `ordinate://dashboard/${DASH}?view=${V1}&view=${V2}`],
  ['a port', `ordinate://dashboard:8080/${DASH}`],
  ['credentials', `ordinate://me:pw@dashboard/${DASH}`],
  ['no slashes', `ordinate:dashboard/${DASH}`],
  ['not a URL', 'not a url'],
  ['not a string', { href: `ordinate://dashboard/${DASH}` }],
  ['too long', `ordinate://dashboard/${DASH}?pad=${'x'.repeat(600)}`],
];
for (const [why, url] of refused) ok(`link: refused — ${why}`, parseDeepLink(url) === null, JSON.stringify(parseDeepLink(url)));

finish();
