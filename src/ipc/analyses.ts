import { ipcMain } from 'electron';
import * as analysis from '../analysis/analysis';
import * as dashboards from '../analysis/dashboards';
import * as visuals from '../analysis/visuals';
import { draftDashboard } from '../analyze';
import * as plan from '../analysis/analysisPlan';

// Analyses IPC — list/get/create/rename/update/delete an Analysis (the AUTHORING
// container), plus the two channels that only exist here:
//
//   `analysis:forDashboard` — the implicit wrap of a legacy standalone dashboard
//   `analysis:draft`        — the AI layout draft, MOVED from `dashboard:draft`
//
// All are ipcMain.handle (request/response); a thrown error becomes
// { ok:false, error } so the renderer never sees an unhandled rejection. No deps
// object (pure disk + the model call), matching projects.register() /
// visuals.register() / dashboards.register().
//
// Nothing in this file hydrates a dataset table, and nothing computes a figure.
// Every number a sheet shows is still recomputed at render time by the existing
// `dashboard:metric` / `visual:data` channels.

// ── The implicit-analysis wrap ──────────────────────────────────────────────
//
// A dashboard that predates analyses keeps working EXACTLY as it does today. It
// is wrapped in an Analysis the first time the user EDITS it — never on a read.
// `dashboard:list` and `dashboard:get` stay pure reads that upgrade v2 → v3 in
// memory only (src/dashboards.ts normalize), so a machine that never edits
// anything never has a byte rewritten.
//
// NOT GATED ON THE DuckDB BRIDGE, deliberately. src/datasets.ts gates its v2→v3
// migration on parquetStore.isSupported() because the TARGET of that migration
// is Parquet: without the native module the migration would write a table the
// app cannot read back. An Analysis is plain JSON, like project.json and
// dashboard.json. Gating this on the bridge would leave a user whose native
// module failed to load unable to author an analysis at all, for zero benefit —
// and it would be the first bridge-gated AUTHORING feature in the app.
//
// ORDER MATTERS: write the analysis FIRST, stamp the dashboard SECOND. A crash
// between them leaves an ORPHAN ANALYSIS (invisible, one small JSON file) and an
// unwrapped dashboard, and the next edit retries cleanly. The reverse order
// would leave a dashboard pointing at an analysis that does not exist.
//
// BEST-EFFORT: a failure at either step must not fail the user's action — the
// caller falls back to the legacy in-place dashboard editor.
//
// Exported so the self-check can drive the real logic rather than a copy of it
// (the same reason src/ipc/mosaic.ts exports its resolvers).
export async function wrapDashboardInAnalysis(
  projectId: string,
  dashboardId: string,
): Promise<
  | { ok: true; analysis: analysis.Analysis; created: boolean }
  | { ok: false; error: string }
> {
  const d = await dashboards.getDashboard(projectId, dashboardId);
  if (!d) return { ok: false, error: 'Dashboard not found' };

  // Idempotent: an already-wrapped dashboard returns its existing analysis,
  // exactly as getDataset's second read returns the migrated record.
  if (d.analysisId) {
    const existing = await analysis.getAnalysis(projectId, d.analysisId);
    if (existing) return { ok: true, analysis: existing, created: false };
    // Stale pointer (analysis deleted) — fall through and wrap again.
  }

  // Deep copy: the analysis must own its sheets outright, so editing them can
  // never reach back into the published snapshot.
  const created = await analysis.saveAnalysis(projectId, {
    name: d.name,
    sheets: JSON.parse(JSON.stringify(d.pages)),
    filters: JSON.parse(JSON.stringify(d.filters)),
    publishedDashboardIds: [d.id],
    // The dashboard already exists and is what a reader sees, so it counts as
    // published — as of whenever it was last written.
    lastPublishedAt: d.updatedAt,
  });
  if (!created) return { ok: false, error: 'Could not create the analysis' };

  // Step 2. A failure here is survivable (see the header) — the analysis stands,
  // the dashboard stays unwrapped, and the next edit retries.
  //
  // `publish: true` — this is a PROVENANCE STAMP, not a user edit of the
  // snapshot's contents, so it is one of the two writes allowed past the
  // read-only guard in dashboards.updateDashboard. It also covers the re-wrap
  // case, where the dashboard already carries a (stale) analysisId.
  await dashboards.updateDashboard(
    projectId,
    dashboardId,
    { analysisId: created.id, publishedAt: d.publishedAt || d.updatedAt },
    { publish: true },
  );

  return { ok: true, analysis: created, created: true };
}

// ── PUBLISH — the whole point of the split ──────────────────────────────────
//
// Publishing is a SNAPSHOT, NOT A LINK. After it, editing the analysis — its
// sheets, its filters, or ANY VISUAL IT REFERENCES — must not change the
// published dashboard by one byte until the user publishes again.
//
// That is why each referenced Visual's DEFINITION is copied BY VALUE into the
// card as an inline `CardVisual`. Layout alone is not enough: a visual is part
// of what the author edits, so a published dashboard that resolved `visualId`
// at render time would silently reshape itself the moment someone changed a
// chart type from the Visuals page. Copying the definition is the level at
// which the guarantee holds.
//
// What is deliberately NOT copied is the DATA. A published dashboard still
// reads the live Parquet through the frozen definition — refreshing a Postgres
// connection is a data event, and a dashboard that could never see new numbers
// is not what "publish" means in a BI tool. This is a stated non-guarantee, not
// an oversight.
//
// Nothing in here hydrates a dataset, touches a row, or computes a figure.
export async function publishAnalysis(
  projectId: string,
  id: string,
  opts: { dashboardId?: unknown; name?: unknown } = {},
): Promise<{ ok: true; dashboard: dashboards.Dashboard; created: boolean } | { ok: false; error: string }> {
  const a = await analysis.getAnalysis(projectId, id);
  if (!a) return { ok: false, error: 'Analysis not found' };

  // 1. Deep-copy sheets → pages. CARD IDS ARE KEPT: a stable card id across
  //    republishes is what a future "what changed since last publish" diff
  //    needs, and a card id is a key, never a path.
  const pages: unknown[] = JSON.parse(JSON.stringify(a.sheets));

  // 2. Denormalise every visual card. On failure the card keeps its
  //    `visualId` only and renders the existing "Unavailable" placeholder —
  //    dropping it would silently reflow the layout, which is worse than a
  //    visible gap.
  for (const page of pages as { cards?: Record<string, unknown>[] }[]) {
    for (const card of page.cards || []) {
      if (card.type !== 'visual' || typeof card.visualId !== 'string') continue;
      const v = await visuals.getVisual(projectId, card.visualId);
      if (!v) continue;
      card.visual = {
        datasetId: v.datasetId,
        name: v.name,
        chartType: v.chartType,
        encoding: v.encoding,
        overrides: v.overrides,
        filters: v.filters,
      };
    }
  }

  // 3. Analysis-wide filters, by value.
  const filters = JSON.parse(JSON.stringify(a.filters));

  // 4. PRUNE ON WRITE. `publishedDashboardIds` is provenance and a read must
  //    stay a read, so nothing prunes it on load — this is the one place that
  //    knows a stale id is stale, because it is already checking whether the
  //    republish target still exists.
  const live: string[] = [];
  for (const did of a.publishedDashboardIds) {
    if (await dashboards.getDashboard(projectId, did)) live.push(did);
  }

  const publishedAt = new Date().toISOString();
  const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim() : undefined;
  // A `dashboardId` that is not in this analysis's OWN provenance list is
  // refused (it falls through to a new dashboard): that is what stops one
  // analysis from overwriting another's published dashboard.
  const target = typeof opts.dashboardId === 'string' && live.includes(opts.dashboardId) ? opts.dashboardId : null;

  let dashboard: dashboards.Dashboard | null = null;
  let created = false;
  if (target) {
    dashboard = await dashboards.updateDashboard(
      projectId,
      target,
      { name, pages, filters, analysisId: a.id, publishedAt },
      { publish: true }, // the only other write allowed past the read-only guard
    );
  }
  if (!dashboard) {
    dashboard = await dashboards.saveDashboard(projectId, {
      name: name || a.name,
      pages,
      filters,
      analysisId: a.id,
      publishedAt,
    });
    created = true;
    if (!dashboard) return { ok: false, error: 'Could not publish the dashboard' };
    live.push(dashboard.id);
  }

  // 5. Record provenance LAST. The dashboard is the artifact the user asked
  //    for, so it is written first; a failure here leaves an unrecorded (but
  //    perfectly good) dashboard, which is recoverable, while the reverse would
  //    record an id for a dashboard that does not exist.
  //    `bumpUpdatedAt: false` — publishing edits no sheet, filter or name, and
  //    `updatedAt` is what "has unpublished changes?" compares against.
  await analysis.updateAnalysis(
    projectId,
    id,
    { publishedDashboardIds: live, lastPublishedAt: publishedAt },
    { bumpUpdatedAt: false },
  );

  return { ok: true, dashboard, created };
}

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

  // Deleting an analysis deliberately does NOT touch the dashboards it published
  // — a published dashboard is a standalone snapshot and outlives its author.
  ipcMain.handle('analysis:delete', async (_e, { projectId, id }: any = {}) => ({
    ok: await analysis.deleteAnalysis(projectId, id),
  }));

  // The implicit wrap. Called by the renderer when the user opens a LEGACY
  // dashboard for editing — never on list, never on open-to-view.
  ipcMain.handle('analysis:forDashboard', async (_e, { projectId, dashboardId }: any = {}) => {
    try {
      return await wrapDashboardInAnalysis(projectId, dashboardId);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to open the analysis' };
    }
  });

  // PUBLISH — create a new dashboard, or update the one being republished.
  // `dashboardId` is honoured only when it is already in this analysis's
  // publishedDashboardIds (see publishAnalysis); anything else publishes anew.
  ipcMain.handle('analysis:publish', async (_e, { projectId, id, dashboardId, name }: any = {}) => {
    try {
      return await publishAnalysis(projectId, id, { dashboardId, name });
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to publish the analysis' };
    }
  });

  // Exported so the self-check drives the real handler body, not a copy of it —
  // the same reason `wrapDashboardInAnalysis` / `publishAnalysis` are exported.
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
