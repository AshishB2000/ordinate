// Snowflake semantic views: b1's neutral question → ONE statement (semantic layer part 7, c1;
// docs/live-data/snowflake-semantic-views.md, docs/semantic-layer/07-portability.md D15) — PURE.
//
//   SELECT "d0" AS "<dimension>", …, CAST("m0" AS DOUBLE) AS "<metric>", …
//   FROM SEMANTIC_VIEW(
//     "DATABASE"."SCHEMA"."VIEW"
//     DIMENSIONS <the dimension, read as the Live compiler reads a column> AS "d0", …
//     METRICS "<metric>" AS "m0", …
//     WHERE <the Live compiler's predicates over the dimensions> [AND NOT <"Other": the kept values>]
//   )
//   [ORDER BY "m0" DESC NULLS LAST, "d0" ASC NULLS LAST, …] [LIMIT n]
//
// VALUES ARE BOUND: every filter value, and "Other"'s kept categories, is a `?` (the Snowflake dialect's
// `CAST(? AS …)`), sent through the connection's `runBound` — never text. IDENTIFIERS are only names the dataset
// declares or the layer's sync stored, each part a plain identifier (IDENT_RE) and double-quoted, so its case is
// Snowflake's own; anything else throws before a statement exists (the executor answers a typed failure).
//
// The dimension readings and the predicates are ../compileFilter's, in the Snowflake dialect, naming the view's
// dimensions instead of a table's columns: the same meaning, and the same SQL, as a Live dataset over a table
// (the '' → NULL fold of a text key, a finite double, a DATE at the grain, NULL compared as ''). Every member is
// aliased inside the clause, so the outer SELECT names the columns itself and casts each metric to DOUBLE (a
// NUMBER(38,s) would otherwise reach the shaping as text).

import { IDENT_RE } from '../../../connectors/snowflakeFacts';
import type { SemanticRequest } from '../../../connectors/semanticRun';
import type { DateGrain } from '../../../analysis/categoryKey';
import type { LiveColumn } from '../liveSpec';
import { columnOf, isRefusal } from '../liveSpec';
import * as cf from '../compileFilter';
import { snowflakeDialect } from '../dialects/snowflake';
import { ParamSink } from '../sqlParams';
import type { SemanticAdapter } from './adapters';
import type { SemanticQuery } from './semanticQuery';
import { answerColumns } from './semanticQuery';

const quoted = (parts: string[]): string => parts.map((p) => `"${p}"`).join('.');

/** A member as Snowflake names it: `NAME`, or `TABLE.NAME` for a name two logical tables share, each part quoted. */
export function memberRef(name: string): string {
  const parts = String(name).split('.');
  if (parts.length > 2 || !parts.every((p) => IDENT_RE.test(p))) throw new Error('[semantic] a Snowflake member name must be NAME or TABLE.NAME, plain identifiers');
  return quoted(parts);
}

function viewRef(model: string): string {
  const parts = String(model).split('.');
  if (parts.length !== 3 || !parts.every((p) => IDENT_RE.test(p))) throw new Error('[semantic] a Snowflake semantic view is DATABASE.SCHEMA.VIEW, plain identifiers');
  return quoted(parts);
}

/** The compiler's context over the view's dimensions. */
export function memberCtx(columns: readonly LiveColumn[]): cf.Ctx {
  return { d: snowflakeDialect, b: new ParamSink(), columns: columns.slice(), ref: (col) => memberRef(col.name) };
}

/** A dimension as the Live compiler reads a column: a text key ('' folded into NULL), a finite double, a DATE at its grain. */
export function dimensionReading(c: cf.Ctx, col: LiveColumn, grain: DateGrain | undefined): string {
  if (col.type === 'text') return cf.keyText(c, col);
  if (col.type === 'number') return cf.numberOf(c, col);
  if (!grain) throw new Error(`[semantic] the date dimension ${col.name} needs a grain`);
  const day = cf.dateOf(c, col);
  return grain === 'day' ? day : c.d.trunc(day, grain);
}

function encode(q: SemanticQuery, model: string, columns: readonly LiveColumn[] = []): SemanticRequest {
  const view = viewRef(model);
  const c = memberCtx(columns);
  const names = answerColumns(q);
  if (names.length === 0) throw new Error('[semantic] a question needs a dimension or a metric');
  if (new Set(names).size !== names.length) throw new Error('[semantic] a member asked twice: its rows could not be told apart');
  const alias = new Map<string, string>();
  const dims = q.dimensions.map((x, i) => {
    const col = columnOf(c.columns, x.name);
    if (!col) throw new Error(`[semantic] ${x.name} is not a dimension of this dataset`);
    alias.set(x.name, `"d${i}"`);
    return `${dimensionReading(c, col, x.grain)} AS "d${i}"`;
  });
  const metrics = q.metrics.map((m, j) => {
    alias.set(m, `"m${j}"`);
    return `${memberRef(m)} AS "m${j}"`;
  });
  const preds = cf.predicates(c, q.where);
  if (isRefusal(preds)) throw new Error(`[semantic] a filter the layer cannot apply: ${preds.code}`);
  if (q.exclude) {
    const kept = cf.predicate(c, { kind: 'in', column: q.exclude.dimension, values: q.exclude.values, negate: false });
    if (typeof kept !== 'string') throw new Error(`[semantic] "Other" cannot exclude by ${q.exclude.dimension}`);
    preds.push(`NOT ${kept}`);
  }
  const order = q.order.map((o) => {
    const a = alias.get(o.by);
    if (!a) throw new Error(`[semantic] cannot order by ${o.by}: it is not asked`);
    return `${a} ${o.desc ? 'DESC' : 'ASC'} NULLS LAST`;
  });
  if (q.limit !== undefined && !(Number.isInteger(q.limit) && q.limit >= 0)) throw new Error('[semantic] a limit must be a whole number');
  const select = [
    ...q.dimensions.map((x, i) => `"d${i}" AS "${x.name}"`),
    ...q.metrics.map((m, j) => `CAST("m${j}" AS DOUBLE) AS "${m}"`),
  ];
  const sql = [
    `SELECT ${select.join(', ')}`,
    'FROM SEMANTIC_VIEW(',
    `  ${view}`,
    ...(dims.length ? [`  DIMENSIONS ${dims.join(', ')}`] : []),
    ...(metrics.length ? [`  METRICS ${metrics.join(', ')}`] : []),
    ...(preds.length ? [`  WHERE ${preds.join(' AND ')}`] : []),
    ')',
    ...(order.length ? [`ORDER BY ${order.join(', ')}`] : []),
    ...(q.limit !== undefined ? [`LIMIT ${q.limit}`] : []),
  ].join('\n');
  const done = c.b.finish(sql, snowflakeDialect, names);
  return { kind: 'semantic', body: { sql: done.sql, params: done.params }, columns: names };
}

/** The Snowflake semantic-view encoder: registered in ./adapters as the `snowflake` backend. */
export const snowflakeAdapter = { encode } satisfies SemanticAdapter; // it never refuses: its encode is a request
