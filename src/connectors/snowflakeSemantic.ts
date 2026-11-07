// Snowflake semantic views on the EXISTING Snowflake connection (semantic layer part 7, c1;
// docs/semantic-layer/07-portability.md D14, D16; docs/live-data/snowflake-semantic-views.md) — MAIN PROCESS ONLY.
//
// The `semantic` property of the `snowflake` registry entry, never a second connector: the same account, user,
// role, warehouse, key or PAT, and every statement through that connector's own execution (./snowflake.ts), so
// the same SSRF-pinned transport, QUERY_TAG, timeout, cancel, byte ceiling and redaction (the bearer and the
// stored secrets) as any Live statement.
//
//   listModels     SHOW SEMANTIC VIEWS IN DATABASE | ACCOUNT LIMIT 1000 — no name interpolated (the database is
//                  the session's); a view whose parts are not plain identifiers is not listed
//   describeModel  DESCRIBE SEMANTIC VIEW "DB"."SCHEMA"."VIEW" — dimensions typed through the Live column mapping
//                  (a DATE or TIMESTAMP at every grain: the encoder truncates inside the clause; a TIMESTAMP_TZ
//                  unmapped, its day would be its own offset's), metrics with
//                  whether they add up (`additiveExpression`, failing safe); private members left out; a name two
//                  members share stored as TABLE.NAME, so every stored name is unambiguous in a query
//   run            the encoder's `{ sql, params }` through the connector's `runBound`: `?` binds, the row cap
//
// The capabilities stay narrow until the warehouse nightly proves more: `binaryCompare: false`, so a viewer
// restricted by a row access rule is refused on every Snowflake semantic dataset (D17).

import { DATE_GRAINS } from '../analysis/categoryKey';
import { liveColumnType } from '../data/liveSchema';
import { IDENT_RE } from './snowflakeFacts';
import type { ConnectorContext, ConnectorError, ConnectorRows, ConnectorSemantic, LiveParam } from './types';

/** What the connector lends its semantic capability: its own execution. */
export interface SnowflakeIo {
  /** One catalog statement (SHOW, DESCRIBE): no binds, no row-cap wrapper. */
  catalog(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError>;
  /** One statement with `?` binds inside the row cap: the connector's live `runBound`. */
  runBound(ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<ConnectorRows | ConnectorError>;
}

const AGGREGATE = /\b(SUM|COUNT|COUNT_IF|AVG|MIN|MAX|MEDIAN|MODE|STDDEV\w*|VAR\w*|APPROX_\w+|LISTAGG|ARRAY_AGG|OBJECT_AGG|ANY_VALUE|PERCENTILE_\w+|KURTOSIS|SKEW|CORR|COVAR_\w+|HLL\w*|BIT\w*_AGG|BOOL\w*_AGG|MIN_BY|MAX_BY)\s*\(|\bOVER\s*\(/i;

/** `s` with its string literals blanked, so a quoted bracket or word is not read as SQL. */
const unquoted = (s: string): string => s.replace(/'(?:[^'\\]|\\.|'')*'/g, "''");

/**
 * Whether a metric's expression, as DESCRIBE returns it, is one plain sum or count (D16): exactly one `SUM(…)` or
 * `COUNT(…)` — not `COUNT(DISTINCT …)` — spanning the whole expression, around an argument with no other aggregate
 * and no window. Anything else, or anything unreadable, is false: a refused running total, never a wrong sum.
 */
export function additiveExpression(expr: string): boolean {
  const m = /^\s*(SUM|COUNT)\s*\(([\s\S]*)\)\s*$/i.exec(unquoted(String(expr ?? '')));
  if (!m) return false;
  let depth = 0;
  for (const c of m[2]) {
    if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return false; // the opening bracket closed early: SUM(a) / SUM(b)
  }
  return depth === 0 && !/^\s*DISTINCT\b/i.test(m[2]) && !AGGREGATE.test(m[2]);
}

const str = (ctx: ConnectorContext, key: string): string => (typeof ctx.values[key] === 'string' ? String(ctx.values[key]).trim() : '');
const cell = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** A result's rows as objects keyed by lower-cased column name. */
function records(r: ConnectorRows): Array<Record<string, string>> {
  const names = r.columns.map((c) => c.name.toLowerCase());
  return r.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, cell(row[i])])));
}

async function listModels(io: SnowflakeIo, ctx: ConnectorContext): Promise<Awaited<ReturnType<ConnectorSemantic['listModels']>>> {
  const r = await io.catalog(ctx, `SHOW SEMANTIC VIEWS IN ${str(ctx, 'database') ? 'DATABASE' : 'ACCOUNT'} LIMIT 1000`);
  if (!r.ok) return r;
  const views = records(r).filter((v) => [v.database_name, v.schema_name, v.name].every((p) => IDENT_RE.test(p)));
  const parts = views.map((v) => [v.database_name, v.schema_name, v.name]);
  // The view's name, or as much of SCHEMA.VIEW / DATABASE.SCHEMA.VIEW as tells two of the same name apart.
  const label = (p: string[]): string => {
    for (let n = 1; n < 3; n++) if (parts.filter((q) => q.slice(-n).join('.') === p.slice(-n).join('.')).length === 1) return p.slice(-n).join('.');
    return p.join('.');
  };
  const models = views.map((v, i) => ({ name: parts[i].join('.'), label: label(parts[i]), ...(v.comment ? { description: v.comment } : {}) }));
  return { ok: true, models };
}

type Member = { kind: string; name: string; parent: string; props: Map<string, string> };

async function describeModel(io: SnowflakeIo, ctx: ConnectorContext, model: string): Promise<Awaited<ReturnType<ConnectorSemantic['describeModel']>>> {
  const parts = String(model ?? '').split('.');
  if (parts.length !== 3 || !parts.every((p) => IDENT_RE.test(p))) return { ok: false, error: 'Invalid semantic view name' };
  const r = await io.catalog(ctx, `DESCRIBE SEMANTIC VIEW ${parts.map((p) => `"${p}"`).join('.')}`);
  if (!r.ok) return r;
  if (r.truncated) return { ok: false, error: 'The semantic view has more members than Ordinate reads' };
  const members = new Map<string, Member>();
  for (const row of records(r)) {
    if (!['DIMENSION', 'FACT', 'METRIC', 'DERIVED_METRIC'].includes(row.object_kind)) continue;
    const key = `${row.object_kind}\u0000${row.parent_entity}\u0000${row.object_name}`;
    const m = members.get(key) ?? { kind: row.object_kind, name: row.object_name, parent: row.parent_entity, props: new Map<string, string>() };
    m.props.set(row.property, row.property_value);
    members.set(key, m);
  }
  const all = [...members.values()];
  const uses = new Map<string, number>();
  for (const m of all) uses.set(m.name, (uses.get(m.name) ?? 0) + 1);
  // A bare name only where it is unambiguous; a shared one qualified by its table (Snowflake requires it there).
  const stored = (m: Member): string | null => {
    if (!IDENT_RE.test(m.name)) return null;
    if (uses.get(m.name) === 1) return m.name;
    return IDENT_RE.test(m.parent) ? `${m.parent}.${m.name}` : null;
  };
  const shown = all.filter((m) => m.props.get('ACCESS_MODIFIER') !== 'PRIVATE');
  type Dimension = Extract<Awaited<ReturnType<ConnectorSemantic['describeModel']>>, { ok: true }>['dimensions'][number];
  const dimensions = shown.filter((m) => m.kind === 'DIMENSION').flatMap((m): Dimension[] => {
    const name = stored(m);
    if (!name) return [];
    const dataType = m.props.get('DATA_TYPE') ?? '';
    // shortcut: a TIMESTAMP_TZ's UTC day needs CONVERT_TIMEZONE, so its type, which no semantic record keeps; unmapped until one does
    if (/TIMESTAMP_TZ/i.test(dataType)) return [{ name, type: null }];
    const type = liveColumnType('snowflake', dataType);
    return [type === 'date' ? { name, type, grains: DATE_GRAINS.slice() } : { name, type }];
  });
  const metrics = shown.filter((m) => m.kind === 'METRIC' || m.kind === 'DERIVED_METRIC').flatMap((m) => {
    const name = stored(m);
    if (!name) return [];
    const description = m.props.get('COMMENT');
    return [{ name, additive: m.kind === 'METRIC' && additiveExpression(m.props.get('EXPRESSION') ?? ''), ...(description ? { description } : {}) }];
  });
  return { ok: true, dimensions, metrics };
}

/** The encoder's request (src/engine/live/semantic/snowflake.ts) through the connector's bound execution. */
function run(io: SnowflakeIo, ctx: ConnectorContext, body: unknown): Promise<ConnectorRows | ConnectorError> {
  const b = body as { sql?: unknown; params?: unknown } | null;
  if (!b || typeof b.sql !== 'string' || !Array.isArray(b.params)) return Promise.resolve({ ok: false, error: 'Not a semantic-view question' });
  return io.runBound(ctx, b.sql, b.params as LiveParam[]);
}

/** The `semantic` property of the `snowflake` registry entry, over that connector's execution. */
export function snowflakeSemantic(io: SnowflakeIo): ConnectorSemantic {
  return {
    backend: 'snowflake',
    caps: { lookups: true, binaryCompare: false },
    listModels: (ctx) => listModels(io, ctx),
    describeModel: (ctx, model) => describeModel(io, ctx, model),
    run: (ctx, body) => run(io, ctx, body),
  };
}
