import { ipcMain } from 'electron';
import * as config from '../config';
import * as copilot from '../copilot';
import * as projects from '../projects';
import * as datasets from '../datasets';
import * as visuals from '../visuals';
import * as dashboards from '../dashboards';
import { computeColumnSummary, findQualityIssues } from '../datasetStats';
import { buildVizData } from '../vizData';
import { computeMetric } from '../metricValue';
import { askCopilot } from '../analyze';

// Week 11 — persistent, context-aware AI Copilot IPC. All ipcMain.handle
// (request/response). Every handler is wrapped so a throw becomes { ok:false, error }
// — the renderer never sees an unhandled rejection. No deps object (pure disk +
// model path), matching datasets.register() / projects.register().
//
// The renderer NEVER computes a number: main resolves the referenced entity,
// computes every figure with the SAME pure helpers the rest of the app trusts
// (datasetStats / vizData / metricValue), embeds them as FACTS, replays the prior
// chat turns, and asks the model (through the EXISTING execution path) only to
// narrate. No model configured → { ok:false, notReady:true } for a gentle hint.

type ContextRef = { kind?: string; id?: string };

// Build the app-computed FACTS + provenance for a { kind, id } reference, reusing
// existing pure helpers. Falls back to a project inventory when nothing resolves.
async function buildFacts(projectId: string, context: ContextRef): Promise<copilot.CopilotFacts> {
  const kind = context && typeof context.kind === 'string' ? context.kind : '';
  const id = context && typeof context.id === 'string' ? context.id : '';

  if (kind === 'dataset' && id) {
    const ds = await datasets.getDataset(projectId, id);
    if (ds) {
      const summaries = ds.columns.map((col, c) =>
        computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))),
      );
      const issues = findQualityIssues(ds.columns, ds.rows);
      return copilot.datasetFacts(ds, summaries, issues);
    }
  }

  if (kind === 'visual' && id) {
    const v = await visuals.getVisual(projectId, id);
    if (v) {
      const ds = await datasets.getDataset(projectId, v.datasetId);
      const viz = buildVizData(
        ds ? ds.columns : [],
        ds ? ds.rows : [],
        v.encoding,
        v.filters,
      );
      return copilot.visualFacts(v, ds ? ds.name : '(missing dataset)', viz);
    }
  }

  if (kind === 'dashboard' && id) {
    const d = await dashboards.getDashboard(projectId, id);
    if (d) {
      // One app-computed number per metric card (metricValue.computeMetric). Cache
      // each referenced dataset so a dashboard of many cards over one dataset loads
      // it once.
      const dsCache = new Map<string, Awaited<ReturnType<typeof datasets.getDataset>>>();
      const computed: { label: string; value: number | null }[] = [];
      for (const page of d.pages || []) {
        for (const card of page.cards || []) {
          if (card.type !== 'metric' || !card.metric) continue;
          const m = card.metric;
          let ds = dsCache.get(m.datasetId);
          if (ds === undefined) {
            ds = await datasets.getDataset(projectId, m.datasetId);
            dsCache.set(m.datasetId, ds);
          }
          const value = ds ? computeMetric(ds.columns, ds.rows, { column: m.column, aggregation: m.aggregation }) : null;
          computed.push({ label: m.label || `${m.aggregation}(${m.column})`, value });
        }
      }
      return copilot.dashboardFacts(d, computed);
    }
  }

  // Fallback — project inventory (no per-entity figures available).
  const proj = await projects.getProject(projectId);
  const [dsList, vList, dashList] = await Promise.all([
    datasets.listDatasets(projectId),
    visuals.listVisuals(projectId),
    dashboards.listDashboards(projectId),
  ]);
  return copilot.projectFacts(proj ? proj.name : 'Untitled project', {
    datasets: dsList.map((x) => x.name),
    visuals: vList.map((x) => x.name),
    dashboards: dashList.map((x) => x.name),
  });
}

export function register() {
  // Load a project's chat history (survives reload).
  ipcMain.handle('copilot:history', async (_e, { projectId }: any = {}) => {
    try {
      return { ok: true, turns: await copilot.loadHistory(projectId) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to load Copilot history' };
    }
  });

  // Ask the Copilot a question about the active entity. Builds facts in main from
  // the referenced entity, replays prior turns, calls askCopilot, and persists BOTH
  // turns only on a successful reply (a failed ask leaves the thread unchanged, so
  // the composer can keep the user's text — no orphan question on disk).
  ipcMain.handle('copilot:ask', async (_e, { projectId, context, question }: any = {}) => {
    try {
      const q = typeof question === 'string' ? question.trim() : '';
      if (!q) return { ok: false, error: 'Ask a question first.' };

      const prior = (await copilot.loadHistory(projectId)).map((t) => ({ role: t.role, text: t.text }));
      const facts = await buildFacts(projectId, context || {});
      const res = await askCopilot(prior, facts.text, q);

      if (res.ok) {
        await copilot.appendTurn(projectId, { role: 'user', text: q });
        const turns = await copilot.appendTurn(projectId, {
          role: 'assistant',
          text: res.text,
          provenance: facts.provenance,
        });
        return { ok: true, answer: res.text, provenance: facts.provenance, turns: turns || [] };
      }
      if (res.errorType === 'not_ready') return { ok: false, notReady: true };
      return { ok: false, error: res.message || 'Could not answer the question' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to ask Copilot' };
    }
  });

  // Clear a project's chat history.
  ipcMain.handle('copilot:clear', async (_e, { projectId }: any = {}) => {
    try {
      return { ok: await copilot.clearHistory(projectId) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to clear Copilot history' };
    }
  });

  // Flip the hard ON/OFF switch (distinct from execution-readiness). Flows through
  // config.sanitize() — no dedicated setter. The renderer re-reads copilotEnabled
  // from key:status (publicConfig) after this resolves.
  ipcMain.handle('copilot:setEnabled', async (_e, { enabled }: any = {}) => {
    try {
      config.save({ copilotEnabled: !!enabled });
      return { ok: true, enabled: !!enabled };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update Copilot setting' };
    }
  });
}
