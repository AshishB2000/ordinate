// The conversation turn a deep-research run adds (docs/deep-research/00-design.md, "The research turn"): ONE assistant turn
// after the question, carrying only the run's id. Its text is a fixed sentence with no figure. The card reads everything else
// from `research:get`. The sanitizer in ./copilot keeps only this key.

import { isValidId } from '../app/ids';

export interface ResearchRef { runId: string }

export function sanitizeResearch(raw: unknown): ResearchRef | undefined {
  const id = raw && typeof raw === 'object' ? (raw as { runId?: unknown }).runId : undefined;
  return isValidId(id) ? { runId: id } : undefined;
}
