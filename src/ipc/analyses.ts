import { ipcMain } from 'electron';
import * as analysis from '../analysis';
import * as dashboards from '../dashboards';
import * as datasets from '../datasets';
import * as visuals from '../visuals';
import { draftDashboard } from '../analyze';

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
  await dashboards.updateDashboard(projectId, dashboardId, {
    analysisId: created.id,
    publishedAt: d.publishedAt || d.updatedAt,
  });

  return { ok: true, analysis: created, created: true };
}

// AI-DRAFTED LAYOUT — moved VERBATIM from `dashboard:draft`, which is deleted
// rather than aliased: two AI paths that both create a layout, differing subtly,
// is the failure mode worth avoiding, and an alias IS that outcome.
//
// Build a compact inventory (datasets → columns; saved visuals by name), ask the
// model for a name + cards referencing ONLY those names, then RESOLVE names→ids
// in MAIN (verify columns exist, clamp aggregations, map visual names→ids),
// ASSIGN the grid layout ourselves (flow packer), and sanitize into sheets.
// Returns { ok, name, sheets } WITHOUT saving — the renderer confirms first.
// Every figure is computed later, at render.
//
// The only change from the dashboard version is what it PRODUCES: `sheets` for
// an analysis, not `pages` for a dashboard. The AI's output is a first draft —
// the thing a user immediately wants to edit — so it must land on the authoring
// surface, not in the one place the model calls immutable.
//
// `analyze.draftDashboard()` KEEPS ITS NAME: it is the model call, it sits beside
// summarizeDashboard/explainAnomalies, and a later phase must EXTEND it rather
// than add a second drafting function.
const DRAFT_AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);

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

  ipcMain.handle('analysis:draft', async (_e, { projectId }: any = {}) => {
    try {
      const dsSummaries = await datasets.listDatasets(projectId);
      const vList = await visuals.listVisuals(projectId);
      if (dsSummaries.length === 0 && vList.length === 0) {
        return { ok: false, error: 'Add a dataset or visual before drafting an analysis.' };
      }

      // Load each dataset's columns for the inventory + name→(id, columns) lookup.
      // METADATA ONLY — this loop reads name/columns/id and nothing else, so it
      // uses getDatasetMeta. It previously hydrated EVERY dataset in the project
      // (both the derived table and the immutable source) to build a prompt
      // listing column names: at the 1M row cap that is hundreds of MB parsed per
      // draft, for data that is never looked at.
      const dsByName = new Map<string, datasets.DatasetMeta>();
      const invLines: string[] = ['Datasets and their columns:'];
      for (const s of dsSummaries) {
        const ds = await datasets.getDatasetMeta(projectId, s.id);
        if (!ds) continue;
        dsByName.set(ds.name, ds);
        invLines.push(`- "${ds.name}": ${ds.columns.map((c) => `${c.name} (${c.type})`).join(', ') || '(no columns)'}`);
      }
      invLines.push('');
      invLines.push('Saved visuals (reference by exact name):');
      const vByName = new Map<string, string>(); // name → visualId
      vList.forEach((v) => vByName.set(v.name, v.id));
      invLines.push(vList.length ? vList.map((v) => `- "${v.name}"`).join('\n') : '- (none)');

      const res = await draftDashboard(invLines.join('\n'));
      if (!res.ok) {
        if (res.errorType === 'not_ready') return { ok: false, notReady: true };
        return { ok: false, error: res.message || 'Could not draft an analysis' };
      }

      const structure = (res.structure && typeof res.structure === 'object' ? res.structure : {}) as Record<string, unknown>;
      const name = typeof structure.name === 'string' && structure.name.trim() ? structure.name.trim() : 'AI analysis';
      const rawCards = Array.isArray(structure.cards) ? structure.cards : [];

      // Flow packer: metric 3×2, visual 6×6, text 12×2 — laid out left→right,
      // wrapping at GRID_COLS. Resolve every reference; drop anything unresolvable.
      const packed: unknown[] = [];
      let cx = 0;
      let cy = 0;
      let rowH = 0;
      const place = (w: number, h: number) => {
        if (cx + w > dashboards.GRID_COLS) { cx = 0; cy += rowH; rowH = 0; }
        const layout = { x: cx, y: cy, w, h };
        cx += w;
        if (h > rowH) rowH = h;
        return layout;
      };
      for (const raw of rawCards) {
        const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
        if (!c) continue;
        if (c.type === 'metric') {
          const ds = typeof c.dataset === 'string' ? dsByName.get(c.dataset) : undefined;
          if (!ds) continue;
          const column = typeof c.column === 'string' ? c.column : '';
          if (!ds.columns.some((col) => col.name === column)) continue; // column must exist
          const aggregation = typeof c.aggregation === 'string' && DRAFT_AGGS.has(c.aggregation) ? c.aggregation : 'sum';
          const label = typeof c.label === 'string' ? c.label : `${aggregation}(${column})`;
          packed.push({ type: 'metric', layout: place(3, 2), metric: { datasetId: ds.id, column, aggregation, label } });
        } else if (c.type === 'visual') {
          const visualId = typeof c.visual === 'string' ? vByName.get(c.visual) : undefined;
          if (!visualId) continue;
          packed.push({ type: 'visual', layout: place(6, 6), visualId });
        } else if (c.type === 'text') {
          const heading = typeof c.heading === 'string' ? c.heading : undefined;
          const text = typeof c.text === 'string' ? c.text : undefined;
          if (heading === undefined && text === undefined) continue;
          packed.push({ type: 'text', layout: place(12, 2), heading, text });
        }
      }

      // sanitizeCards drops anything still malformed; wrap into a single sheet.
      // A sheet IS a dashboards.Page, so this is the same sanitiser either way.
      const cards = dashboards.sanitizeCards(packed);
      const sheets = [{ name: 'Page 1', cards }];
      return { ok: true, name, sheets };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to draft an analysis' };
    }
  });
}
