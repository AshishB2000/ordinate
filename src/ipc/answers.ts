// ANSWERS WITH CHARTS — the main-process half.
//
// A question the data can answer ("revenue by region last quarter") comes back
// from the model as an `answer` action carrying a spec (src/ai/answerSpec.ts).
// Everything after that is the app's: the spec is resolved against the
// dataset's real columns, the chart is computed by the same buildVizData every
// visual uses, the card's figures are read off that output (src/ai/answerFacts),
// and only then is the model asked to NARRATE them — with the card's own
// ledger as the audit its narration must pass. "Explain" on a tile and the
// follow-up chips go through the same card, so there is one path for all three.
//
// The spec is what a conversation turn stores; the figures never are. Every
// render recomputes the card (`answer:card`), exactly like a dashboard's metric
// cards, so a refreshed dataset moves an old answer with it.
//
// Registered from ./copilot's register(), which hands over its number guard —
// the guard is a safety control and there is exactly one of it.

import { ipcMain } from './bus';
import * as execConfig from '../app/execConfig';
import * as copilot from '../ai/copilot';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as metrics from '../analysis/metrics';
import { buildVizData } from '../analysis/vizData';
import type { ChartData } from '../analysis/vizData';
import type { VizEncoding } from '../analysis/visuals';
import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import { tileCaption } from '../analysis/captions';
import { displayNames } from '../app/catalog';
import { askCopilot } from '../ai/analyze';
import {
  ANSWER_CHART_TYPES, answerChips, defaultAnswerChart, sanitizeStoredSpec, specFilterSteps, splitCandidates,
  validateAnswerSpec,
} from '../ai/answerSpec';
import type { AnswerChip, AnswerSpec, SpecDataset, SpecMetric } from '../ai/answerSpec';
import { answerFacts, describeAnswer } from '../ai/answerFacts';
import type { Headline } from '../ai/answerFacts';
import type { LedgerEntry, NumberAudit } from '../ai/numberAudit';
import type { SuggestedAction } from '../ai/suggestedAction';
import type { AsOf } from '../api/asOf';
import { asOfFrom, utcLabel } from '../data/figureAsOf';
import type { LiveFailureCode } from '../engine/live/liveQuery';
import { liveCardFor } from './liveAnswers';
import { ensureFresh } from '../data/freshOnAsk';
import { withPulls } from '../data/freshOnAskState';

export type Guard = (text: string, ledger: LedgerEntry[]) => { text: string; audit: NumberAudit };

/** What the renderer draws. Every figure on it was computed here. */
export interface AnswerCard {
  ok: true;
  spec: AnswerSpec;
  title: string;
  chartType: string;
  datasetName: string;
  data: ChartData;
  caption: string;
  headline: Headline[];
  bullets: string[];
  chips: AnswerChip[];
  filterLabels: string[];
  /** The resolved filters, for "Save as visual" / "Open in builder". */
  steps: FilterStep[];
  notes: string[];
  /** How fresh the figures are (L0.2, data/figureAsOf) — the card's caption, and a line of the facts. */
  asOf?: AsOf;
}

export interface Built {
  card: AnswerCard;
  factsText: string;
  ledger: LedgerEntry[];
  provenance: copilot.CopilotProvenance;
}

/** `code`: a Live dataset's typed failure (./liveAnswers) — the card says why, never an empty chart. */
export type Failure = { ok: false; reason: string; code?: LiveFailureCode };

const OK_AUDIT: NumberAudit = { ok: true, violations: [] };

// ── Computing a card ─────────────────────────────────────────────────────────

/**
 * A text filter value → the cell text the data actually holds, matched without
 * regard to case or surrounding space. "west" asked for is "West" stored; a
 * filter that matched nothing because of a capital letter would be an empty
 * chart that looks like an answer.
 */
function canonicaliseTextFilters(steps: FilterStep[], columns: ParsedColumn[], rows: Cell[][]): void {
  for (const s of steps) {
    const ci = columns.findIndex((c) => c.name === s.column);
    if (ci < 0 || columns[ci].type !== 'text') continue;
    if (!['=', '!=', 'in', 'not in'].includes(s.op)) continue;
    const byKey = new Map<string, string>();
    for (const r of rows) {
      const v = r ? r[ci] : null;
      if (v === null || v === undefined) continue;
      const t = String(v);
      const k = t.trim().toLowerCase();
      if (!byKey.has(k)) byKey.set(k, t);
    }
    const fix = (v: Cell): Cell => (typeof v === 'string' ? byKey.get(v.trim().toLowerCase()) ?? v : v);
    if (s.value !== undefined) s.value = fix(s.value);
    if (s.values) s.values = s.values.map(fix);
  }
}

/**
 * Largest first, and at most `top` of them. An answer about categories reads
 * best ranked; a date axis keeps time order and never takes a top-N.
 */
function ranked(data: ChartData, top?: number): ChartData {
  const first = data.series[0];
  if (!first) return data;
  const order = data.labels.map((_, i) => i).sort((a, b) => {
    const va = first.values[a];
    const vb = first.values[b];
    if (typeof va !== 'number') return typeof vb === 'number' ? 1 : a - b;
    if (typeof vb !== 'number') return -1;
    return vb - va || a - b;
  });
  const keep = top && top > 0 ? order.slice(0, top) : order;
  return {
    labels: keep.map((i) => data.labels[i]),
    series: data.series.map((s) => ({ name: s.name, values: keep.map((i) => s.values[i]) })),
  };
}

export async function computeCard(projectId: string, spec: AnswerSpec): Promise<Built | Failure> {
  // A Live dataset is asked of its warehouse (L2.4, ./liveAnswers): ranked and cut there, never hydrated here.
  const live = await liveCardFor(projectId, spec);
  if (live) return live;
  await ensureFresh(projectId, [spec.datasetId]); // L3.1 fresh on ask: before the rows are read
  // ponytail: hydrates the dataset (periods, value matching and split chips all
  // read cells); a resident distinct-values query when answers over 1M rows feel slow.
  const ds = await datasets.getDataset(projectId, spec.datasetId);
  if (!ds) return { ok: false, reason: 'The dataset this answer was built on no longer exists.' };
  const has = (n: string): boolean => ds.columns.some((c) => c.name === n);
  const used = [spec.category, ...spec.measures.map((m) => m.column), ...spec.filters.map((f) => f.column)]
    .concat(spec.series ? [spec.series] : []);
  const missing = used.find((n) => !has(n));
  if (missing) return { ok: false, reason: `"${missing}" is no longer a column of ${ds.name}.` };

  const { steps, labels: filterLabels } = specFilterSteps(spec, ds.columns, ds.rows);
  canonicaliseTextFilters(steps, ds.columns, ds.rows);
  const encoding: VizEncoding = { category: spec.category, values: spec.measures };
  if (spec.series) encoding.series = spec.series;
  if (spec.grain) encoding.grain = spec.grain;
  const viz = buildVizData(ds.columns, ds.rows, encoding, steps);

  const catCol = ds.columns.find((c) => c.name === spec.category);
  const isDate = !!catCol && catCol.type === 'date';
  let data: ChartData = { labels: viz.data.labels, series: viz.data.series };
  if (!isDate) data = ranked(data, spec.top);

  const chartType = ANSWER_CHART_TYPES.has(spec.chartType) ? spec.chartType : defaultAnswerChart(catCol ? catCol.type : 'text', !!spec.series);
  // A column the user gave a display name reads as that name (the catalog).
  const caption = tileCaption({ chartType, data, names: await displayNames(projectId, ds.id).catch(() => ({})) });
  const additive = spec.measures.every((m) => m.aggregation === 'sum' || m.aggregation === 'count');
  // The rows are already loaded, so their time comes off the same record — no second read.
  const read = asOfFrom([ds]);
  const asOf = read ? withPulls(read, projectId, [ds.id]) : read; // "· refreshing…" while a pull goes on (L3.1)
  const facts = answerFacts({
    title: spec.title, datasetName: ds.name, describe: describeAnswer(spec), data,
    categoryIsDate: isDate, additive, filterLabels, caption, ...(asOf ? { asOf: utcLabel(asOf.at) } : {}),
  });
  const notes = viz.warnings.slice();
  if (viz.category && viz.category.note) notes.push(viz.category.note);

  return {
    card: {
      ok: true, spec, title: spec.title, chartType, datasetName: ds.name, data, caption,
      headline: facts.headline, bullets: facts.bullets,
      chips: answerChips(spec, { columns: ds.columns, splitCandidates: splitCandidates(ds.columns, ds.rows, spec.category) }),
      filterLabels, steps, notes, ...(asOf ? { asOf } : {}),
    },
    factsText: facts.text,
    ledger: facts.ledger,
    provenance: {
      kind: 'dataset',
      name: ds.name,
      columns: used.filter((n, i) => used.indexOf(n) === i),
      note: 'chart app-computed',
    },
  };
}

/** The model narrates the card's facts, audited against the card's own ledger. No model → no prose, and the card's bullets stand. */
async function narrate(built: Built, question: string, guard: Guard): Promise<{ text: string; audit: NumberAudit }> {
  if (!execConfig.executionReady()) return { text: '', audit: OK_AUDIT };
  const res = await askCopilot([], built.factsText, question);
  if (!res.ok || !res.text) return { text: '', audit: OK_AUDIT };
  return guard(res.text, built.ledger);
}

// ── The three entry points ───────────────────────────────────────────────────

async function specDatasets(projectId: string): Promise<SpecDataset[]> {
  const list = await datasets.listDatasets(projectId);
  const metas = await Promise.all(list.map((d) => datasets.getDatasetMeta(projectId, d.id)));
  return metas.filter((m): m is NonNullable<typeof m> => !!m).map((m) => ({ id: m.id, name: m.name, columns: m.columns }));
}

async function specMetrics(projectId: string): Promise<SpecMetric[]> {
  const out: SpecMetric[] = [];
  try {
    for (const s of await metrics.listMetrics(projectId)) {
      if (metrics.isFormulaDefinition(s.definition)) continue;
      const full = await metrics.getMetric(projectId, s.id);
      out.push({
        id: s.id, name: s.name, datasetId: s.datasetId,
        column: s.definition.column, aggregation: s.definition.aggregation,
        hasFilters: !!(full && full.filters.length),
      });
    }
  } catch (_) { /* no metric vocabulary — the spec must name columns */ }
  return out;
}

export interface AnswerTurn {
  text: string;
  audit: NumberAudit;
  ledger: LedgerEntry[];
  provenance: copilot.CopilotProvenance;
  spec: AnswerSpec;
}

/**
 * The dock's `answer` action → a narrated, audited answer turn, or the reason
 * it could not be built (the caller keeps the prose answer and says why).
 */
export async function answerFromAction(
  projectId: string,
  context: { kind?: string; id?: string },
  action: SuggestedAction,
  question: string,
  guard: Guard,
): Promise<({ ok: true } & AnswerTurn) | Failure> {
  let defaultDatasetId: string | undefined;
  if (context && context.kind === 'dataset' && context.id) defaultDatasetId = context.id;
  if (context && context.kind === 'visual' && context.id) {
    const v = await visuals.getVisual(projectId, context.id);
    if (v) defaultDatasetId = v.datasetId;
  }
  const v = validateAnswerSpec(action.spec, await specDatasets(projectId), {
    defaultDatasetId, metrics: await specMetrics(projectId), title: action.intent || question,
  });
  if (!v.ok) return v;
  const built = await computeCard(projectId, v.spec);
  if ('ok' in built) return built;
  const n = await narrate(built,
    `Narrate this chart answer to the question "${question}" in two or three sentences, citing only figures from the facts.`,
    guard);
  return { ok: true, text: n.text, audit: n.audit, ledger: built.ledger, provenance: built.provenance, spec: v.spec };
}

/** A saved chart (or a dashboard tile's live one) → the spec its card is built from. */
export function tileSpec(t: { datasetId: string; encoding: VizEncoding; filters: FilterStep[]; chartType: string; name: string }): AnswerSpec | null {
  const enc = t.encoding;
  const category = enc.category || (enc.pivot && enc.pivot.rows && enc.pivot.rows[0]) || '';
  const measures = (enc.values || []).map((m) => (m.aggregation === 'none' ? { ...m, aggregation: 'sum' as const } : m));
  return sanitizeStoredSpec({
    datasetId: t.datasetId,
    category,
    measures,
    series: enc.series,
    grain: enc.grain,
    filters: (t.filters || []).map((f) => ({ column: f.column, op: f.op, value: f.value, values: f.values })),
    chartType: ANSWER_CHART_TYPES.has(t.chartType) ? t.chartType : 'column',
    title: t.name,
  }) || null;
}

async function appendAnswer(
  projectId: string, threadId: string | undefined, userText: string, text: string, built: Built, spec: AnswerSpec,
): Promise<{ turns: copilot.CopilotTurn[]; threadId: string | null }> {
  let target = threadId || (await copilot.latestThreadId(projectId)) || undefined;
  if (!target) target = (await copilot.createThread(projectId))?.id;
  await copilot.appendTurn(projectId, { role: 'user', text: userText }, target);
  const turns = await copilot.appendTurn(projectId, { role: 'assistant', text, provenance: built.provenance, answer: spec }, target);
  return { turns: turns || [], threadId: target || null };
}

export function register(guard: Guard): void {
  // Draw one card from a stored spec. Called on every render of an answer turn.
  ipcMain.handle('answer:card', async (_e, { projectId, spec }: any = {}) => {
    try {
      const s = sanitizeStoredSpec(spec);
      if (!s) return { ok: false, reason: 'This answer could not be read.' };
      const built = await computeCard(projectId, s);
      return 'ok' in built ? built : built.card;
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'Could not build the answer' };
    }
  });

  // "Explain" on a visual or a dashboard tile: the tile's facts, narrated when a
  // model is configured, as bullet points when not — in a NEW conversation.
  ipcMain.handle('answer:explain', async (_e, { projectId, visualId, tile }: any = {}) => {
    try {
      let src: Parameters<typeof tileSpec>[0] | null = null;
      if (typeof visualId === 'string' && visualId) {
        const v = await visuals.getVisual(projectId, visualId);
        if (v) src = { datasetId: v.datasetId, encoding: v.encoding, filters: v.filters, chartType: v.chartType, name: v.name };
      } else if (tile && typeof tile === 'object' && typeof tile.datasetId === 'string') {
        src = {
          datasetId: tile.datasetId,
          encoding: visuals.sanitizeEncoding(tile.encoding),
          filters: visuals.sanitizeFilters(tile.filters),
          chartType: visuals.sanitizeChartType(tile.chartType),
          name: typeof tile.name === 'string' && tile.name.trim() ? tile.name.trim() : 'this chart',
        };
      }
      const spec = src ? tileSpec(src) : null;
      if (!spec || !src) return { ok: false, reason: 'This chart cannot be explained.' };
      const built = await computeCard(projectId, spec);
      if ('ok' in built) return built;
      const n = await narrate(built,
        `Explain the chart "${src.name}" to the user in two or three sentences: what stands out, citing only figures from the facts.`,
        guard);
      const thread = await copilot.createThread(projectId);
      if (!thread) return { ok: false, reason: 'Could not start a conversation.' };
      const r = await appendAnswer(projectId, thread.id, `Explain “${src.name}”`, n.text, built, spec);
      return { ok: true, threadId: r.threadId, narrated: !!n.text };
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'Could not explain the chart' };
    }
  });

  // A follow-up chip: the chip's own spec, recomputed by the app — no model call
  // decides the chart, and one narrates it only when configured.
  ipcMain.handle('answer:rerun', async (_e, { projectId, threadId, spec, label }: any = {}) => {
    try {
      const s = sanitizeStoredSpec(spec);
      if (!s) return { ok: false, reason: 'This follow-up could not be read.' };
      const built = await computeCard(projectId, s);
      if ('ok' in built) return built;
      const userText = typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : s.title;
      const n = await narrate(built,
        `Narrate this chart answer ("${s.title}") in two or three sentences, citing only figures from the facts.`,
        guard);
      const tid = typeof threadId === 'string' && threadId ? threadId : undefined;
      const r = await appendAnswer(projectId, tid, userText, n.text, built, s);
      return { ok: true, turns: r.turns, threadId: r.threadId };
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'Could not run the follow-up' };
    }
  });
}
