// Self-check for src/connectors/mssql.ts (SQL Server / Azure SQL / Synapse).
//
// WHAT THIS CANNOT TEST: there is no SQL Server here. Nothing below proves that
// a generated statement parses on a real server, that TLS negotiates, that
// Synapse accepts OFFSET…FETCH, or that a named instance resolves. Those need a
// live endpoint and are called out in the connector's own comments.
//
// WHAT IT DOES TEST, and what makes that worth something: the `tedious` module
// is REPLACED (via Module._load, the same trick test-connections.ts uses for
// 'electron') with a fake driver that records the config object and the SQL it
// was handed, and emits a controlled number of rows. So the assertions are on
// the real connector code end to end — the driver config it builds, the SQL it
// caps, how many rows it keeps, whether it cancels, and what it does with an
// error — with only the socket faked out.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const path: typeof import('path') = require('path');
const fs: typeof import('fs') = require('fs');
const { EventEmitter }: typeof import('events') = require('events');
const Module: { _load(request: string, ...rest: unknown[]): unknown } = require('module');


// ── the fake tedious driver ───────────────────────────────────────────────────

interface FakeState {
  lastConfig: Record<string, unknown> | null;
  lastSql: string;
  lastParams: { name: string; value: unknown }[];
  rowsToEmit: number;
  connectError: Error | null;
  requestError: Error | null;
  canceled: boolean;
  closed: boolean;
  emitted: number;
}

const state: FakeState = {
  lastConfig: null,
  lastSql: '',
  lastParams: [],
  rowsToEmit: 0,
  connectError: null,
  requestError: null,
  canceled: false,
  closed: false,
  emitted: 0,
};

function resetState(): void {
  state.lastConfig = null;
  state.lastSql = '';
  state.lastParams = [];
  state.rowsToEmit = 0;
  state.connectError = null;
  state.requestError = null;
  state.canceled = false;
  state.closed = false;
  state.emitted = 0;
}

class FakeRequest extends EventEmitter {
  sqlTextOrProcedure: string;
  userCallback: (err: Error | null | undefined, rowCount?: number) => void;
  constructor(sql: string, cb: (err: Error | null | undefined, rowCount?: number) => void) {
    super();
    this.sqlTextOrProcedure = sql;
    this.userCallback = cb;
  }
  addParameter(name: string, _type: unknown, value?: unknown): void {
    state.lastParams.push({ name, value });
  }
}

class FakeConnection extends EventEmitter {
  constructor(cfg: Record<string, unknown>) {
    super();
    state.lastConfig = cfg;
  }
  connect(cb: (err?: Error) => void): void {
    setImmediate(() => {
      if (state.connectError) cb(state.connectError);
      else cb();
    });
  }
  close(): void {
    state.closed = true;
  }
  cancel(): boolean {
    state.canceled = true;
    return true;
  }
  execSql(req: FakeRequest): void {
    state.lastSql = req.sqlTextOrProcedure;
    setImmediate(() => {
      if (state.requestError) {
        req.userCallback(state.requestError);
        return;
      }
      req.emit('columnMetadata', [
        { colName: 'id', type: { name: 'Int' } },
        { colName: 'name', type: { name: 'NVarChar' } },
      ]);
      for (let i = 0; i < state.rowsToEmit; i++) {
        if (state.canceled) break;
        state.emitted++;
        req.emit('row', [
          { metadata: { colName: 'id' }, value: i },
          { metadata: { colName: 'name' }, value: 'n' + i },
        ]);
      }
      if (state.canceled) req.userCallback(new Error('Canceled.'));
      else req.userCallback(null, state.emitted);
    });
  }
}

const fakeTedious = {
  Connection: FakeConnection,
  Request: FakeRequest,
  TYPES: { Int: { name: 'Int' }, NVarChar: { name: 'NVarChar' } },
};

const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]): unknown {
  if (request === 'tedious') return fakeTedious;
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled sibling of the .ts source.
const mssql: typeof import('../src/connectors/mssql') = require('../src/connectors/mssql');

type ConnectorContext = import('../src/connectors/types').ConnectorContext;
type ConnectorDef = import('../src/connectors/types').ConnectorDef;

function ctxFor(over?: Partial<ConnectorContext>): ConnectorContext {
  return {
    values: { host: 'db.example.com', database: 'analytics', user: 'reader' },
    secrets: { password: 'sup3r-s3cret-pw' },
    rowLimit: 10,
    timeoutMs: 30_000,
    ...over,
  };
}

function byId(id: string): ConnectorDef {
  const d = mssql.CONNECTORS.find((c) => c.id === id);
  if (!d) throw new Error('missing connector ' + id);
  return d;
}

async function main(): Promise<void> {
  // ── shape ──────────────────────────────────────────────────────────────────
  const ids = mssql.CONNECTORS.map((c) => c.id);
  ok('three connectors', mssql.CONNECTORS.length === 3, ids.join(','));
  ok('ids are exactly sqlserver/azure-sql/azure-synapse',
    ids.join(',') === 'sqlserver,azure-sql,azure-synapse', ids.join(','));
  ok('ids are unique', new Set(ids).size === ids.length);
  ok('every connector is readOnly', mssql.CONNECTORS.every((c) => c.readOnly === true));
  ok('every connector is family mssql', mssql.CONNECTORS.every((c) => c.family === 'mssql'));
  ok('every connector has a label + fields',
    mssql.CONNECTORS.every((c) => !!c.label && Array.isArray(c.fields) && c.fields.length > 0));
  ok('CONNECTORS and the lowercase alias are the same array', mssql.connectors === mssql.CONNECTORS);

  for (const c of mssql.CONNECTORS) {
    const port = c.fields.find((f) => f.key === 'port');
    ok(`${c.id} defaults to port 1433`, !!port && port.default === 1433, port && port.default);
    const pw = c.fields.find((f) => f.key === 'password');
    ok(`${c.id} marks password secret:true`, !!pw && pw.secret === true && pw.type === 'password');
    ok(`${c.id} never marks a non-password field secret`,
      c.fields.every((f) => !f.secret || f.key === 'password'));
  }

  ok('on-prem SQL Server offers a trustServerCertificate opt-in',
    byId('sqlserver').fields.some((f) => f.key === 'trustServerCertificate' && f.default === false));
  ok('that opt-in says what it gives up',
    /impersonate|verif/i.test(String(byId('sqlserver').fields.find((f) => f.key === 'trustServerCertificate')?.help)));
  ok('Azure connectors do not offer trustServerCertificate at all',
    !byId('azure-sql').fields.some((f) => f.key === 'trustServerCertificate') &&
    !byId('azure-synapse').fields.some((f) => f.key === 'trustServerCertificate'));
  ok('Azure connectors do not offer an encrypt toggle',
    !byId('azure-sql').fields.some((f) => f.key === 'encrypt') &&
    !byId('azure-synapse').fields.some((f) => f.key === 'encrypt'));

  // ── the driver config we build ─────────────────────────────────────────────
  const V = mssql.__testing.VARIANTS;
  const onPrem = V[0];
  const azure = V[1];
  const synapse = V[2];

  const cfgDefault = mssql.buildTediousConfig(onPrem, ctxFor({ values: {} })) as unknown as {
    options: Record<string, unknown>;
    authentication: { options: Record<string, unknown> };
    server: string;
  };
  ok('connectTimeout comes from ctx.timeoutMs', cfgDefault.options.connectTimeout === 30_000, cfgDefault.options.connectTimeout);
  ok('requestTimeout comes from ctx.timeoutMs', cfgDefault.options.requestTimeout === 30_000, cfgDefault.options.requestTimeout);
  const cfgShort = mssql.buildTediousConfig(onPrem, ctxFor({ timeoutMs: 1234 })) as unknown as { options: Record<string, unknown> };
  ok('both timeouts track a different ctx.timeoutMs',
    cfgShort.options.connectTimeout === 1234 && cfgShort.options.requestTimeout === 1234);
  ok('port defaults to 1433 in the config', cfgDefault.options.port === 1433, cfgDefault.options.port);
  ok('trustServerCertificate is FALSE by default', cfgDefault.options.trustServerCertificate === false);
  ok('readOnlyIntent is set', cfgDefault.options.readOnlyIntent === true);
  ok('rows are streamed, not collected by the driver', cfgDefault.options.rowCollectionOnRequestCompletion === false);
  ok('rows are positional (useColumnNames false)', cfgDefault.options.useColumnNames === false);
  ok('the password is taken from ctx.secrets', cfgDefault.authentication.options.password === 'sup3r-s3cret-pw');

  for (const v of [azure, synapse]) {
    const cfg = mssql.buildTediousConfig(v, ctxFor({ values: { encrypt: false, trustServerCertificate: true } })) as unknown as {
      options: Record<string, unknown>;
    };
    ok(`${v.id}: encrypt is ON even when the value says false`, cfg.options.encrypt === true);
    ok(`${v.id}: trustServerCertificate stays false even when the value says true`,
      cfg.options.trustServerCertificate === false);
  }
  const cfgOnPremEnc = mssql.buildTediousConfig(onPrem, ctxFor({ values: {} })) as unknown as { options: Record<string, unknown> };
  ok('on-prem encrypt defaults ON too', cfgOnPremEnc.options.encrypt === true);
  const cfgTrust = mssql.buildTediousConfig(onPrem, ctxFor({ values: { trustServerCertificate: true } })) as unknown as {
    options: Record<string, unknown>;
  };
  ok('on-prem trustServerCertificate is opt-in, and the opt-in works', cfgTrust.options.trustServerCertificate === true);
  const cfgInst = mssql.buildTediousConfig(onPrem, ctxFor({ values: { instanceName: 'SQLEXPRESS' } })) as unknown as {
    options: Record<string, unknown>;
  };
  ok('an instance name replaces the port (tedious rejects both)',
    cfgInst.options.instanceName === 'SQLEXPRESS' && cfgInst.options.port === undefined);

  // ── the row cap wrapper ────────────────────────────────────────────────────
  const plain = mssql.capTsql('select * from sales', 100);
  ok('plain query is wrapped with TOP (n)', /^SELECT TOP \(100\) \* FROM \( select \* from sales \) AS _ord_cap$/.test(plain), plain);
  ok('T-SQL cap never emits LIMIT', !/\bLIMIT\b/i.test(plain));

  const ordered = mssql.capTsql('select * from sales order by amount desc', 50);
  ok('an ORDER BY query is NOT wrapped (SQL Server error 1033)', !/_ord_cap/.test(ordered), ordered);
  ok('an ORDER BY query gets OFFSET/FETCH appended instead',
    /order by amount desc OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY$/.test(ordered), ordered);

  const cte = mssql.capTsql('with t as (select 1 as a) select * from t', 7);
  ok('a CTE is not wrapped (WITH is illegal in a derived table)', !/_ord_cap/.test(cte), cte);
  ok('a CTE gets ORDER BY (SELECT NULL) + OFFSET/FETCH',
    /ORDER BY \(SELECT NULL\) OFFSET 0 ROWS FETCH NEXT 7 ROWS ONLY$/.test(cte), cte);

  const paged = mssql.capTsql('select * from sales order by a offset 10 rows fetch next 5 rows only', 9);
  ok('a query that already pages itself is left alone', !/_ord_cap/.test(paged) && !/NEXT 9/.test(paged), paged);

  const trailing = mssql.capTsql('select * from sales;', 3);
  ok('a trailing semicolon is stripped before wrapping', !/;/.test(trailing), trailing);

  // ORDER BY inside a subquery/string must not trip the top-level scan.
  const nested = mssql.capTsql("select * from (select * from t order by 1 offset 0 rows) x where s <> 'order by'", 5);
  ok('an ORDER BY nested in a subquery or a string is not top-level', /_ord_cap/.test(nested), nested);

  // ── read-only guard ────────────────────────────────────────────────────────
  const sqlserver = byId('sqlserver');
  const writes = [
    'delete from sales',
    'update sales set a = 1',
    'insert into sales values (1)',
    'drop table sales',
    'exec sp_who',
    'select * into backup_sales from sales',
    'with t as (select 1 a) delete from sales',
    'select 1; drop table sales',
  ];
  for (const w of writes) {
    const r = await sqlserver.run(ctxFor(), w);
    ok('rejects: ' + w, r.ok === false && /read-only|single statement|Only SELECT/i.test(r.ok === false ? r.error : ''),
      r.ok === false ? r.error : 'ACCEPTED');
  }

  // ── running, capping, cancelling ───────────────────────────────────────────
  resetState();
  state.rowsToEmit = 100;
  const capped = await sqlserver.run(ctxFor({ rowLimit: 4 }), 'select * from sales');
  ok('run succeeded', capped.ok === true, capped.ok === false ? capped.error : '');
  if (capped.ok) {
    ok('keeps exactly ctx.rowLimit rows', capped.rows.length === 4, capped.rows.length);
    ok('reports truncated:true when the cap clips', capped.truncated === true);
    ok('columns come from columnMetadata with the source type verbatim',
      capped.columns.length === 2 && capped.columns[0].name === 'id' && capped.columns[1].type === 'NVarChar',
      JSON.stringify(capped.columns));
    ok('values are positional scalars', capped.rows[0][0] === 0 && capped.rows[0][1] === 'n0', JSON.stringify(capped.rows[0]));
  }
  ok('the server-side cap asked for rowLimit + 1', /TOP \(5\)/.test(state.lastSql), state.lastSql);
  ok('the request was cancelled once the cap was passed', state.canceled === true);
  ok('the connection was closed', state.closed === true);
  ok('no more than rowLimit + 1 rows were ever read', state.emitted <= 5, state.emitted);

  resetState();
  state.rowsToEmit = 3;
  const short = await sqlserver.run(ctxFor({ rowLimit: 10 }), 'select * from sales');
  ok('a result inside the cap is not truncated', short.ok === true && short.truncated === false);
  ok('a result inside the cap keeps every row', short.ok === true && short.rows.length === 3);
  ok('a result inside the cap does not cancel', state.canceled === false);

  resetState();
  state.rowsToEmit = 5;
  const exact = await sqlserver.run(ctxFor({ rowLimit: 5 }), 'select * from sales');
  ok('exactly-at-the-cap keeps 5 rows and is NOT truncated',
    exact.ok === true && exact.rows.length === 5 && exact.truncated === false,
    exact.ok === true ? `${exact.rows.length} rows, truncated=${exact.truncated}` : exact.error);
  ok('exactly-at-the-cap does not cancel', state.canceled === false);

  // ── listTables ─────────────────────────────────────────────────────────────
  resetState();
  state.rowsToEmit = 2;
  const tables = await sqlserver.listTables(ctxFor());
  ok('listTables succeeded', tables.ok === true, tables.ok === false ? tables.error : '');
  ok('listTables reads INFORMATION_SCHEMA.TABLES', /INFORMATION_SCHEMA\.TABLES/.test(state.lastSql), state.lastSql);
  ok('listTables binds every value (no concatenated literals)',
    state.lastParams.length === 3 &&
    state.lastParams.map((p) => p.name).join(',') === 'maxRows,baseTable,viewType',
    JSON.stringify(state.lastParams));
  ok('listTables parameterizes even the row cap', /TOP \(@maxRows\)/.test(state.lastSql), state.lastSql);
  ok('listTables returns {schema,name}', tables.ok === true && tables.tables.length === 2 &&
    tables.tables[0].schema === '0' && tables.tables[0].name === 'n0', JSON.stringify(tables.ok === true ? tables.tables : []));

  // ── identifier quoting ─────────────────────────────────────────────────────
  const evil = 'evil"; DROP TABLE x; --';
  ok('an injection attempt fails the identifier whitelist', mssql.isSafeIdent(evil) === false);
  ok('quoting doubles the embedded quote so it stays ONE identifier',
    mssql.quoteIdent(evil) === '"evil""; DROP TABLE x; --"', mssql.quoteIdent(evil));
  ok('the quoted form has no unbalanced quote that could end the identifier',
    (mssql.quoteIdent(evil).match(/"/g) || []).length % 2 === 0);
  ok('a normal identifier passes', mssql.isSafeIdent('sales_2024') && mssql.quoteIdent('sales_2024') === '"sales_2024"');
  ok('a dotted name is not a single identifier', mssql.isSafeIdent('dbo.sales') === false);

  // ── errors ─────────────────────────────────────────────────────────────────
  resetState();
  state.connectError = new Error('Login failed for user reader (password sup3r-s3cret-pw)');
  const failed = await sqlserver.run(ctxFor(), 'select 1');
  ok('a connect failure is returned, not thrown', failed.ok === false);
  ok('safeError redacts the password from a driver error',
    failed.ok === false && !failed.error.includes('sup3r-s3cret-pw') && failed.error.includes('***'),
    failed.ok === false ? failed.error : '');
  ok('the connection is still closed after a connect failure', state.closed === true);

  resetState();
  state.requestError = new Error('Invalid object name (dsn=sqlserver://reader:sup3r-s3cret-pw@host)');
  const reqFailed = await sqlserver.run(ctxFor(), 'select 1');
  ok('a request failure is returned, not thrown', reqFailed.ok === false);
  ok('safeError redacts a DSN embedded in a request error',
    reqFailed.ok === false && !reqFailed.error.includes('sup3r-s3cret-pw'),
    reqFailed.ok === false ? reqFailed.error : '');
  ok('the connection is closed after a request failure', state.closed === true);

  resetState();
  const empty = await sqlserver.run(ctxFor(), '   ');
  ok('an empty query is rejected before connecting', empty.ok === false && state.lastConfig === null);

  // ── source hygiene ─────────────────────────────────────────────────────────
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'connectors', 'mssql.ts'), 'utf8');
  ok('the source never uses shell:true', !/shell\s*:\s*true/.test(src));
  ok('the source contains no bare `any` type', !/:\s*any\b/.test(src));
  ok('the ORDER BY-in-a-derived-table limitation is documented',
    /1033|ORDER BY clause is invalid/.test(src));

  console.log(failureCount() === 0 ? '\nAll mssql connector checks passed.' : `\n${failureCount()} check(s) FAILED.`);
  if (failureCount() > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FAIL unexpected throw', err);
  process.exit(1);
});
