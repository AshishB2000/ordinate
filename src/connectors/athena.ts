// Amazon Athena — MAIN PROCESS ONLY. The Athena API over HTTPS, no AWS SDK.
//
// Each call is one POST to https://athena.<region>.amazonaws.com/ with an
// `X-Amz-Target: AmazonAthena.<Action>` header, signed with SigV4 (./awsSign).
// A query is StartQueryExecution, GetQueryExecution until it finishes, then
// GetQueryResults page by page. Tables and columns come from the catalog API
// (ListDatabases, ListTableMetadata, GetTableMetadata), not from SQL.
//
// The transport is Snowflake's (./snowflakeHttp): one bounded request through
// ssrf.ts `safeFetch` (the address checked and pinned, no redirect followed),
// with a wall clock, the caller's abort signal and a byte ceiling.
//
// READ-ONLY, ENFORCED BY THE WRAPPER: a query runs as
// `select * from (\n<query>\n) limit cap+1`, and only a query expression parses
// there: no CREATE, INSERT, DROP or UNLOAD. The key still wants read-only
// Athena, Glue and S3 permissions, plus write on the results bucket.
//
// BOUNDED: the cap is in the SQL; the clock and the caller's abort stop the
// polling and send StopQueryExecution, so Athena stops scanning (and billing).
// `bytes` reports DataScannedInBytes, what Athena bills on.

import { randomUUID } from 'node:crypto';
import { signV4, type AwsCredentials } from './awsSign';
import { asArray, budgetMs, cleanSql, MAX_BYTES, prop, rowCap, secret, str } from './httpShared';
import { snowflakeFetch, type SfHttpResponse, type SfTransport } from './snowflakeHttp';
import { cappedStatement } from './snowflakeSql';
import { safeError } from './types';
import type { ConnectorColumn, ConnectorContext, ConnectorDef, ConnectorError, ConnectorRows, ConnectorSchema, ConnectorTable, ConnectorTables } from './types';

type Cell = string | null;
const err = (error: string): ConnectorError => ({ ok: false, error });

// ── the transport seam ───────────────────────────────────────────────────────

let transport: SfTransport = snowflakeFetch;

/** Route every Athena request through `t`; null restores the real one. Tests only. */
export function setTransport(t: SfTransport | null): void {
  transport = t ?? snowflakeFetch;
}

// ── the account ──────────────────────────────────────────────────────────────

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const KEY_ID_RE = /^[A-Z0-9]{16,128}$/;

interface Account { ok: true; host: string; region: string; creds: AwsCredentials }

/** The endpoint and credentials from the form, or what is wrong with it. Exported for the self-check. */
export function accountOf(ctx: ConnectorContext): Account | ConnectorError {
  const region = str(ctx, 'region').trim().toLowerCase();
  if (!REGION_RE.test(region)) return err('Enter an AWS region, such as us-east-1');
  const accessKeyId = str(ctx, 'accessKeyId').trim();
  if (!KEY_ID_RE.test(accessKeyId)) return err('Enter the access key ID (it starts with AKIA)');
  const secretAccessKey = secret(ctx, 'secretAccessKey').trim();
  if (!secretAccessKey) return err('Enter the secret access key');
  const output = str(ctx, 'outputLocation').trim();
  if (output && !output.startsWith('s3://')) return err('The query result location is an s3:// address');
  const host = `athena.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`;
  return { ok: true, host, region, creds: { accessKeyId, secretAccessKey } };
}

const catalogOf = (ctx: ConnectorContext): string => str(ctx, 'catalog').trim() || 'AwsDataCatalog';

// ── one API call ─────────────────────────────────────────────────────────────

const CALL_MS = 30_000;
const CANCEL_MS = 5_000;
const CLIPPED = 'Response exceeded the 100 MB ceiling and was cut off. Narrow the query or lower the row limit.';

type Json = Record<string, unknown>;
type Reply = { ok: true; json: Json; size: number } | (ConnectorError & { clipped?: true });

function parseJson(body: string): Json | undefined {
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** The user-facing sentence for a refused call. */
function failureOf(res: SfHttpResponse, json: Json | undefined): string {
  const type = String(prop(json, '__type') ?? '').replace(/^.*#/, '');
  const message = String(prop(json, 'message') ?? prop(json, 'Message') ?? '').trim() || (json ? '' : res.body.trim().slice(0, 300));
  if (res.status === 403 || /^(UnrecognizedClient|InvalidSignature|AccessDenied|ExpiredToken|InvalidClientTokenId)/.test(type)) {
    return `AWS refused the request${type ? ` (${type})` : ''}${message ? ': ' + message : ''}`;
  }
  if (res.status === 429 || /^(Throttling|TooManyRequests)/.test(type)) return 'Athena is rate-limiting requests. Try again in a minute.';
  if (message) return type ? `${type}: ${message}` : message;
  return `Request failed (HTTP ${res.status})`;
}

/** One Athena action. Throws on a network failure, a refused address or a stop. */
async function call(acct: Account, action: string, payload: Json, timeoutMs: number, signal?: AbortSignal, maxBytes = MAX_BYTES): Promise<Reply> {
  const body = JSON.stringify(payload);
  const headers = signV4({
    method: 'POST', host: acct.host, path: '/', region: acct.region, service: 'athena', body, creds: acct.creds,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AmazonAthena.${action}` },
  });
  const res = await transport({ url: new URL(`https://${acct.host}/`), method: 'POST', headers, body, timeoutMs, maxBytes, signal });
  if (res.truncated) return { ok: false, error: CLIPPED, clipped: true };
  const json = parseJson(res.body);
  if (res.status === 200 && json) return { ok: true, json, size: Buffer.byteLength(res.body, 'utf8') };
  // AWS error bodies can echo what was sent: redact before it becomes a sentence.
  return err(safeError(failureOf(res, json), { secretAccessKey: acct.creds.secretAccessKey }));
}

async function cancel(acct: Account, id: string): Promise<void> {
  try {
    await call(acct, 'StopQueryExecution', { QueryExecutionId: id }, CANCEL_MS);
  } catch {
    // best effort: the answer is already decided
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The clock and the caller's abort as one signal, and the sentence each one ends with. */
function stopwatch(ctx: ConnectorContext): { stop: AbortSignal; left: () => number; stopped: () => ConnectorError } {
  const budget = budgetMs(ctx);
  const deadline = Date.now() + budget;
  const clock = AbortSignal.timeout(budget);
  return {
    stop: ctx.signal ? AbortSignal.any([ctx.signal, clock]) : clock,
    left: () => Math.max(1, Math.min(CALL_MS, deadline - Date.now())),
    stopped: () => err(ctx.signal?.aborted ? 'The query was cancelled' : `Query timed out after ${Math.ceil(budget / 1000)}s`),
  };
}

// ── running a statement ──────────────────────────────────────────────────────

const POLL_FIRST_MS = 250;
const POLL_MAX_MS = 2_000;
const PAGE_ROWS = 1_000;
const FINISHED: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function startPayload(ctx: ConnectorContext, statement: string): Json {
  const database = str(ctx, 'database').trim();
  const workgroup = str(ctx, 'workgroup').trim();
  const output = str(ctx, 'outputLocation').trim();
  return {
    QueryString: statement,
    ClientRequestToken: randomUUID(),
    QueryExecutionContext: { Catalog: catalogOf(ctx), ...(database ? { Database: database } : {}) },
    ...(workgroup ? { WorkGroup: workgroup } : {}),
    ...(output ? { ResultConfiguration: { OutputLocation: output } } : {}),
  };
}

/** Run one statement to completion and read its pages, under ctx's caps, clock and signal. */
async function execute(ctx: ConnectorContext, statement: string): Promise<ConnectorRows | ConnectorError> {
  const acct = accountOf(ctx);
  if (!acct.ok) return acct;
  const { stop, left, stopped } = stopwatch(ctx);
  if (stop.aborted) return stopped();
  let running = ''; // the id to cancel while the query may still be running
  try {
    // Not given `stop`: a dropped reply would lose the id to cancel with. It
    // only queues the query; the waiting is below.
    const started = await call(acct, 'StartQueryExecution', startPayload(ctx, statement), left());
    if (!started.ok) return started;
    const id = typeof started.json.QueryExecutionId === 'string' ? started.json.QueryExecutionId : '';
    if (!id) return err('Athena accepted the query without an id');
    running = id;

    let exec: unknown;
    for (let pause = POLL_FIRST_MS; ; pause = Math.min(POLL_MAX_MS, Math.round(pause * 1.5))) {
      if (stop.aborted) throw stop.reason;
      const got = await call(acct, 'GetQueryExecution', { QueryExecutionId: id }, left(), stop);
      if (!got.ok) {
        await cancel(acct, id);
        return got;
      }
      exec = got.json.QueryExecution;
      if (FINISHED.has(String(prop(prop(exec, 'Status'), 'State')))) break;
      await sleep(Math.min(pause, left()), stop);
    }
    const status = prop(exec, 'Status');
    const state = String(prop(status, 'State'));
    if (state === 'FAILED') {
      return err(safeError(String(prop(status, 'StateChangeReason') ?? prop(prop(status, 'AthenaError'), 'ErrorMessage') ?? 'The query failed in Athena'), ctx.secrets));
    }
    if (state === 'CANCELLED') return err('The query was cancelled in Athena');
    running = ''; // finished: from here a stop only stops reading
    const scanned = Number(prop(prop(exec, 'Statistics'), 'DataScannedInBytes'));
    const rows = await readResults(acct, id, ctx, prop(exec, 'StatementType') === 'DML', stop, left);
    return rows.ok && Number.isFinite(scanned) ? { ...rows, bytes: scanned } : rows;
  } catch (e) {
    if (running) await cancel(acct, running);
    return stop.aborted ? stopped() : err(safeError(e, ctx.secrets));
  }
}

async function readResults(
  acct: Account, id: string, ctx: ConnectorContext, select: boolean, stop: AbortSignal, left: () => number,
): Promise<ConnectorRows | ConnectorError> {
  const cap = rowCap(ctx);
  let columns: ConnectorColumn[] = [];
  const rows: Cell[][] = [];
  let bytes = MAX_BYTES;
  let truncated = false;
  let token: string | undefined;
  let first = true;
  do {
    const page = await call(acct, 'GetQueryResults', { QueryExecutionId: id, MaxResults: PAGE_ROWS, ...(token ? { NextToken: token } : {}) }, left(), stop, bytes);
    if (!page.ok) {
      if (page.clipped && !first) {
        truncated = true;
        break;
      }
      return page;
    }
    bytes -= page.size;
    const set = prop(page.json, 'ResultSet');
    const info = asArray(prop(prop(set, 'ResultSetMetadata'), 'ColumnInfo'));
    if (first) columns = info.map((c) => ({ name: String(prop(c, 'Name') ?? ''), type: String(prop(c, 'Type') ?? '') }));
    // A NULL has no VarCharValue; an empty string has "".
    let data = asArray(prop(set, 'Rows')).map((r) => asArray(prop(r, 'Data')).map((d): Cell => {
      const v = prop(d, 'VarCharValue');
      return typeof v === 'string' ? v : null;
    }));
    // A SELECT's first page opens with the header row; nothing else's does.
    if (first && select && data.length && data[0].every((v, i) => v === prop(info[i], 'Label') || v === prop(info[i], 'Name'))) data = data.slice(1);
    for (const r of data) rows.push(r); // a loop: a spread of many rows overflows the stack
    first = false;
    token = typeof page.json.NextToken === 'string' && page.json.NextToken ? page.json.NextToken : undefined;
    if (token && bytes <= 0) truncated = true;
  } while (token && rows.length <= cap && bytes > 0);
  return { ok: true, columns, rows: rows.length > cap ? rows.slice(0, cap) : rows, truncated: truncated || rows.length > cap };
}

// ── the operations ───────────────────────────────────────────────────────────

async function run(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const statement = cleanSql(sql);
  if (!statement) return err('No query specified');
  return execute(ctx, cappedStatement(statement, rowCap(ctx)));
}

const MAX_TABLES = 1_000;
const LIST_PAGE = 50;

/** Every item of a paged catalog listing, up to `limit`. Throws the refusal. */
async function listAll(acct: Account, action: string, payload: Json, key: string, limit: number, left: () => number, stop: AbortSignal): Promise<unknown[]> {
  const out: unknown[] = [];
  let token: string | undefined;
  do {
    const r = await call(acct, action, { ...payload, MaxResults: LIST_PAGE, ...(token ? { NextToken: token } : {}) }, left(), stop);
    if (!r.ok) throw new Error(r.error);
    for (const item of asArray(r.json[key])) if (out.length < limit) out.push(item);
    token = typeof r.json.NextToken === 'string' && r.json.NextToken ? r.json.NextToken : undefined;
  } while (token && out.length < limit);
  return out;
}

/** The connection's database's tables; without one, every database's in the catalog. */
async function listTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  const acct = accountOf(ctx);
  if (!acct.ok) return acct;
  const { stop, left, stopped } = stopwatch(ctx);
  const catalog = catalogOf(ctx);
  try {
    const only = str(ctx, 'database').trim();
    const databases = only
      ? [only]
      : (await listAll(acct, 'ListDatabases', { CatalogName: catalog }, 'DatabaseList', MAX_TABLES, left, stop)).map((d) => String(prop(d, 'Name') ?? ''));
    const tables: ConnectorTable[] = [];
    for (const db of databases) {
      if (!db || tables.length >= MAX_TABLES) continue;
      const found = await listAll(acct, 'ListTableMetadata', { CatalogName: catalog, DatabaseName: db }, 'TableMetadataList', MAX_TABLES - tables.length, left, stop);
      for (const t of found) tables.push({ schema: db, name: String(prop(t, 'Name') ?? '') });
    }
    return { ok: true, tables: tables.filter((t) => t.name) };
  } catch (e) {
    return stop.aborted ? stopped() : err(safeError(e, ctx.secrets));
  }
}

/** One table's columns, then its partition keys, from the catalog. The names are JSON values, never SQL. */
async function describeTable(ctx: ConnectorContext, table: string): Promise<ConnectorSchema | ConnectorError> {
  const acct = accountOf(ctx);
  if (!acct.ok) return acct;
  const parts = String(table ?? '').split('.');
  const name = parts[parts.length - 1];
  const database = parts.length === 2 ? parts[0] : str(ctx, 'database').trim();
  if (parts.length > 2 || !name || !database) return err('Invalid table name');
  const { stop, left, stopped } = stopwatch(ctx);
  try {
    const r = await call(acct, 'GetTableMetadata', { CatalogName: catalogOf(ctx), DatabaseName: database, TableName: name }, left(), stop);
    if (!r.ok) return r;
    const meta = prop(r.json, 'TableMetadata');
    const columns = [...asArray(prop(meta, 'Columns')), ...asArray(prop(meta, 'PartitionKeys'))]
      .map((c) => ({ name: String(prop(c, 'Name') ?? ''), type: String(prop(c, 'Type') ?? '') }));
    return { ok: true, columns };
  } catch (e) {
    return stop.aborted ? stopped() : err(safeError(e, ctx.secrets));
  }
}

// ── the definition ───────────────────────────────────────────────────────────

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'amazon-athena',
    label: 'Amazon Athena',
    family: 'athena',
    category: 'Query engines',
    readOnly: true,
    blurb: 'The Athena API over HTTPS, signed with an access key. Athena bills by data scanned: filter on partition columns.',
    fields: [
      { key: 'region', label: 'Region', type: 'text', required: true, placeholder: 'us-east-1' },
      {
        key: 'accessKeyId', label: 'Access key ID', type: 'text', required: true, placeholder: 'AKIA…',
        help: 'An IAM user’s key with read-only Athena, Glue and S3 permissions, and write on the results bucket.',
      },
      { key: 'secretAccessKey', label: 'Secret access key', type: 'password', secret: true, required: true },
      { key: 'workgroup', label: 'Workgroup', type: 'text', default: 'primary' },
      {
        key: 'outputLocation', label: 'Query result location', type: 'text', placeholder: 's3://my-athena-results/ordinate/',
        help: 'Where Athena writes results. Leave empty when the workgroup sets one.',
      },
      { key: 'catalog', label: 'Data catalog', type: 'text', default: 'AwsDataCatalog' },
      { key: 'database', label: 'Database', type: 'text', help: 'Optional. Lists this database’s tables and is the default for queries; without it, every database in the catalog.' },
    ],
    listTables,
    run,
    describeTable,
  },
];
