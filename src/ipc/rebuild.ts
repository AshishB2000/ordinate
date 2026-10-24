// Rebuild a dashboard from a screenshot (docs/rebuild-from-screenshot/).
//
//   rebuild:read    AI. An uploaded screenshot → the model reads its STRUCTURE
//                   (src/ai/rebuildRead.ts) → a sanitized reading. No figure,
//                   nothing stored. `notReady` with no model.
//   rebuild:match   NOT AI. A reading + the user's corrections → each tile
//                   matched to the dataset's columns (src/analysis/rebuildPlan.ts),
//                   the plan of the ready ones validated and previewed by the
//                   planner's own previewPlan, and each KPI's figure through
//                   computeCardMetric — the doors a built tile takes, so a Live
//                   dataset's figures come from its warehouse.
//
// Creating the dashboard is `analysis:buildPlan` with the plan this returns —
// the one door every plan takes. Nothing here creates a record.

import * as fs from 'fs';
import { ipcMain } from './bus';
import { resolveUpload, type Upload } from '../server/files';
import { MAX_IMAGE_BYTES, PNG_MAGIC } from '../app/captureUpload';
import { readDashboardImage, sanitizeReading, MAX_TILES } from '../ai/rebuildRead';
import { loadPlanContext } from '../analysis/analysisPlan';
import { previewPlan } from '../analysis/planPreview';
import { rebuild, type RebuiltTile, type TileOverride } from '../analysis/rebuildPlan';
import { computeCardMetric } from './dashboards';
import { isLiveFigureError, liveCodeOf } from './liveRoute';
import * as m from '../analysis/rebuildMessages';

const AGGS = new Set(['sum', 'avg', 'count', 'min', 'max']);
const FIELD_KEY = /^(?:category|split|filter|value[0-3])$/;

/** The check screen's corrections, re-read field by field — rebuildTile re-checks every value against the dataset. */
export function sanitizeOverrides(raw: unknown): TileOverride[] {
  const out: TileOverride[] = [];
  for (const o of Array.isArray(raw) ? raw.slice(0, MAX_TILES) : []) {
    if (!o || typeof o !== 'object' || !Number.isInteger(o.id)) continue;
    const ov: TileOverride = { id: o.id };
    if (typeof o.dropped === 'boolean') ov.dropped = o.dropped;
    if (typeof o.chartType === 'string') ov.chartType = o.chartType.slice(0, 40);
    if (typeof o.title === 'string') ov.title = o.title.slice(0, 80);
    if (o.fields && typeof o.fields === 'object') {
      ov.fields = {};
      for (const [key, f] of Object.entries(o.fields as Record<string, any>)) {
        if (!FIELD_KEY.test(key) || !f || typeof f !== 'object') continue;
        const column = typeof f.column === 'string' ? f.column.slice(0, 512) : null;
        ov.fields[key] = AGGS.has(f.aggregation) ? { column, aggregation: f.aggregation } : { column };
      }
    }
    out.push(ov);
  }
  return out;
}

type Figure = { value: number | null } | { value: null; error: string; code?: string };

/** One KPI's figure, by the same call its built tile makes. A Live refusal is said, never shown as a blank. */
async function figureOf(projectId: string, metric: { datasetId: string; column: string; aggregation: any }): Promise<Figure> {
  try {
    const r = await computeCardMetric(projectId, metric.datasetId, { column: metric.column, aggregation: metric.aggregation });
    return { value: r.ok ? r.value : null };
  } catch (err: any) {
    if (isLiveFigureError(err)) return { value: null, error: err.message, ...liveCodeOf(err) };
    throw err;
  }
}

export type MatchedTile = RebuiltTile & {
  /** A chart's preview, computed by the function that draws the built visual — or why there is none. */
  preview?: { data: unknown; note?: string };
  figure?: Figure;
};

/** rebuild:match's body. Exported so the self-check drives the real handler, not a copy. */
export async function matchReading(projectId: string, datasetId: string, rawReading: unknown, rawOverrides: unknown): Promise<any> {
  try {
    const ctx = await loadPlanContext(projectId, datasetId);
    const ds = ctx.datasets.find((d) => d.id === datasetId);
    if (!ds) return { ok: false, error: m.datasetGone() };
    const reading = sanitizeReading(rawReading);
    const { tiles, plan, order } = rebuild(reading, ds, ctx, sanitizeOverrides(rawOverrides));
    const preview = await previewPlan(projectId, plan, ctx);
    const sheet = preview.sheets[0];
    const kpis = order.kpi;
    const charts = order.chart;
    const out: MatchedTile[] = tiles.map((t) => ({ ...t }));
    const byId = new Map(out.map((t) => [t.id, t]));
    await Promise.all((sheet?.metrics ?? []).map(async (metric, i) => {
      const t = byId.get(kpis[i]);
      if (t) t.figure = await figureOf(projectId, metric);
    }));
    (sheet?.visuals ?? []).forEach((v, i) => {
      const t = byId.get(charts[i]);
      if (t) t.preview = { data: v.data, ...(v.note ? { note: v.note } : {}) };
    });
    const seen: Record<string, number> = {};
    const layout = (sheet?.layout ?? []).map((p) => {
      const n = (seen[p.kind] = (seen[p.kind] ?? -1) + 1);
      const ids = p.kind === 'metric' ? kpis : p.kind === 'visual' ? charts : order.text;
      return { ...p, tileId: ids[n] ?? null };
    });
    return {
      ok: true,
      name: preview.name,
      // The dropdowns' choices: names and DECLARED types, never a value.
      columns: ds.columns.map((c) => ({ name: c.name, type: c.type })),
      tiles: out,
      layout,
      controls: (sheet?.controls ?? []).length,
      dropped: preview.dropped,
      plan: preview.plan,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || m.unreadable(), ...liveCodeOf(err) };
  }
}

export function register(): void {
  ipcMain.handle('rebuild:read', async (_e, { fileToken }: any = {}) => {
    let upload: Upload | null = null;
    try {
      upload = await resolveUpload(fileToken);
      const stat = await fs.promises.stat(upload.path);
      if (stat.size > MAX_IMAGE_BYTES) return { ok: false, errorType: 'bad_image', message: m.tooLarge() };
      const buf = await fs.promises.readFile(upload.path);
      if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, errorType: 'bad_image', message: m.notPng() };
      const r = await readDashboardImage('data:image/png;base64,' + buf.toString('base64'));
      if (!r.ok) {
        if (r.errorType === 'not_ready') return { ok: false, notReady: true };
        return { ok: false, errorType: r.errorType, message: r.message || (r.errorType === 'bad_reply' ? m.modelUnreadable() : m.unreadable()), ...(r.detail ? { detail: r.detail } : {}) };
      }
      if (!r.reading.tiles.length) return { ok: false, errorType: 'no_tiles', message: m.noTiles() };
      return { ok: true, reading: r.reading };
    } catch {
      return { ok: false, errorType: 'unknown', message: m.unreadable() };
    } finally {
      upload?.done();
    }
  });

  ipcMain.handle('rebuild:match', async (_e, { projectId, datasetId, reading, overrides }: any = {}) =>
    matchReading(String(projectId), String(datasetId), reading, overrides));
}
