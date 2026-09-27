// File parsing + per-column type detection — MAIN PROCESS, pure logic.
// No Electron import, no fs of arbitrary paths: every parser here operates on
// strings/values handed in by the IPC layer. Messy input returns `warnings`
// instead of throwing.
//
// Covered here: RFC-4180 CSV (delimiter-configurable → also TSV), JSON
// (array-of-objects or 2D array), paste auto-detect (JSON/CSV/TSV), and
// text|number|date column classification.
//
// NOT here: xlsx. That is the next phase (read-only via exceljs in the
// datasets/ipc layer); parse.ts stays Electron- and exceljs-free so it can be
// unit-tested by a plain `node` self-check.

// ── Pinned output shape ──────────────────────────────────────────────────────

export type ColumnType = 'text' | 'number' | 'date';

export interface ParsedColumn {
  name: string;
  type: ColumnType;
}

export interface ParseResult {
  columns: ParsedColumn[];
  rows: (string | number | null)[][]; // parallel to columns; number when the column is numeric
  rowCount: number; // rows.length (post-cap; see MAX_ROWS)
  sheetNames?: string[]; // xlsx only; unused in this phase
  warnings: string[]; // human-readable, never throws
}

// MAX_ROWS caps the OUTPUT row count (slice + warning in finalize). It does NOT
// bound peak memory during parsing — the whole file is tokenized first. The real
// anti-OOM guard is the byte-size ceiling enforced BEFORE readFile in
// src/ipc/datasets.ts (MAX_FILE_BYTES); this cap just keeps the saved dataset and
// preview a sane size. ponytail: two guards, byte-ceiling upstream + row-cap here.
// Raised from 50,000 (2026-08). The old cap existed because every consumer
// materialised the whole table into Cell[][]: the JS fold, the IPC clone to the
// renderer, and the Explore grid, which re-copied the array on every keystroke.
// None of that is true any more — datasets are stored as Parquet, charts,
// metrics and stats query it in place, and the grid pulls one 500-row page at a
// time (src/datasetPage.ts). Parsing still materialises once, which is why this
// is 1,000,000 rather than unbounded; MAX_FILE_BYTES in src/ipc/datasets.ts is
// the real anti-OOM guard and is enforced before a byte is read.
const MAX_ROWS = 1_000_000;

// ── Public API ───────────────────────────────────────────────────────────────

// RFC-4180 CSV: quoted fields, "" escaped quotes, embedded commas/newlines,
// CRLF or LF. `delimiter` defaults to ',' — TSV reuses this with '\t'.
export function parseCsv(text: string, delimiter: string = ','): ParseResult {
  if (typeof text !== 'string' || text.trim() === '') return emptyResult('Empty file');
  const records = splitCsvRecords(text, delimiter);
  if (records.length === 0) return emptyResult('No rows found');
  const header = records[0];
  const body = records.slice(1);
  return finalize(header, body);
}

// JSON: array-of-objects (keys → columns, union of keys, missing → null) OR a
// 2D array (first row = headers when all non-numeric strings, else synthesized
// col1..colN). A bare object is treated as a single-row array-of-objects.
export function parseJson(text: string): ParseResult {
  if (typeof text !== 'string' || text.trim() === '') return emptyResult('Empty file');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return emptyResult('Could not parse as JSON or delimited text');
  }
  return parseJsonValue(data);
}

// Paste auto-detect: try JSON first (only accept array/object results — a bare
// number/string is not tabular), else sniff the delimiter by counting '\t' vs
// ',' on the first non-empty line, then parseCsv with that delimiter.
export function parsePaste(text: string): ParseResult {
  if (typeof text !== 'string' || text.trim() === '') return emptyResult('Empty file');
  try {
    const data: unknown = JSON.parse(text.trim());
    if (Array.isArray(data) || (data !== null && typeof data === 'object')) {
      return parseJsonValue(data);
    }
  } catch (_) {
    // not JSON — fall through to delimited sniffing
  }
  const line = firstNonEmptyLine(text);
  const tabs = countChar(line, '\t');
  const commas = countChar(line, ',');
  const delim = tabs > commas ? '\t' : ',';
  return parseCsv(text, delim);
}

// Classify one column's raw string cells (empty '' allowed and ignored):
//   number → every non-empty cell parses as a finite number
//   date   → every non-empty cell parses as a date (and not already a number)
//   text   → otherwise (and for an all-empty column)
export function detectColumnType(cells: string[]): ColumnType {
  const nonEmpty = cells.filter((c) => c != null && String(c).trim() !== '');
  if (nonEmpty.length === 0) return 'text';
  if (nonEmpty.every((c) => isFiniteNumber(c))) return 'number';
  if (nonEmpty.every((c) => looksLikeDate(c))) return 'date';
  return 'text';
}

// Shared table finalizer, exported for the xlsx reader (src/parseXlsx.ts) so a
// sheet's header + string-cell body runs through the exact same ragged-fix,
// per-column type detection, and coercion as CSV/JSON. Keeps parse.ts itself
// exceljs- and Electron-free (unit-testable under plain node).
export function finalizeTable(header: string[], body: string[][]): ParseResult {
  return finalize(header, body);
}

// ── Internal: CSV state-machine tokenizer ────────────────────────────────────

// The real RFC-4180 tokenizer: an in-quote flag, "" → " unescape, and
// delimiter/newline only split when not inside quotes. A trailing newline does
// not create a spurious empty final record.
function splitCsvRecords(text: string, delim: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  let i = 0;

  const endRecord = (): void => {
    record.push(field);
    field = '';
    records.push(record);
    record = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    // outside quotes
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      endRecord();
      i += text[i + 1] === '\n' ? 2 : 1; // consume optional LF of a CRLF
      continue;
    }
    if (ch === '\n') {
      endRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // flush the final field/record
  record.push(field);
  records.push(record);

  // a file ending in a newline leaves a trailing [''] record — drop it
  const last = records[records.length - 1];
  if (last && last.length === 1 && last[0] === '') records.pop();

  return records;
}

// ── Internal: shared finalize (ragged fix + type detect + coerce) ────────────

// The shared tail for every parser: enforce the row cap, pad/truncate ragged
// rows to header width (warn once), detect each column's type over its raw
// string cells, then coerce cells (number → JS number, empty → null, otherwise
// left as the original string so dates stay lossless).
function finalize(header: string[], body: string[][]): ParseResult {
  const warnings: string[] = [];
  const width = header.length;
  const names = header.map((h, i) => (h && h.trim() ? h.trim() : `col${i + 1}`));

  let rows = body;
  if (rows.length > MAX_ROWS) {
    warnings.push(`Row cap reached — kept first ${MAX_ROWS} of ${rows.length} rows`);
    rows = rows.slice(0, MAX_ROWS);
  }

  let ragged = false;
  const normalized: string[][] = rows.map((r) => {
    if (r.length !== width) ragged = true;
    if (r.length < width) return r.concat(new Array(width - r.length).fill(''));
    if (r.length > width) return r.slice(0, width);
    return r;
  });
  if (ragged) warnings.push(`Ragged rows — padded to ${width} columns`);
  if (normalized.length === 0) warnings.push('No rows found');

  const columns: ParsedColumn[] = names.map((name, c) => {
    const cells = normalized.map((r) => r[c] ?? '');
    return { name, type: detectColumnType(cells) };
  });

  const outRows: (string | number | null)[][] = normalized.map((r) =>
    r.map((cell, c) => coerceCell(cell, columns[c].type)),
  );

  return { columns, rows: outRows, rowCount: outRows.length, warnings };
}

function coerceCell(cell: string, type: ColumnType): string | number | null {
  if (cell == null || cell === '') return null;
  if (type === 'number') {
    // Gate on the STRICT rule, not loose Number(): identical output for the
    // initial parse (cells already passed isFiniteNumber during detection), but
    // it protects the RETYPE path (updateDataset) — retyping a "007"/zip/SKU or
    // a >15-digit id column to number must NOT corrupt it to 7 / lose precision.
    // Anything that isn't a lossless number becomes null, never a wrong value.
    return isFiniteNumber(cell) ? Number(cell) : null;
  }
  return cell; // text and date stay as the original string (lossless)
}

// Re-coerce a STORED cell (string | number | null) to a new column type. Used by
// datasets.updateDataset on a retype. Stringifies first (a stored number → its JS
// string form) then applies the same coerceCell logic, so number→text keeps the
// digits and text→number parses where possible; a non-numeric cell on a →number
// retype becomes null rather than NaN (number-accuracy).
export function coerceValue(value: string | number | null, type: ColumnType): string | number | null {
  if (value == null) return null;
  return coerceCell(String(value), type);
}

// ── Internal: JSON shaping ───────────────────────────────────────────────────

function parseJsonValue(data: unknown): ParseResult {
  let arr: unknown[];
  if (Array.isArray(data)) {
    arr = data;
  } else if (data !== null && typeof data === 'object') {
    arr = [data]; // a bare object → single-row array-of-objects
  } else {
    return emptyResult('No rows found');
  }
  if (arr.length === 0) return emptyResult('No rows found');
  if (Array.isArray(arr[0])) return parse2dArray(arr as unknown[][]);
  return parseObjectArray(arr);
}

function parseObjectArray(arr: unknown[]): ParseResult {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const obj of arr) {
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) {
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      }
    }
  }
  if (keys.length === 0) return emptyResult('No rows found');
  const body: string[][] = arr.map((obj) =>
    keys.map((k) => {
      const rec = obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>) : {};
      const v = rec[k];
      return v == null ? '' : String(v);
    }),
  );
  return finalize(keys, body);
}

function parse2dArray(arr: unknown[][]): ParseResult {
  const first = arr[0];
  // First row is a header only when every cell is a non-numeric string.
  const isHeaderRow = first.every((c) => typeof c === 'string' && !isFiniteNumber(c));
  const extra: string[] = [];
  let header: string[];
  let body: unknown[][];
  if (isHeaderRow) {
    header = first.map((c) => String(c));
    body = arr.slice(1);
  } else {
    // Plain loop, not Math.max(0, ...arr.map(...)): arr is the whole uncapped JSON
    // array (bounded only by the 100 MB byte ceiling), and argument-spread over
    // ~65k+ elements throws RangeError — which would fail a valid import instead of
    // trimming to MAX_ROWS.
    let width = 0;
    for (const r of arr) {
      const len = Array.isArray(r) ? r.length : 1;
      if (len > width) width = len;
    }
    header = Array.from({ length: width }, (_, i) => `col${i + 1}`);
    body = arr;
    extra.push('No header row detected — using generated column names');
  }
  const bodyStr: string[][] = body.map((r) =>
    (Array.isArray(r) ? r : [r]).map((c) => (c == null ? '' : String(c))),
  );
  const res = finalize(header, bodyStr);
  res.warnings = extra.concat(res.warnings);
  return res;
}

// ── Internal: scalar predicates + small helpers ──────────────────────────────

// A cell counts as a NUMBER only if it is a plain numeric literal that survives
// Number() without changing identity. This is deliberately strict so identifier-
// like columns are NOT silently corrupted: "007" would become 7 (zip/SKU/phone
// leading zeros lost) and a 20-digit id would lose precision past 2^53. Those
// stay text. Genuine numeric data (12, -3.5, 1.50, 2.4e3) still classifies as
// number. Number-accuracy is a core promise of the app, so err toward text.
export function isFiniteNumber(s: string): boolean {
  const t = String(s).trim();
  if (t === '') return false;
  // Strict decimal/exponent literal only (blocks hex/octal/Infinity/"1,200"/whitespace-in-middle).
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return false;
  // Leading-zero integer part = an identifier (007, 0123), not a number.
  if (/^[+-]?0\d/.test(t)) return false;
  // >15 significant digits can't round-trip through a JS double without loss.
  if (t.replace(/[^\d]/g, '').length > 15) return false;
  return Number.isFinite(Number(t));
}

export function looksLikeDate(s: string): boolean {
  const t = String(s).trim();
  if (t === '') return false;
  if (isFiniteNumber(t)) return false; // a bare integer like "2024" is a number, not a date
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t)) return true; // YYYY-MM-DD / YYYY/MM/DD
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(t)) return true; // MM/DD/YYYY
  // A bare all-digit string (e.g. "007", a zip, an id) is NOT a date — without
  // this guard Date.parse("007") succeeds and would mis-type identifier columns.
  if (/^[+-]?\d+$/.test(t)) return false;
  return !Number.isNaN(Date.parse(t)); // permissive fallback (e.g. "Jan 5, 2023")
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() !== '') return line;
  }
  return '';
}

function countChar(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i += 1) if (s[i] === ch) count += 1;
  return count;
}

function emptyResult(warning: string): ParseResult {
  return { columns: [], rows: [], rowCount: 0, warnings: [warning] };
}
