// Self-check for src/connectors/postgres.ts — the eleven-source PostgreSQL
// wire-protocol connector family.
//
// ── What this suite can and cannot prove ─────────────────────────────────────
// There is NO live database here, and there is no honest way to fake one: a
// stub cannot tell you whether Redshift really lists Spectrum tables or whether
// QuestDB really honours `set statement_timeout`. Those live in the connector's
// `// UNVERIFIED` comments and can only be closed against a real server.
//
// What IS testable without a server is everything that happens on THIS side of
// the socket, and that is where this family's failure modes actually are:
//
//   • the per-vendor facts table (a factory that builds eleven near-identical
//     entries fails by copy-paste, so every default port and TLS default is
//     pinned against a written-out expectation),
//   • the exact SQL the driver emits — the row cap, the sub-select wrapper, the
//     server-side timeout, and identifier quoting,
//   • that a hostile identifier is rejected BEFORE a socket is opened,
//   • that a schema filter is a bound parameter and never SQL text,
//   • that a password is redacted out of a driver error string,
//   • that the password field is `secret: true`, because a password written
//     into the shareable project folder is the worst outcome this family has,
//   • that the client is closed on every path, including the failing ones.
//
// The `pg` module is replaced (via Module._load) with a recording fake, so the REAL
// connector runs its REAL code path and we read back exactly what it sent.
//
//   npx tsc … && node scripts/test-connectorsPostgres.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const Module: any = require('module');
import type { ConnectorContext, ConnectorDef } from '../src/connectors/types';

// Load the genuine pg type table BEFORE the stub goes in, so the OID → type
// name mapping is tested against pg's own catalog rather than our idea of it.
const realPgTypes: unknown = require('pg').types;

// ── The recording fake ───────────────────────────────────────────────────────

interface Recorded {
  text: string;
  values?: unknown[];
  mode?: string;
}

interface FakeResult {
  fields?: { name: string; dataTypeID: number }[];
  rows?: unknown[][];
}

let clients: FakeClient[] = [];
let connectImpl: () => Promise<void> = async () => {};
let queryImpl: (text: string, values?: unknown[]) => Promise<FakeResult> = async () => ({ fields: [], rows: [] });

const { EventEmitter }: typeof import('events') = require('events');

class FakeClient extends EventEmitter {
  config: Record<string, unknown>;
  queries: Recorded[] = [];
  connects = 0;
  ends = 0;

  constructor(config: Record<string, unknown>) {
    super();
    this.config = config || {};
    clients.push(this);
  }

  async connect(): Promise<void> {
    this.connects += 1;
    await connectImpl();
  }

  query(arg: string | FakeQuery): Promise<FakeResult> | FakeQuery {
    if (typeof arg === 'string') {
      this.queries.push({ text: arg, mode: 'simple' });
      return queryImpl(arg);
    }
    // A submitted Query, as pg runs one: rows emitted as they arrive, then the callback.
    const { text, values, queryMode } = arg.config;
    this.queries.push({ text: String(text), values, mode: queryMode });
    queryImpl(String(text), values).then((res) => {
      for (const row of res.rows || []) arg.emit('row', row, res);
      arg.callback(null, res);
    }, (err: Error) => arg.callback(err));
    return arg;
  }

  async end(): Promise<void> {
    this.ends += 1;
  }
}

class FakeQuery extends EventEmitter {
  constructor(
    readonly config: { text: string; values?: unknown[]; queryMode?: string },
    _values: unknown,
    readonly callback: (err: Error | null, res?: FakeResult) => void,
  ) {
    super();
  }
}

const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]): unknown {
  if (request === 'pg') return { Client: FakeClient, Query: FakeQuery, types: realPgTypes };
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled sibling of the .ts source.
const mod: { CONNECTORS: ConnectorDef[] } = require('../src/connectors/postgres');
const CONNECTORS = mod.CONNECTORS;

// ── Harness ──────────────────────────────────────────────────────────────────

const PASSWORD = 'sup3r-s3cret-pw';

function reset(): void {
  clients = [];
  connectImpl = async () => {};
  queryImpl = async () => ({ fields: [], rows: [] });
}

function makeCtx(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    values: {
      host: 'db.example.com',
      port: 5432,
      database: 'analytics',
      user: 'reader',
      ssl: false,
      sslInsecure: false,
      ...(over.values || {}),
    },
    secrets: { password: PASSWORD, ...(over.secrets || {}) },
    rowLimit: over.rowLimit === undefined ? 100 : over.rowLimit,
    timeoutMs: over.timeoutMs === undefined ? 30_000 : over.timeoutMs,
  };
}

function byId(id: string): ConnectorDef {
  const c = CONNECTORS.find((x) => x.id === id);
  if (!c) throw new Error('no connector ' + id);
  return c;
}

/** Every statement the driver sent, in order, across every client it opened. */
function allSql(): string[] {
  return clients.flatMap((c) => c.queries.map((q) => q.text));
}

/** The one data statement — everything the driver sends that is not a `set`. */
function dataSql(): string {
  const hits = allSql().filter((t) => !/^\s*set\b/i.test(t));
  return hits.length === 1 ? hits[0] : hits.join(' ;; ');
}

// ── Expectations, written out rather than derived ────────────────────────────
//
// This table is the whole point of the file. Eleven entries built by a factory
// all LOOK right; the way they go wrong is one entry silently carrying its
// neighbour's port. So the ports are transcribed from vendor documentation and
// compared literally — no loops over the source's own data, which would agree
// with any mistake it contains.

const EXPECTED: { id: string; label: string; port: number; ssl: boolean }[] = [
  { id: 'postgres', label: 'PostgreSQL', port: 5432, ssl: false },
  { id: 'amazon-redshift', label: 'Amazon Redshift', port: 5439, ssl: true },
  { id: 'cockroachdb', label: 'CockroachDB', port: 26257, ssl: false },
  { id: 'alloydb', label: 'Google AlloyDB', port: 5432, ssl: true },
  { id: 'neon', label: 'Neon', port: 5432, ssl: true },
  { id: 'supabase', label: 'Supabase', port: 5432, ssl: true },
  { id: 'timescaledb', label: 'TimescaleDB', port: 5432, ssl: false },
  { id: 'yugabytedb', label: 'YugabyteDB', port: 5433, ssl: false }, // YSQL, not 5432
  { id: 'materialize', label: 'Materialize', port: 6875, ssl: false },
  { id: 'questdb', label: 'QuestDB', port: 8812, ssl: false }, // pgwire, not the 9000 HTTP port
  { id: 'risingwave', label: 'RisingWave', port: 4566, ssl: false },
];

function fieldOf(c: ConnectorDef, key: string) {
  return c.fields.find((f) => f.key === key);
}

async function main(): Promise<void> {
  // ── 1. The family ──────────────────────────────────────────────────────────

  ok('exports exactly 11 connectors', CONNECTORS.length === 11, CONNECTORS.length);

  const ids = CONNECTORS.map((c) => c.id);
  ok('ids are unique', new Set(ids).size === ids.length, ids);
  ok('every id is kebab-case', ids.every((i) => /^[a-z][a-z0-9-]*$/.test(i)), ids);
  ok(
    'every label is a non-empty string',
    CONNECTORS.every((c) => typeof c.label === 'string' && c.label.trim().length > 0),
  );
  ok('readOnly === true on all 11', CONNECTORS.every((c) => c.readOnly === true));
  ok("family === 'postgres' on all 11", CONNECTORS.every((c) => c.family === 'postgres'));
  ok(
    'category is one of the four allowed groups',
    CONNECTORS.every((c) => ['Databases', 'Cloud warehouses', 'Query engines', 'Files & local'].includes(c.category)),
  );
  ok(
    'listTables and run are functions on all 11',
    CONNECTORS.every((c) => typeof c.listTables === 'function' && typeof c.run === 'function'),
  );

  // ── 2. Per-vendor facts, one assertion each ────────────────────────────────

  for (const e of EXPECTED) {
    const c = CONNECTORS.find((x) => x.id === e.id);
    ok(`connector ${e.id} exists`, !!c);
    if (!c) continue;
    ok(`${e.id} label is "${e.label}"`, c.label === e.label, c.label);
    const port = fieldOf(c, 'port');
    ok(`${e.id} default port is ${e.port}`, !!port && port.default === e.port, port && port.default);
    const ssl = fieldOf(c, 'ssl');
    ok(`${e.id} TLS default is ${e.ssl}`, !!ssl && ssl.default === e.ssl, ssl && ssl.default);
  }

  // The four vendors whose endpoints are public by nature must ship TLS on.
  const tlsOn = CONNECTORS.filter((c) => fieldOf(c, 'ssl')?.default === true).map((c) => c.id).sort();
  ok(
    'TLS defaults on for exactly the cloud endpoints',
    JSON.stringify(tlsOn) === JSON.stringify(['alloydb', 'amazon-redshift', 'neon', 'supabase']),
    tlsOn,
  );

  // ── 3. Fields, and the one that matters most ───────────────────────────────

  for (const c of CONNECTORS) {
    for (const key of ['host', 'port', 'database', 'user']) {
      const f = fieldOf(c, key);
      ok(`${c.id} has a required '${key}' field`, !!f && f.required === true);
      ok(`${c.id} '${key}' is not marked secret`, !!f && f.secret !== true);
    }
    const pw = fieldOf(c, 'password');
    // A password on the connection record ends up in the project folder, which
    // is shareable. `secret: true` is what routes it to config.connectionSecrets
    // instead. This is the single most important assertion in the file.
    ok(`${c.id} password field is secret: true`, !!pw && pw.secret === true, pw);
    ok(`${c.id} password field type is 'password'`, !!pw && pw.type === 'password');
    const secretKeys = c.fields.filter((f) => f.secret === true).map((f) => f.key);
    ok(`${c.id} marks exactly one field secret`, JSON.stringify(secretKeys) === '["password"]', secretKeys);
    const insecure = fieldOf(c, 'sslInsecure');
    ok(`${c.id} certificate-trust escape hatch defaults OFF`, !!insecure && insecure.default === false);
    ok(
      `${c.id} certificate-trust escape hatch says what it gives up`,
      !!insecure && typeof insecure.help === 'string' && insecure.help.length > 40,
    );
  }

  // ── 4. TLS reaches the driver as verification-ON ───────────────────────────

  reset();
  await byId('neon').run(makeCtx({ values: { ssl: true, sslInsecure: false } }), 'select 1');
  ok(
    'ssl on → certificate verification stays ON',
    JSON.stringify(clients[0]?.config.ssl) === JSON.stringify({ rejectUnauthorized: true }),
    clients[0]?.config.ssl,
  );

  reset();
  await byId('neon').run(makeCtx({ values: { ssl: true, sslInsecure: true } }), 'select 1');
  ok(
    'explicit opt-in is the only way to stop verifying',
    JSON.stringify(clients[0]?.config.ssl) === JSON.stringify({ rejectUnauthorized: false }),
    clients[0]?.config.ssl,
  );

  reset();
  await byId('postgres').run(makeCtx({ values: { ssl: false } }), 'select 1');
  ok('ssl off → no TLS options at all', clients[0]?.config.ssl === undefined, clients[0]?.config.ssl);

  // ── 5. The row cap, and truncation reported rather than hidden ─────────────

  reset();
  // The server returns MORE rows than the cap allows: the driver must clip and
  // say so. (It asks for cap + 1 precisely so it can tell a clipped result from
  // an exact fit — asserted on the SQL below.)
  queryImpl = async (text) =>
    /^\s*set\b/i.test(text)
      ? {}
      : {
          fields: [{ name: 'n', dataTypeID: 23 }],
          rows: [[1], [2], [3], [4]],
        };
  let r = await byId('postgres').run(makeCtx({ rowLimit: 3 }), 'select n from big');
  ok('run succeeded', r.ok === true, r);
  if (r.ok) {
    ok('row cap is applied: never more than ctx.rowLimit rows', r.rows.length === 3, r.rows.length);
    ok('truncation is reported, not silent', r.truncated === true);
  }
  ok(
    'the wrapper is select * from ( … ) with a LIMIT bounded by rowLimit + 1',
    dataSql() === 'select * from (\nselect n from big\n) as _ord_wrap limit 4',
    dataSql(),
  );

  reset();
  queryImpl = async (text) =>
    /^\s*set\b/i.test(text) ? {} : { fields: [{ name: 'n', dataTypeID: 23 }], rows: [[1], [2]] };
  r = await byId('postgres').run(makeCtx({ rowLimit: 3 }), 'select n from small');
  ok('an under-cap result is not marked truncated', r.ok === true && r.truncated === false, r);

  reset();
  queryImpl = async (text) =>
    /^\s*set\b/i.test(text) ? {} : { fields: [{ name: 'n', dataTypeID: 23 }], rows: [[1], [2], [3]] };
  r = await byId('postgres').run(makeCtx({ rowLimit: 3 }), 'select n from exact');
  ok('an EXACT fit is not falsely reported as truncated', r.ok === true && r.truncated === false, r);
  ok('NV-12: the client keeps an error listener, so a peer-driven error cannot end the pod',
    clients[0]?.listenerCount('error') === 1, clients[0]?.listenerCount('error'));

  // NV-40: rows are counted as they arrive; past MAX_RESULT_BYTES the client is
  // ended (pg would buffer the rest) and what arrived comes back truncated.
  const { MAX_RESULT_BYTES } = require('../src/connectors/types') as typeof import('../src/connectors/types');
  const half = 'x'.repeat(MAX_RESULT_BYTES / 2 - 64);
  for (const [n, want] of [[4, true], [2, false]] as const) {
    reset();
    queryImpl = async (text) => (/^\s*set\b/i.test(text) ? {} : { fields: [{ name: 's', dataTypeID: 25 }], rows: Array(n).fill([half]) });
    r = await byId('postgres').run(makeCtx({ rowLimit: 100 }), 'select s from wide');
    ok(want ? 'past MAX_RESULT_BYTES: the rows under it, truncated, the client ended at once'
      : 'negative control: the same rows under the ceiling are whole',
    r.ok === true && r.rows.length === 2 && r.truncated === want && clients[0]?.ends === (want ? 2 : 1),
    r.ok === true ? `${r.rows.length} rows, truncated=${r.truncated}, ends=${clients[0]?.ends}` : r);
  }

  reset();
  await byId('postgres').run(makeCtx({ rowLimit: 5 }), 'select 1;   ');
  // T6.3: the data statement goes over the EXTENDED protocol — one statement,
  // so `select 1 ) x; commit; begin read write; delete …` cannot run — and a
  // trailing `--` comment cannot swallow the wrapper's LIMIT (own line).
  ok('the data statement is sent with queryMode extended (one statement per call)',
    clients.flatMap((c) => c.queries).filter((q) => /_ord_wrap/.test(q.text)).every((q) => q.mode === 'extended'));
  reset();
  await byId('postgres').run(makeCtx({ rowLimit: 5 }), 'select * from big ) x --');
  ok('a trailing -- comment ends at the newline; the LIMIT survives on its own line', /\n\) as _ord_wrap limit 6$/.test(dataSql()), dataSql());
  reset();
  await byId('postgres').run(makeCtx({ rowLimit: 5 }), 'select 1;   ');
  ok(
    'a trailing semicolon is stripped so it cannot end the statement before the LIMIT',
    dataSql() === 'select * from (\nselect 1\n) as _ord_wrap limit 6',
    dataSql(),
  );

  // ── 6. The timeout reaches the SERVER ──────────────────────────────────────

  reset();
  await byId('postgres').run(makeCtx({ timeoutMs: 12_000 }), 'select 1');
  const sets = allSql().filter((t) => /^set\b/i.test(t));
  const stmt = sets.find((t) => /statement_timeout/.test(t));
  ok('a server-side statement_timeout is issued', !!stmt, sets);
  const ms = stmt ? Number((/to\s+(\d+)/.exec(stmt) || [])[1]) : NaN;
  ok('statement_timeout is within ctx.timeoutMs', Number.isFinite(ms) && ms > 0 && ms <= 12_000, stmt);
  ok(
    'a JS-side query_timeout is also set as a backstop',
    clients[0]?.config.query_timeout === 12_000,
    clients[0]?.config.query_timeout,
  );
  ok(
    'the connect phase is bounded too',
    clients[0]?.config.connectionTimeoutMillis === 12_000,
    clients[0]?.config.connectionTimeoutMillis,
  );
  ok(
    'the session is asked to be read-only before anything runs',
    sets.some((t) => /default_transaction_read_only\s+to\s+on/i.test(t)),
    sets,
  );
  ok(
    'the read-only guard is issued BEFORE the data statement',
    allSql().findIndex((t) => /default_transaction_read_only/i.test(t)) < allSql().findIndex((t) => /_ord_wrap/.test(t)),
    allSql(),
  );

  // statement_timeout is NOT passed as a client option, because pg would put it
  // in the startup packet and a pgwire engine that does not know the GUC would
  // refuse the whole connection.
  ok(
    'statement_timeout is not smuggled into the startup packet',
    clients[0]?.config.statement_timeout === undefined,
    clients[0]?.config.statement_timeout,
  );

  reset();
  // An engine that rejects the SET must still work — that is the whole reason
  // it is a statement and not a startup parameter.
  queryImpl = async (text) => {
    if (/statement_timeout/.test(text)) throw new Error('unknown option: statement_timeout');
    if (/^\s*set\b/i.test(text)) return {};
    return { fields: [{ name: 'n', dataTypeID: 23 }], rows: [[1]] };
  };
  r = await byId('questdb').run(makeCtx(), 'select 1');
  ok('an engine that rejects SET statement_timeout still returns rows', r.ok === true, r);
  reset();
  queryImpl = async (text) => {
    if (/statement_timeout/.test(text)) throw new Error('unknown option: statement_timeout');
    return {};
  };
  r = await byId('postgres').run(makeCtx(), 'select 1');
  ok('but on real PostgreSQL a rejected SET is a loud error', r.ok === false, r);

  // ── 7. Identifiers: whitelist, quoting, and a hostile name ─────────────────

  reset();
  r = await byId('postgres').run(makeCtx({ rowLimit: 10 }), 'public.sales');
  ok(
    'a bare qualified table name is double-quoted, part by part',
    dataSql() === 'select * from "public"."sales" limit 11',
    dataSql(),
  );

  reset();
  r = await byId('postgres').run(makeCtx({ rowLimit: 10 }), 'sales');
  ok('an unqualified table name works too', dataSql() === 'select * from "sales" limit 11', dataSql());

  const HOSTILE = 'evil"; DROP TABLE x; --';
  reset();
  r = await byId('postgres').run(makeCtx(), HOSTILE);
  ok('a hostile identifier is rejected', r.ok === false && r.error === 'Invalid table name', r);
  // The strongest available statement: it did not merely fail to inject, it
  // never opened a socket at all.
  ok('a hostile identifier never opens a connection', clients.length === 0, clients.length);

  for (const bad of ['a.b.c', 'sales; drop table x', 'drop table sales', 'insert into t values (1)', '../etc/passwd']) {
    reset();
    r = await byId('postgres').run(makeCtx(), bad);
    ok(`rejected without connecting: ${JSON.stringify(bad)}`, r.ok === false && clients.length === 0, r);
  }

  reset();
  r = await byId('postgres').run(makeCtx(), '   ');
  ok('empty input is refused', r.ok === false && clients.length === 0, r);

  // A schema name is a VALUE, so it is bound — the hostile string must appear
  // in the parameter array and NOWHERE in the SQL text.
  reset();
  queryImpl = async () => ({ fields: [], rows: [] });
  await byId('postgres').listTables(makeCtx({ values: { schema: HOSTILE } }));
  const listQ = clients[0].queries.filter((q) => !/^\s*set\b/i.test(q.text));
  ok('the schema filter never appears in SQL text', !listQ.some((q) => q.text.includes('DROP TABLE')), listQ);
  ok(
    'the schema filter is bound as a parameter',
    listQ.some((q) => Array.isArray(q.values) && q.values.includes(HOSTILE)),
    listQ.map((q) => q.values),
  );

  reset();
  await byId('postgres').listTables(makeCtx({ values: { schema: '' } }));
  const noFilter = clients[0].queries.filter((q) => !/^\s*set\b/i.test(q.text));
  ok(
    'an empty schema filter binds null rather than building different SQL',
    noFilter.length === 1 && Array.isArray(noFilter[0].values) && noFilter[0].values[0] === null,
    noFilter.map((q) => q.values),
  );
  ok(
    'the table listing is itself bounded',
    noFilter.length === 1 && /limit\s+\d+\s*$/i.test(noFilter[0].text),
    noFilter[0]?.text,
  );
  ok(
    'the listing excludes catalog schemas',
    noFilter.length === 1 && /pg_catalog/.test(noFilter[0].text) && /information_schema'/.test(noFilter[0].text),
    noFilter[0]?.text,
  );

  // ── 8. Per-vendor listing differences ──────────────────────────────────────

  reset();
  queryImpl = async () => ({ fields: [], rows: [] });
  await byId('amazon-redshift').listTables(makeCtx());
  ok(
    'Redshift asks for external tables as well as information_schema',
    allSql().some((t) => /svv_external_tables/i.test(t)) && allSql().some((t) => /information_schema\.tables/i.test(t)),
    allSql(),
  );

  reset();
  // Redshift without permission on the SVV view must still list local tables.
  queryImpl = async (text) => {
    if (/svv_external_tables/i.test(text)) throw new Error('permission denied for relation svv_external_tables');
    if (/^\s*set\b/i.test(text)) return {};
    return { fields: [], rows: [['public', 'sales']] };
  };
  let t = await byId('amazon-redshift').listTables(makeCtx());
  ok(
    'Redshift falls back to plain information_schema when the SVV view is denied',
    t.ok === true && t.tables.length === 1 && t.tables[0].name === 'sales' && t.tables[0].schema === 'public',
    t,
  );

  reset();
  // QuestDB has no schemas; if its partial information_schema is missing, the
  // native `show tables` answers and the name is read POSITIONALLY.
  queryImpl = async (text) => {
    if (/information_schema/i.test(text)) throw new Error('table does not exist [table=information_schema.tables]');
    if (/^\s*set\b/i.test(text)) return {};
    return { fields: [{ name: 'table', dataTypeID: 25 }], rows: [['trades'], ['quotes']] };
  };
  t = await byId('questdb').listTables(makeCtx());
  ok(
    'QuestDB falls back to SHOW TABLES',
    t.ok === true && t.tables.length === 2 && t.tables[0].name === 'trades' && t.tables[0].schema === undefined,
    t,
  );

  reset();
  // All candidates failing must surface an error, never an empty table list —
  // "no tables" and "could not ask" are different answers.
  queryImpl = async (text) => {
    if (/^\s*set\b/i.test(text)) return {};
    throw new Error('relation does not exist');
  };
  t = await byId('questdb').listTables(makeCtx());
  ok('a total listing failure is an error, not an empty list', t.ok === false, t);

  // ── 9. Secrets never ride out in an error string ───────────────────────────

  reset();
  connectImpl = async () => {
    // Shaped like a real pg failure, which does carry connection detail.
    throw new Error(`connection to server at "db.example.com" (10.0.0.4), port 5432 failed: password ${PASSWORD} rejected`);
  };
  r = await byId('postgres').run(makeCtx(), 'select 1');
  ok('a failed connection is an error result, not a throw', r.ok === false, r);
  if (!r.ok) {
    ok('the password is not in the error string', !r.error.includes(PASSWORD), r.error);
    ok('it is replaced rather than dropped silently', r.error.includes('***'), r.error);
  }
  ok('the client is closed even when connect() threw', clients[0]?.ends === 1, clients[0]?.ends);

  reset();
  connectImpl = async () => {
    throw new Error('could not connect to postgres://reader:hunter2@db.example.com:5432/analytics');
  };
  r = await byId('postgres').run(makeCtx({ secrets: { password: 'unrelated' } }), 'select 1');
  ok(
    'credentials embedded in a DSN are redacted even when they are not the stored secret',
    !r.ok && !r.error.includes('hunter2') && r.error.includes('//***:***@'),
    !r.ok ? r.error : r,
  );

  reset();
  queryImpl = async (text) => {
    if (/^\s*set\b/i.test(text)) return {};
    throw new Error(`syntax error near "${PASSWORD}"`);
  };
  r = await byId('postgres').run(makeCtx(), 'select 1');
  ok('a query error is redacted too', !r.ok && !r.error.includes(PASSWORD), r);
  ok('the client is closed after a query error', clients[0]?.ends === 1, clients[0]?.ends);

  reset();
  queryImpl = async (text) =>
    /^\s*set\b/i.test(text) ? {} : { fields: [{ name: 'n', dataTypeID: 23 }], rows: [[1]] };
  await byId('postgres').run(makeCtx(), 'select 1');
  ok('the client is closed on the happy path', clients[0]?.ends === 1, clients[0]?.ends);

  reset();
  queryImpl = async () => ({ fields: [], rows: [] });
  await byId('postgres').listTables(makeCtx());
  ok('listTables closes its client too', clients[0]?.ends === 1, clients[0]?.ends);

  // ── 10. Values and column types crossing the bridge ────────────────────────

  reset();
  const when = new Date('2024-03-01T12:00:00.000Z');
  queryImpl = async (text) =>
    /^\s*set\b/i.test(text)
      ? {}
      : {
          fields: [
            { name: 'id', dataTypeID: 23 },
            { name: 'zip', dataTypeID: 25 },
            { name: 'ok', dataTypeID: 16 },
            { name: 'at', dataTypeID: 1114 },
            { name: 'doc', dataTypeID: 114 },
            { name: 'nothing', dataTypeID: 23 },
            { name: 'weird', dataTypeID: 999999 },
          ],
          rows: [[1, '007', true, when, { a: 1 }, null, 10n]],
        };
  r = await byId('postgres').run(makeCtx(), 'select * from mixed');
  ok('run returned rows', r.ok === true, r);
  if (r.ok) {
    ok('column names come through verbatim', r.columns.map((c) => c.name).join(',') === 'id,zip,ok,at,doc,nothing,weird');
    ok("OID 23 maps to the source's own type name", r.columns[0].type === 'int4', r.columns[0]);
    ok('OID 25 maps to text', r.columns[1].type === 'text', r.columns[1]);
    ok('an unknown OID is reported honestly, not guessed', r.columns[6].type === 'oid_999999', r.columns[6]);
    const row = r.rows[0];
    ok('a number stays a number', row[0] === 1);
    // The connector must NOT re-type; `007` is the reason the whole storage
    // layer keeps strings as strings.
    ok("'007' stays the string 007", Object.is(row[1], '007'), row[1]);
    ok('a boolean stays a boolean', row[2] === true);
    ok('a Date becomes an ISO string', row[3] === '2024-03-01T12:00:00.000Z', row[3]);
    ok('a structured value becomes JSON', row[4] === '{"a":1}', row[4]);
    ok('null stays null', Object.is(row[5], null), row[5]);
    ok('a bigint becomes a string rather than a lossy number', row[6] === '10', row[6]);
    ok(
      'every value is one of the four allowed kinds',
      row.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)),
      row,
    );
  }

  reset();
  queryImpl = async (text) => (/^\s*set\b/i.test(text) ? {} : {});
  r = await byId('postgres').run(makeCtx(), 'select 1');
  ok('a driver result with no fields/rows degrades to an empty table', r.ok === true && r.rows.length === 0, r);

  // ── 11. The port field actually drives the connection ──────────────────────

  reset();
  await byId('cockroachdb').run(makeCtx({ values: { port: undefined } }), 'select 1');
  ok(
    "a missing port falls back to the connector's own default",
    clients[0]?.config.port === 26257,
    clients[0]?.config.port,
  );

  reset();
  await byId('cockroachdb').run(makeCtx({ values: { port: '5432' } }), 'select 1');
  ok('a numeric string port is accepted', clients[0]?.config.port === 5432, clients[0]?.config.port);

  reset();
  await byId('cockroachdb').run(makeCtx({ values: { port: 'nonsense' } }), 'select 1');
  ok('a nonsense port falls back rather than reaching the driver', clients[0]?.config.port === 26257, clients[0]?.config.port);

  // ── 12. A table's facts (UNVERIFIED against a real server) ─────────────────
  //
  // The catalog queries are written from PostgreSQL's and Redshift's documentation, and answered here by a
  // recording fake that matches each statement by the catalog it names. What is pinned is THIS side of the
  // socket: a name is bound or refused before a socket, every statement is limited, a sub-read that fails
  // costs its field, Redshift is not asked what it does not have. A real server answers in test-pgFacts-db.

  const FAILS = (re: RegExp) => async (text: string): Promise<FakeResult> => { throw new Error(`function does not exist (${text.match(re)?.[0]})`); };
  /** Rows by catalog, first match wins; a `set` and anything unmatched answers nothing. */
  function catalog(rows: [RegExp, unknown[][]][], failing?: RegExp): typeof queryImpl {
    return async (text) => {
      if (failing?.test(text)) return FAILS(failing)(text);
      const hit = rows.find(([re]) => re.test(text));
      return { rows: hit ? hit[1] : [] };
    };
  }
  const PG_ROWS: [RegExp, unknown[][]][] = [
    [/pg_get_partkeydef/, [['RANGE (order_date)']]],
    [/pg_total_relation_size/, [['8192']]], // the partition tree's sum, or the relation alone
    [/pg_index/, [['orders_pkey', true, 'btree', 'line_id', 1, '1'], ['orders_region', false, 'hash', 'region', 3, '3']]],
    [/pg_constraint/, [['order_date', 2, '{2,1}'], ['line_id', 1, '{2,1}']]],
    [/information_schema\.columns/, [['line_id', 'bigint', 'NO'], ['region', 'text', 'YES']]],
    [/pg_attribute/, [['line_id', 'bigint', false, null], ['order_date', 'date', false, null], ['region', 'text', true, 'Discount in USD, after tax']]],
    [/obj_description/, [[16385, 'public', 'Orders', 1200]]],
  ];
  const RS_ROWS: [RegExp, unknown[][]][] = [[/svv_table_info/, [['KEY(customer_id)', 'order_date', 3, 1500]]], ...PG_ROWS];
  const sent = (): Recorded[] => clients.flatMap((c) => c.queries).filter((q) => !/^\s*set\b/i.test(q.text));
  const pg = byId('postgres');
  const rs = byId('amazon-redshift');
  const facts = async (c: ConnectorDef, t = 'public.orders', ctx = makeCtx()) => {
    const f = await c.tableFacts!(ctx, t);
    return f.ok ? f : null;
  };

  reset();
  queryImpl = catalog(PG_ROWS);
  let f = await facts(pg);
  ok('pg facts: comment, columns with types, nullability and comments, the estimate', f?.comment === 'Orders' && f.rowEstimate === 1200 && JSON.stringify(f.columns.map((c) => [c.name, c.type, c.nullable, c.comment ?? null])) ===
    '[["line_id","bigint",false,null],["order_date","date",false,null],["region","text",true,"Discount in USD, after tax"]]', JSON.stringify(f));
  ok('pg facts: the key is in its own order (not the table\'s), enforced, and flags its columns', JSON.stringify(f?.primaryKey) === '{"columns":["order_date","line_id"],"enforced":true}' && f?.columns.map((c) => !!c.key).join() === 'true,true,false', JSON.stringify(f?.primaryKey));
  ok('pg facts: indexes, partition and size', JSON.stringify([f?.indexes, f?.partition, f?.bytes]) ===
    '[[{"name":"orders_pkey","columns":["line_id"],"unique":true,"kind":"btree"},{"name":"orders_region","columns":["region"],"unique":false,"kind":"hash"}],{"columns":["order_date"],"method":"RANGE"},8192]', JSON.stringify(f));
  ok('pg facts: every statement is limited', sent().length >= 6 && sent().every((r) => /\blimit \d+\s*$/i.test(r.text.trim())), sent().map((r) => r.text.slice(-30)).join(' | '));
  ok('pg facts: the schema and name are bound (the oid after them), never text', sent()[0].values!.join() === 'public,orders' && sent().slice(1).every((r) => r.values!.length === 1 && /^\d+$/.test(String(r.values![0]))) && sent().every((r) => !r.text.includes('orders')), JSON.stringify(sent().map((r) => r.values)));
  ok('pg facts: an unqualified name binds a null schema', await (async () => { reset(); queryImpl = catalog(PG_ROWS); await facts(pg, 'orders'); return sent()[0].values!.join() === ',orders' && sent()[0].values![0] === null; })());

  reset();
  await pg.tableFacts!(makeCtx(), 'public.x"; drop table y; --');
  ok('pg facts: a hostile name is a bound value, never text', sent().length > 0 && sent().every((r) => !/drop table/i.test(r.text)) && sent()[0].values!.includes('x"; drop table y; --'));
  reset();
  const refusals = await Promise.all(['a.b.c', '', '.x', 'x.', '  '].map((n) => pg.tableFacts!(makeCtx(), n)));
  ok('pg facts: three parts, an empty part or no name are refused before a socket', refusals.every((r) => !r.ok && r.error === 'Invalid table name') && clients.length === 0);

  reset();
  queryImpl = catalog(PG_ROWS, /pg_get_partkeydef/);
  f = await facts(pg);
  ok('pg facts: a failing sub-read keeps the rest', f?.columns.length === 3 && !!f.primaryKey && !('partition' in f) && !!f.indexes && f.bytes === 8192 && f.comment === 'Orders', JSON.stringify(f));
  reset();
  queryImpl = catalog(PG_ROWS, /pg_constraint|pg_index|pg_total_relation_size/);
  f = await facts(pg);
  ok('pg facts: …whichever it is (no key, indexes or size)', f?.columns.length === 3 && !('primaryKey' in f) && !('indexes' in f) && !('bytes' in f) && f.partition?.method === 'RANGE', JSON.stringify(f));

  reset();
  queryImpl = catalog(PG_ROWS, /pg_partition_tree/);
  f = await facts(pg);
  ok('pg facts: before PostgreSQL 12 (no pg_partition_tree) the size is the relation\'s own', f?.bytes === 8192 && sent().filter((q) => /pg_total_relation_size/.test(q.text)).length === 2, JSON.stringify(f));
  reset();
  queryImpl = catalog(PG_ROWS, /pg_attribute a\s+where/);
  f = await facts(pg);
  ok('pg facts: columns fall back to information_schema, with no comments', f?.columns.map((c) => c.name).join() === 'line_id,region' && f.columns.every((c) => !('comment' in c)) && f.columns[0].nullable === false && f.columns[1].nullable === true, JSON.stringify(f));
  const fb = sent().find((q) => /information_schema\.columns/.test(q.text));
  ok('pg facts: …and the fallback is bound and limited too', !!fb && fb.values!.join() === 'public,orders' && /\blimit 2000\s*$/.test(fb.text.trim()), JSON.stringify(fb));
  reset();
  queryImpl = catalog(PG_ROWS, /obj_description/);
  f = await facts(pg);
  ok('pg facts: with no readable pg_class, the columns still come (information_schema only)', f?.columns.length === 2 && !('comment' in f) && !('primaryKey' in f) && !sent().some((q) => /pg_constraint|pg_index|pg_get_partkeydef/.test(q.text)), JSON.stringify(f));
  reset();
  queryImpl = catalog([]);
  const none = await pg.tableFacts!(makeCtx(), 'public.nothing');
  ok('pg facts: a table nothing knows is an error, as describeTable says it', !none.ok && none.error === 'No such table: nothing', JSON.stringify(none));
  reset();
  const slow = catalog(PG_ROWS);
  queryImpl = async (t) => { await new Promise((r) => setTimeout(r, 8)); return slow(t); };
  f = await facts(pg, 'public.orders', makeCtx({ timeoutMs: 1 }));
  ok('pg facts: past the budget (the default one reads them all, above) the optional reads are skipped, the columns are not', f?.columns.length === 3 && !('primaryKey' in f) && !sent().some((q) => /pg_constraint|pg_index|pg_get_partkeydef|pg_total_relation_size/.test(q.text)), JSON.stringify(f));
  ok('pg facts: the client is closed', clients.every((c) => c.ends === 1));

  // Redshift is not Postgres: informational keys, no partition key function, its own table view.
  reset();
  queryImpl = catalog(RS_ROWS);
  f = await facts(rs);
  ok('redshift: distribution, sort key and an informational key', JSON.stringify([f?.distribution, f?.sortKey, f?.primaryKey?.enforced]) === '[{"style":"KEY","columns":["customer_id"]},["order_date"],false]', JSON.stringify(f));
  ok('redshift: size from svv_table_info (1 MB blocks), the estimate from it too', f?.bytes === 3 * 1_048_576 && f.rowEstimate === 1500, JSON.stringify(f));
  ok('redshift: it is never asked for what it lacks (partition key, pg_index, relation size)', !sent().some((q) => /pg_get_partkeydef|pg_index|pg_total_relation_size/.test(q.text)) && !('partition' in f!) && !('indexes' in f!));
  ok('redshift: the table view is read by bound schema and name', ((q) => !!q && q.values!.join() === 'public,orders' && /\blimit \d+\s*$/.test(q.text.trim()))(sent().find((x) => /svv_table_info/.test(x.text))));
  reset();
  queryImpl = catalog(PG_ROWS); // svv_table_info leaves out empty tables: no row
  f = await facts(rs);
  ok('redshift: an empty table (no svv row) keeps everything else, with no error', f?.columns.length === 3 && !!f.primaryKey && !('distribution' in f) && !('sortKey' in f) && f.rowEstimate === 1200, JSON.stringify(f));
  reset();
  queryImpl = catalog([[/svv_table_info/, [['AUTO(ALL)', '', 0, 0]]], ...PG_ROWS]);
  f = await facts(rs);
  ok('redshift: AUTO(ALL) names no column, and an empty sort key is none', JSON.stringify(f?.distribution) === '{"style":"AUTO(ALL)","columns":[]}' && !('sortKey' in f!), JSON.stringify(f));
  reset();
  queryImpl = catalog(RS_ROWS);
  await facts(pg);
  ok('NEGATIVE CONTROL: PostgreSQL itself is asked for the partition key, indexes and relation size, and not for svv_table_info', ['pg_get_partkeydef', 'pg_index', 'pg_total_relation_size'].every((w) => sent().some((q) => q.text.includes(w))) && !sent().some((q) => /svv_table_info/.test(q.text)));

  // The pgwire engines keep whatever answers (UNVERIFIED: none of them was asked).
  ok('every pgwire variant has tableFacts', CONNECTORS.every((d) => typeof d.tableFacts === 'function'));
  reset();
  queryImpl = catalog(PG_ROWS, /pg_attribute|pg_class/);
  f = await facts(byId('questdb'));
  ok('pgwire: an engine with neither pg_attribute nor pg_class still gives its columns', f?.columns.length === 2, JSON.stringify(f));

  const { parsePartitionKey, parseDistribution }: typeof import('../src/connectors/pgFacts') = require('../src/connectors/pgFacts');
  ok('partition key: method and columns, a quoted name unquoted, an expression kept whole', JSON.stringify([parsePartitionKey('RANGE (order_date)'), parsePartitionKey('HASH ("Mixed ""Case""", b)'), parsePartitionKey("LIST (date_trunc('day', ts), region)")]) ===
    JSON.stringify([{ columns: ['order_date'], method: 'RANGE' }, { columns: ['Mixed "Case"', 'b'], method: 'HASH' }, { columns: ["date_trunc('day', ts)", 'region'], method: 'LIST' }]));
  ok('partition key: nothing (not partitioned, or not a key) is none', parsePartitionKey('') === undefined && parsePartitionKey('garbage') === undefined && parsePartitionKey('RANGE ()') === undefined);
  ok('distribution: EVEN, ALL, KEY(col), a quoted column and the AUTO forms', JSON.stringify(['EVEN', 'all', 'KEY(customer_id)', 'KEY("cust id")', 'AUTO(KEY(customer_id))', 'AUTO(EVEN)'].map(parseDistribution)) ===
    '[{"style":"EVEN","columns":[]},{"style":"ALL","columns":[]},{"style":"KEY","columns":["customer_id"]},{"style":"KEY","columns":["cust id"]},{"style":"AUTO(KEY)","columns":["customer_id"]},{"style":"AUTO(EVEN)","columns":[]}]');
  ok('distribution: text it does not know is none', parseDistribution('') === undefined && parseDistribution('ROUND_ROBIN') === undefined);

  // ── done ───────────────────────────────────────────────────────────────────

  if (failureCount() > 0) {
    console.error(`\n${failureCount()} failing assertion(s)`);
    process.exit(1);
  }
  console.log('\nall connectors/postgres checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
