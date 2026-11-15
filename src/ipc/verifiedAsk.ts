// A question asked word for word as a verified one is answered by the app (semantic part 3 D8): the verified
// spec is drawn again through the figure doors, so its numbers are today's, under the caller's row lock. No model
// decides the match, and none writes a word: the turn's text is empty and the card's own bullets say what it shows.
//
// The match stays inside what is open: with a dataset, a visual or a topic open, only a verified question on its
// datasets matches, so "Revenue last month" asked with Retail open never draws a chart from Ecommerce.

import { appendAnswer, computeCard } from './answers';
import { topicDatasets } from './guidance';
import * as visuals from '../analysis/visuals';
import { verifiedHit } from './verifiedLookup';
import { NO_ACTION } from '../ai/suggestedAction';
import type { TurnGuidance } from '../ai/turnGuidance';

/** The datasets an open dataset, visual or topic limits a match to; null = the whole project (Home, any other context, a gone visual or topic). */
async function openScope(projectId: string, context: { kind?: string; id?: string }): Promise<ReadonlySet<string> | null> {
  const id = typeof context.id === 'string' ? context.id : '';
  if (!id) return null;
  if (context.kind === 'dataset') return new Set([id]);
  if (context.kind === 'visual') {
    const v = await visuals.getVisual(projectId, id);
    return v ? new Set([v.datasetId]) : null;
  }
  if (context.kind === 'topic') {
    const ds = await topicDatasets(projectId, id);
    return ds ? new Set(ds.map((d) => d.id)) : null;
  }
  return null;
}

/** What is open (`openScope`), inside `within` (an Assistant agent's topic) too; null = no limit. */
export async function verifiedScope(projectId: string, context: { kind?: string; id?: string }, within: ReadonlySet<string> | null = null): Promise<ReadonlySet<string> | null> {
  const open = await openScope(projectId, context);
  return !open ? within : !within ? open : new Set([...open].filter((id) => within.has(id)));
}

/** The verified question `question` is word for word, inside `scope`, or null: one indexed lookup with a database (./verifiedLookup). */
export function verifiedMatch(projectId: string, question: string, scope: ReadonlySet<string> | null) {
  return verifiedHit(projectId, question, scope);
}

/**
 * null when the question is no verified one (the model takes it). A hit whose card fails answers `{ ok: false }`
 * with the reason and falls no further: a model's guess at a verified question is worse than the reason.
 * `target`: the conversation it lands in, pinned once the card is built. `scope.only`: the datasets a hit must be on
 * (`verifiedScope`: what is open, inside an Assistant agent's topic; outside it the question goes to the model, which
 * says when it is out of the agent's scope), and `scope.note`, the agent's fall-back line, if any.
 */
export async function verifiedAsk(
  projectId: string, question: string, target: () => Promise<string | undefined>,
  scope: { only: ReadonlySet<string> | null; note: string | null } = { only: null, note: null },
) {
  const hit = await verifiedMatch(projectId, question, scope.only);
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
