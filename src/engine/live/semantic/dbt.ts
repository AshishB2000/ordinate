// dbt Semantic Layer (BETA): b1's neutral question → ONE createQuery's variables (semantic layer part 7, d1;
// docs/live-data/dbt-semantic-layer.md, docs/semantic-layer/07-portability.md D15) — PURE.
//
//   { savedQuery: "orders", metrics: [{ name: "revenue" }], groupBy: [{ name: "metric_time", grain: "MONTH" }],
//     where: [{ sql: "{{ Dimension('customer__region') }} = 'West'" }],
//     orderBy: [{ metric: { name: "revenue" }, descending: true }, { groupBy: { name: "metric_time", grain: "MONTH" }, descending: false }],
//     limit: 51 }
//
// NAMES travel as GraphQL variables, each a dbt identifier from the dataset's declared dimensions and the layer's
// synced metrics; anything else throws. VALUES reach dbt only inside `where` text, written by ./literals (the closed
// encoder: what it cannot write exactly is refused `layerFilter`, never dropped, never inlined raw). The saved query
// itself is named, never run by name: the connector reads it again, adds its own filter, and checks the names.

import type { DbtBody, DbtOrder } from '../../../connectors/dbtWire';
import { DBT_IDENT_RE, GRAIN_OF } from '../../../connectors/dbtWire';
import type { SemanticRequest } from '../../../connectors/semanticRun';
import type { LiveColumn, LiveRefusal } from '../liveSpec';
import { columnOf, isRefusal } from '../liveSpec';
import type { SemanticAdapter } from './adapters';
import { DBT_NAME_RE, dimensionRef, whereText } from './literals';
import type { SemanticQuery } from './semanticQuery';
import { answerColumns } from './semanticQuery';

const named = (name: string, what: string): string => {
  if (!DBT_NAME_RE.test(String(name))) throw new Error(`[semantic] a dbt ${what} must be a dbt name`);
  return name;
};

function encode(q: SemanticQuery, model: string, columns: readonly LiveColumn[] = [], names = { dataset: '', layer: 'dbt' }): SemanticRequest | LiveRefusal {
  if (!DBT_IDENT_RE.test(String(model))) throw new Error('[semantic] a dbt saved query must be a dbt name');
  const asked = answerColumns(q);
  if (asked.length === 0) throw new Error('[semantic] a question needs a dimension or a metric');
  if (new Set(asked).size !== asked.length) throw new Error('[semantic] a member asked twice: its rows could not be told apart');
  if (q.limit !== undefined && !(Number.isInteger(q.limit) && q.limit >= 0 && q.limit <= 100_000)) throw new Error('[semantic] a limit must be a whole number under the row cap');
  const groupBy: DbtBody['groupBy'] = q.dimensions.map((d) => {
    const col = columnOf(columns.slice(), d.name);
    if (!col) throw new Error(`[semantic] ${d.name} is not a dimension of this dataset`);
    if (col.type === 'number') throw new Error(`[semantic] dbt types no dimension a number (${d.name})`);
    if (col.type !== 'date') return { name: named(d.name, 'dimension') };
    if (!d.grain) throw new Error(`[semantic] the date dimension ${d.name} needs a grain`);
    return { name: named(d.name, 'dimension'), grain: GRAIN_OF[d.grain] };
  });
  const metrics = q.metrics.map((m) => ({ name: named(m, 'metric') }));
  const where: DbtBody['where'] = [];
  const nonBlank: string[] = [];
  const synced = new Set(columns.map((c) => c.name));
  for (const f of q.where) {
    const col = columnOf(columns.slice(), f.column);
    // A value list's own "not empty" on a text dimension it lists: '' and NULL out at dbt, whitespace out when read.
    if (q.metrics.length === 0 && f.kind === 'empty' && f.negate && col?.type === 'text' && q.dimensions.some((d) => d.name === col.name)) {
      const ref = dimensionRef(col.name, synced);
      if (!ref) throw new Error(`[semantic] ${col.name} is not a dbt name`);
      where.push({ sql: `${ref} <> ''` });
      nonBlank.push(col.name);
      continue;
    }
    const w = whereText(f, columns, names);
    if (isRefusal(w)) return w;
    where.push({ sql: w.text });
  }
  if (q.exclude) {
    // "Other": every row but the kept categories', as a `not in` (dbt computes it).
    const w = whereText({ kind: 'in', column: q.exclude.dimension, values: q.exclude.values, negate: true }, columns, names);
    if (isRefusal(w)) return w;
    where.push({ sql: w.text });
  }
  const orderBy: DbtOrder[] = q.order.map((o) => {
    if (!asked.includes(o.by)) throw new Error(`[semantic] cannot order by ${o.by}: it is not asked`);
    const g = groupBy.find((x) => x.name === o.by);
    return g && !q.metrics.includes(o.by) ? { groupBy: { ...g }, descending: o.desc } : { metric: { name: o.by }, descending: o.desc };
  });
  const body: DbtBody = { savedQuery: model, metrics, groupBy, where, orderBy };
  if (nonBlank.length) {
    body.nonBlank = nonBlank;
    if (q.limit !== undefined) body.cut = q.limit; // the cut comes after the blanks are dropped
  } else if (q.limit !== undefined) {
    body.limit = q.limit;
  }
  return { kind: 'semantic', body, columns: asked };
}

/** The dbt encoder: registered in ./adapters as the `dbt` backend. */
export const dbtAdapter: SemanticAdapter = { encode };
