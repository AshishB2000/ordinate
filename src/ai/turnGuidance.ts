// How an Assistant answer was guided, kept on its stored turn: which verified question it followed, how
// many standing instructions applied and which verified questions it was shown as examples. Ids and
// counts only, never text. A release that cannot write one still keeps it through every thread write
// (copilot.ts normalizeTurns and appendTurn); this sanitizer drops a hand-edited or corrupt value
// instead of showing it later. Pure; never throws.

import { isValidId } from '../app/ids';

export interface TurnGuidance {
  verifiedId?: string; // UUID of the verified question the answer followed
  instructions: number; // integer 0..MAX_GUIDANCE_INSTRUCTIONS: how many standing instructions applied (the project's and an agent's)
  examples: string[]; // UUIDs, at most MAX_GUIDANCE_EXAMPLES
  documents?: string[]; // UUIDs of the knowledge documents whose passages went into the prompt, at most MAX_GUIDANCE_DOCUMENTS (docs/knowledge-docs rule 7)
  documentRefs?: { id: string; title: string; gone?: true }[]; // BROWSER ONLY, added when a turn is sent (src/knowledge/retrieve.ts); never stored: the sanitizer drops it
  narrated?: true; // a verified answer a model was asked to narrate (turns stored before verified answers stopped calling one): "no model call" would be false
}

const MAX_GUIDANCE_INSTRUCTIONS = 80; // instructions.ts MAX_INSTRUCTIONS twice: the project's list and an agent's (src/ai/agents.ts)
const MAX_GUIDANCE_EXAMPLES = 5;
const MAX_GUIDANCE_DOCUMENTS = 6;

/** Undefined for anything that is no object or whose count is no integer in range; a bad id or example is dropped alone. */
export function sanitizeGuidance(raw: unknown): TurnGuidance | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const n = r.instructions;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_GUIDANCE_INSTRUCTIONS) return undefined;
  const examples = Array.isArray(r.examples) ? r.examples.filter(isValidId).slice(0, MAX_GUIDANCE_EXAMPLES) : [];
  const documents = Array.isArray(r.documents) ? r.documents.filter(isValidId).slice(0, MAX_GUIDANCE_DOCUMENTS) : [];
  return { ...(isValidId(r.verifiedId) && { verifiedId: r.verifiedId }), instructions: n, examples, ...(documents.length && { documents }), ...(r.narrated === true && { narrated: true as const }) };
}
