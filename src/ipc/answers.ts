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
import type { FilterStep } from '../data/transforms';
import { tileCaption } from '../analysis/captions';
import { displayNames, load as loadCatalog } from '../app/catalog';
import { shownNames, taughtNames } from '../app/columnNames';
import { askCopilot } from '../ai/analyze';
import {
  ANSWER_CHART_TYPES, answerChips, defaultAnswerChart, resolveColumn, sanitizeStoredSpec, specFilterSteps, splitCandidates,
  validateAnswerSpec,
} from '../ai/answerSpec';
import type { AnswerChip, AnswerSpec, SpecDataset, SpecMetric } from '../ai/answerSpec';
import { canonicaliseTextFilters, heldValues, matchValues, nearestValueFixes } from '../ai/answerValues';
import { sanitizeLearn, suggestFixes } from '../ai/answerSuggest';
import type { AnswerLearn, AnswerSuggest } from '../ai/answerSuggest';
import { noRowsMatch, valueMatched } from '../ai/answerMessages';
import { saveCardAsVisual } from './answerSave';
import { isRefine, refineSpec, sameChart } from '../ai/answerRefine';
import { previousAnswerBlock } from '../ai/previousAnswer';
import { withheldColumns } from '../app/sharePolicy';
import { answerFacts, describeAnswer, withheldFilters } from '../ai/answerFacts';
import type { Headline } from '../ai/answerFacts';
import type { LedgerEntry, NumberAudit } from '../ai/numberAudit';
import type { SuggestedAction } from '../ai/suggestedAction';
import type { AsOf } from '../api/asOf';
import { asOfFrom, utcLabel } from '../data/figureAsOf';
import type { LiveFailureCode } from '../engine/live/liveQuery';
import { answerNames } from '../engine/live/liveMissing';
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
  /** No rows, because a filter value is not in its column: the sentence, and the stored values it may have meant (ai/answerValues). */
  noMatch?: { text: string; options: AnswerChip[] };
  /** The name its turn can remember (`learnState`), when the card was asked with one. */
  learn?: CardLearn;
}

/** A name to remember, as the card shows it: the column's shown name, and 'known' once the project's names already mean that column. */
export interface CardLearn extends AnswerLearn { label: string; state: 'offer' | 'known' }

export interface Built {
  card: AnswerCard;
  factsText: string;
  ledger: LedgerEntry[];
  provenance: copilot.CopilotProvenance;
}

/**
 * `code`: a Live dataset's typed failure (./liveAnswers) — the card says why, never an empty chart.
 * `suggest`: a refused spec named something that does not exist, and this is what it may have meant.
 */
export type Failure = { ok: false; reason: string; code?: LiveFailureCode; suggest?: AnswerSuggest };

const OK_AUDIT: NumberAudit = { ok: true, violations: [] };

// ── Computing a card ─────────────────────────────────────────────────────────

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

/**
 * The card a spec draws. `loose` is for a spec that was just WRITTEN — by a
 * model, or by a chip built from one: a filter value the column does not hold
 * is then matched to the one stored value it means (ai/answerValues), and the
 * card's own `spec` is the matched one, which is what the turn stores. A stored
 * spec is drawn as it stands, so a reload and an explained tile show what they
 * showed.
 */
export async function computeCard(projectId: string, asked: AnswerSpec, loose = false): Promise<Built | Failure> {
  // A Live dataset is asked of its warehouse (L2.4, ./liveAnswers): ranked and cut there, never hydrated here.
  const live = await liveCardFor(projectId, asked);
  if (live) return live;
  await ensureFresh(projectId, [asked.datasetId]); // L3.1 fresh on ask: before the rows are read
  // ponytail: hydrates the dataset (periods, value matching and split chips all
  // read cells); a resident distinct-values query when answers over 1M rows feel slow.
  const ds = await datasets.getDataset(projectId, asked.datasetId);
  if (!ds) return { ok: false, reason: 'The dataset this answer was built on no longer exists.' };
  const has = (n: string): boolean => ds.columns.some((c) => c.name === n);
  const used = [asked.category, ...asked.measures.map((m) => m.column), ...asked.filters.map((f) => f.column)]
    .concat(asked.series ? [asked.series] : []);
  const missing = used.find((n) => !has(n));
  if (missing) return { ok: false, reason: `"${missing}" is no longer a column of ${ds.name}.` };

  // What the filtered text columns hold: read once, for the loose match, the case fix and the empty answer's suggestions.
  const held = heldValues(asked.filters, ds.columns, ds.rows);
  const spec = loose ? matchValues(asked, held) : asked;
  const { steps, labels: filterLabels } = specFilterSteps(spec, ds.columns, ds.rows);
  canonicaliseTextFilters(steps, held);
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
  // What a MODEL reads of the filters: the value on a column marked personal or financial is withheld
  // (ai/answerFacts `withheldFilters`). The card's own labels, drawn for the person, are untouched.
  const withheld = spec.filters.length ? await withheldColumns(projectId, ds.id) : new Set<string>();
  const saidFilterLabels = spec.filters.some((f) => withheld.has(f.column))
    ? specFilterSteps({ filters: withheldFilters(spec.filters, withheld) }, ds.columns, ds.rows).labels : undefined;
  const facts = answerFacts({
    title: spec.title, datasetName: ds.name, describe: describeAnswer(spec), data,
    categoryIsDate: isDate, additive, filterLabels, saidFilterLabels, caption, ...(asOf ? { asOf: utcLabel(asOf.at) } : {}),
  });
  // What the app did to a value comes first: it changes what the chart is about. The CARD's line, never the facts'.
  const notes = (spec.matched ?? []).map((m) => valueMatched(m.said, m.value, m.column)).concat(viz.warnings);
  if (viz.category && viz.category.note) notes.push(viz.category.note);
  // Nothing to draw because a value is not in its column: the nearest stored ones, never a marked column's.
  const near = data.labels.length ? null : nearestValueFixes(spec, held, withheld);

  return {
    card: {
      ok: true, spec, title: spec.title, chartType, datasetName: ds.name, data, caption,
      headline: facts.headline, bullets: facts.bullets,
      chips: answerChips(spec, { columns: ds.columns, splitCandidates: splitCandidates(ds.columns, ds.rows, spec.category) }),
      filterLabels, steps, notes, ...(asOf ? { asOf } : {}),
      ...(near ? { noMatch: { text: noRowsMatch(near.column, near.op, near.said), options: near.options } } : {}),
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
  if (!(await execConfig.executionReady())) return { text: '', audit: OK_AUDIT };
  const res = await askCopilot([], built.factsText, question);
  if (!res.ok || !res.text) return { text: '', audit: OK_AUDIT };
  return guard(res.text, built.ledger);
}

// ── The three entry points ───────────────────────────────────────────────────

/**
 * Every dataset a spec may name: its columns, and what people call them — the
 * display names and "Also called" names the facts told the model to use, so a
 * spec written in those words resolves. ONE catalog read for the project;
 * records only, so a Live dataset is listed like any other.
 */
export async function specDatasets(projectId: string): Promise<SpecDataset[]> {
  const list = await datasets.listDatasets(projectId);
  const metas = await Promise.all(list.map((d) => datasets.getDatasetMeta(projectId, d.id)));
  const docs = (await loadCatalog(projectId)).columns;
  return metas.filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => ({ id: m.id, name: m.name, columns: m.columns, names: taughtNames(m.columns, docs[m.id]), shown: shownNames(m.columns, docs[m.id]) }));
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

/** The chart a follow-up continues: its stored spec, the block that tells the model about it, and that block's ledger. */
export interface PreviousAnswer { spec: AnswerSpec; block: string; ledger: LedgerEntry[] }

/**
 * The most recent answer of a conversation, when a follow-up can still build on
 * it: its dataset exists and the spec, restated in full, still validates against
 * it — every column it uses is still there, with a type its measures and filters
 * fit. Otherwise null, and the next question is asked as if nothing came before.
 * Metadata and the catalog only: a Live dataset is never hydrated.
 *
 * "Still there" is by EXACT name, as `computeCard` reads it. A column renamed
 * only in case or punctuation still resolves by the validator's looser rules,
 * but the block, the marks that withhold a value and the merge all go by the
 * stored name — under a stale one a marked value would be printed and a
 * replaced filter kept.
 */
export async function previousAnswer(projectId: string, turns: copilot.CopilotTurn[]): Promise<PreviousAnswer | null> {
  let spec: AnswerSpec | undefined;
  for (let i = turns.length - 1; i >= 0 && !spec; i--) if (turns[i].role === 'assistant') spec = turns[i].answer;
  const meta = spec ? await datasets.getDatasetMeta(projectId, spec.datasetId) : null;
  if (!spec || !meta) return null;
  if (answerNames(spec).some((n) => !meta.columns.some((c) => c.name === n))) return null;
  const ds: SpecDataset = { id: meta.id, name: meta.name, columns: meta.columns };
  if (!validateAnswerSpec(refineSpec(spec, {}, ds), [ds]).ok) return null;
  const { text, ledger } = previousAnswerBlock(spec, meta.name, await withheldColumns(projectId, meta.id));
  return { spec, block: text, ledger };
}

/**
 * The dock's `answer` action → a narrated, audited answer turn, or the reason
 * it could not be built (the caller keeps the prose answer and says why).
 *
 * `previous` is the answer a follow-up continues (`previousAnswer`). A spec
 * marked `"refine": true` is merged onto it by the app (ai/answerRefine) and the
 * MERGED spec is validated — refused with the validator's reason, never cut
 * back to the patch alone. A refine the merge could apply nothing of (a key it
 * does not read) is refused too: the previous chart again, under the
 * follow-up's title, is a wrong answer that looks right. Any other spec is a
 * new subject; it keeps nothing of the previous answer but its dataset, and
 * that only as the default after the screen's own.
 */
export async function answerFromAction(
  projectId: string,
  context: { kind?: string; id?: string },
  action: SuggestedAction,
  question: string,
  guard: Guard,
  previous?: AnswerSpec,
): Promise<({ ok: true } & AnswerTurn) | Failure> {
  let defaultDatasetId: string | undefined;
  if (context && context.kind === 'dataset' && context.id) defaultDatasetId = context.id;
  if (context && context.kind === 'visual' && context.id) {
    const v = await visuals.getVisual(projectId, context.id);
    if (v) defaultDatasetId = v.datasetId;
  }
  const all = await specDatasets(projectId);
  const defined = await specMetrics(projectId);
  const on = previous ? all.find((d) => d.id === previous.datasetId) : undefined;
  // The answer a refine is laid over — none for a new subject, or once its dataset is gone.
  const base = previous && on && isRefine(action.spec) ? previous : null;
  const raw = base && on ? refineSpec(base, action.spec, on, defined) : action.spec;
  const opts = { defaultDatasetId: defaultDatasetId ?? on?.id, title: action.intent || question };
  const v = validateAnswerSpec(raw, all, { ...opts, metrics: defined });
  if (!v.ok) {
    // A name that does not exist: what it may have meant, picked by the app from the names alone
    // (ai/answerSuggest) and laid over the same raw spec — the MERGED one, so a follow-up's option
    // keeps its carried filters. An option that is the previous chart again is not one.
    const options = v.miss ? suggestFixes(raw, v.miss, all, defined, opts).filter((o) => !base || !sameChart(base, o.spec)) : [];
    return v.miss && options.length
      ? { ok: false, reason: v.reason, suggest: { part: v.miss.part, said: v.miss.said, options } }
      : { ok: false, reason: v.reason };
  }
  if (base && sameChart(base, v.spec)) return { ok: false, reason: 'The follow-up changed nothing the app could apply.' };
  const built = await computeCard(projectId, v.spec, true);
  if ('ok' in built) return built;
  // …also when it only became the previous chart once a value was matched to the one it already filtered to.
  if (base && sameChart(base, built.card.spec)) return { ok: false, reason: 'The follow-up changed nothing the app could apply.' };
  const n = await narrate(built,
    `Narrate this chart answer to the question "${question}" in two or three sentences, citing only figures from the facts.`,
    guard);
  // The card's own spec: the validated one, with any filter value the app matched to what the data holds.
  return { ok: true, text: n.text, audit: n.audit, ledger: built.ledger, provenance: built.provenance, spec: built.card.spec };
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
  projectId: string, threadId: string | undefined, userText: string, text: string, built: Built, spec: AnswerSpec, learn?: AnswerLearn,
): Promise<{ turns: copilot.CopilotTurn[]; threadId: string | null }> {
  let target = threadId || (await copilot.latestThreadId(projectId)) || undefined;
  if (!target) target = (await copilot.createThread(projectId))?.id;
  await copilot.appendTurn(projectId, { role: 'user', text: userText }, target);
  const turns = await copilot.appendTurn(projectId, { role: 'assistant', text, provenance: built.provenance, answer: spec, ...(learn ? { learn } : {}) }, target);
  return { turns: turns || [], threadId: target || null };
}

/**
 * Whether a name is still to remember, worked out now — never stored, so a name
 * taught in the Columns tab, or by anyone's card, shows here at once. Metadata
 * and the catalog only: a Live dataset is never hydrated. Nothing when the
 * column is gone.
 */
async function learnState(projectId: string, datasetId: string, learn: AnswerLearn): Promise<CardLearn | undefined> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta || !meta.columns.some((c) => c.name === learn.column)) return undefined;
  const docs = (await loadCatalog(projectId)).columns[datasetId];
  const known = resolveColumn(learn.said, meta.columns, taughtNames(meta.columns, docs))?.name === learn.column;
  return { ...learn, label: shownNames(meta.columns, docs)[learn.column] || learn.column, state: known ? 'known' : 'offer' };
}

export function register(guard: Guard): void {
  // Draw one card from a stored spec. Called on every render of an answer turn;
  // `learn` is its turn's name to remember, if it has one.
  ipcMain.handle('answer:card', async (_e, { projectId, spec, learn }: any = {}) => {
    try {
      const s = sanitizeStoredSpec(spec);
      if (!s) return { ok: false, reason: 'This answer could not be read.' };
      const built = await computeCard(projectId, s);
      if ('ok' in built) return built;
      const said = sanitizeLearn(learn, s);
      const taught = said ? await learnState(projectId, s.datasetId, said) : undefined;
      return taught ? { ...built.card, learn: taught } : built.card;
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

  // A follow-up chip, or a "Did you mean" option: the chip's own spec, recomputed
  // by the app — no model call decides the chart, and one narrates it only when
  // configured. An option built from a refused spec still carries the filter
  // values as they were said, so they are matched here as an answer's are. An
  // option that put a column in place of a name sends `learn`, kept on the new
  // turn only for a column its answer uses (ai/answerSuggest `sanitizeLearn`).
  ipcMain.handle('answer:rerun', async (_e, { projectId, threadId, spec, label, learn }: any = {}) => {
    try {
      const s = sanitizeStoredSpec(spec);
      if (!s) return { ok: false, reason: 'This follow-up could not be read.' };
      const built = await computeCard(projectId, s, true);
      if ('ok' in built) return built;
      const userText = typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : s.title;
      const n = await narrate(built,
        `Narrate this chart answer ("${s.title}") in two or three sentences, citing only figures from the facts.`,
        guard);
      const tid = typeof threadId === 'string' && threadId ? threadId : undefined;
      const r = await appendAnswer(projectId, tid, userText, n.text, built, built.card.spec, sanitizeLearn(learn, built.card.spec));
      return { ok: true, turns: r.turns, threadId: r.threadId };
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'Could not run the follow-up' };
    }
  });

  // "Save as visual": the card is rebuilt HERE from the spec — its encoding and its
  // filter steps are the server's, never a client's — and saved as it was drawn (./answerSave).
  ipcMain.handle('answer:saveVisual', async (_e, { projectId, spec }: any = {}) => {
    try {
      const s = sanitizeStoredSpec(spec);
      if (!s) return { ok: false, reason: 'This answer could not be read.' };
      const built = await computeCard(projectId, s);
      return 'ok' in built ? built : await saveCardAsVisual(projectId, built.card);
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'Could not save the visual' };
    }
  });
}
