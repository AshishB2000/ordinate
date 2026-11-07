// Cube's REST API on the wire (semantic layer part 7, e1; docs/live-data/cube.md) — PURE.
//
// The query object Ordinate sends to `POST <base>/v1/load` (written by src/engine/live/semantic/cube.ts), the body
// the encoder hands the connector, and how a reply is read back into rows named as the question asked them
// (`readLoad`, used by ./cube.ts). Nothing here opens a socket.
//
// Reading a reply is strict and exact. A cell is a number only where Cube's own `annotation` types its member
// `number` and the text is a finite number (Cube passes Postgres `numeric` and `bigint` as strings). A dimension
// answered both as '' and as NULL is refused: Ordinate keeps one blank group where Cube has two, and joining them
// would be arithmetic on the layer's figures. A reply cut by its limit is checked against Ordinate's order (a NULL
// last): when an order column holds a NULL before a value, the warehouse under Cube sorted it first, the cut may
// have kept the wrong rows, and the caller asks again without the cut (`recut`).

import type { Cell } from './httpShared';
import { asArray, prop } from './httpShared';
import type { ConnectorRows } from './types';

/** A Cube cube, view or member name: what the encoder writes and the listing keeps. */
export const CUBE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The most rows one question asks for: Cube's default `CUBEJS_DB_QUERY_LIMIT`. A reply that fills it is refused. */
export const CUBE_ROW_LIMIT = 50_000;

export type CubeOperator = 'equals' | 'notEquals' | 'set' | 'notSet' | 'gt' | 'gte' | 'lt' | 'lte' | 'afterOrOnDate' | 'beforeDate';
export type CubeFilter =
  | { member: string; operator: CubeOperator; values?: string[] }
  | { and: CubeFilter[] }
  | { or: CubeFilter[] };

export interface CubeQuery {
  measures: string[];
  dimensions: string[];
  timeDimensions: Array<{ dimension: string; granularity: string }>;
  filters: CubeFilter[];
  order: Array<[string, 'asc' | 'desc']>;
  limit: number;
  timezone: 'UTC';
}

/**
 * The encoder's request body. `query` is all Cube sees. `nonBlank` names text members whose blank values (null,
 * '' or whitespace) the connector drops from a value list (Cube cannot test whitespace); `limit` is then the cut
 * applied after the drop, the query itself asking for every value.
 */
export interface CubeBody {
  query: CubeQuery;
  nonBlank?: string[];
  limit?: number;
}

export function isCubeBody(b: unknown): b is CubeBody {
  const q = prop(b, 'query');
  return !!q && typeof q === 'object' && Array.isArray(prop(q, 'measures')) && Array.isArray(prop(q, 'dimensions'))
    && Array.isArray(prop(q, 'timeDimensions')) && Array.isArray(prop(q, 'filters')) && Array.isArray(prop(q, 'order'))
    && Number.isInteger(prop(q, 'limit'));
}

/** A member's name in the model: `orders.region` → `region`. */
export const shortName = (member: string): string => member.slice(member.indexOf('.') + 1);

/** Each reply key the query asks for, with the name its column comes back under. */
export function replyKeys(q: CubeQuery): Array<{ key: string; name: string }> {
  return [
    ...q.timeDimensions.map((t) => ({ key: `${t.dimension}.${t.granularity}`, name: shortName(t.dimension) })),
    ...q.dimensions.map((d) => ({ key: d, name: shortName(d) })),
    ...q.measures.map((m) => ({ key: m, name: shortName(m) })),
  ];
}

const FINITE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** The members the reply's annotation types `number`. */
function numberMembers(json: unknown): Set<string> {
  const out = new Set<string>();
  for (const part of ['measures', 'dimensions']) {
    const a = prop(prop(json, 'annotation'), part);
    if (a && typeof a === 'object') for (const [k, v] of Object.entries(a)) if (prop(v, 'type') === 'number') out.add(k);
  }
  return out;
}

function cellOf(v: unknown, numeric: boolean): Cell {
  if (v === null || v === undefined) return null;
  if (numeric && typeof v === 'string' && FINITE.test(v.trim())) return Number(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

const blank = (v: Cell): boolean => v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Whether the first `limit` rows Cube returned are the first `limit` under Ordinate's order, a NULL last either way:
 * key by key, each column's NULLs only after its values, within the rows tied with the last row on every key before.
 * Rows that open with a NULL prove nothing (the warehouse may sort NULLs first, every value past the cut): not exact.
 */
export function cutIsExact(rows: Cell[][], keys: number[]): boolean {
  let tied = rows;
  for (const k of keys) {
    const firstNull = tied.findIndex((r) => r[k] === null);
    if (firstNull === 0 || (firstNull > 0 && tied.slice(firstNull).some((r) => r[k] !== null))) return false;
    const last = tied[tied.length - 1]?.[k] ?? null;
    tied = tied.filter((r) => Object.is(r[k], last));
    if (tied.length <= 1) return true;
  }
  return true;
}

export type LoadRead = ConnectorRows | { ok: false; error: string } | { recut: true };

/** One /v1/load reply → rows named as the question asked them, or why not. */
export function readLoad(body: CubeBody, json: unknown): LoadRead {
  const data = prop(json, 'data');
  if (!Array.isArray(data)) return { ok: false, error: 'Cube answered without data' };
  const keys = replyKeys(body.query);
  if (data.some((d) => !d || typeof d !== 'object' || keys.some(({ key }) => !Object.prototype.hasOwnProperty.call(d, key)))) {
    return { ok: false, error: 'Cube answered without a member it was asked for' };
  }
  const numeric = numberMembers(json);
  let rows: Cell[][] = data.map((d) => keys.map(({ key }) => cellOf(prop(d, key), numeric.has(key))));
  const dims = body.query.dimensions.map((d) => keys.findIndex((k) => k.key === d));
  if (dims.some((i) => rows.some((r) => r[i] === '') && rows.some((r) => r[i] === null))) {
    return { ok: false, error: "Cube answered a dimension's blank both as '' and as no value; Ordinate keeps one blank group (declare the dimension NULLIF(…, '') in the model)" };
  }
  const full = rows.length >= body.query.limit;
  if (full && body.query.limit === CUBE_ROW_LIMIT) return { ok: true, columns: keys.map(({ name }) => ({ name, type: '' })), rows: rows.slice(0, CUBE_ROW_LIMIT), truncated: true };
  const order = body.query.order.map(([m]) => keys.findIndex((k) => k.key === m || k.key.startsWith(`${m}.`)));
  if (full && !cutIsExact(rows, order)) return { recut: true };
  // One blank form in a cut may hide the other past it (the check above needs both, and "Other" drops both): re-ask.
  if (full && dims.some((i) => !numeric.has(keys[i].key) && rows.some((r) => r[i] === '' || r[i] === null))) return { recut: true };
  const drop = new Set((body.nonBlank ?? []).map((m) => keys.findIndex((k) => k.key === m)));
  if (drop.size) rows = rows.filter((r) => ![...drop].some((i) => blank(r[i])));
  if (body.limit !== undefined) rows = rows.slice(0, body.limit);
  return { ok: true, columns: keys.map(({ name }) => ({ name, type: '' })), rows, truncated: false };
}

/**
 * One question's rows: `post` sends a body to /v1/load and returns Cube's answer (polling is its business). A reply
 * whose cut cannot be trusted is asked again without the cut (CUBE_ROW_LIMIT), and ranked by the caller.
 */
export async function loadRows(body: CubeBody, post: (b: CubeBody) => Promise<{ ok: true; json: unknown } | { ok: false; error: string }>): Promise<ConnectorRows | { ok: false; error: string }> {
  for (const b of [body, { ...body, query: { ...body.query, limit: CUBE_ROW_LIMIT } }]) {
    const answer = await post(b);
    if (!answer.ok) return answer;
    const read = readLoad(b, answer.json);
    if (!('recut' in read)) return read;
  }
  return { ok: false, error: 'Cube answered a full reply twice' }; // unreachable: a reply at the cap is never re-cut
}

/** The listing's and describe's access to /v1/meta: its cubes and views. */
export const metaCubes = (json: unknown): unknown[] => asArray(prop(json, 'cubes'));
