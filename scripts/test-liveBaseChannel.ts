// `live:setBaseFilters` and the Schema reply's always-applied filters (semantic layer part 1, PR 08, D13).
//
// 1. The contract: `write`, project-scoped, a strict input of plain filter steps (no term, lock,
//    context or radius key; at most 20 steps, 1,000 values). A project viewer may not set them; an
//    editor may.
// 2. The write: saved in one record write with an epoch bump, the next chart asks the warehouse with
//    them, a schema sync is queued and samples under them, and `dataset:liveSchema` returns them.
//    Refused in a sentence, with nothing written: on an extract, a step the stored form would drop, a
//    step that would be skipped (an unknown column, an empty list) and one the column cannot take; past
//    the contract (a model import), a step the stored form would change (a via, lock, context, datasetId).
// 3. REDACT: a caller row access rules restrict gets each step's column and operator, never a value.
//
//   npm run build:ts && node scripts/test-liveBaseChannel.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';
import type { FilterStep } from '../src/data/transforms';

const api: typeof import('../src/api/index') = require('../src/api/index');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const base: typeof import('../src/data/liveBaseFilters') = require('../src/data/liveBaseFilters');
const liveMsg: typeof import('../src/data/liveMessages') = require('../src/data/liveMessages');
const refusals: typeof import('../src/engine/liveRefusals') = require('../src/engine/liveRefusals');
const handler: typeof import('../src/ipc/liveBaseFilters') = require('../src/ipc/liveBaseFilters');

type Identity = import('../src/server/context').Identity;
const { fake, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);
const F = (column: string, op: FilterStep['op'], value?: unknown, extra: Partial<FilterStep> = {}): FilterStep =>
  ({ type: 'filter', column, op, ...(value === undefined ? {} : { value }), ...extra } as FilterStep);
const CANARY = 'zz-base-7c41';
const ID = '3b1f0a52-6f0e-4c52-9a43-0d6f1f0b7e11';
const BASE = [F('region', 'not in', undefined, { values: ['North', CANARY] })];
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'editor' }, org: { id: 'acme' } };

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  const set = (filters: unknown[], d = L) => post('live:setBaseFilters', { projectId: P, datasetId: d, filters });
  const meta = () => H.as(ORG_A, () => H.datasets.getDatasetMeta(P, L)) as Promise<Reply>;
  const schema = async (): Promise<Reply> => (await post('dataset:liveSchema', { projectId: P, datasetId: L })).value;

  // ── 1. The contract ───────────────────────────────────────────────────────
  const contract = api.contracts['live:setBaseFilters'];
  const input = { projectId: P, datasetId: L, filters: BASE };
  ok('contract: write, project-scoped by projectId', contract.access === 'write' && 'project' in contract && contract.project(input) === P);
  for (const [label, filters] of [
    ['a term step', [{ type: 'term', term: ID }]],
    ['a lock mark', [{ ...BASE[0], lock: true }]],
    ['a context mark', [{ ...BASE[0], context: true }]],
    ['a radius', [{ ...F('region', 'within_km'), radius: { lat: 1, lon: 2, km: 3 } }]],
    ['21 steps', Array(21).fill(BASE[0])],
    ['a list of 1,001 values', [F('region', 'in', undefined, { values: Array.from({ length: 1001 }, (_, i) => `v${i}`) })]],
  ] as [string, unknown[]][]) {
    const r = await set(filters);
    ok(`contract: ${label} is a 400 at the door`, r.status === 400, `${r.status} ${r.body.slice(0, 120)}`);
  }
  ok('NEGATIVE CONTROL: 20 steps and a list of 1,000 values pass the contract',
    contract.input.safeParse({ ...input, filters: Array(20).fill(F('region', 'in', undefined, { values: Array.from({ length: 1000 }, (_, i) => `v${i}`) })) }).success);
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const decide = (who: Identity, rank: number) => H.as(who, () => authz.authorize(contract, input, who, grants(rank)));
  ok('access: a project viewer may not set them', !(await decide(VIEWER, 1)).ok);
  ok('access: a project editor may', (await decide(EDITOR, 2)).ok);

  // ── 2. The write ──────────────────────────────────────────────────────────
  const e0 = (await meta()).live.epoch;
  ok('dataset:liveSchema before any: an empty list', show((await schema()).baseFilters) === show([]));
  const refusedWith = async (label: string, filters: unknown[], d: string, code: string, error: string): Promise<void> => {
    const r = (await set(filters, d)).value;
    ok(`refused: ${label}, in a sentence, nothing written`, r.ok === false && r.code === code && r.error === error && (await meta()).live.epoch === e0 && (await meta()).live.baseFilters === undefined, show(r));
  };
  await refusedWith('on an extract (not_live)', BASE, s.extractId, 'not_live', liveMsg.liveBaseFiltersNotLiveMessage());
  await refusedWith('a distance step (the stored form drops it)', [F('amt', 'within_km')], L, 'live_refused', liveMsg.liveBaseFilterInvalidMessage());
  await refusedWith('an unknown operator', [F('region', 'bogus' as FilterStep['op'], 1)], L, 'live_refused', liveMsg.liveBaseFilterInvalidMessage());
  await refusedWith('an empty in-list (it would be skipped)', [F('region', 'in', undefined, { values: [] })], L, 'live_refused', liveMsg.liveBaseFilterInvalidMessage());
  await refusedWith('a column the dataset lacks', [BASE[0], F('gone', '=', 1)], L, 'live_refused', liveMsg.liveBaseFilterInvalidMessage());
  await refusedWith('a period on a text column (its own sentence)', [F('region', 'period', undefined, { period: { preset: 'last_n_months', n: 6 } })], L, 'live_refused', refusals.livePeriodNotDate('region'));
  // A model file's step reaches the handler with no contract: a key the stored form would strip is refused, never
  // saved without it (a `via` would become a filter on this table's own column).
  for (const [label, extra] of [['a via', { via: ID }], ['a lock mark', { lock: true }], ['a context mark', { context: true }], ['a datasetId', { datasetId: ID }]] as [string, Reply][]) {
    const r = await H.as(ORG_A, () => handler.setLiveBaseFilters({ projectId: P, datasetId: L, filters: [{ ...BASE[0], ...extra }] })) as Reply;
    ok(`refused past the contract (a model import): ${label} the stored form would strip, nothing written`,
      r.ok === false && r.code === 'live_refused' && r.error === liveMsg.liveBaseFilterInvalidMessage() && (await meta()).live.epoch === e0 && (await meta()).live.baseFilters === undefined, show(r));
  }
  const cols = (await meta()).columns;
  ok('NEGATIVE CONTROL: the plain step passes the check, its keys in any order', 'steps' in handler.baseFiltersRefusal({ columns: cols }, [{ values: BASE[0].values, op: 'not in', column: 'region', type: 'filter' }]));
  ok('NEGATIVE CONTROL: a period the sanitizer only normalizes (a stray n on this_month) passes',
    'steps' in handler.baseFiltersRefusal({ columns: cols }, [F('d', 'period', undefined, { period: { preset: 'this_month', n: 6 } })]));

  H.queryCache.clear();
  // Called in a request context of its own: an injected request's signal fires when its reply closes,
  // which would cancel the sync it queued (a real HTTP reply that finished does not).
  const saved = await H.as(ORG_A, () => handler.setLiveBaseFilters({ projectId: P, datasetId: L, filters: BASE })) as Reply;
  ok('saves: the steps and the bumped epoch come back', saved.ok === true && show(saved.baseFilters) === show(BASE) && saved.epoch === e0 + 1, show(saved));
  ok('…stored as read: sanitizing the stored list changes nothing', show(base.sanitizeBaseFilters((await meta()).live.baseFilters)) === show(BASE));
  const from = fake.calls.length;
  const chart = (await post('visual:data', { projectId: P, datasetId: L, encoding: { category: 'region', values: [{ column: 'amt', aggregation: 'sum' }] } })).value;
  const asked = fake.calls.slice(from);
  ok('…the next chart asks the warehouse, with the filter bound', chart.ok === true && asked.length > 0 && asked.every((c) => c.params.some((p) => p.value === CANARY)) && !chart.data.labels.includes('North'), show(chart).slice(0, 200));
  let view: Reply = {};
  for (let i = 0; i < 200; i += 1) {
    view = await schema();
    if (view.sampledAt && !view.syncing) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const region = view.columns?.find((c: Reply) => c.name === 'region');
  ok('…a sync was queued, and it sampled under the filters: North is not a value the picker offers', !!view.sampledAt && region?.values.length > 0 && !region.values.includes('North'), show(region));
  ok('dataset:liveSchema returns the steps', show(view.baseFilters) === show(BASE));

  // ── 3. REDACT ─────────────────────────────────────────────────────────────
  ok('REDACT: a restricted caller gets column and operator, no value', show(base.redactBaseFilters(BASE, true)) === show([{ type: 'filter', column: 'region', op: 'not in' }]));
  ok('NEGATIVE CONTROL: an unrestricted caller gets the steps as stored', show(base.redactBaseFilters(BASE, false)) === show(BASE));

  const cleared = (await set([])).value;
  ok('[] clears them: the key goes, the epoch moves again', cleared.ok === true && cleared.epoch === e0 + 2 && (await meta()).live.baseFilters === undefined && show((await schema()).baseFilters) === show([]), show(cleared));

  await close();
  finish();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  finish();
});
