// Insights — things the app FOUND in a dataset, each with a number it computed
// and a chart it can draw. MAIN PROCESS. No DOM, no fs.
//
// THE APP DOES THE MATH. Every figure below is computed here or by
// `residentQuery.aggregateResident`; a model never contributes one and never
// sees this file. The dock may later NARRATE these figures (src/ipc/copilot.ts
// feeds them in as FACTS) — that is the only AI involvement, and it is optional.
//
// ── One rule set, two aggregators ────────────────────────────────────────────
// The house style is "resident fast path + JS reference, differentially tested".
// The naive reading of that is two copies of every rule, which is two places to
// get `movers` wrong. Instead the THREE new rules below are written ONCE against
// a one-function aggregator:
//
//   type Agg = (category, measure, filters?) => { labels, values } | null
//
// and it is the AGGREGATOR that is twinned, in `insightsAgg.ts`. The rules, the
// thresholds, the rounding, the ranking and every string are shared, so the two
// paths cannot drift in the only way that would produce a WRONG figure rather
// than a slow one. `scripts/test-insights.ts` still asserts the two agree with
// `Object.is`, end to end through this file.
//
// The five anomaly kinds are NOT reimplemented here: `fromAnomaly` lifts an
// existing `anomalies.Anomaly` into an `Insight`, so the detector stays the one
// in `anomalies.ts` and its own resident twin keeps serving it.

import type { ColumnType, ParsedColumn } from '../data/parse';
import type { Anomaly } from './anomalies';
import {
  DEFAULTS, foldPeriods, measureEncoding, orderPeriods, periodPlan, round,
} from './insightsAgg';
import type { Agg, AggOut, Insight, InsightChart, InsightKind, InsightOptions } from './insightsAgg';
import { formatNumber, formatPercent } from '../app/format';
import { t } from '../app/i18n';

/** A figure in a sentence, as the workspace writes numbers (format.ts). */
const fmtNum = (n: number): string => formatNumber(round(n), { maxDecimals: 2 });
/** |ratio| as a percent, one decimal at most: 0.5 → "50%". */
const pctAbs = (ratio: number): string => formatPercent(Math.abs(ratio), 1, { maxOnly: true });

// The shapes and the two aggregators are this module's public surface too —
// a caller wants `insights.residentAgg`, not a second import of a file whose
// name is an implementation detail.
export type { Agg, Insight, InsightChart, InsightKind, InsightOptions } from './insightsAgg';
export { jsAgg, residentAgg } from './insightsAgg';

// Cost bounds. Each is a query count, not a taste. One dataset scan is
// MEASURES_SCANNED (picking the measures, and the series `trend` then reuses
// from cache) + TEXT_COLS × MEASURES (concentration, which also decides which
// columns are dimensions) + 2 × MOVER_TRIPLES (a before and an after per
// triple) aggregates — 38 statements at the values below, and no more however
// wide the table is.
const MEASURES = 3;
const TEXT_COLS = 6;
const MOVER_TRIPLES = 6;
/** A category column is a dimension, not an id column and not a flag. */
const MIN_CATS = 2;
const MAX_CATS = 30;
/** Fewest periods a least-squares line is worth fitting. */
const MIN_TREND_PERIODS = 4;
const TREND_PERIODS = 12;
/** Below this many categories "3 of 4 are 62%" is not a finding. */
const MIN_CONCENTRATION_CATS = 4;
/** A concentrated head is a SMALL head — at most this fraction of categories. */
const MAX_HEAD_FRACTION = 0.25;
/** Movers reported per direction. */
const TOP_MOVERS = 3;
/**
 * A mover must move a MEANINGFUL slice of the period, not just a big percentage
 * of a small number. Measured on the bundled sample: without this, the top
 * twelve cards were all four-cent discount swings reading "rose 1000%".
 */
const MOVER_MIN_CONTRIBUTION = 0.02;
/**
 * Past +1000% the story is the BASE, not the change — the prior period was
 * effectively zero, and "rose 259159%" is a true figure that tells the reader
 * nothing. Such a finding is suppressed AS A CARD; the underlying anomaly is
 * untouched, so the watch and the explain path still report it.
 */
const MAX_CREDIBLE_PCT = 10;
/** Number columns considered before the three biggest are picked as measures. */
const MEASURES_SCANNED = 8;

// ── the three rules ──────────────────────────────────────────────────────────

interface Ctx {
  datasetId: string;
  agg: Agg;
  o: Required<InsightOptions>;
}



/**
 * Largest movers between the latest period and the one before it.
 *
 * ponytail: "latest COMPLETE period" is taken to be the last distinct value of
 * the date column. Deciding a period is half-elapsed needs a calendar this app
 * does not have; the ceiling is that a partial final month reads as a drop.
 * Upgrade path: roll up through `categoryKey.chooseGrain` and drop a final
 * bucket whose span has not closed.
 */
async function moverInsights(ctx: Ctx, dateCol: string, measure: string, catCol: string): Promise<Insight[]> {
  const raw = await ctx.agg(dateCol, measure);
  if (!raw || raw.labels.length < 2) return [];
  const plan = periodPlan(raw.labels);
  const ordered = orderPeriods([...foldPeriods(raw, plan).keys()]);
  if (ordered.length < 2) return [];
  const now = ordered[ordered.length - 1];
  const prev = ordered[ordered.length - 2];

  const at = (p: string): ReturnType<Agg> =>
    ctx.agg(catCol, measure, [{ type: 'filter', column: dateCol, op: plan.op, value: p }]);
  const before = await at(prev);
  const after = await at(now);
  if (!before || !after) return [];

  const prevBy = new Map<string, number>();
  before.labels.forEach((l, i) => { const v = before.values[i]; if (typeof v === 'number') prevBy.set(l, v); });
  const nowBy = new Map<string, number>();
  after.labels.forEach((l, i) => { const v = after.values[i]; if (typeof v === 'number') nowBy.set(l, v); });

  // The period's own total is the yardstick for "does this matter" — it comes
  // free from the period fold above, so materiality costs no extra query.
  const periodTotal = Math.abs(foldPeriods(raw, plan).get(now) ?? 0);

  const moves: { cat: string; from: number; to: number; delta: number; pct: number | null; share: number }[] = [];
  for (const cat of new Set([...prevBy.keys(), ...nowBy.keys()])) {
    const from = prevBy.get(cat) ?? 0;
    const to = nowBy.get(cat) ?? 0;
    const delta = to - from;
    if (delta === 0) continue;
    const pct = from === 0 ? null : delta / from;
    if (pct !== null && Math.abs(pct) > MAX_CREDIBLE_PCT) continue; // base effect, not a story
    const share = periodTotal > 0 ? Math.abs(delta) / periodTotal : 0;
    if (share < MOVER_MIN_CONTRIBUTION) continue;
    moves.push({ cat, from, to, delta, pct, share });
  }
  // Deterministic: by magnitude, ties broken by name so two machines agree.
  const byDelta = (a: typeof moves[0], b: typeof moves[0]): number =>
    b.delta - a.delta || a.cat.localeCompare(b.cat);
  moves.sort(byDelta);
  const picked = [...moves.slice(0, TOP_MOVERS), ...moves.slice(-TOP_MOVERS).filter((m) => m.delta < 0)];

  const seen = new Set<string>();
  const out: Insight[] = [];
  for (const m of picked) {
    if (seen.has(m.cat)) continue;
    seen.add(m.cat);
    // Figures in the prose are written by format.ts (Settings → General → Formats);
    // `facts` below keeps the raw numbers.
    const pctText = m.pct === null ? '' : ` ${pctAbs(m.pct)}`;
    out.push({
      id: `${ctx.datasetId}:mover:${catCol}:${measure}:${m.cat}:${now}`,
      kind: 'mover',
      title: t('insights.in', { cat: m.cat, measure, p2: !!(m.delta > 0), pctText, now }),
      detail:
        t('insights.for_from_in_to_in', { measure, cat: m.cat, p2: !!(m.delta > 0), from: fmtNum(m.from), prev, to: fmtNum(m.to), now, p7: (m.pct === null ? t('insights.no_prior_value_to_compare_against') : t('insights.a_change_of', { delta: fmtNum(m.delta), p1: formatPercent(m.pct, 1, { maxOnly: true }) })) }),
      severity: m.pct !== null && Math.abs(m.pct) >= ctx.o.moverWarnPct ? 'warn' : 'info',
      datasetId: ctx.datasetId,
      column: catCol,
      periodKey: now,
      facts: {
        category: m.cat, measure, dateColumn: dateCol,
        fromPeriod: prev, toPeriod: now,
        prev: round(m.from), now: round(m.to), change: round(m.delta),
        // The share of the whole period this one change accounts for. It is
        // what ranks the card, and it is an app-computed figure like any other.
        contribution: round(m.share),
        ...(m.pct === null ? {} : { pctChange: round(m.pct) }),
      },
      chart: {
        type: 'line',
        encoding: measureEncoding(dateCol, measure),
        filters: [{ type: 'filter', column: catCol, op: '=', value: m.cat }],
      },
    });
  }
  return out;
}

/** Least-squares slope over the last 12 periods, reported past ±trendPct. */
async function trendInsight(ctx: Ctx, dateCol: string, measure: string): Promise<Insight | null> {
  const agg = await ctx.agg(dateCol, measure);
  if (!agg) return null;
  const by = foldPeriods(agg, periodPlan(agg.labels));
  const periods = orderPeriods([...by.keys()]).slice(-TREND_PERIODS);
  const n = periods.length;
  if (n < MIN_TREND_PERIODS) return null;

  const ys = periods.map((p) => by.get(p) as number);
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - xMean) * (ys[i] - yMean);
    den += (i - xMean) * (i - xMean);
  }
  if (den === 0) return null;
  const slope = num / den;
  const start = yMean - slope * xMean; // the fitted value at period 0
  const change = slope * (n - 1);
  if (start === 0) return null;
  const ratio = change / Math.abs(start);
  if (Math.abs(ratio) <= ctx.o.trendPct) return null;

  return {
    id: `${ctx.datasetId}:trend:${dateCol}:${measure}:${periods[0]}:${periods[n - 1]}`,
    kind: 'trend',
    title: t('insights.trended_over_periods', { measure, p1: !!(change > 0), ratio: pctAbs(ratio), n }),
    detail:
      t('insights.a_least_squares_line_through_over', { measure, n, p2: periods[0], p3: periods[n - 1], p4: !!(change > 0), p5: fmtNum(Math.abs(change)), p6: formatPercent(ratio, 1, { maxOnly: true }) }),
    severity: 'info',
    datasetId: ctx.datasetId,
    column: measure,
    periodKey: periods[n - 1],
    facts: {
      measure, dateColumn: dateCol, periods: n,
      firstPeriod: periods[0], lastPeriod: periods[n - 1],
      slope: round(slope), change: round(change), pctChange: round(ratio),
    },
    chart: { type: 'line', encoding: measureEncoding(dateCol, measure) },
  };
}

/** Pareto: the smallest head of categories that carries most of a measure. */
function concentrationInsight(
  ctx: Ctx,
  catCol: string,
  measure: string,
  agg: { labels: string[]; values: (number | null)[] },
): Insight | null {
  const pairs: { cat: string; v: number }[] = [];
  agg.labels.forEach((l, i) => { const v = agg.values[i]; if (typeof v === 'number' && v > 0) pairs.push({ cat: l, v }); });
  const n = pairs.length;
  if (n < MIN_CONCENTRATION_CATS) return null;
  const total = pairs.reduce((a, b) => a + b.v, 0);
  if (total <= 0) return null;
  pairs.sort((a, b) => b.v - a.v || a.cat.localeCompare(b.cat));

  let head = 0;
  let cum = 0;
  while (head < n && cum / total < ctx.o.concentrationShare) {
    cum += pairs[head].v;
    head += 1;
  }
  if (head / n > MAX_HEAD_FRACTION) return null;
  const share = cum / total;

  return {
    id: `${ctx.datasetId}:concentration:${catCol}:${measure}`,
    kind: 'concentration',
    title: t('insights.of_are_of', { head, n, catCol, p3: formatPercent(share, 0), measure }),
    detail:
      t('insights.the_top_of_values_in_carry', { head, n, catCol, cum: fmtNum(cum), total: fmtNum(total), measure, p6: formatPercent(share, 1, { maxOnly: true }), p7: pairs[0].cat, p8: formatPercent(pairs[0].v / total, 1, { maxOnly: true }) }),
    severity: 'info',
    datasetId: ctx.datasetId,
    column: catCol,
    facts: {
      measure, categories: n, head,
      headTotal: round(cum), total: round(total), share: round(share),
      topCategory: pairs[0].cat, topShare: round(pairs[0].v / total),
    },
    chart: { type: 'column', encoding: measureEncoding(catCol, measure) },
  };
}

// ── anomalies → insights ─────────────────────────────────────────────────────

/**
 * Lift an already-DETECTED anomaly. Nothing is recomputed: `detail`, `severity`
 * and every fact are the detector's own, so the figure on a card is the figure
 * `anomalies.ts` (or its resident twin) produced.
 */
export function fromAnomaly(datasetId: string, a: Anomaly, columns: ParsedColumn[]): Insight | null {
  const col = a.column;
  // A change off a near-zero base ("profit rose 259159% on 2024-11-03") is a
  // true figure that tells a reader nothing, and it would headline every card
  // surface it appeared on. Suppressed HERE, as a card — the Anomaly itself is
  // untouched, so the refresh watch and `dashboard:explainAnomalies` still
  // report it exactly as they do today.
  if (typeof a.facts.pctChange === 'number' && Math.abs(a.facts.pctChange) > MAX_CREDIBLE_PCT) return null;
  const type = col ? columns.find((c) => c && c.name === col)?.type : undefined;
  let chart: InsightChart | undefined;
  if (col && (a.kind === 'numeric_outlier' || a.kind === 'dominant_category')) {
    chart = { type: 'column', encoding: { category: col, values: [{ column: col, aggregation: 'count' }] } };
  } else if (col && a.kind === 'period_change' && typeof a.facts.dateColumn === 'string') {
    chart = { type: 'line', encoding: measureEncoding(String(a.facts.dateColumn), col) };
  }
  return {
    id: `${datasetId}:${a.kind}:${col ?? ''}:${a.facts.toPeriod ?? ''}`,
    kind: a.kind,
    title: anomalyTitle(a, type),
    detail: a.detail,
    severity: a.severity,
    datasetId,
    column: col,
    facts: a.facts,
    chart,
    periodKey: typeof a.facts.toPeriod === 'string' ? a.facts.toPeriod : undefined,
  };
}

/** A card title is one line; `Anomaly.detail` is a sentence. App-authored. */
function anomalyTitle(a: Anomaly, type?: ColumnType): string {
  const col = a.column ?? '';
  switch (a.kind) {
    case 'numeric_outlier':
      return t('insights.has_outside_its_expected_range', { col, count: a.facts.count });
    case 'dominant_category':
      return t('insights.is_of', { value: a.facts.value, p1: formatPercent(Number(a.facts.share), 0), col });
    case 'period_change':
      return `${col} ${Number(a.facts.pctChange) >= 0 ? 'rose' : 'fell'} ` +
        `${pctAbs(Number(a.facts.pctChange))} in ${a.facts.toPeriod}`;
    case 'empty_heavy':
      return t('insights.is_mostly_empty', { col });
    default:
      return t('insights.never_changes_2', { col, p1: !!(type === 'number') });
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/** Rank: warn before info, then by magnitude. Cap per kind, then in total. */
export function rankInsights(
  list: Insight[],
  maxTotal = DEFAULTS.maxTotal,
  maxPerKind = DEFAULTS.maxPerKind,
): Insight[] {
  // Magnitude is always a SHARE in [0,1], never a raw percentage. Ranking on
  // `pctChange` puts the smallest base first — a 1000% swing on four cents
  // outranks a 12% fall in revenue — which is the opposite of what a reader
  // wants. `contribution` (a mover's slice of its period) and `share` (a
  // concentration head) already are shares; a bare percentage is clamped so it
  // can compete with them without dominating them.
  const magnitude = (i: Insight): number => {
    const f = i.facts || {};
    for (const k of ['contribution', 'share']) {
      const v = f[k];
      if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v);
    }
    const pct = f.pctChange;
    if (typeof pct === 'number' && Number.isFinite(pct)) return Math.min(Math.abs(pct), 1);
    return 0;
  };
  const sorted = list.slice().sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'warn' ? -1 : 1;
    return magnitude(b) - magnitude(a) || a.id.localeCompare(b.id);
  });
  // Per-kind cap FIRST, in ranked order, so the best of each kind survives and
  // one prolific rule cannot fill the row (anomalies.ts caps the same way, and
  // for the same reason). Then the total cap.
  const perKind = new Map<InsightKind, number>();
  const kept: Insight[] = [];
  for (const i of sorted) {
    const n = perKind.get(i.kind) ?? 0;
    if (n >= maxPerKind) continue;
    perKind.set(i.kind, n + 1);
    kept.push(i);
  }
  return kept.slice(0, maxTotal);
}

/**
 * The three new kinds over one dataset, through whichever aggregator is handed
 * in. Never throws — a bad input or a dead aggregator yields [].
 *
 * The anomaly kinds are added by the CALLER (`ipc/insights.ts`), which already
 * owns the resident/JS choice for `detectAnomalies` and must not make it twice.
 */
export async function detectInsights(
  datasetId: string,
  columns: ParsedColumn[],
  agg: Agg,
  opts?: InsightOptions,
): Promise<Insight[]> {
  try {
    const cols = Array.isArray(columns) ? columns.filter((c) => c && typeof c.name === 'string') : [];
    if (cols.length === 0 || typeof agg !== 'function') return [];
    const o = { ...DEFAULTS, ...(opts || {}) };
    const ctx: Ctx = { datasetId, agg, o };

    const dateCols = cols.filter((c) => c.type === 'date').map((c) => c.name);
    const dateCol = dateCols[0];
    const numberCols = cols.filter((c) => c.type === 'number').map((c) => c.name).slice(0, MEASURES_SCANNED);
    const textCols = cols.filter((c) => c.type === 'text').map((c) => c.name).slice(0, TEXT_COLS);
    const found: Insight[] = [];

    // WHICH THREE COLUMNS ARE THE MEASURES.
    //
    // "The first three number columns" picked `units, unit_price, discount` on
    // the bundled sample and left `revenue` and `profit` out — the two anyone
    // opening a retail table wants. Picking by TOTAL MAGNITUDE instead is
    // data-driven rather than name-driven, and it costs nothing extra: the
    // per-measure period series it needs is the same one `trendInsight` and
    // `moverInsights` go on to use, so the aggregate is computed once and
    // cached here. With no date column there is nothing to total over and the
    // first three stand, which is the old behaviour unchanged.
    const periodSeries = new Map<string, NonNullable<AggOut>>();
    let measures = numberCols.slice(0, MEASURES);
    if (dateCol) {
      const scale: { name: string; total: number }[] = [];
      for (const name of numberCols) {
        const out = await ctx.agg(dateCol, name);
        if (!out) continue;
        periodSeries.set(name, out);
        let total = 0;
        for (const v of out.values) if (typeof v === 'number') total += Math.abs(v);
        scale.push({ name, total });
      }
      if (scale.length) {
        scale.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
        measures = scale.slice(0, MEASURES).map((x) => x.name);
      }
    }
    // Serve the cached series to the two rules that want it, transparently.
    const cachedAgg: Agg = (category, measure, filters) =>
      (!filters && category === dateCol && periodSeries.has(measure)
        ? (periodSeries.get(measure) as NonNullable<AggOut>)
        : agg(category, measure, filters));
    ctx.agg = cachedAgg;

    // Concentration and movers ask different things of a text column, so they
    // have different gates: "3 of 40 states are 62% of revenue" is the FINDING,
    // while a 40-way mover breakdown is a table, not a card. One query serves
    // both — `labels.length` IS the distinct count of the non-empty cells.
    const dimensions: string[] = [];
    for (const catCol of textCols) {
      for (const measure of measures) {
        const out = await ctx.agg(catCol, measure);
        if (!out) continue;
        if (!dimensions.includes(catCol) && out.labels.length >= MIN_CATS && out.labels.length <= MAX_CATS) {
          dimensions.push(catCol);
        }
        const c = concentrationInsight(ctx, catCol, measure, out);
        if (c) found.push(c);
      }
    }

    if (dateCol) {
      for (const measure of measures) {
        const t = await trendInsight(ctx, dateCol, measure);
        if (t) found.push(t);
      }
      let triples = 0;
      for (const catCol of dimensions) {
        for (const measure of measures) {
          if (triples >= MOVER_TRIPLES) break;
          triples += 1;
          found.push(...(await moverInsights(ctx, dateCol, measure, catCol)));
        }
      }
    }

    return rankInsights(found, o.maxTotal, o.maxPerKind);
  } catch (_) {
    return []; // never throws — a broken aggregator means no findings, not a crash
  }
}

// i18n-skip-begin — the model's frame stays English; the Assistant is told which
// language to answer in (src/app/i18n.ts languageInstruction), and the insight
// lines it quotes are already in the reader's language.
// PURE facts block for the model. Same guard-line contract as
// `anomalies.buildAnomaliesFacts`: the model cites, it does not compute.
const GUARD_LINE =
  'The insights below were FOUND and MEASURED by the app (Ordinate), not by you. ' +
  'Treat every figure as ground truth: cite them exactly and NEVER recompute, round, or invent one.';

export function buildInsightsFacts(datasetName: string, list: Insight[]): string {
  const items = Array.isArray(list) ? list : [];
  const lines: string[] = [GUARD_LINE, ''];
  if (items.length === 0) {
    lines.push(`Nothing stands out in dataset "${datasetName}".`);
    return lines.join('\n');
  }
  lines.push(`Insights found in dataset "${datasetName}" (${items.length}, all figures app-computed):`);
  for (const i of items) lines.push(`- [${i.severity}] ${i.detail}`);
  return lines.join('\n');
}
// i18n-skip-end
