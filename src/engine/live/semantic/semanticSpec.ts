// The three doors' questions on a semantic dataset (semantic layer part 7, b2; docs/semantic-layer/07-portability.md
// D12, D16) — PURE. The twins of ../liveSpec's adapters: the same IR, but every measure is a layer metric by its name
// there — a chart or answer measure names its mirror metric (`metricId` → `mirrors`), a KPI asks `{ metric }` — and a
// column measure is refused (`columnOnLayer`: aggregating a dimension ourselves goes around the layer). What needs
// rows is refused with the layer's sentence, under the code it has on any Live dataset.

import type { AnswerSpec } from '../../../ai/answerSpec';
import type { VizEncoding } from '../../../analysis/visuals';
import type { FilterStep } from '../../../data/transforms';
import type { AdaptOpts, LiveAdapted, LiveColumn, LiveRefusal, MeasureReader } from '../liveSpec';
import { adaptFilters, fromAnswerSpec, fromVizEncoding, isRefusal, refuse } from '../liveSpec';
import type { RowNeedingCode } from './semanticRefusals';
import { refuseLayer } from './semanticRefusals';
import type { SemanticEnv } from './semanticQuery';

const ROW_CODES: ReadonlySet<string> = new Set<RowNeedingCode>(['pivot', 'cohort', 'funnel', 'drivers', 'facet', 'map', 'raw', 'related']);

const names = (env: SemanticEnv): { dataset: string; layer: string } => ({ dataset: env.dataset, layer: env.layer });

/** A refusal that needs rows says so naming the layer; every other one is as the adapter gave it. */
export function layerWorded<T>(r: T | LiveRefusal, env: SemanticEnv): T | LiveRefusal {
  return isRefusal(r) && ROW_CODES.has(r.code) ? refuseLayer(r.code as RowNeedingCode, names(env)) : r;
}

/** A chart or answer measure: its mirror's layer metric, or `columnOnLayer`. */
function mirrorReader(env: SemanticEnv, mirrors: ReadonlyMap<string, string> | undefined): MeasureReader {
  return (v) => {
    const external = typeof v.metricId === 'string' ? mirrors?.get(v.metricId) : undefined;
    return external !== undefined ? { metric: external } : refuseLayer('columnOnLayer', { ...names(env), column: typeof v.column === 'string' ? v.column : '' });
  };
}

/** `vizDataFor`'s question on a semantic dataset. */
export function fromSemanticViz(encoding: VizEncoding, filters: FilterStep[], columns: LiveColumn[], env: SemanticEnv, opts: AdaptOpts = {}): LiveAdapted {
  return layerWorded(fromVizEncoding(encoding, filters, columns, opts, mirrorReader(env, opts.mirrors)), env);
}

/** `computeCard`'s question on a semantic dataset. */
export function fromSemanticAnswer(spec: AnswerSpec, columns: LiveColumn[], env: SemanticEnv, opts: AdaptOpts = {}): LiveAdapted {
  return layerWorded(fromAnswerSpec(spec, columns, opts, mirrorReader(env, opts.mirrors)), env);
}

/** `computeCardMetric`'s question on a semantic dataset: one layer metric, by name. */
export function fromSemanticMetric(spec: { column: string; aggregation: string } | { metric: string }, filters: FilterStep[], columns: LiveColumn[], env: SemanticEnv, opts: AdaptOpts = {}): LiveAdapted {
  if (!spec || typeof spec !== 'object') return refuse('noMeasure');
  if (!('metric' in spec) || typeof spec.metric !== 'string') return refuseLayer('columnOnLayer', { ...names(env), column: String((spec as { column?: unknown }).column ?? '') });
  const f = adaptFilters(filters, columns, opts);
  if (!f.ok) return layerWorded(f, env);
  return { ok: true, ir: { kind: 'metric', measures: [{ metric: spec.metric }], filters: f.filters, order: 'natural', weekCal: null }, warnings: f.warnings };
}
