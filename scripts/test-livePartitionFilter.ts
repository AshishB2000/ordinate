'use strict';

// Live date filters on key columns (docs/assistant/00-design.md; engine/live/liveDateRange.ts,
// compileFilter RAW_RANGE_DIALECTS; scripts/warehousePruning.ts).
//
//   1. A REQUIRED date range. A Live dataset whose source table doc says a filter on its date column
//      is required (BigQuery's require_partition_filter as a stored fact, or an editor's "required
//      filters" naming it) gets "Last 12 months" on a question that has none, and says so — through
//      every door (visual:data, dashboard:metric, computeCard), in ONE place (a spy counts the calls;
//      the source has one call site). A question that filters the column already is untouched, and so
//      is a dataset with no such fact (NEGATIVE CONTROL). The figure equals the copy's with "Last 12
//      months" chosen by hand.
//   2. The RAW-RANGE compile, switch off and on, for all six dialects: off is today's SQL byte for
//      byte; on, a key column is compared raw and half-open, every value bound, the bound typed for
//      the column (DATE, TIMESTAMP, BigQuery TIMESTAMP), and anything else keeps the cast. Parity with
//      the extract is test-liveParity's (scripts/liveParityRawRange.ts).
//   3. LOOKUPS (the answers' case fix, the latest-day probe) carry the same range; the probe's day is
//      never claimed for a period past the range, and the card says the range (NEGATIVE CONTROL: no
//      doc, no range). PARTITIONS THAT ARE NOT A DECLARED DATE: an integer-range partition that is
//      required refuses an unfiltered question on every door (chart, tile, answer, SQL) naming it, and a
//      filtered one passes, its case fix included; BigQuery's `_PARTITIONTIME` is a TIMESTAMP range among
//      the base filters, on the table scan under a calc, BigQuery only (NEGATIVE CONTROL: DuckDB refuses).
//   4. The nightly's pruning measurement: its plan skips without variables, refuses a half-set, and
//      compiles its two forms; test-warehouseLive skips green without secrets and writes no artifact.
//
//   npm run build:ts && node scripts/test-livePartitionFilter.js

import { ok, finish } from './selfcheck';
import { H, close, post } from './liveRouteHarness';
import type { LiveColumn, LiveIR } from '../src/engine/live/liveSpec';
import type { CompileDialectId } from '../src/engine/live/dialect';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { spawnSync }: typeof import('child_process') = require('child_process');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const dateRange: typeof import('../src/engine/live/liveDateRange') = require('../src/engine/live/liveDateRange');
const compile: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const compileFilter: typeof import('../src/engine/live/compileFilter') = require('../src/engine/live/compileFilter');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const liveSql: typeof import('../src/engine/live/liveSql') = require('../src/engine/live/liveSql');
const liveTarget: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
const pruning: typeof import('./warehousePruning') = require('./warehousePruning');
const { DIALECT_IDS, dialectFor }: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');

const SENTENCE = 'Last 12 months: this table needs a date range';
const ENC = { category: 'cat', values: [{ column: 'amt', aggregation: 'sum' as const }] };
const LAST_12 = { type: 'filter' as const, column: 'd', op: 'period' as const, period: { preset: 'last_n_months' as const, n: 12 } };

let calls = 0;
const real = dateRange.withRequiredRange;
(dateRange as { withRequiredRange: typeof real }).withRequiredRange = (...a) => { calls += 1; return real(...a); };

/** The days the last statement since the reset bound to a range on `d`; none when it sent none (a cache hit: its key is the IR, range and all). */
function sentRange(): string[] {
  const c = H.fake.calls.at(-1);
  H.fakeMod.resetFake();
  if (!c) return [];
  const n = (c.sql.match(/TRY_CAST\(lv_src\."d" AS DATE\) >= /g) ?? []).length;
  return n ? c.params.filter((p) => p.type === 'date').map((p) => String(p.value)) : [];
}

async function doors(projectId: string, liveId: string, filters: import('../src/data/transforms').FilterStep[] = []) {
  const before = calls;
  H.fakeMod.resetFake();
  const viz = (await post('visual:data', { projectId, datasetId: liveId, encoding: ENC, filters })).value;
  const vizSent = sentRange();
  const kpi = (await post('dashboard:metric', { projectId, datasetId: liveId, column: 'amt', aggregation: 'sum', filters })).value;
  const kpiSent = sentRange();
  const card = await H.as(H.ORG_A, () => answers.computeCard(projectId, { datasetId: liveId, category: 'cat', measures: ENC.values, filters: filters.length ? [{ column: 'd', period: 'last_year' }] : [], chartType: 'bar', title: 't' }));
  const cardSent = sentRange();
  return { viz, kpi, card: 'card' in card ? card.card : null, sent: [vizSent, kpiSent, cardSent], spied: calls - before };
}

async function requiredRange(): Promise<void> {
  const s = await H.setupOrg(H.ORG_A);
  const P = s.projectId;
  // The doc an editor's "Read from warehouse" stores: `d` is the partition column, and BigQuery requires a filter on it.
  await H.as(H.ORG_A, async () => {
    const made = await store.createSourceDoc(P, s.connId, 'live_typed', {});
    if (!made.ok) throw new Error('no doc');
    await store.updateSourceDoc(P, s.connId, made.docId, (d) => ({ ...d, facts: { columns: [{ name: 'd', type: 'DATE' }], partition: { columns: ['d'], method: 'DAY', required: true }, clusterBy: ['cat'], readAt: '2025-03-01T00:00:00Z', readBy: 'ana' } }));
  });
  const facts = await H.as(H.ORG_A, async () => {
    const meta = await H.datasets.getDatasetMeta(P, s.liveId);
    return meta?.origin?.kind === 'connection' ? dateRange.dateFactsOf(P, meta.origin, undefined, H.fx.COLUMNS) : null;
  });
  ok('facts: `d` is required and a key; `cat` (a cluster key, not a date) is neither', JSON.stringify(facts) === '{"required":["d"],"keys":["d"]}', JSON.stringify(facts));

  H.fakeMod.resetFake();
  const got = await doors(P, s.liveId);
  ok('chart: the reply says the range it added, in the catalog sentence', got.viz.ok === true && Array.isArray(got.viz.notes) && got.viz.notes.includes(SENTENCE), JSON.stringify(got.viz.notes));
  ok('KPI tile: dashboard:metric says it too', got.kpi.ok === true && Array.isArray(got.kpi.notes) && got.kpi.notes.includes(SENTENCE), JSON.stringify(got.kpi));
  ok('answer: the card says it', !!got.card && got.card.notes.includes(SENTENCE), JSON.stringify(got.card?.notes));
  // ORDINATE_TODAY is 2025-03-15 (./liveQueryHarness): the 12 complete months before March 2025.
  ok('every door sent `d` in [2024-03-01, 2025-02-28], bound', got.sent.every((r) => JSON.stringify(r) === '["2024-03-01","2025-02-28"]'), JSON.stringify(got.sent));
  ok('ONE place: the executor\'s shared step ran once per door', got.spied === 3, `${got.spied} calls`);
  const sites = (function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  })(path.join(__dirname, '..', 'src')).filter((f) => /withRequiredRange\(/.test(fs.readFileSync(f, 'utf8')) && !f.endsWith('liveDateRange.ts'));
  ok('ONE place: src/ calls withRequiredRange only in the executor (liveQuery.ts)', sites.length === 1 && sites[0].endsWith(path.join('engine', 'live', 'liveQuery.ts')), sites.join());

  const copy = (await post('visual:data', { projectId: P, datasetId: s.extractId, encoding: ENC, filters: [LAST_12] })).value;
  // Each path ranks by its own rule (test-liveParity checks both), so the figures are compared by label.
  const byLabel = (d: { labels: string[]; series: { values: (number | null)[] }[] }) => new Map(d.labels.map((l, i) => [l, d.series[0].values[i]]));
  const [mine, theirs] = got.viz.ok && copy.ok ? [byLabel(got.viz.data), byLabel(copy.data)] : [new Map(), new Map([['', 0]])];
  ok('the figure is the copy\'s with "Last 12 months" chosen by hand (Object.is, label by label)', mine.size > 0 && mine.size === theirs.size && [...mine].every(([l, v]) => theirs.has(l) && Object.is(v, theirs.get(l))), JSON.stringify([got.viz.data, copy.data]));

  // A question that filters `d` already is untouched: one range (its own), no sentence.
  const own = await doors(P, s.liveId, [{ type: 'filter', column: 'd', op: 'period', period: { preset: 'custom', from: '2024-01-01', to: '2024-06-30' } }]);
  ok('a question with its own date filter: no sentence on the chart, the tile or the card', !own.viz.notes?.includes(SENTENCE) && !own.kpi.notes?.includes(SENTENCE) && !!own.card && !own.card.notes.includes(SENTENCE), JSON.stringify([own.viz.notes, own.kpi.notes, own.card?.notes]));
  ok('…and its own range is the only one sent', JSON.stringify(own.sent.slice(0, 2)) === '[["2024-01-01","2024-06-30"],["2024-01-01","2024-06-30"]]', JSON.stringify(own.sent));

  // NEGATIVE CONTROL: the same table with no facts and no typed required filter is asked as before.
  const bare = await H.as(H.ORG_A, () => H.liveOver(P, { table: 'live_typed' }, H.fx.COLUMNS));
  const conns = await H.as(H.ORG_A, async () => (await store.listSourceIndex(P, bare.connId)).length);
  const none = await doors(P, bare.liveId);
  ok('NEGATIVE CONTROL: no doc on its connection — no range added, no sentence', conns === 0 && none.sent.every((r) => r.length === 0) && !none.viz.notes?.includes(SENTENCE) && !none.kpi.notes?.includes(SENTENCE) && !!none.card && !none.card.notes.includes(SENTENCE),
    JSON.stringify([none.sent, none.viz.notes, none.kpi.notes]));

  // An editor's typed "required filters" naming the column is the other way in.
  await H.as(H.ORG_A, () => store.createSourceDoc(P, bare.connId, 'live_typed', { requiredFilters: 'Always filter on D, or a query scans every partition' }));
  const typed = await doors(P, bare.liveId);
  ok('an editor\'s required filter naming `D` (any case) adds the range too', typed.sent.every((r) => JSON.stringify(r) === '["2024-03-01","2025-02-28"]') && typed.viz.notes?.includes(SENTENCE), JSON.stringify(typed.sent));
  await H.as(H.ORG_A, async () => {
    const id = (await store.listSourceIndex(P, bare.connId))[0].docId;
    await store.saveSourceDoc(P, bare.connId, id, { requiredFilters: 'Filter on d_utc' });
  });
  const near = await doors(P, bare.liveId);
  ok('NEGATIVE CONTROL: a required filter naming another word (`d_utc`) adds nothing', near.sent.every((r) => r.length === 0) && !near.viz.notes?.includes(SENTENCE), JSON.stringify(near.sent));
}

/** The date params of the statements since the reset whose SQL matches `re`. */
function datesOf(re: RegExp): string[][] {
  return H.fake.calls.filter((c) => re.test(c.sql)).map((c) => c.params.filter((p) => p.type === 'date').map((p) => String(p.value)));
}

const card = (P: string, liveId: string, filters: import('../src/ai/answerSpec').AnswerFilter[]) =>
  H.as(H.ORG_A, () => answers.computeCard(P, { datasetId: liveId, category: 'cat', measures: ENC.values, filters, chartType: 'bar', title: 't' }));

async function lookups(): Promise<void> {
  const P = (await H.setupOrg(H.ORG_A)).projectId;
  const withDoc = await H.as(H.ORG_A, () => H.liveOver(P, { table: 'live_typed' }, H.fx.COLUMNS));
  await H.as(H.ORG_A, async () => {
    const made = await store.createSourceDoc(P, withDoc.connId, 'live_typed', {});
    if (!made.ok) throw new Error('no doc');
    await store.updateSourceDoc(P, withDoc.connId, made.docId, (d) => ({ ...d, facts: { columns: [{ name: 'd', type: 'DATE' }], partition: { columns: ['d'], method: 'DAY', required: true }, readAt: '2025-03-01T00:00:00Z', readBy: 'ana' } }));
  });
  const bare = await H.as(H.ORG_A, () => H.liveOver(P, { table: 'live_typed' }, H.fx.COLUMNS));
  const RANGE = '["2024-03-01","2025-02-28"]';

  H.fakeMod.resetFake();
  await card(P, withDoc.liveId, [{ column: 'region', op: '=', value: 'WEST' }]);
  const fixed = datesOf(/SELECT DISTINCT/);
  ok('case fix: its lookup carries the required range on `d`, bound', fixed.length === 1 && JSON.stringify(fixed[0]) === RANGE, JSON.stringify(fixed));
  H.fakeMod.resetFake();
  await card(P, bare.liveId, [{ column: 'region', op: '=', value: 'WEST' }]);
  ok('NEGATIVE CONTROL: no doc — the case fix sends no range', JSON.stringify(datesOf(/SELECT DISTINCT/)) === '[[]]', JSON.stringify(datesOf(/SELECT DISTINCT/)));

  // `this_week` (2025-03-09…) is empty; the data ends on 2025-03-01, after the range's end (2025-02-28).
  H.fakeMod.resetFake();
  const week = await card(P, withDoc.liveId, [{ column: 'd', period: 'this_week' }]);
  const probe = datesOf(/AS o_l0/);
  const notes = 'card' in week ? week.card.notes : [];
  ok('latest-day probe: held to the required range (never wider), and the card says so', probe.length === 1 && JSON.stringify(probe[0]) === RANGE && notes.includes(SENTENCE), JSON.stringify([probe, notes]));
  ok('…and a day it found inside the range is never said for a period after the range (the data really ends on 2025-03-01)', notes.every((n) => !/ends on/.test(n)), JSON.stringify(notes));
  H.fakeMod.resetFake();
  const bareWeek = await card(P, bare.liveId, [{ column: 'd', period: 'this_week' }]);
  const bareNotes = 'card' in bareWeek ? bareWeek.card.notes : [];
  ok('NEGATIVE CONTROL: no doc — the probe reads every day and the card says where the data ends', JSON.stringify(datesOf(/AS o_l0/)) === '[[]]' && bareNotes.some((n) => /ends on/.test(n)) && !bareNotes.includes(SENTENCE), JSON.stringify(bareNotes));
}

async function integerPartition(): Promise<void> {
  const P = (await H.setupOrg(H.ORG_A)).projectId;
  const ds = await H.as(H.ORG_A, () => H.liveOver(P, { table: 'live_typed' }, H.fx.COLUMNS));
  await H.as(H.ORG_A, async () => {
    const made = await store.createSourceDoc(P, ds.connId, 'live_typed', {});
    if (!made.ok) throw new Error('no doc');
    await store.updateSourceDoc(P, ds.connId, made.docId, (d) => ({ ...d, facts: { columns: [{ name: 'tier', type: 'INT64' }], partition: { columns: ['tier'], method: 'RANGE', required: true }, readAt: '2025-03-01T00:00:00Z', readBy: 'ana' } }));
  });
  const NEEDS = 'This table needs a filter on "tier": add one to the question.';
  const facts = await H.as(H.ORG_A, async () => {
    const meta = await H.datasets.getDatasetMeta(P, ds.liveId);
    return meta?.origin?.kind === 'connection' ? dateRange.dateFactsOf(P, meta.origin, undefined, H.fx.COLUMNS) : null;
  });
  ok('facts: a required integer-range partition is `unbounded`, no date range', JSON.stringify(facts) === '{"required":[],"keys":[],"unbounded":["tier"]}', JSON.stringify(facts));
  const TIER = { type: 'filter' as const, column: 'tier', op: '=' as const, value: 1 };
  H.fakeMod.resetFake();
  const viz = (await post('visual:data', { projectId: P, datasetId: ds.liveId, encoding: ENC, filters: [] })).value;
  const kpi = await post('dashboard:metric', { projectId: P, datasetId: ds.liveId, column: 'amt', aggregation: 'sum', filters: [] });
  const ans = await card(P, ds.liveId, [{ column: 'region', op: '=', value: 'WEST' }]);
  const sql = await H.as(H.ORG_A, () => liveSql.runLiveSql(P, 'SELECT count(*) AS n FROM t', [{ id: ds.liveId, names: ['t'] }]));
  ok('unfiltered: chart, tile, answer and SQL refuse, naming the column, and nothing is asked', viz.ok === false && viz.error === NEEDS && JSON.stringify(kpi.value).includes(JSON.stringify(NEEDS).slice(1, -1)) && !('card' in ans) && ans.reason === NEEDS
    && sql.ok === false && sql.error === NEEDS && H.fake.calls.length === 0, JSON.stringify([viz, kpi.value, ans, sql, H.fake.calls.length]));
  H.fakeMod.resetFake();
  const v2 = (await post('visual:data', { projectId: P, datasetId: ds.liveId, encoding: ENC, filters: [TIER] })).value;
  const k2 = (await post('dashboard:metric', { projectId: P, datasetId: ds.liveId, column: 'amt', aggregation: 'sum', filters: [TIER] })).value;
  const a2 = await card(P, ds.liveId, [{ column: 'region', op: '=', value: 'WEST' }, { column: 'tier', op: '=', value: 1 }]);
  const s2 = await H.as(H.ORG_A, () => liveSql.runLiveSql(P, 'SELECT count(*) AS n FROM t WHERE tier = 1', [{ id: ds.liveId, names: ['t'] }]));
  const fix = H.fake.calls.filter((c) => /SELECT DISTINCT/.test(c.sql));
  ok('filtered on `tier`: every door answers, and the case fix reads tier as the question does', v2.ok === true && k2.ok === true && 'card' in a2 && s2.ok === true && fix.length === 1 && fix[0].params.some((p) => p.type === 'number' && p.value === 1),
    JSON.stringify([v2.ok, k2.ok, 'card' in a2 ? 'card' : a2, s2.ok ? 'ok' : s2, fix.map((c) => c.params)]));
}

function partitionTime(): void {
  const columns: LiveColumn[] = [{ name: 'amt', type: 'number' }, { name: 'cat', type: 'text' }];
  const ir: LiveIR = { kind: 'metric', measures: [{ column: 'amt', aggregation: 'sum' }], filters: [], order: 'natural', weekCal: null };
  const env = { dialect: 'bigquery' as const, source: { kind: 'table' as const, parts: ['p', 'd', 't'] }, columns };
  const r = dateRange.withRequiredRange(ir, { requiredTime: true, env });
  const q = r.ok ? compile.compileMetric(r.ir, r.env) : null;
  const sql = q?.ok ? q.query.sql : '';
  ok('_PARTITIONTIME: a TIMESTAMP range on the pseudo-column, half-open, both ends bound at UTC midnight, the question IR untouched',
    r.ok && r.ir === ir && r.notes.includes(SENTENCE) && sql.includes('WHERE (lv_src._PARTITIONTIME >= CAST(@p0 AS TIMESTAMP) AND lv_src._PARTITIONTIME < CAST(@p1 AS TIMESTAMP))')
      && q?.ok === true && JSON.stringify(q.query.params.map((p) => [p.type, p.value])) === '[["timestamp","2024-03-01T00:00:00.000Z"],["timestamp","2025-03-01T00:00:00.000Z"]]', sql);
  ok('…it is a base filter, so it is in the cache key (`keyOf` reads env.base)', r.ok && JSON.stringify(r.env.base?.map((f) => f.column)) === '["_PARTITIONTIME"]');
  const calc = { ...env, source: { ...env.source, calcs: [{ name: 'dbl', expression: '[amt] * 2', type: 'number' as const }] } };
  const rc = dateRange.withRequiredRange({ ...ir, measures: [{ column: 'dbl', aggregation: 'sum' }] }, { requiredTime: true, env: { ...calc, columns: [...columns, { name: 'dbl', type: 'number' }] } });
  const qc = rc.ok ? compile.compileMetric(rc.ir, rc.env) : null;
  const inner = qc?.ok ? qc.query.sql : '';
  ok('…under a calc it sits on the table scan itself, innermost', /FROM `p`\.`d`\.`t` AS lv_src WHERE \(lv_src\._PARTITIONTIME >= /.test(inner), inner);
  const duck = dateRange.withRequiredRange(ir, { requiredTime: true, env: { ...env, dialect: 'duckdb' } });
  const qd = duck.ok ? compile.compileMetric(duck.ir, duck.env) : null;
  ok('NEGATIVE CONTROL: any other dialect refuses the pseudo-column, never drops it', qd?.ok === false, JSON.stringify(qd));
}

async function partitionTimeFacts(): Promise<void> {
  const P = (await H.setupOrg(H.ORG_A)).projectId;
  const ds = await H.as(H.ORG_A, () => H.liveOver(P, { table: 'live_typed' }, H.fx.COLUMNS));
  await H.as(H.ORG_A, async () => {
    const made = await store.createSourceDoc(P, ds.connId, 'live_typed', {});
    if (!made.ok) throw new Error('no doc');
    await store.updateSourceDoc(P, ds.connId, made.docId, (d) => ({ ...d, facts: { columns: [], partition: { columns: ['_PARTITIONTIME'], method: 'DAY', required: true }, readAt: '2025-03-01T00:00:00Z', readBy: 'ana' } }));
  });
  const [facts, target] = await H.as(H.ORG_A, async () => {
    const meta = await H.datasets.getDatasetMeta(P, ds.liveId);
    return [meta?.origin?.kind === 'connection' ? await dateRange.dateFactsOf(P, meta.origin, undefined, H.fx.COLUMNS) : null, await liveTarget.liveTarget(P, ds.liveId)] as const;
  });
  ok('facts: an ingestion-time table that requires a filter is `partitionTime`', JSON.stringify(facts) === '{"required":[],"keys":[],"partitionTime":true}', JSON.stringify(facts));
  ok('NEGATIVE CONTROL: on a warehouse that is not BigQuery the target asks for no partition time', target.ok && target.target.requiredTime === undefined, JSON.stringify(target.ok && target.target.requiredTime));
}

function rawRangeCompile(): void {
  const columns: LiveColumn[] = [
    { name: 'd', type: 'date', sourceType: 'DATE' }, { name: 'ts', type: 'date', sourceType: 'TIMESTAMP' }, { name: 'tz', type: 'date', sourceType: 'TIMESTAMP_TZ' },
    { name: 'txt', type: 'date', sourceType: 'VARCHAR' }, { name: 'other', type: 'date', sourceType: 'DATE' }, { name: 'amt', type: 'number', sourceType: 'DOUBLE' },
  ];
  const range = (column: string, from?: string, to?: string): LiveIR => ({ kind: 'metric', measures: [{ column: 'amt', aggregation: 'sum' }], filters: [{ kind: 'range', column, ...(from ? { from } : {}), ...(to ? { to } : {}) }], order: 'natural', weekCal: null });
  const chart = (column: string): LiveIR => ({ kind: 'chart', category: { column: 'd', kind: 'date', grain: 'month' }, measures: [{ column: 'amt', aggregation: 'sum' }], filters: [{ kind: 'range', column, from: '2024-01-01', to: '2024-02-28' }], order: 'natural', weekCal: null });
  const env = (dialect: CompileDialectId, keys?: string[]) => ({ dialect, source: { kind: 'table' as const, parts: ['s', 't'] }, columns, ...(keys ? { keys } : {}) });
  const keys = ['d', 'ts', 'tz', 'txt'];
  const q = (ir: LiveIR, e: ReturnType<typeof env>) => {
    const c = ir.kind === 'metric' ? compile.compileMetric(ir, e) : compile.compileChart(ir, { kind: 'date', grain: 'month' }, e);
    return c.ok ? c.query : null;
  };
  const irs = [range('d', '2024-01-01', '2024-02-28'), range('ts', undefined, '2023-12-31'), range('tz', '2024-02-29'), range('txt', '2024-01-01', '2024-01-31'), chart('ts')];
  let offSame = 0;
  for (const d of DIALECT_IDS) for (const ir of irs) if (JSON.stringify(q(ir, env(d, keys))) === JSON.stringify(q(ir, env(d)))) offSame += 1;
  ok(`switch OFF (RAW_RANGE_DIALECTS empty): keys change nothing — ${DIALECT_IDS.length} dialects × ${irs.length} statements byte-equal`, compileFilter.RAW_RANGE_DIALECTS.size === 0 && offSame === DIALECT_IDS.length * irs.length, `${offSame}`);

  for (const d of DIALECT_IDS) {
    compileFilter.RAW_RANGE_DIALECTS.add(d);
    try {
      const ref = (n: string) => `lv_src.${dialectFor(d).ident(n)}`;
      // Raw: every mention of the column is bare, in `IS NOT NULL`, `>=` or `<` — never inside a cast.
      const bare = (sql: string, n: string) => { const all = sql.split(ref(n)).length - 1; return all > 0 && all === sql.split(new RegExp(`${ref(n).replace(/[.`"\\]/g, '\\$&')} (?:IS NOT NULL|>=|<) `)).length - 1; };
      const on = q(range('d', '2024-01-01', '2024-02-28'), env(d, keys))!;
      const col = ref('d');
      ok(`${d}: a DATE key is compared raw, half-open, both days bound (end = to + 1)`, on.sql.includes(`${col} IS NOT NULL AND ${col} >= `) && on.sql.includes(`${col} < `) && bare(on.sql, 'd')
        && JSON.stringify(on.params.map((p) => [p.type, p.value])) === '[["date","2024-01-01"],["date","2024-02-29"]]', on.sql);
      const ts = q(range('ts', undefined, '2023-12-31'), env(d, keys))!;
      ok(`${d}: a TIMESTAMP key is compared raw against ${d === 'bigquery' ? 'a TIMESTAMP (no DATE→TIMESTAMP coercion there)' : 'a DATE'}, the year's end exclusive`,
        bare(ts.sql, 'ts') && JSON.stringify(ts.params.map((p) => [p.type, p.value])) === JSON.stringify([d === 'bigquery' ? ['timestamp', '2024-01-01T00:00:00.000Z'] : ['date', '2024-01-01']]), ts.sql);
      const tz = q(range('tz', '2024-02-29'), env(d, keys))!;
      ok(`${d}: a zoned timestamp key is compared raw from the leap day`, bare(tz.sql, 'tz') && JSON.stringify(tz.params.map((p) => p.value)) === '["2024-02-29"]', tz.sql);
      const txt = range('txt', '2024-01-01', '2024-01-31');
      ok(`${d}: a date stored as text keeps the cast form exactly`, JSON.stringify(q(txt, env(d, keys))) === JSON.stringify(q(txt, env(d))));
      const other = range('other', '2024-01-01', '2024-01-31');
      ok(`${d}: a date column that is no key keeps the cast form exactly`, JSON.stringify(q(other, env(d, keys))) === JSON.stringify(q(other, env(d))));
      const odd = range('d', '2024-1-5', '2024-02-30');
      ok(`${d}: a bound that is not an ISO day keeps the cast form exactly`, JSON.stringify(q(odd, env(d, keys))) === JSON.stringify(q(odd, env(d))));
    } finally {
      compileFilter.RAW_RANGE_DIALECTS.delete(d);
    }
  }
}

function pruningMeasurement(): void {
  const envOf = (vars: Record<string, string>) => (n: string): string => (vars[n] ?? '').trim();
  const sf = pruning.pruningPlan(envOf({}), 'snowflake');
  const bq = pruning.pruningPlan(envOf({}), 'bigquery');
  ok('pruning plan: Snowflake with no table set is skipped (not a failure); BigQuery measures its public default, June 2024',
    !sf.run && !sf.missing && bq.run && bq.plan.isDefault && bq.plan.column === 'datehour' && bq.plan.from === '2024-06-01' && bq.plan.to === '2024-06-30', JSON.stringify([sf, bq]));
  const half = pruning.pruningPlan(envOf({ SNOWFLAKE_PRUNING_TABLE: 'DB.S.T' }), 'snowflake');
  const bad = pruning.pruningPlan(envOf({ BIGQUERY_PRUNING_TABLE: 'p.d.t', BIGQUERY_PRUNING_COLUMN: 'x;drop' }), 'bigquery');
  const set = pruning.pruningPlan(envOf({ SNOWFLAKE_PRUNING_TABLE: 'DB.S.T', SNOWFLAKE_PRUNING_COLUMN: 'EVENT_TS', SNOWFLAKE_PRUNING_MONTH: '2024-02' }), 'snowflake');
  ok('pruning plan: a table without its column, or a column that is no plain identifier, is refused (NEGATIVE CONTROL: not a skip); a full set runs over its month',
    !half.run && !!half.missing && !bad.run && !!bad.missing && set.run && !set.plan.isDefault && set.plan.from === '2024-02-01' && set.plan.to === '2024-02-29', JSON.stringify([half, bad, set]));
  const f = pruning.forms('bigquery', { kind: 'table', parts: ['p', 'd', 't'] }, { name: 'datehour', type: 'date', sourceType: 'TIMESTAMP' }, '2024-06-01', '2024-06-30');
  ok('pruning forms: the cast form casts the column, the raw form does not, both bind every day; the switch is left off',
    typeof f !== 'string' && f.cast.sql.includes('SAFE_CAST(lv_src.`datehour` AS DATE) >= CAST(@p0 AS DATE)') && f.raw.sql.includes('lv_src.`datehour` >= CAST(@p0 AS TIMESTAMP)')
      && JSON.stringify(f.raw.params.map((p) => p.value)) === '["2024-06-01T00:00:00.000Z","2024-07-01T00:00:00.000Z"]' && compileFilter.RAW_RANGE_DIALECTS.size === 0, typeof f === 'string' ? f : f.raw.sql);
  const sfForm = pruning.forms('snowflake', { kind: 'table', parts: ['DB', 'S', 'T'] }, { name: 'D', type: 'date', sourceType: 'DATE' }, '2024-06-01', '2024-06-30');
  const text = typeof sfForm === 'string' ? '' : pruning.inlined(sfForm.raw);
  let refused = false;
  try { pruning.inlined({ sql: 'SELECT ? AS x', params: [{ name: 'p0', type: 'text', value: "x' OR '1'='1" }], columns: ['x'] }); } catch { refused = true; }
  ok('pruning EXPLAIN text: only the measurement\'s own ISO days are inlined, anything else refuses', !text.includes('?') && text.includes(`"D" >= CAST('2024-06-01' AS DATE)`) && refused, text);

  // The nightly itself, with no warehouse variable at all: green, says it skipped, writes nothing.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-pruning-')), 'pruning.json');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SNOWFLAKE|BIGQUERY)_/.test(k)));
  const run = (extra: Record<string, string>) => spawnSync(process.execPath, [path.join(__dirname, 'test-warehouseLive.js')], { env: { ...clean, WAREHOUSE_PRUNING_OUT: out, GITHUB_STEP_SUMMARY: '', ...extra }, encoding: 'utf8', timeout: 60_000 });
  const skipped = run({});
  ok('test-warehouseLive without secrets: exit 0, both warehouses skipped, no pruning artifact', skipped.status === 0 && /skip Snowflake real-account checks/.test(skipped.stdout) && /skip BigQuery real-account checks/.test(skipped.stdout) && !fs.existsSync(out), skipped.stdout.slice(-500) + skipped.stderr.slice(-500));
  const alone = run({ BIGQUERY_PRUNING_TABLE: 'p.d.t' });
  ok('NEGATIVE CONTROL: a pruning variable without the warehouse\'s key fails the nightly (a half-set is not a skip)', alone.status !== 0 && /missing: BIGQUERY_KEY_JSON/.test(alone.stdout + alone.stderr), alone.stdout.slice(-300));
}

async function main(): Promise<void> {
  rawRangeCompile();
  partitionTime();
  pruningMeasurement();
  await requiredRange();
  await lookups();
  await integerPartition();
  await partitionTimeFacts();
}

void main()
  .catch((e) => ok('live partition filter suite threw', false, e && (e as Error).stack))
  .then(() => close())
  .finally(() => finish());
