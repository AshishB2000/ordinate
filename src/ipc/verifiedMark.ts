// "✓ Verified · <who>" on an answer card (semantic layer part 3 D9) — by COMPARISON only.
//
// A card is marked when its spec draws the same chart as a working verified question's (../ai/answerRefine
// `sameChart`), chart type aside. Worked out at every draw: never stored on a turn, never read from a client or a
// model (`sanitizeStoredSpec` drops an unknown `verified` key). A question that no longer runs, or one hidden from
// the caller by row access rules (D5), marks nothing. Editing the question removes the mark where it no longer fits.

import { sameChart } from '../ai/answerRefine';
import type { AnswerSpec } from '../ai/answerSpec';
import { closedToCaller } from '../data/rowAccess';
import { listVerified } from '../analysis/verifiedQuestions';
import { hasValueFilter } from '../analysis/verifiedRules';
import { verifiedEnv, verifiedProblem } from './verifiedState';

export interface VerifiedMark { id: string; question: string; by: string; at: string }

export async function verifiedMark(projectId: string, spec: AnswerSpec): Promise<{ verified?: VerifiedMark }> {
  const drawn = { ...spec, chartType: '' };
  // The comparison first, on the records alone: the metadata check runs only for a card that matches one.
  const q = (await listVerified(projectId)).find((v) => sameChart({ ...v.spec, chartType: '' }, drawn));
  if (!q || verifiedProblem(q, await verifiedEnv(projectId)) !== null) return {};
  if (hasValueFilter(q.spec) && (await closedToCaller(projectId, q.spec.datasetId, { rowsOnly: true }))) return {};
  return { verified: { id: q.id, question: q.question, by: q.verifiedBy, at: q.verifiedAt } };
}
