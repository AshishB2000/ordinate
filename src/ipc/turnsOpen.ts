// A conversation as a caller a shared folder restricts may see it (docs/team-folders/00-design.md, "The Assistant's
// history, as built") — MAIN PROCESS. An answer about a dataset they cannot open (its chart's, a "Did you mean"
// option's, any its SQL answer read, or any its facts were built from: `factsFrom`, a prose answer's too), or asked about a
// dashboard they cannot open (`dashboardsFrom`), is gone, with the question just before it: from every reply that carries turns (./answerSnapshots
// `turnsForBrowser`: copilot:history, copilot:ask, answer:rerun, a verified hit), from the turns the model is replayed
// (copilot:ask), and from the chart a follow-up continues. A title taken from such a question reads as an untitled
// conversation's. Nothing is deleted: open the folder to them again and the turns are back.
//
// THE SAME RULE, IN SQL, counts the turns of each conversation in the list (../ai/copilotRows `listPage`): a turn is
// shown unless it is a closed answer or a question whose next turn is one. A conversation with turns and none shown is, to
// them, none: `copilot:history` answers as for none, the list leaves it out, and an ask into it starts a new one (`askThread`).
//
// INERT with no folder besides Everyone (or for an admin): `levelsOf` answers null with no query, and the turns are
// returned as they are.

import { levelsOf } from '../server/authz/folderGate';
import * as copilot from '../ai/copilot';

type Turn = Pick<copilot.CopilotTurn, 'role' | 'text' | 'answer' | 'suggest' | 'sql' | 'factsFrom' | 'dashboardsFrom'>;

/** The datasets an assistant turn shows: its chart's, its "Did you mean" options', every one its SQL answer read and its facts' (0039 `ordinate_turn_shows`). */
const shows = (t: Turn): string[] => [
  ...(t.answer ? [t.answer.datasetId] : []), ...(t.suggest?.options ?? []).map((o) => o.spec.datasetId), ...(t.sql?.datasetIds ?? []), ...(t.factsFrom ?? []),
];

/** `turns` without each answer on a dataset or dashboard the caller cannot open, and a question just before one. The same array when nothing restricts. */
export async function openTurns<T extends Turn>(projectId: string, turns: readonly T[]): Promise<T[]> {
  const level = await levelsOf(projectId, 'dataset');
  if (!level) return turns as T[];
  const board = turns.some((t) => t.dashboardsFrom) ? await levelsOf(projectId, 'dashboard') : null; // the dashboards' placements only when a turn names one
  const closed = turns.map((t) => t.role === 'assistant' && (shows(t).some((id) => level(id) === 'none') || !!t.dashboardsFrom?.some((id) => board?.(id) === 'none')));
  return turns.filter((t, i) => !closed[i] && !(t.role === 'user' && closed[i + 1]));
}

/** `title`, or the untitled one when it was taken from a question `openTurns` drops (`opening`: the conversation's first turns). */
export async function openTitle(projectId: string, title: string, opening: readonly copilot.CopilotTurn[]): Promise<string> {
  if (title === copilot.FALLBACK_TITLE || title !== copilot.titleFromTurns([...opening])) return title; // untitled, or renamed: the caller's own words
  const first = opening.find((t) => t.role === 'user' && t.text.trim() !== '');
  return first && (await openTurns(projectId, opening)).includes(first) ? title : copilot.FALLBACK_TITLE;
}

/**
 * The conversation `copilot:ask` lands in: the caller's `threadId`, else their latest (`copilot.threadFor`) — or none when
 * it has turns and every one is hidden from them, so the ask starts a new one and nothing of the old one (its agent, its
 * id) is used or named. `stored`: its turns, read to tell only when a folder restricts the caller (the ask replays them).
 */
export async function askThread(projectId: string, threadId: string | undefined): Promise<{ into: copilot.ThreadRef | null; stored?: copilot.CopilotTurn[] }> {
  const into = await copilot.threadFor(projectId, threadId);
  if (!into || !(await levelsOf(projectId, 'dataset'))) return { into };
  const stored = await copilot.loadHistory(projectId, into.id);
  return { into: stored.length && !(await openTurns(projectId, stored)).length ? null : into, stored };
}
