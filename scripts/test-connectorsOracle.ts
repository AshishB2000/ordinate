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

const path: typeof import('path') = require('path');
const fs: typeof import('fs') = require('fs');
const Module: { _load(request: string, ...rest: unknown[]): unknown } = require('module');

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label + (extra === undefined ? '' : '  → ' + String(extra)));
    failures++;
  }
}

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
  lastOptions: { outFormat?: number; maxRows?: number; fetchTypeHandler?: (m: unknown) => unknown } | null;
  callTimeout: number;
  rowsAvailable: number;
  connectError: Error | null;
  executeError: Error | null;
  closed: boolean;
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
    options: { outFormat?: number; maxRows?: number; fetchTypeHandler?: (m: unknown) => unknown },
  ): Promise<{ metaData: { name: string; dbTypeName: string }[]; rows: unknown[][] }> {
    state.lastSql = sql;
    state.lastBinds = binds;
    state.lastOptions = options;
    if (state.executeError) throw state.executeError;
    // The real driver stops fetching at maxRows; the fake must too, or the
    // client-side half of the cap would go untested.
    const max = options.maxRows === undefined || options.maxRows === 0 ? state.rowsAvailable : options.maxRows;
    const n = Math.min(state.rowsAvailable, max);
    const rows: unknown[][] = [];
    for (let i = 0; i < n; i++) rows.push([i, 'n' + i]);
    return {
      metaData: [
        { name: 'ID', dbTypeName: 'NUMBER' },
        { name: 'NAME', dbTypeName: 'VARCHAR2' },
      ],
      rows,
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
  ok('maxRows caps the driver client-side too', state.lastOptions?.maxRows === 5, state.lastOptions?.maxRows);
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

  // ── source hygiene ─────────────────────────────────────────────────────────
  ok('the source contains no bare `any` type', !/:\s*any\b/.test(srcTs));
  ok('the 12c version floor and the 11g ROWNUM alternative are both documented',
    /ROWNUM/.test(srcTs) && /12\.1|12c/.test(srcTs));

  console.log(failures === 0 ? '\nAll oracle connector checks passed.' : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL unexpected throw', err);
  process.exit(1);
});
