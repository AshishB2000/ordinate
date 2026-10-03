import { dialog } from 'electron';
import * as appPaths from '../app/paths';
import { ipcMain } from './bus';
import { windowOf } from '../server/context';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import * as metrics from '../analysis/metrics';
import * as datasets from '../data/datasets';
import { loadPlanContext } from '../analysis/analysisPlan';
import { captureTemplate, mainDatasetId, type UserTemplate } from '../analysis/userTemplate';
import { planApply, bindIds, type ApplyPlan } from '../analysis/userTemplateApply';
import { fromTemplateFile, toTemplateFile } from '../analysis/userTemplateFile';
import type { RoleMapping } from '../analysis/templateRoles';
import * as store from '../app/userTemplateStore';
import { geoHitsFor, reasonFor } from './templates';

// USER TEMPLATES IPC (r7:templates) — "Save as template…" on any dashboard, and
// the gallery's "Yours" group. No model, no network: a template is a dashboard's
// structure with its columns replaced by roles.
//
//   utpl:capture  The roles a dashboard would become, for the Save dialog.
//   utpl:save     Re-capture IN MAIN and store it, with the author's role edits.
//                 The body never round-trips through the renderer.
//   utpl:rename / utpl:delete / utpl:export / utpl:import
//   utpl:preview  What a mapping would build — counts, drops, KPI tiles.
//   utpl:apply    Build it: calculated fields, metrics, visuals, then a NEW
//                 dashboard, each through its ordinary record API.

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

type Obj = Record<string, unknown>;

async function captureFor(projectId: string, analysisId: string) {
  const a = await analysis.getAnalysis(projectId, analysisId);
  if (!a) return { error: 'That dashboard could not be read.' };
  const ids = new Set<string>();
  for (const p of a.sheets) for (const c of p.cards) if (c.type === 'visual' && c.visualId) ids.add(c.visualId);
  const vis = (await Promise.all([...ids].map((id) => visuals.getVisual(projectId, id)))).filter((v): v is visuals.Visual => !!v);
  const dsId = mainDatasetId(a.sheets, (id) => vis.find((v) => v.id === id)?.datasetId);
  const meta = dsId ? await datasets.getDatasetMeta(projectId, dsId) : null;
  if (!meta) return { error: 'This dashboard has no tiles on a dataset yet — add one, then save it as a template.' };
  const ctx = await loadPlanContext(projectId, dsId);
  const ms = (await metrics.listMetrics(projectId)).filter((m) => m.datasetId === dsId);
  const full = (await Promise.all(ms.map((m) => metrics.getMetric(projectId, m.id)))).filter((m): m is metrics.Metric => !!m);
  const result = captureTemplate({
    analysis: a,
    visuals: vis,
    dataset: { id: dsId, columns: meta.columns, steps: meta.steps || [], summaries: ctx.datasets[0]?.summaries },
    metrics: full,
  });
  return { analysis: a, datasetName: meta.name, result };
}

/** The renderer's mapping, kept only where it names a role and a real column. */
async function planFor(projectId: string, datasetId: string, t: UserTemplate, mapping: unknown, name?: string): Promise<{ plan?: ApplyPlan; error?: string }> {
  const ctx = await loadPlanContext(projectId, datasetId);
  const ds = ctx.datasets[0];
  const meta = ds ? await datasets.getDatasetMeta(projectId, ds.id) : null;
  if (!ds || !meta) return { error: 'That dataset could not be read.' };
  const cols = new Set(ds.columns.map((c) => c.name));
  const raw = mapping && typeof mapping === 'object' ? (mapping as Obj) : {};
  const clean: RoleMapping = {};
  for (const r of t.roles) if (typeof raw[r.id] === 'string' && cols.has(raw[r.id] as string)) clean[r.id] = raw[r.id] as string;
  const missing = t.roles.filter((r) => r.required && !clean[r.id]).map((r) => r.label);
  if (missing.length) return { error: reasonFor(missing) + '.' };
  const geoHits = await geoHitsFor(projectId, ds);
  const geoLevels: Record<string, string> = {};
  for (const r of t.roles) if (clean[r.id] && geoHits[clean[r.id]]) geoLevels[r.id] = geoHits[clean[r.id]].level;
  const plan = planApply(t, clean, {
    datasetId: ds.id,
    columns: ds.columns,
    steps: meta.steps || [],
    metrics: await metrics.listMetrics(projectId),
    geoLevels,
  }, { name, newId: randomUUID });
  return { plan };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function register(): void {
  ipcMain.handle('utpl:capture', async (_e, a: Obj = {}) => {
    try {
      const c = await captureFor(str(a.projectId), str(a.analysisId));
      if (!c.result) return { ok: false, error: c.error };
      const r = c.result;
      return {
        ok: true, name: c.analysis.name, datasetName: c.datasetName, roles: r.roles, skipped: r.skipped, tiles: r.tiles,
        calcFields: r.body.calcFields.length, metrics: r.body.metrics.length, charts: r.body.visuals.length,
      };
    } catch (err: unknown) {
      return { ok: false, error: (err as Error)?.message || 'Could not read the dashboard.' };
    }
  });

  ipcMain.handle('utpl:save', async (_e, a: Obj = {}) => {
    try {
      const c = await captureFor(str(a.projectId), str(a.analysisId));
      if (!c.result) return { ok: false, error: c.error };
      const edits = new Map((Array.isArray(a.roles) ? a.roles : []).map((r: Obj) => [str(r && r.id), r || {}]));
      const roles = c.result.roles.map((r) => {
        const e = edits.get(r.id) || {};
        return {
          id: r.id, kind: r.kind,
          label: str(e.label).trim() || r.label,
          required: e.required === undefined ? r.required : e.required === true,
          hints: Array.isArray(e.hints) ? (e.hints as unknown[]).filter((h): h is string => typeof h === 'string') : r.hints,
        };
      });
      const saved = await store.saveTemplate({
        id: randomUUID(),
        name: str(a.name).trim() || c.analysis.name,
        description: str(a.description).trim(),
        createdAt: new Date().toISOString(),
        roles,
        body: c.result.body,
        thumbnail: str(a.thumbnail),
        sourceAnalysisId: c.analysis.id,
      });
      return saved ? { ok: true, id: saved.id, name: saved.name } : { ok: false, error: 'Could not save the template.' };
    } catch (err: unknown) {
      return { ok: false, error: (err as Error)?.message || 'Could not save the template.' };
    }
  });

  ipcMain.handle('utpl:rename', async (_e, a: Obj = {}) => {
    const t = await store.updateTemplate(a.id, { name: a.name, description: a.description });
    return t ? { ok: true, name: t.name } : { ok: false, error: 'That template could not be renamed.' };
  });

  ipcMain.handle('utpl:delete', async (_e, a: Obj = {}) => ({ ok: await store.deleteTemplate(a.id) }));

  ipcMain.handle('utpl:export', async (e, a: Obj = {}) => {
    const t = await store.getTemplate(a.id);
    if (!t) return { ok: false, error: 'That template could not be read.' };
    const safe = t.name.replace(/[^A-Za-z0-9 _.-]+/g, '').trim().slice(0, 80) || 'template';
    const win = windowOf(e);
    const opts = {
      title: 'Export template',
      defaultPath: path.join(appPaths.downloads(), safe + '.ordinate-template'),
      filters: [{ name: 'Ordinate template', extensions: ['ordinate-template'] }],
    };
    const { filePath, canceled } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      await fs.promises.writeFile(filePath, toTemplateFile(t), 'utf8');
      return { ok: true, dest: filePath };
    } catch (err: unknown) {
      return { ok: false, error: (err as Error)?.message || 'Could not write the file.' };
    }
  });

  ipcMain.handle('utpl:import', async (e) => {
    const win = windowOf(e);
    const opts = {
      title: 'Import template',
      properties: ['openFile' as const],
      filters: [{ name: 'Ordinate template', extensions: ['ordinate-template', 'json'] }],
    };
    const { filePaths, canceled } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const st = await fs.promises.stat(filePaths[0]);
      if (st.size > MAX_IMPORT_BYTES) return { ok: false, error: 'That file is too large to be a template.' };
      const res = fromTemplateFile(await fs.promises.readFile(filePaths[0], 'utf8'), randomUUID);
      if (!res.ok) return res;
      const existing = await store.getTemplate(res.template.id);
      if (existing) return { ok: true, id: existing.id, name: existing.name, existed: true };
      const saved = await store.saveTemplate(res.template);
      return saved ? { ok: true, id: saved.id, name: saved.name } : { ok: false, error: 'Could not store the template.' };
    } catch (err: unknown) {
      return { ok: false, error: (err as Error)?.message || 'Could not read that file.' };
    }
  });

  ipcMain.handle('utpl:preview', async (_e, a: Obj = {}) => {
    try {
      const t = await store.getTemplate(a.templateId);
      if (!t) return { ok: false, error: 'That template is gone.' };
      const { plan, error } = await planFor(str(a.projectId), str(a.datasetId), t, a.mapping);
      if (!plan) return { ok: false, error };
      return { ok: true, tiles: plan.tiles, total: plan.total, dropped: plan.dropped, kpis: plan.kpis };
    } catch (err: unknown) {
      return { ok: false, error: (err as Error)?.message || 'Could not plan the template.' };
    }
  });

  ipcMain.handle('utpl:apply', async (_e, a: Obj = {}) => {
    try {
      const projectId = str(a.projectId);
      const datasetId = str(a.datasetId);
      const t = await store.getTemplate(a.templateId);
      if (!t) return { ok: false, error: 'That template is gone.' };
      const { plan, error } = await planFor(projectId, datasetId, t, a.mapping, str(a.name).trim() || undefined);
      if (!plan) return { ok: false, error };
      if (plan.newSteps.length) {
        const meta = await datasets.getDatasetMeta(projectId, datasetId);
        await datasets.updateSteps(projectId, datasetId, [...((meta && meta.steps) || []), ...plan.newSteps]);
      }
      const ids = new Map<string, string>();
      for (const m of plan.metrics) {
        if (m.reuseId) { ids.set(m.ref, m.reuseId); continue; }
        const saved = await metrics.saveMetric(projectId, m.input as unknown as metrics.MetricInput);
        if (saved) ids.set(m.ref, saved.id);
      }
      for (const v of plan.visuals) {
        const saved = await visuals.saveVisual(projectId, bindIds(v.input, ids) as unknown as Parameters<typeof visuals.saveVisual>[1]);
        if (saved) ids.set(v.ref, saved.id);
      }
      const saved = await analysis.saveAnalysis(projectId, bindIds(plan.analysis, ids));
      if (!saved) return { ok: false, error: 'Could not create the dashboard.' };
      return { ok: true, analysis: saved, dropped: plan.dropped, calculatedFields: plan.newSteps.length };
    } catch (err: unknown) {
      return { ok: false, error: (err as Error)?.message || 'Could not apply the template.' };
    }
  });
}
