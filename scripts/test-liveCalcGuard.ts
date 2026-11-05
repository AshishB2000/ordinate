// A Live dataset's calculated fields: kept, and refused where this pod cannot read them (semantic layer part 8,
// step 00a, as step 04 leaves it).
//
// 00a was the rolling-deploy guard for step 04: a pod that cannot compute the fields refuses every question
// that would answer without them. Step 04 computes them, so what stays of the guard is the UNREADABLE list: a
// stored list this pod cannot read in full (a newer release's shape) still refuses every door, typed, because
// a calc it dropped would read as an unknown column and a filter on it would be skipped.
//
// 1. sanitizeLiveCalcs rebuilds `{name, expression, type}` and drops what it cannot read; capped at 50;
//    idempotent (a re-save never changes a stored field again).
// 2. The key lives at the TOP LEVEL of the dataset record: `meta.live.calculated` is read from it and the calcs
//    are appended to `meta.columns` (step 04), and no Live writer (each rebuilds `raw.live`) erases it or
//    copies it into `live` or `columns`.
// 3. A readable list: every door that names no calc answers (step 04, test-liveCalcs covers the rest). An
//    unreadable one: every door (a chart, a KPI, an answer card with and without the case-fix lookup, a
//    schema sync, the scheduler's daily sync), "Make a copy" and "Copy the data instead" refuse typed
//    (`calculated`) and spend no warehouse call, and a copy saves nothing. With base filters too (applied
//    since PR 08), the same holds. NEGATIVE CONTROL: the same doors answer on a Live dataset with no key, an
//    empty one, a null one, and on this one once the key is gone.
//
//   npm run build:ts && node scripts/test-liveCalcGuard.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';

const fs: typeof import('fs') = require('fs');
const calcs: typeof import('../src/data/liveCalcs') = require('../src/data/liveCalcs');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const refusals: typeof import('../src/engine/liveRefusals') = require('../src/engine/liveRefusals');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const job: typeof import('../src/engine/live/schemaSyncJob') = require('../src/engine/live/schemaSyncJob');

const { fake, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);
const C = (name: string, expression = '1', type: unknown = 'number') => ({ name, expression, type });
const CALCS = [
  { name: 'Margin', expression: '[amt] - [qty]', type: 'number' },
  { name: 'Band', expression: "IF [amt] > 10 THEN 'big' ELSE 'small' END", type: 'text' },
];
const BASE = [{ type: 'filter', column: 'region', op: '!=', value: 'North' }];
const ENC = { category: 'region', values: [{ column: 'amt', aggregation: 'sum' }] };

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  duck.forbidSyncOnMainThread();

  // ── 1. The sanitizer ──────────────────────────────────────────────────────
  ok('sanitize rebuilds the three keys and drops what it cannot read', show(calcs.sanitizeLiveCalcs([
    { ...CALCS[0], extra: 1 },
    C('x\u0000'), C('y', '1', 'date'), C('w', 'a\u0000b'), C('   '), C('e', ''), C('big', 'x'.repeat(5_000)), C('n'.repeat(201)),
    7, null, 'text', [CALCS[0]],
  ])) === show([CALCS[0]]));
  ok('sanitize trims a name and keeps a text type', show(calcs.sanitizeLiveCalcs([C('  Band  ', 'x', 'text')])) === show([C('Band', 'x', 'text')]));
  ok('sanitize keeps a name of 200 and an expression of 4,000, and no more', calcs.MAX_CALC_NAME === 200 && calcs.MAX_CALC_EXPRESSION === 4_000
    && calcs.sanitizeLiveCalcs([C('n'.repeat(200), 'x'.repeat(4_000))]).length === 1
    && calcs.sanitizeLiveCalcs([C('n'.repeat(201))]).length === 0 && calcs.sanitizeLiveCalcs([C('n', 'x'.repeat(4_001))]).length === 0);
  const many = (n: number) => Array.from({ length: n }, (_, i) => C(`c${i}`));
  ok('sanitize caps at 50', calcs.MAX_LIVE_CALCS === 50 && calcs.sanitizeLiveCalcs(many(60)).length === 50 && calcs.sanitizeLiveCalcs(many(50)).length === 50);
  ok('sanitize of a non-list is empty', calcs.sanitizeLiveCalcs(undefined).length === 0 && calcs.sanitizeLiveCalcs('x').length === 0 && calcs.sanitizeLiveCalcs({ 0: CALCS[0] }).length === 0);
  for (const [label, input] of [
    ['a mixed list', [{ ...CALCS[0], extra: 1 }, C('  Band  ', 'x', 'text'), C('y', '1', 'date'), 7]],
    ['a list past the cap', many(60)],
    ['a list with one valid calc', CALCS],
    ['a non-list', 'everything'],
  ] as [string, unknown][]) {
    ok(`sanitize twice == once: ${label}`, show(calcs.sanitizeLiveCalcs(calcs.sanitizeLiveCalcs(input))) === show(calcs.sanitizeLiveCalcs(input)));
  }
  ok('hasLiveCalcs: some, or a list that could not be read in full', !calcs.hasLiveCalcs(undefined) && !calcs.hasLiveCalcs({})
    && !calcs.hasLiveCalcs({ calculated: [] }) && calcs.hasLiveCalcs({ calculated: [CALCS[0]] }) && calcs.hasLiveCalcs({ calculatedUnreadable: true }));

  // ── 2. Where it is stored ─────────────────────────────────────────────────
  const meta = () => H.as(ORG_A, () => H.datasets.getDatasetMeta(P, L)) as Promise<Reply>;
  const raw = (): Promise<Reply> => H.as(ORG_A, async () => JSON.parse(await fs.promises.readFile(rec.datasetFilePath(P, L), 'utf8')));
  const plantKey = (key: 'calculated' | 'baseFilters', value: unknown) => H.as(ORG_A, () => rec.serialized(rec.datasetFilePath(P, L), (r) => {
    if (value === undefined) delete r[key];
    else r[key] = value;
  }));
  const plant = (value: unknown) => plantKey('calculated', value);

  const before = (await meta()).columns;
  ok('a Live dataset with no key has no calculated fields in memory', (await meta()).live.calculated === undefined && (await meta()).live.calculatedUnreadable === undefined);
  await plant([]);
  ok('NEGATIVE CONTROL: an empty list reads as none', (await meta()).live.calculated === undefined && (await meta()).live.calculatedUnreadable === undefined);
  await plant(null);
  ok('NEGATIVE CONTROL: a stored null reads as none', (await meta()).live.calculated === undefined && (await meta()).live.calculatedUnreadable === undefined);
  await plant('everything');
  ok('a stored key that is not a list is marked unreadable, never read as none', (await meta()).live.calculated === undefined && (await meta()).live.calculatedUnreadable === true);
  await plant({ 0: CALCS[0] });
  ok('an object keyed like a list is marked unreadable too', (await meta()).live.calculated === undefined && (await meta()).live.calculatedUnreadable === true);
  await plant(CALCS);
  ok('meta.live.calculated is read from the top-level key; meta.columns gains the calcs at its end (step 04)', show((await meta()).live.calculated) === show(CALCS)
    && (await meta()).live.calculatedUnreadable === undefined
    && show((await meta()).columns) === show([...before, ...CALCS.map((c) => ({ name: c.name, type: c.type }))]), show((await meta()).live));

  const stamp = new Date().toISOString();
  const WRITERS: [string, () => Promise<unknown>][] = [
    ['bumpEpoch', () => H.liveDataset.bumpEpoch(P, L)],
    ['setMaxCacheAge', () => H.liveDataset.setMaxCacheAge(P, L, 60)],
    ['stampSyncAttempt', () => H.liveDataset.stampSyncAttempt(P, L, stamp)],
    ['writeSchemaSync', async () => H.liveDataset.writeSchemaSync(P, L, {
      columns: calcs.declaredColumns((await meta()) as { columns: import('../src/data/parse').ParsedColumn[] }), profile: { columns: [] }, missingColumns: [], syncedAt: stamp, changed: false,
    })],
    // Part 1 step 08's write of the base filters (and their removal) keeps the calculated fields too.
    ['setBaseFilters', async () => (await H.liveDataset.setBaseFilters(P, L, BASE as never)) && H.liveDataset.setBaseFilters(P, L, [])],
  ];
  const holdsKey = async (): Promise<boolean> => {
    const r = await raw();
    return show(r.calculated) === show(CALCS) && !('calculated' in r.live) && !r.columns.some((c: Reply) => CALCS.some((k) => k.name === c.name));
  };
  for (const [name, write] of WRITERS) {
    const done = await H.as(ORG_A, write);
    ok(`${name} keeps raw.calculated and writes it into neither raw.live nor raw.columns`, !!done && (await holdsKey()), show(await raw()));
  }
  ok('…and the writers\' changes landed', (await meta()).live.maxCacheAgeSec === 60 && (await raw()).live.syncAttemptAt === stamp);

  // ── 3. The guard ──────────────────────────────────────────────────────────
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
  const sentence = refusals.liveCalculatedRefused('Margin');
  ok('the sentence says why and what to do', /calculated fields can't be computed by this server/.test(sentence) && /finish upgrading Ordinate/.test(sentence), sentence);
  ok('the refusal code renders its catalog key with its column', spec.refuse('calculatedUnreadable', 'Margin').message === sentence && spec.refuse('calculatedUnreadable', 'Margin').params.column === 'Margin');
  const count = async (): Promise<number> => (await H.as(ORG_A, () => H.datasets.listDatasets(P))).length;

  /**
   * Every door, the lookup, Make a copy and Copy the data instead refuse typed on L (whatever is planted), and
   * spend nothing. `why` is the code the refusal travels under and `said` its sentence.
   */
  async function refusesEverywhere(what: string, why = 'calculatedUnreadable', said = sentence): Promise<unknown[]> {
    H.queryCache.clear();
    const replies: unknown[] = [];
    const calls0 = fake.calls.length;
    const n0 = await count();
    for (const [label, call] of DOORS) {
      const r = await call(L);
      replies.push(r);
      // A card's failure (ipc/liveAnswers `Failure`) carries the catalog sentence in `reason`; every other reply has the code there.
      const typed = r.ok === false && r.code === 'live_refused' && (label.startsWith('answer:card') ? r.reason === said : r.reason === why && r.error === said);
      ok(`${what}: ${label} refuses typed (${why})`, typed, show(r));
    }
    let built = false;
    const looked = await H.as(ORG_A, () => H.lq.liveLookup(P, L, () => { built = true; return spec.refuse('badQuery'); }));
    replies.push(looked);
    ok(`${what}: liveLookup (the case-fix door) refuses typed before it builds a statement`,
      !built && looked.ok === false && looked.code === 'live_refused' && looked.reason === why && looked.error === said, show(looked));
    const copy = (await post('dataset:copyLive', { projectId: P, datasetId: L })).value;
    replies.push(copy);
    ok(`${what}: Make a copy refuses typed and saves nothing`,
      copy.ok === false && copy.code === 'live_refused' && copy.reason === why && copy.error === said && (await count()) === n0, show(copy));
    const toExtract = (await post('dataset:setMode', { projectId: P, datasetId: L, mode: 'extract' })).value;
    replies.push(toExtract);
    ok(`${what}: Copy the data instead refuses typed; the record stays Live`,
      toExtract.ok === false && toExtract.code === 'live_refused' && toExtract.reason === why && toExtract.error === said && (await meta()).mode === 'live', show(toExtract));
    ok(`${what}: none of it spent a warehouse call`, fake.calls.length === calls0, show(fake.calls.length - calls0));
    return replies;
  }

  /** A readable list (step 04): every door that names no calc answers on L. */
  async function answersEverywhere(what: string): Promise<void> {
    H.queryCache.clear();
    for (const [label, call] of DOORS) {
      const r = await call(L);
      ok(`${what}: ${label} answers`, r.ok === true, show(r).slice(0, 240));
    }
  }
  await answersEverywhere('a readable list (step 04)');
  ok('…and the record still holds the calculated fields it was planted with', show((await meta()).live.calculated) === show(CALCS) && (await holdsKey()));

  // The scheduler's daily sync is a door too: on an unreadable list, queued, then refused typed, and it writes nothing but its own attempt stamp.
  await plant('everything');
  const rawBefore = await raw();
  const calls0 = fake.calls.length;
  const started = await H.as(ORG_A, () => job.startSchemaSync(P, L, { scheduled: true, now: Date.now() + 3_000 }));
  const synced = (started?.status === 'queued' ? await started.done : undefined) as Reply | undefined;
  ok('the daily sync is queued, then refused typed (calculatedUnreadable), and spent no warehouse call',
    started?.status === 'queued' && synced?.ok === false && synced.code === 'live_refused' && synced.reason === 'calculatedUnreadable' && synced.error === refusals.liveCalculatedRefused('') && fake.calls.length === calls0, show(synced));
  const rawAfter = await raw();
  const liveOf = (r: Reply) => show({ ...r.live, syncAttemptAt: undefined });
  ok('…it wrote only its attempt stamp: no missingColumns, same columns, same schemaSyncedAt, same calculated fields',
    typeof rawAfter.live.syncAttemptAt === 'string' && rawAfter.live.syncAttemptAt !== rawBefore.live.syncAttemptAt && !('missingColumns' in rawAfter.live)
    && liveOf(rawAfter) === liveOf(rawBefore) && show(rawAfter.columns) === show(rawBefore.columns) && rawAfter.calculated === 'everything', show(rawAfter.live));
  await plant(CALCS);

  // A stored list this pod cannot READ in full is refused too: dropping an entry (or all of them) would answer without it.
  const GOOD = CALCS[0];
  for (const [label, stored] of [
    ['a list of one calc with an unknown type', [C('a', '1', 'date')]],
    ['a valid calc beside one with an unknown type (partial)', [GOOD, C('a', '1', 'date')]],
    ['a valid calc beside a non-object', [GOOD, 7]],
    ['a valid calc beside a 5 KB expression', [GOOD, C('a', 'x'.repeat(5_000))]],
    ['a valid calc beside a NUL in a name', [GOOD, C('a\u0000')]],
    ['51 valid calcs (one past the cap)', many(calcs.MAX_LIVE_CALCS + 1)],
    ['a stored key that is not a list', 'everything'],
    ['an object keyed like a list', { 0: GOOD }],
  ] as [string, unknown][]) {
    await plant(stored);
    const m = (await meta()).live;
    ok(`unreadable: ${label} is marked, not read as none`, m.calculatedUnreadable === true, show(m));
    await refusesEverywhere(`unreadable (${label})`, 'calculatedUnreadable', refusals.liveCalculatedRefused(Array.isArray(stored) && stored[0] === GOOD ? GOOD.name : ''));
  }
  await plant(many(calcs.MAX_LIVE_CALCS));
  ok('NEGATIVE CONTROL: exactly 50 valid calcs are read in full, not marked unreadable', (await meta()).live.calculated.length === 50 && (await meta()).live.calculatedUnreadable === undefined);
  await plant(CALCS);
  ok('NEGATIVE CONTROL: a readable list is not marked unreadable', (await meta()).live.calculatedUnreadable === undefined);

  // With base filters too (PR 08 applies them, so they no longer refuse): a readable list answers every door,
  // and an unreadable one refuses with its own code, base filters or not.
  await plantKey('baseFilters', BASE);
  await answersEverywhere('base filters and calcs together');
  await plant([GOOD, 7]);
  await refusesEverywhere('base filters and an unreadable list: the list refuses', 'calculatedUnreadable', refusals.liveCalculatedRefused(GOOD.name));
  await plantKey('baseFilters', undefined);
  await refusesEverywhere('once the base filters are gone, the unreadable list still refuses', 'calculatedUnreadable', refusals.liveCalculatedRefused(GOOD.name));
  await plant(CALCS);

  // The one whole-record rebuild (persist, through writeRecordKeepingPolicy) would drop raw.calculated: no Live writer or door reaches it.
  const realWrite = rec.writeRecordKeepingPolicy;
  let rebuilt = 0;
  (rec as { writeRecordKeepingPolicy: typeof realWrite }).writeRecordKeepingPolicy = (...a) => { rebuilt += 1; return realWrite(...a); };
  try {
    for (const [, write] of WRITERS) await H.as(ORG_A, write);
    await answersEverywhere('through the persist spy');
    ok('no Live writer or door goes through writeRecordKeepingPolicy (persist), which would drop raw.calculated', rebuilt === 0 && (await holdsKey()), String(rebuilt));
    await H.as(ORG_A, () => H.datasets.updateSteps(P, s.extractId, []));
    ok('NEGATIVE CONTROL: the spy sees a plain extract write', rebuilt > 0, String(rebuilt));
  } finally {
    (rec as { writeRecordKeepingPolicy: typeof realWrite }).writeRecordKeepingPolicy = realWrite;
  }

  // NEGATIVE CONTROLS: the guard is the calculated fields, nothing else.
  const n1 = await count();
  for (const [label, call] of DOORS) {
    const r = await call(second.liveId);
    ok(`NEGATIVE CONTROL: ${label} answers on a Live dataset without calculated fields`, r.ok === true, show(r).slice(0, 240));
  }
  const copyOther = (await post('dataset:copyLive', { projectId: P, datasetId: second.liveId })).value;
  ok('NEGATIVE CONTROL: Make a copy answers on a Live dataset without calculated fields', copyOther.ok === true && (await count()) === n1 + 1, show(copyOther));
  for (const [label, stored] of [['the key removed', undefined], ['an empty list', []], ['a null', null]] as [string, unknown][]) {
    await plant(stored);
    H.queryCache.clear();
    for (const [door, call] of DOORS) {
      const r = await call(L);
      ok(`NEGATIVE CONTROL: with ${label}, ${door} answers on the same dataset`, r.ok === true, show(r).slice(0, 240));
    }
  }

  await close();
  finish();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  finish();
});
