// "✓ Verified · <who>" on an answer card (semantic layer part 3 D9) — by COMPARISON only.
//
// A card is marked when its spec draws the same chart as a working verified question's (../ai/answerRefine
// `sameChart`), chart type aside. Worked out at every draw: never stored on a turn, never read from a client or a
// model (`sanitizeStoredSpec` drops an unknown `verified` key). A question that no longer runs, or one hidden from
// the caller by row access rules (D5), marks nothing. Editing the question removes the mark where it no longer fits.
//
// An answer turn's mark also says how the answer came to that chart (`kind`, docs/assistant/00-design.md step 4 A),
// from the ids its guidance kept: `matched`, the verified question it was asked word for word; `based_on`, one the
// model was shown as an example. Only when the chart is that question's — an example in the prompt alone claims
// nothing. The card then says it in one line in place of the badge. `by` is the verifier as a person reads them
// (../app/mentionToken `personName`, '' when none was recorded): the badge and the line name people the same way.

import { sameChart } from '../ai/answerRefine';
import type { AnswerSpec } from '../ai/answerSpec';
import type { TurnGuidance } from '../ai/turnGuidance';
import { personName } from '../app/mentionToken';
import { closedToCaller } from '../data/rowAccess';
import { verifiedOn } from './verifiedLookup';
import { hasValueFilter } from '../analysis/verifiedRules';
import { verifiedEnvFor, verifiedProblem } from './verifiedState';

export interface VerifiedMark { id: string; question: string; by: string; at: string; kind?: 'matched' | 'based_on' }

export async function verifiedMark(projectId: string, spec: AnswerSpec, guidance?: TurnGuidance): Promise<{ verified?: VerifiedMark }> {
  const drawn = { ...spec, chartType: '' };
  const kindOf = (id: string): VerifiedMark['kind'] => (id === guidance?.verifiedId ? 'matched' : guidance?.examples.includes(id) ? 'based_on' : undefined);
  const rank = (id: string): number => ['matched', 'based_on', undefined].indexOf(kindOf(id));
  // The comparison first, on the records of the card's dataset alone (an index lookup with a database: a reopened
  // conversation marks every card): the metadata check runs only for a card that matches one, the turn's own first.
  const same = (await verifiedOn(projectId, spec.datasetId)).filter((v) => sameChart({ ...v.spec, chartType: '' }, drawn));
  for (const q of same.sort((a, b) => rank(a.id) - rank(b.id))) {
    if (verifiedProblem(q, await verifiedEnvFor(projectId, [q])) !== null) continue;
    if (hasValueFilter(q.spec) && (await closedToCaller(projectId, q.spec.datasetId, { rowsOnly: true }))) continue;
    const kind = kindOf(q.id);
    return { verified: { id: q.id, question: q.question, by: personName(q.verifiedBy), at: q.verifiedAt, ...(kind ? { kind } : {}) } };
  }
  return {};
}
