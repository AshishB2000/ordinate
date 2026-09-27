import { ipcMain } from 'electron';
import * as config from '../app/config';
import * as execConfig from '../app/execConfig';
import * as copilot from '../ai/copilot';
import * as projects from '../app/projects';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as dashboards from '../analysis/dashboards';
import * as analysis from '../analysis/analysis';
import { computeColumnSummary, findQualityIssues } from '../data/datasetStats';
import { buildVizData } from '../analysis/vizData';
import { withTableCalcs } from '../analysis/tableCalc';
import { computeMetric } from '../analysis/metricValue';
import { askCopilot } from '../ai/analyze';
import { auditNumbers } from '../ai/numberAudit';
import { listInsights } from './insights';
import * as metrics from '../analysis/metrics';
import { resolveMetric } from './metrics';
import { resolveChartOverlays } from './visualsAnalytics';
import * as scorecards from '../analysis/scorecards';
import { computeScorecard } from './scorecards';
import { scorecardFacts } from '../ai/scorecardFacts';
import * as drivers from './drivers';
import { driversFacts } from '../ai/driversFacts';
import type { FactMetric } from '../ai/copilotFacts';
import * as history from '../app/history';
import * as captureDataset from '../data/captureDataset';
import type { LedgerEntry, NumberAudit } from '../ai/numberAudit';
import * as answers from './answers';
// The catalog's column docs, with a sensitivity mark carried across a later
// rename — so a withheld column stays withheld under its new name.
import { assistantColumnDocs as catalogColumns } from '../app/sharePolicy';

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

type ContextRef = { kind?: string; id?: string; offset?: number };

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

// ── The number-fidelity guard ────────────────────────────────────────────────
//
// The app does the math; the model narrates figures the app already computed.
// `ai/numberAudit` checks that claim against the LEDGER buildFacts recorded, and
// this is where the answer meets the check.
//
// It does not block and it does not retry. A retry loop spends a second model
// call to hide the evidence, and blocking turns one bad figure into no answer at
// all — while the user, who is the person actually able to judge, is told
// nothing either way. So the finding is APPENDED TO THE ANSWER TEXT, before the
// turn is persisted: it then survives a reload, appears in the composer, the
// dock and the stored transcript with no renderer change, and cannot be styled
// away. The user sees it, which is the entire point.
const GUARD_NOTE = 'Contains a figure the app did not compute: ';

// Once per process, residentTrace-style: the failure this catches is systematic
// (a prompt that invites derived figures), so the thousandth line says nothing
// the first did not, and a flooded log is a log nobody reads.
let guardWarned = false;

// Exported for src/ipc/alerts.ts, the one other place a model narrates in this
// app (the "Explain alerts" conversation). The guard is a safety control, not a
// formatter — a second copy of it is a second thing that can silently stop
// running, so there is one.
export function guardAnswer(text: string, ledger: LedgerEntry[]): { text: string; audit: NumberAudit } {
  const audit = auditNumbers(text, ledger);
  if (audit.ok) return { text, audit };
  const tokens = audit.violations.map((v) => v.token).join(', ');
  if (!guardWarned) {
    guardWarned = true;
    // Tokens only, never the answer or the facts: this runs over user data.
    console.warn(
      `[numbers] the assistant stated ${plural(audit.violations.length, 'figure')} not in the app's ledger ` +
        `(${tokens}). The answer is shown with a note appended. Further occurrences this session are not logged.`,
    );
  }
  return { text: text + '\n\n' + GUARD_NOTE + tokens, audit };
}

/**
 * The project's DEFINED metrics, resolved.
 *
 * `datasetId` narrows to one dataset's metrics (the dataset branch); omitted,
 * every metric in the project (the dashboard branch, whose cards may span
 * several). Each figure comes back from the ordinary resolver, so it is the
 * same number the card shows, formatted the same way — and both go into the
 * facts ledger at the call site.
 *
 * Never throws: a project whose metrics cannot be read simply hands the model
 * no metric vocabulary, which is exactly the state every project was in before
 * this layer existed.
 */
async function factMetrics(projectId: string, datasetId?: string): Promise<FactMetric[]> {
  try {
    const list = await metrics.listMetrics(projectId);
    const out: FactMetric[] = [];
    for (const s of list) {
      if (datasetId && s.datasetId !== datasetId) continue;
      const r = await resolveMetric(projectId, s.id);
      if (!r) continue;
      out.push({ name: r.name, definitionText: r.definitionText, value: r.value, display: r.display, description: s.description });
    }
    return out;
  } catch (_) {
    return [];
  }
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
      // The same app-computed findings the Insights cards show — so the dock can
      // narrate "West fell 31%" from the app's figure rather than deriving one.
      const insights = await listInsights(projectId, id);
      emit({ kind: 'compute', label: 'Read ' + plural(insights.length, 'insight'), count: insights.length });
      const defined = await factMetrics(projectId, id);
      if (defined.length) {
        emit({ kind: 'compute', label: 'Resolved ' + plural(defined.length, 'metric'), count: defined.length });
      }
      const columnDocs = await catalogColumns(projectId, id); // the user's own column notes (catalog)
      return copilot.datasetFacts(ds, summaries, issues, insights, defined, columnDocs);
    }
  }

  if (kind === 'visual' && id) {
    const v = await visuals.getVisual(projectId, id);
    if (v) {
      emit({ kind: 'read', label: 'Read ' + v.name });
      const ds = await datasets.getDataset(projectId, v.datasetId);
      emit({ kind: 'read', label: 'Read ' + (ds ? ds.name : '(missing dataset)') });
      // The calculated figures the chart shows, beside the raw ones (tableCalc.ts).
      const viz = withTableCalcs({ ok: true, ...buildVizData(
        ds ? ds.columns : [],
        ds ? ds.rows : [],
        v.encoding,
        v.filters,
      ) }, v.encoding);
      emit({ kind: 'compute', label: 'Built chart data' });
      const columnDocs = await catalogColumns(projectId, v.datasetId); // the user's own column notes (catalog)
      // The visual's Analytics overlays, resolved under the visual's own filters.
      const overlays = v.analytics && v.analytics.length
        ? await resolveChartOverlays(projectId, viz.data, viz.category, v.analytics, v.filters) : [];
      if (overlays.length) emit({ kind: 'compute', label: 'Resolved ' + plural(overlays.length, 'overlay'), count: overlays.length });
      return copilot.visualFacts(v, ds ? ds.name : '(missing dataset)', viz, columnDocs, overlays);
    }
  }

  // A CAPTURE is a project record like any other, so a question asked from the
  // capture page is an ordinary dock ask scoped to it. The extraction is the
  // model's; every statistic below is the app's, computed here with the same
  // computeColumnSummary the dataset branch uses.
  if (kind === 'capture' && id) {
    const thread = await history.loadThread(id);
    const extracted = thread && thread.result ? thread.result.extractedTable : null;
    if (thread && extracted) {
      emit({ kind: 'read', label: 'Read ' + (thread.title || 'capture') });
      const draft = captureDataset.buildDraft(extracted);
      emit({ kind: 'read', label: 'Read the extracted table', detail: plural(draft.rows.length, 'row') });
      const summaries = draft.columns.map((col, c) =>
        computeColumnSummary(col, draft.rows.map((row) => (row ? row[c] ?? null : null))),
      );
      emit({ kind: 'compute', label: 'Summarised ' + plural(draft.columns.length, 'column'), count: draft.columns.length });
      return copilot.captureFacts(thread.title || 'Capture', draft.columns, summaries, draft.rows);
    }
  }

  // The analysis record IS the Dashboard the user sees (the authoring surface).
  // Its `sheets` are `Page[]`, so the metric walk is identical to any card grid.
  if (kind === 'analysis' && id) {
    const a = await analysis.getAnalysis(projectId, id);
    if (a) {
      emit({ kind: 'read', label: 'Read ' + a.name });
      // Tile NAMES (analysis.listAnalysisTiles) — the same read model the edit
      // validator resolves against, so the model can only name a tile the app
      // can then find. A real read (one Visual record per distinct chart), so it
      // is a real step; names and aggregations only, never a value.
      const tiles = await analysis.listAnalysisTiles(projectId, a);
      emit({ kind: 'read', label: 'Read ' + plural(tiles.length, 'tile'), count: tiles.length });
      const cards = await computeMetricCards(projectId, a.sheets);
      emit({ kind: 'compute', label: 'Computed ' + plural(cards.length, 'metric'), count: cards.length });
      const defined = await factMetrics(projectId);
      if (defined.length) {
        emit({ kind: 'compute', label: 'Resolved ' + plural(defined.length, 'metric'), count: defined.length });
      }
      return copilot.analysisFacts(a, cards, tiles, defined);
    }
  }

  // A "Why did this change?" panel: the question it answered, recomputed now
  // from the token it was asked under (ipc/drivers.ts), so the model narrates
  // the app's decomposition and never derives one (ai/driversFacts.ts).
  if (kind === 'drivers' && id) {
    const asked = drivers.recall(projectId, id);
    const res = asked ? await drivers.driversFor(projectId, asked.spec, asked.params) : null;
    if (res && res.ok) {
      emit({ kind: 'compute', label: 'Explained the change across ' + plural(res.dimensions.length, 'dimension'), count: res.dimensions.length });
      return driversFacts(res);
    }
  }

  // An open SCORECARD: every row's figures and status for the period on screen,
  // computed by the same call the page makes — so "what's off track?" is read
  // straight off the app's own verdicts (ai/scorecardFacts.ts).
  if (kind === 'scorecard' && id) {
    const sc = await scorecards.getScorecard(projectId, id);
    if (sc) {
      emit({ kind: 'read', label: 'Read ' + sc.name });
      const offset = typeof context.offset === 'number' && Number.isFinite(context.offset) ? context.offset : 0;
      const res = await computeScorecard(projectId, sc, offset);
      emit({ kind: 'compute', label: 'Scored ' + plural(res.rows.length, 'metric') + ' for ' + res.window.label, count: res.rows.length });
      return scorecardFacts({
        name: res.name, period: res.period, windowLabel: res.window.label, rows: res.rows, groups: res.groups,
      });
    }
  }

  // Fallback — project inventory (no per-entity figures available).
  const proj = await projects.getProject(projectId);
  const [dsList, vList, dashList] = await Promise.all([
    datasets.listDatasets(projectId),
    visuals.listVisuals(projectId),
    analysis.listAnalyses(projectId),
  ]);
  emit({
    kind: 'inventory',
    label: 'Scanned the project',
    detail: plural(dsList.length, 'dataset') + ', ' + plural(vList.length, 'visual') + ', ' + plural(dashList.length, 'dashboard'),
  });
  // Column names and types only — a metadata read, no rows — so a question
  // asked from Home can still come back as an answer chart.
  const metas = await Promise.all(dsList.slice(0, 12).map((d) => datasets.getDatasetMeta(projectId, d.id)));
  return copilot.projectFacts(proj ? proj.name : 'Untitled project', {
    datasets: dsList.map((x) => x.name),
    visuals: vList.map((x) => x.name),
    dashboards: dashList.map((x) => x.name),
  }, await Promise.all(metas.filter((m) => !!m).map(async (m) => ({
    name: m!.name, columns: m!.columns, docs: await catalogColumns(projectId, m!.id),
  }))));
}

export function register() {
  // Answer cards, "Explain" and the follow-up chips (./answers), handed the ONE
  // number guard rather than importing it back from here.
  answers.register(guardAnswer);

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
  //
  // Two additive side channels ride the ONE askId (see below). STREAMING
  // (feat/ask-streaming) forwards each narration token on `copilot:ask:chunk`;
  // ACTIVITY (feat/ask-activity) forwards each real operation on
  // `copilot:ask:activity`. Neither changes the handle contract: it still
  // resolves last with the FULL text + provenance + persisted turns, persistence
  // still saves BOTH turns only on success, a failed ask still leaves the thread
  // untouched, and errors travel through the handle only (never a side channel).
  // Provenance and every activity step are built from app-computed facts BELOW,
  // independent of the reply text — neither derives a chip or a number from a
  // token.
  ipcMain.handle('copilot:ask', async (event, { projectId, context, question, threadId, askId }: any = {}) => {
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
      // ACTIVITY chips: push each real operation to the window that asked. Wired
      // ONLY when an askId is present AND a model is configured — so with no model
      // the ask short-circuits to not_ready and the chips stay invisible. Scoped
      // by askId so a stale ask's chips are dropped and Ask/dock never cross.
      const emit: ActivityEmit = aid && execConfig.executionReady()
        ? (step) => { try { event.sender.send('copilot:ask:activity', { askId: aid, step }); } catch (_) { /* window gone */ } }
        : NO_ACTIVITY;
      // STREAMING deltas: only BYOK models actually stream (analyzeStream.ts);
      // with no model or a local CLI, onDelta never fires, so no chunk traffic and
      // the not_ready / error paths stay exactly as they were.
      const onDelta = aid
        ? (delta: string) => { try { event.sender.send('copilot:ask:chunk', { askId: aid, delta }); } catch (_) { /* window gone */ } }
        : undefined;

      const tid = typeof threadId === 'string' && threadId ? threadId : undefined;
      const prior = (await copilot.loadHistory(projectId, tid)).map((t) => ({ role: t.role, text: t.text }));
      const facts = await buildFacts(projectId, context || {}, emit);
      // The single, real model call — the ONLY 'model' step, bracketing the one
      // narration this app makes. No agent loop, so there is nothing else to say.
      emit({ kind: 'model', label: 'Asked the model to narrate' });
      const res = await askCopilot(prior, facts.text, q, onDelta);

      if (res.ok) {
        // Pin the target thread BEFORE the first append. Two reasons: the question
        // and its answer must land in the SAME conversation even if something else
        // creates a newer thread between the two writes, and the reply can then tell
        // the renderer which thread it wrote to (it may have been created just now).
        let target = tid || (await copilot.latestThreadId(projectId)) || undefined;
        if (!target) target = (await copilot.createThread(projectId))?.id;

        // An ANSWER action: the app builds the chart from the spec, and the turn's
        // prose becomes a SECOND, narrow narration of that chart's own facts,
        // audited against that chart's own ledger (./answers). A spec that does
        // not resolve keeps the prose answer and says plainly why no chart came.
        let answer: Awaited<ReturnType<typeof answers.answerFromAction>> | null = null;
        if (res.suggestedAction && res.suggestedAction.kind === 'answer') {
          emit({ kind: 'compute', label: 'Built the answer chart' });
          answer = await answers.answerFromAction(projectId, context || {}, res.suggestedAction, q, guardAnswer);
        }

        // The guard runs BEFORE persistence, so the stored turn carries the note
        // and a reloaded conversation shows it too. `answer` below is the guarded
        // text for the same reason — one string, seen everywhere.
        const guarded = answer && answer.ok
          ? { text: answer.text, audit: answer.audit }
          : guardAnswer(answer ? `${res.text}\n\n(No chart: ${answer.reason})` : res.text, facts.ledger);
        const built = answer && answer.ok ? answer : null;

        await copilot.appendTurn(projectId, { role: 'user', text: q }, target);
        const turns = await copilot.appendTurn(projectId, {
          role: 'assistant',
          text: guarded.text,
          provenance: built ? built.provenance : facts.provenance,
          answer: built ? built.spec : undefined,
        }, target);
        // `suggestedAction` is the model's STRUCTURED read of what the question
        // wanted (src/ai/suggestedAction.ts) — a whitelisted kind plus an intent
        // string, never a plan and never a figure. It is NOT persisted on the
        // turn: a proposal belongs to the turn that produced it and is rebuilt
        // from disk truth as prose only, which is the existing rule.
        return {
          ok: true, answer: guarded.text, provenance: facts.provenance,
          turns: turns || [], threadId: target || null,
          // An answer is fully handled here, so it proposes nothing further.
          suggestedAction: answer ? { kind: 'none', intent: '' } : res.suggestedAction || { kind: 'none', intent: '' },
          // App-side records, for tests and the fidelity gate. The renderer shows
          // neither: the ledger is internal, and the audit's finding is already
          // in `answer`. Nothing new reaches a user in this PR.
          ledger: built ? built.ledger : facts.ledger,
          numberAudit: guarded.audit,
        };
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
