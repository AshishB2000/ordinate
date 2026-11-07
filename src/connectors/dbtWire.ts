// The dbt Semantic Layer's GraphQL API on the wire (semantic layer part 7, d1, BETA; docs/live-data/dbt-semantic-layer.md)
// — PURE.
//
// Every document Ordinate sends is a constant here: names and values travel as GraphQL VARIABLES, never in a document.
// The encoder (src/engine/live/semantic/dbt.ts) writes a `DbtBody`; ./dbt.ts sends it and reads the answer back with
// `readPage` / `finishRows`. Everything dbt-specific is as documented (or as dbt Labs' SDK sends it), unverified on an
// account until the nightly runs: each use says which.
//
// Reading an answer is strict. Columns are found by name, case-insensitively (a warehouse may upper-case them), and a
// reply with two columns of one name in different cases is refused. A metric cell is a number when it is a JSON number
// or a finite decimal's text; a dimension cell is left as sent (`007` stays text). A dimension answered both as '' and
// as NULL is refused (Ordinate keeps one blank group). A reply cut by its limit is checked against Ordinate's order
// (a NULL last): when a NULL came before a value, the cut may have kept the wrong rows and the caller asks again
// without the cut (`recut`), as for Cube.

import type { DateGrain } from '../analysis/categoryKey';
import { cutIsExact } from './cubeWire';
import type { Cell } from './httpShared';
import { asArray, prop } from './httpShared';
import type { ConnectorRows } from './types';

/** The multi-tenant regions and their hosts (documented). Single-tenant and cell hosts are per account: not offered (beta). */
export const DBT_REGIONS: Readonly<Record<string, { host: string; label: string }>> = {
  'north-america': { host: 'semantic-layer.cloud.getdbt.com', label: 'North America' },
  emea: { host: 'semantic-layer.emea.dbt.com', label: 'EMEA' },
  apac: { host: 'semantic-layer.au.dbt.com', label: 'APAC' },
};
export const DBT_HOSTS: readonly string[] = Object.values(DBT_REGIONS).map((r) => r.host);
/** An environment id: digits, a safe JSON number (`BigInt!`, documented). */
export const ENV_ID_RE = /^[1-9]\d{0,14}$/;
/** A saved query's, metric's or dimension's name as the encoder writes it (dbt names are snake case). */
export const DBT_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export type DbtGrain = 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';
export const GRAIN_OF: Readonly<Record<DateGrain, DbtGrain>> = { day: 'DAY', week: 'WEEK', month: 'MONTH', quarter: 'QUARTER', year: 'YEAR' };

// The documents (docs/live-data/dbt-semantic-layer.md). Listing and describing: the API page's paginated queries;
// `measures` is the SDK's (not on the page); the create, poll and cancel are the page's (cancel: the SDK's).
export const DOCS = {
  savedQueries: 'query SavedQueries($environmentId: BigInt!, $pageNum: Int!) { savedQueriesPaginated(environmentId: $environmentId, pageNum: $pageNum, pageSize: 100) { items { name label description } pageNum totalPages } }',
  savedQuery: 'query SavedQuery($environmentId: BigInt!, $savedQueryName: String!) { savedQuery(environmentId: $environmentId, savedQueryName: $savedQueryName) { name queryParams { metrics { name } groupBy { name grain datePart } where { whereSqlTemplate } } } }',
  dimensions: 'query Dimensions($environmentId: BigInt!, $metrics: [MetricInput!]!, $pageNum: Int!) { dimensionsPaginated(environmentId: $environmentId, metrics: $metrics, pageNum: $pageNum, pageSize: 500) { items { name description type queryableGranularities } pageNum totalPages } }',
  metrics: 'query Metrics($environmentId: BigInt!, $pageNum: Int!) { metricsPaginated(environmentId: $environmentId, pageNum: $pageNum, pageSize: 500) { items { name description type } pageNum totalPages } }',
  // With MetricFlow's non_additive_dimension (a semi-additive measure, a balance). The SDK's Measure has no such field
  // today: an API that refuses it answers no measure, so no metric is additive (fail safe).
  measures: 'query Measures($environmentId: BigInt!, $metrics: [MetricInput!]!) { measures(environmentId: $environmentId, metrics: $metrics) { name agg nonAdditiveDimension { name } } }',
  createQuery: 'mutation CreateQuery($environmentId: BigInt!, $metrics: [MetricInput!], $groupBy: [GroupByInput!], $where: [WhereInput!], $orderBy: [OrderByInput!], $limit: Int) { createQuery(environmentId: $environmentId, metrics: $metrics, groupBy: $groupBy, where: $where, orderBy: $orderBy, limit: $limit) { queryId } }',
  query: 'query QueryResult($environmentId: BigInt!, $queryId: String!, $pageNum: Int!) { query(environmentId: $environmentId, queryId: $queryId, pageNum: $pageNum) { status error totalPages jsonResult(encoded: false) } }',
  cancelQuery: 'mutation CancelQuery($environmentId: BigInt!, $queryId: String!) { cancelQuery(environmentId: $environmentId, queryId: $queryId) { queryId } }',
} as const;

export type DbtOrder = { metric: { name: string }; descending: boolean } | { groupBy: { name: string; grain?: DbtGrain }; descending: boolean };

/**
 * The encoder's request. `savedQuery` is the dataset (the connector reads it again, sends its own filter beside these,
 * and refuses a question naming what it no longer has). `nonBlank` names group-bys whose blank values (NULL, '' or
 * whitespace) the connector drops from a value list (SQL's whitespace test differs by warehouse); `cut` is then the
 * cut applied after the drop, dbt asked for every value.
 */
export interface DbtBody {
  savedQuery: string;
  metrics: Array<{ name: string }>;
  groupBy: Array<{ name: string; grain?: DbtGrain }>;
  where: Array<{ sql: string }>;
  orderBy: DbtOrder[];
  limit?: number;
  nonBlank?: string[];
  cut?: number;
}

export function isDbtBody(b: unknown): b is DbtBody {
  return typeof prop(b, 'savedQuery') === 'string' && ['metrics', 'groupBy', 'where', 'orderBy'].every((k) => Array.isArray(prop(b, k)))
    && (prop(b, 'limit') === undefined || Number.isInteger(prop(b, 'limit')));
}

/** Each column an answer to `body` carries: its reply key (a time group-by `name__grain`) and the name it comes back under. */
export function replyKeys(body: DbtBody): Array<{ key: string; name: string; metric: boolean }> {
  return [
    ...body.groupBy.map((g) => ({ key: g.grain ? `${g.name}__${g.grain.toLowerCase()}` : g.name, name: g.name, metric: false })),
    ...body.metrics.map((m) => ({ key: m.name, name: m.name, metric: true })),
  ];
}

const FINITE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function cellOf(v: unknown, metric: boolean): Cell {
  if (v === null || v === undefined) return null;
  if (metric && typeof v === 'string' && FINITE.test(v.trim())) return Number(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

/** One page's `jsonResult` (pandas' table orient, as a JSON string) → its rows, positional to `replyKeys`, or why not. */
export function readPage(body: DbtBody, jsonResult: unknown): Cell[][] | { error: string } {
  let json: unknown;
  try {
    json = typeof jsonResult === 'string' ? JSON.parse(jsonResult) as unknown : undefined;
  } catch {
    json = undefined;
  }
  const data = prop(json, 'data');
  if (!Array.isArray(data)) return { error: 'dbt answered without a table' };
  const fields = asArray(prop(prop(json, 'schema'), 'fields')).map((f) => String(prop(f, 'name') ?? ''));
  const byLower = new Map<string, string>();
  for (const f of fields) {
    if (byLower.has(f.toLowerCase())) return { error: `dbt answered two columns named ${f.toLowerCase()}` };
    byLower.set(f.toLowerCase(), f);
  }
  const keys = replyKeys(body);
  const actual = keys.map((k) => byLower.get(k.key.toLowerCase()));
  if (actual.some((a) => a === undefined)) return { error: 'dbt answered without a column it was asked for' };
  if (data.some((d) => !d || typeof d !== 'object')) return { error: 'dbt answered a row that is no object' };
  return data.map((d) => keys.map((k, i) => cellOf(prop(d, actual[i]!), k.metric)));
}

const blank = (v: Cell): boolean => v === null || (typeof v === 'string' && v.trim() === '');

/**
 * All of a question's rows (its pages, in order) → the rows named as asked, or why not, or `recut` when a cut reply
 * cannot be trusted. `cap` is the connector's row cap; `limit` the limit dbt was asked.
 */
export function finishRows(body: DbtBody, rows: Cell[][], limit: number, cap: number): ConnectorRows | { ok: false; error: string } | { recut: true } {
  const keys = replyKeys(body);
  const dims = body.groupBy.map((_g, i) => i);
  if (dims.some((i) => rows.some((r) => r[i] === '') && rows.some((r) => r[i] === null))) {
    return { ok: false, error: "dbt answered a dimension's blank both as '' and as no value; Ordinate keeps one blank group" };
  }
  const columns = keys.map(({ name }) => ({ name, type: '' }));
  if (rows.length > cap) return { ok: true, columns, rows: rows.slice(0, cap), truncated: true };
  const order = body.orderBy.map((o) => keys.findIndex((k) => ('metric' in o ? k.metric && k.name === o.metric.name : !k.metric && k.name === o.groupBy.name)));
  const cut = rows.length >= limit && limit <= cap;
  if (cut && !cutIsExact(rows, order)) return { recut: true };
  // One blank form in a cut may hide the other past it (the check above needs both, and "Other" drops both): re-ask.
  if (cut && body.groupBy.some((g, i) => !g.grain && rows.some((r) => r[i] === '' || r[i] === null))) return { recut: true };
  let out = rows;
  const drop = (body.nonBlank ?? []).map((n) => keys.findIndex((k) => !k.metric && k.name === n));
  if (drop.length) out = out.filter((r) => !drop.some((i) => blank(r[i])));
  if (body.cut !== undefined) out = out.slice(0, body.cut);
  return { ok: true, columns, rows: out, truncated: false };
}

/** A GraphQL reply's `data`, or its errors' words. */
export function dataOf(json: unknown): { ok: true; data: unknown } | { ok: false; error: string } {
  const errors = asArray(prop(json, 'errors'));
  if (errors.length) return { ok: false, error: errors.map((e) => String(prop(e, 'message') ?? 'error')).join('; ').slice(0, 400) };
  const data = prop(json, 'data');
  return data && typeof data === 'object' ? { ok: true, data } : { ok: false, error: 'dbt answered without data' };
}
