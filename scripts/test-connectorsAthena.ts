// Self-check for the Amazon Athena connector (src/connectors/athena.ts, awsSign.ts).
// The API is HTTPS-only, so — the Snowflake precedent — the protocol runs against a
// FAKE transport answering by X-Amz-Target; the real socket layer is the Snowflake
// transport, which has its own suite (test-connectorsSnowflakeHttp).
//
//   1. SigV4 against AWS's published test vectors, and every request re-verified
//   2. the form: region, key id, secret, result location; the China endpoint
//   3. a query: the F3 cap wrapper, start payload, polling, pages, the header row,
//      NULL vs "", truncation, bytes scanned
//   4. failures: FAILED state, an AWS error body, a refused key, rate limiting
//   5. the clock and the caller's abort send StopQueryExecution
//   6. listTables (paged, every database or one) and describeTable (partitions)
//   7. a SECRET CANARY: the secret key in no request, result, error or log line
//
//   npm run build:ts && node scripts/test-connectorsAthena.js

export {}; // module scope — sibling test scripts share top-level names
import { createHmac } from 'crypto';
import { ok, finish } from './selfcheck';

const athena: typeof import('../src/connectors/athena') = require('../src/connectors/athena');
const sign: typeof import('../src/connectors/awsSign') = require('../src/connectors/awsSign');
const registry: typeof import('../src/connectors') = require('../src/connectors');
const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
type Ctx = import('../src/connectors/types').ConnectorContext;
type Req = import('../src/connectors/snowflakeHttp').SfHttpRequest;
type Json = Record<string, unknown>;

let captured = '';
for (const s of [process.stdout, process.stderr]) {
  const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
  (s as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return orig(chunk, ...rest);
  };
}

const found = registry.getConnector('amazon-athena');
if (!found) throw new Error('amazon-athena is not registered');
const def: import('../src/connectors/types').ConnectorDef = found;

const SECRET = `wJalr/${Math.random().toString(36).slice(2)}+canary`;
const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const values = { region: 'eu-west-1', accessKeyId: KEY_ID, workgroup: 'analysts', catalog: '', database: 'sales', outputLocation: 's3://results/ord/' };
const ctxFor = (v: Json = {}, extra: Partial<Ctx> = {}): Ctx =>
  ({ values: { ...values, ...v }, secrets: { secretAccessKey: SECRET }, rowLimit: 100, timeoutMs: 10_000, ...extra });
const isErr = (r: { ok: boolean }): r is { ok: false; error: string } => !r.ok;

// ── the fake ─────────────────────────────────────────────────────────────────
const sent: { action: string; body: Json; req: Req }[] = [];
let route: (action: string, body: Json) => { status?: number; json: unknown } | null = () => null;
let badSignatures = 0;

/** Recompute the signature from what was actually sent; count any mismatch. */
function verify(req: Req): void {
  const h = req.headers;
  const amz = h['x-amz-date'];
  const now = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
  const region = req.url.hostname.split('.')[1];
  const again = sign.signV4({
    method: req.method, host: req.url.hostname, path: req.url.pathname, region, service: 'athena', body: req.body ?? '', now,
    creds: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
    headers: { 'content-type': h['content-type'], 'x-amz-target': h['x-amz-target'] },
  });
  if (again.authorization !== h.authorization) badSignatures++;
}

athena.setTransport(async (req: Req) => {
  const action = String(req.headers['x-amz-target'] ?? '').replace('AmazonAthena.', '');
  const body = JSON.parse(req.body ?? '{}') as Json;
  sent.push({ action, body, req });
  verify(req);
  if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const r = route(action, body);
  if (!r) return { status: 400, body: JSON.stringify({ __type: 'InvalidRequestException', message: `fake: no route for ${action}` }), truncated: false };
  return { status: r.status ?? 200, body: JSON.stringify(r.json), truncated: false };
});

const col = (Name: string, Type: string): Json => ({ Name, Label: Name, Type });
const row = (...cells: (string | null)[]): Json => ({ Data: cells.map((c) => (c === null ? {} : { VarCharValue: c })) });

/** A query that runs `polls` times, then succeeds with `pages` of rows. */
function query(opts: { polls?: number; pages: Json[][]; columns: Json[]; type?: string; scanned?: number; final?: string; reason?: string }): void {
  let polled = 0;
  route = (action, body) => {
    if (action === 'StartQueryExecution') return { json: { QueryExecutionId: 'q-1' } };
    if (action === 'GetQueryExecution') {
      const state = polled++ < (opts.polls ?? 1) ? 'RUNNING' : opts.final ?? 'SUCCEEDED';
      return { json: { QueryExecution: { QueryExecutionId: 'q-1', StatementType: opts.type ?? 'DML', Status: { State: state, StateChangeReason: opts.reason }, Statistics: { DataScannedInBytes: opts.scanned ?? 0 } } } };
    }
    if (action === 'GetQueryResults') {
      const at = body.NextToken ? Number(body.NextToken) : 0;
      return { json: { ResultSet: { Rows: opts.pages[at], ResultSetMetadata: { ColumnInfo: opts.columns } }, ...(at + 1 < opts.pages.length ? { NextToken: String(at + 1) } : {}) } };
    }
    if (action === 'StopQueryExecution') return { json: {} };
    return null;
  };
}

async function main(): Promise<void> {
  // ── 1. SigV4 ────────────────────────────────────────────────────────────────
  const EXAMPLE = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  ok('SigV4: the signing key matches AWS’s worked example',
    sign.signingKey(EXAMPLE, '20120215', 'us-east-1', 'iam').toString('hex') === 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  const vanilla = sign.signV4({ method: 'GET', host: 'example.amazonaws.com', path: '/', region: 'us-east-1', service: 'service', headers: {}, body: '', creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: EXAMPLE }, now: new Date('2015-08-30T12:36:00Z') });
  ok('SigV4: AWS test suite get-vanilla', vanilla.authorization === 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31', vanilla.authorization);
  ok('SigV4: the host header is left to the URL', !('host' in vanilla) && vanilla['x-amz-date'] === '20150830T123600Z');
  const tampered = { ...vanilla };
  ok('SigV4: a different secret signs differently (negative control)', sign.signV4({ method: 'GET', host: 'example.amazonaws.com', path: '/', region: 'us-east-1', service: 'service', headers: {}, body: '', creds: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: EXAMPLE + 'x' }, now: new Date('2015-08-30T12:36:00Z') }).authorization !== tampered.authorization);

  // ── 2. the form ─────────────────────────────────────────────────────────────
  const acct = athena.accountOf(ctxFor());
  ok('the endpoint is athena.<region>.amazonaws.com', acct.ok && acct.host === 'athena.eu-west-1.amazonaws.com');
  const cn = athena.accountOf(ctxFor({ region: 'cn-north-1' }));
  ok('a China region uses amazonaws.com.cn', cn.ok && cn.host === 'athena.cn-north-1.amazonaws.com.cn');
  for (const [v, what] of [[{ region: 'eu-west-1.evil.com/' }, 'a region that is not one'], [{ region: '' }, 'no region'], [{ accessKeyId: 'akia lower' }, 'a malformed key id'], [{ outputLocation: 'https://x' }, 'a result location that is not s3://']] as [Json, string][]) {
    ok(`refused: ${what}`, !athena.accountOf(ctxFor(v)).ok);
  }
  ok('refused: no secret key', !athena.accountOf({ ...ctxFor(), secrets: {} }).ok);

  // ── 3. a query ──────────────────────────────────────────────────────────────
  query({
    polls: 2, scanned: 10_485_760,
    columns: [col('region', 'varchar'), col('total', 'decimal'), col('note', 'varchar')],
    pages: [
      [row('region', 'total', 'note'), row('EU', '12.50', ''), row('US', '007', null)],
      [row('APAC', '1', 'x')],
    ],
  });
  sent.length = 0;
  const r = await def.run(ctxFor(), 'select region, total, note from orders -- trailing comment;');
  const start = sent.find((s) => s.action === 'StartQueryExecution')?.body ?? {};
  ok('the F3 cap: the query on its own line inside the wrapper', start.QueryString === 'select * from (\nselect region, total, note from orders -- trailing comment\n) limit 101', start.QueryString);
  ok('start: catalog default, database, workgroup, result location, a request token', JSON.stringify(start.QueryExecutionContext) === '{"Catalog":"AwsDataCatalog","Database":"sales"}'
    && start.WorkGroup === 'analysts' && JSON.stringify(start.ResultConfiguration) === '{"OutputLocation":"s3://results/ord/"}' && typeof start.ClientRequestToken === 'string', start);
  ok('polled until SUCCEEDED, then read two pages', sent.filter((s) => s.action === 'GetQueryExecution').length === 3 && sent.filter((s) => s.action === 'GetQueryResults').length === 2);
  ok('every request: POST https://athena.eu-west-1.amazonaws.com/ with the target header', sent.every((s) => s.req.method === 'POST' && s.req.url.href === 'https://athena.eu-west-1.amazonaws.com/' && s.req.headers['content-type'] === 'application/x-amz-json-1.1'));
  ok('every request’s signature verifies against its own body', badSignatures === 0 && sent.length > 0, badSignatures);
  ok('the header row is dropped; rows from both pages', r.ok && r.rows.length === 3 && r.rows[0][0] === 'EU' && r.rows[2][0] === 'APAC', r.ok && r.rows);
  ok('NULL is null and "" stays ""; "007" stays text', r.ok && r.rows[1][2] === null && r.rows[0][2] === '' && r.rows[1][1] === '007');
  ok('columns carry Athena’s type names', r.ok && r.columns.map((c) => `${c.name}:${c.type}`).join() === 'region:varchar,total:decimal,note:varchar');
  ok('bytes is DataScannedInBytes', r.ok && r.bytes === 10_485_760 && !r.truncated);

  query({ columns: [col('n', 'integer')], pages: [[row('n'), row('1'), row('2'), row('3')]] });
  const capped = await def.run(ctxFor({}, { rowLimit: 2 }), 'select n from t');
  ok('the cap: 2 rows, truncated', capped.ok && capped.rows.length === 2 && capped.truncated);

  query({ type: 'UTILITY', columns: [col('tab_name', 'string')], pages: [[row('tab_name'), row('orders')]] });
  const utility = await def.run(ctxFor(), 'select 1');
  ok('only a SELECT’s first row is a header: kept for anything else', utility.ok && utility.rows.length === 2);

  const viaTable = await connectionRun.runConnectionText('amazon-athena', ctxFor().values, ctxFor().secrets, { table: 'sales.orders' }, { rowLimit: 5 });
  const tableSql = sent.filter((s) => s.action === 'StartQueryExecution').pop()?.body.QueryString;
  ok('a picked table is quoted, limited and wrapped', viaTable.ok && tableSql === 'select * from (\nselect * from "sales"."orders" limit 5\n) limit 6', tableSql);

  // ── 4. failures ─────────────────────────────────────────────────────────────
  query({ final: 'FAILED', reason: 'COLUMN_NOT_FOUND: line 1:8: Column \'x\' cannot be resolved', columns: [], pages: [] });
  const failed = await def.run(ctxFor(), 'select x from t');
  ok('FAILED: Athena’s reason', isErr(failed) && /COLUMN_NOT_FOUND/.test(failed.error), failed);
  route = () => ({ status: 400, json: { __type: 'com.amazonaws.athena#InvalidRequestException', message: `bad workgroup ${SECRET}` } });
  const invalid = await def.run(ctxFor(), 'select 1');
  ok('an AWS error body: its type and message, the secret redacted', isErr(invalid) && invalid.error.startsWith('InvalidRequestException: bad workgroup') && !invalid.error.includes(SECRET), invalid);
  route = () => ({ status: 400, json: { __type: 'UnrecognizedClientException', message: 'The security token included in the request is invalid.' } });
  const denied = await def.listTables(ctxFor());
  ok('a refused key says AWS refused it', isErr(denied) && /^AWS refused the request \(UnrecognizedClientException\)/.test(denied.error), denied);
  route = () => ({ status: 400, json: { __type: 'ThrottlingException', message: 'Rate exceeded' } });
  const throttled = await def.run(ctxFor(), 'select 1');
  ok('throttling is named', isErr(throttled) && /rate-limiting/.test(throttled.error));

  // ── 5. the clock and the abort ──────────────────────────────────────────────
  query({ polls: 1e9, columns: [], pages: [] });
  sent.length = 0;
  const t0 = Date.now();
  const slow = await def.run(ctxFor({}, { timeoutMs: 1_000 }), 'select 1');
  ok('the clock: stops near its budget', isErr(slow) && slow.error === 'Query timed out after 1s' && Date.now() - t0 < 2_500, [slow, Date.now() - t0]);
  ok('…and sends StopQueryExecution for the query', sent.some((s) => s.action === 'StopQueryExecution' && s.body.QueryExecutionId === 'q-1'));
  sent.length = 0;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t1 = Date.now();
  const cancelled = await def.run(ctxFor({}, { signal: ac.signal }), 'select 1');
  ok('the caller hanging up cancels at once, and stops the query', isErr(cancelled) && cancelled.error === 'The query was cancelled' && Date.now() - t1 < 1_500
    && sent.some((s) => s.action === 'StopQueryExecution'), [cancelled, Date.now() - t1]);

  // ── 6. the catalog ──────────────────────────────────────────────────────────
  route = (action, body) => {
    if (action === 'ListDatabases') return { json: body.NextToken ? { DatabaseList: [{ Name: 'logs' }] } : { DatabaseList: [{ Name: 'sales' }], NextToken: 'p2' } };
    if (action === 'ListTableMetadata') return { json: { TableMetadataList: [{ Name: `${String(body.DatabaseName)}_t` }] } };
    if (action === 'GetTableMetadata') return { json: { TableMetadata: { Name: body.TableName, Columns: [col('id', 'bigint')], PartitionKeys: [col('dt', 'string')] } } };
    return null;
  };
  const every = await def.listTables(ctxFor({ database: '' }));
  ok('listTables: every database, paged', every.ok && JSON.stringify(every.tables) === '[{"schema":"sales","name":"sales_t"},{"schema":"logs","name":"logs_t"}]', every);
  sent.length = 0;
  const one = await def.listTables(ctxFor());
  ok('listTables: only the connection’s database when set', one.ok && one.tables.length === 1 && !sent.some((s) => s.action === 'ListDatabases'));
  const described = await def.describeTable!(ctxFor(), 'logs.events"; drop');
  const asked = sent.filter((s) => s.action === 'GetTableMetadata').pop()?.body;
  ok('describeTable: columns then partition keys, the name sent as a value', described.ok && described.columns.map((c) => c.name).join() === 'id,dt'
    && asked?.DatabaseName === 'logs' && asked?.TableName === 'events"; drop', [described, asked]);
  ok('describeTable: a three-part name is refused', !(await def.describeTable!(ctxFor(), 'a.b.c')).ok);

  // ── 7. the canary ───────────────────────────────────────────────────────────
  const hmacOfSecret = createHmac('sha256', SECRET).update('x').digest('hex'); // a spelling that must not leak either
  const wire = JSON.stringify(sent.map((s) => ({ url: s.req.url.href, headers: s.req.headers, body: s.req.body })));
  ok('the secret key is in no request', !wire.includes(SECRET) && !wire.includes(encodeURIComponent(SECRET)) && !wire.includes(hmacOfSecret));
  ok('the secret key is in no result, error or log line', !captured.includes(SECRET) && ![r, failed, invalid, denied, slow, cancelled].some((x) => JSON.stringify(x).includes(SECRET)));
  athena.setTransport(null);
}

main()
  .catch((e: unknown) => ok('the suite ran to the end', false, e))
  .finally(finish);
