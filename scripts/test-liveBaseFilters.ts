// A Live dataset's always-applied "base filters" (semantic layer part 1, PR 08a and PR 08, D13).
//
// 1. sanitizeBaseFilters keeps plain `filter` steps only (no term, no lock, no context, no
//    within_km, no stray key), caps them at MAX_BASE_FILTERS and a list at MAX_BASE_FILTER_VALUES.
// 2. The key lives at the TOP LEVEL of the dataset record, beside `rowPolicy`: `meta.live.baseFilters`
//    is read from it, and no Live writer (each rebuilds `raw.live`) erases it or copies it into `live`.
//    `setBaseFilters` writes it with an epoch bump and drops the figures sampled under the old ones;
//    `liveBaseOf` adapts it, and a step that cannot be applied refuses, never skips.
// 3. A stored list this pod cannot read in full refuses every door, the case-fix lookup and both
//    copies, typed (`baseFilterUnreadable`), with no warehouse call. NEGATIVE CONTROL: 20 steps read.
// 4. The doors: every statement each Live entry point sends binds the base filter (the canary).
//    NEGATIVE CONTROL: the same doors on a Live dataset without base filters bind none. A period base
//    moves at midnight (the resolved range is in the key); a base change never serves the stale answer
//    from before it; an empty sample under a base is retried LIMIT-only; a sync sampled under other
//    filters stores no figures; a base column the warehouse dropped refuses every question, typed,
//    while the sync still syncs the columns. (scripts/test-liveBaseCompile.ts holds the pure builders.)
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
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const liveBase: typeof import('../src/engine/live/liveBase') = require('../src/engine/live/liveBase');
const liveProfile: typeof import('../src/data/liveProfile') = require('../src/data/liveProfile');
const compile: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const { isLive } = H.liveDataset;

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
  const list = (n: number) => F('region', 'in', undefined, { values: Array.from({ length: n }, (_, i) => `v${i}`) });
  ok('sanitize drops a step of more than 1,000 values (so the stored list reads as unreadable), and keeps one of 1,000',
    base.MAX_BASE_FILTER_VALUES === 1000 && base.sanitizeBaseFilters([list(1001)]).length === 0 && base.sanitizeBaseFilters([list(1000)]).length === 1);
  const messy = [{ ...F('region', '!=', 'x'), context: true }, F('d', 'period', undefined, { period: { preset: 'last_n_months', n: 6 } }), list(3), 7];
  ok('sanitize twice is sanitize once', show(base.sanitizeBaseFilters(base.sanitizeBaseFilters(messy))) === show(base.sanitizeBaseFilters(messy)));

  // ── 2. Where it is stored ─────────────────────────────────────────────────
  const metaOf = (d: string) => H.as(ORG_A, () => H.datasets.getDatasetMeta(P, d)) as Promise<Reply>;
  const meta = () => metaOf(L);
  const raw = (): Promise<Reply> => H.as(ORG_A, async () => JSON.parse(await fs.promises.readFile(rec.datasetFilePath(P, L), 'utf8')));
  const plant = (value: unknown) => H.as(ORG_A, () => rec.serialized(rec.datasetFilePath(P, L), (r) => {
    if (value === undefined) delete r.baseFilters;
    else r.baseFilters = value;
  }));

  ok('a Live dataset with no key has no base filters in memory', (await meta()).live.baseFilters === undefined);
  await plant([]);
  ok('an empty list reads as none', (await meta()).live.baseFilters === undefined && (await meta()).live.baseFiltersUnreadable === undefined);
  await plant('everything');
  ok('a stored key that is not a list is marked unreadable, never read as none', (await meta()).live.baseFilters === undefined && (await meta()).live.baseFiltersUnreadable === true);
  await plant(null);
  ok('NEGATIVE CONTROL: a stored null reads as none', (await meta()).live.baseFilters === undefined && (await meta()).live.baseFiltersUnreadable === undefined);
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

  // ── 2b. The write, and the adapter every builder shares ───────────────────
  const setBase = (d: string, steps: FilterStep[]) => H.as(ORG_A, () => H.liveDataset.setBaseFilters(P, d, steps));
  const PROFILE = { sampledAt: stamp, sampleRows: 9, method: 'limit', columns: [{ name: 'region', sourceType: 'VARCHAR', filled: 9, distinct: 2, values: ['North', 'South'], counts: [5, 4] }] };
  await H.as(ORG_A, () => rec.serialized(rec.datasetFilePath(P, L), (r) => { (r.live as Reply).profile = PROFILE; }));
  const e0 = (await meta()).live.epoch;
  ok('setBaseFilters writes the top-level key and bumps the epoch once', !!(await setBase(L, BASE)) && show((await raw()).baseFilters) === show(BASE) && (await meta()).live.epoch === e0 + 1 && !('baseFilters' in (await raw()).live));
  ok('…and drops the sampled figures read under the old filters, keeping the warehouse\'s type names', show((await raw()).live.profile) === show({ columns: [{ name: 'region', sourceType: 'VARCHAR' }] }), show((await raw()).live.profile));
  ok('…so a picker answers "not sampled yet", never a value the new filters exclude', liveProfile.profileDistinct((await meta()) as never, 'region') === 'notSampled');
  ok('[] deletes the key (and bumps again)', !!(await setBase(L, [])) && !('baseFilters' in (await raw())) && (await meta()).live.epoch === e0 + 2);
  ok('refused on an extract', (await setBase(s.extractId, BASE)) === false && !('baseFilters' in JSON.parse(await H.as(ORG_A, () => fs.promises.readFile(rec.datasetFilePath(P, s.extractId), 'utf8')))));
  const cols = H.fx.COLUMNS;
  ok('liveBaseOf adapts', show(liveBase.liveBaseOf(BASE, cols)) === show({ ok: true, base: [{ kind: 'in', column: 'region', values: ['North', CANARY], negate: true }] }), show(liveBase.liveBaseOf(BASE, cols)));
  ok('liveBaseOf of nothing is an empty base', show(liveBase.liveBaseOf(undefined, cols)) === show({ ok: true, base: [] }));
  for (const [label, st] of [
    ['unknown column', F('gone', '=', 1)],
    ['empty in-list', F('region', 'in', undefined, { values: [] })],
    ['period on text', F('region', 'period', undefined, { period: { preset: 'last_n_months', n: 6 } })],
    ['a period that resolves to nothing', F('d', 'period', undefined, { period: { preset: 'custom' } })],
  ] as [string, FilterStep][]) {
    const r = liveBase.liveBaseOf([BASE[0], st], cols);
    ok(`a base filter never skips: ${label} refuses`, !r.ok && (r.code === 'baseFilter' ? r.params.column === st.column : true), show(r));
  }
  ok('a skipped step refuses as baseFilter, naming its column', show(liveBase.liveBaseOf([F('gone', '=', 1)], cols)) === show(spec.refuse('baseFilter', 'gone')));
  ok('a radius step refuses (withinKm), never skips', !liveBase.liveBaseOf([{ ...F('lat', 'within_km'), radius: { lat: 1, lon: 2, km: 3 } } as unknown as FilterStep], [...cols, { name: 'lat', type: 'number' }]).ok);
  await setBase(L, BASE); // § 3 starts from the planted filters

  // ── 3. A stored list this pod cannot READ in full refuses everything ─────────
  // Dropping a step (or all of them) would answer wider than the dataset allows: every door, the lookup,
  // Make a copy and Copy the data instead refuse typed (`baseFilterUnreadable`) and spend nothing.
  const second = await H.as(ORG_A, () => H.liveOver(P, { table: 'live_typed' }, H.fx.COLUMNS));
  const chartOn = async (d: string): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId: d, encoding: ENC })).value;
  const SPEC = (d: string, filters: unknown[] = []) => ({ datasetId: d, category: 'region', measures: [{ column: 'amt', aggregation: 'sum' }], filters, chartType: 'bar', title: 'Sales by region' });
  // A text filter sends the card through the case fix first (liveCaseFix -> liveLookup), before its chart.
  const NORTH = [{ column: 'region', op: 'in', values: ['north'] }];
  const DOORS: [string, (d: string) => Promise<Reply>][] = [
    ['visual:data', chartOn],
    ['dashboard:metric', async (d) => (await post('dashboard:metric', { projectId: P, datasetId: d, column: 'amt', aggregation: 'sum' })).value],
    ['answer:card', async (d) => (await post('answer:card', { projectId: P, spec: SPEC(d) })).value],
    ['answer:card (a text filter: the case-fix lookup)', async (d) => (await post('answer:card', { projectId: P, spec: SPEC(d, NORTH) })).value],
    ['dataset:syncLiveSchema', async (d) => (await post('dataset:syncLiveSchema', { projectId: P, datasetId: d })).value],
  ];
  const unreadable = refusals.liveBaseFiltersUnreadable();
  ok('the unreadable sentence says why and what to do', /always-applied filters can't be applied by this server/.test(unreadable) && /finish upgrading Ordinate/.test(unreadable), unreadable);
  const count = async (): Promise<number> => (await H.as(ORG_A, () => H.datasets.listDatasets(P))).length;

  /** Every door, the lookup, Make a copy and Copy the data instead refuse typed on L, and spend nothing. */
  async function refusesEverywhere(what: string): Promise<unknown[]> {
    H.queryCache.clear();
    const replies: unknown[] = [];
    const calls0 = fake.calls.length;
    const n0 = await count();
    for (const [label, call] of DOORS) {
      const r = await call(L);
      replies.push(r);
      // A card's failure (ipc/liveAnswers `Failure`) carries the catalog sentence in `reason`; every other reply has the code there.
      // A sync still syncs the columns (names and types, no rows); its sample is what refuses.
      const refusal = label === 'dataset:syncLiveSchema' && r.ok === true ? r.sample : r;
      const typed = refusal.ok === false && refusal.code === 'live_refused' && (label.startsWith('answer:card') ? refusal.reason === unreadable : refusal.reason === 'baseFilterUnreadable' && refusal.error === unreadable);
      ok(`${what}: ${label} refuses typed (baseFilterUnreadable)`, typed, show(r));
    }
    let built = false;
    const looked = await H.as(ORG_A, () => H.lq.liveLookup(P, L, () => { built = true; return spec.refuse('badQuery'); }));
    replies.push(looked);
    ok(`${what}: liveLookup (the case-fix door) refuses typed before it builds a statement`,
      !built && looked.ok === false && looked.code === 'live_refused' && looked.reason === 'baseFilterUnreadable' && looked.error === unreadable, show(looked));
    const copy = (await post('dataset:copyLive', { projectId: P, datasetId: L })).value;
    replies.push(copy);
    ok(`${what}: Make a copy refuses typed and saves nothing`,
      copy.ok === false && copy.code === 'live_refused' && copy.reason === 'baseFilterUnreadable' && copy.error === unreadable && (await count()) === n0, show(copy));
    const toExtract = (await post('dataset:setMode', { projectId: P, datasetId: L, mode: 'extract' })).value;
    replies.push(toExtract);
    ok(`${what}: Copy the data instead refuses typed; the record stays Live`,
      toExtract.ok === false && toExtract.code === 'live_refused' && toExtract.reason === 'baseFilterUnreadable' && (await meta()).mode === 'live', show(toExtract));
    ok(`${what}: none of it spent a warehouse call`, fake.calls.length === calls0, show(fake.calls.length - calls0));
    return replies;
  }

  const GOOD = F('region', '!=', 'x');
  const BOGUS = { type: 'filter', column: 'x', op: 'bogus' };
  for (const [label, stored] of [
    ['a list of one step with an unknown operator', [BOGUS]],
    ['a valid step beside one with an unknown operator (partial)', [GOOD, BOGUS]],
    ['a valid step beside a non-object', [GOOD, 7]],
    ['21 valid steps (one past the cap)', Array.from({ length: base.MAX_BASE_FILTERS + 1 }, (_, i) => F('region', '!=', `v${i}`))],
    ['a step of 1,001 values', [GOOD, list(1001)]],
    ['a stored key that is not a list', 'everything'],
    ['an object keyed like a list', { 0: GOOD }],
    ['a glossary term', [GOOD, { type: 'term', term: ID }]],
    ['a radius step', [GOOD, { ...F('lat', 'within_km'), radius: { lat: 1, lon: 2, km: 3 } }]],
  ] as [string, unknown][]) {
    await plant(stored);
    const m = (await meta()).live;
    ok(`unreadable: ${label} is marked, not read as none`, m.baseFiltersUnreadable === true, show(m));
    const replies = await refusesEverywhere(`unreadable (${label})`);
    ok(`unreadable (${label}): no refusal carries a filter value`, !show(replies).includes('"x"') && !show(replies).includes('v0'), show(replies).slice(0, 300));
  }
  await plant(Array.from({ length: base.MAX_BASE_FILTERS }, (_, i) => F('region', '!=', `v${i}`)));
  ok('NEGATIVE CONTROL: exactly 20 valid steps are read in full, not marked unreadable', (await meta()).live.baseFilters.length === 20 && (await meta()).live.baseFiltersUnreadable === undefined);
  await plant(BASE);
  ok('NEGATIVE CONTROL: a readable list is not marked unreadable', (await meta()).live.baseFiltersUnreadable === undefined);

  // ── 4. The doors: every statement a Live question sends binds the base filter ──
  const M = (column: string, aggregation: string) => ({ column, aggregation });
  const okReply = (r: Reply): boolean => r.ok === true && (r.sample === undefined || r.sample.ok === true);
  const ANSWER = (d: string) => ({ datasetId: d, category: 'cat', measures: [M('amt', 'sum')], filters: [{ column: 'region', op: 'in', values: ['south'] }, { column: 'd', period: 'last_year' }], chartType: 'bar', title: 't' });
  const SENDS: [string, (d: string) => Promise<Reply>, number][] = [
    ['text chart', async (d) => (await post('visual:data', { projectId: P, datasetId: d, encoding: { category: 'cat', values: [M('amt', 'sum')] } })).value, 1],
    ['number chart (bin range + chart)', async (d) => (await post('visual:data', { projectId: P, datasetId: d, encoding: { category: 'qty', values: [M('amt', 'sum')] } })).value, 2],
    ['date chart (grain probe + chart)', async (d) => (await post('visual:data', { projectId: P, datasetId: d, encoding: { category: 'd', values: [M('amt', 'sum')] } })).value, 2],
    ['KPI', async (d) => (await post('dashboard:metric', { projectId: P, datasetId: d, column: 'qty', aggregation: 'sum' })).value, 1],
    ['answer (case fix + latest + chart)', async (d) => (await post('answer:card', { projectId: P, spec: ANSWER(d) })).value, 3],
    ['schema sync (profile)', async (d) => (await post('dataset:syncLiveSchema', { projectId: P, datasetId: d })).value, 1],
  ];
  const canaried = (c: { params: { value: unknown }[] }): boolean => c.params.some((p) => p.value === CANARY);
  const sends = async (d: string, call: (d: string) => Promise<Reply>): Promise<{ r: Reply; sent: typeof fake.calls }> => {
    H.queryCache.clear();
    const from = fake.calls.length;
    const r = await call(d);
    return { r, sent: fake.calls.slice(from) };
  };
  await setBase(L, BASE);
  for (const [label, call, n] of SENDS) {
    const { r, sent } = await sends(L, call);
    ok(`${label}: answers, and every one of its ${n} statements binds the base filter`, okReply(r) && sent.length === n && sent.every(canaried), `${show(r).slice(0, 200)} ${show(sent.map((c) => c.sql.slice(0, 120)))}`);
  }
  for (const [label, call, n] of SENDS) {
    const { r, sent } = await sends(second.liveId, call);
    ok(`NEGATIVE CONTROL: ${label} on a Live dataset without base filters sends ${n}, none with the canary`, okReply(r) && sent.length === n && !sent.some(canaried));
  }
  const lookup = await sends(L, () => H.as(ORG_A, () => H.lq.liveLookup(P, L, (t) => compile.compileCaseMatches('region', ['south'], t.env))));
  ok('liveLookup (the case fix) binds the base filter', lookup.r.ok === true && lookup.sent.length === 1 && lookup.sent.every(canaried));
  const synced = (await meta()).live.profile.columns.find((c: Reply) => c.name === 'region');
  ok('the sync sampled under the base filter: North is gone from the region values', synced.values.length > 0 && !synced.values.includes('North'), show(synced));

  const cards = async (d: string): Promise<number> => (await post('visual:data', { projectId: P, datasetId: d, encoding: ENC })).value.data.labels.length;
  const regions = (await H.as(ORG_A, async () => (await chartOn(L)).data.labels)) as string[];
  ok('a chart by the filtered column has no North', !regions.includes('North') && regions.includes('South') && (await cards(second.liveId)) === regions.length + 1, show(regions));

  // A period base filter: the resolved range is in the key, so the answer moves at midnight.
  await setBase(L, [F('d', 'period', undefined, { period: { preset: 'last_n_months', n: 6 } })]);
  H.queryCache.clear();
  const c0 = fake.calls.length;
  await chartOn(L);
  await chartOn(L);
  const asked = fake.calls.length - c0;
  process.env.ORDINATE_TODAY = '2025-01-15';
  await chartOn(L);
  const moved = fake.calls.length - c0 - asked;
  process.env.ORDINATE_TODAY = '2025-03-15';
  ok('a period base filter: asked once, then cached; a new day asks again (the resolved range is in the key)', asked === 1 && moved === 1, show({ asked, moved }));

  // The stale fallback never serves an answer computed under other base filters.
  await setBase(L, BASE);
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, L, 0)); // every ask goes to the warehouse
  H.queryCache.clear();
  const fresh = await chartOn(L);
  fake.hook = async () => ({ ok: false, error: 'warehouse down' });
  const staleSame = await chartOn(L);
  ok('CONTROL: with the warehouse down and the same filters, the last answer is served, labelled stale', staleSame.ok === true && staleSame.asOf.stale === true && show(staleSame.data) === show(fresh.data), show(staleSame).slice(0, 200));
  await setBase(L, [F('region', 'not in', undefined, { values: ['South', CANARY] })]);
  const afterChange = await chartOn(L);
  ok('a base change with the warehouse down: live_failed, never the stale answer from before the change', afterChange.ok === false && afterChange.code === 'live_failed', show(afterChange).slice(0, 200));
  fake.hook = null;
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, L, 300));
  await setBase(L, BASE);

  // A base that keeps none of the engine's sample: retried LIMIT-only, never stored as every column empty.
  const syncOnce = async (d: string): Promise<{ r: Reply; sent: typeof fake.calls }> => {
    let first = true;
    fake.hook = async () => (first ? ((first = false), { ok: true as const, columns: [], rows: [], truncated: false }) : undefined);
    try {
      return await sends(d, async (x) => (await post('dataset:syncLiveSchema', { projectId: P, datasetId: x })).value);
    } finally {
      fake.hook = null;
    }
  };
  const retried = await syncOnce(L);
  const prof = (await meta()).live.profile;
  ok('an empty sample under the base filters is retried LIMIT-only, and the retry binds them too',
    retried.r.ok === true && retried.sent.length === 2 && /USING SAMPLE/.test(retried.sent[0].sql) && !/USING SAMPLE/.test(retried.sent[1].sql) && retried.sent.every(canaried), show(retried.sent.map((c) => c.sql.slice(0, 160))));
  ok('…and the retry is what is stored (rows, LIMIT), not "every column empty"', prof.sampleRows > 0 && prof.method === 'limit', show({ rows: prof.sampleRows, method: prof.method }));
  const notRetried = await syncOnce(second.liveId);
  ok('NEGATIVE CONTROL: without base filters an empty row sample is not retried (today\'s rule)', notRetried.r.ok === true && notRetried.sent.length === 1);

  // A sync that sampled under other filters than the record holds when it writes stores no figures.
  const syncWrite = (under: FilterStep[]) => H.as(ORG_A, async () => H.liveDataset.writeSchemaSync(P, L, {
    columns: (await meta()).columns, profile: PROFILE as never, missingColumns: [], syncedAt: new Date().toISOString(), changed: false, sampledUnder: under,
  }));
  await syncWrite([]);
  ok('a sync sampled under other base filters stores no figures', show((await raw()).live.profile) === show({ columns: [{ name: 'region', sourceType: 'VARCHAR' }] }), show((await raw()).live.profile));
  await syncWrite(BASE);
  ok('NEGATIVE CONTROL: one sampled under the same filters stores them', (await raw()).live.profile.sampleRows === 9);

  // A base column the warehouse dropped: every question refuses, the sync still syncs the columns.
  await H.as(ORG_A, () => H.fx.loadWarehouse('live_drop', H.fx.COLUMNS, H.fx.fixtureRows()));
  const third = await H.as(ORG_A, () => H.liveOver(P, { table: 'live_drop' }, H.fx.COLUMNS));
  await setBase(third.liveId, BASE);
  await H.warehouseExec(ORG_A, 'ALTER TABLE live_drop DROP COLUMN region');
  const dropped = refusals.liveBaseFilterRefused('region');
  // Not synced yet: the record still declares `region`, the warehouse no longer has it.
  const n2 = await count();
  for (const [label, channel, extra] of [['Make a copy', 'dataset:copyLive', {}], ['Copy the data instead', 'dataset:setMode', { mode: 'extract' }]] as [string, string, Reply][]) {
    const r = (await post(channel, { projectId: P, datasetId: third.liveId, ...extra })).value;
    ok(`a base column gone from the fetched rows: ${label} refuses typed (baseFilter), saves nothing, stays Live`,
      r.ok === false && r.code === 'live_refused' && r.reason === 'baseFilter' && r.error === dropped && (await count()) === n2 && isLive(await metaOf(third.liveId)), show(r));
  }
  const dropSync = (await post('dataset:syncLiveSchema', { projectId: P, datasetId: third.liveId })).value;
  ok('a dropped base column: the sync syncs the columns, its sample refused typed (baseFilter)',
    dropSync.ok === true && dropSync.removed.includes('region') && dropSync.sample.ok === false && dropSync.sample.code === 'live_refused' && dropSync.sample.reason === 'baseFilter' && dropSync.sample.error === dropped, show(dropSync));
  for (const [label, call] of DOORS.slice(0, 2)) {
    const before = fake.calls.length;
    const r = await call(third.liveId);
    ok(`a dropped base column: ${label} refuses baseFilter, no warehouse call`, r.ok === false && r.code === 'live_refused' && r.reason === 'baseFilter' && r.error === dropped && fake.calls.length === before, show(r));
  }
  ok('the sentence names the column and who can fix it', /“region”/.test(dropped) && /until an editor changes it/.test(dropped), dropped);
  for (const [label, channel, extra] of [['Make a copy', 'dataset:copyLive', {}], ['Copy the data instead', 'dataset:setMode', { mode: 'extract' }]] as [string, string, Reply][]) {
    const before = fake.calls.length;
    const r = (await post(channel, { projectId: P, datasetId: third.liveId, ...extra })).value;
    ok(`a dropped base column, synced: ${label} refuses typed (baseFilter) before it fetches`, r.ok === false && r.reason === 'baseFilter' && (await count()) === n2 && fake.calls.length === before && isLive(await metaOf(third.liveId)), show(r));
  }

  // ── 5. Copies keep the base filters as Prepare steps (never wider than the dataset) ──
  await setBase(L, BASE);
  H.queryCache.clear();
  const kpi = async (d: string, column: string, aggregation: string): Promise<Reply> => (await post('dashboard:metric', { projectId: P, datasetId: d, column, aggregation })).value;
  const liveCount = await kpi(L, 'qty', 'count');
  const liveSum = await kpi(L, 'amt', 'sum');
  const writes: Reply[] = [];
  const realPersist = H.datasets.persist;
  (H.datasets as { persist: typeof realPersist }).persist = (projectId, ds, progress) => { writes.push({ id: ds.id, steps: ds.steps }); return realPersist(projectId, ds, progress); };
  const copy = (await post('dataset:copyLive', { projectId: P, datasetId: L })).value;
  (H.datasets as { persist: typeof realPersist }).persist = realPersist;
  const copyMeta = await metaOf(copy.dataset.id);
  ok('Make a copy: the copy carries the base filters as its Prepare steps', copy.ok === true && show(copyMeta.steps) === show(BASE), show(copy));
  ok('…written once, already filtered: no moment holds the rows the filters exclude', show(writes) === show([{ id: copy.dataset.id, steps: BASE }]), show(writes));
  ok('…its KPIs are the Live KPIs (Object.is)', Object.is((await kpi(copy.dataset.id, 'qty', 'count')).value, liveCount.value) && Object.is((await kpi(copy.dataset.id, 'amt', 'sum')).value, liveSum.value), show([liveCount.value, liveSum.value]));
  ok('…its rows are the filtered ones, and the fetched table is its Prepare source', copy.dataset.rowCount < H.fx.fixtureRows().length && copyMeta.sourceColumns?.length === H.fx.COLUMNS.length, show({ rows: copy.dataset.rowCount, source: copyMeta.sourceColumns }));
  ok('NEGATIVE CONTROL: the same KPI on the Live dataset without base filters differs', !Object.is((await kpi(second.liveId, 'qty', 'count')).value, liveCount.value));
  const plainCopy = (await post('dataset:copyLive', { projectId: P, datasetId: second.liveId })).value;
  ok('NEGATIVE CONTROL: a copy of a Live dataset without base filters has no steps (today\'s copy)', plainCopy.ok === true && show((await metaOf(plainCopy.dataset.id)).steps) === show([]) && plainCopy.dataset.rowCount === H.fx.fixtureRows().length);

  const switched = (await post('dataset:setMode', { projectId: P, datasetId: L, mode: 'extract' })).value;
  ok('Copy the data instead: same id, the steps, the same KPIs, no baseFilters key left',
    switched.ok === true && switched.mode === 'extract' && show((await metaOf(L)).steps) === show(BASE) && Object.is((await kpi(L, 'qty', 'count')).value, liveCount.value)
      && Object.is((await kpi(L, 'amt', 'sum')).value, liveSum.value) && !('baseFilters' in (await raw())) && !isLive(await meta()), show(switched));

  await close();
  finish();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  finish();
});
