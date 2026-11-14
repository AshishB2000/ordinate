// A question asked word for word as a verified one is answered by the app (semantic part 3 D8): the verified
// spec is drawn again through the figure doors, so its numbers are today's, under the caller's row lock. No model
// decides the match, and none writes a word: the turn's text is empty and the card's own bullets say what it shows.

import { verifiedStates } from './verifiedState';
import { appendAnswer, computeCard } from './answers';
import { exactHit } from '../ai/verifiedPick';
import { NO_ACTION } from '../ai/suggestedAction';
import type { TurnGuidance } from '../ai/turnGuidance';

/**
 * null when the question is no verified one (the model takes it). A hit whose card fails answers `{ ok: false }`
 * with the reason and falls no further: a model's guess at a verified question is worse than the reason.
 * `target`: the conversation it lands in, pinned once the card is built. `scope`: an Assistant agent's topic, outside
 * which no question is a hit (it goes to the model, which says it is out of scope), and its fall-back line, if any.
 */
export async function verifiedAsk(
  projectId: string, question: string, target: () => Promise<string | undefined>,
  scope: { only: ReadonlySet<string> | null; note: string | null } = { only: null, note: null },
) {
  const hit = exactHit((await verifiedStates(projectId)).filter((s) => !scope.only || scope.only.has(s.q.spec.datasetId)), question);
  if (!hit) return null;
  const built = await computeCard(projectId, hit.spec);
  if ('ok' in built) return { ok: false as const, error: built.reason };
  const guidance: TurnGuidance = { verifiedId: hit.id, instructions: 0, examples: [] };
  const text = scope.note ?? '';
  const r = await appendAnswer(projectId, await target(), question, text, built, built.card.spec, undefined, guidance);
  return {
    ok: true as const, answer: text, provenance: built.provenance, turns: r.turns, threadId: r.threadId,
    suggestedAction: NO_ACTION, ledger: built.ledger, numberAudit: { ok: true as const, violations: [] }, guidance,
  };
}
