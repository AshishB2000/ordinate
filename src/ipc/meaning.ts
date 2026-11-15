// The question's side of meaning search (docs/assistant/00-design.md, step 3; PR 7c) — MAIN PROCESS ONLY. Step 3's
// search (./assistantSearch) and the verified examples (./verifiedLookup) merge words with meaning when all of these
// hold: the org has a fingerprint model (Admin → AI), the database has pgvector's table, and the project has
// fingerprints of that model (../server/fingerprintJob makes them). Then the question is fingerprinted ONCE per ask
// (purpose 'query', a 2 s timeout joined to the request's signal) and kept for its length (./askMemo). Only items at
// least the model's least similarity away (../ai/fingerprints minSimilarity) count as near: meaning reorders and adds
// only what is close, and where a result means "offer this" it needs a words hit too (./agentAsk, ./answerCheck).
//
// Anything else is words only, exactly as without meaning: no model is no request at all, and a failure (the provider,
// the timeout, a query) is logged once by its code, never the question.

import { logger } from '../app/logger';
import { fingerprint, minSimilarity } from '../ai/fingerprints';
import { currentFingerprintModel } from '../server/aiConfig';
import { hasVectors, modelKey } from '../server/fingerprintStore';
import { vectorLiteral, vectorPlace, type NearTo } from '../server/vectorStore';
import { TEXT_MAX } from '../app/assistantSearchRank';
import { perAsk } from './askMemo';

/** How long a question's fingerprint may take before the search goes on with words only. */
export const QUERY_TIMEOUT_MS = 2_000;

let warned = false;
function wordsOnly(code: unknown): null {
  if (!warned) {
    warned = true;
    logger.warn(`[meaning search] the question's fingerprint or its query failed (${String(code)}); answering by words. Further failures are not logged.`);
  }
  return null;
}

/** The question's fingerprint to compare `projectId`'s items with, or null: words only. Never throws. */
export async function meaningOf(projectId: string, question: string): Promise<NearTo | null> {
  const pick = currentFingerprintModel();
  if (!pick) return null; // off: nothing is asked of anyone
  try {
    const place = await vectorPlace();
    if (!place) return null;
    const model = modelKey(pick);
    if (!(await perAsk(`meaning:has\0${projectId}\0${model}`, () => hasVectors(projectId, model)))) return null;
    const text = Array.from(question).slice(0, TEXT_MAX).join('');
    const literal = await perAsk(`meaning:q\0${model}\0${text}`, async () => {
      const r = await fingerprint([text], pick, { purpose: 'query', timeoutMs: QUERY_TIMEOUT_MS, quiet: true });
      return r.ok ? vectorLiteral(r.vectors[0]) : wordsOnly(r.errorType); // remembered for the ask: one try a question
    });
    return literal === null ? null : { model, literal, place, maxDistance: 1 - minSimilarity(pick) };
  } catch (err) {
    return wordsOnly((err as { code?: unknown })?.code ?? 'error');
  }
}

/** `fn`'s nearest items, or null (logged once) when its query fails: the caller goes on by words. */
export async function nearOrWords<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    return wordsOnly((err as { code?: unknown })?.code ?? 'error');
  }
}
