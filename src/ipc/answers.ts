// ANSWERS WITH CHARTS — the main-process half.
//
// A question the data can answer ("revenue by region last quarter") comes back
// from the model as an `answer` action carrying a spec (src/ai/answerSpec.ts).
// Everything after that is the app's: the spec is resolved against the
// dataset's real columns, the chart is computed by the same buildVizData every
// visual uses, and the card's figures are read off that output (src/ai/answerFacts).
// A dock question makes ONE model call: its one sentence, written before the
// card exists and with no figure in it, is the turn's text, audited against the
// facts and the card's own ledger (./copilot). "Explain" on a tile and the
// follow-up chips go through the same card and have the model NARRATE it
// (`narrate`), audited the same way, so there is one card path for all three.
//
// A conversation turn stores the spec AND the card as it was computed, with its
// time (./answerSnapshots): reopening shows the figures the answer had, under the
// same access, and Refresh computes them again. `answer:card` draws a spec now,
// for a card that belongs to no turn.
//
// Registered from ./copilot's register(), which hands over its number guard —
// the guard is a safety control and there is exactly one of it.

import { specNames, specTerms, vocabularyFor } from './specVocabulary';
import { checkAction, vocabulary } from './answerCheck';
import { ipcMain } from './bus';
import { keepReads } from './askMemo';
import { lockedTable, withLockOf } from './rowDoors';
import { withoutColumns } from '../data/columnAccess';
import type { Lock } from '../data/rowLock';
import * as execConfig from '../app/execConfig';
import * as copilot from '../ai/copilot';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import { buildVizData } from '../analysis/vizData';
import { applyChartCalcs, type CalcSeries } from '../analysis/tableCalc';
import type { ChartData } from '../analysis/vizData';
import type { ValueLabelPairs } from '../analysis/valueLabels';
import { cardTextAsSeen, filterText, labelCardData, saidFilters, saidValue } from './valueLabelReplies';
import type { VizEncoding } from '../analysis/visuals';
import type { Cell, FilterStep } from '../data/transforms';
import { isKeptStep } from '../data/filterList';
import { isTermStep, type TERM_CODE } from '../data/termStep';
import { expandAnswerTerms } from '../analysis/termExpand';
import type { AnswerTerms } from '../analysis/termExpand';
import { tileCaption } from '../analysis/captions';
import { displayNames } from '../app/catalog';
import { navContext } from './modelNavigation';
import { askCopilot } from '../ai/analyze';
import {
  ANSWER_CHART_TYPES, answerChips, defaultAnswerChart, latestDate, periodsAfterData, sanitizeStoredSpec, specFilterSteps,
  splitCandidates, validateAnswerSpec,
} from '../ai/answerSpec';
import type { AnswerChip, AnswerSpec, SpecDataset } from '../ai/answerSpec';
import { canonicaliseTextFilters, heldValues, matchValues, nearestValueFixes } from '../ai/answerValues';
import { sanitizeLearn } from '../ai/answerSuggest';
import type { AnswerLearn, AnswerSuggest } from '../ai/answerSuggest';
import { noRowsMatch, periodAfterData, valueMatched } from '../ai/answerMessages';
import { formatDate } from '../app/format';
import { daysFromCivil } from '../analysis/categoryKey';
import { isoFromDays } from '../analysis/dateIntel';
import { saveCardAsVisual } from './answerSave';
import { learnState, registerSnapshots, snapshotFor, turnsForBrowser, type BrowserTurn } from './answerSnapshots';
import { isRefine, refineSpec, sameChart } from '../ai/answerRefine';
import { previousAnswerBlock } from '../ai/previousAnswer';
import { withheldColumns } from '../app/sharePolicy';
import { cardFacts, describeAnswer, withheldFilters } from '../ai/answerFacts';
import type { Headline } from '../ai/answerFacts';
import type { LedgerEntry, NumberAudit } from '../ai/numberAudit';
import type { SuggestedAction } from '../ai/suggestedAction';
import type { AsOf } from '../api/asOf';
import { asOfFrom, utcLabel } from '../data/figureAsOf';
import type { LiveFailureCode } from '../engine/live/liveQuery';
import { answerNames } from '../engine/live/liveMissing';
import { liveCardFor } from './liveAnswers';
import { filterLabels as labelsSaid } from './filterLabels';
import { liveWithheld } from './liveProfile';
import { isLive } from '../data/liveDataset';
import { ensureFresh } from '../data/freshOnAsk';
import { withPulls } from '../data/freshOnAskState';
import { withChartFigures } from '../analysis/chartShapes';
import { figureAsk } from '../analysis/figureAsk';
import { inSourceTable } from './sourceAnswers';
import { register as registerKeep } from './sourceKeep';
import type { AnswerLink } from './answerLink';
import { keepFirst, tableNote } from '../ai/sourceAnswerMessages';
import { snapshotMeasureRefusal } from '../analysis/snapshotGuards';
import { figureRefusal } from '../analysis/additivity';
import { pendingMeasureRefusal } from '../analysis/pendingKinds';
import { chartScope } from '../analysis/metricTimeScope';
import { hasVia } from '../analysis/joinPlan';
import { retiredNotes } from '../analysis/statusNotes';
import { instructionsGuidance } from './guidance';
import { verifiedMark } from './verifiedMark'; // "✓ Verified", by comparison at every draw (part 3 D9)
import { answeredFrom, register as registerSources, usesOf } from './answerSources'; // "Answered from ▾", "Also on ▸" (step 7)
// A cycle (./agentAsk imports this module): only used inside handlers, never at load.
import { askScope } from './agentAsk';
import type { Agent } from '../ai/agents';
import { outsideTopic } from '../ai/agentMessages';

export type Guard = (text: string, ledger: LedgerEntry[]) => { text: string; audit: NumberAudit };

/** What the renderer draws. Every figure on it was computed here. */
export interface AnswerCard {
  ok: true;
  spec: AnswerSpec;
  title: string;
  chartType: string;
  datasetName: string;
  /** Raw labels, with what a stored value is called beside them (./valueLabelReplies). */
  data: ChartData & { valueLabels?: ValueLabelPairs };
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
  /** The Visual its turn records it was saved as — only while that visual still exists. */
  savedVisualId?: string;
  /** The columns it reads, as the card names them (./answerSources `usesOf`): "Answered from ▾". */
  uses?: string[];
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
 * `code`: a Live dataset's typed failure (./liveAnswers) — the card says why, never an empty chart; `term`, a
 * filter it cannot apply (thrown by the door, typed by the route).
 * `suggest`: a refused spec named something that does not exist, and this is what it may have meant.
 */
/** `needs`: what an editor must add first (Ask an editor's reason): a link (outcome E, `link` the checked one), or a copy of a table not asked live. */
export type Failure = { ok: false; reason: string; code?: LiveFailureCode | typeof TERM_CODE; suggest?: AnswerSuggest; needs?: 'link' | 'copy'; link?: AnswerLink };

const OK_AUDIT: NumberAudit = { ok: true, violations: [] };

// ── Computing a card ─────────────────────────────────────────────────────────

/** A date column's latest day over these rows, ISO, or null. */
function endsOn(columns: { name: string }[], rows: Cell[][], column: string): string | null {
  const ci = columns.findIndex((c) => c.name === column);
  const d = ci < 0 ? null : latestDate(rows.map((r) => (r ? r[ci] ?? null : null)));
  return d ? isoFromDays(daysFromCivil(d.y, d.m, d.d)) : null;
}

/**
 * Largest first, and at most `top` of them. An answer about categories reads
 * best ranked; a date axis keeps time order and never takes a top-N.
 */
function ranked(data: ChartData, top?: number): ChartData {
  const first: CalcSeries | undefined = data.series[0];
  if (!first) return data;
  const by = first.raw ?? first.values; // the figures, never a calculated one: rank 1 is the largest
  const order = data.labels.map((_, i) => i).sort((a, b) => {
    const va = by[a];
    const vb = by[b];
    if (typeof va !== 'number') return typeof vb === 'number' ? 1 : a - b;
    if (typeof vb !== 'number') return -1;
    return vb - va || a - b;
  });
  const keep = top && top > 0 ? order.slice(0, top) : order;
  const pick = <T>(xs: T[]): T[] => keep.map((i) => xs[i]);
  return {
    labels: pick(data.labels),
    series: data.series.map((s: CalcSeries) => ({ name: s.name, values: pick(s.values), ...(s.calc && s.raw ? { raw: pick(s.raw), calc: s.calc } : {}) })),
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
/** THE answer door: row access rules first (./rowDoors — a refusal throws), then the body with the caller's lock. */
export async function computeCard(projectId: string, asked: AnswerSpec, loose = false): Promise<Built | Failure> {
  if (!asked.table) return cardOf(projectId, asked, loose);
  // An answer read straight from a source table runs inside its Live view (./sourceAnswers), or is refused.
  const built = await inSourceTable(projectId, asked, () => cardOf(projectId, asked, loose), true);
  return 'card' in built ? { ...built, provenance: { ...built.provenance, note: tableNote() } } : built;
}

async function cardOf(projectId: string, asked: AnswerSpec, loose: boolean): Promise<Built | Failure> {
  // A glossary term is expanded FIRST (a refusal THROWS, typed 'term'), before the lock and the Live split; the card keeps the reference.
  const x = await expandAnswerTerms(projectId, asked);
  const built = await withLockOf(projectId, x.spec && x.spec.datasetId, (lock, hidden) => computeCardWith(projectId, x.spec, loose, lock, x, hidden), [x.spec, x.steps]); // the question: the spec and its terms' steps
  const out = x.terms.length && 'card' in built ? withTermRefs(built, x) : built;
  if ('card' in out) {
    out.card.notes.push(...await retiredNotes(projectId, asked.measures.flatMap((m) => m.metricId ? [`metric:${m.metricId}`] : []))); // a retired metric still computes (D6); the card says what replaces it
    out.card.uses = await usesOf(projectId, out.card.spec); // extract and Live alike, kept with the card
  }
  return out;
}

/** The card as asked: each term back in its spec (and its chips'), its steps holding the reference in place of the expansion, so a save keeps it. */
function withTermRefs(built: Built, x: AnswerTerms): Built {
  const refs = x.terms.map((t) => ({ term: t.term }));
  const withRefs = (s: AnswerSpec): AnswerSpec => ({ ...s, filters: [...s.filters, ...refs] });
  const card = built.card;
  const chips = (list: AnswerChip[]): AnswerChip[] => list.map((c) => ({ ...c, spec: withRefs(c.spec) }));
  return {
    ...built,
    card: {
      ...card, spec: withRefs(card.spec), chips: chips(card.chips), steps: [...card.steps, ...(x.terms as unknown as FilterStep[])],
      ...(card.noMatch ? { noMatch: { ...card.noMatch, options: chips(card.noMatch.options) } } : {}),
    },
  };
}

async function computeCardWith(projectId: string, asked: AnswerSpec, loose: boolean, lock: Lock | null, terms: Pick<AnswerTerms, 'steps' | 'labels'> = { steps: [], labels: [] }, hidden: ReadonlySet<string> = new Set()): Promise<Built | Failure> {
  const asMeasures = { category: asked.category, values: asked.measures };
  const snapshot = (await pendingMeasureRefusal(projectId, asMeasures)) ?? (await snapshotMeasureRefusal(projectId, asMeasures, asked.datasetId)) // part 5's shapes first; extract and Live alike
    ?? (await figureRefusal(projectId, asked.datasetId, { ...asMeasures, ...(asked.series ? { series: asked.series } : {}) }, asked.chartType)); // a waterfall, Pareto or 100% stack adds its measure up, as a running total or a share does (D7)
  if (snapshot) return { ok: false, reason: snapshot };
  // A Live dataset is asked of its warehouse (L2.4, ./liveAnswers): ranked and cut there, never hydrated here. A term's steps join the lock: never skipped.
  const sayable = loose ? await labelsSaid(projectId, asked.datasetId, asked.filters) : undefined; // value labels a just-written spec may say (part 3 D6)
  const live = await liveCardFor(projectId, asked, [...(lock ? lock.steps : []), ...terms.steps], terms.labels, sayable);
  if (live) return live;
  await ensureFresh(projectId, [asked.datasetId]); // L3.1 fresh on ask: before the rows are read
  // ponytail: hydrates the dataset (periods, value matching and split chips all
  // read cells); a resident distinct-values query when answers over 1M rows feel slow.
  const stored = await datasets.getDataset(projectId, asked.datasetId);
  if (!stored) return { ok: false, reason: 'The dataset this answer was built on no longer exists.' };
  // Under a row access lock every helper below (value matching, period anchors, nearest values) sees entitled rows only.
  const ds = withoutColumns(lockedTable(stored, lock), hidden); // no hidden column reaches a match, a chip or a suggestion
  const has = (n: string): boolean => ds.columns.some((c) => c.name === n);
  const used = [asked.category, ...asked.measures.map((m) => m.column), ...asked.filters.flatMap((f) => ('column' in f ? [f.column] : []))]
    .concat(asked.series ? [asked.series] : []);
  const missing = used.find((n) => !has(n));
  if (missing) return { ok: false, reason: `"${missing}" is no longer a column of ${ds.name}.` };

  // What the filtered text columns hold: read once, for the loose match, the case fix and the empty answer's suggestions.
  const held = heldValues(asked.filters, ds.columns, ds.rows);
  const spec = loose ? matchValues(asked, held, sayable) : asked; // a label said becomes its stored value, within held
  const { steps, labels } = specFilterSteps(spec, ds.columns, ds.rows);
  canonicaliseTextFilters(steps, held);
  const filterLabels = [...labels, ...terms.labels]; // a glossary term reads as its name
  const encoding: VizEncoding = { category: spec.category, values: spec.measures };
  if (spec.series) encoding.series = spec.series;
  if (spec.grain) encoding.grain = spec.grain;
  const viz = buildVizData(ds.columns, ds.rows, encoding, [...steps, ...terms.steps]);

  const catCol = ds.columns.find((c) => c.name === spec.category);
  const isDate = !!catCol && catCol.type === 'date';
  // A measure's "Calculate as" (ai/answerCalc): on the aggregated grid, by the function a visual's reply goes through (`visual:data`).
  let data: ChartData = applyChartCalcs({ labels: viz.data.labels, series: viz.data.series }, encoding, viz.category, viz.warnings);
  if (!isDate) data = ranked(data, spec.top);

  const chartType = ANSWER_CHART_TYPES.has(spec.chartType) ? spec.chartType : defaultAnswerChart(catCol ? catCol.type : 'text', !!spec.series);
  data = withChartFigures(data, figureAsk(chartType)); // the figures the card draws (analysis/chartShapes), and its caption reads
  // A column the user gave a display name reads as that name (the catalog).
  const names = await displayNames(projectId, ds.id).catch(() => ({}));
  const caption = tileCaption({ chartType, data, names });
  const additive = spec.measures.every((m) => m.aggregation === 'sum' || m.aggregation === 'count');
  // The rows are already loaded, so their time comes off the same record — no second read.
  const read = asOfFrom([ds]);
  const asOf = read ? withPulls(read, projectId, [ds.id]) : read; // "· refreshing…" while a pull goes on (L3.1)
  // What a MODEL reads: a filter's value, and a label of the category or the split, on a column marked
  // personal or financial is withheld (ai/answerFacts `withheldFilters`, `cardFacts`). The card's own
  // labels and bullets, drawn for the person, are untouched.
  const withheld = await withheldColumns(projectId, ds.id);
  const saidFilterLabels = spec.filters.some((f) => 'column' in f && withheld.has(f.column))
    ? [...specFilterSteps({ filters: withheldFilters(spec.filters, withheld) }, ds.columns, ds.rows).labels, ...terms.labels] : undefined;
  const factsIn = {
    title: spec.title, datasetName: ds.name, describe: describeAnswer(spec), data,
    categoryIsDate: isDate, additive, filterLabels, saidFilterLabels, caption, ...(asOf ? { asOf: utcLabel(asOf.at) } : {}),
  };
  const facts = cardFacts(factsIn, spec, withheld);
  // What a PERSON reads says a stored value's label (F5), its filters' too (a value its locked rows hold); the model's facts above keep the value.
  const labelled = await labelCardData(projectId, ds.id, encoding, data, viz.category);
  const said = await filterText(projectId, ds.id, spec.filters, held);
  const shown = saidFilters(spec.filters, said, held);
  const shownLabels = shown === spec.filters ? filterLabels : [...specFilterSteps({ filters: shown }, ds.columns, ds.rows).labels, ...terms.labels];
  const seen = cardTextAsSeen(labelled.data, { chartType, names }, factsIn, { caption, headline: facts.headline, bullets: facts.bullets }, shownLabels);
  const say = (column: string, value: string): string => saidValue(said, held, column, value);
  // What the app did to a value comes first: it changes what the chart is about. The CARD's line, never the facts'.
  const notes = (spec.matched ?? []).map((m) => valueMatched(m.said, say(m.column, m.value), m.column)).concat(viz.warnings);
  if (viz.category && viz.category.note) notes.push(viz.category.note);
  notes.push(...labelled.notes, ...said.notes.filter((n) => !labelled.notes.includes(n)));
  // No rows because the period starts after the caller's rows end (a stale dataset): said, never another period.
  if (!data.labels.length) notes.push(...periodsAfterData(spec, (column) => endsOn(ds.columns, ds.rows, column)).map((p) => periodAfterData(p.label, ds.name, formatDate(p.ends))));
  // Nothing to draw because a value is not in its column: the nearest stored ones (said by their labels), never a marked column's.
  const near = data.labels.length ? null : nearestValueFixes(spec, held, withheld, say);

  return {
    card: {
      ok: true, spec, title: spec.title, chartType, datasetName: ds.name, data: labelled.data, ...seen,
      chips: answerChips(spec, { columns: ds.columns, splitCandidates: splitCandidates(ds.columns, ds.rows, spec.category), ...(await navContext(projectId, spec.datasetId)) }),
      filterLabels: shownLabels, steps, notes, ...(asOf ? { asOf } : {}),
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
/** `asked`: a model was called (one was ready), whether or not its words were kept. */
/** `agent`: the Assistant agent of the conversation (./agentAsk): its instructions after the project's, its model while enabled. */
export async function narrate(projectId: string, built: Built, question: string, guard: Guard, agent?: Agent | null): Promise<{ text: string; audit: NumberAudit; asked: boolean }> {
  if (!execConfig.assistantOn() || !(await execConfig.executionReady())) return { text: '', audit: OK_AUDIT, asked: false };
  const g = await instructionsGuidance(projectId, agent ? { name: agent.name, instructions: agent.instructions.map((i) => i.text) } : undefined); // the editors' instructions follow the card's facts (./guidance)
  const res = await askCopilot([], [built.factsText, g.text].filter(Boolean).join('\n\n'), question, undefined, { model: agent?.model });
  if (!res.ok || !res.text) return { text: '', audit: OK_AUDIT, asked: true };
  return { ...guard(res.text, built.ledger.concat(g.ledger)), asked: true };
}

// ── The three entry points ───────────────────────────────────────────────────

export { specDatasets, specMetrics, specTerms } from './specVocabulary'; // their home; named here for older callers

export interface AnswerTurn {
  ledger: LedgerEntry[];
  provenance: copilot.CopilotProvenance;
  spec: AnswerSpec;
  /** The card as computed, which the turn keeps (./answerSnapshots). */
  card: AnswerCard;
}

/**
 * The chart a follow-up continues: its stored spec, the block that tells the model about it, that block's
 * ledger, and the columns whose values the block withheld — which the merge must then not drop unseen.
 */
export interface PreviousAnswer { spec: AnswerSpec; block: string; ledger: LedgerEntry[]; withheld: ReadonlySet<string> }

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
  const asked = spec;
  const meta = asked ? await inSourceTable(projectId, asked, () => datasets.getDatasetMeta(projectId, asked.datasetId)) : null; // a table's answer: its view
  if (!spec || !meta) return null;
  if (answerNames(spec).some((n) => !meta.columns.some((c) => c.name === n))) return null;
  const ds: SpecDataset = { id: meta.id, name: meta.name, columns: meta.columns };
  const terms = (await vocabularyFor(projectId, { specs: [spec], datasetIds: [spec.datasetId] }))?.terms ?? (await specTerms(projectId)); // the terms it names, or every one (the reference)
  if (!validateAnswerSpec(refineSpec(spec, {}, ds), [ds], { terms }).ok) return null;
  // A Live dataset's set is its facts' own, stricter one (./liveProfile): pending and detected columns too.
  const withheld = isLive(meta) ? await liveWithheld(projectId, meta.id, meta) : await withheldColumns(projectId, meta.id);
  const { text, ledger } = previousAnswerBlock(spec, meta.name, withheld);
  return { spec, block: text, ledger, withheld };
}

/**
 * The dock's `answer` action → the card's spec, ledger and provenance, or the
 * reason it could not be built (the caller keeps the prose answer and says why).
 * No second model call: the turn's text is the action's own sentence, which the
 * caller audits against the facts and this card's ledger.
 *
 * `previous` is the answer a follow-up continues (`previousAnswer`). A spec
 * marked `"refine": true` is merged onto it by the app (ai/answerRefine) and the
 * MERGED spec is validated — refused with the validator's reason, never cut
 * back to the patch alone. A refine the merge could apply nothing of (a key it
 * does not read) is refused too: the previous chart again, under the
 * follow-up's title, is a wrong answer that looks right. Any other spec is a
 * new subject; it keeps nothing of the previous answer but its dataset, and
 * that only as the default after the screen's own.
 *
 * `withheld` is the previous answer's (`PreviousAnswer.withheld`): the columns
 * whose filter values the model was never shown, so could not restate.
 */
export async function answerFromAction(
  projectId: string,
  context: { kind?: string; id?: string },
  action: SuggestedAction,
  question: string,
  previous?: AnswerSpec,
  withheld?: ReadonlySet<string>,
  only?: ReadonlySet<string>, // an Assistant agent's topic: the datasets a spec may name (src/ipc/agentAsk.ts); none, every one
): Promise<({ ok: true } & AnswerTurn) | Failure> {
  const v = await checkAction(projectId, context, action, question, previous, withheld, only);
  if (!v.ok) return v;
  const base = v.base;
  const built = await computeCard(projectId, v.spec, true);
  if ('ok' in built) return built;
  // …also when it only became the previous chart once a value was matched to the one it already filtered to.
  if (base && sameChart(base, built.card.spec)) return { ok: false, reason: 'The follow-up changed nothing the app could apply.' };
  // The card's own spec: the validated one, with any filter value the app matched to what the data holds.
  return { ok: true, ledger: built.ledger, provenance: built.provenance, spec: built.card.spec, card: built.card };
}

/**
 * The dataset a NEW answer spec names when every dataset of the project counts, or null (a refine, or a spec that names
 * none the caller may use). Validation only, over metadata: nothing is computed. An agent's out-of-scope check (./agentAsk).
 */
export async function namedDataset(projectId: string, action: SuggestedAction): Promise<string | null> {
  if (!action.spec || isRefine(action.spec)) return null;
  const vocab = await vocabulary(projectId, { specs: [action.spec], anyDataset: !specNames([action.spec]).datasets.length }); // ./answerCheck
  const v = validateAnswerSpec(action.spec, vocab.datasets, { metrics: vocab.metrics, terms: vocab.terms });
  return v.ok ? v.spec.datasetId : null;
}

/** A saved chart (or a dashboard tile's live one) → the spec its card is built from. */
export function tileSpec(t: { datasetId: string; encoding: VizEncoding; filters: FilterStep[]; chartType: string; name: string }): AnswerSpec | null {
  // A step this pod cannot read (not a filter, not a term) has no place in a spec: none, never a widened chart.
  if ((t.filters || []).some((f) => isKeptStep(f) && !isTermStep(f))) return null;
  if (hasVia(t.encoding, t.filters)) return null; // a spec has no `via`: it would read the primary's same-named column
  const enc = t.encoding;
  const category = enc.category || (enc.pivot && enc.pivot.rows && enc.pivot.rows[0]) || '';
  const measures = (enc.values || []).map((m) => (m.aggregation === 'none' ? { ...m, aggregation: 'sum' as const } : m));
  const spec = sanitizeStoredSpec({
    datasetId: t.datasetId,
    category,
    measures,
    series: enc.series,
    grain: enc.grain,
    // A term step becomes { term } (a door expands it); the rest is a comparison. No step is ignored.
    filters: (t.filters || []).map((f) => {
      const s: unknown = f; // a term rides in FilterStep[] (filterList.ts shortcut), so the type cannot say so
      return isTermStep(s) ? { term: s.term } : { column: f.column, op: f.op, value: f.value, values: f.values };
    }),
    chartType: ANSWER_CHART_TYPES.has(t.chartType) ? t.chartType : 'column',
    title: t.name,
  });
  // sanitizeStoredSpec keeps a term only when it is a UUID and stops at the eighth filter: a filter lost there would widen the chart.
  return spec && spec.filters.length === (t.filters || []).length ? spec : null;
}

/** The question and its answer, the card kept with it (./answerSnapshots); the conversation's turns as the browser gets them. */
export async function appendAnswer(
  projectId: string, threadId: string | undefined, userText: string, text: string, built: Built, spec: AnswerSpec, learn?: AnswerLearn, guidance?: copilot.CopilotTurn['guidance'],
): Promise<{ turns: BrowserTurn[]; threadId: string | null }> {
  let target = threadId || (await copilot.latestThreadId(projectId)) || undefined;
  if (!target) target = (await copilot.createThread(projectId))?.id;
  const snapshot = await snapshotFor(projectId, built.card, spec);
  await copilot.appendTurn(projectId, { role: 'user', text: userText }, target);
  const turns = await copilot.appendTurn(projectId, {
    role: 'assistant', text, provenance: built.provenance, answer: spec, ...(snapshot ? { snapshot } : {}), ...(learn ? { learn } : {}), ...(guidance ? { guidance } : {}),
  }, target);
  return { turns: await turnsForBrowser(projectId, turns || []), threadId: target || null };
}

export function register(guard: Guard): void {
  registerSnapshots(computeCard); // `answer:refresh`, through THE answer door
  registerSources(); // `answer:alsoOn`
  registerKeep(); // `answer:keepTable` (./sourceKeep)
  // Draw one card from a spec, now: a card no conversation turn keeps (a turn's own
  // comes with its conversation, or from `answer:refresh`). `learn` is its turn's name to remember, and `savedVisualId` the visual it was
  // saved as — handed back only while that visual exists, so a deleted one is
  // offered to save again instead of a link to nothing.
  // Each handler below keeps its reads for its length (./askMemo), as copilot:ask does.
  ipcMain.handle('answer:card', keepReads(async (_e, { projectId, spec, learn, savedVisualId }: any = {}) => {
    try {
      const s = sanitizeStoredSpec(spec);
      if (!s) return { ok: false, reason: 'This answer could not be read.' };
      return await inSourceTable(projectId, s, async () => { // a source table's answer: its view for the card and its words alike
        const built = await computeCard(projectId, s);
        if ('ok' in built) return built;
        const said = sanitizeLearn(learn, s);
        const taught = said ? await learnState(projectId, s.datasetId, said) : undefined;
        const kept = typeof savedVisualId === 'string' && (await visuals.getVisual(projectId, savedVisualId)) ? savedVisualId : undefined;
        return { ...built.card, ...(taught ? { learn: taught } : {}), ...(kept ? { savedVisualId: kept } : {}), ...(await verifiedMark(projectId, built.card.spec)), ...(await answeredFrom(projectId, s.datasetId)) };
      }, true);
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'Could not build the answer' };
    }
  }));

  // "Explain" on a visual or a dashboard tile: the tile's facts, narrated when a
  // model is configured, as bullet points when not — in a NEW conversation.
  ipcMain.handle('answer:explain', keepReads(async (_e, { projectId, visualId, tile }: any = {}) => {
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
      // A spec keeps no `fromControl`, so the chart door's rewrite (a date control's period on the date the tile counts by) runs here, before the steps become one.
      const scoped = src ? await chartScope(projectId, src.datasetId, src.encoding, src.filters) : null;
      if (scoped && !scoped.ok) return { ok: false, reason: scoped.error };
      if (src && scoped) src = { ...src, filters: scoped.filters };
      const spec = src ? tileSpec(src) : null;
      if (!spec || !src) return { ok: false, reason: 'This chart cannot be explained.' };
      const built = await computeCard(projectId, spec);
      if ('ok' in built) return built;
      const n = await narrate(projectId, built,
        `Explain the chart "${src.name}" to the user in two or three sentences: what stands out, citing only figures from the facts.`,
        guard);
      const thread = await copilot.createThread(projectId);
      if (!thread) return { ok: false, reason: 'Could not start a conversation.' };
      const r = await appendAnswer(projectId, thread.id, `Explain “${src.name}”`, n.text, built, spec);
      return { ok: true, threadId: r.threadId, narrated: !!n.text };
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'Could not explain the chart' };
    }
  }));

  // A follow-up chip, or a "Did you mean" option: the chip's own spec, recomputed
  // by the app — no model call decides the chart, and one narrates it only when
  // configured. An option built from a refused spec still carries the filter
  // values as they were said, so they are matched here as an answer's are. An
  // option that put a column in place of a name sends `learn`, kept on the new
  // turn only for a column its answer uses (ai/answerSuggest `sanitizeLearn`).
  ipcMain.handle('answer:rerun', keepReads(async (_e, { projectId, threadId, spec, label, learn }: any = {}) => {
    try {
      const s = sanitizeStoredSpec(spec);
      if (!s) return { ok: false, reason: 'This follow-up could not be read.' };
      const tid = typeof threadId === 'string' && threadId ? threadId : undefined;
      // In an Assistant agent's conversation the agent narrates (./agentAsk), and a chart outside its topic is not its to
      // give: refused before anything is computed.
      const scope = await askScope(projectId, tid ? await copilot.agentOf(projectId, tid) : undefined);
      if (scope.only && scope.topic && !scope.only.has(s.datasetId)) return { ok: false, reason: outsideTopic(scope.topic.name) };
      const built = await computeCard(projectId, s, !(await verifiedMark(projectId, s)).verified); // a verified question's own spec (its chip) draws as stored
      if ('ok' in built) return built;
      const userText = typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : s.title;
      const n = await narrate(projectId, built,
        `Narrate this chart answer ("${s.title}") in two or three sentences, citing only figures from the facts.`,
        guard, scope.agent);
      const r = await appendAnswer(projectId, tid, userText, n.text, built, built.card.spec, sanitizeLearn(learn, built.card.spec));
      return { ok: true, turns: r.turns, threadId: r.threadId };
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'Could not run the follow-up' };
    }
  }));

  // "Save as visual": the card is rebuilt HERE from the spec — its encoding and its
  // filter steps are the server's, never a client's — and saved as it was drawn (./answerSave).
  // `threadId` + `turnId` name the answer turn it came from, which then keeps the visual's id.
  ipcMain.handle('answer:saveVisual', async (_e, { projectId, spec, threadId, turnId }: any = {}) => {
    try {
      const s = sanitizeStoredSpec(spec);
      if (!s) return { ok: false, reason: 'This answer could not be read.' };
      if (s.table) return { ok: false, reason: keepFirst() }; // a visual names a dataset: Keep as a dataset makes it (./sourceKeep)
      const built = await computeCard(projectId, s);
      if ('ok' in built) return built;
      const saved = await saveCardAsVisual(projectId, built.card);
      if (saved.ok && typeof threadId === 'string' && typeof turnId === 'string') await copilot.markSaved(projectId, threadId, turnId, s, saved.visual.id);
      return saved;
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'Could not save the visual' };
    }
  });
}
