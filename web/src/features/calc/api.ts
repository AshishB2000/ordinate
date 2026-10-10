// The calculated-field dialog's one server call of its own, and its pure
// helpers. `metric:check` (src/ipc/metricCheck.ts) answers everything the
// measure editor shows about a formula: the tokens it colours, the error and
// its span, whether the name is free, and the figure on the current data.
// NOTHING HERE PARSES OR COMPUTES — a template only writes formula text, and the
// server still validates and calculates it.

import { rpc } from '../../api/client';
import type { MetricFormat, MetricSummary } from '../analyses/metrics/api';
import { isFormula } from '../analyses/metrics/api';
import type { FunctionDoc, Tok } from '../prepare/api';
import type { Measure } from '../visuals/api';

export interface MetricCheck {
  /** The formula is a metric AND its figure was computed. */
  ok: boolean;
  /** The formula is a metric — Save may go ahead (a Live warehouse that is down still leaves a valid definition). */
  valid: boolean;
  tokens: Tok[];
  /** `syntax`, `circular`, `column`, `unknown`, `dataset`, `type` — or a `live_…` code when the figure was refused. */
  code?: string;
  error?: string;
  at?: { start: number; end: number };
  nameError?: string;
  preview?: { ok: true; value: number | null; display: string; definitionText: string; asOf?: { mode?: string } };
}

export async function checkMetric(input: { projectId: string; datasetId: string; expression: string; name?: string; id?: string; format?: MetricFormat; chart?: boolean }): Promise<MetricCheck> {
  return (await rpc('metric:check', input)) as MetricCheck;
}

/** The five totals a measure is made of — the language's own, listed first in the editor. */
export const AGG_DOCS: FunctionDoc[] = [
  { name: 'sum', category: 'totals', signature: 'sum(column)', summary: 'The total of a number column.', example: 'sum([Revenue])' },
  { name: 'avg', category: 'totals', signature: 'avg(column)', summary: 'The average of a number column.', example: 'avg([Price])' },
  { name: 'count', category: 'totals', signature: 'count(column)', summary: 'How many rows have a value in the column.', example: 'count([Order ID])' },
  { name: 'min', category: 'totals', signature: 'min(column)', summary: 'The smallest value of a number column.', example: 'min([Price])' },
  { name: 'max', category: 'totals', signature: 'max(column)', summary: 'The largest value of a number column.', example: 'max([Price])' },
];

/** What a quick start is filled from: a column (totalled, in a measure) or a saved metric. */
export interface Operand {
  kind: 'column' | 'metric';
  name: string;
}

export type TemplateId = 'difference' | 'ratio' | 'percent';
export const TEMPLATES: { id: TemplateId; label: string; hint: string }[] = [
  { id: 'difference', label: 'Difference', hint: 'A − B' },
  { id: 'ratio', label: 'Ratio', hint: 'A ÷ B' },
  { id: 'percent', label: 'Percent of', hint: 'A ÷ B, as a percent' },
];

/**
 * The formula TEXT a quick start writes. In a measure a column is totalled
 * first — `sum([A])` — and "percent" is a format; on a row it is `× 100`,
 * because a column has no format of its own.
 */
export function templateText(id: TemplateId, a: Operand, b: Operand, measure: boolean): { expression: string; name: string; percent: boolean } {
  const ref = (o: Operand) => (o.kind === 'metric' || !measure ? `[${o.name}]` : `sum([${o.name}])`);
  const [A, B] = [ref(a), ref(b)];
  if (id === 'difference') return { expression: `${A} - ${B}`, name: `${a.name} minus ${b.name}`, percent: false };
  if (id === 'ratio') return { expression: `${A} / ${B}`, name: `${a.name} per ${b.name}`, percent: false };
  return { expression: measure ? `${A} / ${B}` : `${A} / ${B} * 100`, name: `${a.name} % of ${b.name}`, percent: measure };
}

/**
 * The chart measure a saved metric becomes (src/analysis/visuals.ts VizMeasure).
 * A SIMPLE metric keeps its own column and aggregation — that is what the chart
 * plots. A FORMULA metric has neither: the server calculates it from `metricId`
 * (src/ipc/vizMetricMeasures.ts) and names the series after the metric, so
 * `column` carries the name and the aggregation is `count` — the one whose
 * series name is the bare column, which keeps per-series formatting keyed right.
 */
export function metricMeasure(m: Pick<MetricSummary, 'id' | 'name' | 'definition'>, prev?: Measure): Measure {
  const out: Measure = isFormula(m.definition) ? { column: m.name, aggregation: 'count', metricId: m.id } : { column: m.definition.column, aggregation: m.definition.aggregation, metricId: m.id };
  if (prev?.calc) out.calc = prev.calc;
  return out;
}
