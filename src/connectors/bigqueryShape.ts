// BigQuery request and response shaping — MAIN PROCESS ONLY, and pure: no
// socket, no clock, no cache. Split out of bigquery.ts (the transport and the
// job loop) so the self-check drives every byte of the REST protocol from
// recorded fixtures, the Databricks precedent (http.ts shapeDatabricks).
//
// What is decided here, and why:
//
//   • NAMES. A project id is `^[a-z][a-z0-9-]{4,28}[a-z0-9]$`, or the legacy
//     domain-scoped `example.com:my-project`; a dataset is letters, digits and
//     underscores; a table is Unicode letters, marks, digits, connector and dash
//     punctuation (BigQuery also allows spaces — refused here, a name the tree
//     never needs). Every one is validated before it reaches a URL (where it is
//     encoded) or SQL (where the whole path is ONE backtick identifier — no
//     validated part can hold a backtick, a backslash or a newline).
//   • VALUES TRAVEL AS PARAMETERS (plan D4). `buildRequest` maps a LiveParam to
//     a named, typed query parameter; the SQL text is never touched.
//   • TYPES (plan L1.3). BigQuery's JSON sends every scalar as a string. Number
//     columns (INT64, NUMERIC, BIGNUMERIC, FLOAT64) KEEP THOSE STRINGS — exact,
//     and `-0` survives — and declare `columnType: 'number'` only when every
//     value passes parse.ts's `isFiniteNumber`; one value with more than 15
//     significant digits (an id) or a NaN makes the whole column TEXT, exactly
//     as the CSV detector would, so the dispatch's coerceValue never turns a
//     19-digit id into a rounded number or a null. TIMESTAMP arrives as epoch
//     seconds (`1.7044176E9`) and is converted EXACTLY, by decimal arithmetic,
//     to UTC ISO (milliseconds, like every other connector's Date). DATE and
//     DATETIME are dates as sent; BOOL is a boolean; REPEATED and RECORD are
//     JSON text. Strings pass through untouched, a leading U+FEFF included.

import { isFiniteNumber } from '../data/parse';
import type { ColumnType } from '../data/parse';
import type { ConnectorColumn, ConnectorContext, ConnectorError, ConnectorRows, LiveParam } from './types';

type Cell = string | number | boolean | null;

export const BQ_HOST = 'bigquery.googleapis.com';
const BQ_BASE = `https://${BQ_HOST}/bigquery/v2`;

// ── names ───────────────────────────────────────────────────────────────────

const PROJECT = '(?:[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\.[a-z]{2,63}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]';
const PROJECT_RE = new RegExp(`^${PROJECT}$`);
const DATASET = '[A-Za-z0-9_]{1,1024}';
const DATASET_RE = new RegExp(`^${DATASET}$`);
const TABLE = '[\\p{L}\\p{M}\\p{N}\\p{Pc}\\p{Pd}]{1,1024}';
const TABLE_PATH_RE = new RegExp(`^(?:(${PROJECT})\\.)?(${DATASET})\\.(${TABLE})$`, 'u');
const LOCATION_RE = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,1024}$/;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const validProject = (p: string): boolean => PROJECT_RE.test(p);
export const validDataset = (d: string): boolean => DATASET_RE.test(d);
export const validLocation = (l: string): boolean => LOCATION_RE.test(l);
export const validJobId = (j: string): boolean => JOB_ID_RE.test(j);

export interface TablePath {
  project?: string;
  dataset: string;
  table: string;
}

/** `dataset.table` or `project.dataset.table`, validated part by part — or null. */
export function parseTablePath(name: string): TablePath | null {
  const m = TABLE_PATH_RE.exec(String(name ?? '').trim());
  if (!m) return null;
  return m[1] ? { project: m[1], dataset: m[2], table: m[3] } : { dataset: m[2], table: m[3] };
}

/** A validated table path as ONE backtick identifier, which BigQuery accepts for the whole path. */
export function quotedTablePath(name: string): string | null {
  const p = parseTablePath(name);
  return p ? '`' + [p.project, p.dataset, p.table].filter(Boolean).join('.') + '`' : null;
}

/** The default dataset field: `dataset` (in the billing project) or `project.dataset`. */
export function parseDatasetRef(raw: string, billing: string): { projectId: string; datasetId: string } | null {
  const v = String(raw ?? '').trim();
  const dot = v.lastIndexOf('.');
  const projectId = dot > 0 ? v.slice(0, dot) : billing;
  const datasetId = dot > 0 ? v.slice(dot + 1) : v;
  return validProject(projectId) && validDataset(datasetId) ? { projectId, datasetId } : null;
}

// ── URLs: a fixed host, encoded path segments ───────────────────────────────

const seg = encodeURIComponent;

export function queriesUrl(project: string): URL {
  return new URL(`${BQ_BASE}/projects/${seg(project)}/queries`);
}

export interface Job {
  projectId: string;
  jobId: string;
  location?: string;
}

export function resultsUrl(job: Job, q: { pageToken?: string; maxResults?: number; timeoutMs?: number }): URL {
  const u = new URL(`${BQ_BASE}/projects/${seg(job.projectId)}/queries/${seg(job.jobId)}`);
  if (job.location) u.searchParams.set('location', job.location);
  if (q.pageToken) u.searchParams.set('pageToken', q.pageToken);
  if (q.maxResults) u.searchParams.set('maxResults', String(q.maxResults));
  if (q.timeoutMs) u.searchParams.set('timeoutMs', String(q.timeoutMs));
  u.searchParams.set('formatOptions.useInt64Timestamp', 'false');
  return u;
}

export function cancelUrl(job: Job): URL {
  const u = new URL(`${BQ_BASE}/projects/${seg(job.projectId)}/jobs/${seg(job.jobId)}/cancel`);
  if (job.location) u.searchParams.set('location', job.location);
  return u;
}

export function datasetsUrl(project: string, pageToken?: string): URL {
  const u = new URL(`${BQ_BASE}/projects/${seg(project)}/datasets`);
  u.searchParams.set('maxResults', '1000');
  if (pageToken) u.searchParams.set('pageToken', pageToken);
  return u;
}

export function tablesUrl(project: string, dataset: string, pageToken?: string): URL {
  const u = new URL(`${BQ_BASE}/projects/${seg(project)}/datasets/${seg(dataset)}/tables`);
  u.searchParams.set('maxResults', '1000');
  if (pageToken) u.searchParams.set('pageToken', pageToken);
  return u;
}

export function tableUrl(project: string, p: TablePath): URL {
  return new URL(`${BQ_BASE}/projects/${seg(p.project || project)}/datasets/${seg(p.dataset)}/tables/${seg(p.table)}`);
}

// ── the request ─────────────────────────────────────────────────────────────

/**
 * The row cap's server-side half (CLAUDE.md, F3): the statement sits on its
 * OWN LINE inside the wrapper, so a trailing `--` comment cannot swallow the
 * LIMIT. cap + 1, so a result exactly at the cap is told apart from a clipped one.
 */
export function capSql(sql: string, cap: number): string {
  return `select * from (\n${sql}\n) limit ${cap + 1}`;
}

/** `maximumBytesBilled`: the lowest of the connection's field, the server's ceiling and the caller's. */
export function bytesCap(field: unknown, ceiling: number, callerMax?: number): number {
  const n = typeof field === 'number' ? field : typeof field === 'string' && /^\d{1,16}$/.test(field.trim()) ? Number(field) : NaN;
  let cap = ceiling;
  if (Number.isSafeInteger(n) && n > 0) cap = Math.min(cap, n);
  if (typeof callerMax === 'number' && Number.isSafeInteger(callerMax) && callerMax > 0) cap = Math.min(cap, callerMax);
  return cap;
}

export interface RequestOptions {
  location?: string;
  defaultDataset?: { projectId: string; datasetId: string };
  /** Omitted on a dry run, which bills nothing. Always set otherwise. */
  maxBytes: number;
  label: 'live' | 'extract';
  /** How long BigQuery may hold the HTTP request open waiting for the job. */
  waitMs: number;
  /** BigQuery stops the job by itself past this, even if we are gone. */
  jobTimeoutMs: number;
  maxResults: number;
  dryRun?: boolean;
}

const PARAM_TYPE: Record<LiveParam['type'], string> = {
  text: 'STRING', number: 'FLOAT64', boolean: 'BOOL', date: 'DATE', timestamp: 'TIMESTAMP',
};

/** One LiveParam → a named, typed BigQuery query parameter, or why it cannot be one. */
function queryParameter(p: LiveParam): Record<string, unknown> | string {
  if (!PARAM_NAME_RE.test(String(p?.name ?? ''))) return 'a parameter name is not valid';
  const v = p.value;
  const typed = (type: string, value?: string) => ({
    name: p.name,
    parameterType: { type },
    // A NULL is the parameter's type with no value (the client libraries' encoding).
    parameterValue: value === undefined ? {} : { value },
  });
  if (!Object.prototype.hasOwnProperty.call(PARAM_TYPE, p.type)) return `parameter ${p.name} has an unknown type`;
  if (v === null) return typed(PARAM_TYPE[p.type]);
  switch (p.type) {
    case 'text':
      return typeof v === 'string' ? typed('STRING', v) : `parameter ${p.name} is not text`;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return `parameter ${p.name} is not a finite number`;
      // An integral, exactly representable value binds as INT64, so `id = @p0`
      // compares integers; anything else is a FLOAT64 (String(v) round-trips).
      return Number.isSafeInteger(v) ? typed('INT64', String(v)) : typed('FLOAT64', String(v));
    case 'boolean':
      return typeof v === 'boolean' ? typed('BOOL', v ? 'true' : 'false') : `parameter ${p.name} is not a boolean`;
    case 'date':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? typed('DATE', v) : `parameter ${p.name} is not a YYYY-MM-DD date`;
    case 'timestamp':
      return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? typed('TIMESTAMP', v) : `parameter ${p.name} is not an ISO timestamp`;
  }
}

/**
 * The body of `POST /projects/<p>/queries` (jobs.query), or the reason a
 * parameter is refused. Legacy SQL off, named parameters, a job always
 * created (so there is one to cancel), the cost guard and the purpose label.
 */
export function buildRequest(sql: string, params: readonly LiveParam[], opts: RequestOptions): { ok: true; body: Record<string, unknown> } | ConnectorError {
  const queryParameters: Record<string, unknown>[] = [];
  for (const p of params || []) {
    const qp = queryParameter(p);
    if (typeof qp === 'string') return { ok: false, error: `Query not sent: ${qp}.` };
    queryParameters.push(qp);
  }
  const body: Record<string, unknown> = {
    query: sql,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters,
    labels: { ordinate: opts.label },
    formatOptions: { useInt64Timestamp: false }, // TIMESTAMP as epoch seconds — what decodeScalar reads
  };
  if (opts.location) body.location = opts.location;
  if (opts.defaultDataset) body.defaultDataset = opts.defaultDataset;
  if (opts.dryRun) {
    body.dryRun = true;
    return { ok: true, body };
  }
  body.maximumBytesBilled = String(opts.maxBytes);
  body.maxResults = opts.maxResults;
  body.timeoutMs = opts.waitMs;
  body.jobTimeoutMs = String(opts.jobTimeoutMs);
  body.jobCreationMode = 'JOB_CREATION_REQUIRED';
  return { ok: true, body };
}

// ── the response ────────────────────────────────────────────────────────────

/** A typed read of an untyped JSON object. */
export function prop(o: unknown, key: string): unknown {
  return o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Field {
  name: string;
  type: string;
  mode: string;
  fields: Field[];
}

function fieldOf(f: unknown): Field {
  return {
    name: text(prop(f, 'name')),
    type: text(prop(f, 'type')).toUpperCase() || 'STRING',
    mode: text(prop(f, 'mode')).toUpperCase(),
    fields: arr(prop(f, 'fields')).map(fieldOf),
  };
}

/** The job a jobs.query / getQueryResults reply names, validated — or null. */
export function jobOf(json: unknown, fallbackLocation?: string): Job | null {
  const ref = prop(json, 'jobReference');
  const projectId = text(prop(ref, 'projectId'));
  const jobId = text(prop(ref, 'jobId'));
  const location = text(prop(ref, 'location'));
  if (!validProject(projectId) || !validJobId(jobId)) return null;
  const loc = validLocation(location) ? location : fallbackLocation;
  return loc ? { projectId, jobId, location: loc } : { projectId, jobId };
}

const NUMBER_TYPES = new Set(['INTEGER', 'INT64', 'FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC', 'DECIMAL', 'BIGDECIMAL']);
const DATE_TYPES = new Set(['DATE', 'DATETIME', 'TIMESTAMP']);
const RECORD_TYPES = new Set(['RECORD', 'STRUCT']);

/** Floor division on BigInt (BigInt `/` truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

/**
 * BigQuery's TIMESTAMP wire form — epoch SECONDS as a decimal string, often
 * in E notation (`1.7044176E9`, `-1.5E0`) — to a UTC ISO string, exactly:
 * the digits are shifted as a decimal, never multiplied as a float. Null when
 * it is not such a number or falls outside what a Date can hold.
 */
export function epochToIso(s: string): string | null {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const frac = m[3] || '';
  const shift = Number(m[4] || 0) - frac.length + 3; // to milliseconds
  if (shift > 30) return null;
  let ms = BigInt(m[2] + frac);
  if (m[1] === '-') ms = -ms;
  ms = shift >= 0 ? ms * 10n ** BigInt(shift) : floorDiv(ms, 10n ** BigInt(-shift));
  if (ms > 8_640_000_000_000_000n || ms < -8_640_000_000_000_000n) return null;
  return new Date(Number(ms)).toISOString();
}

/** One scalar as sent → a cell. Number strings stay strings (see the header). */
function decodeScalar(type: string, v: unknown, nested: boolean): unknown {
  if (v === null || v === undefined) return null;
  // BigQuery sends scalars as strings; anything else is kept, as JSON text at the top level (a cell is a primitive).
  if (typeof v !== 'string') return nested || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v);
  if (type === 'TIMESTAMP') return epochToIso(v) ?? v;
  if (type === 'BOOL' || type === 'BOOLEAN') return v === 'true' ? true : v === 'false' ? false : v;
  // Inside JSON text a number is a JSON number when that is lossless.
  if (nested && NUMBER_TYPES.has(type) && isFiniteNumber(v)) return Number(v);
  return v;
}

/** A value of `field` → a cell (top level) or a JSON value (inside a RECORD/REPEATED). */
function decodeValue(field: Field, v: unknown, nested: boolean): unknown {
  if (v === null || v === undefined) return null;
  if (field.mode === 'REPEATED') {
    const one: Field = { ...field, mode: 'NULLABLE' };
    const items = arr(v).map((e) => decodeValue(one, prop(e, 'v'), true));
    return nested ? items : JSON.stringify(items);
  }
  if (RECORD_TYPES.has(field.type)) {
    const cells = arr(prop(v, 'f'));
    const obj: Record<string, unknown> = {};
    field.fields.forEach((sub, i) => { obj[sub.name] = decodeValue(sub, prop(cells[i], 'v'), true); });
    return nested ? obj : JSON.stringify(obj);
  }
  return decodeScalar(field.type, v, nested);
}

/** Ordinate's type for a result column (see the header), or undefined to let the dispatch detect. */
export function columnTypeOf(field: Pick<Field, 'type' | 'mode'>, values: readonly Cell[]): ColumnType | undefined {
  if (field.mode === 'REPEATED' || RECORD_TYPES.has(field.type)) return 'text';
  if (DATE_TYPES.has(field.type)) return 'date';
  if (NUMBER_TYPES.has(field.type)) {
    return values.every((v) => v === null || (typeof v === 'string' && isFiniteNumber(v))) ? 'number' : 'text';
  }
  if (['STRING', 'BYTES', 'BOOL', 'BOOLEAN', 'TIME', 'GEOGRAPHY', 'JSON', 'INTERVAL', 'RANGE'].includes(field.type)) return 'text';
  return undefined;
}

/** The source type name as BigQuery reports it, REPEATED spelled out. */
const typeName = (f: Field): string => (f.mode === 'REPEATED' ? `REPEATED ${f.type}` : f.type);

/**
 * A jobs.query / getQueryResults reply (or several pages merged into one
 * `{schema, rows}`) → ConnectorRows, capped at ctx.rowLimit with truncation
 * reported, never trimmed silently.
 */
export function shapeResponse(json: unknown, ctx: Pick<ConnectorContext, 'rowLimit'>, clipped = false): ConnectorRows | ConnectorError {
  if (prop(json, 'jobComplete') === false) return { ok: false, error: 'The query has not finished.' };
  const fields = arr(prop(prop(json, 'schema'), 'fields')).map(fieldOf);
  const n = Math.floor(ctx.rowLimit);
  const cap = Number.isFinite(n) && n > 0 ? n : 1;
  const raw = arr(prop(json, 'rows'));
  const truncated = clipped || raw.length > cap;
  const rows: Cell[][] = raw.slice(0, cap).map((r) => {
    const cells = arr(prop(r, 'f'));
    return fields.map((f, i) => decodeValue(f, prop(cells[i], 'v'), false) as Cell);
  });
  const columns: ConnectorColumn[] = fields.map((f, i) => {
    const col: ConnectorColumn = { name: f.name, type: typeName(f) };
    const t = columnTypeOf(f, rows.map((r) => r[i]));
    if (t) col.columnType = t;
    return col;
  });
  return { ok: true, columns, rows, truncated };
}

/**
 * What a finished query billed, from BigQuery's own reply: `totalBytesBilled`
 * (jobs.query), else `totalBytesProcessed` (getQueryResults carries only that).
 * Undefined when the reply has neither — never estimated (live data L2.7).
 */
export function billedBytesOf(json: unknown): number | undefined {
  for (const k of ['totalBytesBilled', 'totalBytesProcessed']) {
    const raw = prop(json, k);
    const n = typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  return undefined;
}

/** tables.get's schema → the workbench's column list (top-level fields). */
export function describeColumns(json: unknown): { name: string; type: string; nullable: boolean }[] {
  return arr(prop(prop(json, 'schema'), 'fields')).map(fieldOf).filter((f) => f.name)
    .map((f) => ({ name: f.name, type: typeName(f), nullable: f.mode !== 'REQUIRED' }));
}

// ── errors ──────────────────────────────────────────────────────────────────

const SCOPE_HINT =
  'Google refused the read-only access this server asks for (insufficient authentication scopes). ' +
  'Ordinate requests only the bigquery.readonly and cloud-platform.read-only scopes and will not ask for write access — see docs/server/live-data.md (BigQuery).';
const ROLE_HINT = 'The service account needs BigQuery Data Viewer on the data and BigQuery Job User on the billing project.';

/** A non-2xx BigQuery reply → one user-facing sentence (the caller scrubs secrets from it). */
export function apiError(status: number, body: string): string {
  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    json = undefined;
  }
  const err = prop(json, 'error');
  const message = text(prop(err, 'message')) || (body.trim().startsWith('<') ? '' : body.trim().slice(0, 300));
  const reasons = [...arr(prop(err, 'errors')), ...arr(prop(err, 'details'))].map((e) => text(prop(e, 'reason')));
  if (status === 403 && (/insufficient authentication scopes/i.test(message) || reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT'))) {
    return `${SCOPE_HINT} (HTTP 403: ${message || 'insufficient scopes'})`;
  }
  if (status === 401) return `Google rejected the access token (HTTP 401)${message ? ': ' + message : ''}`;
  if (status === 403 && reasons.includes('accessDenied')) return `${message || 'Access denied'} — ${ROLE_HINT}`;
  if (reasons.includes('bytesBilledLimitExceeded')) return `${message} Raise "Max bytes billed per query" or narrow the query.`;
  return message ? `BigQuery: ${message}` : `BigQuery request failed (HTTP ${status})`;
}

/** "~1.2 GB" — a dry run's byte count for the editor (1024-based, as BigQuery bills). */
export function estimateLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `~${Math.max(0, Math.round(bytes) || 0)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `~${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
