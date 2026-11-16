// A conversation as a caller a shared folder restricts may see it (docs/team-folders/00-design.md, "The Assistant's
// history, as built") — MAIN PROCESS. An answer about a dataset they cannot open (its chart's, a "Did you mean"
// option's, any its SQL answer read, or any its facts were built from: `factsFrom`, a prose answer's too) is gone, with the question just before it: from every reply that carries turns (./answerSnapshots
// `turnsForBrowser`: copilot:history, copilot:ask, answer:rerun, a verified hit), from the turns the model is replayed
// (copilot:ask), and from the chart a follow-up continues. A title taken from such a question reads as an untitled
// conversation's. Nothing is deleted: open the folder to them again and the turns are back.
//
// THE SAME RULE, IN SQL, counts the turns of each conversation in the list (../ai/copilotRows `listPage`): a turn is
// shown unless it is a closed answer or a question whose next turn is one.
//
// INERT with no folder besides Everyone (or for an admin): `levelsOf` answers null with no query, and the turns are
// returned as they are.

import { levelsOf } from '../server/authz/folderGate';
import * as copilot from '../ai/copilot';

type Turn = Pick<copilot.CopilotTurn, 'role' | 'text' | 'answer' | 'suggest' | 'sql' | 'factsFrom'>;

/** The datasets an assistant turn shows: its chart's, its "Did you mean" options', every one its SQL answer read and its facts' (0039 `ordinate_turn_shows`). */
const shows = (t: Turn): string[] => [
  ...(t.answer ? [t.answer.datasetId] : []), ...(t.suggest?.options ?? []).map((o) => o.spec.datasetId), ...(t.sql?.datasetIds ?? []), ...(t.factsFrom ?? []),
];

/** `turns` without each answer on a dataset the caller cannot open, and a question just before one. The same array when nothing restricts. */
export async function openTurns<T extends Turn>(projectId: string, turns: readonly T[]): Promise<T[]> {
  const level = await levelsOf(projectId, 'dataset');
  if (!level) return turns as T[];
  const closed = turns.map((t) => t.role === 'assistant' && shows(t).some((id) => level(id) === 'none'));
  return turns.filter((t, i) => !closed[i] && !(t.role === 'user' && closed[i + 1]));
}

/** `title`, or the untitled one when it was taken from a question `openTurns` drops (`opening`: the conversation's first turns). */
export async function openTitle(projectId: string, title: string, opening: readonly copilot.CopilotTurn[]): Promise<string> {
  if (title === copilot.FALLBACK_TITLE || title !== copilot.titleFromTurns([...opening])) return title; // untitled, or renamed: the caller's own words
  const first = opening.find((t) => t.role === 'user' && t.text.trim() !== '');
  return first && (await openTurns(projectId, opening)).includes(first) ? title : copilot.FALLBACK_TITLE;
}
