// Event funnels — PURE, MAIN PROCESS, no fs / DOM.
//
// STRICT ORDER. An entity enters at its FIRST step-1 event (t1). Step k's time
// is the EARLIEST event named step k strictly after step k−1's matched time,
// and the entity converts to step k only if t_k − t1 ≤ window. Other events in
// between are allowed. An exact duplicate event cannot change any of that — the
// matching takes a minimum, and a minimum does not care how often a value
// occurs — so duplicates count once by construction, not by a dedupe pass.
//
// Timestamps are read in ONE grammar, `TS_RE`, shared as text with the SQL
// side: YYYY-MM-DD, optionally followed by [T or space]HH:MM[:SS[.fraction]]
// and a Z. Anything else excludes the row on both paths. Milliseconds are the
// unit (the first three fraction digits); a timezone offset is not accepted.
//
// TWO PATHS, ONE FOLD — the pivot's arrangement. `buildEventFunnel` is the JS
// reference; `engine/funnelResident` produces the same per-breakdown counts
// and the same two middle time-gaps per step off the stored Parquet. Both hand
// them to `foldEventFunnel`, so every rate and median is the same JS arithmetic
// over identical integers.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep, TableData } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import { daysFromCivil, civilFromDays } from './categoryKey';
import { entityKey } from './cohortData';
import { formatCompact } from '../app/format';

export type WindowUnit = 'hours' | 'days';

export interface FunnelEncoding {
  entity: string;
  event: string;
  time: string;
  /** Ordered, 2–8 values of the event column. */
  steps: string[];
  window: { n: number; unit: WindowUnit };
  breakdown?: string;
}

export const FUNNEL_MIN_STEPS = 2;
export const FUNNEL_MAX_STEPS = 8;
export const FUNNEL_BREAKDOWN_CAP = 12;
const MAX_WINDOW = 100_000;

export interface FunnelBreakdownGroup {
  label: string;
  counts: number[];
  pctOfFirst: (number | null)[];
}

export interface EventFunnel {
  steps: string[];
  /** Entities reaching each step. */
  counts: number[];
  /** % of step 1 (step 1 itself is 100 when anyone entered). */
  pctOfFirst: (number | null)[];
  /** % of the step before. */
  pctOfPrev: (number | null)[];
  /** Median ms from step k−1 to step k over the entities that reached both; [0] is null. */
  medianMs: (number | null)[];
  window: { n: number; unit: WindowUnit };
  breakdown: { column: string; groups: FunnelBreakdownGroup[]; truncated: boolean } | null;
  /** Rows dropped for an empty entity or an unreadable timestamp. */
  excluded: number;
  needs: string;
}

/** What the two paths compute differently — nothing else. */
export interface FunnelGroups {
  /** One per breakdown label (a single '' group without a breakdown). `first` only ORDERS groups. */
  groups: Array<{ label: string; counts: number[]; first: number }>;
  /** Per step k ≥ 1: the two middle time-gaps (equal for an odd count), or null when nobody reached it. */
  mids: Array<[number, number] | null>;
  excluded: number;
}

// ── Sanitisation ─────────────────────────────────────────────────────────────

const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** `encoding.eventFunnel`, or undefined. Incomplete shelves survive for the empty state. */
export function sanitizeEventFunnel(raw: unknown): FunnelEncoding | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const steps = (Array.isArray(o.steps) ? o.steps : [])
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .slice(0, FUNNEL_MAX_STEPS)
    .map((s) => s.slice(0, 400));
  const w = o.window && typeof o.window === 'object' ? (o.window as Record<string, unknown>) : {};
  const n = typeof w.n === 'number' && Number.isFinite(w.n) && w.n > 0 ? Math.min(w.n, MAX_WINDOW) : 7;
  const enc: FunnelEncoding = {
    entity: str(o.entity), event: str(o.event), time: str(o.time), steps,
    window: { n, unit: w.unit === 'hours' ? 'hours' : 'days' },
  };
  if (str(o.breakdown)) enc.breakdown = str(o.breakdown);
  return enc;
}

export function funnelColumns(enc: FunnelEncoding): string[] {
  return [enc.entity, enc.event, enc.time, enc.breakdown || ''].filter(Boolean);
}

export function windowMs(w: { n: number; unit: WindowUnit }): number {
  return w.n * (w.unit === 'hours' ? 3_600_000 : 86_400_000);
}

// ── The timestamp grammar ────────────────────────────────────────────────────

// RE2 and JS agree on every construct here (ASCII \d, groups, `?`, `$`), which
// is what lets `engine/funnelResident` hand DuckDB this exact text.
export const TS_RE =
  '^(\\d{4})-(\\d{2})-(\\d{2})(?:[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,9}))?)?Z?)?$';
const TS_RX = new RegExp(TS_RE);

/** A stored cell → epoch milliseconds, or null. */
export function eventMs(cell: Cell): number | null {
  if (cell == null) return null;
  const m = TS_RX.exec(String(cell));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const day = daysFromCivil(y, mo, d);
  const back = civilFromDays(day);
  if (back.y !== y || back.m !== mo || back.d !== d) return null;
  const h = m[4] ? Number(m[4]) : 0;
  const mi = m[5] ? Number(m[5]) : 0;
  const s = m[6] ? Number(m[6]) : 0;
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
  return day * 86_400_000 + h * 3_600_000 + mi * 60_000 + s * 1000 + ms;
}

// ── What an encoding still needs ─────────────────────────────────────────────

export function funnelNeeds(cols: ParsedColumn[], enc: FunnelEncoding | undefined): string {
  const has = (n: string | undefined): boolean => !!n && cols.some((c) => c && c.name === n);
  if (!enc || !enc.entity) return 'Pick the entity column — who moves through the funnel.';
  if (!has(enc.entity)) return `The entity column "${enc.entity}" is not in this dataset.`;
  if (!enc.event) return 'Pick the event-name column.';
  if (!has(enc.event)) return `The event column "${enc.event}" is not in this dataset.`;
  if (!enc.time) return 'Pick the timestamp column.';
  if (!has(enc.time)) return `The timestamp column "${enc.time}" is not in this dataset.`;
  if (enc.steps.length < FUNNEL_MIN_STEPS) return 'Add at least two steps, in the order they happen.';
  if (enc.breakdown && !has(enc.breakdown)) return `The breakdown column "${enc.breakdown}" is not in this dataset.`;
  return '';
}

function emptyFunnel(enc: FunnelEncoding | undefined, needs: string): EventFunnel {
  const steps = enc ? enc.steps.slice() : [];
  return {
    steps, counts: steps.map(() => 0), pctOfFirst: steps.map(() => null), pctOfPrev: steps.map(() => null),
    medianMs: steps.map(() => null), window: enc ? { ...enc.window } : { n: 7, unit: 'days' },
    breakdown: null, excluded: 0, needs,
  };
}

/** A breakdown cell as a label: a number column by its JS number, anything else verbatim. */
export function dimLabel(cell: Cell, isNumber: boolean): string {
  if (isNumber) return typeof cell === 'number' && Number.isFinite(cell) ? String(cell) : '';
  return cell == null ? '' : String(cell);
}

// ── The JS reference ─────────────────────────────────────────────────────────

export interface FunnelResult {
  funnel: EventFunnel;
  warnings: string[];
}

interface Ev { n: string; t: number; o: number; d: string }

/** The reference: columns + rows + a funnel encoding → the funnel. Never throws. */
export function buildEventFunnel(
  columns: ParsedColumn[],
  rows: Cell[][],
  enc: FunnelEncoding | undefined,
  filters?: FilterStep[],
): FunnelResult {
  const warnings: string[] = [];
  let table: TableData = { columns: Array.isArray(columns) ? columns : [], rows: Array.isArray(rows) ? rows : [] };
  const needs = funnelNeeds(table.columns, enc);
  if (needs || !enc) return { funnel: emptyFunnel(enc, needs), warnings };
  if (filters && filters.length > 0) {
    const f = applyPipeline(table, filters);
    for (const w of f.warnings) warnings.push(w);
    table = { columns: f.columns, rows: f.rows };
  }
  const idx = (name: string): number => table.columns.findIndex((c) => c && c.name === name);
  const ei = idx(enc.entity);
  const ni = idx(enc.event);
  const ti = idx(enc.time);
  const bi = enc.breakdown ? idx(enc.breakdown) : -1;
  const numEntity = table.columns[ei].type === 'number';
  const numDim = bi >= 0 && table.columns[bi].type === 'number';
  const wanted = new Set(enc.steps);

  const byEntity = new Map<string | number, Ev[]>();
  let excluded = 0;
  table.rows.forEach((r, o) => {
    const key = entityKey(r[ei], numEntity);
    const t = eventMs(r[ti]);
    if (key === null || t === null) { excluded += 1; return; }
    const n = r[ni] == null ? null : String(r[ni]);
    if (n === null || !wanted.has(n)) return;
    let list = byEntity.get(key);
    if (!list) byEntity.set(key, (list = []));
    list.push({ n, t, o, d: bi >= 0 ? dimLabel(r[bi], numDim) : '' });
  });

  const S = enc.steps.length;
  const W = windowMs(enc.window);
  const groups = new Map<string, { label: string; counts: number[]; first: number }>();
  const gaps: number[][] = enc.steps.map(() => []);
  for (const list of byEntity.values()) {
    let entry: Ev | null = null;
    for (const e of list) {
      if (e.n === enc.steps[0] && (!entry || e.t < entry.t || (e.t === entry.t && e.o < entry.o))) entry = e;
    }
    if (!entry) continue;
    let g = groups.get(entry.d);
    if (!g) groups.set(entry.d, (g = { label: entry.d, counts: new Array<number>(S).fill(0), first: entry.o }));
    g.first = Math.min(g.first, entry.o);
    g.counts[0] += 1;
    let prev = entry.t;
    for (let k = 1; k < S; k += 1) {
      let next: number | null = null;
      for (const e of list) if (e.n === enc.steps[k] && e.t > prev && (next === null || e.t < next)) next = e.t;
      if (next === null || next - entry.t > W) break;
      g.counts[k] += 1;
      gaps[k].push(next - prev);
      prev = next;
    }
  }
  const mids = gaps.map((list, k): [number, number] | null => {
    if (k === 0 || list.length === 0) return null;
    list.sort((a, b) => a - b);
    return [list[Math.floor((list.length + 1) / 2) - 1], list[Math.floor(list.length / 2)]];
  });
  return { funnel: foldEventFunnel(enc, { groups: [...groups.values()], mids, excluded }), warnings };
}

// ── The fold both paths share ────────────────────────────────────────────────

const pctOf = (a: number, b: number): number | null => (b > 0 ? (a / b) * 100 : null);

export function foldEventFunnel(enc: FunnelEncoding, g: FunnelGroups): EventFunnel {
  const S = enc.steps.length;
  const out = emptyFunnel(enc, '');
  out.excluded = g.excluded;
  // Two SQL groups can share a label (a NULL and an '' breakdown cell are both
  // '' once labelled), so the fold merges by label rather than trusting keys.
  const merged = new Map<string, { label: string; counts: number[]; first: number }>();
  for (const grp of g.groups) {
    const m = merged.get(grp.label);
    if (!m) { merged.set(grp.label, { label: grp.label, counts: grp.counts.slice(0, S), first: grp.first }); continue; }
    for (let k = 0; k < S; k += 1) m.counts[k] += grp.counts[k] || 0;
    m.first = Math.min(m.first, grp.first);
  }
  const list = [...merged.values()];
  for (const grp of list) for (let k = 0; k < S; k += 1) out.counts[k] += grp.counts[k] || 0;
  out.pctOfFirst = out.counts.map((c) => pctOf(c, out.counts[0]));
  out.pctOfPrev = out.counts.map((c, k) => (k === 0 ? pctOf(c, c) : pctOf(c, out.counts[k - 1])));
  out.medianMs = enc.steps.map((_, k) => {
    const m = g.mids[k];
    return k > 0 && m ? (m[0] + m[1]) / 2 : null;
  });
  if (enc.breakdown) {
    list.sort((a, b) => (b.counts[0] - a.counts[0]) || (a.first - b.first));
    out.breakdown = {
      column: enc.breakdown,
      groups: list.slice(0, FUNNEL_BREAKDOWN_CAP).map((grp) => ({
        label: grp.label,
        counts: grp.counts.slice(),
        pctOfFirst: grp.counts.map((c) => pctOf(c, grp.counts[0])),
      })),
      truncated: list.length > FUNNEL_BREAKDOWN_CAP,
    };
  }
  return out;
}

/** The `{labels, series}` every grid-agnostic surface reads: entities per step. */
export function funnelChartData(f: EventFunnel): { labels: string[]; series: { name: string; values: (number | null)[] }[] } {
  if (!f.steps.length || f.needs) return { labels: f.steps.slice(), series: [] };
  return { labels: f.steps.slice(), series: [{ name: 'Entities', values: f.counts.slice() }] };
}

// ── Words ────────────────────────────────────────────────────────────────────

const pct1 = (v: number): string => `${Math.round(v * 10) / 10}%`;

/** "3 h", "2.5 d", "45 min", "12 s" — a median gap as a reader says it. */
export function durationText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const r = (v: number): string => String(Math.round(v * 10) / 10);
  if (ms < 60_000) return `${r(ms / 1000)} s`;
  if (ms < 3_600_000) return `${r(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${r(ms / 3_600_000)} h`;
  return `${r(ms / 86_400_000)} d`;
}

export function windowText(w: { n: number; unit: WindowUnit }): string {
  const one = w.unit === 'hours' ? 'hour' : 'day';
  return `${w.n} ${w.n === 1 ? one : one + 's'}`;
}

/** "1.2K entered Signup; 38% reached Purchase within 7 days; the biggest drop is Signup → Trial (45% lost)". */
export function funnelCaption(f: EventFunnel | null | undefined): string {
  if (!f || f.needs || !Array.isArray(f.steps) || f.steps.length < 2) return 'No data to summarize';
  if (!f.counts[0]) return `Nobody reached ${f.steps[0]}`;
  const last = f.steps.length - 1;
  let text = `${formatCompact(f.counts[0])} entered ${f.steps[0]}; ` +
    `${pct1(f.pctOfFirst[last] ?? 0)} reached ${f.steps[last]} within ${windowText(f.window)}`;
  if (f.steps.length > 2) {
    let worst = 1;
    for (let k = 2; k <= last; k += 1) if ((f.pctOfPrev[k] ?? 100) < (f.pctOfPrev[worst] ?? 100)) worst = k;
    text += `; the biggest drop is ${f.steps[worst - 1]} → ${f.steps[worst]} (${pct1(100 - (f.pctOfPrev[worst] ?? 100))} lost)`;
  }
  return text;
}
