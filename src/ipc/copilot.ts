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

// ── Activity stream (feat/ask-activity) ─────────────────────────────────────
// This app has NO agent loop and NO model tool-calls: copilot:ask computes facts
// (buildFacts, below) and makes ONE narration call (askCopilot). So the ONLY
// honest "activity" to surface is the discrete operations buildFacts actually
// performs — each step maps 1:1 to a function that ran THIS turn, with a
// truthful label and count. There are NO model-reasoning steps (there is no
// reasoning to report), and NO step ever carries a data VALUE dressed as a
// finding — counts of columns/rows/issues/metrics are facts; a value like
// "South = 4200" is not, and stays in the answer/provenance. `label`/`detail`
// are always app-authored, never model output. See buildFacts for the exact
// ordered set per kind; the whitelist here is what the renderer is allowed to
// render (textContent only).
export type ActivityKind = 'read' | 'compute' | 'quality' | 'model' | 'inventory';
export interface ActivityStep {
  kind: ActivityKind;
  label: string;
  detail?: string;
  count?: number;
}
export type ActivityEmit = (step: ActivityStep) => void;
const NO_ACTIVITY: ActivityEmit = () => { /* default — non-ask callers and the not_ready path emit nothing */ };

// Small English-plural helper so a count of 1 reads right ("1 column", not
// "1 columns"). App-authored strings only — nothing here is model output.
function plural(n: number, one: string, many = one + 's'): string {
  return n + ' ' + (n === 1 ? one : many);
}

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
export async function buildFacts(
  projectId: string,
  context: ContextRef,
  emit: ActivityEmit = NO_ACTIVITY,
): Promise<copilot.CopilotFacts> {
  const kind = context && typeof context.kind === 'string' ? context.kind : '';
  const id = context && typeof context.id === 'string' ? context.id : '';

  // Every emit() below fires ONLY after its operation actually ran and only on
  // the branch that ran it — so the chip set is a truthful record of this turn's
  // work, never a fixed script. `emit` defaults to a no-op, so the unit test
  // (scripts/test-copilot-analysis-facts.ts) and any non-ask caller see the
  // exact same behaviour as before, and the computed numbers are untouched.
  if (kind === 'dataset' && id) {
    const ds = await datasets.getDataset(projectId, id);
    if (ds) {
      emit({ kind: 'read', label: 'Read ' + ds.name, detail: plural(ds.rowCount, 'row') });
      const summaries = ds.columns.map((col, c) =>
        computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))),
      );
      emit({ kind: 'compute', label: 'Summarised ' + plural(ds.columns.length, 'column'), count: ds.columns.length });
      const issues = findQualityIssues(ds.columns, ds.rows);
      emit({ kind: 'quality', label: 'Checked data quality', detail: plural(issues.length, 'issue') + ' found', count: issues.length });
      return copilot.datasetFacts(ds, summaries, issues);
    }
  }

  if (kind === 'visual' && id) {
    const v = await visuals.getVisual(projectId, id);
    if (v) {
      emit({ kind: 'read', label: 'Read ' + v.name });
      const ds = await datasets.getDataset(projectId, v.datasetId);
      emit({ kind: 'read', label: 'Read ' + (ds ? ds.name : '(missing dataset)') });
      const viz = buildVizData(
        ds ? ds.columns : [],
        ds ? ds.rows : [],
        v.encoding,
        v.filters,
      );
      emit({ kind: 'compute', label: 'Built chart data' });
      return copilot.visualFacts(v, ds ? ds.name : '(missing dataset)', viz);
    }
  }

  if (kind === 'dashboard' && id) {
    const d = await dashboards.getDashboard(projectId, id);
    if (d) {
      emit({ kind: 'read', label: 'Read ' + d.name });
      const cards = await computeMetricCards(projectId, d.pages);
      emit({ kind: 'compute', label: 'Computed ' + plural(cards.length, 'metric'), count: cards.length });
      return copilot.dashboardFacts(d, cards);
    }
  }

  // An analysis is the mutable authoring surface a dashboard is published from.
  // `Analysis.sheets` IS `Dashboard.pages` (src/analysis.ts header), so the same
  // walk produces the same numbers — analysisFacts only labels them differently.
  if (kind === 'analysis' && id) {
    const a = await analysis.getAnalysis(projectId, id);
    if (a) {
      emit({ kind: 'read', label: 'Read ' + a.name });
      const cards = await computeMetricCards(projectId, a.sheets);
      emit({ kind: 'compute', label: 'Computed ' + plural(cards.length, 'metric'), count: cards.length });
      return copilot.analysisFacts(a, cards);
    }
  }

  // Fallback — project inventory (no per-entity figures available).
  const proj = await projects.getProject(projectId);
  const [dsList, vList, dashList] = await Promise.all([
    datasets.listDatasets(projectId),
    visuals.listVisuals(projectId),
    dashboards.listDashboards(projectId),
  ]);
  emit({
    kind: 'inventory',
    label: 'Scanned the project',
    detail: plural(dsList.length, 'dataset') + ', ' + plural(vList.length, 'visual') + ', ' + plural(dashList.length, 'dashboard'),
  });
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
  ipcMain.handle('copilot:ask', async (_e, { projectId, context, question, threadId, askId }: any = {}) => {
    try {
      const q = typeof question === 'string' ? question.trim() : '';
      if (!q) return { ok: false, error: 'Ask a question first.' };

      // Activity chips (feat/ask-activity): a fire-and-forget push of each real
      // operation to the window that asked. Wired ONLY when the renderer passed
      // an askId AND a model is actually configured — so with no model the ask
      // short-circuits to not_ready and the chips stay invisible, exactly as the
      // brief requires. askId scopes the stream so a stale ask's chips are
      // dropped and Ask/dock never cross. Every step is emitted from buildFacts
      // (real ops) plus the one 'model' step below that brackets the narration.
      const aid = typeof askId === 'string' && askId ? askId : '';
      const emit: ActivityEmit = aid && config.executionReady()
        ? (step) => { try { _e.sender.send('copilot:ask:activity', { askId: aid, step }); } catch (_) { /* window gone */ } }
        : NO_ACTIVITY;

      const tid = typeof threadId === 'string' && threadId ? threadId : undefined;
      const prior = (await copilot.loadHistory(projectId, tid)).map((t) => ({ role: t.role, text: t.text }));
      const facts = await buildFacts(projectId, context || {}, emit);
      // The single, real model call — the ONLY 'model' step, bracketing the one
      // narration this app makes. No agent loop, so there is nothing else to say.
      emit({ kind: 'model', label: 'Asked the model to narrate' });
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
