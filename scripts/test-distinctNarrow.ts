// `dataset:distinct` narrowed by PARENT filter steps — the server half of the cascading filter picker
// (semantic layer, p6-05a) — over the real RPC route, on the parity fixture's extract and Live dataset.
//
//   § extract  the resident list and the JS reference agree under Object.is (values and total); the
//              narrowed list drops what the parents rule out; the table is never hydrated
//   § steps    a related dataset's step (`datasetId`, `via`) is not a parent and narrows nothing;
//              six steps are taken and seven refused; a term is refused by the contract
//   § live     a Live reply to a request that carried parents says `narrowed: false` — and only then
//   § narrow   `narrowSteps` alone: sanitized, at most six, twice == once, a bad step narrows less
//
// The row-lock case (a restricted caller's picks never widen their lock) is in test-rowPolicySafetyNet.
//
//   npm run build:ts && node scripts/test-distinctNarrow.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Cell, FilterStep } from '../src/data/transforms';
import { H, close, hydrates, post } from './liveRouteHarness';

const sync: typeof import('../src/engine/live/schemaSync') = require('../src/engine/live/schemaSync');
const { distinctValuesPageJs }: typeof import('../src/engine/datasetPage') = require('../src/engine/datasetPage');

const { fx, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  const col = (name: string): number => fx.COLUMNS.findIndex((c) => c.name === name);

  // The fixture's `cat` and `region` are independent picks, so no `cat` occurs only outside a region.
  // Add ONE row to the extract that does: `cat` 'Only outside', in a region other than R.
  const base = fx.fixtureRows();
  const regions = [...new Set(base.map((r) => r[col('region')]).filter((v): v is string => typeof v === 'string' && v !== ''))];
  const R = regions[0];
  const elsewhere = regions[1];
  const extra = fx.COLUMNS.map((c): Cell => ({ many: 'm99', cat: 'Only outside', region: elsewhere, amt: 1, qty: 1, tier: 1, d: '2024-01-01', bigid: null } as Record<string, Cell>)[c.name]);
  const X = (await H.as(ORG_A, () => H.datasets.saveDataset(P, { name: 'Narrowed', sourceKind: 'csv', ...fx.importTyped(fx.COLUMNS, [...base, extra]) })))!.id;
  const ds = (await H.as(ORG_A, () => H.datasets.getDataset(P, X)))!;
  // C: a `cat` value that occurs only outside R, read off X's rows
  const catsIn = new Set<string>();
  const catsOut = new Set<string>();
  for (const r of ds.rows) {
    const c = r[col('cat')];
    if (typeof c !== 'string' || c === '') continue;
    (r[col('region')] === R ? catsIn : catsOut).add(c);
  }
  const C = [...catsOut].find((c) => !catsIn.has(c));
  ok('setup: R is a region of X, and a cat value C occurs only outside R', typeof R === 'string' && typeof C === 'string', show({ R, C }));

  const inR: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: R }];
  const distinct = (datasetId: string, more: object = {}, column = 'cat') => post('dataset:distinct', { projectId: P, datasetId, column, ...more });

  // ── § extract ───────────────────────────────────────────────────────────────
  const whole = (await distinct(X)).value;
  const { value: narrowed, hydrated: touched } = await hydrates(X, async () => (await distinct(X, { filters: inR })).value);
  const js = distinctValuesPageJs(ds.columns, ds.rows, 'cat', { limit: 200, filters: inR });
  ok('narrowed: resident and JS agree', show(narrowed.values) === show(js.values) && Object.is(narrowed.total, js.total), show({ narrowed, js }));
  ok('narrowed: C is not in R', Array.isArray(narrowed.values) && !narrowed.values.includes(C) && narrowed.values.length > 0 && narrowed.values.length < whole.values.length);
  ok('NEGATIVE CONTROL: unnarrowed, it is', whole.values.includes(C));
  ok('narrowed: the table was never hydrated (the resident path)', touched === false);
  ok('narrowed: an extract reply never says `narrowed`', !('narrowed' in narrowed) && !('narrowed' in whole));
  const twins: [string, { filters: FilterStep[]; search?: string; limit?: number }][] = [
    ['two steps', { filters: [...inR, { type: 'filter', column: 'qty', op: '>=', value: 5 }] }],
    ['a list step', { filters: [{ type: 'filter', column: 'region', op: 'in', values: [R, elsewhere] }] }],
    ['with a search and a limit', { filters: inR, search: 'a', limit: 3 }],
  ];
  for (const [label, more] of twins) {
    const got = (await distinct(X, more)).value;
    const want = distinctValuesPageJs(ds.columns, ds.rows, 'cat', more);
    ok(`narrowed (${label}): resident and JS agree`, show(got.values) === show(want.values) && Object.is(got.total, want.total), show({ got, want }));
  }
  ok('an empty `filters` is the unnarrowed list', show((await distinct(X, { filters: [] })).value) === show(whole));

  // ── § steps ─────────────────────────────────────────────────────────────────
  const OTHER = s.connId; // a UUID of another record
  ok('a related step (datasetId) is not a parent', (await distinct(X, { filters: [{ ...inR[0], datasetId: OTHER }] })).value.values.includes(C));
  ok('a related step (via) is not a parent', (await distinct(X, { filters: [{ ...inR[0], via: OTHER }] })).value.values.includes(C));
  ok('NEGATIVE CONTROL: the same step without them narrows', !(await distinct(X, { filters: [{ ...inR[0] }] })).value.values.includes(C));
  ok('a step that does not sanitize narrows nothing (less, never more)', show((await distinct(X, { filters: [{ type: 'filter', column: 'region', op: 'nope', value: R }] })).value) === show(whole));
  const six = Array(6).fill(inR[0]);
  const sixReply = await distinct(X, { filters: six });
  ok('six steps are taken', sixReply.status === 200 && !sixReply.value.values.includes(C), `${sixReply.status} ${sixReply.body.slice(0, 160)}`);
  ok('NEGATIVE CONTROL: seven steps are refused by the contract', (await distinct(X, { filters: Array(7).fill(inR[0]) })).status === 400);
  ok('a term is refused by the contract', (await distinct(X, { filters: [{ type: 'term', term: 'revenue' }] })).status === 400);
  ok('a step without a column is refused by the contract', (await distinct(X, { filters: [{ type: 'filter', op: '=' }] })).status === 400);
  ok('an op past 16 characters is refused by the contract', (await distinct(X, { filters: [{ type: 'filter', column: 'region', op: 'x'.repeat(17) }] })).status === 400);
  ok('NEGATIVE CONTROL: the contract still refuses a key it does not know', (await post('dataset:distinct', { projectId: P, datasetId: X, column: 'cat', parents: inR })).status === 400);

  // ── § live ──────────────────────────────────────────────────────────────────
  const synced = await H.as(ORG_A, () => sync.syncLiveSchema(P, L));
  ok('setup: the Live dataset is profiled', synced.ok && synced.sample.ok, show(synced).slice(0, 160));
  const liveWhole = (await distinct(L)).value;
  const liveNarrowed = (await distinct(L, { filters: inR })).value;
  ok('Live: the sample list, said to be not narrowed', liveNarrowed.narrowed === false && Array.isArray(liveNarrowed.values) && show({ ...liveNarrowed, narrowed: undefined }) === show(liveWhole), show(liveNarrowed));
  ok('Live: without `filters` the reply has no `narrowed` key', !('narrowed' in liveWhole) && liveWhole.approximate === true);
  ok('Live: an empty `filters` has no `narrowed` key either', !('narrowed' in (await distinct(L, { filters: [] })).value));
  ok('Live: steps that were all dropped (a related dataset) narrowed nothing, and say nothing', !('narrowed' in (await distinct(L, { filters: [{ ...inR[0], datasetId: OTHER }] })).value));
  const unprofiled = await H.as(ORG_A, () => H.liveOver(P, { table: 'live_typed' }, fx.COLUMNS));
  const refusal = (await distinct(unprofiled.liveId, { filters: inR })).value;
  ok('Live: a refusal stays the refusal, unmarked', refusal.ok === false && refusal.code === 'live_refused' && !('narrowed' in refusal), show(refusal));

  // ── § narrow ────────────────────────────────────────────────────────────────
  const { narrowSteps }: typeof import('../src/ipc/distinctNarrow') = require('../src/ipc/distinctNarrow');
  const messy = [
    { type: 'filter', column: 'region', op: '=', value: R, evil: 'x', values: [1, { a: 1 }, 'b'] },
    { type: 'filter', column: 'qty', op: 'in', values: [1, 2, { nested: true }, null] },
    { type: 'term', term: 'revenue' },
    { type: 'filter', column: 'region', op: '=', value: R, datasetId: OTHER },
    { type: 'filter', column: 'region', op: '=', value: R, via: OTHER },
    { type: 'filter', column: 'region', op: 'nope' },
    { type: 'filter', op: '=' },
    null,
    'text',
  ];
  const once = narrowSteps(messy);
  ok('narrowSteps: the two plain filters, sanitized (unknown keys and nested values gone)', show(once) === show([
    { type: 'filter', column: 'region', op: '=', value: R, values: [1, 'b'] },
    { type: 'filter', column: 'qty', op: 'in', values: [1, 2, null] },
  ]), show(once));
  ok('narrowSteps: twice == once', show(narrowSteps(once)) === show(once));
  ok('narrowSteps: a term, a related step and a step that does not sanitize are dropped', once.length === 2);
  ok('NEGATIVE CONTROL: without `via` the same step is kept', narrowSteps([{ type: 'filter', column: 'region', op: '=', value: R }]).length === 1
    && narrowSteps([{ type: 'filter', column: 'region', op: '=', value: R, via: OTHER }]).length === 0);
  ok('narrowSteps: at most six', narrowSteps(Array(9).fill(messy[0])).length === 6);
  ok('narrowSteps: not a list is no steps', [undefined, null, 'x', 5, {}].every((v) => narrowSteps(v).length === 0));

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
