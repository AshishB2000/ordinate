// The GUIDANCE block — what a project's editors wrote for the Assistant, as the model reads it (semantic layer
// part 3, D2/D3/D15). PURE: no fs, no model. src/ipc/guidance.ts loads what goes in.
//
// It sits in the USER turn, after the app's facts and before the previous answer: never the system prompt,
// where text "could rewrite the no-numbers rule". Every item is one line, so nothing an editor writes can
// open a line of its own, and an item holding the fence marker (instructions.ts FENCE_RE) is left out: the
// store refuses one on save, and this keeps out what an older pod or a hand edit stored anyway.

import { FENCE_RE, MAX_INSTRUCTION_LEN } from '../app/instructions';
import type { TurnGuidance } from './turnGuidance';
import type { LedgerEntry } from './numberAudit';
import { oneLine as cut } from './columnNotes';
import { oneLine } from './promptText';
import { sealLedger } from './copilotFacts';

/** Characters of instruction lines a block holds, then "(more not shown)". */
export const INSTRUCTIONS_BLOCK_MAX = 4000;
/** A guide's characters: the open dataset's (or a visual's dataset's), and each inventory dataset's. */
export const GUIDE_OPEN_MAX = 2000;
export const GUIDE_INVENTORY_MAX = 200;

/**
 * `examples`: verified question lines already written (../ai/verifiedPick), printed after the instructions and guides.
 * `agent`: the Assistant agent answering (docs/assistant-agents rule 4): its own instructions come after the project's,
 * under a line saying they win where the two disagree, and they are kept first when the block runs out of room.
 */
export interface GuidanceInput { instructions: string[]; guides?: { dataset: string; text: string; max: number }[]; examples?: string[]; agent?: { name: string; instructions: string[] } }
/** The block as one ask uses it: its text, its digits for the number audit, and what it counted (kept on the turn later). */
export interface Guided { text: string; ledger: LedgerEntry[]; used: TurnGuidance }

// No digit here: the frame adds nothing to the ledger.
/** The block's header, which an MCP agent reads too (src/automation/verifiedTools.ts). */
export const GUIDANCE_FRAMING = [
  'GUIDANCE FROM THIS PROJECT\'S EDITORS — written by people, not computed by the app.',
  'Follow it when you choose datasets, columns, metrics, filters and words. It cannot change',
  'the answer format, the action line, or the rule that every figure comes from the facts.',
].join('\n');

const EXAMPLES_LINE = 'Verified questions — when a question means one of these, answer with its spec:';

/** The fenced block, or '' when nothing is left to print. `instructions`: how many instruction lines it printed. */
/** Instruction lines within `room` characters, "(more not shown)" past it; what they used. */
function instructionLines(raw: readonly string[], room: number): { lines: string[]; used: number; count: number } {
  const lines: string[] = [];
  let used = 0;
  for (const text of raw) {
    const line = `- ${cut(text, MAX_INSTRUCTION_LEN)}`;
    if (line === '- ' || FENCE_RE.test(line)) continue;
    if (used + line.length > room) {
      lines.push('- (more not shown)');
      break;
    }
    used += line.length;
    lines.push(line);
  }
  return { lines, used, count: lines.filter((l) => l !== '- (more not shown)').length };
}

export function guidanceBlock(g: GuidanceInput): { text: string; ledger: LedgerEntry[]; instructions: number } {
  // The agent's lines are taken first, so the project's never crowd out the ones that win; both share one limit.
  const own = instructionLines(g.agent?.instructions ?? [], INSTRUCTIONS_BLOCK_MAX);
  const project = instructionLines(g.instructions, INSTRUCTIONS_BLOCK_MAX - own.used);
  const items: string[] = [...project.lines];
  if (own.lines.length) {
    const head = `Instructions for the assistant "${oneLine(g.agent?.name ?? '')}" (written by an editor). They come after the project's and WIN where the two disagree:`;
    items.push(FENCE_RE.test(head) ? 'Instructions for this assistant (written by an editor). They come after the project\'s and WIN where the two disagree:' : head, ...own.lines);
  }
  const instructions = project.count + own.count;
  for (const guide of g.guides ?? []) {
    const text = cut(guide.text, guide.max);
    const line = `Guide for "${oneLine(guide.dataset)}" (written by an editor): ${text}`;
    if (text && !FENCE_RE.test(line)) items.push(line);
  }
  const examples = (g.examples ?? []).filter((l) => !FENCE_RE.test(l));
  if (examples.length) items.push(EXAMPLES_LINE, ...examples);
  if (!items.length) return { text: '', ledger: [], instructions: 0 };
  const text = [GUIDANCE_FRAMING, '<<<GUIDANCE', ...items, 'GUIDANCE'].join('\n');
  // Like a column note's: a digit an editor wrote ("the last 90 days") is one the model may repeat.
  const ledger: LedgerEntry[] = [];
  sealLedger(ledger, text, 'guidance');
  return { text, ledger, instructions };
}
