// "Keep as a dataset" on an answer read straight from a source table (docs/assistant/00-design.md, "Asking needs no
// dataset; keeping makes one") — MAIN PROCESS ONLY.
//
// `answer:keepTable` (`write`, as `connection:import` is): the caller's own answer turn whose spec names a table
// (./sourceAnswers), the table's Live dataset made through the connection's own Live create (./liveDatasets
// createLiveDataset: its columns read from the warehouse's catalog, its first schema sync queued), and the turn's answer
// re-pointed at it, so Save as visual, Verify and Add to dashboard then work as on any dataset. The card is computed
// again on open, on the new dataset. A turn already kept (or never a table's) makes nothing: one click, one dataset.

import { ipcMain } from './bus';
import * as copilot from '../ai/copilot';
import { sourceView } from './sourceAnswers';
import { createLiveDataset } from './liveDatasets';
import { answerNotThere } from '../ai/answerSnapshotMessages';
import { notFromTable } from '../ai/sourceAnswerMessages';
import { turnsForBrowser } from './answerSnapshots';
import { LIVE_NOTE } from './liveAnswers';

export async function keepTable(projectId: string, threadId: string, turnId: string): Promise<Record<string, unknown>> {
  const turn = await copilot.findTurn(projectId, threadId, turnId);
  if (!turn || !turn.answer) return { ok: false, reason: answerNotThere() };
  const spec = turn.answer;
  if (!spec.table) return { ok: false, reason: notFromTable() };
  const v = await sourceView(projectId, spec.table, spec.datasetId);
  if (!v.ok) return v;
  const made = await createLiveDataset({ projectId, connId: v.table.connId, table: v.table.table, name: v.table.table });
  if (!made.ok || !('dataset' in made) || !made.dataset) return { ok: false, reason: 'error' in made ? made.error : notFromTable() };
  const { table: _t, ...rest } = spec;
  const kept = { ...rest, datasetId: made.dataset.id };
  if (!(await copilot.replaceAnswer(projectId, threadId, turnId, spec, kept, LIVE_NOTE))) return { ok: false, reason: answerNotThere() };
  return { ok: true, datasetId: made.dataset.id, turns: await turnsForBrowser(projectId, await copilot.loadHistory(projectId, threadId)) };
}

export function register(): void {
  ipcMain.handle('answer:keepTable', async (_e, { projectId, threadId, turnId }: Record<string, unknown> = {}) => {
    try {
      return await keepTable(String(projectId ?? ''), String(threadId ?? ''), String(turnId ?? ''));
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error ? err.message : notFromTable() };
    }
  });
}
