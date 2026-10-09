// A Live dataset's PROFILE — what "Sync schema" learned about its columns from
// one sampled warehouse query (docs/live-data/00-plan.md L2.5) — MAIN, pure.
//
// The record of a Live dataset holds no rows, so everything that used to read
// a column's VALUES to help someone — the AI's context ("region" holds North,
// South, East, West), the filter picker's checkbox list, the "Split by" chip —
// reads this instead. It lives in the record's `live` block beside the cache
// age and the schema sync time (./liveDataset.ts), written only by the sync
// (src/engine/live/schemaSync.ts), and re-sanitized on every load like every
// other part of a record: a hand-edited profile is clipped, never trusted.
//
// Every figure here is a SAMPLE's: `filled` and `distinct` count the rows the
// sample held, so `distinct` is a lower bound of the table's (exact on a table
// the sample covers whole) and the share empty is the sample's. Everything
// that shows one says so ("~4 distinct", "in a sample of 10,000 rows").
//
// SAMPLE VALUES are kept only for a LOW-CARDINALITY TEXT column (≤ 50 distinct
// in the sample — a split a chart draws without "Other"), at most 20, most
// frequent first, and only values a picker can filter on exactly (≤ 200
// characters; a longer one is left out, never cut). They are the warehouse's
// data: a model is never shown those of a column marked personal or financial
// (src/ipc/liveProfile.ts `liveWithheld`), and a project bundle drops them
// under the share policy (src/app/sharePolicy.ts, `withoutSamples`).

import type { ParsedColumn } from './parse';
import type { DatasetMeta } from './datasets';

/** Sample values kept per low-cardinality text column. */
export const PROFILE_SAMPLE_VALUES = 20;
/** At or under this many distinct values in the sample, a text column is low-cardinality (categoryKey's CATEGORY_CAP). */
export const LOW_CARDINALITY = 50;
/** A sample value longer than this is left out: a picker filters on the whole value or not at all. */
export const MAX_SAMPLE_CHARS = 200;
/** Columns a profile may describe — the sample's cost model (src/engine/live/profileSql.ts) never asks for more. */
export const PROFILE_MAX_COLUMNS = 500;
/**
 * Characters of sample values one record keeps, all columns together. The
 * record is read on every live question (the cache key, the dialect), so it
 * stays small: without this, 500 text columns × 20 values × 200 characters
 * would be 2 MB. Past it, a column keeps its counts and lists fewer values, or
 * none — schema order decides who goes first, never the values.
 */
export const PROFILE_VALUE_CHARS = 64 * 1024;
/** Missing column names a record remembers. */
const MAX_MISSING = 200;
const MAX_NAME = 512;
const MAX_TYPE = 200;

/** Why a sync read no sample: too costly by the estimate, the warehouse failed, or a limit refused it. */
export type SampleSkip = 'tooCostly' | 'failed' | 'refused';
const SKIPS: ReadonlySet<string> = new Set<SampleSkip>(['tooCostly', 'failed', 'refused']);

/** One column as the last sync saw it. */
export interface LiveColumnProfile {
  name: string;
  /** The warehouse's own type name, verbatim. The compiler's safe cast reads it (liveSpec `LiveColumn.sourceType`). */
  sourceType?: string;
  /** Non-empty cells in the sample (null, '' and JS whitespace are empty — the compiler's rule). */
  filled?: number;
  /** Distinct non-empty values in the sample — the table's, approximately (a lower bound). */
  distinct?: number;
  /** A low-cardinality text column's most frequent values in the sample, most frequent first. */
  values?: string[];
  /** How often each of `values` occurred in the sample. */
  counts?: number[];
}

export interface LiveProfile {
  /** When the sample was read. Absent: no sample has been read yet. */
  sampledAt?: string;
  /** Rows the sample held. */
  sampleRows?: number;
  /** How the rows were chosen: the engine's sample clause over a table, or the first rows (LIMIT). */
  method?: 'sample' | 'limit';
  /** The last sync read no sample, and why — the figures, if any, are an earlier sync's. */
  skipped?: SampleSkip;
  columns: LiveColumnProfile[];
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const isoOf = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : undefined);
const nameOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' && v.length <= MAX_NAME ? v : undefined);

function sanitizeColumn(raw: unknown, budget: { chars: number }): LiveColumnProfile | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const name = o && nameOf(o.name);
  if (!o || !name) return null;
  const out: LiveColumnProfile = { name };
  if (typeof o.sourceType === 'string' && o.sourceType.length <= MAX_TYPE) out.sourceType = o.sourceType;
  const filled = count(o.filled);
  const distinct = count(o.distinct);
  if (filled !== undefined) out.filled = filled;
  if (distinct !== undefined) out.distinct = distinct;
  if (Array.isArray(o.values) && Array.isArray(o.counts)) {
    const values: string[] = [];
    const counts: number[] = [];
    for (let i = 0; i < o.values.length && values.length < PROFILE_SAMPLE_VALUES; i++) {
      const v = o.values[i];
      const n = count(o.counts[i]);
      if (typeof v !== 'string' || v.length > MAX_SAMPLE_CHARS || n === undefined || values.includes(v)) continue;
      if (v.length > budget.chars) break;
      budget.chars -= v.length;
      values.push(v);
      counts.push(n);
    }
    if (values.length) Object.assign(out, { values, counts });
  }
  return out;
}

/** A stored profile made safe and bounded (on every load, and before every write), or undefined when there is none worth keeping. */
export function sanitizeProfile(raw: unknown): LiveProfile | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || !Array.isArray(o.columns)) return undefined;
  const seen = new Set<string>();
  const columns: LiveColumnProfile[] = [];
  const budget = { chars: PROFILE_VALUE_CHARS };
  for (const c of o.columns) {
    if (columns.length >= PROFILE_MAX_COLUMNS) break;
    const named = c && typeof c === 'object' ? (c as Record<string, unknown>).name : undefined;
    if (typeof named === 'string' && seen.has(named)) continue; // a duplicate spends no budget
    const col = sanitizeColumn(c, budget);
    if (!col) continue;
    seen.add(col.name);
    columns.push(col);
  }
  const out: LiveProfile = { columns };
  const sampledAt = isoOf(o.sampledAt);
  const rows = count(o.sampleRows);
  if (sampledAt) out.sampledAt = sampledAt;
  if (rows !== undefined) out.sampleRows = rows;
  if (o.method === 'sample' || o.method === 'limit') out.method = o.method;
  if (typeof o.skipped === 'string' && SKIPS.has(o.skipped)) out.skipped = o.skipped as SampleSkip;
  return out;
}

/** The stored list of columns gone from the warehouse that something still names. */
export function sanitizeMissing(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = [...new Set(raw.map(nameOf).filter((n): n is string => !!n))].slice(0, MAX_MISSING);
  return out.length ? out : undefined;
}

/** A time stamp from a record, or undefined. */
export function sanitizeStamp(raw: unknown): string | undefined {
  return isoOf(raw);
}

// ── Readers: what the pickers, the split chip and the AI read ────────────────

type ProfileMeta = Pick<DatasetMeta, 'columns' | 'live'>;

/** The profile of one declared column of a Live dataset, or null (no profile, no such column). */
export function profileOf(meta: ProfileMeta, column: string): LiveColumnProfile | null {
  const p = meta.live?.profile;
  if (!p || !meta.columns.some((c) => c.name === column)) return null;
  return p.columns.find((c) => c.name === column) ?? null;
}

/**
 * The columns worth splitting an answer by (L2.4's `computeCard` "Split by"
 * chip): declared TEXT other than `category`, 2–12 distinct values in the
 * sample, fewest first, ties in schema order — the extract's
 * `answerSpec.splitCandidates(columns, rows, exclude)` rule, read from the
 * profile instead of the rows. Not a date: a live chart split by a date column
 * is refused (liveSpec `dateSeries`), so a date chip would offer a chart that
 * cannot be drawn. A column gone from the warehouse is not declared any more,
 * so it is never offered. No profile, no candidates — never a guess.
 */
export function profileSplitCandidates(meta: ProfileMeta, category: string): string[] {
  const p = meta.live?.profile;
  if (!p) return [];
  const missing = new Set(meta.live?.missingColumns ?? []);
  const out: { name: string; n: number; at: number }[] = [];
  meta.columns.forEach((c, at) => {
    if (c.type !== 'text' || c.name === category || missing.has(c.name)) return;
    const n = p.columns.find((x) => x.name === c.name)?.distinct;
    if (n !== undefined && n >= 2 && n <= 12) out.push({ name: c.name, n, at });
  });
  return out.sort((a, b) => a.n - b.n || a.at - b.at).map((x) => x.name);
}

/** `dataset:distinct`'s answer from the profile: the shape the extract's `readDistinctPage` returns, flagged as a sample's. */
export interface ProfileDistinct {
  values: string[];
  /** Matching values — or, unsearched, the column's distinct count in the sample (≥ the values listed). */
  total: number;
  /** Always true: the list and the total are a sample's, not the table's. */
  approximate: true;
}

/**
 * A column's values for a filter picker, from the profile. The search is the
 * extract's (`distinctValuesPageJs`: case-insensitive substring). A column
 * with no stored values (a number, a date, a high-cardinality text) answers
 * none, with its distinct count — the picker's Condition tab still works.
 * Null when the dataset has no profile, or the profile never measured this
 * column (one added since the last sample): the caller keeps refusing (D6) —
 * an empty list would read as "this column has no values".
 */
export function profileDistinct(meta: ProfileMeta, column: string, req: { limit?: number; search?: string } = {}): ProfileDistinct | null {
  const p = profileOf(meta, column);
  if (!p || p.distinct === undefined) return null;
  const cap = Math.max(0, Math.floor(typeof req.limit === 'number' ? req.limit : PROFILE_SAMPLE_VALUES));
  const needle = typeof req.search === 'string' ? req.search.toLowerCase() : '';
  const all = p.values ?? [];
  const hits = needle ? all.filter((v) => v.toLowerCase().includes(needle)) : all;
  const total = needle ? hits.length : Math.max(p.distinct, all.length);
  return { values: hits.slice(0, cap), total, approximate: true };
}

/** A sample value matrix (one row per value position), for the sensitivity detector's `rows`. */
export function sampleMatrix(columns: ParsedColumn[], profile: LiveProfile | undefined): (string | null)[][] {
  const lists = columns.map((c) => profile?.columns.find((p) => p.name === c.name)?.values ?? []);
  const n = lists.reduce((m, l) => Math.max(m, l.length), 0);
  return Array.from({ length: n }, (_, r) => lists.map((l) => (r < l.length ? l[r] : null)));
}

/**
 * A record's `live` block with the sample values of `columns` removed — what
 * leaves in a bundle under a mask or drop policy. Counts and types stay: they
 * are aggregates, like a masked export's figures. Returns whether it changed.
 */
export function withoutSamples(live: unknown, columns: ReadonlySet<string>): boolean {
  const o = live && typeof live === 'object' ? (live as Record<string, unknown>) : null;
  const p = o && o.profile && typeof o.profile === 'object' ? (o.profile as Record<string, unknown>) : null;
  if (!p || !Array.isArray(p.columns)) return false;
  let changed = false;
  for (const c of p.columns) {
    const col = c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
    if (!col || typeof col.name !== 'string' || !columns.has(col.name) || !('values' in col || 'counts' in col)) continue;
    delete col.values;
    delete col.counts;
    changed = true;
  }
  return changed;
}
