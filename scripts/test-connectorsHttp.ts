// Self-check for src/connectors/http.ts — the seven HTTP query engines.
//
// Unlike the database families (postgres/mysql/mssql/oracle), this one needs NO
// live server and NO dependency to be tested for real: it speaks plain HTTP, so
// every request path here is driven against a local http.createServer() stub.
// That is the point of the family being dependency-free, so we use it.
//
// What is genuinely exercised end-to-end: the transport's three caps (rows,
// bytes, wall clock — including that the socket is actually DESTROYED), the
// Trino/Presto nextUri paging loop and its DELETE-on-early-stop, and the
// response shaping of six of the seven engines. Databricks is https-only (it is
// a hosted service and we never disable certificate verification), so its
// shaping is unit-tested through the exported shapeDatabricks instead.
//
// No framework. Plain Node, ok(label, cond, extra), non-zero exit on failure.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const http: typeof import('http') = require('http');

// ponytail: compiled sibling of the .ts source.
const conn: typeof import('../src/connectors/http') = require('../src/connectors/http');
const types: typeof import('../src/connectors/types') = require('../src/connectors/types');

type IncomingMessage = import('http').IncomingMessage;
type ServerResponse = import('http').ServerResponse;
type Ctx = import('../src/connectors/types').ConnectorContext;
type Def = import('../src/connectors/types').ConnectorDef;
type Rows = import('../src/connectors/types').ConnectorRows;
type Err = import('../src/connectors/types').ConnectorError;


// ── stub server ──────────────────────────────────────────────────────────────

interface LoggedReq {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

interface Stub {
  port: number;
  log: LoggedReq[];
  /** Sockets the server saw close — proof the client actually tore one down. */
  closedSockets: number;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string, stub: Stub) => void;

async function startStub(handler: Handler): Promise<Stub> {
  const log: LoggedReq[] = [];
  const stub: Stub = { port: 0, log, closedSockets: 0, close: async () => {} };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      log.push({ method: req.method || '', url: req.url || '', body, headers: req.headers });
      try {
        handler(req, res, body, stub);
      } catch (e) {
        try {
          res.statusCode = 500;
          res.end('stub handler threw');
        } catch {
          /* socket already gone */
        }
      }
    });
    req.on('error', () => {});
  });

  server.on('connection', (s) => {
    s.on('close', () => {
      stub.closedSockets++;
    });
    s.on('error', () => {});
  });
  // A TLS ClientHello arriving at a plain-HTTP server shows up here.
  server.on('clientError', (_e, socket) => {
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  stub.port = typeof addr === 'object' && addr ? addr.port : 0;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return stub;
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  const b = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(b.length) });
  res.end(b);
}

function ctxFor(
  values: Record<string, unknown>,
  secrets: Record<string, string> = {},
  rowLimit = 100,
  timeoutMs = 5_000,
): Ctx {
  return { values, secrets, rowLimit, timeoutMs };
}

function byId(id: string): Def {
  const d = conn.CONNECTORS.find((c) => c.id === id);
  if (!d) throw new Error('no connector ' + id);
  return d;
}

function fieldOf(d: Def, key: string) {
  return d.fields.find((f) => f.key === key);
}

function isRows(r: Rows | Err): r is Rows {
  return r.ok === true;
}

// Every stub-driven test must opt in to plain HTTP — which is itself the proof
// that https is the default.
function stubValues(stub: Stub, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { host: '127.0.0.1', port: stub.port, insecureHttp: true, ...extra };
}

// ── 1. definition shape ──────────────────────────────────────────────────────

const EXPECTED: { id: string; label: string; port?: number }[] = [
  { id: 'clickhouse', label: 'ClickHouse', port: 8443 },
  { id: 'databricks-sql', label: 'Databricks SQL' },
  { id: 'trino', label: 'Trino', port: 8443 },
  { id: 'presto', label: 'Presto', port: 8443 },
  { id: 'elasticsearch', label: 'Elasticsearch', port: 9200 },
  { id: 'opensearch', label: 'OpenSearch', port: 9200 },
  { id: 'druid', label: 'Apache Druid', port: 8888 },
];

function testDefs(): void {
  ok('exactly 7 connectors', conn.CONNECTORS.length === 7, conn.CONNECTORS.length);

  const ids = conn.CONNECTORS.map((c) => c.id);
  ok('ids are unique', new Set(ids).size === ids.length, ids);

  for (const e of EXPECTED) {
    const d = conn.CONNECTORS.find((c) => c.id === e.id);
    ok(`${e.id} exists`, !!d);
    if (!d) continue;
    ok(`${e.id} label is "${e.label}"`, d.label === e.label, d.label);
    ok(`${e.id} readOnly === true`, d.readOnly === true);
    ok(`${e.id} family is http`, d.family === 'http', d.family);
    ok(`${e.id} category is Query engines`, d.category === 'Query engines', d.category);
    ok(`${e.id} has listTables + run`, typeof d.listTables === 'function' && typeof d.run === 'function');
    ok(`${e.id} requires a host`, fieldOf(d, 'host')?.required === true);
    if (e.port !== undefined) {
      ok(`${e.id} default port is ${e.port}`, fieldOf(d, 'port')?.default === e.port, fieldOf(d, 'port')?.default);
    }
  }

  // Every credential field is secret: true, and no non-secret field is named
  // like one. A token landing in the shareable project folder is the failure.
  const CRED_KEYS = ['password', 'token', 'apiKey'];
  for (const d of conn.CONNECTORS) {
    for (const f of d.fields) {
      if (CRED_KEYS.includes(f.key)) {
        ok(`${d.id}.${f.key} is secret:true`, f.secret === true);
        ok(`${d.id}.${f.key} renders as a password input`, f.type === 'password', f.type);
      } else {
        ok(`${d.id}.${f.key} is NOT marked secret`, f.secret !== true);
      }
    }
  }
  ok('databricks token field exists and is secret', fieldOf(byId('databricks-sql'), 'token')?.secret === true);
  ok('elasticsearch apiKey field exists and is secret', fieldOf(byId('elasticsearch'), 'apiKey')?.secret === true);

  // Plain HTTP is an explicit opt-in on the six self-hostable engines, and the
  // help text says why it is dangerous. Databricks is https-only: no opt-in.
  for (const id of ['clickhouse', 'trino', 'presto', 'elasticsearch', 'opensearch', 'druid']) {
    const f = fieldOf(byId(id), 'insecureHttp');
    ok(`${id} exposes the insecureHttp opt-in`, !!f);
    ok(`${id} insecureHttp defaults to off`, f?.default === false, f?.default);
    ok(`${id} insecureHttp is a checkbox`, f?.type === 'checkbox');
    ok(`${id} insecureHttp help warns about clear text`, /clear text/i.test(String(f?.help || '')), f?.help);
  }
  ok('databricks-sql has NO plain-HTTP opt-in', fieldOf(byId('databricks-sql'), 'insecureHttp') === undefined);

  ok('MAX_BYTES matches connectionRun (100MB)', conn.MAX_BYTES === 100 * 1024 * 1024, conn.MAX_BYTES);
}

// ── 2. transport: normal / byte cap / timeout ────────────────────────────────

async function testTransport(): Promise<void> {
  // -- a normal response round-trips
  {
    const stub = await startStub((_req, res) => json(res, { hello: 'world' }));
    const r = await conn.httpRequest({
      url: new URL(`http://127.0.0.1:${stub.port}/x`),
      method: 'GET',
      timeoutMs: 5_000,
    });
    ok('transport: 200 status', r.status === 200, r.status);
    ok('transport: body round-trips', r.body === '{"hello":"world"}', r.body);
    ok('transport: not truncated', r.truncated === false);
    ok('transport: request was logged by the stub', stub.log.length === 1 && stub.log[0].url === '/x');
    await stub.close();
  }

  // -- the byte cap clips the body AND destroys the socket
  {
    const CAP = 4096;
    let writeErrored = false;
    const stub = await startStub((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(64 * 1024, 0x61); // 'a'
      let sent = 0;
      const pump = (): void => {
        try {
          while (sent < 4 * 1024 * 1024) {
            if (res.destroyed || res.writableEnded) return;
            sent += chunk.length;
            if (!res.write(chunk)) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        } catch {
          writeErrored = true; // client hung up mid-write — the point of the test
        }
      };
      res.on('error', () => {
        writeErrored = true;
      });
      pump();
    });

    const before = stub.closedSockets;
    const r = await conn.httpRequest({
      url: new URL(`http://127.0.0.1:${stub.port}/big`),
      method: 'GET',
      timeoutMs: 10_000,
      maxBytes: CAP,
    });
    ok('byte cap: truncated is reported', r.truncated === true);
    ok('byte cap: body is clipped to exactly maxBytes', r.body.length === CAP, r.body.length);
    // Give the server a tick to notice the reset.
    await new Promise((res) => setTimeout(res, 120));
    ok(
      'byte cap: the socket was destroyed (server saw it close / error)',
      stub.closedSockets > before || writeErrored,
      { closed: stub.closedSockets - before, writeErrored },
    );
    await stub.close();
  }

  // -- the wall clock fires and the socket is destroyed
  {
    const stub = await startStub(() => {
      /* deliberately never respond */
    });
    const before = stub.closedSockets;
    const t0 = Date.now();
    let msg = '';
    try {
      await conn.httpRequest({
        url: new URL(`http://127.0.0.1:${stub.port}/hang`),
        method: 'GET',
        timeoutMs: 400,
      });
      msg = '(resolved — should have timed out)';
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    const elapsed = Date.now() - t0;
    ok('timeout: rejected with a timeout message', /timed out/i.test(msg), msg);
    // The real assertion is that this returned at all — a setTimeout without
    // destroy() would leave the request open and hang the test.
    ok('timeout: returned near timeoutMs, did not hang', elapsed < 3_000, elapsed);
    await new Promise((res) => setTimeout(res, 120));
    ok('timeout: the socket was destroyed', stub.closedSockets > before, stub.closedSockets - before);
    await stub.close();
  }
}

// ── 3. https is the default ──────────────────────────────────────────────────

async function testHttpsDefault(): Promise<void> {
  const stub = await startStub((_req, res) => json(res, { meta: [], data: [] }));

  // Same host/port, but WITHOUT the opt-in: the client speaks TLS to a plain
  // HTTP server, which cannot succeed. https is the default, not http.
  const r = await byId('clickhouse').run(
    ctxFor({ host: '127.0.0.1', port: stub.port }, {}, 10, 3_000),
    'SELECT 1',
  );
  ok('https default: a plain-HTTP stub is NOT reached without the opt-in', r.ok === false, r);

  // The same call WITH the opt-in works — so the failure above is the scheme,
  // not the stub.
  const r2 = await byId('clickhouse').run(ctxFor(stubValues(stub), {}, 10, 3_000), 'SELECT 1');
  ok('https default: the opt-in is what enables plain HTTP', r2.ok === true, r2);

  // A pasted http:// host is REJECTED rather than silently downgrading TLS.
  const r3 = await byId('clickhouse').run(
    ctxFor({ host: `http://127.0.0.1:${stub.port}` }, {}, 10, 3_000),
    'SELECT 1',
  );
  ok(
    'https default: a pasted http:// host is rejected without the opt-in',
    r3.ok === false && /plain http is off/i.test((r3 as Err).error),
    r3,
  );

  // Databricks is https-only: the opt-in does not exist and http is refused.
  const r4 = await byId('databricks-sql').run(
    ctxFor({ host: `http://127.0.0.1:${stub.port}`, warehouseId: 'w1' }, { token: 't0ken-value' }, 10, 3_000),
    'SELECT 1',
  );
  ok('https default: databricks refuses a plain-HTTP host', r4.ok === false && /https-only/i.test((r4 as Err).error), r4);

  await stub.close();
}

// ── 4. ClickHouse ────────────────────────────────────────────────────────────

async function testClickHouse(): Promise<void> {
  const stub = await startStub((_req, res) =>
    json(res, {
      meta: [
        { name: 'city', type: 'String' },
        { name: 'n', type: 'UInt64' },
      ],
      data: [
        ['Oslo', 3],
        ['Lima', 7],
      ],
      rows: 2,
    }),
  );

  const d = byId('clickhouse');
  const r = await d.run(ctxFor(stubValues(stub, { database: 'analytics', user: 'reader' }), { password: 'pw' }), 'SELECT city, n FROM t');
  ok('clickhouse: ok', isRows(r), r);
  if (isRows(r)) {
    ok('clickhouse: columns', r.columns.map((c) => c.name).join(',') === 'city,n', r.columns);
    ok('clickhouse: source types kept verbatim', r.columns[1].type === 'UInt64', r.columns[1]);
    ok('clickhouse: rows', JSON.stringify(r.rows) === '[["Oslo",3],["Lima",7]]', r.rows);
    ok('clickhouse: not truncated', r.truncated === false);
  }

  const req = stub.log[0];
  ok('clickhouse: POSTs the SQL as the body', req.method === 'POST' && req.body.startsWith('SELECT city, n FROM t'), req.body);
  ok('clickhouse: appends FORMAT JSONCompact', /FORMAT JSONCompact$/.test(req.body), req.body);
  ok('clickhouse: sets readonly=2 (the read-only guard)', req.url.includes('readonly=2'), req.url);
  ok('clickhouse: sets max_execution_time', /max_execution_time=\d+/.test(req.url), req.url);
  ok('clickhouse: sets max_result_rows', /max_result_rows=\d+/.test(req.url), req.url);
  ok('clickhouse: passes the database', req.url.includes('database=analytics'), req.url);
  ok('clickhouse: sends the user header', req.headers['x-clickhouse-user'] === 'reader', req.headers['x-clickhouse-user']);

  // A user-written FORMAT clause is not doubled up.
  await d.run(ctxFor(stubValues(stub)), 'SELECT 1 FORMAT JSONCompact');
  ok(
    'clickhouse: does not append a second FORMAT clause',
    (stub.log[1].body.match(/FORMAT/gi) || []).length === 1,
    stub.log[1].body,
  );

  // Trailing semicolon stripped.
  await d.run(ctxFor(stubValues(stub)), 'SELECT 1;');
  ok('clickhouse: strips a trailing semicolon', !/;\s*FORMAT/.test(stub.log[2].body), stub.log[2].body);

  await stub.close();
}

// ── 5. rowLimit is enforced and reported ─────────────────────────────────────

async function testRowLimit(): Promise<void> {
  const stub = await startStub((_req, res) =>
    json(res, {
      meta: [{ name: 'n', type: 'UInt64' }],
      data: [[1], [2], [3], [4], [5]],
    }),
  );
  const r = await byId('clickhouse').run(ctxFor(stubValues(stub), {}, 3), 'SELECT n FROM t');
  ok('rowLimit: ok', isRows(r), r);
  if (isRows(r)) {
    ok('rowLimit: rows are capped', r.rows.length === 3, r.rows.length);
    ok('rowLimit: truncated is reported, not trimmed silently', r.truncated === true);
    ok('rowLimit: the kept rows are the first ones', JSON.stringify(r.rows) === '[[1],[2],[3]]', r.rows);
  }

  // Exactly at the cap is NOT truncated.
  const r2 = await byId('clickhouse').run(ctxFor(stubValues(stub), {}, 5), 'SELECT n FROM t');
  ok('rowLimit: exactly at the cap is not flagged truncated', isRows(r2) && r2.truncated === false, r2);
  await stub.close();
}

// ── 6. the byte ceiling at connector level ───────────────────────────────────

// Streams past the real 100MB constant, which proves the ceiling is actually
// wired into the engine calls rather than only available to the transport.
async function testByteCeiling(): Promise<void> {
  let sent = 0;
  let finished = false;
  const LIMIT = conn.MAX_BYTES + 16 * 1024 * 1024;
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(1024 * 1024, 0x7b); // '{' — never valid JSON as a whole
    const pump = (): void => {
      try {
        while (sent < LIMIT) {
          if (res.destroyed || res.writableEnded) return;
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        finished = true;
        res.end();
      } catch {
        /* client cut us off mid-write — exactly what this test asserts */
      }
    };
    res.on('error', () => {});
    pump();
  });

  const before = stub.closedSockets;
  const t0 = Date.now();
  const r = await byId('clickhouse').run(ctxFor(stubValues(stub), {}, 100, 60_000), 'SELECT 1');
  const elapsed = Date.now() - t0;
  ok('byte ceiling: an over-cap response does not silently yield a table', r.ok === false, r);
  ok(
    'byte ceiling: the error names the 100 MB cap',
    r.ok === false && /100 MB/.test((r as Err).error),
    r.ok === false ? (r as Err).error : r,
  );
  // Settle, then prove the connection was actually torn down mid-stream: the
  // server never got to finish its (deliberately larger) body.
  await new Promise((res) => setTimeout(res, 300));
  ok('byte ceiling: the socket was destroyed', stub.closedSockets > before, { closed: stub.closedSockets - before, elapsed });
  ok('byte ceiling: the server never finished writing its oversized body', finished === false, { sent, LIMIT });
  await stub.close();
}

// ── 7. Trino paging ──────────────────────────────────────────────────────────

async function testTrinoPaging(): Promise<void> {
  // Page 1 (the POST): nextUri and ZERO rows — the trap. Page 2: rows + nextUri.
  // Page 3: rows and NO nextUri, which is the only real end of the stream.
  const stub = await startStub((req, res, _body, self) => {
    const base = `http://127.0.0.1:${self.port}`;
    const u = req.url || '';
    if (u.startsWith('/v1/statement') && req.method === 'POST') {
      json(res, { id: 'q1', infoUri: base + '/ui/q1', nextUri: base + '/v1/statement/q1/1' });
    } else if (u === '/v1/statement/q1/1') {
      json(res, {
        id: 'q1',
        nextUri: base + '/v1/statement/q1/2',
        columns: [
          { name: 'k', type: 'varchar' },
          { name: 'v', type: 'bigint' },
        ],
        data: [
          ['a', 1],
          ['b', 2],
        ],
      });
    } else if (u === '/v1/statement/q1/2') {
      json(res, {
        id: 'q1',
        columns: [
          { name: 'k', type: 'varchar' },
          { name: 'v', type: 'bigint' },
        ],
        data: [['c', 3]],
      });
    } else {
      json(res, { error: { message: 'unexpected ' + u } }, 404);
    }
  });

  const r = await byId('trino').run(ctxFor(stubValues(stub, { user: 'reader', catalog: 'hive', schema: 'sales' })), 'SELECT k, v FROM t');
  ok('trino paging: ok', isRows(r), r);
  if (isRows(r)) {
    ok('trino paging: all rows across all pages collected', JSON.stringify(r.rows) === '[["a",1],["b",2],["c",3]]', r.rows);
    ok('trino paging: columns picked up from the first page that has them', r.columns.map((c) => c.name).join(',') === 'k,v', r.columns);
    ok('trino paging: not truncated', r.truncated === false);
  }
  ok('trino paging: the loop terminated after exactly 3 requests', stub.log.length === 3, stub.log.map((l) => l.method + ' ' + l.url));
  ok('trino paging: first request is a POST to /v1/statement', stub.log[0].method === 'POST' && stub.log[0].url === '/v1/statement');
  ok('trino paging: follow-ups are GETs', stub.log[1].method === 'GET' && stub.log[2].method === 'GET');
  ok('trino paging: no DELETE when the stream ended on its own', !stub.log.some((l) => l.method === 'DELETE'));
  ok('trino paging: sends X-Trino-User', stub.log[0].headers['x-trino-user'] === 'reader', stub.log[0].headers['x-trino-user']);
  ok('trino paging: sends X-Trino-Catalog/Schema', stub.log[0].headers['x-trino-catalog'] === 'hive' && stub.log[0].headers['x-trino-schema'] === 'sales');
  ok('trino paging: no X-Presto-* headers leak in', stub.log[0].headers['x-presto-user'] === undefined);

  await stub.close();
}

// ── 8. Trino early stop cancels the query ────────────────────────────────────

async function testTrinoEarlyStop(): Promise<void> {
  // Every page hands back another nextUri — an endless query. rowLimit must
  // stop it AND cancel it, or it keeps running on the cluster.
  let page = 0;
  const deletes: string[] = [];
  const stub = await startStub((req, res, _body, self) => {
    const base = `http://127.0.0.1:${self.port}`;
    if (req.method === 'DELETE') {
      deletes.push(req.url || '');
      res.writeHead(204);
      res.end();
      return;
    }
    page++;
    json(res, {
      id: 'q9',
      nextUri: `${base}/v1/statement/q9/${page + 1}`,
      columns: [{ name: 'n', type: 'bigint' }],
      data: [[page * 10], [page * 10 + 1]],
    });
  });

  const r = await byId('trino').run(ctxFor(stubValues(stub, { user: 'reader' }), {}, 2), 'SELECT n FROM t');
  ok('trino early stop: ok', isRows(r), r);
  if (isRows(r)) {
    ok('trino early stop: rows capped at rowLimit', r.rows.length === 2, r.rows);
    ok('trino early stop: truncated is reported', r.truncated === true);
  }
  ok('trino early stop: a DELETE was issued to cancel the live query', deletes.length === 1, deletes);
  ok('trino early stop: the DELETE targeted the nextUri', deletes[0] === '/v1/statement/q9/2', deletes[0]);
  ok('trino early stop: the paging loop stopped (2 non-DELETE requests)', stub.log.filter((l) => l.method !== 'DELETE').length === 1, stub.log.map((l) => l.method + ' ' + l.url));

  await stub.close();
}

// ── 9. Presto uses X-Presto-* ────────────────────────────────────────────────

async function testPresto(): Promise<void> {
  const stub = await startStub((_req, res) =>
    json(res, { id: 'p1', columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }),
  );
  const r = await byId('presto').run(ctxFor(stubValues(stub, { user: 'reader', catalog: 'hive' })), 'SELECT 1');
  ok('presto: ok', isRows(r) && r.rows.length === 1, r);
  ok('presto: sends X-Presto-User', stub.log[0].headers['x-presto-user'] === 'reader', stub.log[0].headers['x-presto-user']);
  ok('presto: sends X-Presto-Catalog', stub.log[0].headers['x-presto-catalog'] === 'hive');
  ok('presto: does NOT send X-Trino-User', stub.log[0].headers['x-trino-user'] === undefined);
  ok('presto: posts to /v1/statement', stub.log[0].url === '/v1/statement');
  await stub.close();
}

// ── 10. Elasticsearch / OpenSearch / Druid response shaping ──────────────────

async function testElasticsearch(): Promise<void> {
  const closed: string[] = [];
  const stub = await startStub((req, res) => {
    if ((req.url || '').startsWith('/_sql/close')) {
      closed.push(req.url || '');
      json(res, { succeeded: true });
      return;
    }
    json(res, {
      columns: [
        { name: 'host', type: 'keyword' },
        { name: 'bytes', type: 'long' },
      ],
      rows: [
        ['a', 10],
        ['b', 20],
      ],
      cursor: 'CURSOR-TOKEN',
    });
  });

  const r = await byId('elasticsearch').run(ctxFor(stubValues(stub, { user: 'elastic' }), { password: 'pw' }), 'SELECT host, bytes FROM logs');
  ok('elasticsearch: ok', isRows(r), r);
  if (isRows(r)) {
    ok('elasticsearch: columns', r.columns.map((c) => c.name).join(',') === 'host,bytes', r.columns);
    ok('elasticsearch: rows', JSON.stringify(r.rows) === '[["a",10],["b",20]]', r.rows);
    ok('elasticsearch: a cursor means more rows exist → truncated', r.truncated === true);
  }
  ok('elasticsearch: posts to /_sql?format=json', /^\/_sql\?format=json$/.test(stub.log[0].url), stub.log[0].url);
  ok('elasticsearch: sends the query in the body', JSON.parse(stub.log[0].body).query === 'SELECT host, bytes FROM logs');
  ok('elasticsearch: sends fetch_size', typeof JSON.parse(stub.log[0].body).fetch_size === 'number');
  ok('elasticsearch: closes the cursor rather than leaking server state', closed.length === 1, closed);

  // API key takes precedence over user/password.
  await byId('elasticsearch').run(ctxFor(stubValues(stub, { user: 'elastic' }), { password: 'pw', apiKey: 'KEY123' }), 'SELECT 1');
  const auth = String(stub.log[stub.log.length - 1].headers.authorization || '');
  ok('elasticsearch: apiKey wins over basic auth', auth.startsWith('ApiKey '), auth.slice(0, 7));

  await stub.close();
}

async function testOpenSearch(): Promise<void> {
  const stub = await startStub((req, res) => {
    if ((req.url || '').startsWith('/_plugins/_sql/close')) {
      json(res, { succeeded: true });
      return;
    }
    json(res, {
      schema: [
        { name: 'svc', type: 'text' },
        { name: 'cnt', type: 'integer' },
      ],
      datarows: [
        ['api', 5],
        ['web', 6],
      ],
      total: 2,
      size: 2,
    });
  });

  const r = await byId('opensearch').run(ctxFor(stubValues(stub, { user: 'admin' }), { password: 'pw' }), 'SELECT svc, cnt FROM t');
  ok('opensearch: ok', isRows(r), r);
  if (isRows(r)) {
    ok('opensearch: columns from `schema`', r.columns.map((c) => c.name).join(',') === 'svc,cnt', r.columns);
    ok('opensearch: rows from `datarows`', JSON.stringify(r.rows) === '[["api",5],["web",6]]', r.rows);
    ok('opensearch: no cursor → not truncated', r.truncated === false);
  }
  ok('opensearch: posts to /_plugins/_sql', stub.log[0].url.startsWith('/_plugins/_sql'), stub.log[0].url);
  ok('opensearch: sends basic auth', String(stub.log[0].headers.authorization || '').startsWith('Basic '));
  await stub.close();
}

async function testDruid(): Promise<void> {
  const stub = await startStub((_req, res) =>
    json(res, [
      ['ts', 'value'],
      ['STRING', 'LONG'],
      ['2026-01-01', 4],
      ['2026-01-02', 9],
    ]),
  );
  const r = await byId('druid').run(ctxFor(stubValues(stub)), 'SELECT ts, value FROM src');
  ok('druid: ok', isRows(r), r);
  if (isRows(r)) {
    ok('druid: header row becomes columns', r.columns.map((c) => c.name).join(',') === 'ts,value', r.columns);
    ok('druid: typesHeader row becomes types', r.columns[1].type === 'LONG', r.columns[1]);
    ok('druid: data rows start at index 2', JSON.stringify(r.rows) === '[["2026-01-01",4],["2026-01-02",9]]', r.rows);
  }
  const body = JSON.parse(stub.log[0].body);
  ok('druid: posts to /druid/v2/sql (the query-only endpoint)', stub.log[0].url === '/druid/v2/sql', stub.log[0].url);
  ok('druid: never touches the ingestion endpoint', !stub.log.some((l) => l.url.includes('/sql/task')));
  ok('druid: asks for array + header + typesHeader', body.resultFormat === 'array' && body.header === true && body.typesHeader === true, body);
  ok('druid: passes a query timeout in the context', typeof body.context?.timeout === 'number', body.context);
  ok('druid: mints a sqlQueryId so it can be cancelled', typeof body.context?.sqlQueryId === 'string' && body.context.sqlQueryId.startsWith('ordinate-'), body.context);
  await stub.close();
}

// Druid cancels a timed-out query rather than leaving it on the broker.
async function testDruidCancel(): Promise<void> {
  const deletes: string[] = [];
  const stub = await startStub((req, res) => {
    if (req.method === 'DELETE') {
      deletes.push(req.url || '');
      res.writeHead(200);
      res.end();
      return;
    }
    /* never respond to the query itself */
  });
  const r = await byId('druid').run(ctxFor(stubValues(stub), {}, 100, 400), 'SELECT 1');
  ok('druid cancel: a timeout is an error, not a silent partial', r.ok === false && /timed out/i.test((r as Err).error), r);
  await new Promise((res) => setTimeout(res, 200));
  ok('druid cancel: a DELETE cancelled the running query', deletes.length === 1 && deletes[0].startsWith('/druid/v2/sql/ordinate-'), deletes);
  await stub.close();
}

// ── 11. listTables ───────────────────────────────────────────────────────────

async function testListTables(): Promise<void> {
  const stub = await startStub((_req, res) =>
    json(res, {
      meta: [
        { name: 'table_schema', type: 'String' },
        { name: 'table_name', type: 'String' },
      ],
      data: [
        ['public', 'orders'],
        ['public', 'users'],
      ],
    }),
  );
  const r = await byId('clickhouse').listTables(ctxFor(stubValues(stub)));
  ok('listTables: ok', r.ok === true, r);
  if (r.ok) {
    ok('listTables: mapped to {schema,name}', JSON.stringify(r.tables) === '[{"schema":"public","name":"orders"},{"schema":"public","name":"users"}]', r.tables);
  }
  ok('listTables: queries system.tables, not a write statement', /system\.tables/i.test(stub.log[0].body), stub.log[0].body);
  await stub.close();

  // Column NAMES win over position: OpenSearch's SHOW TABLES puts the catalog
  // first, so positional guessing would report the catalog as the schema.
  const stub2 = await startStub((_req, res) =>
    json(res, {
      schema: [
        { name: 'TABLE_CAT', type: 'keyword' },
        { name: 'TABLE_NAME', type: 'keyword' },
        { name: 'TABLE_TYPE', type: 'keyword' },
      ],
      datarows: [['opensearch', 'logs-2026', 'BASE TABLE']],
    }),
  );
  const r2 = await byId('opensearch').listTables(ctxFor(stubValues(stub2)));
  ok('listTables: resolves the name column by NAME, not position', r2.ok === true && r2.tables[0].name === 'logs-2026', r2);
  await stub2.close();
}

// ── 12. secrets never ride out in an error ───────────────────────────────────

async function testSecretRedaction(): Promise<void> {
  const TOKEN = 'dapi-super-secret-bearer-token-1234';

  // safeError itself, direct.
  const direct = types.safeError(new Error(`auth failed for Bearer ${TOKEN}`), { token: TOKEN });
  ok('safeError: redacts a bearer token from secrets', !direct.includes(TOKEN) && direct.includes('***'), direct);
  ok('safeError: redacts credentials embedded in a URL', types.safeError(new Error('at https://u:pw@host/x')).includes('//***:***@'), types.safeError(new Error('at https://u:pw@host/x')));

  // And through a real connector, where the engine echoes the header back in
  // its error body — which is exactly what these engines do.
  const stub = await startStub((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `bad query; authorization: Bearer ${TOKEN}` }));
  });
  const r = await byId('elasticsearch').run(
    ctxFor(stubValues(stub, { user: 'elastic' }), { apiKey: TOKEN }),
    'SELECT nope FROM missing',
  );
  ok('connector error: is an error', r.ok === false, r);
  if (r.ok === false) {
    ok('connector error: the token is NOT in the message', !r.error.includes(TOKEN), r.error);
    ok('connector error: it was redacted, not just dropped', r.error.includes('***'), r.error);
    ok('connector error: the useful part survives', /bad query/.test(r.error), r.error);
    ok('connector error: bounded length', r.error.length <= 500, r.error.length);
  }
  await stub.close();
}

// ── 13. Databricks shaping (https-only → unit-tested directly) ───────────────

function testDatabricksShaping(): void {
  const ctx = ctxFor({}, { token: 'tok' }, 2);
  const good = conn.shapeDatabricks(
    {
      status: { state: 'SUCCEEDED' },
      manifest: {
        truncated: false,
        schema: {
          columns: [
            { name: 'a', type_text: 'STRING' },
            { name: 'b', type_text: 'BIGINT' },
          ],
        },
      },
      result: { data_array: [['x', 1]] },
    },
    ctx,
  );
  ok('databricks: shapes a SUCCEEDED response', isRows(good), good);
  if (isRows(good)) {
    ok('databricks: columns from manifest.schema.columns', good.columns.map((c) => c.name).join(',') === 'a,b', good.columns);
    ok('databricks: type_text kept verbatim', good.columns[1].type === 'BIGINT');
    ok('databricks: rows from result.data_array', JSON.stringify(good.rows) === '[["x",1]]', good.rows);
    ok('databricks: not truncated', good.truncated === false);
  }

  const serverTrunc = conn.shapeDatabricks(
    { status: { state: 'SUCCEEDED' }, manifest: { truncated: true, schema: { columns: [{ name: 'a', type_text: 'INT' }] } }, result: { data_array: [[1]] } },
    ctx,
  );
  ok('databricks: manifest.truncated is propagated', isRows(serverTrunc) && serverTrunc.truncated === true, serverTrunc);

  const failed = conn.shapeDatabricks(
    { status: { state: 'FAILED', error: { message: 'TABLE_OR_VIEW_NOT_FOUND with token tok' } } },
    ctx,
  );
  ok('databricks: a non-SUCCEEDED state is an error', failed.ok === false, failed);
  ok('databricks: the failure message is redacted', failed.ok === false && !failed.error.includes('tok') && failed.error.includes('***'), failed);

  const overCap = conn.shapeDatabricks(
    { status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'a', type_text: 'INT' }] } }, result: { data_array: [[1], [2], [3]] } },
    ctx,
  );
  ok('databricks: rowLimit applies on top of row_limit', isRows(overCap) && overCap.rows.length === 2 && overCap.truncated === true, overCap);
}

// ── 14. validation guards ────────────────────────────────────────────────────

async function testGuards(): Promise<void> {
  const missingHost = await byId('trino').run(ctxFor({ user: 'u' }), 'SELECT 1');
  ok('guard: missing host is a clean error', missingHost.ok === false && /host is required/i.test((missingHost as Err).error), missingHost);

  const badPort = await byId('trino').run(ctxFor({ host: 'h', port: 70000, user: 'u' }), 'SELECT 1');
  ok('guard: out-of-range port is rejected', badPort.ok === false && /port/i.test((badPort as Err).error), badPort);

  const noUser = await byId('trino').run(ctxFor({ host: 'h', user: '' }), 'SELECT 1');
  ok('guard: trino requires a user', noUser.ok === false && /user is required/i.test((noUser as Err).error), noUser);

  const emptySql = await byId('druid').run(ctxFor({ host: 'h' }), '   ');
  ok('guard: empty SQL is rejected before any socket opens', emptySql.ok === false && /no query/i.test((emptySql as Err).error), emptySql);

  const noWarehouse = await byId('databricks-sql').run(ctxFor({ host: 'h' }, { token: 't' }), 'SELECT 1');
  ok('guard: databricks requires a warehouse id', noWarehouse.ok === false && /warehouse/i.test((noWarehouse as Err).error), noWarehouse);

  const noToken = await byId('databricks-sql').run(ctxFor({ host: 'h', warehouseId: 'w' }), 'SELECT 1');
  ok('guard: databricks requires a token', noToken.ok === false && /token/i.test((noToken as Err).error), noToken);

  const weirdScheme = await byId('druid').run(ctxFor({ host: 'ftp://h' }), 'SELECT 1');
  ok('guard: a non-http scheme in the host is rejected', weirdScheme.ok === false && /hostname/i.test((weirdScheme as Err).error), weirdScheme);
}

// ── 15. nextUri is re-anchored on OUR origin ─────────────────────────────────

// A coordinator behind a proxy returns an internal hostname; honouring it
// verbatim would be an SSRF and a silent TLS downgrade in one.
async function testNextUriRebase(): Promise<void> {
  let hits = 0;
  const stub = await startStub((req, res) => {
    hits++;
    if (req.method === 'POST') {
      // Deliberately hostile: a different host AND a downgrade to plain http.
      json(res, { id: 'q', nextUri: 'http://evil.example.invalid:1/v1/statement/q/1' });
    } else {
      json(res, { id: 'q', columns: [{ name: 'n', type: 'bigint' }], data: [[42]] });
    }
  });
  const r = await byId('trino').run(ctxFor(stubValues(stub, { user: 'u' })), 'SELECT 1');
  ok('nextUri: a foreign host in nextUri is re-anchored on our origin', isRows(r) && JSON.stringify(r.rows) === '[[42]]', r);
  ok('nextUri: the follow-up came back to the stub', hits === 2, hits);
  ok('nextUri: the path/query from the server is preserved', stub.log[1].url === '/v1/statement/q/1', stub.log[1].url);
  await stub.close();
}

// ── run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  testDefs();
  await testTransport();
  await testHttpsDefault();
  await testClickHouse();
  await testRowLimit();
  await testByteCeiling();
  await testTrinoPaging();
  await testTrinoEarlyStop();
  await testPresto();
  await testElasticsearch();
  await testOpenSearch();
  await testDruid();
  await testDruidCancel();
  await testListTables();
  await testSecretRedaction();
  testDatabricksShaping();
  await testGuards();
  await testNextUriRebase();

  if (failureCount()) {
    console.error(`\n${failureCount()} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll connectors/http checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
