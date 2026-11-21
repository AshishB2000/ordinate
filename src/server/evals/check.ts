// The two sides of the "same figure" check, computed NOW (docs/eval-suites/00-design.md): the expected spec and the answer's spec, each
// through `computeCard` (THE answer door: row access rules, hidden columns, folders, the Live budget), as the runner. Nothing here
// compares: ../../ai/evalChecks does, with Object.is. A side that cannot be computed is null, which the check fails: a refusal, a
// Live dataset's typed failure or a deleted dataset is never an empty comparison that could pass.

import type { AnswerSpec } from '../../ai/answerSpec';
import { computeCard } from '../../ipc/answers';
import type { Sides } from '../../ai/evalChecks';

async function dataOf(projectId: string, spec: AnswerSpec): Promise<unknown | null> {
  try {
    const built = await computeCard(projectId, spec);
    return 'card' in built ? built.card.data : null;
  } catch {
    return null; // a row-policy refusal, a Live failure or a gone dataset: the check fails, never passes on nothing
  }
}

/** Both sides, in the caller's request context. */
export async function sidesOf(projectId: string, expected: AnswerSpec, answer: AnswerSpec): Promise<Sides> {
  return { expected: await dataOf(projectId, expected), answer: await dataOf(projectId, answer) };
}
