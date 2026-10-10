// `metric:check` — the measure editor's ONE question per pause in typing — MAIN.
//
// Is this formula a metric, where exactly is it not (analysis/metricCheck.ts),
// is its name free, and what does it come to on the current data. The verdict is
// the resolver's own compiler and the figure is `previewDefinition` — the same
// resolver and formatter the saved record will use — so the editor cannot show a
// value the metric would not produce, and the browser parses nothing.
//
// NOTHING HERE WRITES, and nothing hydrates: the columns come from the dataset's
// metadata and the figure through `computeCardMetric`, which sends a Live
// dataset to its warehouse. A Live figure that could not be had comes back typed
// (`ok:false`, a `live_…` code, the sentence), never as an empty value.

import { ipcMain } from './bus';
import * as metrics from '../analysis/metrics';
import { isFormulaDefinition } from '../analysis/metrics';
import { checkMetricFormula } from '../analysis/metricCheck';
import type { KnownMetric, MetricCheck } from '../analysis/metricCheck';
import { compileMetricFormula } from '../analysis/metricFormula';
import * as datasets from '../data/datasets';
import { relatedColumnNames } from './relationships';
import { liveCodeOf } from './liveRoute';
import { nameTaken, nameTakenMessage, previewDefinition } from './metrics';

/** The handler names this limit itself; the contract's bound is the transport's. */
const MAX_EXPRESSION = 2000;

/**
 * `valid`: the formula IS a metric (Save may go ahead). `ok` is `valid` AND the
 * figure was had — a Live dataset whose warehouse could not answer is
 * `{ok:false, valid:true, code:'live_…', error}`, the house shape for a refused
 * Live figure, so nothing downstream reads a missing value as an empty one.
 */
export type MetricCheckReply = Omit<MetricCheck, 'code'> & {
  valid: boolean;
  code?: string;
  reason?: string;
  nameError?: string;
  preview?: Awaited<ReturnType<typeof previewDefinition>>;
};

/** Every other metric of the project, with the metric names its formula references. */
async function knownMetrics(projectId: string, exceptId: string | undefined): Promise<Map<string, KnownMetric>> {
  const columnsOf = new Map<string, string[]>();
  const out = new Map<string, KnownMetric>();
  for (const [key, m] of await metrics.metricsByName(projectId)) {
    if (m.id === exceptId) continue;
    let refs: string[] = [];
    if (isFormulaDefinition(m.definition)) {
      if (!columnsOf.has(m.datasetId)) columnsOf.set(m.datasetId, ((await datasets.getDatasetMeta(projectId, m.datasetId))?.columns ?? []).map((c) => c.name));
      const compiled = compileMetricFormula(m.definition.formula, columnsOf.get(m.datasetId) ?? []);
      if (compiled.ok) refs = compiled.program.metricRefs;
    }
    out.set(key, { name: m.name, datasetId: m.datasetId, refs });
  }
  return out;
}

export async function checkMetric(input: {
  projectId: string; datasetId: string; expression: string; name?: string; id?: string; format?: unknown; chart?: boolean;
}): Promise<MetricCheckReply> {
  const { projectId, datasetId, id } = input;
  const expression = typeof input.expression === 'string' ? input.expression : '';
  if (expression.length > MAX_EXPRESSION) {
    return { ok: false, valid: false, tokens: [], code: 'syntax', error: `The formula is too long (${expression.length} characters; the limit is ${MAX_EXPRESSION}).` };
  }
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, valid: false, tokens: [], error: 'Dataset not found' };
  const name = (input.name ?? '').trim();
  const verdict = checkMetricFormula({
    expression,
    datasetId,
    columns: meta.columns.map((c) => ({ name: c.name, type: c.type })),
    related: await relatedColumnNames(projectId, datasetId),
    metrics: await knownMetrics(projectId, id),
    self: name || undefined,
    chart: input.chart === true,
  });
  const check: MetricCheckReply = { ...verdict, valid: verdict.ok };
  if (name && (await nameTaken(projectId, name, id))) check.nameError = nameTakenMessage(name);
  if (!check.valid) return check;
  try {
    check.preview = await previewDefinition(projectId, datasetId, { formula: expression }, [], input.format, name || undefined);
  } catch (err: any) { // any: a thrown LiveFigureError, or whatever the resolver met
    return { ...check, ok: false, error: err?.message || 'The value could not be computed.', ...liveCodeOf(err) };
  }
  return check;
}

export function register(): void {
  ipcMain.handle('metric:check', async (_e, input: any = {}): Promise<MetricCheckReply> => { // any: zod-checked at the door
    try {
      return await checkMetric(input);
    } catch (err: any) { // any: a check must never reject — the editor asks on every pause
      return { ok: false, valid: false, tokens: [], error: err?.message || 'Could not check the formula' };
    }
  });
}
