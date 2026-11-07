// A question asked word for word as a verified one is answered by the app (semantic part 3 D8): the verified
// spec is drawn again through the figure doors, so its numbers are today's, under the caller's row lock. No model
// decides the match, and none is needed; one narrates the card only when one is ready (answers `narrate`).

import { verifiedStates } from './verifiedState';
import { appendAnswer, computeCard, narrate, type Guard } from './answers';
import { exactHit } from '../ai/verifiedPick';
import { NO_ACTION } from '../ai/suggestedAction';
import type { TurnGuidance } from '../ai/turnGuidance';

/**
 * null when the question is no verified one (the model takes it). A hit whose card fails answers `{ ok: false }`
 * with the reason and falls no further: a model's guess at a verified question is worse than the reason.
 */
export async function verifiedAsk(projectId: string, question: string, threadId: string | undefined, guard: Guard) {
  const hit = exactHit(await verifiedStates(projectId), question);
  if (!hit) return null;
  const built = await computeCard(projectId, hit.spec);
  if ('ok' in built) return { ok: false as const, error: built.reason };
  const n = await narrate(projectId, built,
    `Narrate this chart answer ("${hit.question}") in two or three sentences, citing only figures from the facts.`, guard);
  const guidance: TurnGuidance = { verifiedId: hit.id, instructions: 0, examples: [] };
  const r = await appendAnswer(projectId, threadId, question, n.text, built, built.card.spec, undefined, guidance);
  return {
    ok: true as const, answer: n.text, provenance: built.provenance, turns: r.turns, threadId: r.threadId,
    suggestedAction: NO_ACTION, ledger: built.ledger, numberAudit: n.audit, guidance,
  };
}
