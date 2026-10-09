// The test harness's FAKE WAREHOUSE for Live datasets (docs/live-data/00-plan.md
// L2.3, L2.6). Not a suite itself.
//
// CI has no Snowflake or BigQuery, so this connector declares the live
// compiler's DuckDB dialect — the test bench L2.2's parity suite proves — and
// answers `live.runBound` by running the compiled statement on DuckDB through
// the same async bridge, against tables the test (or the e2e seed's fixture)
// created. Everything ABOVE the connector is the real thing: the record, the
// connection, the secrets store, the SSRF guard, the executor, its cache, its
// budget and its trace.
//
// Registered ONLY by a test (`registerLiveFake()`) or by a server started with
// ORDINATE_TEST_LIVE_FAKE=1 (src/server/main.ts), which env.ts refuses in prod
// (and the image ships no scripts/). It goes through `registerTestConnector`:
// the registry resolves the id, the picker's catalog never lists it.
//
//   live-fake       no host field — the executor's everyday path
//   live-fake-net   the same with a `host` field, so the SSRF guard resolves,
//                   checks and pins it before runBound sees the context
//
// The spy: `fake.calls` records every runBound (statement, parameters, signal,
// the context's bounds); `fake.hook` may hold, fail or slow a call, as a real
// warehouse would. On abort it answers "Cancelled", as a connector that
// cancelled the warehouse statement does.

import type { ConnectorContext, ConnectorDef, ConnectorError, ConnectorRows, LiveParam } from '../src/connectors/types';
import type { ParsedColumn } from '../src/data/parse';

const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');

export const LIVE_FAKE_ID = 'live-fake';
export const LIVE_FAKE_NET_ID = 'live-fake-net';

/** The e2e seed's built-in warehouse table: `values.fixture = 'orders'` creates it on first use. */
export const ORDERS_TABLE = 'live_fake_orders';
export const ORDERS_COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'amount', type: 'number' },
  { name: 'day', type: 'date' },
];
const ORDERS_DDL =
  `CREATE TABLE IF NOT EXISTS ${ORDERS_TABLE} AS SELECT ` +
  `CASE i % 4 WHEN 0 THEN 'North' WHEN 1 THEN 'South' WHEN 2 THEN 'East' ELSE 'West' END AS region, ` +
  'CAST((i * 37) % 101 AS DOUBLE) AS amount, CAST(DATE \'2024-01-01\' + CAST(i % 366 AS INTEGER) AS DATE) AS day ' +
  'FROM range(240) t(i)';

export interface FakeCall {
  sql: string;
  params: LiveParam[];
  signal: AbortSignal | undefined;
  timeoutMs: number;
  rowLimit: number;
  costTag: ConnectorContext['costTag'];
  maxBytes: number | undefined;
  /** The address the SSRF guard pinned (live-fake-net only). */
  pinned: string | undefined;
  /** True when the signal had fired by the time the call answered. */
  abortedAtEnd: boolean;
}

/** A test's say over one call: return a reply to answer with it, or undefined to run the statement. */
export type FakeHook = (call: FakeCall, ctx: ConnectorContext) => Promise<ConnectorRows | ConnectorError | undefined>;

export const fake: { calls: FakeCall[]; hook: FakeHook | null } = { calls: [], hook: null };

const CANCELLED: ConnectorError = { ok: false, error: 'Cancelled' };
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Resolves when `signal` fires — the "warehouse" a held call waits on. */
export function whenAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return p;
  return Promise.race([p, whenAborted(signal).then(() => null)]);
}

const toDuck = (p: LiveParam): string | number | null => (typeof p.value === 'boolean' ? String(p.value) : p.value);

async function ensureFixture(values: Record<string, unknown>): Promise<void> {
  if (values.fixture === 'orders') await duck.execAsync(ORDERS_DDL);
}

/** DuckDB rows (objects in SELECT order) → the connector shape: positional, capped, the cap reported. */
function shaped(rows: Record<string, unknown>[], rowLimit: number, types: Map<string, string> = new Map()): ConnectorRows {
  const names = rows.length ? Object.keys(rows[0]) : [...types.keys()];
  const cells = rows.slice(0, rowLimit).map((r) => names.map((n) => r[n] as string | number | null));
  return { ok: true, columns: names.map((name) => ({ name, type: types.get(name) ?? '' })), rows: cells, truncated: rows.length > rowLimit };
}

async function runBound(ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<ConnectorRows | ConnectorError> {
  const call: FakeCall = {
    sql, params, signal: ctx.signal, timeoutMs: ctx.timeoutMs, rowLimit: ctx.rowLimit, costTag: ctx.costTag,
    maxBytes: ctx.maxBytes, pinned: ctx.pinned?.address, abortedAtEnd: false,
  };
  fake.calls.push(call);
  try {
    const held = fake.hook ? await fake.hook(call, ctx) : undefined;
    if (held) return held;
    if (ctx.signal?.aborted) return CANCELLED;
    await ensureFixture(ctx.values);
    const rows = await raceAbort(duck.queryAsync(sql, params.map(toDuck)), ctx.signal);
    return rows === null ? CANCELLED : shaped(rows, ctx.rowLimit);
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    call.abortedAtEnd = ctx.signal?.aborted === true;
  }
}

/** The source's column types, from DuckDB's own DESCRIBE — what readLiveSchema maps to declared types. */
async function describe(sql: string): Promise<Map<string, string>> {
  const rows = await duck.queryAsync(`DESCRIBE ${sql}`);
  return new Map(rows.map((r) => [String(r.column_name), String(r.column_type)]));
}

function def(id: string, label: string, withHost: boolean): ConnectorDef {
  return {
    id,
    label,
    family: 'live-fake',
    category: 'Cloud warehouses',
    readOnly: true,
    fields: [
      ...(withHost ? [{ key: 'host', label: 'Host', type: 'text' as const }] : []),
      { key: 'fixture', label: 'Fixture', type: 'text' },
      { key: 'password', label: 'Password', type: 'password', secret: true },
    ],
    async listTables(ctx) {
      await ensureFixture(ctx.values);
      const rows = await duck.queryAsync("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name");
      return { ok: true, tables: rows.map((r) => ({ name: String(r.table_name) })) };
    },
    async run(ctx, sql) {
      try {
        await ensureFixture(ctx.values);
        const inner = `SELECT * FROM (\n${sql}\n)`;
        const types = await describe(inner);
        return shaped(await duck.queryAsync(`${inner} LIMIT ${ctx.rowLimit + 1}`), ctx.rowLimit, types);
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async describeTable(ctx, table) {
      if (!TABLE_RE.test(table)) return { ok: false, error: 'Invalid table name' };
      await ensureFixture(ctx.values);
      const types = await describe(`"${table}"`);
      return { ok: true, columns: [...types].map(([name, type]) => ({ name, type })) };
    },
    live: { dialect: 'duckdb', runBound },
  };
}

let registered = false;

/** Make the fake resolvable by id (never listed). Idempotent. Throws under ORDINATE_ENV=prod. */
export function registerLiveFake(): void {
  if (registered) return;
  registry.registerTestConnector(def(LIVE_FAKE_ID, 'Fake warehouse (tests)', false));
  registry.registerTestConnector(def(LIVE_FAKE_NET_ID, 'Fake networked warehouse (tests)', true));
  registered = true;
}

/** Forget the calls and the hook between cases. */
export function resetFake(): void {
  fake.calls.length = 0;
  fake.hook = null;
}

/**
 * The e2e seed's Live dataset: a fake connection whose fixture is `orders`
 * and a Live record over its table — the shape "Add from connection → Live"
 * stores. Run inside the org's request context, after `registerLiveFake()`.
 */
export async function seedLiveFake(projectId: string): Promise<{ connId: string; datasetId: string }> {
  registerLiveFake();
  const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
  const conn = await connections.saveConnection(projectId, { name: 'Fake warehouse', connectorId: LIVE_FAKE_ID, values: { fixture: 'orders' } });
  if (!conn) throw new Error('the fake connection was not saved');
  const ds = await liveRecord.saveLiveRecord(projectId, {
    name: 'Orders (live)', columns: ORDERS_COLUMNS, origin: { kind: 'connection', connId: conn.id, table: ORDERS_TABLE },
  });
  if (!ds) throw new Error('the Live dataset was not saved');
  return { connId: conn.id, datasetId: ds.id };
}
