// Pure layout and formatting for the three grids (no React): the shapes the
// server sends, how each figure prints, the pivot's merged header rows, the
// colour positions a ramp needs, and the CSV rows an export writes. Ported from
// renderer/hub/pivotRender.ts and cohortRender.ts.
//
// THE SERVER DOES THE MATH. Every printed figure is the server's, formatted
// here and nothing else. The only arithmetic is a 0..1 POSITION for a cell's
// colour (the pivot's conditional ramp, the cohort heatmap, a funnel bar's
// width) — a visual encoding, never a printed number.

import { fmtVal, fmtWith, tcCalcLabel, tcCalcValueText } from '../format';
import { t } from './strings';

/** `analysis/pivotData.PivotGrid`, as `visual:data` sends it. */
export interface PivotGridShape {
  rowHeaders: string[][];
  colHeaders: string[][];
  cells: (number | null)[][];
  rowTotals: (number | null)[][] | null;
  colTotals: (number | null)[] | null;
  grand: (number | null)[] | null;
  rowKinds: Array<'leaf' | 'subtotal'>;
  valueNames: string[];
  valueCount: number;
  showAs: string[];
  formats: string[];
  conditional: Array<{ valueIdx: number; kind: string; threshold?: number }>;
  sort: PivotSort | null;
  rowGroupCount: number;
  colGroupCount: number;
  truncated: boolean;
  calcs?: Array<{ kind: string } | null>;
  rawCells?: (number | null)[][];
}

export interface PivotSort {
  by: 'label' | number;
  dir: 'asc' | 'desc';
}

/** `analysis/cohortData.CohortGrid`. */
export interface CohortGridShape {
  grain: string;
  show: 'retention' | 'value';
  curve: boolean;
  cohorts: string[];
  sizes: number[];
  /** The sum of `sizes`, computed by the server. */
  members: number;
  cells: (number | null)[][];
  average: (number | null)[];
  periods: number;
  periodNoun: string;
  excluded: number;
  valueName: string;
  truncated: boolean;
  needs: string;
}

/** `analysis/funnelEvents.EventFunnel`. */
export interface EventFunnelShape {
  steps: string[];
  counts: number[];
  pctOfFirst: (number | null)[];
  pctOfPrev: (number | null)[];
  medianMs: (number | null)[];
  window: { n: number; unit: string };
  breakdown: { column: string; groups: Array<{ label: string; counts: number[]; pctOfFirst: (number | null)[] }>; truncated: boolean } | null;
  excluded: number;
  needs: string;
}

// ── Formatting (display only) ────────────────────────────────────────────────

/** The table calculation a pivot value field carries, or ''. */
export function calcKind(grid: PivotGridShape, vi: number): string {
  const c = Array.isArray(grid.calcs) ? grid.calcs[vi] : null;
  return c && typeof c.kind === 'string' ? c.kind : '';
}

/** A pivot figure: a table calculation's own text, a share, a rank, or the app formatter. */
export function pivotFmt(v: number | null | undefined, showAs: string | undefined, format: string | undefined, kind = ''): string {
  if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return '–';
  if (kind) return tcCalcValueText(kind, v);
  if (showAs === 'pct_row' || showAs === 'pct_col' || showAs === 'pct_total') {
    // The server sends a ratio; ×100 is the unit a percent sign implies.
    return (v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%';
  }
  if (showAs === 'rank') return String(v);
  return fmtWith(v, format || 'auto');
}

/** Which value field a grid column carries. */
export const valueOf = (grid: PivotGridShape, col: number): number => (grid.valueCount > 0 ? col % grid.valueCount : 0);

/** A cell's tooltip: row path, column path, the figure (both figures for a calculated cell). */
export function pivotTip(grid: PivotGridShape, r: number, c: number): string {
  const vi = valueOf(grid, c);
  const kind = calcKind(grid, vi);
  const v = grid.cells[r]?.[c] ?? null;
  const raw = grid.rawCells?.[r]?.[c] ?? null;
  return [
    (grid.rowHeaders[r] || []).filter(Boolean).join(' · ') || '—',
    (grid.colHeaders[c] || []).filter(Boolean).join(' · ') || grid.valueNames[vi] || '',
    kind ? tcCalcLabel(kind, v, raw) : pivotFmt(v, grid.showAs[vi], grid.formats[vi]),
  ]
    .filter(Boolean)
    .join('\n');
}

export const engPct = (v: number | null | undefined): string => (v == null ? '' : `${Math.round(v * 10) / 10}%`);
export const engNum = (v: number | null | undefined): string => (v == null ? '' : fmtVal(v));

export function engDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const r = (v: number): string => String(Math.round(v * 10) / 10);
  if (ms < 60_000) return `${r(ms / 1000)} s`;
  if (ms < 3_600_000) return `${r(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${r(ms / 3_600_000)} h`;
  return `${r(ms / 86_400_000)} d`;
}

export function engWindow(w: { n: number; unit: string }): string {
  const one = w.unit === 'hours' ? 'hour' : 'day';
  return `${w.n} ${w.n === 1 ? one : one + 's'}`;
}

// ── The pivot header ─────────────────────────────────────────────────────────

export interface HeadCell {
  label: string;
  /** The first grid column under it. */
  col: number;
  span: number;
  /** The bottom header row: these are the sortable column heads. */
  leaf: boolean;
}

/**
 * One row per column-dimension level, equal consecutive labels MERGED — but
 * only while the whole prefix above matches, so two regions sharing a
 * sub-label stay two headers.
 */
export function pivotHeadRows(grid: PivotGridShape): { depth: number; rows: HeadCell[][] } {
  const depth = grid.colHeaders.length ? Math.max(...grid.colHeaders.map((h) => h.length)) : 1;
  const rows: HeadCell[][] = [];
  for (let level = 0; level < depth; level += 1) {
    const row: HeadCell[] = [];
    let c = 0;
    while (c < grid.colHeaders.length) {
      const label = grid.colHeaders[c]![level] ?? '';
      let span = 1;
      while (
        c + span < grid.colHeaders.length &&
        (grid.colHeaders[c + span]![level] ?? '') === label &&
        samePrefix(grid.colHeaders[c]!, grid.colHeaders[c + span]!, level)
      )
        span += 1;
      row.push({ label, col: c, span, leaf: level === depth - 1 });
      c += span;
    }
    rows.push(row);
  }
  return { depth, rows };
}

function samePrefix(a: string[], b: string[], level: number): boolean {
  for (let i = 0; i < level; i += 1) if ((a[i] ?? '') !== (b[i] ?? '')) return false;
  return true;
}

/** Rows under a collapsed subtotal are hidden; the subtotal itself stays. */
export function visibleRows(grid: PivotGridShape, collapsed: ReadonlySet<string>): number[] {
  const out: number[] = [];
  outer: for (let r = 0; r < grid.cells.length; r += 1) {
    const p = grid.rowHeaders[r] ?? [];
    for (let d = 1; d < p.length; d += 1) if (collapsed.has(pathKey(p.slice(0, d)))) continue outer;
    out.push(r);
  }
  return out;
}

export const pathKey = (p: string[]): string => p.join('\u0000');

// ── Conditional formatting: a colour position, from the LEAF cells only ──────

export interface CondRange {
  lo: number;
  hi: number;
}

export function condRanges(grid: PivotGridShape): Map<number, CondRange> {
  const out = new Map<number, CondRange>();
  for (const rule of grid.conditional || []) {
    if (out.has(rule.valueIdx) || grid.valueCount < 1) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (let r = 0; r < grid.cells.length; r += 1) {
      if (grid.rowKinds[r] !== 'leaf') continue; // a subtotal would flatten the ramp
      const row = grid.cells[r]!;
      for (let c = rule.valueIdx; c < row.length; c += grid.valueCount) {
        const v = row[c];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (lo <= hi) out.set(rule.valueIdx, { lo, hi });
  }
  return out;
}

/** How a leaf cell is painted: a class for a threshold, a background for a ramp or a bar. */
export function cellPaint(
  v: number | null,
  rule: { kind: string; threshold?: number } | undefined,
  range: CondRange | undefined,
): { tone?: 'above' | 'below'; background?: string } {
  if (!rule || v == null || !Number.isFinite(v)) return {};
  if (rule.kind === 'threshold') return { tone: v >= (typeof rule.threshold === 'number' ? rule.threshold : 0) ? 'above' : 'below' };
  if (!range) return {};
  const pos = range.hi === range.lo ? 0 : Math.min(1, Math.max(0, (v - range.lo) / (range.hi - range.lo)));
  if (rule.kind === 'scale') return { background: `color-mix(in srgb, var(--chart-1) ${(pos * 28).toFixed(1)}%, transparent)` };
  if (rule.kind === 'bars') {
    const pct = (pos * 100).toFixed(1);
    return { background: `linear-gradient(to left, color-mix(in srgb, var(--chart-1) 22%, transparent) ${pct}%, transparent ${pct}%)` };
  }
  return {};
}

// ── The cohort heatmap ramp: --surface → --accent, text picked for AA ────────

type Rgb = [number, number, number];

export function parseRgb(css: string): Rgb | null {
  const s = String(css || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1]![i]! + m![1]![i]!, 16)) as Rgb;
  m = /^#([0-9a-f]{6})/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)) as Rgb;
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function lum(c: Rgb): number {
  const ch = (v: number): number => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}
const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

export interface Ramp {
  base: Rgb;
  ink: Rgb;
  text: Rgb | null;
}

export function makeRamp(surface: string, accent: string, text: string): Ramp | null {
  const base = parseRgb(surface);
  const ink = parseRgb(accent);
  return base && ink ? { base, ink, text: parseRgb(text) } : null;
}

/** A cell's shade at position `p` ∈ [0, 1], and a text colour only when the theme's own fails AA. */
export function shade(p: number, ramp: Ramp): { backgroundColor: string; color?: string } {
  const w = 0.08 + 0.72 * Math.max(0, Math.min(1, p));
  const bg = ramp.base.map((b, i) => Math.round(b + (ramp.ink[i]! - b) * w)) as Rgb;
  const out: { backgroundColor: string; color?: string } = { backgroundColor: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})` };
  const L = lum(bg);
  if (ramp.text && contrast(L, lum(ramp.text)) >= 4.5) return out;
  out.color = contrast(L, 0) >= contrast(L, 1) ? '#000' : '#fff';
  return out;
}

/** The ramp's top: retention over k ≥ 1 (k = 0 is 100% by definition); a value over every cell. */
export function cohortMax(g: CohortGridShape): number {
  let max = 0;
  g.cells.forEach((row) =>
    row.forEach((v, k) => {
      if (v != null && (g.show === 'value' || k > 0) && v > max) max = v;
    }),
  );
  return max;
}

// ── CSV (an export: full-precision figures, as the desktop wrote them) ───────

export function engineRows(type: 'cohort' | 'event_funnel', data: { cohort?: CohortGridShape; eventFunnel?: EventFunnelShape }): string[][] | null {
  if (type === 'cohort') {
    const g = data.cohort;
    if (!g || g.needs || !g.cohorts.length) return null;
    const head = [t('common.cohort'), t('cohortRender.members')];
    for (let k = 0; k < g.periods; k += 1) head.push(`${g.periodNoun} ${k}`);
    const out = [head];
    const raw = (v: number | null): string => (v == null ? '' : String(v));
    g.cohorts.forEach((c, i) => out.push([c, String(g.sizes[i])].concat(g.cells[i]!.map(raw))));
    out.push(['Average', String(g.members)].concat(g.average.map(raw)));
    return out;
  }
  const f = data.eventFunnel;
  if (!f || f.needs) return null;
  const raw = (v: number | null | undefined): string => (v == null ? '' : String(v));
  const out = [[t('common.step'), t('cohortRender.entities'), t('cohortRender.of_first_step'), t('cohortRender.of_previous_step'), t('cohortRender.median_time_from_previous')]];
  f.steps.forEach((s, k) => out.push([s, String(f.counts[k]), raw(f.pctOfFirst[k]), k ? raw(f.pctOfPrev[k]) : '', k ? raw(f.medianMs[k]) : '']));
  if (f.breakdown) {
    out.push([]);
    out.push([f.breakdown.column].concat(f.steps));
    f.breakdown.groups.forEach((grp) => out.push([grp.label].concat(grp.counts.map(String))));
  }
  return out;
}

export function toCsv(rows: string[][]): string {
  const cell = (s: string): string => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
