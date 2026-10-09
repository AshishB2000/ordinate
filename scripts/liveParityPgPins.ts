// The pins only Postgres can show — helper for scripts/test-liveParityPostgres.ts
// (docs/live-data/00-plan.md L2.8). Each is a NAMED difference between Postgres
// and Redshift (or the extract), shown exactly, with the control that makes it
// visible; none is a loosened comparison. R3 and R4 are read off the runner's
// observations in the suite itself.
//
//   R1  collation: Postgres orders and compares text by its collation. CI's
//       postgres:17 database defaults to en_US.utf8; Redshift has no linguistic
//       collation and compares code points, as the extract (JS `<`) does. So the
//       matrix runs in a byte-ordered (C) database, and a `<` filter and a tie
//       order on an ICU-collated twin show what would differ.
//   R2  session zone: `CAST(timestamptz AS DATE)` takes the day in the
//       session's zone. The connector's live session is set to UTC (an extract
//       stores the UTC instant); a plain session in the database's UTC+14
//       default puts every one of the three instants on the next day.
//   R5  read-only: a write that the row-cap wrapper cannot stop (`nextval` in a
//       SELECT) is refused by the session's read-only guard.

import type { FilterStep } from '../src/data/transforms';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { CompileEnv } from '../src/engine/live/compile';
import type { ConnectorError, ConnectorRows, LiveParam } from '../src/connectors/types';
import type { Ok } from './liveParityMatrix';
import type { PgParity } from './liveParityEngines';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const dashIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const ev: typeof import('../src/engine/live/evaluate') = require('../src/engine/live/evaluate');
const comp: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const shape: typeof import('../src/engine/live/shape') = require('../src/engine/live/shape');
const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');

type Cell = string | number | null;
const show = (v: unknown): string => JSON.stringify(v);

interface Ctx {
  ok: Ok;
  pid: string;
  pg: PgParity;
  /** One statement through the Redshift connector's runBound (via liveRun), on the scratch database. */
  bound(sql: string, params?: LiveParam[]): Promise<ConnectorRows | ConnectorError>;
}

const env = (table: string, columns: LiveColumn[]): CompileEnv => ({ dialect: 'redshift', source: { kind: 'table', parts: [table] }, columns });

async function insert(c: Ctx, table: string, rows: Cell[][], types: string[]): Promise<void> {
  const params: Cell[] = [];
  const tuples = rows.map((r) => `(${r.map((v, i) => { params.push(v); return `CAST($${params.length} AS ${types[i]})`; }).join(', ')})`);
  await c.pg.query(`INSERT INTO "${table}" VALUES ${tuples.join(', ')}`, params);
}

async function liveCount(c: Ctx, e: CompileEnv, filters: FilterStep[]): Promise<number | null | string> {
  const a = spec.fromMetric({ column: 'k', aggregation: 'count' }, filters, e.columns, {});
  if (!a.ok) return a.code;
  const out = await ev.evaluateLive(a.ir, e, c.pg.engine.run);
  return out.ok && out.kind === 'metric' ? out.value : show(out);
}

async function liveLabels(c: Ctx, e: CompileEnv): Promise<string[] | string> {
  const a = spec.fromVizEncoding({ category: 'k', values: [{ column: 'v', aggregation: 'sum' }] }, [], e.columns, {});
  if (!a.ok) return a.code;
  const out = await ev.evaluateLive(a.ir, e, c.pg.engine.run);
  return out.ok && out.kind === 'chart' ? out.chart.data.labels : show(out);
}

/** R1: the same rows under the byte order and under ICU's root collation. */
async function collation(c: Ctx): Promise<void> {
  const icu = Number((await c.pg.query("select count(*) from pg_collation where collname = 'und-x-icu'"))[0][0]);
  if (!icu) {
    console.log('skip PIN R1 (collation): this Postgres has no ICU collation und-x-icu to show it with');
    return;
  }
  const rows: Cell[][] = ['Beta', 'a', 'b', 'B', 'Alpha', 'beta'].map((k) => [k, 1]);
  const cols: LiveColumn[] = [{ name: 'k', type: 'text', sourceType: 'character varying' }, { name: 'v', type: 'number', sourceType: 'double precision' }];
  const ds = await datasets.saveDataset(c.pid, { name: 'pin_collation', sourceKind: 'csv', ...fx.importTyped(cols, rows) });
  await c.pg.query('CREATE TABLE "pin_c" (k VARCHAR(256), v DOUBLE PRECISION)');
  await c.pg.query('CREATE TABLE "pin_icu" (k VARCHAR(256) COLLATE "und-x-icu", v DOUBLE PRECISION)');
  for (const t of ['pin_c', 'pin_icu']) await insert(c, t, rows, ['VARCHAR(256)', 'DOUBLE PRECISION']);
  const lt: FilterStep[] = [{ type: 'filter', column: 'k', op: '<', value: 'b' }];
  const ext = await dashIpc.computeCardMetric(c.pid, ds!.id, { column: 'k', aggregation: 'count' }, lt);
  const byte = await liveCount(c, env('pin_c', cols), lt);
  const ling = await liveCount(c, env('pin_icu', cols), lt);
  c.ok("PIN R1 (collation): `k < 'b'` keeps 4 of Beta/a/b/B/Alpha/beta on the extract (code points) and byte-ordered; 2 under ICU — Redshift has no such collation",
    ext.value === 4 && byte === 4 && ling === 2, show([ext.value, byte, ling]));
  // Every category ties on 1, so live orders them by label — in the collation's order.
  const cOrder = await liveLabels(c, env('pin_c', cols));
  const iOrder = await liveLabels(c, env('pin_icu', cols));
  c.ok('PIN R1 (collation): tied categories order by code point byte-ordered (Alpha, B, Beta, a, b, beta) and differently under ICU',
    show(cOrder) === '["Alpha","B","Beta","a","b","beta"]' && Array.isArray(iOrder) && show(iOrder) !== show(cOrder), show([cOrder, iOrder]));
}

/** R2: TIMESTAMPTZ instants near midnight UTC, in a database whose sessions default to UTC+14. */
async function sessionZone(c: Ctx): Promise<void> {
  const rows: Cell[][] = [['2024-01-05T23:30:00.000Z', 2], ['2024-01-05T10:00:00.000Z', 1], ['2024-01-31T20:00:00.000Z', 4]];
  const ds = await datasets.saveDataset(c.pid, { name: 'pin_tz', sourceKind: 'csv', ...fx.importTyped([{ name: 't', type: 'date' }, { name: 'v', type: 'number' }], rows) });
  const source = await c.pg.engine.load('pin_tz', [{ name: 't', store: 'timestamptz' }, { name: 'v', store: 'float' }], rows);
  const cols: LiveColumn[] = [{ name: 't', type: 'date', sourceType: 'timestamp with time zone' }, { name: 'v', type: 'number', sourceType: 'double precision' }];
  const e: CompileEnv = { dialect: 'redshift', source, columns: cols };
  const enc = { category: 't', grain: 'day' as const, values: [{ column: 'v', aggregation: 'sum' as const }] };
  const ext = await visualsIpc.vizDataFor(c.pid, ds!.id, enc, []);
  const a = spec.fromVizEncoding(enc, [], cols, {});
  const out = a.ok ? await ev.evaluateLive(a.ir, e, c.pg.engine.run) : null;
  const liveData = out && out.ok && out.kind === 'chart' ? out.chart.data : null;
  c.ok('PIN R2 (session zone): TIMESTAMPTZ days on live = the extract\'s UTC days (2024-01-05: 3, 2024-01-31: 4) in a database defaulting to UTC+14',
    ext.ok && !!liveData && show(ext.data) === show(liveData) && show(liveData.labels) === '["2024-01-05","2024-01-31"]', show([ext.ok && ext.data, liveData]));
  const zone = await c.bound('select current_setting(\'TimeZone\') as tz');
  const plainZone = (await c.pg.query("select current_setting('TimeZone')"))[0][0];
  c.ok(`PIN R2: the live session runs in UTC; a plain session there is in ${eng.HOSTILE_ZONE}`,
    zone.ok && zone.rows[0]?.[0] === 'UTC' && plainZone === eng.HOSTILE_ZONE, show([zone, plainZone]));
  // CONTROL: the very statement the connector ran, in the session's own zone.
  if (a.ok) {
    const key = { kind: 'date' as const, grain: 'day' as const };
    const q = comp.compileChart(a.ir, key, e);
    const raw = q.ok ? await c.pg.query(q.query.sql, q.query.params.map((x) => x.value)) : [];
    const shaped = q.ok ? shape.shapeChart(raw, q.query, a.ir, key, cols) : null;
    const labels = shaped && 'data' in shaped ? shaped.data.labels : null;
    c.ok('PIN R2: CONTROL — the same statement in a session left at UTC+14 puts every instant on the NEXT day (2024-01-06, 2024-02-01): what the UTC session prevents',
      show(labels) === '["2024-01-06","2024-02-01"]', show(labels));
  }
}

/** R5: a write inside a SELECT gets past the wrapper; the read-only session refuses it. */
async function readOnly(c: Ctx): Promise<void> {
  await c.pg.query('CREATE SEQUENCE "pin_seq"');
  const w = await c.bound("select nextval('pin_seq') as n");
  const next = (await c.pg.query("select nextval('pin_seq')"))[0][0];
  c.ok('PIN R5 (read-only): nextval() through runBound is refused by the read-only session, and the sequence never moved (a plain session gets 1)',
    !w.ok && /read-only/i.test(w.error) && String(next) === '1', show([w, next]));
}

export async function run(c: Ctx): Promise<void> {
  await collation(c);
  await sessionZone(c);
  await readOnly(c);
}
