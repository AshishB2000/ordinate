// The Summary card over IPC — MAIN PROCESS.
//
// Gathers what the dashboard's own tiles already say, from the modules that
// compute it, and hands the figures to analysis/summaryCard for wording and
// ranking. Nothing here aggregates a row:
//
//   headline KPI + contributor  ipc/drivers.driversFor on the first KPI card —
//                               its Compare when it has one, else the two
//                               latest periods of the dataset's date column
//   top insight                 ipc/insights.listInsights per dataset (cached)
//   failing quality rule        the dataset's STORED latest quality run
//   fired alert                 the alert inbox's unseen events
//
// Everything the tiles read is under the dashboard's filters, selection and
// parameters, inside the request's "as of" scope (withAsOf), exactly like a
// metric card. A model is only on the `summary:rewrite` path, which narrates
// these same sentences and is audited against their ledger.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as alertStore from '../analysis/alertStore';
import * as execConfig from '../app/execConfig';
import * as sharePolicy from '../app/sharePolicy';
import { sanitizeCard, sanitizeDashboardFilters } from '../analysis/dashboards';
import type { Card } from '../analysis/dashboards';
import { paramValues, resolveFilterParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import type { FilterStep } from '../data/transforms';
import { asOfIso, withAsOf } from '../data/asOf';
import { sanitizeDriversSpec } from '../analysis/driverScope';
import { rankInsights } from '../analysis/insights';
import { listQuality } from '../analysis/qualityRun';
import { ruleSignature } from '../analysis/qualityRules';
import { formatValue } from '../app/format';
import { askCopilot } from '../ai/analyze';
import {
  alertSentence, composeSummary, driverSentence, insightSentence, kpiSentence, qualitySentence, summaryFacts,
} from '../analysis/summaryCard';
import type { QualityFact, SummaryCandidates, SummarySentence } from '../analysis/summaryCard';
import { driversFor } from './drivers';
import { listInsights } from './insights';
import { resolveMetric } from './metrics';
import { computeCardMetric } from './dashboards';
import { guardAnswer } from './copilot';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CARDS = 500;
/** Insights considered — the top one, and the rest only to reach three sentences. */
const INSIGHTS_KEPT = 3;

/** A tile: the dataset it reads and every column it names. */
interface Tile { cardId: string; datasetId: string; columns: Set<string> }

/** The cards of every sheet, whitelisted, in reading order (sheet, row, column). */
function readingOrder(rawPages: unknown): Card[] {
  const out: Card[] = [];
  for (const page of Array.isArray(rawPages) ? rawPages : []) {
    const raw = page && typeof page === 'object' ? (page as { cards?: unknown }).cards : null;
    const cards = (Array.isArray(raw) ? raw : []).map(sanitizeCard).filter((c): c is Card => !!c);
    cards.sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
    out.push(...cards);
    if (out.length >= MAX_CARDS) break;
  }
  return out.slice(0, MAX_CARDS);
}

async function tilesOf(projectId: string, cards: Card[]): Promise<Tile[]> {
  const out: Tile[] = [];
  for (const c of cards) {
    if (c.type === 'metric' && c.metric) out.push({ cardId: c.id, datasetId: c.metric.datasetId, columns: new Set([c.metric.column]) });
    else if (c.type === 'stats' && c.stats) out.push({ cardId: c.id, datasetId: c.stats.datasetId, columns: new Set() });
    else if (c.type === 'visual') {
      const v = c.visual && c.visual.datasetId ? c.visual : c.visualId ? await visuals.getVisual(projectId, c.visualId) : null;
      if (!v) continue;
      const enc = v.encoding || ({} as typeof v.encoding);
      const cols = [enc.category, enc.series, ...(enc.values || []).map((m) => m.column)].filter((x): x is string => !!x);
      out.push({ cardId: c.id, datasetId: v.datasetId, columns: new Set(cols) });
    }
  }
  return out;
}

/**
 * The tile a fact came from: the first on its dataset reading the first of
 * `columns` any tile reads, else the first tile on its dataset.
 */
function tileFor(tiles: Tile[], datasetId: string | undefined, ...columns: Array<string | undefined>): string | null {
  const on = tiles.filter((t) => t.datasetId === datasetId);
  for (const c of columns) {
    const hit = c ? on.find((t) => t.columns.has(c)) : undefined;
    if (hit) return hit.cardId;
  }
  return on[0] ? on[0].cardId : null;
}

// ── The five facts ───────────────────────────────────────────────────────────

async function kpiAndDriver(projectId: string, card: Card, filters: FilterStep[], params: ParamValues): Promise<Pick<SummaryCandidates, 'kpi' | 'driver'>> {
  const m = card.metric;
  if (!m) return { kpi: null, driver: null };
  const meta = await datasets.getDatasetMeta(projectId, m.datasetId);
  if (!meta) return { kpi: null, driver: null };
  const metric = { ...(m.metricId ? { metricId: m.metricId } : {}), column: m.column, aggregation: m.aggregation, ...(m.label ? { label: m.label } : {}) };
  const dateCol = meta.columns.find((c) => c.type === 'date');
  // The card's own Compare first (but not under "as of": it moves TODAY's
  // periods), then the two latest periods the data has.
  const compares: unknown[] = [];
  if (m.compare && m.compare.mode && !asOfIso()) compares.push(m.compare);
  if (dateCol) compares.push({ mode: 'latest', column: dateCol.name });
  for (const compare of compares) {
    const spec = sanitizeDriversSpec({ datasetId: m.datasetId, metric, compare, path: [] }, filters);
    const r = spec ? await driversFor(projectId, spec, params) : null;
    if (!r || !r.ok || r.totals.a === null) continue;
    const kpi = kpiSentence({
      cardId: card.id, metric: r.metric.name, a: r.totals.a, b: r.totals.b, delta: r.totals.delta, pct: r.totals.pct,
      aText: r.totals.aText, bText: r.totals.bText, deltaText: r.totals.deltaText,
      aLabel: r.periods.a, bLabel: r.periods.b, direction: r.metric.direction,
    });
    const sel = r.selected;
    const leadLabel = sel ? (r.dimensions.find((d) => d.column === sel.column) || { lead: null }).lead : null;
    const lead = sel && leadLabel !== null ? sel.members.find((x) => x.label === leadLabel) : undefined;
    const driver = sel && lead ? driverSentence({
      cardId: card.id, datasetId: m.datasetId, metric: r.metric.name, column: sel.column, label: lead.label,
      delta: lead.delta, deltaText: lead.deltaText, share: lead.share, moveShare: lead.moveShare, offsetting: sel.offsetting,
    }) : null;
    return { kpi, driver };
  }
  // No second period to compare: the level alone, from the card's own resolver.
  if (m.metricId) {
    const r = await resolveMetric(projectId, m.metricId, { filters, params });
    if (r && r.ok && r.value !== null) {
      return { kpi: kpiSentence({ cardId: card.id, metric: m.label || r.name, a: r.value, b: null, delta: null, pct: null, aText: r.display, bText: '', deltaText: '', aLabel: '', bLabel: '' }), driver: null };
    }
  }
  const r = await computeCardMetric(projectId, m.datasetId, { column: m.column, aggregation: m.aggregation }, filters, params);
  const text = r.ok && r.value !== null ? formatValue(r.value, m.format || 'auto') : '';
  return {
    kpi: r.ok ? kpiSentence({ cardId: card.id, metric: m.label || `${m.aggregation} of ${m.column}`, a: r.value, b: null, delta: null, pct: null, aText: text, bText: '', deltaText: '', aLabel: '', bLabel: '' }) : null,
    driver: null,
  };
}

async function insightFacts(projectId: string, ids: string[], tiles: Tile[]): Promise<SummarySentence[]> {
  const all = [];
  for (const id of ids) all.push(...await listInsights(projectId, id));
  return rankInsights(all, INSIGHTS_KEPT).map((i) => {
    const enc = i.chart && i.chart.encoding;
    const measures = enc ? (enc.values || []).map((m) => m.column) : [];
    return insightSentence(i, tileFor(tiles, i.datasetId, i.column, ...measures, enc && enc.category));
  });
}

async function qualityFact(projectId: string, ids: string[], tiles: Tile[]): Promise<SummarySentence | null> {
  let best: QualityFact | null = null;
  for (const id of ids) {
    const meta = await datasets.getDatasetMeta(projectId, id);
    const q = meta ? await listQuality(projectId, id) : null;
    if (!meta || !q || !q.latest) continue;
    for (const res of q.latest.results) {
      const rule = q.rules.find((r) => r.id === res.ruleId);
      if (!rule || res.passed || res.error) continue;
      const fact: QualityFact = {
        cardId: tileFor(tiles, id, rule.column), datasetName: meta.name, signature: ruleSignature(rule),
        rowCountRule: rule.kind === 'row_count', failing: res.failing, rowCount: meta.rowCount, severity: rule.severity,
      };
      const rank = (f: QualityFact): number => (f.severity === 'fail' ? 1e15 : 0) + f.failing;
      if (!best || rank(fact) > rank(best)) best = fact;
    }
  }
  return best ? qualitySentence(best) : null;
}

async function alertFact(projectId: string, ids: string[], analysisId: string, tiles: Tile[]): Promise<SummarySentence | null> {
  const file = await alertStore.load(projectId);
  const cutoff = asOfIso();
  const ev = file.events
    // Quality alerts have their own sentence; an "as of" view sees only what had fired by then.
    .filter((e) => !e.seen && e.ruleName !== 'Data quality' && (ids.includes(e.datasetId) || (!!analysisId && e.analysisId === analysisId)))
    .filter((e) => !cutoff || e.at <= cutoff)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!ev) return null;
  const rule = file.rules.find((r) => r.id === ev.ruleId);
  return alertSentence({
    cardId: tileFor(tiles, ev.datasetId, rule && rule.metric.column), ruleName: ev.ruleName, message: ev.message,
    value: ev.value, previous: ev.previous, deltaPct: ev.deltaPct,
  });
}

export interface SummaryScope {
  analysisId?: string;
  /** Sanitized dashboard filters (parameters not yet bound) and the bound values. */
  filters: FilterStep[];
  params: ParamValues;
  /**
   * The sentences are LEAVING the app (an export, a published site, a report,
   * the model): drop any that quote values of a column marked sensitive.
   */
  outbound?: boolean;
}

/** The Summary card's sentences for a dashboard's sheets, ranked. EXPORTED for publish and the tests. */
export async function computeSummary(projectId: string, rawPages: unknown, scope: SummaryScope): Promise<SummarySentence[]> {
  const cards = readingOrder(rawPages);
  const tiles = await tilesOf(projectId, cards);
  const ids = [...new Set(tiles.map((t) => t.datasetId))].filter((id) => UUID_RE.test(id));
  const steps = resolveFilterParams(scope.filters, scope.params).steps;
  const head = cards.find((c) => c.type === 'metric' && c.metric);
  const { kpi, driver } = head ? await kpiAndDriver(projectId, head, steps, scope.params) : { kpi: null, driver: null };
  let out = composeSummary({
    kpi, driver,
    insights: await insightFacts(projectId, ids, tiles),
    quality: await qualityFact(projectId, ids, tiles),
    alert: await alertFact(projectId, ids, scope.analysisId || '', tiles),
  });
  if (scope.outbound) {
    const kept: SummarySentence[] = [];
    for (const s of out) {
      const withheld = s.datasetId && s.column ? await sharePolicy.withheldColumns(projectId, s.datasetId) : null;
      if (!withheld || !withheld.has(s.column as string)) kept.push(s);
    }
    out = kept;
  }
  return out;
}

/** The renderer's request → a scope. Everything in it is untrusted. */
function scopeOf(req: any, outbound = false): SummaryScope {
  return {
    analysisId: typeof req.analysisId === 'string' && UUID_RE.test(req.analysisId) ? req.analysisId : '',
    filters: sanitizeDashboardFilters(req.filters),
    params: paramValues(req.params),
    outbound: outbound || req.outbound === true,
  };
}

const NO_MODEL = 'Rewrite needs a model. Set one up in Settings → AI.';

export function register(): void {
  // The card's sentences, recomputed on every render of the card.
  ipcMain.handle('summary:compute', async (_e, req: any = {}) => withAsOf(req.projectId, req.asOf, async () => {
    try {
      if (typeof req.projectId !== 'string' || !UUID_RE.test(req.projectId)) return { ok: false, error: 'Invalid project' };
      const sentences = await computeSummary(req.projectId, req.pages, scopeOf(req));
      const ready = execConfig.executionReady();
      return {
        ok: true,
        sentences: sentences.map((s) => ({ kind: s.kind, text: s.text, tone: s.tone, cardId: s.cardId })),
        computedAt: new Date().toISOString(),
        canRewrite: ready,
        ...(ready ? {} : { rewriteReason: NO_MODEL }),
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not summarise this dashboard.' };
    }
  }));

  // "Rewrite": the same facts, narrated in prose, audited against their ledger.
  // A rewrite citing any figure the app did not compute is refused — the
  // card keeps the app's own sentences.
  ipcMain.handle('summary:rewrite', async (_e, req: any = {}) => withAsOf(req.projectId, req.asOf, async () => {
    try {
      if (typeof req.projectId !== 'string' || !UUID_RE.test(req.projectId)) return { ok: false, error: 'Invalid project' };
      if (!execConfig.executionReady()) return { ok: false, error: NO_MODEL };
      const sentences = await computeSummary(req.projectId, req.pages, scopeOf(req, true));
      if (!sentences.length) return { ok: false, error: 'There is nothing to rewrite yet.' };
      const name = typeof req.name === 'string' && req.name.trim() ? req.name.trim().slice(0, 200) : 'this dashboard';
      const facts = summaryFacts(name, sentences);
      const res = await askCopilot([], facts.text,
        'Rewrite the summary above as one short paragraph of plain prose for a business reader. Keep every fact, '
        + 'most important first. Cite only figures that appear in the facts, exactly as written. No lists, no headings.');
      if (!res.ok || !res.text) return { ok: false, error: 'The model did not answer. The app’s sentences stay.' };
      const guarded = guardAnswer(res.text, facts.ledger);
      if (!guarded.audit.ok) return { ok: false, error: 'The rewrite cited a figure the app did not compute, so the app’s sentences stay.' };
      return { ok: true, text: res.text.trim() };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not rewrite the summary.' };
    }
  }));
}
