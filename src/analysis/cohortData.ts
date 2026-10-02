// Cohort retention — PURE, MAIN PROCESS, no Electron / fs / DOM.
//
// An entity's COHORT is the week / month / quarter of its FIRST event. Period
// index k is the whole number of periods between that cohort period and an
// event's own period. Two readings of one triangle:
//   retention %(k)  = distinct members with ≥1 event in period k ÷ cohort size × 100
//   cumulative(k)   = Σ value over the cohort's events in periods 0..k ÷ cohort size
// A cell past the last period the data reaches is BLANK (null), never 0 — the
// triangle is the honest shape of "not happened yet".
//
// The period grammar is the workspace calendar's (dateIntel): weeks start on
// `weekStart`, quarters on the fiscal-year start month — or, under a week
// calendar (retailCalendar), its weeks, periods (the "month" grain) and
// quarters, labelled FY24 P03 W2 / FY24 P03 / FY24 Q1. A date cell is read by
// `dateIntel.periodDay` — the same two shapes a period filter reads, whose SQL
// twin (`periodSql.sqlPeriodDate`) is already pinned by a differential test.
//
// TWO PATHS, ONE FOLD — the pivot's arrangement. `buildCohort` is the JS
// reference; `engine/cohortResident` computes the same per-(cohort, k) groups
// off the stored Parquet. Both hand them to `foldCohort`, so every percentage,
// running sum and average is JS arithmetic over identical integers and
// identically-ordered sums (`sum(v ORDER BY ordinal)` on the SQL side).

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep, TableData } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import { civilFromDays } from './categoryKey';
import { getCalendar, isoFromDays, periodDay } from './dateIntel';
import type { CalendarPrefs } from './dateIntel';
import { ordinalOf, ordinalStart, unitOfGrain, weekCalOf, weekLabel } from './retailCalendar';
import { formatCompact } from '../app/format';

export type CohortGrain = 'week' | 'month' | 'quarter';
export type CohortShow = 'retention' | 'value';

export interface CohortEncoding {
  entity: string;
  date: string;
  /** A number column; read only when `show` is 'value'. */
  value?: string;
  grain: CohortGrain;
  show: CohortShow;
  /** Draw the retention curve (one line per cohort + the average) instead of the table. */
  curve: boolean;
}

/** Past these the table is a download, not a read. The LATEST cohorts are kept. */
export const COHORT_CAP = 60;
export const COHORT_PERIOD_CAP = 120;

export interface CohortGrid {
  grain: CohortGrain;
  show: CohortShow;
  curve: boolean;
  /** Oldest first. */
  cohorts: string[];
  sizes: number[];
  /** `cells[cohort][k]` — a percentage or a per-member value; null past the data. */
  cells: (number | null)[][];
  /** Size-weighted, over the cohorts that have reached k. */
  average: (number | null)[];
  periods: number;
  /** 'Week' | 'Month' | 'Quarter' — the column noun. */
  periodNoun: string;
  /** Rows dropped for an empty entity or an unreadable date. */
  excluded: number;
  valueName: string;
  truncated: boolean;
  /** Non-empty when the encoding cannot draw yet — the empty state's sentence. */
  needs: string;
}

/** One (cohort, k) group — the only thing the two paths compute differently. */
export interface CohortCell {
  c: number;
  k: number;
  active: number;
  /** Σ value over the group's events, file order; null when none was a number. */
  value: number | null;
}

export interface CohortGroups {
  cells: CohortCell[];
  /** The latest period ordinal any kept event falls in. */
  last: number | null;
  excluded: number;
}

// ── Sanitisation ─────────────────────────────────────────────────────────────

const GRAINS: ReadonlySet<string> = new Set(['week', 'month', 'quarter']);
const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 400) : '');

/** `encoding.cohort`, or undefined. Incomplete shelves survive — they are what the empty state reads. */
export function sanitizeCohort(raw: unknown): CohortEncoding | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const enc: CohortEncoding = {
    entity: str(o.entity),
    date: str(o.date),
    grain: GRAINS.has(o.grain as string) ? (o.grain as CohortGrain) : 'month',
    show: o.show === 'value' ? 'value' : 'retention',
    curve: o.curve === true,
  };
  if (str(o.value)) enc.value = str(o.value);
  return enc;
}

/** Every column the encoding reads — for the share policy. */
export function cohortColumns(enc: CohortEncoding): string[] {
  return [enc.entity, enc.date, enc.value || ''].filter(Boolean);
}

// ── The period grammar ───────────────────────────────────────────────────────

/** An epoch day → its period's ordinal. Consecutive periods differ by exactly 1. */
export function periodOrdinal(day: number, grain: CohortGrain, cal: CalendarPrefs): number {
  const wc = weekCalOf(cal);
  if (wc) return ordinalOf(day, unitOfGrain(grain)!, wc);
  // 1970-01-01 was a Thursday, so (day + 4) mod 7 is the Sunday-based weekday.
  if (grain === 'week') return Math.floor((day + 4 - cal.weekStart) / 7);
  const c = civilFromDays(day);
  const month = c.y * 12 + c.m - 1;
  return grain === 'month' ? month : Math.floor((month - (cal.fiscalYearStart - 1)) / 3);
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

/** A period ordinal → the cohort's row label. */
export function cohortLabel(ord: number, grain: CohortGrain, cal: CalendarPrefs): string {
  const wc = weekCalOf(cal);
  if (wc) {
    const unit = unitOfGrain(grain)!;
    return weekLabel(ordinalStart(ord, unit, wc), unit, wc);
  }
  if (grain === 'week') return isoFromDays(ord * 7 - 4 + cal.weekStart); // the week's first day
  const month = grain === 'month' ? ord : ord * 3 + cal.fiscalYearStart - 1;
  const y = Math.floor(month / 12);
  const m = month - y * 12 + 1;
  if (grain === 'month') return `${pad(y, 4)}-${pad(m, 2)}`;
  if (cal.fiscalYearStart === 1) return `${pad(y, 4)}-Q${Math.floor((m - 1) / 3) + 1}`;
  const fq = Math.floor((((m - cal.fiscalYearStart) % 12) + 12) % 12 / 3) + 1;
  return `${pad(y, 4)}-${pad(m, 2)} (FQ${fq})`;
}

const NOUN: Record<CohortGrain, string> = { week: 'Week', month: 'Month', quarter: 'Quarter' };

// ── What an encoding still needs ─────────────────────────────────────────────

function colOf(cols: ParsedColumn[], name: string | undefined): ParsedColumn | null {
  return name ? cols.find((c) => c && c.name === name) || null : null;
}

/** '' when the encoding can draw; otherwise the sentence the empty state shows. Columns only — no rows. */
export function cohortNeeds(cols: ParsedColumn[], enc: CohortEncoding | undefined): string {
  if (!enc || !enc.entity) return 'Pick the entity column — who the events belong to.';
  if (!colOf(cols, enc.entity)) return `The entity column "${enc.entity}" is not in this dataset.`;
  if (!enc.date) return 'Pick the event date column.';
  if (!colOf(cols, enc.date)) return `The date column "${enc.date}" is not in this dataset.`;
  if (enc.show === 'value') {
    if (!enc.value) return 'Pick a value column to show cumulative value.';
    const v = colOf(cols, enc.value);
    if (!v) return `The value column "${enc.value}" is not in this dataset.`;
    if (v.type !== 'number') return `"${enc.value}" is not a number column.`;
  }
  return '';
}

function emptyGrid(enc: CohortEncoding | undefined, needs: string): CohortGrid {
  const e = enc || sanitizeCohort({}) as CohortEncoding;
  return {
    grain: e.grain, show: e.show, curve: e.curve, cohorts: [], sizes: [], cells: [], average: [],
    periods: 0, periodNoun: NOUN[e.grain], excluded: 0, valueName: '', truncated: false, needs,
  };
}

// ── The JS reference ─────────────────────────────────────────────────────────

/** Empty is null OR '' OR whitespace — `sqlGen.sqlEmpty`'s class. */
const isEmpty = (cell: Cell): boolean => cell == null || String(cell).trim() === '';

/** The entity's identity, cast on its DECLARED type — or null to exclude the row. */
export function entityKey(cell: Cell, isNumber: boolean): string | number | null {
  if (isNumber) return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
  return isEmpty(cell) ? null : String(cell);
}

export interface CohortResult {
  grid: CohortGrid;
  warnings: string[];
}

/** The reference: columns + rows + a cohort encoding → the grid. Never throws. */
export function buildCohort(
  columns: ParsedColumn[],
  rows: Cell[][],
  enc: CohortEncoding | undefined,
  filters?: FilterStep[],
  cal: CalendarPrefs = getCalendar(),
): CohortResult {
  const warnings: string[] = [];
  let table: TableData = { columns: Array.isArray(columns) ? columns : [], rows: Array.isArray(rows) ? rows : [] };
  const needs = cohortNeeds(table.columns, enc);
  if (needs || !enc) return { grid: emptyGrid(enc, needs), warnings };
  if (filters && filters.length > 0) {
    const f = applyPipeline(table, filters);
    for (const w of f.warnings) warnings.push(w);
    table = { columns: f.columns, rows: f.rows };
  }
  const idx = (name: string): number => table.columns.findIndex((c) => c && c.name === name);
  const ei = idx(enc.entity);
  const di = idx(enc.date);
  const vi = enc.show === 'value' && enc.value ? idx(enc.value) : -1;
  const numEntity = table.columns[ei].type === 'number';

  const first = new Map<string | number, number>();
  const kept: Array<{ key: string | number; p: number; v: number | null }> = [];
  let excluded = 0;
  let last: number | null = null;
  for (const r of table.rows) {
    const key = entityKey(r[ei], numEntity);
    const day = periodDay(r[di]);
    if (key === null || day === null) { excluded += 1; continue; }
    const p = periodOrdinal(day, enc.grain, cal);
    const f = first.get(key);
    if (f === undefined || p < f) first.set(key, p);
    if (last === null || p > last) last = p;
    const v = vi >= 0 && typeof r[vi] === 'number' && Number.isFinite(r[vi]) ? (r[vi] as number) : null;
    kept.push({ key, p, v });
  }

  const cells = new Map<string, { c: number; k: number; members: Set<string | number>; value: number | null }>();
  for (const e of kept) {
    const c = first.get(e.key) as number;
    const k = e.p - c;
    const id = c + ':' + k;
    let cell = cells.get(id);
    if (!cell) cells.set(id, (cell = { c, k, members: new Set(), value: null }));
    cell.members.add(e.key);
    // `(acc ?? 0) + v`, left to right in file order — exactly DuckDB's
    // `sum(v ORDER BY ordinal)`, which starts from 0 (so -0 folds to 0 on both).
    if (e.v !== null) cell.value = (cell.value ?? 0) + e.v;
  }
  const groups: CohortGroups = {
    cells: [...cells.values()].map((x) => ({ c: x.c, k: x.k, active: x.members.size, value: x.value })),
    last,
    excluded,
  };
  return { grid: foldCohort(enc, groups, cal), warnings };
}

// ── The fold both paths share ────────────────────────────────────────────────

export function foldCohort(enc: CohortEncoding, g: CohortGroups, cal: CalendarPrefs = getCalendar()): CohortGrid {
  const out = emptyGrid(enc, '');
  out.excluded = g.excluded;
  if (enc.grain === 'month' && weekCalOf(cal)) out.periodNoun = 'Period';
  out.valueName = enc.show === 'value' && enc.value ? `${enc.value} per member` : '';
  const byCohort = new Map<number, Map<number, CohortCell>>();
  for (const cell of g.cells) {
    let m = byCohort.get(cell.c);
    if (!m) byCohort.set(cell.c, (m = new Map()));
    m.set(cell.k, cell);
  }
  let ords = [...byCohort.keys()].sort((a, b) => a - b);
  if (ords.length > COHORT_CAP) {
    ords = ords.slice(ords.length - COHORT_CAP);
    out.truncated = true;
  }
  if (!ords.length || g.last === null) return out;
  const last = g.last;
  let periods = last - ords[0] + 1;
  if (periods > COHORT_PERIOD_CAP) {
    periods = COHORT_PERIOD_CAP;
    out.truncated = true;
  }
  out.periods = periods;
  const num = new Array<number>(periods).fill(0);
  const den = new Array<number>(periods).fill(0);
  for (const c of ords) {
    const m = byCohort.get(c) as Map<number, CohortCell>;
    // Every member has an event in its own first period, so k = 0 IS the cohort.
    const size = m.get(0) ? (m.get(0) as CohortCell).active : 0;
    const row: (number | null)[] = [];
    let cum = 0;
    for (let k = 0; k < periods; k += 1) {
      if (k > last - c || size === 0) { row.push(null); continue; }
      const cell = m.get(k);
      if (enc.show === 'value') {
        cum += cell && cell.value !== null ? cell.value : 0;
        row.push(cum / size);
        num[k] += cum;
      } else {
        const active = cell ? cell.active : 0;
        row.push((active / size) * 100);
        num[k] += active;
      }
      den[k] += size;
    }
    out.cohorts.push(cohortLabel(c, enc.grain, cal));
    out.sizes.push(size);
    out.cells.push(row);
  }
  out.average = num.map((n, k) => (den[k] > 0 ? (enc.show === 'value' ? n / den[k] : (n / den[k]) * 100) : null));
  return out;
}

/**
 * The `{labels, series}` every grid-agnostic surface reads: the RETENTION
 * CURVE — one series per cohort plus the size-weighted average, over period
 * index. It is what the curve view draws, what an export photographs and what
 * the Assistant's facts list.
 */
export function cohortChartData(g: CohortGrid): { labels: string[]; series: { name: string; values: (number | null)[] }[] } {
  const labels = Array.from({ length: g.periods }, (_, k) => `${g.periodNoun} ${k}`);
  if (!g.cohorts.length) return { labels, series: [] };
  const series = g.cohorts.map((name, i) => ({ name, values: g.cells[i].slice() }));
  series.push({ name: 'Average', values: g.average.slice() });
  return { labels, series };
}

// ── The caption ──────────────────────────────────────────────────────────────

const pct1 = (v: number): string => `${Math.round(v * 10) / 10}%`;

/** "Week-4 retention averages 38%; the 2024-03-04 cohort retains best at 52%". */
export function cohortCaption(g: CohortGrid | null | undefined): string {
  if (!g || g.needs || !Array.isArray(g.cohorts) || g.cohorts.length === 0) return 'No data to summarize';
  const noun = g.periodNoun || NOUN[g.grain] || 'Period';
  const members = g.sizes.reduce((a, b) => a + b, 0);
  let k = Math.min(g.grain === 'week' ? 4 : g.grain === 'month' ? 3 : 1, g.periods - 1);
  while (k > 0 && g.average[k] == null) k -= 1;
  if (k <= 0) {
    return `${g.cohorts.length} ${g.cohorts.length === 1 ? 'cohort' : 'cohorts'}, ` +
      `${formatCompact(members)} ${members === 1 ? 'member' : 'members'}; no later ${noun.toLowerCase()} yet`;
  }
  const fmt = (v: number): string => (g.show === 'value' ? formatCompact(v) : pct1(v));
  let best = -1;
  for (let i = 0; i < g.cells.length; i += 1) {
    const v = g.cells[i][k];
    if (typeof v === 'number' && (best < 0 || v > (g.cells[best][k] as number))) best = i;
  }
  const lead = g.show === 'value'
    ? `${noun}-${k} value per member averages ${fmt(g.average[k] as number)}`
    : `${noun}-${k} retention averages ${fmt(g.average[k] as number)}`;
  if (best < 0 || g.cohorts.length < 2) return lead;
  return `${lead}; the ${g.cohorts[best]} cohort ${g.show === 'value' ? 'is highest' : 'retains best'} at ` +
    fmt(g.cells[best][k] as number);
}
