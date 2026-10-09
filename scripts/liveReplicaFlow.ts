// Live on a PostgreSQL read replica, end to end on a real Postgres — helper for
// scripts/test-liveReplica.ts (its section 3); not a suite itself.
//
// A scratch DATABASE whose sessions default to UTC+14 (`ALTER DATABASE … SET
// timezone`), so a day computed in the session's zone and a day computed in UTC
// differ for every row of the fixture's timestamptz column. One table, two
// connections (the box ticked, the box not), the same table saved Live (cache
// age 0: every ask goes to the database) and copied; then the differential.

import { ok } from './selfcheck';
import type { Identity } from '../src/server/context';
import type { VizEncoding, VizMeasure } from '../src/analysis/visuals';
import type { FilterStep } from '../src/data/transforms';
import type { MetricAggregation } from '../src/analysis/metricValue';
import type { ConnectorContext, LiveParam } from '../src/connectors/types';

type Post = (channel: string, payload: unknown) => Promise<{ status: number; body: string; value: any }>; // any: each reply is narrowed by the check that reads it

const context: typeof import('../src/server/context') = require('../src/server/context');
const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const dashIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const lq: typeof import('../src/engine/live/liveQuery') = require('../src/engine/live/liveQuery');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const { Client } = require('pg') as typeof import('pg');

const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x));
const M = (column: string, aggregation: VizMeasure['aggregation']): VizMeasure => ({ column, aggregation });
const F = (column: string, op: FilterStep['op'], value?: unknown, extra: Partial<FilterStep> = {}): FilterStep =>
  ({ type: 'filter', column, op, ...(value === undefined ? {} : { value }), ...extra } as FilterStep);
const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ZONE = 'Pacific/Kiritimati'; // UTC+14: no instant has the same calendar day there and in UTC between 10:00 and 24:00 UTC

// Every amount is a quarter (or null), so a sum is exact in any order and Object.is holds for sum and avg alike.
// `note` holds '' AND null: the pinned divergence below. `region` holds whitespace and null, never ''.
const FIXTURE = `
  create table public.orders (id integer not null, region text, amount numeric(12,2), qty integer, ordered date, at timestamptz, code text, note text);
  insert into public.orders
  select g,
         (array['North', 'South', 'East', 'West', '  ', null, 'North'])[1 + g % 7],
         case when g % 11 = 0 then null else ((g * 37) % 400) / 4.0 end,
         (g * 7) % 23,
         date '2023-12-25' + (g * 3) % 400,
         timestamptz '2024-01-01 23:30:00+00' + make_interval(days => g % 9, mins => (g % 3) * 20),
         lpad((g % 5)::text, 3, '0'),
         (array['a', '', null])[1 + g % 3]
    from generate_series(1, 240) g;
  analyze public.orders;`;

const CHARTS: [string, VizEncoding, FilterStep[]][] = [
  ['sum by region (whitespace and null regions included)', { category: 'region', values: [M('amount', 'sum')] }, []],
  ['count and avg by region', { category: 'region', values: [M('id', 'count'), M('amount', 'avg')] }, []],
  ['avg by month', { category: 'ordered', grain: 'month', values: [M('amount', 'avg')] }, []],
  ['sum by ISO week, two regions', { category: 'ordered', grain: 'week', values: [M('qty', 'sum')] }, [F('region', 'in', undefined, { values: ['North', 'South'] })]],
  ['sum by quarter, amount > 50', { category: 'ordered', grain: 'quarter', values: [M('qty', 'sum')] }, [F('amount', '>', 50)]],
  ['count by year, region not empty', { category: 'ordered', grain: 'year', values: [M('region', 'count')] }, [F('region', 'not_empty')]],
  ['count by the timestamptz\'s day (UTC)', { category: 'at', grain: 'day', values: [M('id', 'count')] }, []],
  ['max amount over 10 qty bins', { category: 'qty', bins: 10, values: [M('amount', 'max')] }, []],
  ['sum by region split by code', { category: 'region', series: 'code', values: [M('amount', 'sum')] }, []],
  ['min by code, region contains "th"', { category: 'code', values: [M('amount', 'min')] }, [F('region', 'contains', 'th')]],
];

const KPIS: [string, { column: string; aggregation: MetricAggregation }, FilterStep[]][] = [
  ['sum(amount)', { column: 'amount', aggregation: 'sum' }, []],
  ['avg(amount)', { column: 'amount', aggregation: 'avg' }, []],
  ['count(region) — empties not counted', { column: 'region', aggregation: 'count' }, []],
  ['min(qty), code = 003', { column: 'qty', aggregation: 'min' }, [F('code', '=', '003')]],
  ['max(amount), ordered from 2024-06-01', { column: 'amount', aggregation: 'max' }, [F('ordered', '>=', '2024-06-01')]],
  ['avg(qty), region in North/East', { column: 'qty', aggregation: 'avg' }, [F('region', 'in', undefined, { values: ['North', 'East'] })]],
];

export async function endToEnd(post: Post, adminUrl: string, who: Identity): Promise<void> {
  const db = `ordinate_l32_${process.pid}_${Date.now().toString(36)}`;
  const root = new Client({ connectionString: adminUrl });
  root.on('error', () => {});
  await root.connect();
  await root.query(`create database ${db}`);
  await root.query(`alter database ${db} set timezone to '${ZONE}'`);
  const u = new URL(adminUrl);
  u.pathname = '/' + db;
  const src = new Client({ connectionString: u.toString() });
  src.on('error', () => {});
  try {
    await src.connect();
    await src.query(FIXTURE);
    const zone = (await src.query('show timezone')).rows[0].TimeZone;
    ok(`the source database's sessions default to ${ZONE}`, zone === ZONE, zone);
    await flow(post, u, who, src);
  } finally {
    await src.end().catch(() => {});
    await root.query(`drop database if exists ${db} with (force)`).catch(() => {});
    await root.end();
  }
}

async function flow(post: Post, u: URL, who: Identity, src: import('pg').Client): Promise<void> {
  const P = await context.runInContext(who, 'p', async () => (await projects.createProject('Replica flow')).id);
  const values = { host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user: decodeURIComponent(u.username), ssl: false };
  const secrets = { password: decodeURIComponent(u.password) };

  // ── Connect: unticked (the default), then ticked ───────────────────────────
  const plain = await post('connection:testAndSave', { projectId: P, connectorId: 'postgres', name: 'App DB (primary)', values, secrets });
  ok('a Postgres connection saved with the box left alone stores it unticked', plain.value?.ok === true && plain.value.connection.values.readReplica === false, plain.body.slice(0, 300));
  const refused = await post('connection:import', { projectId: P, connId: plain.value?.connection?.id, name: 'No', table: 'public.orders', limit: 1000, mode: 'live' });
  ok('NEGATIVE CONTROL — Live over it is refused with the opt-in sentence', refused.value?.ok === false && /Tick “This is a read replica or a warehouse”/.test(refused.value.error), refused.body);
  const replica = await post('connection:testAndSave', { projectId: P, connectorId: 'postgres', name: 'App DB (replica)', values: { ...values, readReplica: true }, secrets });
  const connId = String(replica.value?.connection?.id ?? '');
  ok('the same database saved with "This is a read replica or a warehouse" ticked', replica.value?.ok === true && replica.value.connection.values.readReplica === true, replica.body.slice(0, 300));

  // ── The same table, Live (age 0) and copied ────────────────────────────────
  const live = await post('connection:import', { projectId: P, connId, name: 'Orders (live)', table: 'public.orders', limit: 1000, mode: 'live', maxCacheAgeSec: 0 });
  const liveId = String(live.value?.dataset?.id ?? '');
  const types = (live.value?.dataset?.columns ?? []).map((c: { name: string; type: string }) => `${c.name}:${c.type}`).join(',');
  ok('Add from connection → Live over the table: schema only, declared from the catalog',
    live.value?.ok === true && live.value.dataset.mode === 'live' && live.value.dataset.rowCount === 0
      && types === 'id:number,region:text,amount:number,qty:number,ordered:date,at:date,code:text,note:text', live.body.slice(0, 300));
  const copy = await post('connection:import', { projectId: P, connId, name: 'Orders (copy)', table: 'public.orders', limit: 1000 });
  const extractId = String(copy.value?.dataset?.id ?? '');
  const copyTypes = (copy.value?.dataset?.columns ?? []).map((c: { name: string; type: string }) => `${c.name}:${c.type}`).join(',');
  ok('…and copied: 240 rows, the same column types', copy.value?.ok === true && copy.value.dataset.rowCount === 240 && copyTypes === types, `${copyTypes} ${copy.body.slice(0, 200)}`);
  const src1 = await post('dataset:source', { projectId: P, id: extractId });
  ok('the copy, from the ticked connection, is offered the Live switch', src1.value?.canGoLive === true, src1.body);
  const off = await post('connection:setLiveOptIn', { projectId: P, connId, on: false });
  ok('unticking it now is refused: one Live dataset asks it', off.value?.ok === false && off.value.liveDatasets === 1, off.body);

  // ── The differential: the L2.3 executor vs the extract, Object.is ─────────
  const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(who, 'q', fn);
  for (const [label, enc, filters] of CHARTS) {
    const ext = await as(() => visualsIpc.vizDataFor(P, extractId, enc, filters));
    const got = await as(() => lq.liveVizData(P, liveId, enc, filters));
    if (!ext.ok || !got.ok) {
      ok(`chart ${label}: both paths answer`, false, show({ ext, got }).slice(0, 400));
      continue;
    }
    // tolerant = false: every label and every figure with Object.is, sums and averages too.
    const problems = cmp.compareCharts(ext.data, got.data, () => false, !!enc.series);
    ok(`chart ${label}: live (Postgres) equals the extract, Object.is (${got.data.labels.length} rows)`, problems.length === 0 && got.data.labels.length > 0, problems.join(' | '));
    ok(`chart ${label}: same category kind and grain, dated live and uncached`,
      ext.category?.kind === got.category.kind && ext.category?.grain === got.category.grain && got.asOf.mode === 'live' && !got.asOf.cached, show([ext.category, got.category, got.asOf]));
  }
  for (const [label, spec, filters] of KPIS) {
    const ext = await as(() => dashIpc.computeCardMetric(P, extractId, spec, filters));
    const got = await as(() => lq.liveMetric(P, liveId, spec, filters));
    ok(`KPI ${label}: live (Postgres) equals the extract, Object.is`, got.ok && ext.ok && typeof got.value === 'number' && Object.is(ext.value, got.value), show([ext.value, got]));
  }

  // PINNED DIVERGENCE — '' and NULL in a text category (for L2.8 to settle, docs/live-data/log.md L3.2).
  // Every import types '' as null (parse.coerceCell), so the copy holds ONE empty group; the warehouse
  // groups '' and NULL apart, so live answers TWO rows labelled "" whose counts add up to the copy's.
  // The L2.2 bench did not see it: its extract was saved without the import's typing, '' kept.
  const pinEnc: VizEncoding = { category: 'note', values: [M('id', 'count')] };
  const pinExt = await as(() => visualsIpc.vizDataFor(P, extractId, pinEnc, []));
  const pinLive = await as(() => lq.liveVizData(P, liveId, pinEnc, []));
  const blanks = (d: { labels: (string | number)[]; series: { values: (number | null)[] }[] }): number[] =>
    d.labels.flatMap((l, i) => (l === '' ? [d.series[0].values[i] ?? 0] : []));
  const extBlank = pinExt.ok ? blanks(pinExt.data) : [];
  const liveBlank = pinLive.ok ? blanks(pinLive.data) : [];
  ok('PINNED — a text category holding both \'\' and NULL: the copy has one "" row, live two that add up to it',
    extBlank.length === 1 && liveBlank.length === 2 && liveBlank[0] + liveBlank[1] === extBlank[0], show({ extBlank, liveBlank }));

  // ── The UTC session, and its negative control ─────────────────────────────
  // Catch the statement the executor sends for the day chart, then send it again on a raw
  // session in the database's own zone: the same SQL and binds, other days.
  const def = registry.getConnector('postgres');
  const real = def?.live?.runBound;
  if (!def?.live || !real) throw new Error('postgres has no live runner');
  const seen: { sql: string; params: LiveParam[]; rows: unknown[][] }[] = [];
  def.live.runBound = async (c: ConnectorContext, sql: string, params: LiveParam[]) => {
    const r = await real(c, sql, params);
    if (r.ok) seen.push({ sql, params, rows: r.rows });
    return r;
  };
  try {
    await as(() => lq.liveVizData(P, liveId, { category: 'at', grain: 'day', values: [M('id', 'count')] }, []));
  } finally {
    def.live.runBound = real;
  }
  const stmt = seen[seen.length - 1];
  const raw = stmt ? await src.query({ text: stmt.sql, values: stmt.params.map((p) => p.value), rowMode: 'array' }) : null;
  ok('NEGATIVE CONTROL — the day chart\'s own statement, on a session left in UTC+14, answers OTHER days than the live session',
    !!stmt && !!raw && raw.rows.length > 0 && show(raw.rows) !== show(stmt.rows), show({ utc: stmt?.rows.slice(0, 3), local: raw?.rows.slice(0, 3) }));

  // ── Measured ───────────────────────────────────────────────────────────────
  const kpi = { column: 'amount', aggregation: 'sum' as const };
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    const r = await as(() => lq.liveMetric(P, liveId, kpi, []));
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (!r.ok || r.asOf.cached) throw new Error('a measured ask did not reach the database');
  }
  const setTz: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = process.hrtime.bigint();
    await src.query("set timezone to 'UTC'");
    setTz.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`     measured: a live KPI on local Postgres (connect, guards, UTC, one bound statement, close) median ${median(times).toFixed(2)} ms of 20; the UTC statement alone ${median(setTz).toFixed(3)} ms of 200`);
}
