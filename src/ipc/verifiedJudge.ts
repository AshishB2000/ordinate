// The ONE judge of a model's answer spec against a verified question (semantic layer part 3 D13): CI's replay, the
// live-model run and the in-app check all score with it. It scores the SPEC, never prose — prose figures are the
// number-fidelity gate's.
//
// `refused`: the validator's reason. `match`: the same chart as the verified one, chart type aside (D9's rule); or,
// on a copy only, both cards drawn by the engine (`computeCard`) with the same labels and the same series values,
// position by position, by `Object.is` — so `in ['West']` and `= 'West'` agree. Series names are not compared.
// `differs`: anything else. A Live dataset is compared on specs only: no warehouse query.

import { sameChart } from '../ai/answerRefine';
import { validateAnswerSpec, type AnswerSpec } from '../ai/answerSpec';
import type { VerifiedQuestion } from '../analysis/verifiedRules';
import type { ChartData } from '../analysis/vizData';
import * as datasets from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { computeCard, specDatasets, specMetrics, specTerms } from './answers';

export type Outcome = 'match' | 'differs' | 'refused';
/** `datasetId`: the reply's own dataset, when its card's reason is the one given (it can quote that dataset's values). */
export interface Judged { outcome: Outcome; reason?: string; by?: 'spec' | 'figures'; datasetId?: string }

const sameValues = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const sameFigures = (a: ChartData, b: ChartData): boolean =>
  sameValues(a.labels, b.labels) && a.series.length === b.series.length && a.series.every((s, i) => sameValues(s.values, b.series[i].values));

async function anyLive(projectId: string, ids: string[]): Promise<boolean> {
  return (await Promise.all(ids.map((id) => datasets.getDatasetMeta(projectId, id)))).some((m) => isLive(m));
}

export async function judgeSpec(projectId: string, q: VerifiedQuestion, raw: unknown, opts: { specOnly?: boolean } = {}): Promise<Judged> {
  const [all, metrics, terms] = await Promise.all([specDatasets(projectId), specMetrics(projectId), specTerms(projectId)]);
  const v = validateAnswerSpec(raw, all, { metrics, terms, title: q.question });
  if (!v.ok) return { outcome: 'refused', reason: v.reason };
  const drawn: AnswerSpec = { ...v.spec, chartType: q.spec.chartType }; // chart type aside, for the figures too
  if (sameChart({ ...q.spec, chartType: '' }, { ...drawn, chartType: '' })) return { outcome: 'match', by: 'spec' };
  if (opts.specOnly || (await anyLive(projectId, [q.spec.datasetId, v.spec.datasetId]))) return { outcome: 'differs', by: 'spec' };
  // The verified card as stored; the model's loose, as `answerFromAction` draws it (a value matched to the one stored).
  const mine = await computeCard(projectId, q.spec);
  if ('ok' in mine) return { outcome: 'differs', reason: mine.reason };
  const theirs = await computeCard(projectId, drawn, true);
  if ('ok' in theirs) return { outcome: 'differs', reason: theirs.reason, datasetId: v.spec.datasetId };
  return { outcome: sameFigures(mine.card.data, theirs.card.data) ? 'match' : 'differs', by: 'figures' };
}
