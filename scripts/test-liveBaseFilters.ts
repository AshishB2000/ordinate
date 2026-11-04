// A Live dataset's always-applied "base filters" (semantic layer part 1, PR 08a).
//
// 08a is the rolling-deploy guard: a pod of this release reads the stored key and, because it cannot
// apply the filters yet, REFUSES every question that would answer without them — typed, never an
// unfiltered figure. A later release applies them; pods of this one are what the rollout starts from.
//
// 1. sanitizeBaseFilters keeps plain `filter` steps only (no term, no lock, no context, no
//    within_km, no stray key) and caps them at MAX_BASE_FILTERS.
// 2. The key lives at the TOP LEVEL of the dataset record, beside `rowPolicy`: `meta.live.baseFilters`
//    is read from it, and no Live writer (each rebuilds `raw.live`) erases it or copies it into `live`.
// 3. The guard: every door a question can come through (a chart, a KPI, an answer card, a schema
//    sync), "Make a copy" and "Copy the data instead" refuse typed (`baseFilter`) and spend no
//    warehouse call, and a copy saves nothing. NEGATIVE CONTROL: the same doors answer on a Live
//    dataset with no base filters, and on this one once the key is gone.
//
//   npm run build:ts && node scripts/test-liveBaseFilters.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';
import type { FilterStep } from '../src/data/transforms';

const fs: typeof import('fs') = require('fs');
const base: typeof import('../src/data/liveBaseFilters') = require('../src/data/liveBaseFilters');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const refusals: typeof import('../src/engine/liveRefusals') = require('../src/engine/liveRefusals');

const { fake, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);
const F = (column: string, op: FilterStep['op'], value?: unknown, extra: Partial<FilterStep> = {}): FilterStep =>
  ({ type: 'filter', column, op, ...(value === undefined ? {} : { value }), ...extra } as FilterStep);
const CANARY = 'zz-base-7c41';
const ID = '3b1f0a52-6f0e-4c52-9a43-0d6f1f0b7e11';
const BASE = [F('region', 'not in', undefined, { values: ['North', CANARY] })];
const ENC = { category: 'region', values: [{ column: 'amt', aggregation: 'sum' }] };

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  duck.forbidSyncOnMainThread();

  // ── 1. The sanitizer ──────────────────────────────────────────────────────
  ok('sanitize keeps plain filter steps only', show(base.sanitizeBaseFilters([
    { ...F('region', '!=', 'x'), context: true, lock: true, via: ID },
    { type: 'term', term: ID },
    F('lat', 'within_km'),
    { ...F('lat', 'within_km'), radius: { lat: 1, lon: 2, km: 3 } },
    F('region', 'bogus' as FilterStep['op'], 1),
    7,
    null,
  ])) === show([{ type: 'filter', column: 'region', op: '!=', value: 'x' }]));
  ok('sanitize keeps a list and a period', show(base.sanitizeBaseFilters([
    F('region', 'in', undefined, { values: ['a', 1, null, { x: 1 } as never] }),
    F('d', 'period', undefined, { period: { preset: 'last_n_months', n: 6 } }),
  ])) === show([
    { type: 'filter', column: 'region', op: 'in', values: ['a', 1, null] },
    { type: 'filter', column: 'd', op: 'period', period: { preset: 'last_n_months', n: 6 } },
  ]));
  ok('sanitize caps at 20', base.MAX_BASE_FILTERS === 20 && base.sanitizeBaseFilters(Array(25).fill(F('region', '!=', 'x'))).length === 20);
  ok('sanitize of a non-list is empty', base.sanitizeBaseFilters(undefined).length === 0 && base.sanitizeBaseFilters({ 0: F('a', '=', 1) }).length === 0);

  // ── 2. Where it is stored ─────────────────────────────────────────────────
  const meta = () => H.as(ORG_A, () => H.datasets.getDatasetMeta(P, L)) as Promise<Reply>;
  const raw = (): Promise<Reply> => H.as(ORG_A, async () => JSON.parse(await fs.promises.readFile(rec.datasetFilePath(P, L), 'utf8')));
  const plant = (value: unknown) => H.as(ORG_A, () => rec.serialized(rec.datasetFilePath(P, L), (r) => {
    if (value === undefined) delete r.baseFilters;
    else r.baseFilters = value;
  }));

  ok('a Live dataset with no key has no base filters in memory', (await meta()).live.baseFilters === undefined);
  await plant([]);
  ok('an empty list reads as none', (await meta()).live.baseFilters === undefined);
  await plant('everything');
  ok('a stored key that is not a list reads as none', (await meta()).live.baseFilters === undefined);
  await plant(BASE);
  ok('meta.live.baseFilters is read from the top-level key', show((await meta()).live.baseFilters) === show(BASE), show((await meta()).live));

  const stamp = new Date().toISOString();
  const WRITERS: [string, () => Promise<unknown>][] = [
    ['bumpEpoch', () => H.liveDataset.bumpEpoch(P, L)],
    ['setMaxCacheAge', () => H.liveDataset.setMaxCacheAge(P, L, 60)],
    ['stampSyncAttempt', () => H.liveDataset.stampSyncAttempt(P, L, stamp)],
    ['writeSchemaSync', async () => H.liveDataset.writeSchemaSync(P, L, {
      columns: (await meta()).columns, profile: { columns: [] }, missingColumns: [], syncedAt: stamp, changed: false,
    })],
  ];
  for (const [name, write] of WRITERS) {
    const done = await H.as(ORG_A, write);
    const r = await raw();
    ok(`${name} keeps raw.baseFilters and never writes it into raw.live`, !!done && show(r.baseFilters) === show(BASE) && !('baseFilters' in r.live), show(r));
  }
  ok('…and the writers\' changes landed', (await meta()).live.maxCacheAgeSec === 60 && (await raw()).live.syncAttemptAt === stamp);

  // ── 3. The guard (08a). A later task replaces this section with the real answers. ──
  const second = await H.as(ORG_A, () => H.liveOver(P, { table: 'live_typed' }, H.fx.COLUMNS));
  const chartOn = async (d: string): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId: d, encoding: ENC })).value;
  const SPEC = (d: string) => ({ datasetId: d, category: 'region', measures: [{ column: 'amt', aggregation: 'sum' }], filters: [], chartType: 'bar', title: 'Sales by region' });
  const DOORS: [string, (d: string) => Promise<Reply>][] = [
    ['visual:data', chartOn],
    ['dashboard:metric', async (d) => (await post('dashboard:metric', { projectId: P, datasetId: d, column: 'amt', aggregation: 'sum' })).value],
    ['answer:card', async (d) => (await post('answer:card', { projectId: P, spec: SPEC(d) })).value],
    ['dataset:syncLiveSchema', async (d) => (await post('dataset:syncLiveSchema', { projectId: P, datasetId: d })).value],
  ];
  H.queryCache.clear();
  const sentence = refusals.liveBaseFilterRefused('region');
  ok('the sentence says why and what to do', /always-applied filters can't be applied by this server/.test(sentence) && /finish upgrading Ordinate/.test(sentence), sentence);
  const replies: unknown[] = [];
  for (const [label, call] of DOORS) {
    const before = fake.calls.length;
    const r = await call(L);
    replies.push(r);
    // A card's failure (ipc/liveAnswers `Failure`) carries the catalog sentence in `reason`; every other reply has the code there.
    const typed = r.ok === false && r.code === 'live_refused' && (label === 'answer:card' ? r.reason === sentence : r.reason === 'baseFilter' && r.error === sentence);
    ok(`08a guard: ${label} refuses typed (baseFilter), no warehouse call`, typed && fake.calls.length === before, show(r));
  }

  const count = async (): Promise<number> => (await H.as(ORG_A, () => H.datasets.listDatasets(P))).length;
  const n0 = await count();
  const calls0 = fake.calls.length;
  const copy = (await post('dataset:copyLive', { projectId: P, datasetId: L })).value;
  replies.push(copy);
  ok('08a guard: Make a copy refuses typed and saves nothing',
    copy.ok === false && copy.code === 'live_refused' && copy.reason === 'baseFilter' && copy.error === sentence && (await count()) === n0, show(copy));
  const toExtract = (await post('dataset:setMode', { projectId: P, datasetId: L, mode: 'extract' })).value;
  replies.push(toExtract);
  const after = await meta();
  ok('08a guard: Copy the data instead refuses typed; the record stays Live',
    toExtract.ok === false && toExtract.code === 'live_refused' && toExtract.reason === 'baseFilter' && after.mode === 'live' && show(after.live.baseFilters) === show(BASE), show(toExtract));
  ok('…and no refusal carries a filter value', !show(replies).includes(CANARY) && !show(replies).includes('North'), show(replies).slice(0, 300));
  ok('…and neither spent a warehouse call', fake.calls.length === calls0, show(fake.calls.length - calls0));

  // NEGATIVE CONTROLS: the guard is the base filters, nothing else.
  for (const [label, call] of DOORS) {
    const r = await call(second.liveId);
    ok(`NEGATIVE CONTROL: ${label} answers on a Live dataset without base filters`, r.ok === true, show(r).slice(0, 240));
  }
  const copyOther = (await post('dataset:copyLive', { projectId: P, datasetId: second.liveId })).value;
  ok('NEGATIVE CONTROL: Make a copy answers on a Live dataset without base filters', copyOther.ok === true && (await count()) === n0 + 1, show(copyOther));
  await plant(undefined);
  H.queryCache.clear();
  for (const [label, call] of DOORS) {
    const r = await call(L);
    ok(`NEGATIVE CONTROL: with the key removed, ${label} answers on the same dataset`, r.ok === true, show(r).slice(0, 240));
  }

  await close();
  finish();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  finish();
});
