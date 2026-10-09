// REAL engines for the live-parity matrix (docs/live-data/00-plan.md L2.8) —
// Postgres standing in for Redshift, and ClickHouse. Helper for
// scripts/test-liveParityPostgres.ts and scripts/test-liveParityClickhouse.ts;
// not a suite itself. (Snowflake and BigQuery, whose nightly roles may not
// write, are ./warehouseLiveParity.ts over ./liveParityLiteral.ts's twins.)
//
// Each engine is two halves that never meet:
//
//   load  TEST SETUP, through a plain client with write rights: a scratch
//         database, tables typed the way that warehouse types them, the rows.
//   run   THE CODE UNDER TEST: every compiled statement goes through
//         `connectors/liveRun.runLiveBound` — the door the executor (L2.3) uses
//         — into the REAL connector's `live.runBound`: Redshift's `$n` binds,
//         its read-only session and statement_timeout, its row-cap wrapper;
//         ClickHouse's `{p0:Type}` parameters, `readonly=2` and result caps. In
//         server mode the SSRF guard checks and pins each socket, as in production.
//
// The runner also OBSERVES what only a real engine can show, for the log and
// the engine's own pins: whether a chart statement's rows came back in rank
// order through the connector's wrapper (L2.1's ORDER BY concern), and how many
// −0 cells the warehouse returned (DuckDB stores none, so the bench never could).

import type { CompiledQuery, LiveSource } from '../src/engine/live/compile';
import type { LiveRows } from '../src/engine/live/shape';
import type { ParityEngine, Store, StoredColumn } from './liveParityFixture';

const pg: typeof import('pg') = require('pg');
const http: typeof import('http') = require('http');
const https: typeof import('https') = require('https');
const net: typeof import('net') = require('net');
const dns: typeof import('dns') = require('dns');
const registry: typeof import('../src/connectors') = require('../src/connectors');
const liveRun: typeof import('../src/connectors/liveRun') = require('../src/connectors/liveRun');

type Cell = string | number | null;

/** What the runner saw on the wire, beyond the answers. */
export interface Observed {
  statements: number;
  /** Chart statements, and how many of them came back already in (o_cr, o_sr) order. */
  charts: number;
  rankOrdered: number;
  /** Cells the warehouse returned as −0 (shaping reports each as 0). */
  negZero: number;
}

/** True when `rows` arrive sorted by the chart's ranks — what the statement's ORDER BY asked for. */
export function inRankOrder(rows: LiveRows, columns: string[]): boolean {
  const cr = columns.indexOf('o_cr');
  const sr = columns.indexOf('o_sr');
  const key = (r: unknown[], i: number): number => (i < 0 ? 0 : Number(r[i]));
  for (let i = 1; i < rows.length; i += 1) {
    const d = key(rows[i - 1], cr) - key(rows[i], cr) || key(rows[i - 1], sr) - key(rows[i], sr);
    if (d > 0) return false;
  }
  return true;
}

/**
 * The first of `host`'s addresses that accepts a TCP connection on `port`. The
 * SSRF guard pins a connector to ONE address (the first resolved), and a CI
 * runner's `localhost` may resolve to ::1 first while a service container
 * listens on IPv4 only — so the suites hand the connector the address that
 * answers, as an IP literal, and open exactly that one with SSRF_ALLOW.
 */
export async function reachableAddress(host: string, port: number): Promise<{ address: string; cidr: string }> {
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.promises.lookup(host, { all: true, verbatim: true });
  for (const a of addrs) {
    const open = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: a.address, port, timeout: 3_000 });
      const done = (v: boolean): void => { sock.destroy(); resolve(v); };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.once('timeout', () => done(false));
    });
    if (open) return { address: a.address, cidr: `${a.address}/${a.family === 6 ? 128 : 32}` };
  }
  throw new Error(`nothing accepts a connection on ${host}:${port} (${addrs.map((a) => a.address).join(', ')})`);
}

/** One statement through the connector's own runBound, observed. Throws on a warehouse error (the executor's contract). */
export function runner(connectorId: string, values: Record<string, unknown>, secrets: Record<string, string>, seen: Observed) {
  const def = registry.getConnector(connectorId);
  if (!def?.live) throw new Error(`${connectorId} has no live capability`);
  return async (q: CompiledQuery, step: string): Promise<LiveRows> => {
    seen.statements += 1;
    const res = await liveRun.runLiveBound(def, values, secrets, q.sql, q.params, { signal: new AbortController().signal, timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`${connectorId} refused a ${step} statement: ${res.error}`);
    if (res.truncated) throw new Error(`${connectorId}: a ${step} statement was truncated`);
    for (const r of res.rows) for (const v of r) if (Object.is(v, -0)) seen.negZero += 1;
    if (step === 'chart') {
      seen.charts += 1;
      if (inRankOrder(res.rows, q.columns)) seen.rankOrdered += 1;
    }
    return res.rows;
  };
}

export const freshObserved = (): Observed => ({ statements: 0, charts: 0, rankOrdered: 0, negZero: 0 });

// ── Postgres, as Redshift ────────────────────────────────────────────────────

/**
 * Redshift's types in Postgres spelling. Text is VARCHAR(256) — a bare VARCHAR
 * on Redshift — so the dialect's VARCHAR(65535) cast is what widens it.
 */
export const PG_DDL: Record<Store, string> = {
  text: 'VARCHAR(256)', float: 'DOUBLE PRECISION', int: 'INTEGER', smallint: 'SMALLINT', decimal: 'NUMERIC(38,0)',
  date: 'DATE', timestamp: 'TIMESTAMP', timestamptz: 'TIMESTAMPTZ',
};
/** …and as the catalog names them (information_schema.columns.data_type), the schema sync's `sourceType`. */
export const PG_NAME: Record<Store, string> = {
  text: 'character varying', float: 'double precision', int: 'integer', smallint: 'smallint', decimal: 'numeric',
  date: 'date', timestamp: 'timestamp without time zone', timestamptz: 'timestamp with time zone',
};

/** The zone every session in the scratch database starts in unless it says otherwise: UTC+14, no DST. */
export const HOSTILE_ZONE = 'Pacific/Kiritimati';

export interface PgParity {
  engine: ParityEngine;
  seen: Observed;
  /** A plain session on the scratch database (its default zone, no guards) — for the pins' controls. */
  query(sql: string, params?: unknown[]): Promise<unknown[][]>;
  /** Where the Redshift connector connects: the scratch database. */
  values: Record<string, unknown>;
  secrets: Record<string, string>;
  close(): Promise<void>;
}

/** −0 travels as text: pg serialises a JS number with toString(), which writes −0 as "0". */
const pgValue = (v: Cell): Cell => (Object.is(v, -0) ? '-0' : v);

/**
 * A scratch database on `adminUrl`, created byte-ordered (`LC_COLLATE 'C'`:
 * Redshift has no linguistic collation, it compares bytes) and with a HOSTILE
 * default zone, so a statement that depends on the session's zone shows it.
 */
export async function postgresParity(adminUrl: string, address: string): Promise<PgParity> {
  const db = `ordinate_l28_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  admin.on('error', () => undefined);
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  const u = new URL(adminUrl);
  u.pathname = `/${db}`;
  const client = new pg.Client({ connectionString: u.toString() });
  client.on('error', () => undefined); // cut by the DROP DATABASE … WITH (FORCE) teardown
  const drop = async (): Promise<void> => {
    await client.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  };
  try {
    await admin.query(`ALTER DATABASE ${db} SET timezone TO '${HOSTILE_ZONE}'`);
    await client.connect();
  } catch (e) {
    await drop();
    throw e;
  }

  const ssl = ['require', 'verify-ca', 'verify-full'].includes(u.searchParams.get('sslmode') ?? '');
  // Over TLS the certificate names the host, so the connector keeps it; otherwise the address that answered.
  const values: Record<string, unknown> = { host: ssl ? u.hostname : address, port: Number(u.port || 5432), database: db, user: decodeURIComponent(u.username), ssl };
  const secrets = { password: decodeURIComponent(u.password) };
  const seen = freshObserved();
  const query = async (sql: string, params: unknown[] = []): Promise<unknown[][]> =>
    (await client.query({ text: sql, values: params, rowMode: 'array' })).rows as unknown[][];

  const engine: ParityEngine = {
    name: 'postgres (redshift dialect)',
    dialect: 'redshift',
    run: runner('amazon-redshift', values, secrets, seen),
    typeName: (s) => PG_NAME[s],
    async load(table: string, columns: StoredColumn[], rows: Cell[][]): Promise<LiveSource> {
      const t = `"${table.replace(/"/g, '""')}"`;
      await query(`DROP TABLE IF EXISTS ${t}`);
      await query(`CREATE TABLE ${t} (${columns.map((c) => `"${c.name}" ${PG_DDL[c.store]}`).join(', ')})`);
      for (let at = 0; at < rows.length; at += 200) {
        const params: Cell[] = [];
        const tuples = rows.slice(at, at + 200).map((r) => `(${r.map((v, i) => {
          params.push(pgValue(v));
          return `CAST($${params.length} AS ${PG_DDL[columns[i].store]})`;
        }).join(', ')})`);
        await query(`INSERT INTO ${t} VALUES ${tuples.join(', ')}`, params);
      }
      return { kind: 'table', parts: [table] };
    },
  };
  return { engine, seen, query, values, secrets, close: drop };
}

// ── ClickHouse ───────────────────────────────────────────────────────────────

const CH_DDL: Record<Store, string> = {
  text: 'Nullable(String)', float: 'Nullable(Float64)', int: 'Nullable(Int32)', smallint: 'Nullable(Int16)', decimal: 'Nullable(Decimal(38, 0))',
  date: 'Nullable(Date)', timestamp: "Nullable(DateTime64(3, 'UTC'))", timestamptz: "Nullable(DateTime64(3, 'UTC'))",
};

/** CLICKHOUSE_URL → where to connect: `http(s)://[user[:password]@]host[:port]`. */
export function clickhouseTarget(raw: string): { origin: string; host: string; port: number; tls: boolean; user: string; password: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const tls = u.protocol === 'https:';
  return {
    origin: `${u.protocol}//${u.host}`, host: u.hostname, port: Number(u.port || (tls ? 8443 : 8123)), tls,
    user: decodeURIComponent(u.username) || 'default', password: decodeURIComponent(u.password),
  };
}

/** One admin statement over ClickHouse's HTTP interface (no readonly): the test's own setup. */
function chAdmin(t: NonNullable<ReturnType<typeof clickhouseTarget>>, sql: string, body?: string, settings: Record<string, string> = {}): Promise<string> {
  const url = new URL(t.origin);
  if (body !== undefined) url.searchParams.set('query', sql);
  for (const [k, v] of Object.entries(settings)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8', 'x-clickhouse-user': t.user };
  if (t.password) headers['x-clickhouse-key'] = t.password;
  return new Promise((resolve, reject) => {
    const req = (t.tls ? https : http).request(url, { method: 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(text) : reject(new Error(`ClickHouse ${res.statusCode}: ${text.slice(0, 500)}`))));
    });
    req.on('error', reject);
    req.end(body ?? sql);
  });
}

/** A JSONCompactEachRow cell: −0 kept as `-0`, a 38-digit decimal as its digits (a JSON number, not a double). */
function chCell(v: Cell, store: Store): string {
  if (v === null) return 'null';
  if (Object.is(v, -0)) return '-0';
  if (store === 'decimal' && typeof v === 'string' && /^-?\d+$/.test(v)) return v;
  return JSON.stringify(v);
}

export interface ChParity {
  engine: ParityEngine;
  seen: Observed;
  version: string;
  database: string;
  close(): Promise<void>;
}

export async function clickhouseParity(raw: string, address: string): Promise<ChParity> {
  const t = clickhouseTarget(raw);
  if (!t) throw new Error('CLICKHOUSE_URL is not an http(s) URL');
  const db = `ordinate_l28_${process.pid}_${Date.now()}`;
  const version = (await chAdmin(t, 'SELECT version()')).trim();
  await chAdmin(t, `CREATE DATABASE ${db}`);
  // Over TLS the certificate names the host, so the connector keeps it; plain HTTP gets the address that answered.
  const values: Record<string, unknown> = { host: t.tls ? t.host : address, port: t.port, database: db, user: t.user, insecureHttp: !t.tls };
  const secrets: Record<string, string> = t.password ? { password: t.password } : {};
  const seen = freshObserved();
  const engine: ParityEngine = {
    name: 'clickhouse',
    dialect: 'clickhouse',
    run: runner('clickhouse', values, secrets, seen),
    typeName: (s) => CH_DDL[s],
    async load(table: string, columns: StoredColumn[], rows: Cell[][]): Promise<LiveSource> {
      const name = `${db}.\`${table}\``;
      await chAdmin(t, `DROP TABLE IF EXISTS ${name}`);
      // MergeTree, as a real table is: several inserts make several parts, and no scan order is promised.
      await chAdmin(t, `CREATE TABLE ${name} (${columns.map((c) => `\`${c.name}\` ${CH_DDL[c.store]}`).join(', ')}) ENGINE = MergeTree ORDER BY tuple()`);
      for (let at = 0; at < rows.length; at += 400) {
        const lines = rows.slice(at, at + 400).map((r) => `[${r.map((v, i) => chCell(v, columns[i].store)).join(',')}]`);
        await chAdmin(t, `INSERT INTO ${name} FORMAT JSONCompactEachRow`, lines.join('\n'), { date_time_input_format: 'best_effort' });
      }
      return { kind: 'table', parts: [db, table] };
    },
  };
  return {
    engine, seen, version, database: db,
    async close(): Promise<void> {
      await chAdmin(t, `DROP DATABASE IF EXISTS ${db}`).catch(() => undefined);
    },
  };
}
