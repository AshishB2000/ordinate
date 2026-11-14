// How an Assistant answer was guided, kept on its stored turn: which verified question it followed, how
// many standing instructions applied and which verified questions it was shown as examples. Ids and
// counts only, never text. A release that cannot write one still keeps it through every thread write
// (copilot.ts normalizeTurns and appendTurn); this sanitizer drops a hand-edited or corrupt value
// instead of showing it later. Pure; never throws.

import { isValidId } from '../app/ids';

export interface TurnGuidance {
  verifiedId?: string; // UUID of the verified question the answer followed
  instructions: number; // integer 0..MAX_GUIDANCE_INSTRUCTIONS: how many standing instructions applied
  examples: string[]; // UUIDs, at most MAX_GUIDANCE_EXAMPLES
  narrated?: true; // a verified answer a model was asked to narrate (turns stored before verified answers stopped calling one): "no model call" would be false
}

const MAX_GUIDANCE_INSTRUCTIONS = 40; // instructions.ts MAX_INSTRUCTIONS: the count cannot pass the list it counts
const MAX_GUIDANCE_EXAMPLES = 5;

/** Undefined for anything that is no object or whose count is no integer in range; a bad id or example is dropped alone. */
export function sanitizeGuidance(raw: unknown): TurnGuidance | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const n = r.instructions;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_GUIDANCE_INSTRUCTIONS) return undefined;
  const examples = Array.isArray(r.examples) ? r.examples.filter(isValidId).slice(0, MAX_GUIDANCE_EXAMPLES) : [];
  return { ...(isValidId(r.verifiedId) && { verifiedId: r.verifiedId }), instructions: n, examples, ...(r.narrated === true && { narrated: true as const }) };
}
