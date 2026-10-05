// KEY DRIVERS — why a figure changed between two periods. MAIN PROCESS, PURE:
// no fs, no DuckDB, no model. Figures in, figures out.
//
// The inputs are app-computed per-member aggregates (src/engine/driversResident
// on the stored Parquet, or src/analysis/driversJs over hydrated rows — the
// reference, differential-tested against it). This file only does arithmetic on
// them, so every number a driver panel shows is reproducible from the data.
//
// ── Additive metrics (sum, count, and + − of them) ──────────────────────────
// Each member's change is its own change: dᵢ = aᵢ − bᵢ, and Σ dᵢ is the whole
// delta because the members partition the rows (empty cells are one member,
// "(blank)", not dropped).
//
// ── Ratio metrics (Margin %, avg order value, any avg) ──────────────────────
// R = N / D = Σᵢ wᵢ·rᵢ with weight wᵢ = Dᵢ/D and rate rᵢ = Nᵢ/Dᵢ. A member's
// change splits by the standard two-factor shift-share, in its symmetric
// (midpoint, i.e. Shapley) form, which leaves no interaction residue:
//
//   rate effectᵢ = (wᵢᴬ + wᵢᴮ)/2 · (rᵢᴬ − rᵢᴮ)     the member did better/worse
//   mix effectᵢ  = (wᵢᴬ − wᵢᴮ) · (rᵢᴬ + rᵢᴮ)/2     the member grew/shrank in weight
//
// and mix + rate = wᵢᴬrᵢᴬ − wᵢᴮrᵢᴮ = Nᵢᴬ/Dᴬ − Nᵢᴮ/Dᴮ, so the effects sum to Rᴬ − Rᴮ.
// A member with no denominator in one period has no rate there; its whole
// change is mix.
//
// ── Ranking dimensions: explained variance ──────────────────────────────────
// A dimension explains a change when its members did NOT all move at the
// overall rate. Against the no-driver expectation eᵢ = Δ·sᵢ (sᵢ = the member's
// share of the baseline, by |value|), the member-specific part is rᵢ = dᵢ − eᵢ
// and
//
//   explained variance = Σ rᵢ² / (Σ rᵢ² + Σ eᵢ²)          ∈ [0, 1]
//
// 0 when every member moved in proportion (the dimension says nothing), →1
// when the change sits in a few members or they offset each other. Ties are
// broken by the dataset's column order, so the ranking never depends on the
// order a query returned groups in.

import type { DriverShape, Linear } from './driverShape';
import { evalLinear } from './driverShape';

/** One member's operand values in both periods (index = operand index; null → nothing). */
export interface MemberAgg {
  key: string;
  a: Array<number | null>;
  b: Array<number | null>;
}

export interface DimensionAgg {
  column: string;
  members: MemberAgg[];
}

export interface MemberEffect {
  key: string;
  /** What a reader sees: '' is shown as "(blank)". */
  label: string;
  /** The member's figure in each period — its own value (additive) or its own rate (ratio). */
  a: number | null;
  b: number | null;
  /** Its contribution to the change. */
  delta: number;
  /** Ratio metrics only. mix + rate = delta. */
  mix?: number;
  rate?: number;
  /** delta / Δ × 100, or null when the total did not change. */
  share: number | null;
}

export interface WaterfallStep {
  key: string;
  label: string;
  delta: number;
  mix?: number;
  rate?: number;
}

export interface Waterfall {
  start: number;
  end: number;
  /** Top positives (largest first), then top negatives (most negative first). */
  steps: WaterfallStep[];
  /** Everything not shown: Δ − Σ steps, so the bars always close on `end`. */
  other: { delta: number; count: number };
}

export interface DimensionResult {
  column: string;
  explained: number;
  memberCount: number;
  /** Every member, largest |delta| first. */
  members: MemberEffect[];
  waterfall: Waterfall;
}

export interface Totals {
  a: number | null;
  b: number | null;
  delta: number | null;
}

/** Members per side shown before "Other". */
export const WATERFALL_TOP = 5;
/** A dimension needs this many members to explain anything, and at most this many to be read. */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 200;

export const BLANK_LABEL = '(blank)';

const zero = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function memberValue(lin: Linear, values: Array<number | null>): number {
  return evalLinear(lin, values.map(zero)) ?? 0;
}

/** The metric's figure in both periods, from the ungrouped operand totals. */
export function totalsOf(shape: DriverShape, a: Array<number | null>, b: Array<number | null>): Totals {
  if (shape.kind === 'none') return { a: null, b: null, delta: null };
  const at = (vals: Array<number | null>): number | null => {
    const n = evalLinear(shape.num, vals);
    if (shape.kind === 'additive' || n === null) return n;
    const d = evalLinear(shape.den, vals);
    return d === null || d === 0 ? null : n / d;
  };
  const ta = at(a);
  const tb = at(b);
  return { a: ta, b: tb, delta: ta !== null && tb !== null ? ta - tb : null };
}

/** Deterministic member order for ties: plain code-unit comparison, never locale. */
function byKey(x: { key: string }, y: { key: string }): number {
  return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
}

/**
 * Every member's effect for one dimension, or null when the metric has no
 * figure in a period (a ratio with a zero denominator, a sum with no numbers).
 */
export function memberEffects(
  shape: DriverShape,
  dim: DimensionAgg,
  totals: Totals,
  totalOps: { a: Array<number | null>; b: Array<number | null> },
): MemberEffect[] | null {
  if (shape.kind === 'none' || totals.delta === null) return null;
  const delta = totals.delta;
  const share = (d: number): number | null => (delta !== 0 ? (d / delta) * 100 : null);
  const label = (k: string): string => (k === '' ? BLANK_LABEL : k);

  if (shape.kind === 'additive') {
    return dim.members.map((m) => {
      const a = memberValue(shape.num, m.a);
      const b = memberValue(shape.num, m.b);
      const d = a - b;
      return { key: m.key, label: label(m.key), a, b, delta: d, share: share(d) };
    });
  }

  const DA = evalLinear(shape.den, totalOps.a);
  const DB = evalLinear(shape.den, totalOps.b);
  if (!DA || !DB) return null;
  return dim.members.map((m) => {
    const na = memberValue(shape.num, m.a);
    const nb = memberValue(shape.num, m.b);
    const da = memberValue(shape.den, m.a);
    const db = memberValue(shape.den, m.b);
    const ca = na / DA;
    const cb = nb / DB;
    const ra = da !== 0 ? na / da : null;
    const rb = db !== 0 ? nb / db : null;
    let mix: number;
    let rate: number;
    if (ra !== null && rb !== null) {
      const wa = da / DA;
      const wb = db / DB;
      rate = ((wa + wb) / 2) * (ra - rb);
      mix = (wa - wb) * ((ra + rb) / 2);
    } else {
      // Present in one period only: there is no second rate to compare, so the
      // member's whole contribution is its weight appearing or disappearing.
      mix = ca - cb;
      rate = 0;
    }
    const d = mix + rate;
    return { key: m.key, label: label(m.key), a: ra, b: rb, delta: d, mix, rate, share: share(d) };
  });
}

/**
 * Σ rᵢ² / (Σ rᵢ² + Σ eᵢ²) — see the header. `base` is each member's baseline
 * weight source (its value, or its denominator for a ratio), `alt` the current
 * period's, used when the baseline is all zero.
 */
export function explainedVariance(deltas: number[], base: number[], alt: number[], delta: number): number {
  let weights = base.map((v) => Math.abs(zero(v)));
  let sum = weights.reduce((s, v) => s + v, 0);
  if (sum === 0) {
    weights = alt.map((v) => Math.abs(zero(v)));
    sum = weights.reduce((s, v) => s + v, 0);
  }
  const n = deltas.length;
  if (n === 0) return 0;
  let rr = 0;
  let ee = 0;
  for (let i = 0; i < n; i += 1) {
    const s = sum === 0 ? 1 / n : weights[i] / sum;
    const e = delta * s;
    const r = deltas[i] - e;
    rr += r * r;
    ee += e * e;
  }
  return rr + ee === 0 ? 0 : rr / (rr + ee);
}

/** Start, the top positives and negatives, Other, end. */
export function buildWaterfall(members: MemberEffect[], start: number, end: number, top = WATERFALL_TOP): Waterfall {
  const pos = members.filter((m) => m.delta > 0).sort((x, y) => y.delta - x.delta || byKey(x, y)).slice(0, top);
  const neg = members.filter((m) => m.delta < 0).sort((x, y) => x.delta - y.delta || byKey(x, y)).slice(0, top);
  const shown = pos.concat(neg);
  const steps: WaterfallStep[] = shown.map((m) => {
    const s: WaterfallStep = { key: m.key, label: m.label, delta: m.delta };
    if (m.mix !== undefined) s.mix = m.mix;
    if (m.rate !== undefined) s.rate = m.rate;
    return s;
  });
  let sumShown = 0;
  for (const s of steps) sumShown += s.delta;
  return { start, end, steps, other: { delta: end - start - sumShown, count: members.length - shown.length } };
}

/**
 * One dimension, fully explained: effects, explained variance and the
 * waterfall. Null when the metric has no figure to explain.
 */
export function explainDimension(
  shape: DriverShape,
  dim: DimensionAgg,
  totals: Totals,
  totalOps: { a: Array<number | null>; b: Array<number | null> },
): DimensionResult | null {
  if (shape.kind === 'none' || totals.a === null || totals.b === null || totals.delta === null) return null;
  const effects = memberEffects(shape, dim, totals, totalOps);
  if (!effects) return null;
  const weightLin = shape.kind === 'ratio' ? shape.den : shape.num;
  const base = dim.members.map((m) => memberValue(weightLin, m.b));
  const alt = dim.members.map((m) => memberValue(weightLin, m.a));
  const explained = explainedVariance(effects.map((e) => e.delta), base, alt, totals.delta);
  const members = effects.slice().sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || byKey(x, y));
  return {
    column: dim.column,
    explained,
    memberCount: dim.members.length,
    members,
    waterfall: buildWaterfall(effects, totals.b, totals.a),
  };
}

/** Highest explained variance first; ties in dataset column order, then by name. */
export function rankDimensions(dims: DimensionResult[], columnOrder: string[]): DimensionResult[] {
  const pos = new Map(columnOrder.map((c, i) => [c, i]));
  const at = (c: string): number => pos.get(c) ?? Number.MAX_SAFE_INTEGER;
  return dims.slice().sort((x, y) =>
    y.explained - x.explained || at(x.column) - at(y.column) || (x.column < y.column ? -1 : x.column > y.column ? 1 : 0));
}

/**
 * The member that most explains the change: the largest move IN THE DIRECTION
 * of the total (the one a reader means by "why did it fall"), or the largest
 * move either way when the total did not change.
 */
export function leadMember(members: MemberEffect[], delta: number): MemberEffect | null {
  const pool = delta > 0 ? members.filter((m) => m.delta > 0) : delta < 0 ? members.filter((m) => m.delta < 0) : members;
  let best: MemberEffect | null = null;
  for (const m of pool) {
    if (m.delta === 0) continue;
    if (!best || Math.abs(m.delta) > Math.abs(best.delta) || (Math.abs(m.delta) === Math.abs(best.delta) && m.key < best.key)) best = m;
  }
  return best;
}

/**
 * Members OFFSET each other when the net change is small beside how much they
 * moved in total: under a fifth of the gross movement. Then "West explains
 * 1,457%" is arithmetic, not an explanation, and the words change. A lead
 * share past MAX_SHARE reads the same way even above that line.
 */
export const OFFSET_RATIO = 0.2;
export const MAX_SHARE = 200;

export function isOffsetting(members: Array<{ delta: number }>, delta: number): boolean {
  let gross = 0;
  for (const m of members) gross += Math.abs(m.delta);
  return gross > 0 && Math.abs(delta) < OFFSET_RATIO * gross;
}

export interface CaptionInput {
  metric: string;
  delta: number;
  /** |Δ| as the metric formats it ("$412K", "1.2 pts"). */
  deltaText: string;
  /** The lead member, with its own change as text ("+$3.1K"). */
  top: { label: string; share: number | null; deltaText?: string } | null;
  lead: { label: string; deltaText: string } | null;
  /** Members largely cancelled out (isOffsetting). */
  offsetting?: boolean;
}

/** "Revenue fell $412K; West explains 61%, led by California at −$190K." */
export function driversCaption(c: CaptionInput): string {
  const head = c.delta > 0 ? `${c.metric} rose ${c.deltaText}` : c.delta < 0 ? `${c.metric} fell ${c.deltaText}` : `${c.metric} did not change overall`;
  if (!c.top) return head + '.';
  let out = head;
  const pct = c.top.share === null ? null : Math.round(c.top.share);
  if (c.offsetting || pct === null || Math.abs(pct) > MAX_SHARE) {
    out += ` as members offset each other; ${c.top.label} moved the most` + (c.top.deltaText ? `, ${c.top.deltaText}` : '');
  } else if (pct > 100) out += `; ${c.top.label} explains ${pct}% — other members offset part of it`;
  else out += `; ${c.top.label} explains ${pct}%`;
  if (c.lead) out += `, led by ${c.lead.label} at ${c.lead.deltaText}`;
  return out + '.';
}
