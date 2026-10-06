// Self-check for src/connectors/mysql.ts — the eight MySQL-wire-protocol
// connectors (MySQL, MariaDB, Aurora MySQL, SingleStore, TiDB, PlanetScale,
// StarRocks, Doris).
//
// SCOPE, stated plainly: this test opens NO socket and talks to NO server. It
// exercises the pure, declarative half of the connector — the definition table,
// the SQL the module emits, the driver options it would pass, and the value
// marshalling. Everything that needs a live server (does max_statement_time
// actually bound a MariaDB query? does StarRocks accept query_timeout? does
// PlanetScale really reject information_schema?) is UNVERIFIED here and is
// called out as such in the module's comments.
//
// What that still buys: the failureCount() this family is actually prone to are all
// declarative. A wrong default port, a MariaDB connector emitting MySQL's
// timeout spelling (silently unbounded), multipleStatements creeping back on
// (`SELECT 1; DROP TABLE x;` — the exact bug class already found in this
// project's DuckDB layer), an unquoted identifier, or a password field that
// forgot `secret: true` are all catchable without a server, and all cost real
// damage if they ship.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled siblings of the .ts sources.
const mysqlConn: typeof import('../src/connectors/mysql') = require('../src/connectors/mysql');
const connTypes: typeof import('../src/connectors/types') = require('../src/connectors/types');

type Ctx = import('../src/connectors/types').ConnectorContext;

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    values: { host: 'db.example.com', database: 'analytics', user: 'reader', ...(over.values || {}) },
    secrets: { password: 'hunter2-very-secret', ...(over.secrets || {}) },
    rowLimit: over.rowLimit ?? 1000,
    timeoutMs: over.timeoutMs ?? 30_000,
  };
}

async function main(): Promise<void> {
  const { CONNECTORS, VARIANTS } = mysqlConn;

  // ── the family itself ──────────────────────────────────────────────────────

  ok('exports exactly 8 connectors', CONNECTORS.length === 8, CONNECTORS.length);

  const ids = CONNECTORS.map((c) => c.id);
  ok('ids are unique', new Set(ids).size === ids.length, ids);
  ok(
    'ids are the expected eight',
    JSON.stringify([...ids].sort()) ===
      JSON.stringify(
        ['aurora-mysql', 'doris', 'mariadb', 'mysql', 'planetscale', 'singlestore', 'starrocks', 'tidb'],
      ),
    ids,
  );
  ok('every id is kebab-case', ids.every((i) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(i)), ids);
  ok('every label is non-empty', CONNECTORS.every((c) => typeof c.label === 'string' && c.label.trim().length > 0));
  ok('every connector is readOnly === true', CONNECTORS.every((c) => c.readOnly === true));
  ok('every connector declares family "mysql"', CONNECTORS.every((c) => c.family === 'mysql'));
  ok('every connector has a blurb', CONNECTORS.every((c) => typeof c.blurb === 'string' && c.blurb.length > 0));
  ok(
    'every connector implements listTables + run',
    CONNECTORS.every((c) => typeof c.listTables === 'function' && typeof c.run === 'function'),
  );

  // ── default ports ──────────────────────────────────────────────────────────
  // A family built from one factory invites exactly one bug: a copy-pasted port.
  // TiDB (4000) and StarRocks/Doris (9030) are the ones most likely to be wrong.
  const EXPECTED_PORTS: Record<string, number> = {
    mysql: 3306,
    mariadb: 3306,
    'aurora-mysql': 3306,
    singlestore: 3306,
    tidb: 4000,
    planetscale: 3306,
    starrocks: 9030,
    doris: 9030,
  };
  for (const [id, expected] of Object.entries(EXPECTED_PORTS)) {
    const def = CONNECTORS.find((c) => c.id === id);
    const portField = def?.fields.find((f) => f.key === 'port');
    ok(`${id}: port field defaults to ${expected}`, portField?.default === expected, portField?.default);
    const variant = VARIANTS.find((v) => v.id === id);
    ok(`${id}: variant port is ${expected}`, variant?.port === expected, variant?.port);
  }

  // The port default must also actually reach the driver when the user leaves
  // the field blank — a correct table with an ignored value is still a bug.
  for (const [id, expected] of Object.entries(EXPECTED_PORTS)) {
    const variant = VARIANTS.find((v) => v.id === id)!;
    const opts = mysqlConn.connectionOptions(variant, ctx({ values: { port: undefined } }));
    ok(`${id}: blank port falls back to ${expected}`, opts.port === expected, opts.port);
  }
  const explicit = mysqlConn.connectionOptions(
    VARIANTS.find((v) => v.id === 'tidb')!,
    ctx({ values: { port: 14000 } }),
  );
  ok('an explicit port overrides the default', explicit.port === 14000, explicit.port);

  // ── the timeout dialect (the silent-failure one) ───────────────────────────

  const my = mysqlConn.timeoutPlan('mysql', 30_000);
  ok('mysql emits max_execution_time', /max_execution_time/.test(my.session || ''), my);
  ok('mysql does NOT emit max_statement_time', !/max_statement_time/.test(JSON.stringify(my)), my);
  ok('mysql timeout is in MILLISECONDS', (my.session || '').includes('30000'), my.session);
  ok('mysql needs no statement prefix', my.prefix === '', my.prefix);

  const maria = mysqlConn.timeoutPlan('mariadb', 30_000);
  ok('mariadb emits max_statement_time', /max_statement_time/.test(maria.prefix), maria);
  ok(
    'mariadb does NOT emit max_execution_time (MariaDB has no such variable)',
    !/max_execution_time/.test(JSON.stringify(maria)),
    maria,
  );
  ok('mariadb timeout is in SECONDS', /max_statement_time=30\b/.test(maria.prefix), maria.prefix);
  ok('mariadb bounds via a SET STATEMENT … FOR prefix', /^SET STATEMENT .* FOR $/.test(maria.prefix), maria.prefix);
  ok('mariadb has no session statement', maria.session === null, maria.session);

  // The prefix must actually glue onto a statement without mangling it.
  ok(
    'mariadb prefix + wrapped query is one legal statement',
    (maria.prefix + mysqlConn.wrapSelect('select 1', 10)).startsWith('SET STATEMENT max_statement_time=30 FOR SELECT'),
    maria.prefix + mysqlConn.wrapSelect('select 1', 10),
  );

  for (const id of ['aurora-mysql', 'singlestore', 'tidb', 'planetscale']) {
    const p = mysqlConn.timeoutPlan(id, 5_000);
    ok(`${id} uses max_execution_time`, p.dialect === 'max_execution_time' && /max_execution_time = 5000/.test(p.session || ''), p);
  }
  for (const id of ['starrocks', 'doris']) {
    const p = mysqlConn.timeoutPlan(id, 5_000);
    ok(`${id} uses query_timeout in seconds`, p.dialect === 'query_timeout' && /query_timeout = 5\b/.test(p.session || ''), p);
  }

  // A sub-second cap must never round to 0 — 0 means "no limit" in every one of
  // these dialects, which would turn a tight bound into no bound at all.
  const tiny = mysqlConn.timeoutPlanFor('query_timeout', 200);
  ok('a sub-second timeout rounds UP to 1s, never 0', /query_timeout = 1\b/.test(tiny.session || ''), tiny.session);
  const tinyMaria = mysqlConn.timeoutPlanFor('max_statement_time', 200);
  ok('a sub-second MariaDB timeout rounds UP to 1s', /max_statement_time=1\b/.test(tinyMaria.prefix), tinyMaria.prefix);

  // Garbage in must not disable the bound.
  const bad = mysqlConn.timeoutPlanFor('max_execution_time', NaN);
  ok('a NaN timeout falls back to a real bound', /max_execution_time = 30000/.test(bad.session || ''), bad.session);
  const neg = mysqlConn.timeoutPlanFor('max_execution_time', -1);
  ok('a negative timeout falls back to a real bound', /max_execution_time = 30000/.test(neg.session || ''), neg.session);

  // ── driver foot-guns ───────────────────────────────────────────────────────

  for (const v of VARIANTS) {
    const opts = mysqlConn.connectionOptions(v, ctx());
    // With multipleStatements on, "SELECT 1; DROP TABLE x;" runs BOTH halves.
    ok(`${v.id}: multipleStatements is false`, opts.multipleStatements === false, opts.multipleStatements);
    ok(`${v.id}: rowsAsArray is true (duplicate column names survive)`, opts.rowsAsArray === true);
    ok(`${v.id}: dateStrings is true (the sniffer decides types, not the driver)`, opts.dateStrings === true);
    ok(`${v.id}: big numbers come back as strings`, opts.supportBigNumbers === true && opts.bigNumberStrings === true);
    ok(`${v.id}: connectTimeout is bounded`, typeof opts.connectTimeout === 'number' && opts.connectTimeout! > 0);
    ok(`${v.id}: password reaches the driver from ctx.secrets`, opts.password === 'hunter2-very-secret');
  }

  // ── row cap ────────────────────────────────────────────────────────────────

  const wrapped = mysqlConn.wrapSelect('select * from sales', 100);
  ok('wrapper is a sub-SELECT', /^SELECT \* FROM \(\nselect \* from sales\n\) AS t /.test(wrapped), wrapped);
  // rowLimit + 1: the extra probe row is how truncation is DETECTED; run() slices
  // back to rowLimit, so the cap the caller sees is exactly ctx.rowLimit.
  ok('wrapper caps at rowLimit (+1 probe row to detect truncation)', / LIMIT 101$/.test(wrapped), wrapped);
  ok('wrapper caps at rowLimit for a 1M limit', / LIMIT 1000001$/.test(mysqlConn.wrapSelect('select 1', 1_000_000)));
  ok(
    'a trailing semicolon is stripped so it cannot close the sub-select',
    mysqlConn.wrapSelect('select 1;  ', 5) === 'SELECT * FROM (\nselect 1\n) AS t LIMIT 6',
    mysqlConn.wrapSelect('select 1;  ', 5),
  );
  ok('T6.3: a trailing -- or # comment ends at the newline; the LIMIT survives on its own line',
    /\n\) AS t LIMIT 6$/.test(mysqlConn.wrapSelect('select * from big ) t -- ', 5)) && /\n\) AS t LIMIT 6$/.test(mysqlConn.wrapSelect('select * from big ) t #', 5)));
  ok('a garbage rowLimit still yields a finite cap', / LIMIT 2$/.test(mysqlConn.wrapSelect('select 1', NaN)));
  ok('a zero rowLimit still yields a finite cap', mysqlConn.effectiveRowLimit(0) === 1);
  ok('effectiveRowLimit passes a sane limit through', mysqlConn.effectiveRowLimit(1_000_000) === 1_000_000);

  // run() rejects an empty query before it ever opens a socket.
  const emptyRun = await CONNECTORS[0].run(ctx(), '   ');
  ok('run() with an empty query errors without connecting', emptyRun.ok === false, emptyRun);

  // ── identifier quoting ─────────────────────────────────────────────────────

  const EVIL = 'evil`; DROP TABLE x; --';
  const quoted = mysqlConn.quoteIdent(EVIL);
  ok('quoteIdent wraps in backticks', quoted.startsWith('`') && quoted.endsWith('`'), quoted);
  ok('quoteIdent doubles the embedded backtick', quoted === '`evil``; DROP TABLE x; --`', quoted);
  // The payload's own backtick can no longer terminate the identifier, so the
  // whole string stays one name. Count them: every backtick inside the body is
  // doubled, so the total is even and the quoting is balanced.
  const inner = quoted.slice(1, -1);
  ok('no lone backtick survives inside the identifier', !/(^|[^`])`([^`]|$)/.test(inner), inner);
  ok('quoteIdent is idempotent-safe on a plain name', mysqlConn.quoteIdent('sales') === '`sales`');
  const show = mysqlConn.showTablesSql(EVIL);
  ok('SHOW TABLES FROM quotes the database name', show === 'SHOW TABLES FROM `evil``; DROP TABLE x; --`', show);
  ok('SHOW TABLES with no database has no FROM clause', mysqlConn.showTablesSql('') === 'SHOW TABLES');

  // ── secrets ────────────────────────────────────────────────────────────────

  for (const c of CONNECTORS) {
    const pw = c.fields.find((f) => f.key === 'password');
    ok(`${c.id}: has a password field`, !!pw);
    ok(`${c.id}: password is marked secret: true`, pw?.secret === true, pw);
    ok(`${c.id}: password field type is 'password'`, pw?.type === 'password', pw?.type);
    const nonSecret = c.fields.filter((f) => f.key !== 'password');
    ok(`${c.id}: no non-password field is marked secret`, nonSecret.every((f) => !f.secret));
  }

  // safeError must strip a password out of a driver string. mysql2 error
  // messages carry the host and user, and a DSN-shaped one carries the password.
  const driverErr = new Error(
    "Access denied for user 'reader'@'10.0.0.1' (using password: hunter2-very-secret) mysql://reader:hunter2-very-secret@db.example.com:3306",
  );
  const safe = connTypes.safeError(driverErr, { password: 'hunter2-very-secret' });
  ok('safeError removes the password from a driver error', !safe.includes('hunter2-very-secret'), safe);
  ok('safeError leaves the useful part of the message', safe.includes('Access denied'), safe);
  ok('safeError redacts URL-embedded credentials', safe.includes('//***:***@'), safe);

  // ── TLS defaults ───────────────────────────────────────────────────────────

  for (const id of ['planetscale', 'aurora-mysql']) {
    const def = CONNECTORS.find((c) => c.id === id)!;
    const sslField = def.fields.find((f) => f.key === 'ssl');
    ok(`${id}: TLS is on by default`, sslField?.default === true, sslField?.default);
  }
  for (const id of ['mysql', 'mariadb', 'tidb', 'singlestore', 'starrocks', 'doris']) {
    const def = CONNECTORS.find((c) => c.id === id)!;
    const sslField = def.fields.find((f) => f.key === 'ssl');
    ok(`${id}: TLS defaults off (self-hosted is usually plain)`, sslField?.default === false, sslField?.default);
  }
  const ps = VARIANTS.find((v) => v.id === 'planetscale')!;
  ok(
    'planetscale keeps TLS on even when the user unticks it (the server refuses plaintext)',
    !!mysqlConn.connectionOptions(ps, ctx({ values: { ssl: false } })).ssl,
  );
  const plainMysql = VARIANTS.find((v) => v.id === 'mysql')!;
  ok('mysql honours the TLS checkbox when ticked', !!mysqlConn.connectionOptions(plainMysql, ctx({ values: { ssl: true } })).ssl);
  ok('mysql leaves TLS off when unticked', !mysqlConn.connectionOptions(plainMysql, ctx({ values: { ssl: false } })).ssl);
  ok(
    'planetscale lists tables via SHOW TABLES (some plans hide information_schema)',
    ps.listVia === 'show_tables',
    ps.listVia,
  );

  // ── value marshalling ──────────────────────────────────────────────────────

  ok('null stays null', mysqlConn.normalizeCell(null) === null);
  ok('undefined becomes null', mysqlConn.normalizeCell(undefined) === null);
  ok('a string passes through', mysqlConn.normalizeCell('007') === '007');
  ok('a number passes through', mysqlConn.normalizeCell(42) === 42);
  ok('a boolean passes through', mysqlConn.normalizeCell(true) === true);
  // A BIGINT past 2^53 must not become a lossy JS number.
  ok('a bigint becomes an exact string', mysqlConn.normalizeCell(9007199254740993n) === '9007199254740993');
  ok('a Date becomes an ISO string', mysqlConn.normalizeCell(new Date(0)) === '1970-01-01T00:00:00.000Z');
  ok('a Buffer becomes base64', mysqlConn.normalizeCell(Buffer.from('hi')) === 'aGk=');
  ok('a parsed JSON column becomes text', mysqlConn.normalizeCell({ a: 1 }) === '{"a":1}');

  ok('column type names come from the protocol code', mysqlConn.columnTypeName({ columnType: 253 }) === 'VAR_STRING', mysqlConn.columnTypeName({ columnType: 253 }));
  ok('column type falls back to `type` when columnType is absent', mysqlConn.columnTypeName({ type: 3 }) === 'LONG');
  ok('an explicit typeName wins', mysqlConn.columnTypeName({ columnType: 3, typeName: 'INT UNSIGNED' }) === 'INT UNSIGNED');
  ok('an unknown code degrades to a string, never throws', mysqlConn.columnTypeName({ columnType: 9999 }) === '9999');
  ok('a field with no type at all is UNKNOWN', mysqlConn.columnTypeName({}) === 'UNKNOWN');

  // ── categories ─────────────────────────────────────────────────────────────
  const CATEGORIES = ['Databases', 'Cloud warehouses', 'Query engines', 'Files & local'];
  ok('every connector has a valid category', CONNECTORS.every((c) => CATEGORIES.includes(c.category)), CONNECTORS.map((c) => c.category));

  console.log('');
  if (failureCount()) {
    console.error(`${failureCount()} check(s) failed.`);
    process.exit(1);
  }
  console.log('All connectors/mysql checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
