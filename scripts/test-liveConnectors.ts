// Self-check for the Live capability of the three v1 warehouses already in the
// registry (docs/live-data/00-plan.md L2.1, D4): Redshift (`$n`), Databricks
// SQL (named `parameters`) and ClickHouse (`{p0:Type}` + `param_p0=`).
//
// The one property every check here serves: a VALUE NEVER BECOMES SQL TEXT.
// An adversarial literal suite (quotes, backslashes, unicode quotes, `${}`,
// a comment opener, a statement terminator, NUL) goes through each dialect's
// request builder, and the statement that would be sent is compared with the
// statement the compiler wrote — byte for byte — while the literal turns up
// only in the parameter slot. Then the transport:
//
//   • checkParams: the shared gate (and its negative controls — NaN, a wrong
//     name, a type mismatch, a local-offset timestamp, too many).
//   • ClickHouse over a real socket to a plain-HTTP stub: the URL carries the
//     caps and the params, the body carries the statement, and an abort
//     DESTROYS the socket (the server sees it close) and answers "Cancelled".
//   • Databricks (https-only, so the loop is driven through its injected
//     transport): submit → poll → rows; abort → `…/cancel` is POSTed; a blown
//     budget → cancel + a timeout; a chunk link off the statement is refused;
//     a reply with no status is an ERROR, never an empty result (D6).
//   • Redshift against a REAL Postgres when DATABASE_URL is set (the portable
//     subset L2.8 builds on): adversarial literals round-trip exactly through
//     `$n`, the row cap clips and says so, and an abort cancels the backend
//     (pg_cancel_backend) — the statement is gone from pg_stat_activity.
//   • A secret canary: a planted password never appears in an error.
//
//   npm run build:ts && node scripts/test-liveConnectors.js
//   DATABASE_URL=postgres://… node scripts/test-liveConnectors.js   # + the Redshift run

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const http: typeof import('http') = require('http');
const params: typeof import('../src/connectors/liveParams') = require('../src/connectors/liveParams');
const liveHttp: typeof import('../src/connectors/liveHttp') = require('../src/connectors/liveHttp');
const pg: typeof import('../src/connectors/postgres') = require('../src/connectors/postgres');
const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');

type Ctx = import('../src/connectors/types').ConnectorContext;
type LiveParam = import('../src/connectors/types').LiveParam;
type HttpRequestOptions = import('../src/connectors/httpShared').HttpRequestOptions;
type JsonResult = import('../src/connectors/httpShared').JsonResult;

const CANARY = 'pw-CANARY-91c3-never-shown';

/** Values a hostile filter could carry. Each must reach the warehouse as data. */
const ADVERSARIAL: string[] = [
  "O'Brien",
  "x' OR '1'='1",
  "'); DROP TABLE orders; --",
  'back\\slash \\\' \\" end\\',
  'tab\there\nnewline\rreturn',
  '‘curly’ “quotes” ＇fullwidth＇',
  '${process.exit(1)} {p0:String} :p0 $1 ? @p0',
  '/* open comment',
  '-- line comment',
  'semi; colon',
  'NUL\u0000inside',
  '🙂 émoji Ελληνικά 中文',
];

const ctxFor = (values: Record<string, unknown>, secrets: Record<string, string> = {}, rowLimit = 100, timeoutMs = 5_000, signal?: AbortSignal): Ctx =>
  ({ values, secrets, rowLimit, timeoutMs, ...(signal ? { signal } : {}) });

const text = (v: string, i = 0): LiveParam => ({ name: `p${i}`, type: 'text', value: v });

(async () => {
  // ── checkParams ────────────────────────────────────────────────────────────
  const good: LiveParam[] = [
    { name: 'p0', type: 'text', value: 'a' },
    { name: 'p1', type: 'number', value: -0.5 },
    { name: 'p2', type: 'boolean', value: false },
    { name: 'p3', type: 'date', value: '2024-02-29' },
    { name: 'p4', type: 'timestamp', value: '2024-02-29T23:59:59.123Z' },
    { name: 'p5', type: 'text', value: null },
  ];
  const checked = params.checkParams(good);
  ok('checkParams: a well-formed list passes, unchanged', Array.isArray(checked) && JSON.stringify(checked) === JSON.stringify(good), JSON.stringify(checked));
  const refused = (label: string, list: unknown): void => {
    const r = params.checkParams(list);
    ok(`checkParams refuses ${label}`, !Array.isArray(r) && (r as { ok: boolean }).ok === false, JSON.stringify(r));
  };
  refused('NaN (negative control)', [{ name: 'p0', type: 'number', value: NaN }]);
  refused('Infinity', [{ name: 'p0', type: 'number', value: Infinity }]);
  refused('a name out of order', [{ name: 'p1', type: 'text', value: 'a' }]);
  refused('a name that is not p<i>', [{ name: 'p0; drop', type: 'text', value: 'a' }]);
  refused('a number typed as text', [{ name: 'p0', type: 'text', value: 7 }]);
  refused('text typed as a number', [{ name: 'p0', type: 'number', value: '7' }]);
  refused('an unknown type', [{ name: 'p0', type: 'json', value: '{}' }]);
  refused('a local-offset timestamp', [{ name: 'p0', type: 'timestamp', value: '2024-01-01T00:00:00+02:00' }]);
  refused('an impossible date', [{ name: 'p0', type: 'date', value: '2024-13-45' }]);
  refused('more than the cap', Array.from({ length: params.MAX_LIVE_PARAMS + 1 }, (_, i) => text('a', i)));
  refused('a non-list', { p0: 'a' });

  // ── Redshift: the text never carries a value ───────────────────────────────
  const RS_SQL = 'select region, sum(sales) as s from public.orders where region = $1::text group by region order by s desc, region';
  for (const lit of ADVERSARIAL) {
    const b = pg.redshiftBound(RS_SQL, [text(lit)], 50);
    const shown = JSON.stringify(lit).slice(0, 40);
    ok(`redshift: ${shown} → the statement is exactly the compiler's, wrapped`,
      !('ok' in b) && b.text === `select * from (\n${RS_SQL}\n) as _ord_live limit 51`, JSON.stringify(b));
    ok(`redshift: ${shown} → travels only as $1`, !('ok' in b) && b.values.length === 1 && Object.is(b.values[0], lit));
  }
  const rsSemi = pg.redshiftBound(`${RS_SQL};  `, [text('a')], 10);
  ok('redshift: a trailing semicolon cannot end the statement before the cap', !('ok' in rsSemi) && !rsSemi.text.includes(';'), JSON.stringify(rsSemi));
  const rsComment = pg.redshiftBound(`${RS_SQL} -- trailing`, [text('a')], 10);
  ok('redshift: a trailing comment cannot swallow the cap (own line, F3)', !('ok' in rsComment) && /\n\) as _ord_live limit 11$/.test(rsComment.text));
  ok('redshift: a bad parameter is refused before any socket', 'ok' in pg.redshiftBound(RS_SQL, [{ name: 'p0', type: 'number', value: NaN }], 10));

  // ── ClickHouse: the request ────────────────────────────────────────────────
  const CH_SQL = 'SELECT region, CAST(sum(sales) AS Float64) AS s FROM orders WHERE region = {p0:String} AND day >= {p1:Date} GROUP BY region ORDER BY s DESC, region';
  for (const lit of ADVERSARIAL) {
    const r = liveHttp.clickhouseBoundRequest(ctxFor({ host: 'ch.example.com' }), CH_SQL, [text(lit), { name: 'p1', type: 'date', value: '2024-01-01' }]);
    const shown = JSON.stringify(lit).slice(0, 40);
    ok(`clickhouse: ${shown} → the body is the compiler's statement`, !('ok' in r) && r.body === `${CH_SQL}\nFORMAT JSONCompact`, JSON.stringify(r));
    if ('ok' in r) continue;
    const sent = r.url.searchParams.get('param_p0');
    ok(`clickhouse: ${shown} → travels only as param_p0, escaped for TabSeparated`, sent === liveHttp.clickhouseParamValue(text(lit)) && !r.body.includes(lit));
  }
  ok('clickhouse: a backslash, tab, newline and quote are escaped',
    liveHttp.clickhouseParamValue(text("a\\b\tc\nd'e")) === "a\\\\b\\tc\\nd\\'e", liveHttp.clickhouseParamValue(text("a\\b\tc\nd'e")));
  ok('clickhouse: NULL is \\N, a boolean 1/0, a timestamp UTC wall clock',
    liveHttp.clickhouseParamValue({ name: 'p0', type: 'text', value: null }) === '\\N'
      && liveHttp.clickhouseParamValue({ name: 'p0', type: 'boolean', value: true }) === '1'
      && liveHttp.clickhouseParamValue({ name: 'p0', type: 'timestamp', value: '2024-01-02T03:04:05.678Z' }) === '2024-01-02 03:04:05.678');
  const chReq = liveHttp.clickhouseBoundRequest(ctxFor({ host: 'ch.example.com', database: 'analytics' }, { password: CANARY }, 25, 9_000), CH_SQL, [text('x'), { name: 'p1', type: 'date', value: '2024-01-01' }]);
  if (!('ok' in chReq)) {
    const q = chReq.url.searchParams;
    ok('clickhouse: readonly=2, the +1 row cap, break on overflow, the time cap',
      q.get('readonly') === '2' && q.get('max_result_rows') === '26' && q.get('result_overflow_mode') === 'break' && q.get('max_execution_time') === '9');
    ok('clickhouse: a hang-up stops the query (cancel_http_readonly_queries_on_client_close=1)', q.get('cancel_http_readonly_queries_on_client_close') === '1');
    ok('clickhouse: https by default, the password in a header, never the URL', chReq.url.protocol === 'https:' && chReq.headers['x-clickhouse-key'] === CANARY && !chReq.url.href.includes(CANARY));
  }

  // ── ClickHouse over a real socket ──────────────────────────────────────────
  let mode: 'rows' | 'hang' | 'echo' = 'rows';
  const seen: { url: string; body: string }[] = [];
  let closed = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url || '', body: Buffer.concat(chunks).toString('utf8') });
      if (mode === 'hang') return; // never answers: only the client's abort ends it
      if (mode === 'echo') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`Code: 62. Syntax error near ${req.headers['x-clickhouse-key']}`);
        return;
      }
      const body = JSON.stringify({ meta: [{ name: 'region', type: 'String' }, { name: 's', type: 'Float64' }], data: [['r1', 3], ['r2', 2], ['r3', 1]] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  server.on('connection', (s) => s.on('close', () => { closed++; }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const chValues = { host: '127.0.0.1', port, insecureHttp: true };
  const ch = registry.getConnector('clickhouse');
  const chRun = (c: Ctx, p: LiveParam[] = [text("O'Brien")]) => ch!.live!.runBound(c, 'SELECT region, s FROM t WHERE region = {p0:String}', p);
  const rows = await chRun(ctxFor(chValues, {}, 2));
  ok('clickhouse runBound: rows, capped at the row limit and reported', rows.ok && rows.rows.length === 2 && rows.truncated === true, JSON.stringify(rows));
  ok('clickhouse runBound: the literal crossed the wire only as a parameter', seen[0].url.includes('param_p0=') && !seen[0].body.includes("O'Brien"), JSON.stringify(seen[0]));
  mode = 'hang';
  const ac = new AbortController();
  const before = closed;
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 150);
  const aborted = await chRun(ctxFor(chValues, {}, 10, 20_000, ac.signal));
  await new Promise((r) => setTimeout(r, 50));
  ok('clickhouse runBound: an abort answers "Cancelled" at once', !aborted.ok && aborted.error === 'Cancelled' && Date.now() - t0 < 3_000, JSON.stringify(aborted));
  ok('clickhouse runBound: …and the socket is destroyed (the server saw it close)', closed > before, `${before} → ${closed}`);
  const pre = new AbortController();
  pre.abort();
  const n = seen.length;
  const early = await chRun(ctxFor(chValues, {}, 10, 5_000, pre.signal));
  ok('clickhouse runBound: an already-aborted call sends nothing', !early.ok && seen.length === n);
  mode = 'echo';
  const echoed = await chRun(ctxFor(chValues, { password: CANARY }, 10));
  ok('clickhouse runBound: a server error echoing the password is redacted (canary)', !echoed.ok && !echoed.error.includes(CANARY) && echoed.error.includes('***'), JSON.stringify(echoed));
  const badParam = await chRun(ctxFor(chValues), [{ name: 'p0', type: 'number', value: NaN }]);
  ok('clickhouse runBound: a bad parameter is refused before any request', !badParam.ok && seen.length === n + 1);
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // ── Databricks: the request ────────────────────────────────────────────────
  const DB_SQL = 'SELECT region, CAST(sum(sales) AS DOUBLE) AS s FROM main.sales.orders WHERE region = :p0 AND amount > :p1 GROUP BY region ORDER BY s DESC, region';
  const dbValues = { host: 'dbc-1.cloud.databricks.com', warehouseId: 'abc123', catalog: 'main' };
  for (const lit of ADVERSARIAL) {
    const r = liveHttp.databricksBoundRequest(ctxFor(dbValues, { token: CANARY }), DB_SQL, [text(lit), { name: 'p1', type: 'number', value: 10 }]);
    const shown = JSON.stringify(lit).slice(0, 40);
    if ('ok' in r) {
      ok(`databricks: ${shown} builds`, false, JSON.stringify(r));
      continue;
    }
    ok(`databricks: ${shown} → the statement is the compiler's`, r.payload.statement === DB_SQL);
    const ps = r.payload.parameters as { name: string; type: string; value?: string }[];
    ok(`databricks: ${shown} → travels only as a STRING parameter`, ps[0].name === 'p0' && ps[0].type === 'STRING' && ps[0].value === lit && ps[1].type === 'DOUBLE' && ps[1].value === '10');
  }
  const dbNull = liveHttp.databricksParam({ name: 'p0', type: 'date', value: null });
  ok('databricks: NULL is a parameter without a value', dbNull.type === 'DATE' && !('value' in dbNull), JSON.stringify(dbNull));
  const dbReq = liveHttp.databricksBoundRequest(ctxFor(dbValues, { token: CANARY }, 40), DB_SQL, [text('a'), { name: 'p1', type: 'number', value: 1 }]);
  if (!('ok' in dbReq)) {
    ok('databricks: asynchronous submit (0s), the +1 row cap, inline JSON', dbReq.payload.wait_timeout === '0s' && dbReq.payload.row_limit === 41 && dbReq.payload.disposition === 'INLINE');
    ok('databricks: https only; the token in the header, never the payload', dbReq.base.protocol === 'https:' && dbReq.headers.authorization === `Bearer ${CANARY}` && !JSON.stringify(dbReq.payload).includes(CANARY));
  }
  ok('databricks: a pasted http:// host is refused', 'ok' in liveHttp.databricksBoundRequest(ctxFor({ ...dbValues, host: 'http://dbc-1.cloud.databricks.com' }, { token: 't' }), DB_SQL, []));

  // ── Databricks: the loop, through its injected transport ──────────────────
  const succeeded = (rowsOut: unknown[][], link?: string) => ({
    statement_id: 'stmt-1', status: { state: 'SUCCEEDED' },
    manifest: { schema: { columns: [{ name: 'region', type_text: 'STRING' }, { name: 's', type_text: 'DOUBLE' }] } },
    result: { data_array: rowsOut, ...(link ? { next_chunk_internal_link: link } : {}) },
  });
  const fake = (script: (opts: HttpRequestOptions, i: number) => unknown) => {
    const calls: HttpRequestOptions[] = [];
    const fn = async (_c: Ctx, opts: HttpRequestOptions): Promise<JsonResult> => {
      calls.push(opts);
      const out = script(opts, calls.length - 1);
      return out && typeof out === 'object' && 'ok' in (out as object) && (out as { ok: unknown }).ok === false
        ? (out as JsonResult)
        : { ok: true, json: out, clipped: false };
    };
    return { calls, fn };
  };
  const dbCtx = (rowLimit = 100, timeoutMs = 5_000, signal?: AbortSignal) => ctxFor(dbValues, { token: 'tok' }, rowLimit, timeoutMs, signal);
  const flow = fake((o, i) => (i === 0 ? { statement_id: 'stmt-1', status: { state: 'PENDING' } } : i === 1 ? { statement_id: 'stmt-1', status: { state: 'RUNNING' } } : succeeded([['r1', '3']])));
  const got = await liveHttp.databricksRunBound(dbCtx(), DB_SQL, [text('a'), { name: 'p1', type: 'number', value: 1 }], flow.fn);
  ok('databricks: submit → poll → rows', got.ok && got.rows.length === 1 && flow.calls.length === 3, JSON.stringify(got));
  ok('databricks: polls the statement by its id, on our host', flow.calls[1].method === 'GET' && flow.calls[1].url.href === 'https://dbc-1.cloud.databricks.com/api/2.0/sql/statements/stmt-1');
  const ac2 = new AbortController();
  const hanging = fake(() => ({ statement_id: 'stmt-2', status: { state: 'RUNNING' } }));
  setTimeout(() => ac2.abort(), 120);
  const stopped = await liveHttp.databricksRunBound(dbCtx(100, 20_000, ac2.signal), DB_SQL, [], hanging.fn);
  const cancelCall = hanging.calls.find((c) => c.url.pathname.endsWith('/cancel'));
  ok('databricks: an abort answers "Cancelled"', !stopped.ok && stopped.error === 'Cancelled', JSON.stringify(stopped));
  ok('databricks: …and POSTs …/statements/<id>/cancel (no warehouse left running)', !!cancelCall && cancelCall.method === 'POST' && cancelCall.url.pathname === '/api/2.0/sql/statements/stmt-2/cancel');
  const slow = fake(() => ({ statement_id: 'stmt-3', status: { state: 'PENDING' } }));
  const timedOut = await liveHttp.databricksRunBound(dbCtx(100, 600), DB_SQL, [], slow.fn);
  ok('databricks: a blown budget cancels and says so', !timedOut.ok && /timed out/.test(timedOut.error) && slow.calls.some((c) => c.url.pathname.endsWith('/stmt-3/cancel')), JSON.stringify(timedOut));
  const failed = fake(() => ({ statement_id: 'stmt-4', status: { state: 'FAILED', error: { message: 'PARSE_SYNTAX_ERROR' } } }));
  const failedR = await liveHttp.databricksRunBound(dbCtx(), DB_SQL, [], failed.fn);
  ok('databricks: a failed statement is an error', !failedR.ok && /FAILED: PARSE_SYNTAX_ERROR/.test(failedR.error));
  const blank = fake(() => ({ statement_id: 'stmt-5' }));
  const blankR = await liveHttp.databricksRunBound(dbCtx(), DB_SQL, [], blank.fn);
  ok('databricks: a reply with no status is an ERROR, never an empty result (D6)', !blankR.ok, JSON.stringify(blankR));
  const noId = fake(() => ({}));
  ok('databricks: …nor is a reply with no statement at all', !(await liveHttp.databricksRunBound(dbCtx(), DB_SQL, [], noId.fn)).ok);
  const chunked = fake((o, i) => (i === 0 ? succeeded([['a', '1']], '/api/2.0/sql/statements/stmt-1/result/chunks/1') : { data_array: [['b', '2']] }));
  const chunkR = await liveHttp.databricksRunBound(dbCtx(), DB_SQL, [], chunked.fn);
  ok('databricks: result chunks are followed', chunkR.ok && chunkR.rows.length === 2 && !chunkR.truncated, JSON.stringify(chunkR));
  const foreign = fake(() => succeeded([['a', '1']], 'https://evil.example/steal'));
  const foreignR = await liveHttp.databricksRunBound(dbCtx(), DB_SQL, [], foreign.fn);
  ok('databricks: a chunk link off this statement is never followed — reported as a clip', foreignR.ok && foreignR.truncated && foreign.calls.length === 1, JSON.stringify(foreignR));

  // ── Redshift against a real Postgres (the portable subset) ─────────────────
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('skip redshift-on-postgres: no DATABASE_URL');
  } else {
    const u = new URL(url);
    const rs = registry.getConnector('amazon-redshift');
    const rsCtx = (rowLimit = 100, timeoutMs = 10_000, signal?: AbortSignal): Ctx => ctxFor(
      { host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user: decodeURIComponent(u.username), ssl: false },
      { password: decodeURIComponent(u.password) }, rowLimit, timeoutMs, signal);
    const ROUND = 'select $1::text as t, $2::double precision as n, $3::boolean as b, $4::date as d, $5::text as z';
    let roundTrips = 0;
    for (const lit of ADVERSARIAL.filter((x) => !x.includes('\u0000'))) {
      const r = await rs!.live!.runBound(rsCtx(), ROUND, [text(lit), { name: 'p1', type: 'number', value: -0.25 }, { name: 'p2', type: 'boolean', value: true }, { name: 'p3', type: 'date', value: '2024-02-29' }, { name: 'p4', type: 'text', value: null }]);
      if (r.ok && r.rows.length === 1 && r.rows[0][0] === lit && r.rows[0][1] === -0.25 && r.rows[0][2] === true && r.rows[0][4] === null) roundTrips++;
      else console.error('     round trip failed for', JSON.stringify(lit), JSON.stringify(r));
    }
    ok(`redshift on Postgres: every adversarial literal round-trips exactly through $n (${roundTrips})`, roundTrips === ADVERSARIAL.length - 1);
    const nul = await rs!.live!.runBound(rsCtx(), 'select $1::text as t', [text('NUL\u0000inside')]);
    ok('redshift on Postgres: a NUL is the server\'s loud refusal, not an injection', !nul.ok, JSON.stringify(nul));
    const capped = await rs!.live!.runBound(rsCtx(3), 'select g from generate_series(1, 10) as g order by g', []);
    ok('redshift on Postgres: the row cap clips, says so, and keeps the compiled order', capped.ok && capped.truncated && JSON.stringify(capped.rows) === '[[1],[2],[3]]', JSON.stringify(capped));
    const ac3 = new AbortController();
    const tag = `ordinate_live_cancel_${Date.now()}`;
    setTimeout(() => ac3.abort(), 400);
    const t1 = Date.now();
    const cancelled = await rs!.live!.runBound(rsCtx(10, 30_000, ac3.signal), `select pg_sleep(20), $1::text as ${tag}`, [text('x')]);
    const took = Date.now() - t1;
    ok('redshift on Postgres: an abort answers "Cancelled" in well under the sleep', !cancelled.ok && cancelled.error === 'Cancelled' && took < 8_000, `${took} ms ${JSON.stringify(cancelled)}`);
    const { Client } = require('pg') as typeof import('pg');
    const probe = new Client({ connectionString: url });
    await probe.connect();
    const still = await probe.query(`select count(*)::int as n from pg_stat_activity where query like $1 and state = 'active' and pid <> pg_backend_pid()`, [`%${tag}%`]);
    await probe.end();
    ok('redshift on Postgres: …and the backend stopped (pg_cancel_backend): nothing left running', still.rows[0].n === 0, JSON.stringify(still.rows));
    // A role that does not exist fails whether the server trusts loopback or asks for the password.
    const wrongPw = await rs!.live!.runBound(ctxFor({ host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user: `nobody_${process.pid}`, ssl: false }, { password: CANARY }, 10, 5_000), 'select 1', []);
    ok('redshift on Postgres: a failed sign-in error carries no password (canary)', !wrongPw.ok && !wrongPw.error.includes(CANARY), JSON.stringify(wrongPw));
  }

  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
