import { ipcMain } from './bus';
import { ctx, senderOf, serverDataDir } from '../server/context';
import * as onboarding from '../app/onboarding';
import { gateRows, hiddenColumnsFor } from '../data/rowAccess';
import { factsOf, tableWithout } from '../ai/hiddenFacts';
import * as config from '../app/config';
import * as execConfig from '../app/execConfig';
import { assistantOff } from '../ai/aiMessages';
import * as copilot from '../ai/copilot';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as analysis from '../analysis/analysis';
import { computeColumnSummary } from '../data/datasetStats';
import * as copilotTable from './copilotTable';
import type { VizDataResult } from '../analysis/vizData';
import { withTableCalcs } from '../analysis/tableCalc';
import { refuseNonAdditiveCalcs } from '../analysis/additivity';
import { followedEncoding } from '../analysis/metricMeasures';
import { followedMeasureTexts } from './copilotMeasures';
import { askCopilot } from '../ai/analyze';
import { auditNumbers, harvestAppNumbers } from '../ai/numberAudit';
import { listInsights } from './insights';
import { isSharePath, type SharePath } from '../app/privacyStore';
import { resolveChartOverlays } from './visualsAnalytics';
import * as scorecards from '../analysis/scorecards';
import * as metrics from '../analysis/metrics';
import { computeScorecard } from './scorecards';
import { scorecardFacts } from '../ai/scorecardFacts';
import * as drivers from './drivers';
import { driversFacts } from '../ai/driversFacts';
import * as scenarios from '../analysis/scenarios';
import { computeScenario } from '../analysis/scenarioResolve';
import { scenarioFacts } from '../ai/scenarioFacts';
import { statsPanelFacts, withStatsTiles } from './stats';
import * as history from '../app/history';
import * as captureDataset from '../data/captureDataset';
import type { LedgerEntry, NumberAudit } from '../ai/numberAudit';
import * as answers from './answers';
import { vizDataFor } from './visuals';
import { isLiveDatasetError } from '../data/liveDataset';
import { inDashboardCurrency, metricCardFigures, savedScope } from './copilotCards';
// The catalog's column docs, with a sensitivity mark carried across a later
// rename — so a withheld column stays withheld under its new name.
import { assistantColumnDocs as catalogColumns } from '../app/sharePolicy';
import { tableFacts } from '../app/tableDocs';
import { liveCopilotFacts } from './liveProfile';
import { logger } from '../app/logger';
import { isKeptStep } from '../data/filterList';
import { termFactsFor } from './terms';
import { askGuidance } from './guidance';
import { askDatasets, askTableFacts } from './askTableFacts';
import { askLinkedFacts } from './askLinks';
import { askValueFacts } from './askValues';
import { verifiedAsk, verifiedMatch, verifiedScope } from './verifiedAsk';
import { copyValueNotes } from './copyValues';
import { topicFacts } from '../ai/topicFacts';
import { allowedAction, NO_ACTION } from '../ai/suggestedAction';
import { agentNames, agentRef } from '../ai/agentAccess';
import { askScope, outsideTurn, PROJECT_SCOPE, scopedContext } from './agentAsk';
import { keepReads } from './askMemo';
import { snapshotFor, sqlSnapshotFor, turnsForBrowser } from './answerSnapshots';
import { sqlAnswer } from './answerSql';
import { openTitle, openTurns } from './turnsOpen';
import { indexFolders } from '../server/authz/folderGate';
import { homeFacts } from './homeFacts';
import { askSourceTables } from './sourceAnswers';

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

// `stats`: the open Statistics panel's analysis SPEC (never figures) — main
// recomputes it and hands the model the result as facts (src/ai/statsFacts.ts).
// `scoped`: the server's own (an Assistant agent's topic, ./agentAsk.ts); the contract has no such field.
type ContextRef = { kind?: string; id?: string; offset?: number; stats?: unknown; scoped?: boolean };

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
    logger.warn(
      `[numbers] the assistant stated ${plural(audit.violations.length, 'figure')} not in the app's ledger ` +
        `(${tokens}). The answer is shown with a note appended. Further occurrences this session are not logged.`,
    );
  }
  return { text: text + '\n\n' + GUARD_NOTE + tokens, audit };
}

/**
 * The digits of the app's OWN words in a refusal ("At most 8 filters."), for the
 * ledger that turn is audited against. Everything from the first quote to the
 * last is left out: a reason quotes the name it could not resolve, that name is
 * the model's, and harvesting it would let a model vouch for its own figure.
 */
function reasonLedger(reason: string): LedgerEntry[] {
  return harvestAppNumbers(reason.replace(/"[\s\S]*"/, '')).map((h) => ({ label: 'a limit the app states in a refusal', value: h.value, unit: h.unit, source: 'refusal' }));
}

import { factMetrics, questionMetrics } from './factMetrics';
export { factMetrics }; // for scripts/test-askDatasetFacts.ts

/** The datasets of the metrics a scorecard or scenario shows (read already by its figures: memo hits inside an ask). */
async function metricDatasets(projectId: string, ids: readonly string[]): Promise<string[]> {
  return (await Promise.all(ids.map((id) => metrics.getMetric(projectId, id)))).flatMap((m) => (m?.datasetId ? [m.datasetId] : []));
}

/** The conversation without what verified question `id` answered, its question and its card: "Not what I asked" sets them aside. */
function withoutAnswer(turns: copilot.CopilotTurn[], id: string | undefined): copilot.CopilotTurn[] {
  if (!id) return turns;
  return turns.filter((t, i) => t.guidance?.verifiedId !== id && !(t.role === 'user' && turns[i + 1]?.guidance?.verifiedId === id));
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
  question?: string, // vocabulary: a retired metric or term the question names stays in it (./statusNotes)
  share?: SharePath, // the facts leave by a share path (a report's narrative): figures the Share policy withholds there are withheld
): Promise<copilot.CopilotFacts> {
  const kind = context && typeof context.kind === 'string' ? context.kind : '';
  const id = context && typeof context.id === 'string' ? context.id : '';

  // Every emit() below fires ONLY after its operation actually ran and only on
  // the branch that ran it — so the chip set is a truthful record of this turn's
  // work, never a fixed script. `emit` defaults to a no-op, so the unit test
  // (scripts/test-copilot-analysis-facts.ts) and any non-ask caller see the
  // exact same behaviour as before, and the computed numbers are untouched.
  if (kind === 'topic' && id) { const f = await topicFacts(projectId, id, emit, context.scoped === true); if (f) return f; } // null (no such topic): the inventory below
  // Whole-dataset facts (column summaries, sample rows, insights, a Live sample): refused on a dataset with row access
  // rules (row-policy D9); with a column hidden from the caller, built without it (part 4, D21: ../ai/hiddenFacts).
  const datasetFacts = kind === 'dataset' && id ? await factsOf(projectId, id, async (hidden) => {
    // A Live dataset keeps no rows: its columns, its sampled profile and — unless
    // withheld — its sample values (L2.5), with its defined metrics' figures from
    // the warehouse (L2.4). One source: ai/liveFacts.
    const live = await liveCopilotFacts(projectId, id, () => factMetrics(projectId, new Set([id]), undefined, question), () => termFactsFor(projectId, id, question));
    if (live) {
      emit({ kind: 'read', label: 'Read the schema of ' + live.name });
      if (live.metrics) emit({ kind: 'compute', label: 'Resolved ' + plural(live.metrics, 'metric'), count: live.metrics });
      return live.facts;
    }
    // Its summaries, quality issues and first rows off the stored Parquet; the table is loaded only when that fails (./copilotTable).
    const table = (await copilotTable.residentTable(projectId, id, hidden)) ?? (await copilotTable.hydratedTable(projectId, id, hidden));
    if (table) {
      const { ds, summaries, issues } = table;
      emit({ kind: 'read', label: 'Read ' + ds.name, detail: plural(ds.rowCount, 'row') });
      emit({ kind: 'compute', label: 'Summarised ' + plural(ds.columns.length, 'column'), count: ds.columns.length });
      emit({ kind: 'quality', label: 'Checked data quality', detail: plural(issues.length, 'issue') + ' found', count: issues.length });
      // The same app-computed findings the Insights cards show — so the dock can
      // narrate "West fell 31%" from the app's figure rather than deriving one. Computed over every column: none with one hidden.
      const insights = hidden.size ? [] : await listInsights(projectId, id);
      emit({ kind: 'compute', label: 'Read ' + plural(insights.length, 'insight'), count: insights.length });
      const defined = await factMetrics(projectId, new Set([id]), undefined, question);
      if (defined.length) {
        emit({ kind: 'compute', label: 'Resolved ' + plural(defined.length, 'metric'), count: defined.length });
      }
      const columnDocs = await catalogColumns(projectId, id); // the user's own column notes (catalog)
      const valueNotes = await copyValueNotes(projectId, id, 'facts'); // its common text values, off the value index (no hydration)
      return copilot.datasetFacts(ds, summaries, issues, insights, defined, columnDocs, tableWithout(await tableFacts(projectId, id), hidden), await termFactsFor(projectId, id, question), valueNotes); // its glossary terms beside its metrics
    }
    return null;
  }) : null;
  if (datasetFacts) return datasetFacts;

  if (kind === 'visual' && id) {
    const v = await visuals.getVisual(projectId, id);
    if (v) {
      emit({ kind: 'read', label: 'Read ' + v.name });
      const ds = await datasets.getDatasetMeta(projectId, v.datasetId);
      emit({ kind: 'read', label: 'Read ' + (ds ? ds.name : '(missing dataset)') });
      // The chart's figures through THE chart door (vizDataFor) — the same numbers
      // the tile draws, a Live dataset's from its warehouse (L2.4) — with the
      // calculated figures beside the raw ones (tableCalc.ts). No figure → none.
      const drawn = await followedEncoding(projectId, v.datasetId, v.encoding); // each metric measure as it is defined NOW: what the tile draws
      const reply = await vizDataFor(projectId, v.datasetId, drawn, v.filters);
      const raw: { ok: true } & VizDataResult = reply.ok
        ? { ok: true, data: reply.data, recommendedShape: reply.recommendedShape, warnings: reply.warnings, category: reply.category }
        : { ok: true, data: { labels: [], series: [] }, recommendedShape: 'categorical', warnings: [] };
      // A calculation that was refused (additivity.ts) is never read: the Assistant gets the raw figures.
      const viz = (await refuseNonAdditiveCalcs(reply, projectId, v.datasetId, drawn)).ok ? withTableCalcs(raw, drawn) : raw;
      emit({ kind: 'compute', label: 'Built chart data' });
      const columnDocs = await catalogColumns(projectId, v.datasetId); // the user's own column notes (catalog)
      // The visual's Analytics overlays, resolved under the visual's own filters.
      const overlays = v.analytics && v.analytics.length
        ? await resolveChartOverlays(projectId, viz.data, viz.category, v.analytics, v.filters) : [];
      if (overlays.length) emit({ kind: 'compute', label: 'Resolved ' + plural(overlays.length, 'overlay'), count: overlays.length });
      // A category or series drawn from a related dataset is marked in THAT dataset's catalog (NV-32).
      const relatedDocs: Record<string, Awaited<ReturnType<typeof catalogColumns>>> = {};
      for (const rid of [v.encoding.categoryDatasetId, v.encoding.seriesDatasetId]) {
        if (rid && rid !== v.datasetId && !relatedDocs[rid]) relatedDocs[rid] = await catalogColumns(projectId, rid);
      }
      return copilot.visualFacts({ ...v, encoding: drawn }, ds ? ds.name : '(missing dataset)', viz, columnDocs, overlays, relatedDocs, tableWithout(await tableFacts(projectId, v.datasetId), await hiddenColumnsFor(projectId, v.datasetId)), await followedMeasureTexts(projectId, v.datasetId, drawn, columnDocs));
    }
  }

  // A CAPTURE is a project record like any other, so a question asked from the
  // capture page is an ordinary dock ask scoped to it. The extraction is the
  // model's; every statistic below is the app's, computed here with the same
  // computeColumnSummary the dataset branch uses.
  if (kind === 'capture' && id) {
    const thread = await history.loadThread(id);
    const extracted = thread && thread.result ? thread.result.extractedTable : null;
    // Only a capture OF THIS PROJECT: the history store is org-wide, and a
    // caller cleared for this project must not read another's by id.
    if (thread && extracted && thread.projectId === projectId) {
      if (thread.datasetId) await gateRows(projectId, String(thread.datasetId)); // the stored table IS that dataset's rows (row-policy D9)
      emit({ kind: 'read', label: 'Read ' + (thread.title || 'capture') });
      const draft = captureDataset.buildDraft(extracted);
      emit({ kind: 'read', label: 'Read the extracted table', detail: plural(draft.rows.length, 'row') });
      const summaries = draft.columns.map((col, c) =>
        computeColumnSummary(col, draft.rows.map((row) => (row ? row[c] ?? null : null))),
      );
      emit({ kind: 'compute', label: 'Summarised ' + plural(draft.columns.length, 'column'), count: draft.columns.length });
      return { ...copilot.captureFacts(thread.title || 'Capture', draft.columns, summaries, draft.rows), ...(thread.datasetId ? { datasetIds: [String(thread.datasetId)] } : {}) };
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
      // Every figure as the dashboard shows it: under its saved filters and parameters (./copilotCards), each
      // KPI through its tile's doors, a defined metric as a card of it would read here — one number per name.
      const scope = savedScope(a);
      // …and in the dashboard's own currency, as the page asks every tile.
      // Its tiles' datasets' metrics, not the project's, and the few step 3 finds for the question elsewhere (Q12), each
      // under the same saved filters; those are their own call, so one that fails costs only them.
      const own = new Set(tiles.flatMap((t) => (t.datasetId ? [t.datasetId] : [])));
      const { cards, defined } = await inDashboardCurrency(projectId, a.id, async () => ({
        cards: await metricCardFigures(projectId, a, scope, share),
        defined: [
          ...await factMetrics(projectId, own, scope, question, share),
          ...await factMetrics(projectId, new Set(), scope, question, share, await questionMetrics(projectId, question, own)),
        ],
      }));
      emit({ kind: 'compute', label: 'Computed ' + plural(cards.length, 'metric'), count: cards.length });
      if (defined.length) {
        emit({ kind: 'compute', label: 'Resolved ' + plural(defined.length, 'metric'), count: defined.length });
      }
      // Statistics tiles (src/ipc/stats.ts): their results, recomputed under the same filters, as facts.
      const filteredBy = [...new Set(scope.filters.flatMap((f) => (isKeptStep(f) ? [] : [f.column])))];
      return withStatsTiles(projectId, a.sheets, { ...copilot.analysisFacts(a, cards, tiles, defined, filteredBy), datasetIds: [...own] }, scope.filters);
    }
  }

  // The open STATISTICS panel: its analysis, recomputed from the spec the dock
  // sent, as the app's own figures and sentences (ai/statsFacts.ts).
  if (kind === 'stats' && context.stats) {
    const facts = await statsPanelFacts(projectId, context.stats);
    if (facts) {
      emit({ kind: 'compute', label: 'Ran the statistics on ' + facts.provenance.name });
      return facts;
    }
  }

  // A "Why did this change?" panel: the question it answered, recomputed now
  // from the token it was asked under (ipc/drivers.ts), so the model narrates
  // the app's decomposition and never derives one (ai/driversFacts.ts).
  if (kind === 'drivers' && id) {
    const asked = await drivers.recall(projectId, id);
    const res = asked ? await drivers.driversFor(projectId, asked.spec, asked.params) : null;
    if (asked && res && res.ok) {
      emit({ kind: 'compute', label: 'Explained the change across ' + plural(res.dimensions.length, 'dimension'), count: res.dimensions.length });
      return { ...driversFacts(res), datasetIds: [asked.spec.datasetId] };
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
      const shown = sc.rows.flatMap((r) => [r.metricId, ...(r.target && typeof r.target === 'object' ? [r.target.metricId] : [])]);
      return {
        ...scorecardFacts({ name: res.name, period: res.period, windowLabel: res.window.label, rows: res.rows, groups: res.groups }),
        datasetIds: await metricDatasets(projectId, shown),
      };
    }
  }

  // An open SCENARIO: baseline and scenario figures, the drivers in words and the
  // tornado, computed by the same call the page makes (ai/scenarioFacts.ts).
  if (kind === 'scenario' && id) {
    const sc = await scenarios.getScenario(projectId, id);
    if (sc) {
      emit({ kind: 'read', label: 'Read ' + sc.name });
      // Scenarios are off for a Live dataset (L2.6) and its page says so: no scenario figure here either, and the
      // question is still answered — from the project, below — rather than every one refused while this page is open.
      const res = await computeScenario(projectId, sc).catch((err: unknown) => {
        if (isLiveDatasetError(err)) return null;
        throw err;
      });
      if (res) {
        emit({ kind: 'compute', label: 'Recomputed ' + plural(res.metrics.length, 'metric') + ' under ' + plural(res.drivers.length, 'driver'), count: res.metrics.length });
        return { ...scenarioFacts(res), datasetIds: await metricDatasets(projectId, sc.baseMetricIds) };
      }
    }
  }

  // Fallback — Home: the project's counts and what step 3 finds for the question (./homeFacts), no per-entity figures.
  return homeFacts(projectId, question ?? '', emit);
}

export function register() {
  // Answer cards, "Explain" and the follow-up chips (./answers), handed the ONE
  // number guard rather than importing it back from here.
  answers.register(guardAnswer);

  // Load ONE conversation's turns (survives reload). threadId is optional — omit it
  // and main resolves the most recent thread, which is what the pre-threads
  // renderer does by simply not sending the field. Each answer comes with the card
  // it kept, while the caller's access is what it was computed under (./answerSnapshots):
  // reopening runs no figure query.
  ipcMain.handle('copilot:history', keepReads(async (_e, { projectId, threadId }: any = {}) => {
    try {
      const tid = typeof threadId === 'string' && threadId ? threadId : undefined;
      const stored = await copilot.loadHistory(projectId, tid);
      const turns = await turnsForBrowser(projectId, stored); // without the answers on a dataset in a folder the caller cannot open (./turnsOpen)
      // Every turn hidden: as for no conversation, as the list leaves it out (../ai/copilotRows listPage).
      if (stored.length && !turns.length) return { ok: true, turns, threadId: null, title: null, agent: null };
      // Which thread the turns actually CAME from: an absent or stale id resolves
      // to the most recent thread, so the renderer learns what it is now looking
      // at instead of guessing. Its title too: a renamed conversation's name is
      // the stored one, which the turns alone cannot tell the header. One lookup,
      // never the list: the list is paged.
      const shown = await copilot.threadFor(projectId, tid);
      // …and the Assistant agent it is with (null: the Project assistant), by name even once it is in the Trash.
      return { ok: true, turns, threadId: shown?.id ?? null, title: shown ? await openTitle(projectId, shown.title, stored.slice(0, 2)) : null, agent: await agentRef(projectId, shown?.agentId ?? null) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to load Copilot history' };
    }
  }));

  // List a project's conversations for the thread sidebar — newest-touched first,
  // no turn bodies, one page at a time: `next` is the cursor of the page after
  // (null: the last). Empty list is a normal answer (no history yet), never an error.
  ipcMain.handle('copilot:threads', async (_e, { projectId, cursor }: any = {}) => {
    try {
      // Shared folders: each count and title is of the turns the caller is shown (./turnsOpen), in the page's one query.
      const page = await copilot.listThreadsPage(projectId, typeof cursor === 'string' ? cursor : undefined, (await indexFolders(projectId))?.open ?? null);
      const names = await agentNames(projectId, page.threads.flatMap((t) => (t.agentId ? [t.agentId] : [])));
      // Which agent each was with, for History, by name; one deleted (in the Trash, or gone from it) is marked so.
      const named = (t: copilot.CopilotThreadSummary) => {
        const n = t.agentId ? names.get(t.agentId) : undefined;
        return t.agentId ? { ...t, ...(n ? { agentName: n.name } : {}), ...(!n || n.gone ? { agentGone: true } : {}) } : t;
      };
      return { ok: true, threads: page.threads.map(named), next: page.next };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to list Copilot conversations' };
    }
  });

  // Start a new, empty conversation. Persisted immediately so copilot:ask can be
  // given its id straight away. Titled "Conversation" until its first user turn
  // renames it — no model call names a thread.
  // `agentId`: the Assistant agent it is with (switching agents starts one); one the caller may not use is refused.
  ipcMain.handle('copilot:newThread', async (_e, { projectId, agentId }: any = {}) => {
    try {
      const scope = agentId ? await askScope(projectId, agentId) : PROJECT_SCOPE;
      if (agentId && !scope.agent) return { ok: false, error: scope.note || 'Could not start a new conversation' };
      const thread = await copilot.createThread(projectId, scope.agent?.id);
      if (!thread) return { ok: false, error: 'Could not start a new conversation' };
      return { ok: true, thread };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to start a new conversation' };
    }
  });

  // Rename or delete ONE of the caller's own conversations. One `ok: false`
  // sentence covers every way there was nothing to act on — an unknown id, another
  // member's thread — so neither tells a caller what exists beyond their own list.
  ipcMain.handle('copilot:renameThread', async (_e, { projectId, threadId, title }: any = {}) => {
    try {
      const thread = await copilot.renameThread(projectId, threadId, title);
      return thread ? { ok: true, thread } : { ok: false, error: 'That conversation is no longer there' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to rename the conversation' };
    }
  });
  ipcMain.handle('copilot:deleteThread', async (_e, { projectId, threadId }: any = {}) => {
    try {
      return (await copilot.deleteThread(projectId, threadId)) ? { ok: true } : { ok: false, error: 'That conversation is no longer there' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to delete the conversation' };
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
  // Its reads are kept for the length of the question (./askMemo): every list and the catalog once, not four to sixty times.
  ipcMain.handle('copilot:ask', keepReads(async (event, { projectId, context, question, threadId, askId, share, agentId, skipVerified }: any = {}) => {
    try {
      const q = typeof question === 'string' ? question.trim() : '';
      if (!q) return { ok: false, error: 'Ask a question first.' };
      // Asking the Assistant anything ticks its Get-started stop for the person asking.
      if (serverDataDir() !== null) onboarding.visit(ctx().user.email, 'assistant');

      // Activity chips (feat/ask-activity): a fire-and-forget push of each real
      // operation to the window that asked. Wired ONLY when the renderer passed
      // an askId AND a model is actually configured — so with no model the ask
      // short-circuits to not_ready and the chips stay invisible, exactly as the
      // brief requires. askId scopes the stream so a stale ask's chips are
      // dropped and Ask/dock never cross. Every step is emitted from buildFacts
      // (real ops) plus the one 'model' step below that brackets the narration.
      const aid = typeof askId === 'string' && askId ? askId : '';
      const client = senderOf(event);
      // ACTIVITY chips: push each real operation to the window that asked. Wired
      // ONLY when an askId is present AND a model is configured — so with no model
      // the ask short-circuits to not_ready and the chips stay invisible. Scoped
      // by askId so a stale ask's chips are dropped and Ask/dock never cross.
      const emit: ActivityEmit = aid && (await execConfig.executionReady())
        ? (step) => { try { client.send('copilot:ask:activity', { askId: aid, step }); } catch (_) { /* window gone */ } }
        : NO_ACTIVITY;
      // STREAMING deltas: only BYOK models actually stream (analyzeStream.ts);
      // with no model or a local CLI, onDelta never fires, so no chunk traffic and
      // the not_ready / error paths stay exactly as they were.
      const onDelta = aid
        ? (delta: string) => { try { client.send('copilot:ask:chunk', { askId: aid, delta }); } catch (_) { /* window gone */ } }
        : undefined;

      const tid = typeof threadId === 'string' && threadId ? threadId : undefined;
      // `share`: only a server caller names one (a report's narrative, ./reportsServer): the contract has no such field. Its
      // answer leaves the app, so only the facts shaped for that path go with it: no thread, no verified or suggested chart.
      const sharing = isSharePath(share) && share !== 'bundle' ? share : undefined;
      // The conversation this lands in decides who answers (docs/assistant-agents rule 11): the one named, else the
      // caller's latest; with none yet, the one this ask starts, with the agent asked for (./agentAsk.ts decides).
      const into = await copilot.threadFor(projectId, tid); // the one named when it is the caller's, else their latest (one lookup: the list is paged)
      const named = !!tid && into?.id === tid;
      const scope = sharing ? PROJECT_SCOPE : await askScope(projectId, into ? into.agentId : agentId);
      // The agent the conversation is stored with, as the reply names it: none for a token or a share, which keep the Project assistant (rule 13).
      const kept = scope === PROJECT_SCOPE ? null : into ? (into.agentId ?? null) : (scope.agent?.id ?? null);
      // Pinned BEFORE the first append, so a question and its answer land in the SAME conversation — the one whose agent
      // answered — even if something else creates a newer one between the two writes, and the reply can say which it was.
      const pin = async (): Promise<string | undefined> => (named ? tid : into?.id) ?? (await copilot.createThread(projectId, scope.agent?.id))?.id;
      const asked = await scopedContext(projectId, scope, context || {}); // an agent's topic, unless the screen is inside it
      // A verified question, word for word, on what is open, inside the agent's topic (./verifiedAsk): no model call.
      // "Not what I asked" on such an answer (`skipVerified`) sends the question to the model instead, without that
      // verified question as an example and without the answer it gave as the chart a follow-up continues.
      const only = sharing ? null : await verifiedScope(projectId, asked, scope.only);
      const passed = skipVerified === true && !sharing ? await verifiedMatch(projectId, q, only) : null;
      const hit = sharing || skipVerified === true ? null : await verifiedAsk(projectId, q, pin, { ...scope, only });
      if (hit) return { ...hit, agent: await agentRef(projectId, kept) };
      if (!execConfig.assistantOn()) return { ok: false, notReady: true, error: assistantOff() };
      const turns = withoutAnswer(await openTurns(projectId, await copilot.loadHistory(projectId, tid)), passed?.id); // replayed: never an answer on a closed folder's dataset
      const prior = sharing ? [] : turns.map((t) => ({ role: t.role, text: t.text }));
      const facts = await buildFacts(projectId, asked, emit, q, sharing);
      const agent = scope.agent ? { name: scope.agent.name, instructions: scope.agent.instructions.map((i) => i.text), datasets: scope.only } : undefined;
      // What the facts are about, the datasets linked to it (./askLinks; none for an agent, which answers from its topic
      // alone) and the Live ones' source table facts (./askTableFacts); none on a share path, whose words leave the app.
      const about = sharing ? [] : await askDatasets(projectId, asked, facts.provenance.kind, q);
      const linked = scope.only ? { text: '', ledger: [], metas: [] } : await askLinkedFacts(projectId, about);
      const values = await askValueFacts(projectId, about, linked.metas, q); // the values its words name, under the caller's row lock (./askValues)
      const tables = sharing ? { text: '', ledger: [] } : await askTableFacts(projectId, about, linked.metas);
      const sources = sharing || scope.only ? { text: '', ledger: [] } : await askSourceTables(projectId, asked, q); // an editor's Home question: tables no dataset is made from (./sourceAnswers)
      const guided = await askGuidance(projectId, asked, facts.provenance.kind, q, { ...(agent ? { agent } : {}), ...(passed ? { exclude: passed.id } : {}) }); // the editors' instructions and guide (./guidance), after the facts
      // The chart a follow-up continues (./answers `previousAnswer`): the model is
      // told what it is by NAME, beside the facts, and the app merges what changes.
      // The block's own digits (a top-N, a filter value) join this turn's ledger.
      // Only for an ask that NAMES its conversation, and finds it: one that names
      // none (a report's narrative page, ./reportsServer) still has the caller's
      // latest replayed, but nobody is looking at that chart and nothing continues it.
      const prev = named ? await answers.previousAnswer(projectId, turns) : null;
      const ledger = facts.ledger.concat(linked.ledger, values.ledger, tables.ledger, sources.ledger, guided.ledger, prev ? prev.ledger : []);
      // The datasets those facts came from, kept on the answer: its words, a prose one's too, leave history with them (./turnsOpen).
      const factsFrom = [...about, ...linked.metas].map((m) => m.id).concat(facts.datasetIds ?? [], prev ? [prev.spec.datasetId] : []);
      // The real model call — a 'model' step, bracketing the one narration this app
      // makes. No agent loop; only an SQL answer (below) makes a second call, which writes SQL.
      emit({ kind: 'model', label: 'Asked the model to narrate' });
      const how = { build: scope.agent ? scope.agent.build : true, topic: scope.only !== null };
      const res = await askCopilot(prior, [facts.text, linked.text, values.text, tables.text, sources.text, guided.text, prev?.block].filter(Boolean).join('\n\n'), q, onDelta, { ...how, model: scope.agent?.model });

      if (res.ok) {
        // What the reply may act on: an agent that may not build answers or does nothing (rule 8).
        const action = allowedAction(res.suggestedAction || NO_ACTION, how);
        // OUT OF SCOPE (rule 10): never an answer from outside the agent's topic, quietly or not. The turn is the
        // app's own words and the dataset the Project assistant can answer from, found by code (./agentAsk.ts).
        const outside = sharing ? null : await outsideTurn(projectId, scope, q, action);
        const target = await pin(); // after the out-of-scope lookup, so one that fails leaves no new conversation behind
        if (outside) {
          await copilot.appendTurn(projectId, { role: 'user', text: q }, target);
          const stored = await copilot.appendTurn(projectId, { role: 'assistant', text: outside.text, outside: outside.outside, guidance: guided.used }, target);
          return {
            ok: true, answer: outside.text, provenance: facts.provenance, turns: await turnsForBrowser(projectId, stored || []), threadId: target || null, suggestedAction: NO_ACTION,
            ledger, numberAudit: { ok: true, violations: [] }, guidance: guided.used, agent: await agentRef(projectId, kept),
          };
        }

        // An ANSWER action: the app builds the chart from the spec, and the turn's
        // prose stays this call's one sentence (no second model call), audited
        // against the facts AND that chart's own ledger, so a figure the model
        // wrote anyway is still flagged (./answers). A spec that does not
        // resolve keeps the prose answer and says plainly why no chart came.
        let answer: Awaited<ReturnType<typeof answers.answerFromAction>> | Awaited<ReturnType<typeof sqlAnswer>> | null = null;
        if (!sharing && action.kind === 'answer') {
          emit({ kind: 'compute', label: 'Built the answer chart' });
          answer = await answers.answerFromAction(projectId, asked, action, q, prev?.spec, prev?.withheld, scope.only ?? undefined);
        }
        // The form cannot say it (outcome F, ./answerSql): a SECOND call writes one statement over the picked datasets'
        // full details, and the Query tab's gate runs it. Its figures are DuckDB's; the turn's words stay this call's sentence.
        if (!sharing && action.kind === 'sql') {
          emit({ kind: 'model', label: 'Asked the model to write SQL' });
          answer = await sqlAnswer(projectId, action, q, scope.only ?? undefined, scope.agent?.model, asked); // an editor's Home question may name its source tables
          if (answer.ok) emit({ kind: 'compute', label: 'Ran the SQL through the Query tab\'s checks' });
        }

        // The guard runs BEFORE persistence, so the stored turn carries the note
        // and a reloaded conversation shows it too. `answer` below is the guarded
        // text for the same reason — one string, seen everywhere. A refused answer
        // is read whole, its reason included: the reason is the app's sentence, so
        // its own digits ("At most 8 filters.") are no figure anyone invented — but
        // what it QUOTES may be the model's words (Unknown dataset "…"), and a
        // figure written into a name is a figure the model wrote.
        const refused = answer && !answer.ok ? answer.reason : null;
        const built = answer && answer.ok && 'spec' in answer ? answer : null;
        const sqlBuilt = answer && answer.ok && 'sql' in answer ? answer : null;
        const audited = built ? ledger.concat(built.ledger) : ledger;
        const guarded = refused === null ? guardAnswer(res.text, audited)
          : guardAnswer(`${res.text}\n\n(No chart: ${refused})`, ledger.concat(reasonLedger(refused)));
        // An agent that fell back says so above the answer (rule 12): the app's line, after the audit of the model's words.
        const text = scope.note ? `${scope.note}\n\n${guarded.text}` : guarded.text;

        const snapshot = built ? await snapshotFor(projectId, built.card, built.spec) // the card as computed, kept with the turn
          : sqlBuilt ? await sqlSnapshotFor(projectId, sqlBuilt.card, sqlBuilt.sql) : undefined;
        await copilot.appendTurn(projectId, { role: 'user', text: q }, target);
        const stored = await copilot.appendTurn(projectId, {
          role: 'assistant',
          text,
          provenance: built ? built.provenance : facts.provenance,
          answer: built ? built.spec : undefined,
          sql: sqlBuilt ? sqlBuilt.sql : undefined,
          snapshot,
          // A refused chart's "Did you mean" (./answers): the app's options, kept so a reload still offers them.
          suggest: answer && !answer.ok && 'suggest' in answer ? answer.suggest : undefined,
          // What an editor must add first (outcome E's checked link, a table to copy): kept so a reload still offers it.
          ...(answer && !answer.ok && 'needs' in answer ? { needs: answer.needs, link: answer.link } : {}),
          guidance: guided.used,
          factsFrom,
        }, target);
        // `suggestedAction` is the model's STRUCTURED read of what the question
        // wanted (src/ai/suggestedAction.ts) — a whitelisted kind plus an intent
        // string, never a plan and never a figure. It is NOT persisted on the
        // turn: a proposal belongs to the turn that produced it and is rebuilt
        // from disk truth as prose only, which is the existing rule.
        return {
          ok: true, answer: text, provenance: facts.provenance,
          turns: await turnsForBrowser(projectId, stored || []), threadId: target || null,
          // An answer is fully handled here, so it proposes nothing further.
          suggestedAction: answer ? NO_ACTION : action,
          // App-side records, for tests and the fidelity gate. The renderer shows
          // neither: the ledger is internal, and the audit's finding is already
          // in `answer`. Nothing new reaches a user in this PR.
          ledger: audited,
          numberAudit: guarded.audit,
          guidance: guided.used,
          agent: await agentRef(projectId, kept),
        };
      }
      if (res.errorType === 'not_ready') return { ok: false, notReady: true };
      return { ok: false, error: res.message || 'Could not answer the question' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to ask Copilot' };
    }
  }));

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
