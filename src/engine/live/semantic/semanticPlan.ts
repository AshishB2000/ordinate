// The plan: a Live IR → the questions a semantic layer can answer (semantic layer part 7, b1;
// docs/semantic-layer/07-portability.md D12, D16, D17) — PURE.
//
// The layer computes every figure. So a question is planned only where no Ordinate arithmetic on the
// layer's figures is needed, and everything else is refused, typed, in a sentence naming the layer:
//
//   text axis   the top 51 by the first metric. Only when a 51st comes back is "Other" asked as a
//               second question (`exclude` the 50 kept): the layer computes it, right even for a ratio.
//   date axis   at a grain the layer lists for that dimension; no automatic grain (`autoGrain`), no
//               retail calendar rolled up from days (`weekRollup`; `day` needs none).
//   split       the category ranks, the series ranks (a text split), the cells of the kept categories,
//               and "Other" by series: up to four questions, each counted at the one door.
//   KPI         one question, no dimension. An answer's "last quarter": the latest day, asked as a
//               lookup only of a backend that has them (`layerLookup`).
//
// Refused: number bins (`bins`), a column measure (`columnOnLayer`: aggregating a dimension ourselves
// goes around the layer), a metric the layer no longer lists (`metricMissing`), and a row lock unless
// the backend compares exactly (`layerRowPolicy`, D17: row access fails closed on a layer).

import { CATEGORY_CAP } from '../../../analysis/categoryKey';
import type { Cell } from '../../../data/transforms';
import type { LiveFilter, LiveIR, LiveRefusal } from '../liveSpec';
import { columnOf, isMetricMeasure, isRefusal, refuse } from '../liveSpec';
import { latestColumns } from '../compile';
import { refuseLayer } from './semanticRefusals';
import type { SemanticEnv, SemanticFilter, SemanticQuery } from './semanticQuery';

export type ChartPlan = {
  ok: true;
  /** First: the categories (with every metric, unsplit), ranked; a date split's cells too. */
  ranks: SemanticQuery;
  /** A split by a text column: the series, ranked by the first metric. */
  seriesRanks?: SemanticQuery;
  /** A text axis's split: the cells of the categories kept. */
  cells?: (kept: Cell[]) => SemanticQuery;
  /** A text axis: "Other", everything but the kept categories (by series, split). Asked only past the cap. */
  other?: (kept: Cell[]) => SemanticQuery;
};

type Dim = SemanticQuery['dimensions'][number];

const namesOf = (env: SemanticEnv): { dataset: string; layer: string } => ({ dataset: env.dataset, layer: env.layer });

/** The IR's measures as the layer's metric names, or why not. */
function metricsOf(ir: LiveIR, env: SemanticEnv): string[] | LiveRefusal {
  if (!Array.isArray(ir.measures) || ir.measures.length === 0) return refuse('noMeasure');
  const out: string[] = [];
  for (const m of ir.measures) {
    if (!isMetricMeasure(m)) return refuseLayer('columnOnLayer', { ...namesOf(env), column: m.column });
    if (!env.metrics.has(m.metric)) return refuseLayer('metricMissing', { ...namesOf(env), metric: m.metric });
    out.push(m.metric);
  }
  return out;
}

/** The base filters, then the question's, as the layer applies them. */
function whereOf(filters: readonly LiveFilter[], env: SemanticEnv): SemanticFilter[] | LiveRefusal {
  const out: SemanticFilter[] = [];
  for (const f of [...(env.base ?? []), ...filters]) {
    if (f.kind === 'latest') return refuse('unresolvedPeriod');
    if (!columnOf(env.columns, f.column)) return refuse('unknownColumn', f.column);
    if ('binary' in f && f.binary === true && !env.caps.binaryCompare) return refuseLayer('layerRowPolicy', namesOf(env));
    out.push(f);
  }
  return out;
}

/** The category as a layer dimension, or why the layer cannot group by it. */
function dimensionOf(ir: LiveIR, env: SemanticEnv): Dim | LiveRefusal {
  const cat = ir.category;
  if (!cat) return refuse('noCategory');
  if (!columnOf(env.columns, cat.column)) return refuse('unknownColumn', cat.column);
  if (cat.kind === 'bins') return refuseLayer('bins', { ...namesOf(env), column: cat.column });
  if (cat.kind === 'text') return { name: cat.column };
  if (!cat.grain) return refuseLayer('autoGrain', { ...namesOf(env), column: cat.column });
  // A week calendar buckets every grain but `day` in OUR code, from days (evaluate.resolveKey): a sum of the layer's figures.
  if (ir.weekCal && cat.grain !== 'day') return refuseLayer('weekRollup', namesOf(env));
  if (!(env.grains.get(cat.column) ?? []).includes(cat.grain)) return refuseLayer('autoGrain', { ...namesOf(env), column: cat.column });
  return { name: cat.column, grain: cat.grain };
}

/** A chart's (or an answer's) questions. */
export function planChart(ir: LiveIR, env: SemanticEnv): ChartPlan | LiveRefusal {
  if (!ir || ir.kind !== 'chart') return refuse('badQuery');
  const metrics = metricsOf(ir, env);
  if (isRefusal(metrics)) return metrics;
  const dim = dimensionOf(ir, env);
  if (isRefusal(dim)) return dim;
  const where = whereOf(ir.filters, env);
  if (isRefusal(where)) return where;
  const text = dim.grain === undefined;
  if (!text && (ir.order === 'value' || ir.top !== undefined)) return refuse('rankOnDate');
  if (ir.top !== undefined && (!Number.isInteger(ir.top) || ir.top < 1 || ir.order !== 'value')) return refuse('badQuery');

  const q = (dimensions: Dim[], ms: string[], order: SemanticQuery['order'], extra: Partial<SemanticQuery> = {}): SemanticQuery =>
    ({ dimensions, metrics: ms, where, order, ...extra });
  // Largest first by the first metric, then the key: the order the SQL path ranks a text axis by.
  const byValue = (key: string): SemanticQuery['order'] => [{ by: metrics[0], desc: true }, { by: key, desc: false }];
  const asc = (...keys: string[]): SemanticQuery['order'] => keys.map((by) => ({ by, desc: false }));
  const top = { limit: CATEGORY_CAP + 1 };
  const without = (kept: Cell[]): Partial<SemanticQuery> => ({ exclude: { dimension: dim.name, values: kept.slice() } });

  if (!ir.series) {
    if (!text) return { ok: true, ranks: q([dim], metrics, asc(dim.name)) };
    return { ok: true, ranks: q([dim], metrics, byValue(dim.name), top), other: (kept) => q([], metrics, [], without(kept)) };
  }
  const s = columnOf(env.columns, ir.series);
  if (!s) return refuse('unknownColumn', ir.series);
  if (s.type === 'date') return refuse('dateSeries', s.name);
  const series: Dim = { name: s.name };
  const m0 = [metrics[0]]; // a split draws its first measure only (liveSpec chartCore)
  const seriesRanks = s.type === 'text' ? { seriesRanks: q([series], m0, byValue(s.name)) } : {};
  if (!text) return { ok: true, ranks: q([dim, series], m0, asc(dim.name, s.name)), ...seriesRanks };
  return {
    ok: true,
    ranks: q([dim], m0, byValue(dim.name), top),
    ...seriesRanks,
    cells: (kept) => ({ ...q([dim, series], m0, asc(dim.name, s.name)), where: [...where, { kind: 'in', column: dim.name, values: kept.slice(), negate: false }] }),
    other: (kept) => q([series], m0, asc(s.name), without(kept)),
  };
}

/** A KPI's one question: no dimension. */
export function planMetric(ir: LiveIR, env: SemanticEnv): { ok: true; query: SemanticQuery } | LiveRefusal {
  if (!ir || ir.kind !== 'metric' || !Array.isArray(ir.measures) || ir.measures.length !== 1) return refuse('badQuery');
  const metrics = metricsOf(ir, env);
  if (isRefusal(metrics)) return metrics;
  const where = whereOf(ir.filters, env);
  if (isRefusal(where)) return where;
  return { ok: true, query: { dimensions: [], metrics, where, order: [] } };
}

/**
 * The latest day per column an answer's data-relative period reads ("last quarter"), as lookups: the
 * day dimension alone, latest first, one row. Over the rows a copy would hold, narrowed only by a row
 * lock and the base filters (compile.compileLatestDates). A backend without lookups refuses it.
 */
export function planLatest(ir: LiveIR, env: SemanticEnv): { ok: true; queries: Array<{ column: string; query: SemanticQuery }> } | LiveRefusal {
  const names = latestColumns(ir);
  if (names.length === 0) return { ok: true, queries: [] };
  if (!env.caps.lookups) return refuseLayer('layerLookup', namesOf(env));
  const where = whereOf(ir.filters.filter((f) => 'binary' in f && f.binary === true), env);
  if (isRefusal(where)) return where;
  const queries: Array<{ column: string; query: SemanticQuery }> = [];
  for (const column of names) {
    const col = columnOf(env.columns, column);
    if (!col) return refuse('unknownColumn', column);
    if (col.type !== 'date') return refuse('periodNotDate', column);
    if (!(env.grains.get(column) ?? []).includes('day')) return refuseLayer('layerLookup', namesOf(env));
    // Not empty: the latest DATE, however the layer orders a NULL.
    const query: SemanticQuery = { dimensions: [{ name: column, grain: 'day' }], metrics: [], where: [...where, { kind: 'empty', column, negate: true }], order: [{ by: column, desc: true }], limit: 1 };
    queries.push({ column, query });
  }
  return { ok: true, queries };
}
