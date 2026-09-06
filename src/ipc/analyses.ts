import { ipcMain } from 'electron';
import * as analysis from '../analysis/analysis';
import { draftDashboard, dispatch, parseFirstObject, type NeutralMsg } from '../ai/analyze';
import * as plan from '../analysis/analysisPlan';
import * as delta from '../analysis/dashboardDelta';
import * as config from '../app/config';

// Analyses IPC — list/get/create/rename/update/delete an Analysis (the AUTHORING
// container), plus the AI layout draft channel `analysis:draft` (MOVED from the
// deleted `dashboard:draft`).
//
// All are ipcMain.handle (request/response); a thrown error becomes
// { ok:false, error } so the renderer never sees an unhandled rejection. No deps
// object (pure disk + the model call), matching projects.register() /
// visuals.register().
//
// Nothing in this file hydrates a dataset table, and nothing computes a figure.
// Every number a sheet shows is still recomputed at render time by the existing
// `dashboard:metric` / `visual:data` channels.

// ── THE AI PLAN — draft → preview → build ──────────────────────────────────
//
// `dashboard:draft` was deleted rather than aliased in Phase C, and this is the
// channel that replaced it. Phase E extended it end-to-end without adding a
// second AI path: `analyze.draftDashboard()` is still the ONE model call (its
// prompt grew from a flat card list into the plan envelope), and every decision
// about what that call produced is re-made by `analysisPlan.validatePlan` — the
// SAME function `analysis:buildPlan` runs on the way in.
//
//   analysis:draft       AI. FACTS in (no rows, no secrets), plan envelope out,
//                        validated + previewed. `not_ready` with no model.
//   analysis:previewPlan NOT AI. Re-validate + re-preview a user-EDITED plan.
//   analysis:buildPlan   NOT AI. Re-validate the approved plan and create the
//                        records: calculated fields → ordinary TransformSteps,
//                        visuals → real Visuals, sheets → an Analysis.
//
// Only the first needs a model. Editing, previewing and building a plan work
// with nothing configured at all — they are app code, and that is what keeps
// "AI is optional" true for the whole surface rather than just the entry point.
//
// Nothing here returns a figure the model produced. Every number in a preview
// came out of `vizDataFor`, which is the same function that draws the built
// Visual; see the header of src/analysisPlan.ts for why they cannot disagree.

export function register() {
  ipcMain.handle('analysis:list', async (_e, { projectId }: any = {}) =>
    analysis.listAnalyses(projectId),
  );

  ipcMain.handle('analysis:get', async (_e, { projectId, id }: any = {}) =>
    analysis.getAnalysis(projectId, id),
  );

  // `sheets` is optional so `analysis:draft` can hand its packed sheets straight in.
  ipcMain.handle('analysis:create', async (_e, { projectId, name, sheets, filters }: any = {}) => {
    try {
      const saved = await analysis.saveAnalysis(projectId, { name, sheets, filters });
      if (!saved) return { ok: false, error: 'Invalid project, or it no longer exists' };
      return saved;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save the analysis' };
    }
  });

  ipcMain.handle('analysis:rename', async (_e, { projectId, id, name }: any = {}) => {
    try {
      const updated = await analysis.updateAnalysis(projectId, id, { name });
      return updated ? { ok: true, analysis: updated } : { ok: false, error: 'Could not rename the analysis' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to rename the analysis' };
    }
  });

  // Mirrors dashboard:update exactly — a supplied array REPLACES the stored one
  // wholesale; it is never patch-merged.
  ipcMain.handle('analysis:update', async (_e, { projectId, id, name, sheets, filters }: any = {}) => {
    try {
      const updated = await analysis.updateAnalysis(projectId, id, { name, sheets, filters });
      return updated ? { ok: true, analysis: updated } : { ok: false, error: 'Could not update the analysis' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update the analysis' };
    }
  });

  ipcMain.handle('analysis:delete', async (_e, { projectId, id }: any = {}) => ({
    ok: await analysis.deleteAnalysis(projectId, id),
  }));

  // Exported so the self-check drives the real handler body, not a copy of it.
  ipcMain.handle('analysis:draft', async (_e, { projectId, datasetId, intent }: any = {}) =>
    draftAnalysisPlan(projectId, {
      datasetId: typeof datasetId === 'string' ? datasetId : undefined,
      intent: typeof intent === 'string' ? intent : undefined,
    }));

  // Re-validate and re-preview a plan the USER edited. No model, so this works
  // with nothing configured — the plan is data, and validating data is app code.
  // EDIT an open dashboard. AI, but only for STRUCTURE: the reply is a list of
  // ops naming tiles by title, which validateDelta resolves against the real
  // record. Nothing is applied here — the renderer shows the diff and the user
  // clicks.
  ipcMain.handle('analysis:editDelta', async (_e, { projectId, analysisId, intent }: any = {}) =>
    draftDashboardEdit(
      projectId,
      typeof analysisId === 'string' ? analysisId : '',
      typeof intent === 'string' ? intent : '',
    ));

  ipcMain.handle('analysis:previewPlan', async (_e, { projectId, plan: raw }: any = {}) => {
    try {
      return await plan.previewPlan(projectId, raw);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to preview the plan' };
    }
  });

  // APPROVAL. Re-validates with the same validatePlan the preview ran, then
  // creates the records through the existing stores. Also model-free.
  ipcMain.handle('analysis:buildPlan', async (_e, { projectId, plan: raw }: any = {}) => {
    try {
      return await plan.buildPlan(projectId, raw);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to build the analysis' };
    }
  });
}

/**
 * `analysis:draft`'s body: FACTS → the one model call → validate → preview.
 *
 * Returns `{ ok:true, plan, ...preview }` — the plan the renderer will hand back
 * to `analysis:buildPlan` verbatim, plus everything needed to show it. Nothing
 * is saved: the user approves, edits or rejects first.
 *
 * `{ ok:false, notReady:true }` with no model configured, which is the whole of
 * what "AI is optional" costs this surface — preview and build still work.
 */
export async function draftAnalysisPlan(
  projectId: string,
  opts: { datasetId?: string; intent?: string } = {},
): Promise<any> {
  try {
    const ctx = await plan.loadPlanContext(projectId, opts.datasetId);
    if (ctx.datasets.length === 0 && ctx.visuals.length === 0) {
      // Scoped and empty means the id did not resolve — say which, rather than
      // telling someone looking at a dataset that they have no datasets.
      return {
        ok: false,
        error: opts.datasetId
          ? 'That dataset could not be read, so there is nothing to draft from.'
          : 'Add a dataset or visual before drafting an analysis.',
      };
    }

    // App-computed, row-free, secret-free. See analysisPlan.buildFactsText.
    const res = await draftDashboard(plan.buildFactsText(ctx, opts.intent));
    if (!res.ok) {
      if (res.errorType === 'not_ready') return { ok: false, notReady: true };
      return { ok: false, error: res.message || 'Could not draft an analysis' };
    }

    // Reuses the context the FACTS block was built from — the model saw exactly
    // the records this validates against.
    return await plan.previewPlan(projectId, res.structure, ctx);
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to draft an analysis' };
  }
}


// ── The EDIT DELTA: one model call, then the app decides everything ──────────
//
// The second AI entry point on this surface, and deliberately the same shape as
// draftAnalysisPlan above: FACTS in (names only — no rows, no figures, no
// secrets), a structure out, and every decision about that structure re-made by
// app code (analysis/dashboardDelta.validateDelta) before anything is shown.
//
// It is a SEPARATE call from copilot:ask rather than a field on the answer for
// the same reason analysis:draft is: the chat answer streams as prose, and a
// list of ops is not prose. copilot:ask's suggestedAction only says WHICH door
// to knock on; this is the door.
//
// The prompt lives here, next to the call, rather than in dashboardDelta.ts —
// that module is PURE (no electron, no config) so its test can drive it
// directly, and a prompt string would not change that but a model call would.

const EDIT_DELTA_SYSTEM_PROMPT =
  'You edit an existing dashboard. You are given its pages and every tile on them BY TITLE, plus ' +
  'the columns of each dataset. Reply with ONLY a JSON object: {"ops":[…]} — no markdown, no ' +
  'prose, no code fences.\n' +
  'Each op is one of:\n' +
  '  {"op":"addTile","page":<1-based page number>,"dataset":"<name>","name":"<title>",' +
  '"chartType":"<type>","encoding":{"category":"<col>","values":[{"column":"<col>","aggregation":"sum|avg|count|min|max"}]}}\n' +
  '  {"op":"replaceTileEncoding","tile":"<existing tile title>","chartType":"<type>","encoding":{…}}\n' +
  '  {"op":"removeTile","tile":"<existing tile title>"}\n' +
  '  {"op":"moveTile","tile":"<title>","position":"top|bottom|before|after","anchor":"<title, for before/after>"}\n' +
  '  {"op":"addControl","page":<n>,"kind":"dropdown|multi|date_range","dataset":"<name>","column":"<col>","label":"<label>"}\n' +
  '  {"op":"renamePage","page":<n>,"name":"<new name>"}\n' +
  '  {"op":"addPage","name":"<name>"}\n' +
  '  {"op":"setTitle","name":"<new dashboard name>"}\n' +
  'Name tiles by their TITLE exactly as listed — the app resolves titles to ids and REFUSES an ' +
  'ambiguous one, so do not invent or abbreviate a title. Reference only columns that exist. ' +
  'sum/avg/min/max need a number column; count works on any. Do NOT specify positions, sizes, ' +
  'coordinates or ids — the app arranges the grid. NEVER output a data value or a computed number. ' +
  'Return only the ops the instruction actually asks for.';

/** Names only: pages, tiles and the columns available. No rows, no figures. */
function buildEditFactsText(name: string, ctx: delta.DeltaContext): string {
  const lines: string[] = [`Dashboard: "${name}".`, ''];
  ctx.pages.forEach((p, i) => {
    lines.push(`Page ${i + 1} "${p.name}" (${p.tileCount} tile(s)):`);
    const tiles = ctx.tiles.filter((t) => t.pageIndex === i);
    if (tiles.length === 0) lines.push('  (empty)');
    tiles.forEach((t) => {
      const bits: string[] = [t.type];
      if (t.chartType) bits.push(t.chartType);
      lines.push(`  - "${t.title}" (${bits.join(', ')})`);
    });
  });
  lines.push('');
  lines.push('Datasets and their columns:');
  ctx.datasets.forEach((d) => {
    lines.push(`- "${d.name}": ${d.columns.map((c) => `${c.name} (${c.type})`).join(', ')}`);
  });
  return lines.join('\n');
}

/**
 * Preview every NEW tile the delta proposes, through the SAME pipeline a drafted
 * plan uses — a synthetic one-sheet plan handed to previewPlan. That keeps the
 * validated-plan gate on the path (a tile that would not survive validatePlan
 * does not get previewed either) and means every figure on the card was
 * computed by vizDataFor, not by anything here.
 */
async function previewNewTiles(
  projectId: string,
  ops: delta.ValidatedDeltaOp[],
  ctx: plan.PlanContext,
): Promise<unknown[]> {
  const adds = ops.filter((o): o is Extract<delta.ValidatedDeltaOp, { op: 'addTile' }> => o.op === 'addTile');
  if (adds.length === 0) return [];
  const synthetic = {
    name: 'preview',
    sheets: [{
      name: 'preview',
      visuals: adds.map((o) => ({
        datasetId: o.datasetId, name: o.name, chartType: o.chartType,
        encoding: o.encoding, filters: o.filters,
      })),
    }],
  };
  try {
    const res = await plan.previewPlan(projectId, synthetic, ctx);
    return res.sheets[0] ? res.sheets[0].visuals : [];
  } catch (_) {
    return []; // a preview is a nicety; the diff still stands
  }
}

export async function draftDashboardEdit(
  projectId: string,
  analysisId: string,
  intent: string,
): Promise<any> {
  try {
    const a = await analysis.getAnalysis(projectId, analysisId);
    if (!a) return { ok: false, error: 'That dashboard could not be read.' };
    if (!config.executionReady()) return { ok: false, notReady: true };

    const planCtx = await plan.loadPlanContext(projectId);
    const tiles = await analysis.listAnalysisTiles(projectId, a);
    const ctx: delta.DeltaContext = {
      pages: (a.sheets || []).map((p) => ({ name: p.name, tileCount: (p.cards || []).length })),
      tiles,
      datasets: planCtx.datasets,
    };

    const messages: NeutralMsg[] = [{
      role: 'user',
      text: buildEditFactsText(a.name, ctx) + '\n\n---\n\nInstruction: ' + intent,
    }];
    const { rawText, error } = await dispatch(EDIT_DELTA_SYSTEM_PROMPT, messages);
    if (error) {
      if (error.errorType === 'not_ready') return { ok: false, notReady: true };
      return { ok: false, error: error.message || 'Could not work out that change.' };
    }
    const parsed = parseFirstObject(rawText);
    if (!parsed) return { ok: false, error: 'Could not read the reply.' };

    const { ops, dropped } = delta.validateDelta(parsed, ctx);
    const previews = await previewNewTiles(projectId, ops, planCtx);
    // Carry each referenced tile's TITLE back with its op. The validator works
    // in card ids (the only thing that cannot be ambiguous), but a diff line
    // reading "this tile: now a line" tells the user nothing — and the renderer
    // cannot resolve a visual card's title on its own, because that title lives
    // on the separate Visual record.
    const titleOf = new Map(ctx.tiles.map((t) => [t.cardId, t.title]));
    const labelled = ops.map((o: any) => {
      const extra: any = {};
      if (o.cardId && titleOf.has(o.cardId)) extra.title = titleOf.get(o.cardId);
      if (o.anchorCardId && titleOf.has(o.anchorCardId)) extra.anchorTitle = titleOf.get(o.anchorCardId);
      return Object.keys(extra).length ? { ...o, ...extra } : o;
    });
    return { ok: true, name: a.name, ops: labelled, dropped, previews };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to work out that change.' };
  }
}
