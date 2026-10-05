// Incremental refresh — the settings, the cursor arithmetic and the JS
// REFERENCE merge. MAIN PROCESS, pure: no fs, no DuckDB.
//
// A connection (or folder) dataset can refresh by fetching only the rows past a
// stored HIGH-WATER MARK on a cursor column (a monotonic timestamp or id), minus
// an optional lookback window that re-reads recent rows to catch late updates.
// The fetched batch is then merged into the stored table:
//
//   • KEY column set → UPSERT. Within the batch, the row with the greatest cursor
//     wins for each key (a tie goes to the LATER row in fetch order). The winner
//     replaces the FIRST stored row with that key, in place; any further stored
//     rows with that key are dropped. Winners whose key is new are appended, in
//     the batch order of the winning row. `updated` counts replaced rows whose
//     cells actually changed; an identical re-read is not an update.
//     A row whose KEY is EMPTY (null, '' or whitespace — isEmptyCell) has no
//     identity to upsert by: it follows the APPEND rule below, against the
//     stored rows whose key is also empty. All appended rows (new winners and
//     empty-key rows) keep batch order.
//   • No key → APPEND, as a multiset difference: a fetched row is appended only
//     when the batch holds MORE copies of it than the stored table already does.
//     That is what dedupes the lookback overlap (a row already stored, read again,
//     is not appended twice) without dropping a real duplicate the source holds,
//     and it makes a replay after a crash idempotent.
//
// Keys and "identical" compare the STORAGE form of a cell (String(cell), null
// kept distinct from ''), which is exactly what the Parquet file holds — so this
// reference and the DuckDB merge (src/engine/incrementalDuck.ts) can agree with
// Object.is. That merge is the real path; this one is what it is tested against.
//
// A row whose cursor is empty or unreadable cannot be placed against the mark,
// so an incremental run never fetches it. The full refresh every 7th run (or on
// demand) picks such rows up — and corrects any other drift.

import type { ColumnType, ParsedColumn } from './parse';
import { isFiniteNumber, looksLikeDate } from './parse';
import { isEmptyCell } from './transforms';

export type Cell = string | number | null;

/** Every Nth run is a full one: six incremental runs, then a full. */
export const FULL_EVERY = 7;
/** Refresh-log entries kept on the record, newest first. */
export const MAX_LOG = 20;
const MAX_NAME = 512;
/** A lookback past ~31 years (seconds) or 1e12 ids is a full refresh in disguise. */
const MAX_LOOKBACK = 1e12;

/** How a run got its rows. */
export type FetchHow = 'server' | 'files' | 'after' | 'unchanged' | 'full';

export interface IncrementalLogEntry {
  at: string;
  mode: 'full' | 'incremental';
  /** Rows the source returned (after the cursor filter, for an incremental run). */
  fetched: number;
  /** Null on a full run: the table was replaced, not merged. */
  inserted: number | null;
  updated: number | null;
  highWater: Cell;
  how: FetchHow;
  /** Why a run was full, or anything else worth a line. */
  note?: string;
}

export interface IncrementalSettings {
  enabled: boolean;
  cursorColumn: string;
  keyColumn?: string;
  /** Seconds for a date cursor, a count for a number cursor. 0 = none. */
  lookback: number;
  highWater: Cell;
  runsSinceFull: number;
  lastFullAt?: string;
  /** When the last successful run STARTED. */
  lastRunAt?: string;
  /**
   * A folder table's file as the last successful run saw it (size, mtime and
   * ctime, taken before the read). "Unchanged" means this exact stamp, not
   * "mtime older than the last run": a sync client, rsync or unzip delivers
   * new data with an OLD mtime, but cannot keep the ctime.
   */
  fileStamp?: string;
  /** "Full refresh now": the next run is full. Cleared by a successful full run. */
  fullNext?: boolean;
  log: IncrementalLogEntry[];
}

// ── Sanitising (every load, every write) ─────────────────────────────────────

const iso = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : undefined;
const name = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_NAME) : '');
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e9 ? v : null;

function cell(v: unknown): Cell {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, MAX_NAME);
  return null;
}

function sanitizeEntry(raw: unknown): IncrementalLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const at = iso(o.at);
  const fetched = count(o.fetched);
  if (!at || fetched === null || (o.mode !== 'full' && o.mode !== 'incremental')) return null;
  const how: FetchHow = (['server', 'files', 'after', 'unchanged', 'full'] as const).includes(o.how as FetchHow)
    ? (o.how as FetchHow) : (o.mode === 'full' ? 'full' : 'after');
  const out: IncrementalLogEntry = {
    at, mode: o.mode, fetched, inserted: count(o.inserted), updated: count(o.updated), highWater: cell(o.highWater), how,
  };
  if (typeof o.note === 'string' && o.note) out.note = o.note.slice(0, 300);
  return out;
}

/**
 * Whitelist a stored or IPC-sent `incremental` block. Only a CONNECTION origin
 * can carry one (folders are connections too); anything else has no cursor to
 * push and is dropped, like an autoRefresh on a dataset with no origin.
 */
export function sanitizeIncremental(raw: unknown, originKind: string | undefined): IncrementalSettings | undefined {
  if (originKind !== 'connection' || !raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const cursorColumn = name(o.cursorColumn);
  if (!cursorColumn) return undefined;
  const lookback = typeof o.lookback === 'number' && Number.isFinite(o.lookback) && o.lookback > 0
    ? Math.min(o.lookback, MAX_LOOKBACK) : 0;
  const out: IncrementalSettings = {
    enabled: o.enabled === true,
    cursorColumn,
    lookback,
    highWater: cell(o.highWater),
    runsSinceFull: Math.min(count(o.runsSinceFull) ?? 0, 1000),
    log: (Array.isArray(o.log) ? o.log : []).map(sanitizeEntry).filter((e): e is IncrementalLogEntry => !!e).slice(0, MAX_LOG),
  };
  const keyColumn = name(o.keyColumn);
  if (keyColumn) out.keyColumn = keyColumn;
  const lastFullAt = iso(o.lastFullAt);
  if (lastFullAt) out.lastFullAt = lastFullAt;
  const lastRunAt = iso(o.lastRunAt);
  if (lastRunAt) out.lastRunAt = lastRunAt;
  if (typeof o.fileStamp === 'string' && /^[\d.:]{1,80}$/.test(o.fileStamp)) out.fileStamp = o.fileStamp;
  if (o.fullNext === true) out.fullNext = true;
  return out;
}

// ── The cursor ───────────────────────────────────────────────────────────────

/** A cursor column must be ordered: a number or a date, never text. */
export function isCursorType(t: ColumnType | undefined): t is 'number' | 'date' {
  return t === 'number' || t === 'date';
}

/**
 * The comparable value of a cursor cell on the column's DECLARED type: the
 * number itself, or a date's epoch milliseconds (the same Date.parse the date
 * detector trusts). Null for an empty or unreadable cell.
 */
export function cursorKey(v: Cell, type: ColumnType): number | null {
  if (v == null || v === '') return null;
  if (type === 'number') {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    return isFiniteNumber(v) ? Number(v) : null;
  }
  if (type === 'date') {
    const t = Date.parse(String(v));
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** The lowest cursor an incremental run asks for: the mark minus the lookback. */
export function lowerBound(highWaterKey: number, lookback: number, type: 'number' | 'date'): number {
  return highWaterKey - (type === 'date' ? lookback * 1000 : lookback);
}

/** The cell with the greatest cursor (the first one on a tie), or null. */
export function maxCursor(rows: Cell[][], idx: number, type: ColumnType): { value: Cell; key: number } | null {
  let best: { value: Cell; key: number } | null = null;
  for (const r of rows) {
    const k = cursorKey(r[idx] ?? null, type);
    if (k !== null && (best === null || k > best.key)) best = { value: r[idx] ?? null, key: k };
  }
  return best;
}

// ── A fetched batch, in the stored table's shape ─────────────────────────────

/** The header normalisation parse.finalize applies, so names compare like for like. */
export function headerNames(header: string[]): string[] {
  return header.map((h, i) => (h && h.trim() ? h.trim() : `col${i + 1}`));
}

/**
 * Coerce a fetched batch (raw strings, as the type detector would see them) to
 * the STORED columns' types, exactly as parse.coerceValue would. A batch whose
 * columns differ, or that puts text into a number/date column, is refused with
 * a reason — the caller then runs a full refresh, which re-detects the types,
 * rather than nulling the cells that no longer fit.
 */
export function toBaseRows(
  header: string[],
  body: string[][],
  columns: ParsedColumn[],
): { ok: true; rows: Cell[][] } | { ok: false; reason: string } {
  const names = headerNames(header);
  if (names.length !== columns.length || names.some((n, i) => n !== columns[i].name)) {
    return { ok: false, reason: 'The source columns changed' };
  }
  const rows: Cell[][] = new Array(body.length);
  for (let r = 0; r < body.length; r++) {
    const src = body[r] || [];
    const out: Cell[] = new Array(columns.length);
    for (let c = 0; c < columns.length; c++) {
      const s = src[c] ?? '';
      const t = columns[c].type;
      if (t === 'number') {
        if (s.trim() !== '' && !isFiniteNumber(s)) return { ok: false, reason: `"${columns[c].name}" no longer holds only numbers` };
        out[c] = isFiniteNumber(s) ? Number(s) : null;
      } else {
        if (t === 'date' && s.trim() !== '' && !looksLikeDate(s)) return { ok: false, reason: `"${columns[c].name}" no longer holds only dates` };
        out[c] = s === '' ? null : s;
      }
    }
    rows[r] = out;
  }
  return { ok: true, rows };
}

/**
 * Keep the rows at or past `lower` (null = keep every row with a cursor), with
 * each one's cursor key. `>=`, not `>`: a row that arrived later with exactly
 * the mark's value must not be skipped, and the merge dedupes the overlap.
 */
export function filterBatch(rows: Cell[][], idx: number, type: ColumnType, lower: number | null): { rows: Cell[][]; keys: number[] } {
  const out: Cell[][] = [];
  const keys: number[] = [];
  for (const r of rows) {
    const k = cursorKey(r[idx] ?? null, type);
    if (k === null || (lower !== null && k < lower)) continue;
    out.push(r);
    keys.push(k);
  }
  return { rows: out, keys };
}

// ── The JS reference merge ───────────────────────────────────────────────────

export interface MergeResult {
  rows: Cell[][];
  inserted: number;
  updated: number;
}

const storage = (v: Cell | undefined): string | null => (v == null ? null : String(v));
const rowKey = (r: Cell[], width: number): string => {
  const parts: (string | null)[] = new Array(width);
  for (let c = 0; c < width; c++) parts[c] = storage(r[c]);
  return JSON.stringify(parts);
};

/** Merge `batch` (with its cursor keys) into `base`. See the header for the rules. */
export function mergeJs(base: Cell[][], batch: Cell[][], keys: number[], keyIndex: number | null, width: number): MergeResult {
  if (keyIndex === null) {
    const added = appendIdx(base, batch, width).map((i) => batch[i]);
    return { rows: base.concat(added), inserted: added.length, updated: 0 };
  }

  const keyed = (r: Cell[]): boolean => !isEmptyCell(r[keyIndex] ?? null);
  const kOf = (r: Cell[]): string => JSON.stringify([storage(r[keyIndex])]);
  // The winner per key: greatest cursor, the later row on a tie.
  const win = new Map<string, number>();
  batch.forEach((r, i) => {
    if (!keyed(r)) return;
    const k = kOf(r);
    const cur = win.get(k);
    if (cur === undefined || keys[i] >= keys[cur]) win.set(k, i);
  });
  const first = new Map<string, number>();
  base.forEach((r, i) => {
    const k = kOf(r);
    if (keyed(r) && !first.has(k)) first.set(k, i);
  });
  const out: Cell[][] = [];
  let updated = 0;
  base.forEach((r, i) => {
    const k = kOf(r);
    const w = win.get(k);
    if (w === undefined) { out.push(r); return; }
    if (first.get(k) !== i) return; // a further stored row with this key: dropped
    const next = batch[w];
    if (rowKey(next, width) !== rowKey(r, width)) updated++;
    out.push(next);
  });
  const fresh = [...win.entries()].filter(([k]) => !first.has(k)).map(([, i]) => i);
  // Empty-key rows: the append rule, against the stored empty-key rows.
  const emptyBase = base.filter((r) => !keyed(r));
  const emptyIdx: number[] = [];
  batch.forEach((r, i) => { if (!keyed(r)) emptyIdx.push(i); });
  const emptyAdded = appendIdx(emptyBase, emptyIdx.map((i) => batch[i]), width).map((j) => emptyIdx[j]);
  const appended = fresh.concat(emptyAdded).sort((a, b) => a - b);
  for (const i of appended) out.push(batch[i]);
  return { rows: out, inserted: appended.length, updated };
}

/** The multiset difference: indexes of `batch` rows beyond the copies `base` already holds. */
function appendIdx(base: Cell[][], batch: Cell[][], width: number): number[] {
  const have = new Map<string, number>();
  for (const r of base) {
    const k = rowKey(r, width);
    have.set(k, (have.get(k) || 0) + 1);
  }
  const seen = new Map<string, number>();
  const out: number[] = [];
  batch.forEach((r, i) => {
    const k = rowKey(r, width);
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > (have.get(k) || 0)) out.push(i);
  });
  return out;
}
