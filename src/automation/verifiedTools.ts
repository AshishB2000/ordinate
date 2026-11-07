// MCP tools for what a project's editors signed off (semantic layer part 3 D5, D12): verified questions and the
// Assistant's instructions, read as the token's user. Read-only: nothing here saves, verifies or edits.
//
// A figure is never stored or re-rounded: `answerVerifiedQuestion` draws the question's spec through `computeCard`
// (the token user's row lock, the Live door) and then the Share policy's EXPORT path, exactly as `aggregate` does.

import { computeCard } from '../ipc/answers';
import { verifiedStates, type VerifiedState } from '../ipc/verifiedState';
import { questionKey } from '../analysis/verifiedRules';
import * as datasets from '../data/datasets';
import { listInstructions, FENCE_RE } from '../app/instructions';
import { GUIDANCE_FRAMING } from '../ai/guidanceFacts';
import * as sharePolicy from '../app/sharePolicy';
import type { Headline } from '../ai/answerFacts';
import { AutomationError } from './errors';
import { noVerifiedQuestion, useAnswerVerified, verifiedSensitive } from './verifiedToolMessages';
import type { Ctx } from './registry';

export interface McpVerified {
  id: string; question: string; phrasings: string[]; dataset: string; verifiedBy: string; verifiedAt: string;
  runs: boolean; problem?: string;
  /** `aggregate`'s arguments, when that tool can say this spec and the caller may see it. */
  aggregate?: { dataset: string; encoding: Record<string, unknown>; filters: unknown[] };
  /** Where to go instead, when `aggregate` cannot say it. */
  use?: string;
}

export interface McpVerifiedAnswer {
  id: string; question: string; dataset: string; labels: (string | number)[]; series: { name: string; values: (number | null)[] }[];
  headline?: Headline[]; asOf?: string; verifiedBy: string; verifiedAt: string; note?: string; notes?: string[];
}

/** `aggregate`'s arguments for a spec, or null: a top-N, a period or a glossary term is not in its FILTERS. */
function aggregateArgs(s: VerifiedState, dataset: string): McpVerified['aggregate'] | null {
  const { spec } = s.q;
  if (s.hidden || s.problem !== null || spec.top || spec.filters.some((f) => 'term' in f || 'period' in f)) return null;
  return {
    dataset,
    encoding: {
      category: spec.category, values: spec.measures.map((m) => ({ column: m.column, aggregation: m.aggregation })),
      ...(spec.series ? { series: spec.series } : {}), ...(spec.grain ? { grain: spec.grain } : {}),
    },
    filters: spec.filters,
  };
}

export async function listVerifiedQuestions(ctx: Ctx): Promise<{ questions: McpVerified[] }> {
  const projectId = ctx.projectId;
  const names = new Map((await datasets.listDatasets(projectId)).map((d) => [d.id, d.name] as const));
  const questions = (await verifiedStates(projectId)).map((s): McpVerified => {
    const dataset = names.get(s.q.spec.datasetId) ?? '';
    const aggregate = aggregateArgs(s, dataset);
    return {
      id: s.q.id, question: s.q.question, phrasings: s.q.phrasings, dataset, verifiedBy: s.q.verifiedBy, verifiedAt: s.q.verifiedAt,
      runs: s.problem === null, ...(s.problem !== null ? { problem: s.problem } : {}),
      ...(aggregate ? { aggregate } : {}),
      ...(!aggregate && !s.hidden && s.problem === null ? { use: useAnswerVerified() } : {}),
    };
  });
  return { questions };
}

export async function answerVerifiedQuestion(ctx: Ctx, question: string): Promise<McpVerifiedAnswer> {
  const key = questionKey(question);
  const hit = (await verifiedStates(ctx.projectId)).find((s) =>
    s.q.id === question || (key !== '' && [s.q.question, ...s.q.phrasings].some((t) => questionKey(t) === key)));
  if (!hit || hit.hidden) throw new AutomationError('not_found', noVerifiedQuestion(question));
  if (hit.problem !== null) throw new AutomationError('runtime', hit.problem);
  const { q } = hit;
  const built = await computeCard(ctx.projectId, q.spec);
  if ('ok' in built) throw new AutomationError('runtime', built.reason);
  const { card } = built;
  const encoding = { category: q.spec.category, values: q.spec.measures, ...(q.spec.series ? { series: q.spec.series } : {}), ...(q.spec.grain ? { grain: q.spec.grain } : {}) };
  const shaped = await sharePolicy.applyToChart(ctx.projectId, q.spec.datasetId, encoding, {
    ok: true as const, data: card.data, warnings: [], recommendedShape: 'categorical', category: undefined,
  }, 'export');
  if (!shaped.ok) throw new AutomationError('runtime', verifiedSensitive());
  const data = shaped.data;
  // A masked label must not leave inside a headline or a note: both are worded from the unmasked labels.
  const same = JSON.stringify(data.labels) === JSON.stringify(card.data.labels)
    && JSON.stringify(data.series.map((s) => s.name)) === JSON.stringify(card.data.series.map((s) => s.name));
  return {
    id: q.id, question: q.question, dataset: card.datasetName, labels: data.labels,
    series: data.series.map((s) => ({ name: s.name, values: s.values })),
    ...(same && card.headline.length ? { headline: card.headline } : {}),
    ...(card.asOf ? { asOf: card.asOf.at } : {}),
    verifiedBy: q.verifiedBy, verifiedAt: q.verifiedAt,
    ...(q.note ? { note: q.note } : {}), ...(same && card.notes.length ? { notes: card.notes } : {}),
  };
}

export async function getInstructions(ctx: Ctx): Promise<{ framing: string; instructions: { text: string; updatedBy: string; updatedAt: string }[] }> {
  const all = await listInstructions(ctx.projectId);
  return {
    framing: GUIDANCE_FRAMING,
    // A text holding the fence marker is left out, as in the Assistant's block.
    instructions: all.filter((i) => !FENCE_RE.test(i.text)).map((i) => ({ text: i.text, updatedBy: i.updatedBy, updatedAt: i.updatedAt })),
  };
}
