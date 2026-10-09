// Snowflake SQL API → ConnectorRows — MAIN PROCESS ONLY, pure (no network, no
// clock). Split out of snowflake.ts so the self-check drives every byte of the
// shaping off recorded JSON (scripts/test-connectorsSnowflake.ts), as
// shapeDatabricks is for Databricks.
//
// The SQL API ("jsonv2") sends every value as a STRING, and the meaning of the
// string is the column's `rowType` entry:
//
//   fixed          "123", "-4.50"           NUMBER(p,s)
//   real           "1.5", "NaN", "inf"      FLOAT / DOUBLE
//   date           "17982"                  days since 1970-01-01
//   time           "82919.000000000"        seconds since midnight
//   timestamp_ntz  "1616173619.000000000"   seconds since the epoch, wall clock
//   timestamp_ltz  "1616173619.000000000"   seconds since the epoch, an instant
//   timestamp_tz   "1616173619.000000000 1500"  the UTC instant, then the zone
//                                           offset in minutes + 1440
//   boolean        "true" / "false"
//   variant, object, array, map  JSON text (pretty-printed)
//   text, binary (hex), geography/geometry (GeoJSON) — as is
//
// So the declared type is never guessed from a value (CLAUDE.md, "cast on the
// DECLARED type"): `columnType` is set from rowType wherever rowType settles it.
// Three decisions worth knowing:
//
//   • FIXED wider than 15 digits is NOT declared a number. Snowflake's INTEGER
//     is NUMBER(38,0), so "precision > 15 → text" would make every integer
//     column unsummable; "→ number" would turn a 20-digit id into null
//     (parse.ts refuses a lossy number). Such a column is left undeclared, and
//     parse.ts's own rule decides from the values — exactly as for a CSV or a
//     Postgres bigint: a 16+ digit id keeps the column text, small counts make
//     it a number. Cells stay strings, so nothing is lost either way.
//   • A REAL is a binary double whose shortest spelling can need 17 digits
//     ("0.30000000000000004"), which parse.ts's strict rule (built for ids)
//     would null. For an EXTRACT the cell is printed at 15 significant digits —
//     DBL_DIG, what Postgres printed by default before v12 — so a declared
//     number survives the import. For LIVE (runBound) it is the exact double:
//     the live layer compares figures with Object.is.
//   • Zoned timestamps (LTZ, TZ) are written as UTC ISO-8601; the session runs
//     with TIMEZONE=UTC, and an NTZ wall clock is written the same way (read as
//     UTC, as the Postgres driver reads `timestamp` on a UTC server). Precision
//     is milliseconds, as everywhere else in the app.
//
// Strings are never trimmed: String.prototype.trim() strips U+FEFF, and a
// leading U+FEFF is data here (the self-check pins it).

import type { ColumnType } from '../data/parse';
import type { ConnectorColumn, ConnectorError } from './types';

export type Cell = string | number | boolean | null;

/** How a column's strings are read. */
export type SfKind =
  | 'fixed' | 'real' | 'text' | 'date' | 'time' | 'ts_ntz' | 'ts_ltz' | 'ts_tz' | 'boolean' | 'json' | 'binary' | 'other';

export interface SfColumn {
  name: string;
  kind: SfKind;
  /** NUMBER precision / scale, when rowType says. */
  precision?: number;
  scale?: number;
  /** The source type, spelled the way Snowflake's DESCRIBE does: NUMBER(38,0), TIMESTAMP_TZ, … */
  type: string;
}

/** EXTRACT prints a REAL at 15 significant digits; LIVE keeps the exact double. */
export type ShapeMode = 'extract' | 'live';

/** Digits a double is guaranteed to carry through a decimal round trip (DBL_DIG). */
const SAFE_DIGITS = 15;

// ── small typed accessors (no `any`) ─────────────────────────────────────────

export function prop(o: unknown, key: string): unknown {
  return o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

// ── rowType ─────────────────────────────────────────────────────────────────

const KIND: Readonly<Record<string, SfKind>> = {
  fixed: 'fixed', real: 'real', text: 'text', date: 'date', time: 'time',
  timestamp_ntz: 'ts_ntz', timestamp_ltz: 'ts_ltz', timestamp_tz: 'ts_tz', boolean: 'boolean',
  variant: 'json', object: 'json', array: 'json', map: 'json', binary: 'binary',
};

/** `resultSetMetaData.rowType` → one SfColumn per column. */
export function columnsOf(rowType: unknown): SfColumn[] {
  return asArray(rowType).map((r) => {
    const raw = asString(prop(r, 'type')).toLowerCase();
    const kind = KIND[raw] ?? 'other';
    const col: SfColumn = { name: asString(prop(r, 'name')), kind, type: raw ? raw.toUpperCase() : 'UNKNOWN' };
    const p = asInt(prop(r, 'precision'));
    const s = asInt(prop(r, 'scale'));
    if (p !== undefined) col.precision = p;
    if (s !== undefined) col.scale = s;
    if (kind === 'fixed') col.type = `NUMBER(${p ?? 38},${s ?? 0})`;
    else if (kind === 'real') col.type = 'FLOAT';
    else if (kind === 'text') col.type = 'VARCHAR';
    return col;
  });
}

/** True when every value a NUMBER(p,s) can hold survives a JS double exactly. */
function fitsDouble(col: SfColumn): boolean {
  return col.precision !== undefined && col.precision <= SAFE_DIGITS;
}

/** The ColumnType rowType DECLARES, or undefined to let parse.ts decide (see the header). */
export function columnTypeOf(col: SfColumn): ColumnType | undefined {
  switch (col.kind) {
    case 'fixed': return fitsDouble(col) ? 'number' : undefined;
    case 'real': return 'number';
    case 'date': case 'ts_ntz': case 'ts_ltz': case 'ts_tz': return 'date';
    case 'text': case 'time': case 'boolean': case 'json': case 'binary': return 'text';
    default: return undefined;
  }
}

/** SfColumn[] → the connector contract's columns (source type + declared ColumnType). */
export function connectorColumns(cols: SfColumn[]): ConnectorColumn[] {
  return cols.map((c) => {
    const out: ConnectorColumn = { name: c.name, type: c.type };
    const t = columnTypeOf(c);
    if (t) out.columnType = t;
    return out;
  });
}

// ── values ──────────────────────────────────────────────────────────────────

const EPOCH = /^(-?)(\d+)(?:\.(\d{1,9}))?$/;
const MAX_MS = 8.64e15; // the Date range

/** "seconds[.nanos]" since the epoch → ISO-8601 UTC (ms, floored), or null when it is not one.
 *  Plain arithmetic, no BigInt: every cell of a million-row extract comes through here. */
export function epochSecondsToIso(s: string): string | null {
  const m = EPOCH.exec(s);
  if (!m || m[2].length > 12) return null; // past ±9999 years either way
  const frac = (m[3] ?? '').padEnd(9, '0');
  let ms = Number(m[2]) * 1000 + Number(frac.slice(0, 3));
  if (m[1]) ms = -ms - (Number(frac.slice(3)) > 0 ? 1 : 0); // floor a negative instant with sub-ms digits
  return Math.abs(ms) <= MAX_MS ? new Date(ms).toISOString() : null;
}

/** "days" since 1970-01-01 → YYYY-MM-DD, or null. */
export function epochDaysToIso(s: string): string | null {
  if (!/^-?\d{1,7}$/.test(s)) return null;
  const iso = new Date(Number(s) * 86_400_000).toISOString();
  return /^\d{4}-/.test(iso) ? iso.slice(0, 10) : null; // years 0–9999 only
}

/** "seconds[.nanos]" since midnight → HH:MM:SS[.fraction], or null. */
export function secondsToTime(s: string): string | null {
  const m = /^(\d{1,5})(?:\.(\d{1,9}))?$/.exec(s);
  if (!m || Number(m[1]) >= 86_400) return null;
  const sec = Number(m[1]);
  const two = (n: number): string => String(n).padStart(2, '0');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  return `${two(Math.floor(sec / 3600))}:${two(Math.floor(sec / 60) % 60)}:${two(sec % 60)}${frac ? '.' + frac : ''}`;
}

/** A TIMESTAMP_TZ value: "<UTC epoch seconds> <offset index>" → the UTC instant, ISO. */
export function timestampTzToIso(s: string): string | null {
  const m = /^(-?\d+(?:\.\d{1,9})?) ([+-]?\d{1,4})$/.exec(s);
  return m ? epochSecondsToIso(m[1]) : null;
}

/** JSON text with the insignificant whitespace removed — lossless (numbers are never re-printed). */
export function compactJson(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') {
      out += ch;
    }
  }
  return out;
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NON_FINITE: Readonly<Record<string, number>> = { nan: NaN, inf: Infinity, infinity: Infinity, '-inf': -Infinity, '-infinity': -Infinity };

function realCell(s: string, mode: ShapeMode): Cell {
  const special = NON_FINITE[s.toLowerCase()];
  if (special !== undefined) return special;
  if (!NUMERIC.test(s)) return s;
  const n = Number(s);
  return mode === 'live' ? n : Number(n.toPrecision(SAFE_DIGITS));
}

/** One raw value → the cell the contract carries. Anything unexpected is kept as its string. */
export function cellOf(raw: unknown, col: SfColumn, mode: ShapeMode): Cell {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return JSON.stringify(raw);
  switch (col.kind) {
    case 'fixed':
      return fitsDouble(col) && NUMERIC.test(raw) ? Number(raw) : raw;
    case 'real':
      return realCell(raw, mode);
    case 'date':
      return epochDaysToIso(raw) ?? raw;
    case 'time':
      return secondsToTime(raw) ?? raw;
    case 'ts_ntz':
    case 'ts_ltz':
      return epochSecondsToIso(raw) ?? raw;
    case 'ts_tz':
      return timestampTzToIso(raw) ?? raw;
    case 'boolean': {
      const b = raw.toLowerCase();
      return b === 'true' || b === '1' ? true : b === 'false' || b === '0' ? false : raw;
    }
    case 'json':
      return compactJson(raw);
    default:
      return raw;
  }
}

/** A `data` array (rows of raw strings) → cells, under the columns' rules. */
export function rowsOf(data: unknown, cols: SfColumn[], mode: ShapeMode): Cell[][] {
  return asArray(data).map((row) => {
    const values = asArray(row);
    return cols.map((c, i) => cellOf(values[i], c, mode));
  });
}

// ── whole responses ─────────────────────────────────────────────────────────

/** The parts of a statement response the protocol reads. */
export interface SfStatus {
  handle: string;
  /** `statementStatusUrl` as sent — a PATH, which the caller re-anchors on its own origin. */
  statusUrl: string;
  code: string;
  message: string;
  sqlState: string;
}

const HANDLE_RE = /^[0-9A-Za-z-]{1,128}$/;

/** The status fields of any statement response; `handle` is '' when absent or malformed. */
export function statusOf(json: unknown): SfStatus {
  const handle = asString(prop(json, 'statementHandle'));
  return {
    handle: HANDLE_RE.test(handle) ? handle : '',
    statusUrl: asString(prop(json, 'statementStatusUrl')),
    code: asString(prop(json, 'code')),
    message: asString(prop(json, 'message')),
    sqlState: asString(prop(json, 'sqlState')),
  };
}

/** A finished statement's first response (HTTP 200): its columns, partition 0, and how many partitions there are. */
export interface SfFirst {
  ok: true;
  columns: SfColumn[];
  rows: Cell[][];
  partitions: number;
  numRows: number;
  handle: string;
}

/** Shape a 200 response. Pure — the self-check feeds it recorded fixtures. */
export function shapeFirst(json: unknown, mode: ShapeMode): SfFirst | ConnectorError {
  const meta = prop(json, 'resultSetMetaData');
  if (!meta || typeof meta !== 'object') return { ok: false, error: 'Snowflake sent a result without its column metadata' };
  const format = asString(prop(meta, 'format'));
  if (format && format !== 'jsonv2') return { ok: false, error: `Snowflake sent results in an unexpected format (${format.slice(0, 20)})` };
  const columns = columnsOf(prop(meta, 'rowType'));
  const info = asArray(prop(meta, 'partitionInfo'));
  return {
    ok: true,
    columns,
    rows: rowsOf(prop(json, 'data'), columns, mode),
    partitions: Math.max(1, info.length),
    numRows: asInt(prop(meta, 'numRows')) ?? 0,
    handle: statusOf(json).handle,
  };
}

/** Shape one further partition (`?partition=N`): data only, read under the first response's columns. */
export function shapePartition(json: unknown, columns: SfColumn[], mode: ShapeMode): Cell[][] {
  return rowsOf(prop(json, 'data'), columns, mode);
}
