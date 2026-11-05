// Self-check for src/connectors/httpFacts.ts — a table's facts on the two HTTP engines that have no
// describeTable: ClickHouse (system.columns, system.tables) and Databricks SQL (Unity Catalog
// information_schema, DESCRIBE DETAIL). test-connectorsHttp.ts is on the file-size allowlist, so this is its own suite.
//
// UNVERIFIED: every statement is written from the ClickHouse and Databricks documentation. There is no
// ClickHouse server and no Databricks workspace behind this suite: a recording FactsQuery answers each
// statement from a fixture, and what is pinned is THIS side of the socket: values are parameters, an
// identifier is whitelisted and quoted before a socket opens, every statement is limited, a refused catalog
// costs its field and only the columns fail the read, and the request that leaves is the family's own bound,
// SSRF-checked one (a local stub server for ClickHouse, an injected transport for the https-only Databricks).
//
//   npm run build:ts && node scripts/test-connectorsHttpFacts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { byCatalog, recorder, refusing } from './factsHarness';

const http: typeof import('http') = require('http');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const facts: typeof import('../src/connectors/httpFacts') = require('../src/connectors/httpFacts');
const conn: typeof import('../src/connectors/http') = require('../src/connectors/http');
const context: typeof import('../src/server/context') = require('../src/server/context');
const tableFactsRun: typeof import('../src/connectors/tableFactsRun') = require('../src/connectors/tableFactsRun');
type Ctx = import('../src/connectors/types').ConnectorContext;
type Def = import('../src/connectors/types').ConnectorDef;

const byId = (id: string): Def => conn.CONNECTORS.find((d) => d.id === id)!;
const ctxFor = (values: Record<string, unknown>, secrets: Record<string, string> = {}, timeoutMs = 5_000): Ctx => ({ values, secrets, rowLimit: 2000, timeoutMs });

// A local HTTP server standing in for ClickHouse: it logs each request and answers by the catalog in the body.
interface Hit { url: URL; body: string; headers: import('http').IncomingHttpHeaders }
async function stub(answer: (hit: Hit, res: import('http').ServerResponse) => void): Promise<{ port: number; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const hit = { url: new URL(req.url ?? '/', 'http://stub'), body: Buffer.concat(chunks).toString('utf8'), headers: req.headers };
      hits.push(hit);
      answer(hit, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('net').AddressInfo).port;
  return { port, hits, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}
const compact = (columns: string[], data: unknown[][]) => JSON.stringify({ meta: columns.map((name) => ({ name, type: 'String' })), data, rows: data.length });
const send = (res: import('http').ServerResponse, body: string, status = 200): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };

// ── ClickHouse ──────────────────────────────────────────────────────────────────────────────────────

// system.columns rows: name, type, comment, is_in_primary_key, is_in_sorting_key, is_in_partition_key (UInt8, so 0/1).
// system.tables rows: comment, partition_key, total_rows, total_bytes (UInt64 arrive as strings), modified (epoch s).
const CH_ORDERS = byCatalog([
  [/FROM system\.columns/, [
    ['order_date', 'Date', '', 1, 1, 1],
    ['region', 'LowCardinality(Nullable(String))', 'Sales region, after tax', 0, 1, 0],
    ['amount', 'Nullable(Float64)', '', 0, 0, 0],
  ]],
  [/FROM system\.tables/, [['Orders, one row per line', 'toYYYYMM(order_date)', '1200', '8192', 1714564800]]],
]);

async function clickhouseReader(): Promise<void> {
  const readCh = async (answer = CH_ORDERS, name = 'shop.orders', database = 'default') => {
    const h = recorder(answer);
    return { h, r: await facts.clickhouseTableFacts(name, h.open, { database }) };
  };

  let t = await readCh();
  const f = t.r.ok ? t.r : null;
  ok('clickhouse facts: names are parameters, never text', t.h.rec.length === 2 && t.h.rec.every((x) => /\{p0:String\}/.test(x.sql) && /\{p1:String\}/.test(x.sql) && !x.sql.includes('orders') && !x.sql.includes('shop')) && JSON.stringify(t.h.rec[0].params) === '["shop","orders"]', JSON.stringify(t.h.rec));
  ok('clickhouse facts: every statement is limited', t.h.rec.every((x) => /\bLIMIT \d+$/.test(x.sql.trim())), t.h.rec.map((x) => x.sql.trim().slice(-14)).join(' | '));
  ok('clickhouse facts: key from the flags, not enforced; sort and partition', JSON.stringify([f?.primaryKey, f?.sortKey, f?.partition]) === '[{"columns":["order_date"],"enforced":false},["order_date","region"],{"columns":["order_date"],"method":"toYYYYMM(order_date)"}]', JSON.stringify(t.r));
  ok('clickhouse facts: columns, types, comments, nullability (from the type), the key mark', JSON.stringify(f?.columns) ===
    '[{"name":"order_date","type":"Date","nullable":false,"key":true},{"name":"region","type":"LowCardinality(Nullable(String))","nullable":true,"comment":"Sales region, after tax"},{"name":"amount","type":"Nullable(Float64)","nullable":true}]', JSON.stringify(f?.columns));
  ok('clickhouse facts: the table comment, estimate, size and modified time (epoch seconds to ISO, whatever the server zone)', JSON.stringify([f?.comment, f?.rowEstimate, f?.bytes, f?.lastModified]) === '["Orders, one row per line",1200,8192,"2024-05-01T12:00:00.000Z"]', JSON.stringify(f));
  ok('clickhouse facts: the modified time is asked for as a Unix timestamp, so no zone is guessed', /toUnixTimestamp\(metadata_modification_time\)/.test(t.h.rec[1].sql));
  ok('clickhouse facts: one table, one read of each catalog', t.h.opened() === 1 && /system\.columns/.test(t.h.rec[0].sql) && /system\.tables/.test(t.h.rec[1].sql));

  t = await readCh(CH_ORDERS, 'orders', 'analytics');
  ok('clickhouse facts: an unqualified name is looked up in the connection\'s database', JSON.stringify(t.h.rec[0].params) === '["analytics","orders"]');
  t = await readCh(CH_ORDERS, 'shop.x\'; DROP TABLE y; --');
  ok('clickhouse facts: a hostile name is a bound value, never text', t.h.rec.length > 0 && t.h.rec.every((x) => !/drop table/i.test(x.sql)) && t.h.rec[0].params[1] === 'x\'; DROP TABLE y; --');

  const refused: boolean[] = [];
  for (const bad of ['a.b.c', 'a.b.c.d', '', '.x', 'x.', '  ']) {
    const g = await readCh(CH_ORDERS, bad);
    refused.push(g.h.opened() === 0 && !g.r.ok && g.r.error === 'Invalid table name');
  }
  ok('clickhouse facts: three or four parts, an empty part or no name never open a request', refused.every(Boolean), refused.join());

  t = await readCh(refusing(CH_ORDERS, /FROM system\.tables/));
  ok('clickhouse facts: a refused system.tables keeps the columns, the key, sort and partition columns', t.r.ok && t.r.columns.length === 3 && !('rowEstimate' in t.r) && !('bytes' in t.r) && !('comment' in t.r) && !('lastModified' in t.r)
    && JSON.stringify(t.r.primaryKey) === '{"columns":["order_date"],"enforced":false}' && JSON.stringify(t.r.partition) === '{"columns":["order_date"]}', JSON.stringify(t.r));
  t = await readCh(refusing(CH_ORDERS, /FROM system\.columns/)).catch((e: Error) => ({ h: recorder(CH_ORDERS), r: { ok: false as const, error: e.message } }));
  ok('clickhouse facts: a refused system.columns fails the read (the door turns it into the sentence)', !t.r.ok && /permission denied/.test(t.r.error));
  t = await readCh(byCatalog([]));
  ok('clickhouse facts: no column is no such table', !t.r.ok && t.r.error === 'No such table: orders', JSON.stringify(t.r));
  t = await readCh(byCatalog([[/FROM system\.columns/, [['id', 'UInt64', '', 0, 0, 0]]], [/FROM system\.tables/, [['', '', null, null, 0]]]]));
  ok('clickhouse facts: a view (no rows, no bytes, no key, no partition, an epoch-zero time) says only what it has', t.r.ok && JSON.stringify(Object.keys(t.r).sort()) === '["columns","ok"]', JSON.stringify(t.r));
  t = await readCh(byCatalog([[/FROM system\.columns/, [['id', 'UInt64', '', 0, 0, 0]]], [/FROM system\.tables/, [['', 'tuple()', 'junk', -5, 1e30]]]]));
  ok('clickhouse facts: a junk figure or time is dropped, not repaired', t.r.ok && !('rowEstimate' in t.r) && !('bytes' in t.r) && !('lastModified' in t.r) && !('partition' in t.r), JSON.stringify(t.r));
  t = await readCh(byCatalog([[/FROM system\.columns/, [['a', 'Int8', '', 1, 1, 1], ['b', 'Int8', '', 1, 1, 0], ['c', 'Int8', '', 0, 0, 0]]]]));
  ok('clickhouse facts: a composite key is every flagged column, in the table\'s column order', t.r.ok && t.r.primaryKey?.columns.join() === 'a,b' && t.r.sortKey?.join() === 'a,b' && t.r.columns.map((c) => c.key ?? false).join() === 'true,true,false', JSON.stringify(t.r));

  const ch = byId('clickhouse');
  ok('clickhouse def: tableFacts wired, still not browsable', typeof ch.tableFacts === 'function' && typeof ch.describeTable !== 'function' && !('factsWake' in ch));
}

// The adapter and the real transport: a local server stands in for ClickHouse. SSRF is off here (a desktop process);
// the guarded run is in `guard()`.
async function clickhouseWire(): Promise<void> {
  const PW = 'pw-canary-ch-81f';
  const server = await stub((hit, res) => {
    if (/FROM system\.columns/.test(hit.body)) send(res, compact(['name', 'type', 'comment', 'a', 'b', 'c'], [['order_date', 'Date', `note ${PW}`, 1, 1, 1], ['amount', 'Float64', '', 0, 0, 0]]));
    else if (/FROM system\.tables/.test(hit.body)) send(res, compact(['comment', 'p', 'r', 'b', 't'], [['Orders', 'toYYYYMM(order_date)', '240', '4096', 1714564800]]));
    else send(res, 'unexpected', 400);
  });
  const ch = byId('clickhouse');
  const values = { host: '127.0.0.1', port: server.port, insecureHttp: true, database: 'shop', user: 'reader' };
  const got = await ch.tableFacts!(ctxFor(values, { password: PW }), 'orders');
  ok('clickhouse wire: the facts come back through the real transport', got.ok && got.columns.length === 2 && got.rowEstimate === 240 && got.bytes === 4096 && got.partition?.method === 'toYYYYMM(order_date)' && got.lastModified === '2024-05-01T12:00:00.000Z', JSON.stringify(got));
  ok('clickhouse wire: two requests, one per catalog', server.hits.length === 2 && /FROM system\.columns/.test(server.hits[0].body) && /FROM system\.tables/.test(server.hits[1].body));
  const [a] = server.hits;
  ok('clickhouse wire: the names ride as param_p0 / param_p1 in the URL and never in the statement', a.url.searchParams.get('param_p0') === 'shop' && a.url.searchParams.get('param_p1') === 'orders' && !a.body.includes('orders') && !a.body.includes('shop'), a.url.search);
  ok('clickhouse wire: readonly=2, the row cap, the time cap, the closed-socket cancel, the database', a.url.searchParams.get('readonly') === '2' && a.url.searchParams.get('max_result_rows') === '2001' && Number(a.url.searchParams.get('max_execution_time')) >= 1
    && a.url.searchParams.get('cancel_http_readonly_queries_on_client_close') === '1' && a.url.searchParams.get('database') === 'shop');
  ok('clickhouse wire: the format clause is ours, on its own line', /\nFORMAT JSONCompact$/.test(a.body) && a.body.split('FORMAT').length === 2);
  ok('clickhouse wire: the user and the password go in headers, never the URL or the body', a.headers['x-clickhouse-user'] === 'reader' && a.headers['x-clickhouse-key'] === PW && !a.url.href.includes(PW) && !a.body.includes(PW));

  server.hits.length = 0;
  const slowStub = await stub((hit, res) => {
    const reply = () => send(res, /FROM system\.columns/.test(hit.body) ? compact(['name', 'type', 'comment', 'a', 'b', 'c'], [['id', 'UInt64', '', 0, 0, 0]]) : compact(['c', 'p', 'r', 'b', 't'], [['', '', '1', '2', 0]]));
    if (/FROM system\.columns/.test(hit.body)) setTimeout(reply, 1_600);
    else reply();
  });
  await ch.tableFacts!(ctxFor({ host: '127.0.0.1', port: slowStub.port, insecureHttp: true }, {}, 3_000), 'default.t');
  const [first, second] = slowStub.hits.map((h) => Number(h.url.searchParams.get('max_execution_time')));
  ok('clickhouse wire: the whole read is one budget: the second statement gets what the first left', first === 3 && second >= 1 && second < first, `${first} ${second}`);
  await slowStub.close();

  const failing = await stub((hit, res) => {
    if (/FROM system\.tables/.test(hit.body)) send(res, `Code: 497. DB::Exception: not enough privileges, password ${PW}`, 500);
    else if (/FROM system\.columns/.test(hit.body)) send(res, compact(['name', 'type', 'comment', 'a', 'b', 'c'], [['id', 'UInt64', '', 0, 0, 0]]));
  });
  const partial = await ch.tableFacts!(ctxFor({ host: '127.0.0.1', port: failing.port, insecureHttp: true }, { password: PW }), 'default.t');
  ok('clickhouse wire: a refused system.tables (HTTP 500) costs its field only', partial.ok && partial.columns.length === 1 && !('rowEstimate' in partial), JSON.stringify(partial));
  await failing.close();
  const denied = await stub((_hit, res) => send(res, `Code: 497. DB::Exception: no grants for ${PW}`, 500));
  const refusedRead = await ch.tableFacts!(ctxFor({ host: '127.0.0.1', port: denied.port, insecureHttp: true }, { password: PW }), 'default.t').then((r) => ({ ok: r.ok, error: r.ok ? '' : r.error }), (e: Error) => ({ ok: false, error: e.message }));
  ok('clickhouse wire: a refused system.columns fails the read, and the error holds no secret', !refusedRead.ok && /HTTP 500/.test(refusedRead.error) && !refusedRead.error.includes(PW), refusedRead.error);
  await denied.close();

  // Through the door: the password planted in a column comment is redacted in what the door hands back.
  const viaDoor = await tableFactsRun.readTableFacts('clickhouse', values, { password: PW }, 'orders');
  ok('clickhouse door: a password in a column comment is redacted', viaDoor !== null && viaDoor.ok && viaDoor.facts.columns[0].comment === 'note ***' && !JSON.stringify(viaDoor).includes(PW), JSON.stringify(viaDoor));
  await server.close();
}

// The SSRF guard (server mode from here on, so it runs last). The door checks the typed host; the family's
// transport checks again on every request, so the adapter is guarded on its own even when called around the door.
async function guard(): Promise<void> {
  context.enterServerMode(fs.mkdtempSync(path.join(os.tmpdir(), 'httpfacts-')));
  delete process.env.SSRF_ALLOW;
  const server = await stub((_hit, res) => send(res, compact(['name', 'type', 'comment', 'a', 'b', 'c'], [['id', 'UInt64', '', 0, 0, 0]])));
  const values = { host: '127.0.0.1', port: server.port, insecureHttp: true };

  const refused = await tableFactsRun.readTableFacts('clickhouse', values, {}, 'shop.orders');
  ok('ssrf: the door refuses a loopback ClickHouse before any request', refused !== null && !refused.ok && /^Refused/.test(refused.error) && server.hits.length === 0, JSON.stringify(refused));
  const around = await chQueryError(values);
  ok('ssrf: the adapter alone is refused by the transport, nothing reaches the server', /^Refused/.test(around) && server.hits.length === 0, around);

  process.env.SSRF_ALLOW = '127.0.0.0/8';
  const allowed = await tableFactsRun.readTableFacts('clickhouse', values, {}, 'shop.orders');
  ok('ssrf NEGATIVE CONTROL: SSRF_ALLOW opens the range, and the same read reaches the server', allowed !== null && allowed.ok && allowed.facts.columns[0].name === 'id' && server.hits.length === 2, JSON.stringify(allowed));
  delete process.env.SSRF_ALLOW;
  await server.close();
}
async function chQueryError(values: Record<string, unknown>): Promise<string> {
  try {
    await facts.chQuery(ctxFor(values))('SELECT 1', []);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

(async () => {
  await clickhouseReader();
  await clickhouseWire();
  await guard();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
