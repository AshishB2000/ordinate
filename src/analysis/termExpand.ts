// Glossary terms at the figure doors (semantic layer). Every figure entry calls this on its filter
// list FIRST — before the row lock, the gates that read the filters, the Live split and the answer
// cache — and uses what it returns from there on. A kept step is a reference: no engine may skip it
// (the figure would widen) and no lock may drop it (rowAccess.withLockSteps keeps filters and terms only).
//
// PR 05a reads no term and no step a later release adds, so any step that is not a plain `filter`
// refuses the figure: a typed `code: 'term'` with the catalog's sentence. 05b expands a term here.

import type { FilterStep } from '../data/transforms';
import type { AnswerSpec } from '../ai/answerSpec';
import { hasTermType, TermNotExpandedError } from '../data/termStep';

export interface TermExpansion {
  steps: FilterStep[];
  /** What the figure says about its terms (05b); none in 05a. */
  notes: string[];
}

/** `steps` with every term expanded. In 05a: the steps as they are, or the refusal when one is not a plain filter. */
export async function expandTerms(projectId: string, datasetId: string, steps: readonly FilterStep[] | undefined): Promise<TermExpansion> {
  const list = steps ?? [];
  // A term (malformed or not), a step from a newer release, or a Prepare step sent as a filter: unreadable here.
  if (list.some((s) => !s || s.type !== 'filter')) throw new TermNotExpandedError('unreadable');
  return { steps: [...list], notes: [] };
}

/** An answer spec with its `{ term }` filters expanded, and the steps they became. In 05a: the refusal on any term. */
export async function expandAnswerTerms(projectId: string, spec: AnswerSpec): Promise<{ spec: AnswerSpec; steps: FilterStep[] }> {
  if (((spec && spec.filters) || []).some((f) => 'term' in f || hasTermType(f))) throw new TermNotExpandedError('unreadable'); // specFilterSteps' rule
  return { spec, steps: [] };
}
