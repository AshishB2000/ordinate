// The FACTS of one answer card — MAIN PROCESS, PURE: no fs, no DOM, no model.
//
// An answer card (a question answered with a chart, or a tile's "Explain")
// carries exactly one set of figures, and every surface that says a number
// about it reads THIS set: the headline numbers on the card, the bullet points
// shown when no model is configured, the FACTS block the model narrates from,
// and the LEDGER that narration is audited against. One pass, one source —
// the rule copilotFacts.ts states for every other facts block, for the same
// reason: a figure that reached the prompt without reaching the ledger becomes
// a false accusation under a correct answer.
//
// Nothing here aggregates a row. The {labels, series} arrive from vizData (the
// same numbers the chart draws); this file only reads extremes, totals, shares
// and the last period's change off them, and says which is which.

import type { ChartData } from '../analysis/vizData';
import { compact } from '../analysis/captions';
import { harvestAppNumbers } from './numberAudit';
import type { LedgerEntry, LedgerUnit } from './numberAudit';
import type { AnswerSpec } from './answerSpec';

/** The spec in words — "sum of revenue by region, split by tier" — for `AnswerFactsInput.describe`. */
export function describeAnswer(spec: AnswerSpec): string {
  const ms = spec.measures.map((m) => `${m.aggregation} of ${m.column}`).join(', ');
  return `${ms} by ${spec.category}${spec.series ? `, split by ${spec.series}` : ''}`;
}

const GUARD_LINE =
  'The numbers below were computed by the app (Ordinate), not by you. ' +
  'Treat them as ground truth: cite them exactly and NEVER recompute, round, or invent a figure.';

export interface AnswerFactsInput {
  title: string;
  datasetName: string;
  /** e.g. "sum of revenue by region" — app-written from the spec. */
  describe: string;
  data: ChartData;
  /** A date category makes "the latest period" and its change meaningful. */
  categoryIsDate: boolean;
  /** Sum and count add up; an average or a max does not, so no total or share. */
  additive: boolean;
  /** One per filter in force, e.g. "order_date: 2024-Q4". */
  filterLabels: string[];
  caption: string;
  /**
   * When the rows are from, already worded ("Oct 9, 2026, 1:00 AM UTC" —
   * data/figureAsOf.utcLabel), so the narration can say "as of 1:00 AM" by
   * copying it. A time, not a figure: numberAudit masks it on both sides, so
   * its digits neither enter the ledger nor count against the answer.
   */
  asOf?: string;
}

export interface Headline {
  label: string;
  value: number;
  display: string;
}

export interface AnswerFacts {
  text: string;
  ledger: LedgerEntry[];
  /** The facts as sentences — what the card shows when no model narrates. */
  bullets: string[];
  headline: Headline[];
}

function num(ledger: LedgerEntry[], label: string, value: number | null | undefined, unit: LedgerUnit): void {
  if (typeof value === 'number' && Number.isFinite(value)) ledger.push({ label, value, unit, source: 'answer' });
}

/** One decimal, trailing ".0" kept off: 27.8%, 30%, -4.2%. */
export function pct(v: number): string {
  const r = Math.round(v * 10) / 10;
  return (Object.is(r, -0) ? 0 : r) + '%';
}

interface Mark { label: string; value: number }

function marks(data: ChartData, s: number): Mark[] {
  const series = data.series[s];
  if (!series) return [];
  const out: Mark[] = [];
  data.labels.forEach((lab, i) => {
    const v = series.values[i];
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ label: String(lab), value: v });
  });
  return out;
}

function extremes(ms: Mark[]): { hi: Mark; lo: Mark } | null {
  if (!ms.length) return null;
  let hi = ms[0];
  let lo = ms[0];
  for (const m of ms) {
    if (m.value > hi.value) hi = m;
    if (m.value < lo.value) lo = m;
  }
  return { hi, lo };
}

/** "sum of revenue" → "revenue" — the noun a sentence uses. */
function noun(seriesName: string): string {
  return seriesName.replace(/^(sum|avg|min|max|count) of /, '');
}

/**
 * The card's figures. `data` is exactly what the chart plots — after any top-N
 * cut the spec asked for, so "the lowest" is the lowest bar the reader can see.
 */
export function answerFacts(input: AnswerFactsInput): AnswerFacts {
  const { data } = input;
  const ledger: LedgerEntry[] = [];
  const bullets: string[] = [];
  const headline: Headline[] = [];
  const lines: string[] = [GUARD_LINE, ''];

  lines.push(`Answer: "${input.title}" — ${input.describe}, over dataset "${input.datasetName}".`);
  if (input.asOf) lines.push(`Data as of: ${input.asOf}.`);
  if (input.filterLabels.length) lines.push(`Filtered to: ${input.filterLabels.join('; ')}.`);

  const labels = Array.isArray(data.labels) ? data.labels : [];
  const series = Array.isArray(data.series) ? data.series : [];
  if (!labels.length || !series.length) {
    lines.push('', 'The answer produced no plottable values.');
    bullets.push('No rows match this question, so there is nothing to chart.');
    const text = lines.join('\n');
    seal(ledger, text);
    return { text, ledger, bullets, headline };
  }

  lines.push('', 'Chart values (app-computed):');
  series.forEach((s) => {
    lines.push(`- ${s.name}: ${labels.map((lab, i) => `${lab}=${fmtRaw(s.values[i])}`).join(', ')}`);
    labels.forEach((lab, i) => num(ledger, `${s.name} @ ${lab}`, s.values[i], 'number'));
  });

  // Per series: extremes, and — only where adding up means something — the total
  // and the leader's share of it. A split answer states each series separately;
  // the first series is the headline.
  series.forEach((s, si) => {
    const ms = marks(data, si);
    const ex = extremes(ms);
    if (!ex) return;
    const what = noun(s.name);
    lines.push('');
    lines.push(`${s.name} — ${ms.length} ${input.categoryIsDate ? 'periods' : 'values'}.`);
    num(ledger, `${s.name}: count of marks`, ms.length, 'count');

    const total = input.additive ? ms.reduce((a, m) => a + m.value, 0) : null;
    const allPositive = ms.every((m) => m.value >= 0);
    if (total !== null) {
      lines.push(`Total ${what}: ${total}.`);
      num(ledger, `total ${s.name}`, total, 'number');
    }
    lines.push(`Highest: ${ex.hi.label} at ${ex.hi.value}. Lowest: ${ex.lo.label} at ${ex.lo.value}.`);

    let share: number | null = null;
    if (total !== null && total > 0 && allPositive && ms.length > 1) {
      share = (ex.hi.value / total) * 100;
      lines.push(`${ex.hi.label} is ${share}% of the total.`);
      num(ledger, `${ex.hi.label} share of ${s.name}`, share, 'percent');
    }

    // The latest period against the one before — only on a date axis, where
    // "latest" is a fact about time rather than about sort order.
    let change: { prev: Mark; last: Mark; pct: number | null } | null = null;
    if (input.categoryIsDate && ms.length >= 2) {
      const last = ms[ms.length - 1];
      const prev = ms[ms.length - 2];
      const p = prev.value !== 0 ? ((last.value - prev.value) / Math.abs(prev.value)) * 100 : null;
      change = { prev, last, pct: p };
      lines.push(`Latest period ${last.label}: ${last.value}; previous ${prev.label}: ${prev.value}` +
        (p === null ? '.' : `; change ${p}%.`));
      num(ledger, `${s.name} change, ${prev.label} to ${last.label}`, p, 'percent');
      num(ledger, `${s.name} difference, ${prev.label} to ${last.label}`, last.value - prev.value, 'number');
    }

    if (si > 1) return; // bullets and headline for the first two series only
    const tail = series.length > 1 ? ` (${s.name})` : '';
    if (input.categoryIsDate && change) {
      bullets.push(`The latest period, ${change.last.label}, is ${compact(change.last.value)}` +
        (change.pct === null ? '' : `, ${change.pct >= 0 ? 'up' : 'down'} ${pct(Math.abs(change.pct))} on ${change.prev.label}`) + `${tail}.`);
      bullets.push(`The peak is ${ex.hi.label} at ${compact(ex.hi.value)}; the low is ${ex.lo.label} at ${compact(ex.lo.value)}${tail}.`);
    } else {
      bullets.push(`${ex.hi.label} is highest at ${compact(ex.hi.value)}` +
        (share !== null ? `, ${pct(share)} of the ${compact(total)} total` : '') + `${tail}.`);
      if (ms.length > 1) bullets.push(`${ex.lo.label} is lowest at ${compact(ex.lo.value)}${tail}.`);
    }
    if (si === 0) {
      if (total !== null) headline.push({ label: `Total ${what}`, value: total, display: compact(total) });
      if (input.categoryIsDate && change) {
        headline.push({ label: `Latest · ${change.last.label}`, value: change.last.value, display: compact(change.last.value) });
      } else {
        headline.push({ label: `Highest · ${ex.hi.label}`, value: ex.hi.value, display: compact(ex.hi.value) });
      }
    }
  });

  bullets.push(`${labels.length} ${input.categoryIsDate ? 'periods' : 'categories'} shown.`);
  num(ledger, 'categories shown', labels.length, 'count');
  if (input.filterLabels.length) bullets.push(`Filtered to ${input.filterLabels.join('; ')}.`);

  if (input.caption) lines.push('', `Caption shown under the chart (app-written): ${input.caption}`);
  lines.push('', 'Summary points (app-written):');
  bullets.forEach((b) => lines.push(`- ${b}`));

  const text = lines.join('\n');
  seal(ledger, text);
  return { text, ledger, bullets, headline };
}

function fmtRaw(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : 'n/a';
}

// Every figure the block prints that no structured entry covers — the caption's
// "2.4×", a compact "1.6M" in a bullet — enters the ledger too. The same
// backstop copilotFacts.sealLedger is, for the same reason.
function seal(ledger: LedgerEntry[], text: string): void {
  for (const h of harvestAppNumbers(text)) {
    const covered = ledger.some((e) => Object.is(e.value, h.value) && (h.unit !== 'percent' || e.unit === 'percent'));
    if (!covered) ledger.push({ label: 'figure printed in the facts block', value: h.value, unit: h.unit, source: 'answer' });
  }
}
