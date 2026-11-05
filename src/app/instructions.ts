// What a project's admin has told the Assistant to do: short standing instructions ("Revenue means
// net_amount unless they say gross"). Kept in catalog.json under `instructions` (catalog.ts). A release
// that cannot write one still keeps it through every catalog write; this sanitizer is what drops a
// hand-edited or corrupt entry instead of showing it to a model later. Pure; never throws.
//
// The text is kept as written, bar its line breaks: it is one line, so an instruction can never open a
// line of its own in a prompt. The reader keeps a stored text that holds the fence marker (never erased);
// a save refuses one, and the prompt builder (src/ai/guidanceFacts.ts) leaves it out.
//
// The store below changes ONE item per call, inside the catalog's locked read-modify-write, so two editors
// adding at once both land.

import { randomUUID } from 'crypto';
import { isValidId } from './ids';
import { clip } from './clip';
import { loadStrict, mutateCatalog, osUser } from './catalog';
import { instructionEmpty, instructionFence, instructionGone, instructionTooMany } from './instructionMessages';

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

/** What could close the guidance block's fence (`<<<GUIDANCE` … `GUIDANCE`) or speak as it: refused on save, skipped on read. */
export const FENCE_RE = /<<<|\bGUIDANCE\b/;
/** A figure-like token — a currency sign before a digit, a decimal, a thousands separator, a percent. A warning, never a refusal: "90 days" is fine. */
export const FIGURE_RE = /[$€£¥]\s?\d|\d\.\d|\d{1,3}(?:,\d{3})+|\d\s?%/;

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

// ── The store ────────────────────────────────────────────────────────────────

export type InstructionOp = { kind: 'add'; text: string } | { kind: 'edit'; id: string; text: string } | { kind: 'remove'; id: string };

/** The project's instructions, in stored order. An unreadable catalog THROWS (a reader shows its error, never "none yet"). */
export async function listInstructions(projectId: string): Promise<Instruction[]> {
  if (!isValidId(projectId)) return [];
  return (await loadStrict(projectId)).instructions ?? [];
}

/** The text as stored, or THROWS the sentence to show: empty once it is one line, or holding the fence marker. */
function storable(raw: string): string {
  const text = oneLine(raw);
  if (!text) throw new Error(instructionEmpty());
  if (FENCE_RE.test(text)) throw new Error(instructionFence());
  return text;
}

/** One change, read fresh under the catalog's lock; the whole list after it. THROWS the catalog's sentence, storing nothing. */
export async function changeInstructions(projectId: string, op: InstructionOp): Promise<Instruction[]> {
  if (!isValidId(projectId)) throw new Error(instructionGone());
  const text = op.kind === 'remove' ? '' : storable(op.text);
  return mutateCatalog(projectId, (file) => {
    const list = file.instructions ?? [];
    const stamp = { updatedBy: clip(osUser(), MAX_BY), updatedAt: new Date().toISOString() };
    let next: Instruction[];
    if (op.kind === 'add') {
      if (list.length >= MAX_INSTRUCTIONS) throw new Error(instructionTooMany(MAX_INSTRUCTIONS));
      next = [...list, { id: randomUUID(), text, ...stamp }];
    } else {
      const at = list.findIndex((i) => i.id.toLowerCase() === op.id.toLowerCase());
      if (at < 0) throw new Error(instructionGone());
      next = op.kind === 'edit' ? list.map((i, k) => (k === at ? { id: i.id, text, ...stamp } : i)) : list.filter((_, k) => k !== at);
    }
    if (next.length) file.instructions = next;
    else delete file.instructions;
    return next;
  });
}
