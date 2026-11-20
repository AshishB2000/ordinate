// A step's chart, drawn NOW for the starter (the report page's live charts): the answer step through `answer:card`'s own handler
// (so a card is drawn exactly as the dock draws one), an SQL step through the gate that ran it, a drivers step as its waterfall.
// The card's figures are recomputed under the caller's access each time; nothing stored here is a figure.

import { handlers } from '../rpc';
import { sanitizeStoredSpec } from '../../ai/answerSpec';
import { sanitizeSqlTurn } from '../../ai/answerSql';
import { sqlCardFor } from '../../ipc/answerSql';
import { driversVizData } from '../../ipc/drivers';
import { sanitizeDriversSpec } from '../../analysis/driverScope';
import type { StepRec } from '../../ai/researchLoop';
import * as say from '../researchMessages';

export type CardReply = Record<string, unknown>;

export async function cardOf(projectId: string, step: StepRec): Promise<CardReply> {
  if (step.status !== 'done' || !step.spec) return { ok: false, reason: say.stepFailed() };
  try {
    if (step.kind === 'answer') {
      const spec = sanitizeStoredSpec(step.spec);
      const handler = handlers.get('answer:card');
      return spec && handler ? ((await handler({}, { projectId, spec })) as CardReply) : { ok: false, reason: say.stepFailed() };
    }
    if (step.kind === 'sql') {
      const turn = sanitizeSqlTurn({ text: step.spec.sql, datasetIds: step.spec.datasetIds, title: step.spec.title });
      const r = turn ? await sqlCardFor(projectId, turn) : null;
      return r ? (r.ok ? { ...r.card } : { ok: false, reason: r.reason }) : { ok: false, reason: say.stepFailed() };
    }
    const spec = sanitizeDriversSpec(step.spec, (step.spec as { filters?: never[] }).filters ?? []);
    if (!spec) return { ok: false, reason: say.stepFailed() };
    const r = await driversVizData(projectId, spec.datasetId, { drivers: { metric: spec.metric, compare: spec.compare, path: spec.path }, category: spec.dimension }, spec.filters);
    return r.ok ? { ok: true, kind: 'drivers', title: step.title, chartType: 'waterfall', data: r.data, caption: '' } : { ok: false, reason: say.stepFailed() };
  } catch {
    return { ok: false, reason: say.stepFailed() };
  }
}
