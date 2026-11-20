// The passages part of the GUIDANCE block (docs/knowledge-docs/00-design.md rules 5 and 6). PURE.
//
// Each passage is ONE line, `[<title> › <heading>] <text>`, so nothing a document says can open a line of its own. A
// line that holds the fence marker is left out (the store refuses none: a PDF may legitimately contain `<<<`; it just
// never reaches a prompt). Rule 6: a document's PLAIN numbers join the number audit's ledger ("1 February", "a 30-day
// window", "FY2025"), its FIGURES do not ("$4.2M", "12.5%", "1,250"): a document may explain a number, never stand
// in for one the engine computes.

import { FENCE_RE, FIGURE_RE } from '../app/instructions';
import { oneLine } from '../ai/columnNotes';
import { MAX_PASSAGE_CHARS, MAX_TITLE } from './limits';

/** What the block prints of one passage. */
export interface BlockPassage { docId: string; title: string; heading: string; text: string }

// No digit here: the frame adds nothing to the ledger.
export const DOCUMENTS_HEADER = 'From the project\'s documents (written by people, not computed by the app). Use them for meaning; every figure still comes from the facts:';

// A global copy of FIGURE_RE, widened to the whole whitespace-delimited token it sits in ("($4.2M)," goes whole).
const FIGURE_TOKEN = new RegExp(`\\S*(?:${FIGURE_RE.source})\\S*`, 'g');

/** `line` with every figure token blanked: what the ledger may learn from it. */
export const withoutFigures = (line: string): string => line.replace(FIGURE_TOKEN, ' ');

/** The printed lines, in order, and the ids of the documents they came from (first seen first). */
export function passageLines(passages: readonly BlockPassage[]): { lines: string[]; docs: string[] } {
  const lines: string[] = [];
  const docs: string[] = [];
  for (const p of passages) {
    const head = [oneLine(p.title, MAX_TITLE), oneLine(p.heading, MAX_TITLE * 2)].filter(Boolean).join(' › ');
    const line = `[${head}] ${oneLine(p.text, MAX_PASSAGE_CHARS)}`;
    if (!p.text.trim() || FENCE_RE.test(line)) continue;
    lines.push(line);
    if (!docs.includes(p.docId)) docs.push(p.docId);
  }
  return { lines, docs };
}
