// The Summary card's SENTENCES — MAIN PROCESS, PURE: no fs, no Electron, no model.
//
// A dashboard's Summary card says, in three to five sentences, what its own
// tiles say under the current filters: the headline KPI's movement, the largest
// contributor to it (Key drivers), the top insight on its datasets, a failing
// quality rule and a fired alert. Every figure arrives here ALREADY COMPUTED —
// by ipc/drivers.driversFor, ipc/insights.listInsights, the stored quality run
// and the alert inbox (gathered in ipc/summary.ts). This file only picks which
// facts to say, writes each one from a fixed template, and ranks them.
//
// RANKING is by MAGNITUDE, a share in [0, 1] for every kind so they compete on
// one scale: a KPI's |change| as a share of its base, a contributor's share of
// the change, an insight's own ranking magnitude (insights.rankInsights), the
// share of rows a quality rule fails on, an alert's |change|. Ties keep the
// kind order below.
//
// The same facts are the LEDGER a "Rewrite" is audited against (summaryFacts):
// the model may only restate them, and ./ai/numberAudit checks that it did.

import type { CopilotFacts } from '../ai/copilot';
import { harvestAppNumbers } from '../ai/numberAudit';
import type { LedgerEntry, LedgerUnit } from '../ai/numberAudit';
import type { Insight } from './insightsAgg';

export type SummaryKind = 'kpi' | 'driver' | 'insight' | 'quality' | 'alert';
export type SummaryTone = 'good' | 'bad' | 'flat' | 'warn' | 'info';

export interface SummaryFigure { label: string; value: number; unit: LedgerUnit }

export interface SummarySentence {
  kind: SummaryKind;
  text: string;
  /** In [0, 1] — what the card ranks by. */
  magnitude: number;
  tone: SummaryTone;
  /** The tile the sentence came from; null when no tile on the dashboard reads it. */
  cardId: string | null;
  /** The dataset and column whose VALUES the sentence quotes — what a share policy checks. */
  datasetId?: string;
  column?: string;
  figures: SummaryFigure[];
}

export const MIN_SENTENCES = 3;
export const MAX_SENTENCES = 5;
const KIND_ORDER: Record<SummaryKind, number> = { kpi: 0, driver: 1, insight: 2, quality: 3, alert: 4 };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const share = (v: number): number => Math.min(Math.abs(v), 1);
/** End a sentence once, whatever the source text ended with. */
const stop = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : s.trim() + '.');
const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : one + 's'}`;
const fig = (out: SummaryFigure[], label: string, v: unknown, unit: LedgerUnit = 'number'): void => {
  if (finite(v)) out.push({ label, value: v, unit });
};

/** "+19%" / "−4.1%" — one decimal under 10%, none above, a real minus sign (kpiCompare.kpiPct's rule). */
export function pctText(pct: number): string {
  const a = Math.abs(pct);
  const body = a < 10 ? a.toFixed(1).replace(/\.0$/, '') : a.toFixed(0);
  return (pct > 0 ? '+' : pct < 0 ? '−' : '') + body + '%';
}

// ── The five templates ───────────────────────────────────────────────────────

export interface KpiFact {
  cardId: string | null;
  metric: string;
  /** The figure now and before, and every text as the metric's format writes it (driversFor). */
  a: number | null;
  b: number | null;
  delta: number | null;
  pct: number | null;
  aText: string;
  bText: string;
  /** Signed, e.g. "+$41.2K". */
  deltaText: string;
  aLabel: string;
  bLabel: string;
  direction?: 'up_good' | 'down_good';
}

/** The headline KPI's movement — or, with no second period, its level. */
export function kpiSentence(f: KpiFact): SummarySentence | null {
  const figures: SummaryFigure[] = [];
  fig(figures, f.metric + ' now', f.a);
  fig(figures, f.metric + ' before', f.b);
  fig(figures, f.metric + ' change', f.delta);
  fig(figures, f.metric + ' change %', f.pct, 'percent');
  const base = { kind: 'kpi' as const, cardId: f.cardId, figures };
  if (!finite(f.a)) return null;
  if (!finite(f.b) || !finite(f.delta)) {
    return { ...base, text: `${f.metric} is ${f.aText}.`, magnitude: 0, tone: 'flat' };
  }
  if (f.delta === 0) {
    return { ...base, text: `${f.metric} held at ${f.aText} in ${f.aLabel}, unchanged from ${f.bLabel}.`, magnitude: 0, tone: 'flat' };
  }
  const up = f.delta > 0;
  const good = f.direction === 'down_good' ? !up : up;
  const by = f.deltaText.replace(/^[+−-]/, '');
  const pct = finite(f.pct) ? ` (${pctText(f.pct)})` : '';
  return {
    ...base,
    text: `${f.metric} ${up ? 'rose' : 'fell'} ${by}${pct} to ${f.aText} in ${f.aLabel}, from ${f.bText} in ${f.bLabel}.`,
    magnitude: finite(f.pct) ? share(f.pct / 100) : 1,
    tone: good ? 'good' : 'bad',
  };
}

export interface DriverFact {
  cardId: string | null;
  datasetId: string;
  metric: string;
  /** The dimension and its lead member (driversFor's ranked first dimension). */
  column: string;
  label: string;
  delta: number;
  deltaText: string;
  /** % of the net change, or null when the members offset each other. */
  share: number | null;
  /** % of all movement — the fair weight when members offset. */
  moveShare: number;
  offsetting: boolean;
}

/** The largest contributor to the headline KPI's change. */
export function driverSentence(f: DriverFact): SummarySentence {
  const figures: SummaryFigure[] = [];
  fig(figures, `${f.label} contribution`, f.delta);
  fig(figures, `${f.label} share of change`, f.share, 'percent');
  fig(figures, `${f.label} share of all movement`, f.moveShare, 'percent');
  const named = `${f.label} (${f.column})`;
  const shareOk = finite(f.share) && !f.offsetting && f.share > 0 && f.share <= 100;
  return {
    kind: 'driver',
    text: shareOk
      ? `${named} drove ${Math.round(f.share as number)}% of the change in ${f.metric}, ${f.deltaText}.`
      : `${named} moved ${f.metric} the most, ${f.deltaText}.`,
    magnitude: shareOk ? share((f.share as number) / 100) : share(f.moveShare / 100),
    tone: 'info',
    cardId: f.cardId,
    datasetId: f.datasetId,
    column: f.column,
    figures,
  };
}

/**
 * The magnitude insights.rankInsights ranks by — restated, not imported,
 * because it is private there. Keep the two in step.
 */
export function insightMagnitude(i: Pick<Insight, 'facts'>): number {
  const f = i.facts || {};
  for (const k of ['contribution', 'share']) {
    const v = f[k];
    if (finite(v)) return Math.abs(v);
  }
  return finite(f.pctChange) ? Math.min(Math.abs(f.pctChange), 1) : 0;
}

/** An insight in its OWN words — so anything the insight carries (an event's attribution) flows through. */
export function insightSentence(i: Pick<Insight, 'title' | 'facts' | 'severity' | 'datasetId' | 'column'>, cardId: string | null): SummarySentence {
  // R8 HOOK: events — if the event-annotation feature attaches attribution as
  // its own field rather than inside `title`, append it to this text here.
  const figures: SummaryFigure[] = [];
  for (const [k, v] of Object.entries(i.facts || {})) fig(figures, k, v);
  return {
    kind: 'insight',
    text: stop(upper(i.title)),
    magnitude: insightMagnitude(i),
    tone: i.severity === 'warn' ? 'warn' : 'info',
    cardId,
    datasetId: i.datasetId,
    ...(i.column ? { column: i.column } : {}),
    figures,
  };
}

export interface QualityFact {
  cardId: string | null;
  datasetName: string;
  /** qualityRules.ruleSignature, e.g. "not_null(customer)". */
  signature: string;
  rowCountRule: boolean;
  failing: number;
  rowCount: number;
  severity: 'warn' | 'fail';
}

/** A quality rule failing in the dataset's latest run. */
export function qualitySentence(f: QualityFact): SummarySentence {
  const figures: SummaryFigure[] = [];
  if (!f.rowCountRule) fig(figures, `rows failing ${f.signature}`, f.failing, 'count');
  return {
    kind: 'quality',
    text: f.rowCountRule
      ? `Quality check "${f.signature}" is failing on ${f.datasetName}.`
      : `Quality check "${f.signature}" is failing on ${plural(f.failing, 'row')} of ${f.datasetName}.`,
    magnitude: f.rowCountRule || f.rowCount <= 0 ? 1 : share(f.failing / f.rowCount),
    tone: f.severity === 'fail' ? 'bad' : 'warn',
    cardId: f.cardId,
    figures,
  };
}

export interface AlertFact {
  cardId: string | null;
  ruleName: string;
  /** The event's own app-composed message (alerts.alertMessage). */
  message: string;
  value: number | null;
  previous: number | null;
  deltaPct: number | null;
}

/** An unseen alert event on one of the dashboard's datasets. */
export function alertSentence(f: AlertFact): SummarySentence {
  const figures: SummaryFigure[] = [];
  fig(figures, `${f.ruleName} value`, f.value);
  fig(figures, `${f.ruleName} previous`, f.previous);
  fig(figures, `${f.ruleName} change %`, f.deltaPct, 'percent');
  return {
    kind: 'alert',
    text: `Alert “${f.ruleName}” fired: ${stop(f.message)}`,
    magnitude: finite(f.deltaPct) ? share(f.deltaPct / 100) : 1,
    tone: 'warn',
    cardId: f.cardId,
    figures,
  };
}

// ── Selection and ranking ────────────────────────────────────────────────────

export interface SummaryCandidates {
  kpi: SummarySentence | null;
  driver: SummarySentence | null;
  /** Ranked, best first (insights.rankInsights order). */
  insights: SummarySentence[];
  quality: SummarySentence | null;
  alert: SummarySentence | null;
}

/**
 * One sentence per kind, the top insight among them; further insights only
 * to reach MIN_SENTENCES. Then ranked by magnitude, capped at MAX_SENTENCES.
 */
export function composeSummary(c: SummaryCandidates): SummarySentence[] {
  const picked = [c.kpi, c.driver, c.insights[0] || null, c.quality, c.alert].filter((s): s is SummarySentence => !!s);
  for (const extra of c.insights.slice(1)) {
    if (picked.length >= MIN_SENTENCES) break;
    picked.push(extra);
  }
  return picked
    .sort((a, b) => b.magnitude - a.magnitude || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    .slice(0, MAX_SENTENCES);
}

// ── The facts a Rewrite narrates ─────────────────────────────────────────────

const GUARD_LINE =
  'The numbers below were computed by the app (Ordinate), not by you. ' +
  'Treat them as ground truth: cite them exactly and NEVER recompute, round, or invent a figure.';

/** The sentences as a facts block plus its ledger — one pass, as every *Facts builder does. */
export function summaryFacts(dashboardName: string, sentences: SummarySentence[]): CopilotFacts {
  const lines = [GUARD_LINE, '', `The app's summary of the dashboard "${dashboardName}", most important first:`];
  const ledger: LedgerEntry[] = [];
  for (const s of sentences) {
    lines.push(`- ${s.text}`);
    for (const f of s.figures) ledger.push({ label: f.label, value: f.value, unit: f.unit, source: 'summaryCard' });
  }
  const text = lines.join('\n');
  // Backstop, as in driversFacts: a figure printed in a sentence (a formatted
  // "$41.2K", a percent) is the app's even when no raw value carries it.
  for (const h of harvestAppNumbers(text)) {
    if (!ledger.some((e) => Object.is(e.value, h.value) && e.unit === h.unit)) {
      ledger.push({ label: 'figure printed in the summary', value: h.value, unit: h.unit, source: 'summaryCard' });
    }
  }
  return { text, ledger, provenance: { kind: 'project', name: dashboardName, note: 'summary figures app-computed' } };
}
