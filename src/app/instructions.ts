// What a project's admin has told the Assistant to do: short standing instructions ("Revenue means
// net_amount unless they say gross"). Kept in catalog.json under `instructions` (catalog.ts). A release
// that cannot write one still keeps it through every catalog write; this sanitizer is what drops a
// hand-edited or corrupt entry instead of showing it to a model later. Pure; never throws.
//
// The text is kept as written, bar its line breaks: it is one line, so an instruction can never open a
// line of its own in a prompt. Fencing the text off from the prompt's own markers is the prompt
// builder's job, not this reader's.

import { isValidId } from './ids';
import { clip } from './clip';

export interface Instruction {
  id: string; // UUID
  text: string; // one line, at most MAX_INSTRUCTION_LEN
  updatedBy: string; // at most 80
  updatedAt: string; // at most 40
}

export const MAX_INSTRUCTIONS = 40;
export const MAX_INSTRUCTION_LEN = 300;
const MAX_BY = 80;
const MAX_AT = 40;

/** Idempotent: the cut never leaves a lone high surrogate or a trailing space, so the next pass trims nothing. */
function oneLine(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ') : '';
  return clip(s, MAX_INSTRUCTION_LEN).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
}

/** The entries of a stored list that are readable, in stored order: a valid id not seen before and some text. */
export function sanitizeInstructions(raw: unknown): Instruction[] {
  const out: Instruction[] = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set<string>();
  for (const e of raw) {
    const r = e as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r) || !isValidId(r.id) || seen.has(r.id.toLowerCase())) continue;
    const text = oneLine(r.text);
    if (!text) continue;
    seen.add(r.id.toLowerCase());
    out.push({ id: r.id, text, updatedBy: clip(r.updatedBy, MAX_BY), updatedAt: clip(r.updatedAt, MAX_AT) });
    if (out.length === MAX_INSTRUCTIONS) break;
  }
  return out;
}
