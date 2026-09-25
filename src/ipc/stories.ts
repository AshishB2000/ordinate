// Stories — the record's IPC, and the Assistant's story proposal.
//
// CRUD is the ordinary pattern (every handler catches, a throw becomes
// { ok:false, error }). The two AI channels mirror the dashboard proposal
// exactly, because a story outline IS a plan: `story:draft` asks the model for
// STRUCTURE through the same draftAnalysisPlan the dashboard action uses —
// validated and previewed by the same code — and `story:build` turns the
// approved plan into records through the same planBuild.buildPlanRecords, then
// lays those records out as a document instead of a grid: a section heading per
// sheet, a metric row for its KPIs, a visual block per chart, prose for its
// notes. The model never writes a figure; every block is a live reference.

import { ipcMain } from 'electron';
import * as stories from '../analysis/stories';
import * as metrics from '../analysis/metrics';
import { buildPlanRecords } from '../analysis/planBuild';
import { draftAnalysisPlan } from './analyses';
import type { StoryBlock } from '../analysis/storyModel';

const STORY_INTENT =
  'Plan a written STORY rather than a dashboard: each sheet is one SECTION of a scrolling document, read top to ' +
  'bottom, named as a section heading a reader would scan for. Prefer two or three sections of one or two charts ' +
  'each, and a short note per section saying what to look at. The story is about: ';

/** An inline plan KPI → a saved Metric: an existing one with the same definition, else a new one named for it. */
async function metricFor(projectId: string, m: any): Promise<string | null> {
  if (!m || typeof m.datasetId !== 'string' || typeof m.column !== 'string') return null;
  const all = await metrics.listMetrics(projectId);
  const same = all.find((x) => x.datasetId === m.datasetId && !metrics.isFormulaDefinition(x.definition)
    && x.definition.column === m.column && x.definition.aggregation === m.aggregation);
  if (same) return same.id;
  const saved = await metrics.saveMetric(projectId, {
    name: typeof m.label === 'string' && m.label.trim() ? m.label.trim() : `${m.aggregation} of ${m.column}`,
    datasetId: m.datasetId,
    definition: { column: m.column, aggregation: m.aggregation },
  });
  return saved ? saved.id : null;
}

/** Built plan records → the blocks of a document. Exported for scripts/test-stories.ts. */
export async function blocksFromRecords(
  projectId: string,
  records: { name: string; sheets: { name: string; cards: any[] }[] },
  rationale: string,
): Promise<Partial<StoryBlock>[]> {
  const blocks: Partial<StoryBlock>[] = [{ kind: 'text', text: '# ' + (records.name || 'Untitled story') }];
  if (rationale && rationale.trim()) blocks.push({ kind: 'text', text: rationale.trim() });
  for (const sheet of records.sheets) {
    blocks.push({ kind: 'text', text: '## ' + (sheet.name || 'Section') });
    const kpis: string[] = [];
    for (const c of sheet.cards) {
      if (c && c.type === 'metric') {
        const id = await metricFor(projectId, c.metric);
        if (id && !kpis.includes(id)) kpis.push(id);
      }
    }
    if (kpis.length === 1) blocks.push({ kind: 'metric', metricId: kpis[0], filters: [] });
    if (kpis.length > 1) blocks.push({ kind: 'metrics_row', metricIds: kpis.slice(0, 4), filters: [] });
    for (const c of sheet.cards) {
      if (c && c.type === 'visual' && typeof c.visualId === 'string') blocks.push({ kind: 'visual', visualId: c.visualId, filters: [] });
    }
    for (const c of sheet.cards) {
      if (c && c.type === 'text' && (c.heading || c.text)) {
        blocks.push({ kind: 'text', text: (c.heading ? '### ' + c.heading + '\n' : '') + (c.text || '') });
      }
    }
  }
  return blocks;
}

export function register(): void {
  ipcMain.handle('story:list', async (_e, { projectId }: any = {}) => stories.listStories(projectId));

  ipcMain.handle('story:get', async (_e, { projectId, id }: any = {}) => stories.getStory(projectId, id));

  ipcMain.handle('story:create', async (_e, { projectId, name, blocks }: any = {}) => {
    try {
      const s = await stories.saveStory(projectId, { name, blocks });
      return s || { ok: false, error: 'Could not create the story.' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not create the story.' };
    }
  });

  ipcMain.handle('story:update', async (_e, { projectId, id, name, blocks }: any = {}) => {
    try {
      const s = await stories.updateStory(projectId, id, { name, blocks });
      return s || { ok: false, error: 'Story not found.' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not save the story.' };
    }
  });

  ipcMain.handle('story:delete', async (_e, { projectId, id }: any = {}) => ({ ok: await stories.deleteStory(projectId, id) }));

  // The Assistant's `story` action, step 1: an outline, validated and previewed,
  // saved nowhere. Same return shape as `analysis:draft`.
  ipcMain.handle('story:draft', async (_e, { projectId, datasetId, intent }: any = {}) =>
    draftAnalysisPlan(projectId, {
      datasetId: typeof datasetId === 'string' ? datasetId : undefined,
      intent: STORY_INTENT + (typeof intent === 'string' ? intent : ''),
    }));

  // Step 2, on the user's approval: records through the ordinary plan build,
  // then ONE new story laid out from them.
  ipcMain.handle('story:build', async (_e, { projectId, plan }: any = {}) => {
    try {
      const records = await buildPlanRecords(projectId, plan);
      if (!records.sheets.length) return { ok: false, error: 'Nothing in that outline could be built.' };
      const blocks = await blocksFromRecords(projectId, records, plan && typeof plan.rationale === 'string' ? plan.rationale : '');
      const s = await stories.saveStory(projectId, { name: records.name, blocks });
      if (!s) return { ok: false, error: 'Could not create the story.' };
      return { ok: true, story: s, dropped: records.dropped };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not build the story.' };
    }
  });
}
