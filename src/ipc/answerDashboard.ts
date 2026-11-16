// "Add to dashboard" on an answer card (docs/assistant/00-design.md step 8) — MAIN PROCESS.
//
// An editor keeps a chart answer on a dashboard in one click. Nothing the browser sent decides what is kept: the card is
// rebuilt HERE from the spec (`computeCard`, THE answer door), saved as a visual through Save as visual's path
// (./answerSave), and a tile of that visual goes at the foot of the dashboard's last sheet. That is the DRAFT
// (`updateAnalysis`): viewers read the published copy until the next Publish, which this never does. Without
// `analysisId`, a new dashboard (`name`, else the card's title) holding just the tile.
//
// WHO: `write`. An existing dashboard needs Edit on its folder, and a new one lands as E6 lands one, with its dataset:
// both the route's, before this runs (src/server/authz/folderWriteGate.ts), so a refusal saves no visual. The visual
// needs Edit on its dataset (the visual store's own check). A source table's answer is Keep as a dataset first; an SQL
// answer has no chart form, so its spec does not read.

import { randomUUID } from 'crypto';
import { ipcMain } from './bus';
import * as analysis from '../analysis/analysis';
import * as config from '../app/config';
import * as versions from '../app/versions';
import { DASHBOARD_STYLE_PRESETS, GRID_COLS, type Card } from '../analysis/dashboards';
import { sanitizeStoredSpec } from '../ai/answerSpec';
import { keepFirst } from '../ai/sourceAnswerMessages';
import { answerNotAdded, dashboardGone, notAChartAnswer } from '../ai/answerMessages';
import { computeCard } from './answers';
import { saveCardAsVisual } from './answerSave';

/** A chart tile as the plan builder sizes two to a row (src/analysis/planLayout.ts). */
const TILE = { w: GRID_COLS / 2, h: 6 };

export type AddedToDashboard =
  | { ok: true; dashboard: { id: string; name: string }; visual: { id: string; name: string } }
  | { ok: false; reason: string };

export async function addAnswerToDashboard(projectId: string, spec: unknown, analysisId?: string, name?: string): Promise<AddedToDashboard> {
  const s = sanitizeStoredSpec(spec);
  if (!s) return { ok: false, reason: notAChartAnswer() };
  if (s.table) return { ok: false, reason: keepFirst() }; // a visual names a dataset: Keep as a dataset makes it (./sourceKeep)
  const built = await computeCard(projectId, s);
  if ('ok' in built) return built;
  // Read and write under the dashboard's hold (every pod): an editor's save between the two is never dropped.
  return analysis.lockedAnalysis(projectId, analysisId ?? '', async () => {
    const board = analysisId ? await analysis.getAnalysis(projectId, analysisId) : null;
    if (analysisId && !board) return { ok: false, reason: dashboardGone() };
    // shortcut: a dashboard write that fails after this leaves the visual saved; upgrade if that is ever seen.
    const saved = await saveCardAsVisual(projectId, built.card);
    if (!saved.ok) return saved;
    const tile = (y: number) => ({ id: randomUUID(), type: 'visual', visualId: saved.visual.id, layout: { x: 0, y, ...TILE } }) as Card;
    if (!board) {
      const title = name?.trim() || built.card.title;
      const style = DASHBOARD_STYLE_PRESETS[config.get().branding.dashboardStyle];
      const made = await analysis.saveAnalysis(projectId, { name: title, sheets: [{ name: title, cards: [tile(0)] }], style });
      if (!made) return { ok: false, reason: answerNotAdded() };
      await versions.record(projectId, 'dashboard', made);
      return { ok: true, dashboard: { id: made.id, name: made.name }, visual: saved.visual };
    }
    const sheets = board.sheets.map((p) => ({ ...p, cards: [...(p.cards || [])] }));
    const last = sheets[sheets.length - 1];
    last.cards.push(tile(last.cards.reduce((m, c) => Math.max(m, (c.layout?.y ?? 0) + (c.layout?.h ?? 0)), 0)));
    const updated = await analysis.updateAnalysis(projectId, board.id, { sheets });
    if (!updated) return { ok: false, reason: answerNotAdded() };
    await versions.record(projectId, 'dashboard', updated, { before: board });
    return { ok: true, dashboard: { id: updated.id, name: updated.name }, visual: saved.visual };
  });
}

export function register(): void {
  ipcMain.handle('answer:addToDashboard', async (_e, { projectId, spec, analysisId, name }: Record<string, unknown> = {}) => {
    try {
      return await addAnswerToDashboard(String(projectId ?? ''), spec, typeof analysisId === 'string' ? analysisId : undefined, typeof name === 'string' ? name : undefined);
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error && err.message ? err.message : answerNotAdded() };
    }
  });
}
