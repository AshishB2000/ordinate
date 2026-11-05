// The test harness's FAKE SEMANTIC LAYER (semantic layer part 7, b1; docs/semantic-layer/07-portability.md
// Tests, "Layer parity"). Not a suite itself.
//
// CI has no Snowflake semantic view, Cube or dbt Cloud, so this layer answers a neutral `SemanticQuery` by
// running, in DuckDB, the SQL its metric definitions (FAKE_METRICS) expand to, over a table the test loaded.
// Its dimensions and filters read the table as the Live compiler does (compileFilter: the '' → NULL fold of a
// text key, the declared-type casts, the filter semantics), so the parity suite proves OUR plan and shaping,
// not a vendor's math or collation: each backend's own differences are pinned by its own PR (c1, e1, d1).
//
// Test code: values are bound parameters, identifiers come from the declared columns only.

import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { SemanticAnswer, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';

const cf: typeof import('../src/engine/live/compileFilter') = require('../src/engine/live/compileFilter');
const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const sqlParams: typeof import('../src/engine/live/sqlParams') = require('../src/engine/live/sqlParams');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');

/** The layer's metrics, over the parity fixture's `amt`. The first two can be added up. */
export const FAKE_METRICS: Readonly<Record<string, string>> = {
  revenue: 'SUM(lv_src."amt")',
  orders: 'COUNT(*)',
  avg_amount: 'AVG(lv_src."amt")',
  max_amount: 'MAX(lv_src."amt")',
};
export const FAKE_ADDITIVE: ReadonlySet<string> = new Set(['revenue', 'orders']);

/** The SQL the fake runs for `q` over `table` (declared `columns`): dimensions then metrics, by position. */
export function fakeSql(table: string, columns: LiveColumn[], q: SemanticQuery): import('../src/engine/live/sqlParams').CompiledQuery {
  const d = dialects.dialectFor('duckdb');
  const c = { d, b: new sqlParams.ParamSink(), columns };
  const col = (name: string): LiveColumn => {
    const found = spec.columnOf(columns, name);
    if (!found) throw new Error(`fake layer: no dimension ${name}`);
    return found;
  };
  const alias = new Map<string, string>();
  const sel = q.dimensions.map((dim, i) => {
    const k = col(dim.name);
    alias.set(dim.name, `d${i}`);
    if (k.type === 'text') return `${d.label(cf.keyText(c, k))} AS d${i}`; // label: the bench's BOM fix (dialects/duckdb)
    if (k.type === 'number') return `${cf.numberOf(c, k)} AS d${i}`;
    if (!dim.grain) throw new Error(`fake layer: ${dim.name} needs a grain`);
    const day = cf.dateOf(c, k);
    // A JSON API's spelling of a date: ISO text at the grain's first day.
    return `strftime(${dim.grain === 'day' ? day : d.trunc(day, dim.grain)}, '%Y-%m-%d') AS d${i}`;
  });
  q.metrics.forEach((m, j) => {
    if (!FAKE_METRICS[m]) throw new Error(`fake layer: no metric ${m}`);
    alias.set(m, `m${j}`);
    sel.push(`${d.toDouble(FAKE_METRICS[m])} AS m${j}`);
  });
  const preds = cf.predicates(c, q.where);
  if (!Array.isArray(preds)) throw new Error(`fake layer: ${preds.message}`);
  if (q.exclude) preds.push(`NOT ${cf.predicate(c, { kind: 'in', column: q.exclude.dimension, values: q.exclude.values, negate: false }) as string}`);
  const order = q.order.map((o) => {
    const a = alias.get(o.by);
    if (!a) throw new Error(`fake layer: cannot order by ${o.by}`);
    return `${cf.nullsLast(a)}, ${a}${o.desc ? ' DESC' : ''}`;
  });
  if (q.limit !== undefined && !Number.isInteger(q.limit)) throw new Error('fake layer: a bad limit');
  const sql = `SELECT ${sel.join(', ')} FROM "${table}" AS lv_src${preds.length ? ` WHERE ${preds.join(' AND ')}` : ''}` +
    `${q.dimensions.length ? ` GROUP BY ${q.dimensions.map((_x, i) => `d${i}`).join(', ')}` : ''}` +
    `${order.length ? ` ORDER BY ${order.join(', ')}` : ''}${q.limit !== undefined ? ` LIMIT ${q.limit}` : ''}`;
  return c.b.finish(sql, d, [...q.dimensions.map((_x, i) => `d${i}`), ...q.metrics.map((_x, j) => `m${j}`)]);
}

/** Answer `q` from `table`, columns named by the query's dimensions then metrics (a layer's member names). */
export async function runFake(table: string, columns: LiveColumn[], q: SemanticQuery): Promise<SemanticAnswer> {
  const compiled = fakeSql(table, columns, q);
  return { columns: [...q.dimensions.map((x) => x.name), ...q.metrics], rows: await fx.runDuck(compiled) };
}
