import { ipcMain } from 'electron';
import * as config from '../config';
import * as copilot from '../copilot';
import * as projects from '../projects';
import * as datasets from '../datasets';
import * as visuals from '../visuals';
import * as dashboards from '../dashboards';
import * as analysis from '../analysis';
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

// One app-computed number per metric card (metricValue.computeMetric) over a
// dashboard's pages OR an analysis's sheets — the same Page[] shape either way.
// Each referenced dataset is cached, so twelve cards over one dataset load it
// once. A missing dataset yields null for that card, never a throw.
async function computeMetricCards(
  projectId: string,
  pages: dashboards.Page[],
): Promise<{ label: string; value: number | null }[]> {
  const dsCache = new Map<string, Awaited<ReturnType<typeof datasets.getDataset>>>();
  const computed: { label: string; value: number | null }[] = [];
  for (const page of pages || []) {
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
  return computed;
}

// Build the app-computed FACTS + provenance for a { kind, id } reference, reusing
// existing pure helpers. Falls back to a project inventory when nothing resolves.
// Exported for scripts/test-copilot-analysis-facts.ts: the app-computed numbers
// are the whole contract here, and reaching them through copilot:ask would need a
// configured model (which returns not_ready before any facts surface).
export async function buildFacts(projectId: string, context: ContextRef): Promise<copilot.CopilotFacts> {
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
    if (d) return copilot.dashboardFacts(d, await computeMetricCards(projectId, d.pages));
  }

  // An analysis is the mutable authoring surface a dashboard is published from.
  // `Analysis.sheets` IS `Dashboard.pages` (src/analysis.ts header), so the same
  // walk produces the same numbers — analysisFacts only labels them differently.
  if (kind === 'analysis' && id) {
    const a = await analysis.getAnalysis(projectId, id);
    if (a) return copilot.analysisFacts(a, await computeMetricCards(projectId, a.sheets));
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
  // Load ONE conversation's turns (survives reload). threadId is optional — omit it
  // and main resolves the most recent thread, which is what the pre-threads
  // renderer does by simply not sending the field.
  ipcMain.handle('copilot:history', async (_e, { projectId, threadId }: any = {}) => {
    try {
      const tid = typeof threadId === 'string' && threadId ? threadId : undefined;
      const turns = await copilot.loadHistory(projectId, tid);
      // Which thread the turns actually CAME from: an absent or stale id resolves
      // to the most recent thread (listThreads is newest-touched first), so the
      // renderer learns what it is now looking at instead of guessing.
      const threads = await copilot.listThreads(projectId);
      const resolved = tid && threads.some((t) => t.id === tid) ? tid : (threads.length > 0 ? threads[0].id : null);
      return { ok: true, turns, threadId: resolved };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to load Copilot history' };
    }
  });

  // List a project's conversations for the thread sidebar — newest-touched first,
  // no turn bodies. Empty list is a normal answer (no history yet), never an error.
  ipcMain.handle('copilot:threads', async (_e, { projectId }: any = {}) => {
    try {
      return { ok: true, threads: await copilot.listThreads(projectId) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to list Copilot conversations' };
    }
  });

  // Start a new, empty conversation. Persisted immediately so copilot:ask can be
  // given its id straight away. Titled "Conversation" until its first user turn
  // renames it — no model call names a thread.
  ipcMain.handle('copilot:newThread', async (_e, { projectId }: any = {}) => {
    try {
      const thread = await copilot.createThread(projectId);
      if (!thread) return { ok: false, error: 'Could not start a new conversation' };
      return { ok: true, thread };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to start a new conversation' };
    }
  });

  // Ask the Copilot a question about the active entity. Builds facts in main from
  // the referenced entity, replays the prior turns OF THE TARGET THREAD, calls
  // askCopilot, and persists BOTH turns only on a successful reply (a failed ask
  // leaves the thread unchanged, so the composer can keep the user's text — no
  // orphan question on disk). threadId is optional: omit it for the most recent
  // conversation, which is the pre-threads renderer's behaviour unchanged.
  ipcMain.handle('copilot:ask', async (_e, { projectId, context, question, threadId }: any = {}) => {
    try {
      const q = typeof question === 'string' ? question.trim() : '';
      if (!q) return { ok: false, error: 'Ask a question first.' };

      const tid = typeof threadId === 'string' && threadId ? threadId : undefined;
      const prior = (await copilot.loadHistory(projectId, tid)).map((t) => ({ role: t.role, text: t.text }));
      const facts = await buildFacts(projectId, context || {});
      const res = await askCopilot(prior, facts.text, q);

      if (res.ok) {
        // Pin the target thread BEFORE the first append. Two reasons: the question
        // and its answer must land in the SAME conversation even if something else
        // creates a newer thread between the two writes, and the reply can then tell
        // the renderer which thread it wrote to (it may have been created just now).
        let target = tid || (await copilot.latestThreadId(projectId)) || undefined;
        if (!target) target = (await copilot.createThread(projectId))?.id;

        await copilot.appendTurn(projectId, { role: 'user', text: q }, target);
        const turns = await copilot.appendTurn(projectId, {
          role: 'assistant',
          text: res.text,
          provenance: facts.provenance,
        }, target);
        return { ok: true, answer: res.text, provenance: facts.provenance, turns: turns || [], threadId: target || null };
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
