import { ipcMain } from 'electron';
import * as analysis from '../analysis/analysis';
import { draftDashboard } from '../ai/analyze';
import * as plan from '../analysis/analysisPlan';

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
  // NOTE the destructure: these handlers forward NAMED fields, not the whole
  // payload, so a field that is not listed here is silently dropped on the way
  // to disk however correctly the record and the sanitizer handle it. `style`
  // is listed for exactly that reason.
  ipcMain.handle('analysis:create', async (_e, { projectId, name, sheets, filters, style }: any = {}) => {
    try {
      const saved = await analysis.saveAnalysis(projectId, { name, sheets, filters, style });
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
  ipcMain.handle('analysis:update', async (_e, { projectId, id, name, sheets, filters, style }: any = {}) => {
    try {
      const updated = await analysis.updateAnalysis(projectId, id, { name, sheets, filters, style });
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
