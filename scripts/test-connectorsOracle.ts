// Self-check for src/connectors/oracle.ts (Oracle Database / Autonomous).
//
// WHAT THIS CANNOT TEST: there is no Oracle server here. Nothing below proves a
// generated statement parses on a real database, that an Easy Connect string
// resolves, that a TLS-enabled Autonomous endpoint accepts us, or — the big one
// — that wallet (mutual TLS) authentication works: `walletLocation` /
// `walletPassword` are passed through to the driver and asserted to be present,
// which is NOT the same as having connected to a wallet-only ADB.
//
// WHAT IT DOES TEST: the real connector code end to end against a FAKE
// `oracledb` (swapped in via Module._load) that records the connection
// attributes, the callTimeout, the SQL and the binds, and honours maxRows the
// way the real driver does. Plus the one assertion that would otherwise only
// fail on a user's machine: the real `oracledb` is in Thin mode and this source
// never calls initOracleClient().

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { byCatalog, recorder, refusing, type Answer } from './factsHarness';

const path: typeof import('path') = require('path');
const fs: typeof import('fs') = require('fs');
const Module: { _load(request: string, ...rest: unknown[]): unknown } = require('module');

// ── the assertion that matters most, made against the REAL driver ─────────────
// Done BEFORE the fake is installed: Thin mode is why this connector can ship
// at all (no Oracle Instant Client on the user's machine). If this ever flips,
// every user gets DPI-1047 at connect time and no unit test would notice.
{
  const realOracle = require('oracledb') as { thin?: boolean; initOracleClient?: unknown };
  ok('the REAL oracledb reports Thin mode (thin === true)', realOracle.thin === true, realOracle.thin);
  ok('initOracleClient exists on the driver — which is exactly why we must not call it',
    typeof realOracle.initOracleClient === 'function');
}

// ── the fake oracledb driver ──────────────────────────────────────────────────

interface FakeState {
  lastAttrs: Record<string, unknown> | null;
  lastSql: string;
  lastBinds: unknown[];
  lastOptions: { outFormat?: number; resultSet?: boolean; fetchTypeHandler?: (m: unknown) => unknown } | null;
  callTimeout: number;
  rowsAvailable: number;
  connectError: Error | null;
  executeError: Error | null;
  closed: boolean;
  /** Rows handed out by getRows, and whether the result set was closed. */
  fetched: number;
  rsClosed: boolean;
  /** The NAME cell of every row, when set (a byte-budget check). */
  cell: string | null;
  /** How long each execute takes, and the callTimeout each one ran under, in order. */
  delayMs: number;
  timeouts: number[];
}

const state: FakeState = {
  lastAttrs: null,
  lastSql: '',
  lastBinds: [],
  lastOptions: null,
  callTimeout: -1,
  rowsAvailable: 0,
  connectError: null,
  executeError: null,
  closed: false,
  fetched: 0,
  rsClosed: false,
  cell: null,
  delayMs: 0,
  timeouts: [],
};

function resetState(): void {
  state.lastAttrs = null;
  state.lastSql = '';
  state.lastBinds = [];
  state.lastOptions = null;
  state.callTimeout = -1;
  state.rowsAvailable = 0;
  state.connectError = null;
  state.executeError = null;
  state.closed = false;
  state.fetched = 0;
  state.rsClosed = false;
  state.cell = null;
  state.delayMs = 0;
  state.timeouts = [];
}

const fakeConnection = {
  get callTimeout(): number {
    return state.callTimeout;
  },
  set callTimeout(v: number) {
    state.callTimeout = v;
  },
  async execute(
    sql: string,
    binds: unknown[],
    options: { outFormat?: number; resultSet?: boolean; fetchTypeHandler?: (m: unknown) => unknown },
  ) {
    state.lastSql = sql;
    state.lastBinds = binds;
    state.lastOptions = options;
    state.timeouts.push(state.callTimeout);
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.executeError) throw state.executeError;
    // A result set, as the real driver returns one: rows only as getRows asks,
    // so the client-side half of the cap is what stops the read.
    return {
      resultSet: {
        metaData: [
          { name: 'ID', dbTypeName: 'NUMBER' },
          { name: 'NAME', dbTypeName: 'VARCHAR2' },
        ],
        async getRows(n: number): Promise<unknown[][]> {
          const rows: unknown[][] = [];
          for (; rows.length < n && state.fetched < state.rowsAvailable; state.fetched++) rows.push([state.fetched, state.cell ?? 'n' + state.fetched]);
          return rows;
        },
        async close(): Promise<void> {
          state.rsClosed = true;
        },
      },
    };
  },
  async close(): Promise<void> {
    state.closed = true;
  },
};

const fakeOracledb = {
  thin: true,
  OUT_FORMAT_ARRAY: 4001,
  DB_TYPE_CLOB: { name: 'DB_TYPE_CLOB' },
  STRING: { name: 'DB_TYPE_VARCHAR' },
  async getConnection(attrs: Record<string, unknown>): Promise<typeof fakeConnection> {
    state.lastAttrs = attrs;
    if (state.connectError) throw state.connectError;
    return fakeConnection;
  },
};

const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]): unknown {
  if (request === 'oracledb') return fakeOracledb;
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled sibling of the .ts source.
const oracle: typeof import('../src/connectors/oracle') = require('../src/connectors/oracle');
const oracleFacts: typeof import('../src/connectors/oracleFacts') = require('../src/connectors/oracleFacts');

type ConnectorContext = import('../src/connectors/types').ConnectorContext;
type ConnectorDef = import('../src/connectors/types').ConnectorDef;

function ctxFor(over?: Partial<ConnectorContext>): ConnectorContext {
  return {
    values: { host: 'db.example.com', port: 1521, serviceName: 'ORCLPDB1', user: 'reader' },
    secrets: { password: 'sup3r-s3cret-pw' },
    rowLimit: 10,
    timeoutMs: 30_000,
    ...over,
  };
}

function byId(id: string): ConnectorDef {
  const d = oracle.CONNECTORS.find((c) => c.id === id);
  if (!d) throw new Error('missing connector ' + id);
  return d;
}

async function main(): Promise<void> {
  // ── shape ──────────────────────────────────────────────────────────────────
  const ids = oracle.CONNECTORS.map((c) => c.id);
  ok('two connectors', oracle.CONNECTORS.length === 2, ids.join(','));
  ok('ids are exactly oracle/oracle-autonomous', ids.join(',') === 'oracle,oracle-autonomous', ids.join(','));
  ok('ids are unique', new Set(ids).size === ids.length);
  ok('every connector is readOnly', oracle.CONNECTORS.every((c) => c.readOnly === true));
  ok('every connector is family oracle', oracle.CONNECTORS.every((c) => c.family === 'oracle'));
  ok('CONNECTORS and the lowercase alias are the same array', oracle.connectors === oracle.CONNECTORS);

  const port = byId('oracle').fields.find((f) => f.key === 'port');
  ok('Oracle Database defaults to port 1521', !!port && port.default === 1521, port && port.default);
  ok('the default port constant is 1521', oracle.__testing.DEFAULT_PORT === 1521);
  ok('Oracle Database offers host/port/serviceName rather than a hand-built DSN',
    ['host', 'port', 'serviceName'].every((k) => byId('oracle').fields.some((f) => f.key === k)));
  // Autonomous is reached with the console's ready-made TLS connect string, so
  // it has no port field of its own — the port lives inside that string.
  ok('Autonomous takes a connect string instead of host/port',
    byId('oracle-autonomous').fields.some((f) => f.key === 'connectString' && f.required === true) &&
    !byId('oracle-autonomous').fields.some((f) => f.key === 'port'));

  for (const c of oracle.CONNECTORS) {
    const pw = c.fields.find((f) => f.key === 'password');
    ok(`${c.id} marks password secret:true`, !!pw && pw.secret === true && pw.type === 'password');
    ok(`${c.id} marks every credential field secret`,
      c.fields.every((f) => f.type !== 'password' || f.secret === true));
    ok(`${c.id} never marks a non-credential field secret`,
      c.fields.every((f) => !f.secret || f.type === 'password'));
  }

  // ── initOracleClient must never appear (Thick mode = an install we don't ship)
  const srcTs = fs.readFileSync(path.join(__dirname, '..', 'src', 'connectors', 'oracle.ts'), 'utf8');
  const srcJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'connectors', 'oracle.js'), 'utf8');
  const CALL_RE = /initOracleClient\s*\(/;
  ok('oracle.ts never CALLS initOracleClient', !CALL_RE.test(srcTs),
    (srcTs.match(/.*initOracleClient.*/g) || []).join(' | '));
  ok('the compiled oracle.js never CALLS initOracleClient', !CALL_RE.test(srcJs));
  // Belt to the regex's braces: the identifier may appear ONLY in a comment.
  // A future `const f = oracledb.initOracleClient; f();` would evade CALL_RE but
  // not this.
  const codeMentions = (src: string): string[] =>
    src.split('\n').filter((l) => l.includes('initOracleClient') && !/^\s*(\/\/|\*|\/\*)/.test(l));
  ok('oracle.ts mentions initOracleClient only in comments', codeMentions(srcTs).length === 0, codeMentions(srcTs).join(' | '));
  ok('the compiled oracle.js mentions initOracleClient only in comments',
    codeMentions(srcJs).length === 0, codeMentions(srcJs).join(' | '));
  ok('oracle.ts explains WHY initOracleClient is forbidden', /Thin mode|Instant Client/.test(srcTs));
  ok('the connector sees Thin mode through its own loader', oracle.loadOracle().thin === true);

  // ── connect attributes ─────────────────────────────────────────────────────
  const V = oracle.__testing.VARIANTS;
  const plainDb = V[0];
  const adb = V[1];

  const attrs = oracle.buildConnAttrs(plainDb, ctxFor()) as unknown as Record<string, unknown>;
  ok('connectString is host:port/serviceName', attrs.connectString === 'db.example.com:1521/ORCLPDB1', attrs.connectString);
  ok('a missing port falls back to 1521',
    oracle.buildConnectString(plainDb, { host: 'h', serviceName: 's' }) === 'h:1521/s',
    oracle.buildConnectString(plainDb, { host: 'h', serviceName: 's' }));
  ok('the password comes from ctx.secrets', attrs.password === 'sup3r-s3cret-pw');
  // connectTimeout is in SECONDS for oracledb (sessionAtts multiplies by 1000);
  // callTimeout below is in milliseconds. Getting this backwards is a 1000x bug.
  ok('connectTimeout is ctx.timeoutMs converted to seconds', attrs.connectTimeout === 30, attrs.connectTimeout);
  ok('a sub-second timeout still yields at least 1s (0 means "no timeout")',
    (oracle.buildConnAttrs(plainDb, ctxFor({ timeoutMs: 200 })) as unknown as Record<string, unknown>).connectTimeout === 1);
  ok('a plain Oracle connection never sends wallet attributes',
    attrs.walletLocation === undefined && attrs.walletPassword === undefined);

  const adbCtx = ctxFor({
    values: { connectString: 'tcps://adb.example.oraclecloud.com:1522/abc_high.adb.oraclecloud.com' },
  });
  const adbAttrs = oracle.buildConnAttrs(adb, adbCtx) as unknown as Record<string, unknown>;
  ok('Autonomous uses the pasted connect string verbatim',
    adbAttrs.connectString === 'tcps://adb.example.oraclecloud.com:1522/abc_high.adb.oraclecloud.com', adbAttrs.connectString);
  ok('Autonomous sends no wallet attributes when no wallet is configured',
    adbAttrs.walletLocation === undefined && adbAttrs.walletPassword === undefined);

  const walletAttrs = oracle.buildConnAttrs(adb, {
    values: { connectString: 'tcps://x:1522/y', walletLocation: '/Users/me/wallet' },
    secrets: { password: 'pw', walletPassword: 'wpw' },
    rowLimit: 10,
    timeoutMs: 30_000,
  }) as unknown as Record<string, unknown>;
  ok('a configured wallet is passed through to the driver',
    walletAttrs.walletLocation === '/Users/me/wallet' && walletAttrs.walletPassword === 'wpw',
    JSON.stringify(walletAttrs));
  ok('the wallet field says Thin mode needs ewallet.pem, not cwallet.sso',
    /ewallet\.pem/.test(String(byId('oracle-autonomous').fields.find((f) => f.key === 'walletLocation')?.help)));

  // ── the row cap wrapper ────────────────────────────────────────────────────
  const plain = oracle.capOracle('select * from sales', 100);
  ok('plain query is wrapped with FETCH FIRST n ROWS ONLY',
    plain === 'SELECT * FROM ( select * from sales ) FETCH FIRST 100 ROWS ONLY', plain);
  ok('the Oracle cap never emits LIMIT or TOP', !/\bLIMIT\b|\bTOP\s*\(/i.test(plain));
  ok('the Oracle cap does not fall back to ROWNUM', !/ROWNUM/i.test(plain));

  const ordered = oracle.capOracle('select * from sales order by amount desc', 50);
  ok('Oracle CAN wrap an ordered query (unlike T-SQL) and does',
    /^SELECT \* FROM \( select \* from sales order by amount desc \) FETCH FIRST 50 ROWS ONLY$/.test(ordered), ordered);

  const cte = oracle.capOracle('with t as (select 1 a from dual) select * from t', 7);
  ok('a CTE gets the clause appended rather than wrapped',
    cte === 'with t as (select 1 a from dual) select * from t FETCH FIRST 7 ROWS ONLY', cte);

  const paged = oracle.capOracle('select * from sales offset 10 rows fetch next 5 rows only', 9);
  ok('a query that already pages itself is left alone', !/FETCH FIRST 9/.test(paged), paged);

  ok('a trailing semicolon is stripped before wrapping', !/;/.test(oracle.capOracle('select 1 from dual;', 3)));

  // ── read-only guard ────────────────────────────────────────────────────────
  const ora = byId('oracle');
  const writes = [
    'delete from sales',
    'update sales set a = 1',
    'insert into sales values (1)',
    'drop table sales',
    'truncate table sales',
    'begin my_proc(); end;',
    'select * from sales for update',
    'select 1 from dual; drop table sales',
  ];
  for (const w of writes) {
    const r = await ora.run(ctxFor(), w);
    ok('rejects: ' + w, r.ok === false, r.ok === false ? r.error : 'ACCEPTED');
  }

  // ── running, capping ───────────────────────────────────────────────────────
  resetState();
  state.rowsAvailable = 1000;
  const capped = await ora.run(ctxFor({ rowLimit: 4 }), 'select * from sales');
  ok('run succeeded', capped.ok === true, capped.ok === false ? capped.error : '');
  if (capped.ok) {
    ok('keeps exactly ctx.rowLimit rows', capped.rows.length === 4, capped.rows.length);
    ok('reports truncated:true when the cap clips', capped.truncated === true);
    ok('columns carry the source type verbatim',
      capped.columns.length === 2 && capped.columns[0].name === 'ID' && capped.columns[0].type === 'NUMBER' &&
      capped.columns[1].type === 'VARCHAR2', JSON.stringify(capped.columns));
    ok('values are positional scalars', capped.rows[0][0] === 0 && capped.rows[0][1] === 'n0');
  }
  ok('the server-side cap asked for rowLimit + 1', /FETCH FIRST 5 ROWS ONLY/.test(state.lastSql), state.lastSql);
  ok('the result set is read client-side, one batch at most, and closed',
    state.lastOptions?.resultSet === true && state.fetched <= 1000 && state.rsClosed === true, state.fetched);
  ok('rows are fetched positionally (OUT_FORMAT_ARRAY)', state.lastOptions?.outFormat === 4001);
  ok('callTimeout is set from ctx.timeoutMs, in milliseconds', state.callTimeout === 30_000, state.callTimeout);
  ok('the connection was closed', state.closed === true);

  resetState();
  state.rowsAvailable = 3;
  const short = await ora.run(ctxFor({ rowLimit: 10 }), 'select * from sales');
  ok('a result inside the cap is not truncated', short.ok === true && short.truncated === false);
  ok('a result inside the cap keeps every row', short.ok === true && short.rows.length === 3);

  resetState();
  state.rowsAvailable = 5;
  const exact = await ora.run(ctxFor({ rowLimit: 5 }), 'select * from sales');
  ok('exactly-at-the-cap keeps 5 rows and is NOT truncated',
    exact.ok === true && exact.rows.length === 5 && exact.truncated === false);

  // NV-40: past MAX_RESULT_BYTES of cell text the read stops, truncated, like the row cap.
  const { MAX_RESULT_BYTES } = require('../src/connectors/types') as typeof import('../src/connectors/types');
  resetState();
  state.rowsAvailable = 10;
  state.cell = 'x'.repeat(MAX_RESULT_BYTES / 2 - 64);
  const heavy = await ora.run(ctxFor({ rowLimit: 100 }), 'select * from sales');
  ok('a result past MAX_RESULT_BYTES keeps the rows under it and says truncated',
    heavy.ok === true && heavy.rows.length === 2 && heavy.truncated === true && state.rsClosed === true,
    heavy.ok === true ? `${heavy.rows.length} rows, truncated=${heavy.truncated}` : heavy.error);
  resetState();
  state.rowsAvailable = 2;
  state.cell = 'x'.repeat(MAX_RESULT_BYTES / 2 - 64);
  const fits = await ora.run(ctxFor({ rowLimit: 100 }), 'select * from sales');
  ok('negative control: the same rows under the ceiling are whole', fits.ok === true && fits.rows.length === 2 && fits.truncated === false);

  resetState();
  state.rowsAvailable = 0;
  const none = await ora.run(ctxFor(), 'select * from sales');
  ok('an empty result still returns columns', none.ok === true && none.rows.length === 0 && none.columns.length === 2);

  // A CLOB column would otherwise arrive as a Lob stream object.
  const handler = state.lastOptions?.fetchTypeHandler;
  ok('a fetchTypeHandler is supplied', typeof handler === 'function');
  if (typeof handler === 'function') {
    ok('CLOB is fetched as a string', JSON.stringify(handler({ name: 'C', dbTypeName: 'CLOB' })) ===
      JSON.stringify({ type: { name: 'DB_TYPE_VARCHAR' } }));
    ok('other types are left alone', handler({ name: 'N', dbTypeName: 'NUMBER' }) === undefined);
  }

  // ── listTables ─────────────────────────────────────────────────────────────
  resetState();
  state.rowsAvailable = 2;
  const tables = await ora.listTables(ctxFor());
  ok('listTables succeeded', tables.ok === true, tables.ok === false ? tables.error : '');
  ok('listTables reads ALL_TABLES', /all_tables/i.test(state.lastSql), state.lastSql);
  ok('listTables uses a bind variable (:1) for the row cap', /FETCH FIRST :1 ROWS ONLY/.test(state.lastSql), state.lastSql);
  ok('the bind value is supplied positionally', state.lastBinds.length === 1 && state.lastBinds[0] === 1000,
    JSON.stringify(state.lastBinds));
  ok('listTables excludes Oracle-maintained schemas', /oracle_maintained/i.test(state.lastSql));
  ok('listTables returns {schema,name}',
    tables.ok === true && tables.tables.length === 2 && tables.tables[0].name === 'n0');

  // ── identifier quoting + Oracle case folding ───────────────────────────────
  const evil = 'evil"; DROP TABLE x; --';
  ok('an injection attempt fails the identifier whitelist', oracle.isSafeIdent(evil) === false);
  ok('quoting doubles the embedded quote so it stays ONE identifier',
    oracle.quoteIdent(evil) === '"evil""; DROP TABLE x; --"', oracle.quoteIdent(evil));
  ok('the quoted form has no unbalanced quote', (oracle.quoteIdent(evil).match(/"/g) || []).length % 2 === 0);
  ok('a normal identifier passes', oracle.isSafeIdent('SALES_2024'));
  ok('an identifier may not start with a digit or underscore (Oracle rule)',
    oracle.isSafeIdent('2sales') === false && oracle.isSafeIdent('_sales') === false);
  // The thing that makes a user's table "not found": unquoted DDL created SALES.
  ok('folding upper-cases an unquoted name the way Oracle does',
    oracle.quoteIdentFolded('sales') === '"SALES"', oracle.quoteIdentFolded('sales'));
  ok('the source documents the UPPERCASE folding rule', /UPPERCASE/.test(srcTs));

  // ── errors ─────────────────────────────────────────────────────────────────
  resetState();
  state.connectError = new Error('ORA-01017: invalid credential (user reader / sup3r-s3cret-pw)');
  const failed = await ora.run(ctxFor(), 'select 1 from dual');
  ok('a connect failure is returned, not thrown', failed.ok === false);
  ok('safeError redacts the password from a driver error',
    failed.ok === false && !failed.error.includes('sup3r-s3cret-pw') && failed.error.includes('***'),
    failed.ok === false ? failed.error : '');

  resetState();
  state.executeError = new Error('ORA-00942 at oracle://reader:sup3r-s3cret-pw@db.example.com:1521/ORCLPDB1');
  const execFailed = await ora.run(ctxFor(), 'select 1 from dual');
  ok('an execute failure is returned, not thrown', execFailed.ok === false);
  ok('safeError redacts a DSN embedded in an execute error',
    execFailed.ok === false && !execFailed.error.includes('sup3r-s3cret-pw'),
    execFailed.ok === false ? execFailed.error : '');
  ok('the connection is closed even when execute throws', state.closed === true);

  resetState();
  const empty = await ora.run(ctxFor(), '   ');
  ok('an empty query is rejected before connecting', empty.ok === false && state.lastAttrs === null);

  // ── a table's facts ────────────────────────────────────────────────────────
  //
  // UNVERIFIED: every statement is written from the Oracle documentation; no database answered it. A fixture
  // answers by dictionary view, and what is pinned is THIS side of the socket: a name is bound or refused before
  // a connection, the verbatim spelling is tried before the upper-case one, every statement ends in
  // FETCH FIRST :n ROWS ONLY, a refused view costs its field and only ALL_TAB_COLUMNS fails the read.

  const CATALOG = byCatalog([
    [/all_tab_comments/i, [['Orders']]],
    [/all_col_comments/i, [['REGION', 'Sales region']]],
    [/all_constraints/i, [['LINE_ID', 1, 'DISABLED', 'SYS_C0011']]],
    [/all_indexes/i, [['SYS_C0011', 'UNIQUE', 'NORMAL', 'LINE_ID', 1], ['ORDERS_REGION', 'NONUNIQUE', 'BITMAP', 'REGION', 1], ['ORDERS_RD', 'UNIQUE', 'NORMAL', 'REGION', 1], ['ORDERS_RD', 'UNIQUE', 'NORMAL', 'ORDER_DATE', 2]]],
    [/all_part_tables/i, [['LIST', 'REGION', 1]]],
    [/\ball_tables\b/i, [[1200, '2024-05-01T12:00:00.000Z']]],
  ]);
  // The columns exist under the upper-case spelling only, as a table made with an unquoted `create table orders` does.
  const UPPER_ONLY: Answer = (sql, params) => /all_tab_columns/i.test(sql)
    ? (params[0] === 'ORDERS' ? [['LINE_ID', 'NUMBER', 'N', 'SHOP'], ['REGION', 'VARCHAR2', 'Y', 'SHOP'], ['ORDER_DATE', 'DATE', 'N', 'SHOP']] : [])
    : CATALOG(sql, params);
  const readFacts = async (answer = UPPER_ONLY, name = 'shop.orders') => {
    const h = recorder(answer);
    return { h, r: await oracleFacts.oracleTableFacts(name, h.open) };
  };

  let o = await readFacts();
  const of = o.r.ok ? o.r : null;
  ok('oracle facts: verbatim first, then upper case, then the upper-case pair for every later statement',
    o.h.rec[0].params[0] === 'orders' && o.h.rec[0].params[1] === 'shop' && o.h.rec[1].params[0] === 'ORDERS' && o.h.rec[1].params[1] === 'SHOP'
    && o.h.rec.slice(2).every((x) => x.params[0] === 'ORDERS' && x.params[1] === 'SHOP'), JSON.stringify(o.h.rec.map((x) => x.params)));
  ok('oracle facts: every statement fetches first n rows', o.h.rec.length === 8 && o.h.rec.every((x) => /fetch first :3 rows only\s*$/i.test(x.sql.trim()) && typeof x.params[2] === 'number'), o.h.rec.map((x) => x.sql.trim().slice(-26)).join(' | '));
  ok('oracle facts: no statement holds the name or the owner as text', o.h.rec.every((x) => !/orders|shop/i.test(x.sql.replace(/all_\w+|\borders_\w+/gi, ''))));
  ok('oracle facts: columns, types and nullability', JSON.stringify(of?.columns.map((c) => [c.name, c.type, c.nullable])) === '[["LINE_ID","NUMBER",false],["REGION","VARCHAR2",true],["ORDER_DATE","DATE",false]]', JSON.stringify(of?.columns));
  ok('oracle facts: the table and column comments', of?.comment === 'Orders' && JSON.stringify(of.columns.map((c) => c.comment ?? null)) === '[null,"Sales region",null]', JSON.stringify(of?.columns));
  ok('oracle facts: a disabled key is not enforced', JSON.stringify(of?.primaryKey) === '{"columns":["LINE_ID"],"enforced":false}' && of?.columns[0].key === true, JSON.stringify(of?.primaryKey));
  ok('oracle facts: indexes keep uniqueness and type, without the index that backs the key', JSON.stringify(of?.indexes) ===
    '[{"name":"ORDERS_REGION","columns":["REGION"],"unique":false,"kind":"BITMAP"},{"name":"ORDERS_RD","columns":["REGION","ORDER_DATE"],"unique":true,"kind":"NORMAL"}]', JSON.stringify(of?.indexes));
  ok('oracle facts: list partitioning', JSON.stringify(of?.partition) === '{"columns":["REGION"],"method":"LIST"}', JSON.stringify(of?.partition));
  ok('oracle facts: the estimate, and no size and no date (last_analyzed is when statistics ran, not a change)', JSON.stringify([of?.rowEstimate, of && 'lastModified' in of, of && 'bytes' in of]) === '[1200,false,false]', JSON.stringify(of));
  ok('oracle facts: one connection, asked for once', o.h.opened() === 1);

  o = await readFacts(UPPER_ONLY, 'SHOP.ORDERS');
  ok('oracle facts: a name already in upper case is not read twice', o.h.rec.filter((x) => /all_tab_columns/i.test(x.sql)).length === 1 && o.r.ok);
  o = await readFacts((sql, params) => /all_tab_columns/i.test(sql) ? [['ID', 'NUMBER', 'N', 'SHOP']] : CATALOG(sql, params), 'orders');
  ok('oracle facts: a lower-case table that exists wins and the retry never happens', o.h.rec[0].params[0] === 'orders' && o.h.rec[0].params[1] === null && o.h.rec[1].params[0] === 'orders' && o.h.rec[1].params[1] === 'SHOP'
    && o.h.rec.filter((x) => /all_tab_columns/i.test(x.sql)).length === 1, JSON.stringify(o.h.rec.map((x) => x.params)));
  o = await readFacts((sql, params) => /all_tab_columns/i.test(sql) ? [['ID', 'NUMBER', 'N', 'A'], ['ID', 'NUMBER', 'N', 'B']] : CATALOG(sql, params), 'orders');
  ok('oracle facts: with no owner named, the first owner\'s table is the one read', o.r.ok && o.r.columns.length === 1 && o.h.rec.slice(1).every((x) => x.params[1] === 'A'));

  o = await readFacts(UPPER_ONLY, "shop.x'; drop table y; --");
  ok('oracle facts: a hostile name is a bound value, never text', o.h.rec.length > 0 && o.h.rec.every((x) => !/drop table/i.test(x.sql)) && o.h.rec[0].params[0] === "x'; drop table y; --");
  const orefused = [];
  for (const bad of ['a.b.c', '', '.x', 'x.', '  ']) {
    const g = await readFacts(UPPER_ONLY, bad);
    orefused.push(g.h.opened() === 0 && !g.r.ok && g.r.error === 'Invalid table name');
  }
  ok('oracle facts: three parts, an empty part or no name never open a connection', orefused.every(Boolean), orefused.join());

  // A refused view costs the fields it feeds and nothing else: the keys of the reply are the full reply's minus those.
  const FULL = Object.keys(of ?? {});
  for (const [view, dropped] of [
    [/all_tab_comments/i, ['comment']], [/all_constraints/i, ['primaryKey']], [/all_indexes/i, ['indexes']],
    [/all_part_tables/i, ['partition']], [/\ball_tables\b/i, ['rowEstimate']], [/all_col_comments/i, []],
  ] as const) {
    o = await readFacts(refusing(UPPER_ONLY, view));
    ok(`oracle facts: a refused ${view.source.replace(/\\b/g, '')} costs ${dropped.join(' and ') || 'the column comments'} only`,
      o.r.ok && Object.keys(o.r).sort().join() === FULL.filter((k) => !dropped.includes(k as never)).sort().join() && o.r.columns.length === 3
      && (view.source === 'all_col_comments' ? o.r.columns.every((c) => !('comment' in c)) : o.r.columns[1].comment === 'Sales region'), JSON.stringify(o.r));
  }
  o = await readFacts(refusing(UPPER_ONLY, /all_tab_columns/i)).catch((e: Error) => ({ h: recorder(UPPER_ONLY), r: { ok: false as const, error: e.message } }));
  ok('oracle facts: a refused ALL_TAB_COLUMNS fails the read', !o.r.ok && /permission denied/.test(o.r.error));
  o = await readFacts(byCatalog([]));
  ok('oracle facts: no column in either spelling is no such table', !o.r.ok && o.r.error === 'No such table: orders' && o.h.rec.length === 2, JSON.stringify(o.r));

  // Through the real connector, over the fake oracledb: the adapter that binds an array and reads the rows.
  ok('every Oracle variant has tableFacts', oracle.CONNECTORS.every((d) => typeof d.tableFacts === 'function'));
  resetState();
  state.rowsAvailable = 1;
  const wired = await byId('oracle').tableFacts!(ctxFor(), 'SHOP.ORDERS');
  ok('oracle facts, wired: the rows of the driver are the columns', wired.ok && wired.columns.length === 1, JSON.stringify(wired));
  ok('oracle facts, wired: the binds are an array of name, owner and the row limit; the connection is closed', JSON.stringify(state.lastBinds) === '["ORDERS","SHOP",1]' && state.closed && state.rsClosed, JSON.stringify(state.lastBinds));
  const sentAll = state.timeouts.length;
  ok('NEGATIVE CONTROL: oracle facts, wired: inside the budget every statement is sent', sentAll >= 4, JSON.stringify(state.timeouts));
  // ONE budget for the whole read, as factsQuery: each statement runs under what is left, and none starts after it.
  resetState();
  state.rowsAvailable = 1;
  state.delayMs = 40;
  const slow = await byId('oracle').tableFacts!(ctxFor({ timeoutMs: 100 }), 'SHOP.ORDERS');
  const ts = state.timeouts;
  ok('oracle facts, wired: one budget: each statement runs under what is left, the last ones are not sent', slow.ok && ts.length >= 1 && ts.length < sentAll && ts.every((t, i) => t > 0 && t <= 100 && (i === 0 || t < ts[i - 1])), JSON.stringify(ts));
  resetState();
  state.connectError = new Error('ORA-01017: invalid credential (sup3r-s3cret-pw)');
  const down = await byId('oracle').tableFacts!(ctxFor(), 'SHOP.ORDERS').catch((e: Error) => ({ ok: false as const, error: e.message }));
  ok('oracle facts, wired: a connect failure is a failure of the read, not a crash (the door redacts it)', !down.ok);

  // ── source hygiene ─────────────────────────────────────────────────────────
  ok('the source contains no bare `any` type', !/:\s*any\b/.test(srcTs));
  ok('the 12c version floor and the 11g ROWNUM alternative are both documented',
    /ROWNUM/.test(srcTs) && /12\.1|12c/.test(srcTs));

  console.log(failureCount() === 0 ? '\nAll oracle connector checks passed.' : `\n${failureCount()} check(s) FAILED.`);
  if (failureCount() > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL unexpected throw', err);
  process.exit(1);
});
