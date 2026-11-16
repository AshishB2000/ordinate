// "Add to dashboard" on an answer card (docs/assistant/00-design.md step 8) — MAIN PROCESS.
//
// An editor keeps a chart answer on a dashboard in one click. Nothing the browser sent decides what is kept: the card is
// rebuilt HERE from the spec (`computeCard`, THE answer door), saved as a visual through Save as visual's path
// (./answerSave), and a tile of that visual goes at the foot of the dashboard's last sheet. That is the DRAFT
// (`updateAnalysis`): viewers read the published copy until the next Publish, which this never does. Without
// `analysisId`, a new dashboard (`name`, else the card's title) holding just the tile.
//
// NOT TWICE. A dashboard that already holds this answer's tile — of the visual its turn keeps, or of a visual that draws
// what Save as visual would save for the card — answers with that tile (`already`), adding nothing. The answer's turn
// (`threadId` + `turnId`, the caller's own) keeps the visual and the dashboard (`markSaved`), so its card says where it
// went after a reload; a turn that already keeps a visual (Save as visual's) puts that one on, not a second.
//
// A SOURCE TABLE'S ANSWER (`spec.table`) is kept first, in the same call, through Keep as a dataset's own make
// (./sourceKeep `keepView`: its checks, and a table already kept is that dataset, never a second), and its turn re-pointed
// at it as Keep does; the tile is then that dataset's, so a second click finds the dataset and the tile both there.
//
// WHO: `write`. An existing dashboard needs Edit on its folder, and a new one lands as E6 lands one, with its dataset:
// both the route's, before this runs (src/server/authz/folderWriteGate.ts), so a refusal saves no visual. The visual
// needs Edit on its dataset (the visual store's own check). A kept table lands where Keep lands it (Everyone: it has no
// parent dataset). An SQL answer has no chart form, so its spec does not read.

import { randomUUID } from 'crypto';
import { ipcMain } from './bus';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import * as config from '../app/config';
import * as versions from '../app/versions';
import * as copilot from '../ai/copilot';
import { DASHBOARD_STYLE_PRESETS, GRID_COLS, type Card } from '../analysis/dashboards';
import { sanitizeStoredSpec } from '../ai/answerSpec';
import { answerNotAdded, dashboardGone, notAChartAnswer } from '../ai/answerMessages';
import { stableStringify } from '../engine/queryCache';
import { computeCard, type AnswerCard } from './answers';
import { saveCardAsVisual, visualOfCard } from './answerSave';
import { keepView } from './sourceKeep';
import { LIVE_NOTE } from './liveAnswers';

/** A chart tile as the plan builder sizes two to a row (src/analysis/planLayout.ts). */
const TILE = { w: GRID_COLS / 2, h: 6 };

type Named = { id: string; name: string };
export type AddedToDashboard = { ok: true; dashboard: Named; visual: Named; already?: true } | { ok: false; reason: string };
/** The answer turn the card draws, on one of the caller's threads. */
export type TurnRef = { threadId: string; turnId: string };

/** What decides a visual's figures, as the visual store keeps them: two visuals with the same key draw the same chart. */
const chartKey = (v: { datasetId: string; chartType: unknown; encoding: unknown; filters?: unknown }): string =>
  stableStringify([v.datasetId.toLowerCase(), visuals.sanitizeChartType(v.chartType), visuals.sanitizeEncoding(v.encoding), visuals.sanitizeFilters(v.filters)]);

/** This answer's tile already on `board`: of the visual `kept`, or of one that draws what the card saves as. */
async function tileOn(projectId: string, board: analysis.Analysis, card: AnswerCard, kept?: string): Promise<Named | null> {
  const want = chartKey(await visualOfCard(projectId, card));
  const ids = new Set(board.sheets.flatMap((p) => (p.cards || []).flatMap((c) => (c.type === 'visual' && c.visualId ? [c.visualId] : []))));
  for (const id of ids) {
    const v = await visuals.getVisual(projectId, id);
    if (v && (id === kept || chartKey(v) === want)) return { id: v.id, name: v.name };
  }
  return null;
}

/** The dashboard a turn's answer was added to, while the caller opens it and it still holds that visual's tile. */
export async function onDashboard(projectId: string, dashboardId: string, visualId: string): Promise<Named | undefined> {
  const board = await analysis.getAnalysis(projectId, dashboardId);
  return board?.sheets.some((p) => (p.cards || []).some((c) => c.visualId === visualId)) ? { id: board.id, name: board.name } : undefined;
}

export async function addAnswerToDashboard(projectId: string, spec: unknown, analysisId?: string, name?: string, turn?: TurnRef): Promise<AddedToDashboard> {
  const asked = sanitizeStoredSpec(spec);
  if (!asked) return { ok: false, reason: notAChartAnswer() };
  let s = asked;
  const mine = turn ? await copilot.findTurn(projectId, turn.threadId, turn.turnId) : null;
  if (asked.table) { // a visual names a dataset: the table's, as Keep as a dataset makes it
    const made = await keepView(projectId, asked.table, asked.datasetId);
    if (!made.ok) return { ok: false, reason: made.reason };
    const { table: _t, ...rest } = asked;
    s = { ...rest, datasetId: made.datasetId };
    if (turn && copilot.holds(mine ?? undefined, asked)) await copilot.replaceAnswer(projectId, turn.threadId, turn.turnId, asked, s, LIVE_NOTE);
  }
  const built = await computeCard(projectId, s);
  if ('ok' in built) return built;
  // The visual its turn keeps, while it is there and the turn draws this answer (or drew the table it was kept from).
  const kept = mine && (copilot.holds(mine, s) || copilot.holds(mine, asked)) && mine.savedVisualId ? await visuals.getVisual(projectId, mine.savedVisualId) : null;
  const marked = async (r: Extract<AddedToDashboard, { ok: true }>): Promise<AddedToDashboard> => {
    if (turn) await copilot.markSaved(projectId, turn.threadId, turn.turnId, s, r.visual.id, r.dashboard.id);
    return r;
  };
  // Read and write under the dashboard's hold (every pod): an editor's save between the two is never dropped.
  return analysis.lockedAnalysis(projectId, analysisId ?? '', async () => {
    const board = analysisId ? await analysis.getAnalysis(projectId, analysisId) : null;
    if (analysisId && !board) return { ok: false, reason: dashboardGone() };
    const there = board ? await tileOn(projectId, board, built.card, kept?.id) : null;
    if (board && there) return marked({ ok: true, already: true, dashboard: { id: board.id, name: board.name }, visual: there });
    // shortcut: a dashboard write that fails after this leaves the visual saved; upgrade if that is ever seen.
    const saved = kept ? { ok: true as const, visual: { id: kept.id, name: kept.name } } : await saveCardAsVisual(projectId, built.card);
    if (!saved.ok) return saved;
    const tile = (y: number) => ({ id: randomUUID(), type: 'visual', visualId: saved.visual.id, layout: { x: 0, y, ...TILE } }) as Card;
    if (!board) {
      const title = name?.trim() || built.card.title;
      const style = DASHBOARD_STYLE_PRESETS[config.get().branding.dashboardStyle];
      const made = await analysis.saveAnalysis(projectId, { name: title, sheets: [{ name: title, cards: [tile(0)] }], style });
      if (!made) return { ok: false, reason: answerNotAdded() };
      await versions.record(projectId, 'dashboard', made);
      return marked({ ok: true, dashboard: { id: made.id, name: made.name }, visual: saved.visual });
    }
    const sheets = board.sheets.map((p) => ({ ...p, cards: [...(p.cards || [])] }));
    const last = sheets[sheets.length - 1];
    last.cards.push(tile(last.cards.reduce((m, c) => Math.max(m, (c.layout?.y ?? 0) + (c.layout?.h ?? 0)), 0)));
    const updated = await analysis.updateAnalysis(projectId, board.id, { sheets });
    if (!updated) return { ok: false, reason: answerNotAdded() };
    await versions.record(projectId, 'dashboard', updated, { before: board });
    return marked({ ok: true, dashboard: { id: updated.id, name: updated.name }, visual: saved.visual });
  });
}

export function register(): void {
  ipcMain.handle('answer:addToDashboard', async (_e, { projectId, spec, analysisId, name, threadId, turnId }: Record<string, unknown> = {}) => {
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const turn = str(threadId) && str(turnId) ? { threadId: String(threadId), turnId: String(turnId) } : undefined;
    try {
      return await addAnswerToDashboard(String(projectId ?? ''), spec, str(analysisId), str(name), turn);
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error && err.message ? err.message : answerNotAdded() };
    }
  });
}
