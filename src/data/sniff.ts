// What a dropped file REALLY is, from its bytes. PURE — buffers in, a verdict
// out; main reads the bytes (src/app/dropImport.ts), never the renderer.
//
// The extension is never consulted. A `.csv` that is really a PNG, a `.json`
// that is really CSV and a renamed program are all decided here by content:
//
//   Parquet   `PAR1` at BOTH ends (a head without the tail is a damaged file)
//   ZIP       `PK\x03\x04`; its central directory (read from the tail) says
//             whether it is a workbook (`[Content_Types].xml` + `xl/workbook.xml`)
//             or an Ordinate bundle (`manifest.json` + `project.json`)
//   JSON      UTF-8 text whose first character is `{` or `[` — classifyJson
//             then tells GeoJSON, a template and records apart by parsing
//   CSV/TSV   UTF-8 (BOM allowed), no NUL byte, and one delimiter that splits
//             the first records into the same number of fields
//
// Everything else is a refusal with a reason a toast can print after the name.

export const HEAD_BYTES = 64 * 1024;
export const TAIL_BYTES = 256 * 1024;

export type Sniff =
  | { ok: true; kind: 'parquet' }
  | { ok: true; kind: 'zip'; names: string[] | null }
  | { ok: true; kind: 'json' }
  | { ok: true; kind: 'csv'; delimiter: string }
  | { ok: false; reason: string };

/** Signatures of things that are certainly not data, named for the toast. */
const BINARY: Array<[number[], string]> = [
  [[0x89, 0x50, 0x4e, 0x47], 'a PNG image'],
  [[0xff, 0xd8, 0xff], 'a JPEG image'],
  [[0x47, 0x49, 0x46, 0x38], 'a GIF image'],
  [[0x25, 0x50, 0x44, 0x46], 'a PDF'],
  [[0x1f, 0x8b], 'a gzip archive'],
  [[0x7f, 0x45, 0x4c, 0x46], 'a program'],
  [[0xcf, 0xfa, 0xed, 0xfe], 'a program'],
  [[0xce, 0xfa, 0xed, 0xfe], 'a program'],
  [[0xca, 0xfe, 0xba, 0xbe], 'a program'],
  [[0x4d, 0x5a], 'a program'],
];

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(buf: Buffer, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
  return true;
}

/**
 * Classify a file from its first bytes (`head`, up to HEAD_BYTES), its last
 * bytes (`tail`, up to TAIL_BYTES) and its total `size`. For a file no larger
 * than HEAD_BYTES, head and tail are the whole file.
 */
export function sniffBytes(head: Buffer, tail: Buffer, size: number): Sniff {
  if (size === 0 || head.length === 0) return { ok: false, reason: 'is empty' };
  if (startsWith(head, [0x50, 0x41, 0x52, 0x31])) {
    const end = tail.subarray(tail.length - 4);
    return size >= 12 && end.toString('latin1') === 'PAR1'
      ? { ok: true, kind: 'parquet' }
      : { ok: false, reason: 'is a damaged Parquet file' };
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return { ok: true, kind: 'zip', names: zipNames(tail, size) };
  if (startsWith(head, OLE)) return { ok: false, reason: 'is an old Excel (.xls) or Office file — save it as .xlsx' };
  for (const [sig, what] of BINARY) if (startsWith(head, sig)) return { ok: false, reason: `is ${what}, not a data file` };
  if (head.includes(0)) return { ok: false, reason: 'is a binary file, not text' };

  const text = utf8(head, head.length >= size);
  if (text === null) return { ok: false, reason: 'is not UTF-8 text' };
  const body = text.replace(/^﻿/, '');
  const first = body.trimStart().charAt(0);
  if (!first) return { ok: false, reason: 'is empty' };
  if (first === '{' || first === '[') return { ok: true, kind: 'json' };
  const delimiter = csvDelimiter(body, head.length >= size);
  return delimiter === null
    ? { ok: false, reason: 'does not look like a table — its rows do not split into the same columns' }
    : { ok: true, kind: 'csv', delimiter };
}

/** Strict UTF-8 decode; a head cut mid-character drops that partial character. Null when invalid. */
export function utf8(buf: Buffer, whole: boolean): string | null {
  let end = buf.length;
  if (!whole) {
    // Walk back over continuation bytes to the last lead byte; if its sequence
    // runs past the cut, the cut is where the sequence starts.
    let p = end - 1;
    while (p > 0 && p > end - 4 && (buf[p] & 0xc0) === 0x80) p--;
    const lead = buf[p];
    const len = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (p + len > end) end = p;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, end));
  } catch {
    return null;
  }
}

const DELIMITERS = [',', '\t', ';', '|'];
const SAMPLE_RECORDS = 20;

/**
 * The delimiter that splits the first records consistently, or null.
 * Quote-aware (a delimiter or newline inside "…" does not count), so an
 * RFC-4180 file with embedded newlines still reads as one record per row.
 * "Consistent" = the header has ≥2 fields and at least 80% of the sampled
 * records have exactly as many. A file with no delimiter at all on ≥2 lines is
 * a single-column CSV.
 */
export function csvDelimiter(text: string, whole: boolean): string | null {
  let best: { d: string; n: number } | null = null;
  for (const d of DELIMITERS) {
    const counts = fieldCounts(text, d, whole);
    if (counts.length === 0) return null;
    const n = counts[0];
    if (n < 2) continue;
    const agree = counts.filter((c) => c === n).length;
    if (agree / counts.length >= 0.8 && (!best || n > best.n)) best = { d, n };
  }
  if (best) return best.d;
  const lines = fieldCounts(text, ',', whole);
  const anyDelim = DELIMITERS.some((d) => text.slice(0, 8192).includes(d));
  return lines.length >= 2 && !anyDelim ? ',' : null;
}

/** Fields per record for the first SAMPLE_RECORDS non-blank records. */
function fieldCounts(text: string, d: string, whole: boolean): number[] {
  const out: number[] = [];
  let fields = 1;
  let blank = true;
  let inQuotes = false;
  for (let i = 0; i < text.length && out.length < SAMPLE_RECORDS; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; blank = false; continue; }
    if (ch === d) { fields++; blank = false; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (!blank) out.push(fields);
      fields = 1;
      blank = true;
      continue;
    }
    if (ch !== ' ') blank = false;
  }
  // The last record counts only when the whole file was read — a head cut
  // mid-record would understate it.
  if (!blank && whole && out.length < SAMPLE_RECORDS) out.push(fields);
  return out;
}

/** Entry names from a ZIP's central directory, when the tail holds all of it; else null. */
export function zipNames(tail: Buffer, size: number): string[] | null {
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = tail.readUInt16LE(eocd + 10);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const tailStart = size - tail.length;
  if (cdOffset < tailStart) return null;
  const names: string[] = [];
  let p = cdOffset - tailStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > tail.length || tail.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = tail.readUInt16LE(p + 28);
    names.push(tail.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + tail.readUInt16LE(p + 30) + tail.readUInt16LE(p + 32);
  }
  return names;
}

/** What a ZIP's entry names make it: a workbook, a bundle candidate, or neither. */
export function classifyZip(names: string[] | null): 'xlsx' | 'bundle' | null {
  if (!names) return null;
  const has = (n: string): boolean => names.includes(n);
  if (has('[Content_Types].xml') && has('xl/workbook.xml')) return 'xlsx';
  if (has('manifest.json') && has('project.json')) return 'bundle';
  return null;
}

const GEO_TYPES = new Set(['FeatureCollection', 'Feature', 'Polygon', 'MultiPolygon', 'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'GeometryCollection']);
export const TEMPLATE_FORMAT = 'ordinate-template';

export type JsonKind = { ok: true; kind: 'geojson' | 'template' | 'json' } | { ok: false; reason: string };

/** Parse JSON text and say what it holds: GeoJSON, an Ordinate template, or records. */
export function classifyJson(text: string): JsonKind {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false, reason: 'is not valid JSON' };
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return { ok: false, reason: 'is an empty JSON list' };
    return data.every((r) => r !== null && typeof r === 'object')
      ? { ok: true, kind: 'json' }
      : { ok: false, reason: 'is a JSON list of plain values, not records' };
  }
  if (data === null || typeof data !== 'object') return { ok: false, reason: 'is a single JSON value, not records' };
  const o = data as Record<string, unknown>;
  if (typeof o.type === 'string' && GEO_TYPES.has(o.type)) return { ok: true, kind: 'geojson' };
  if (o.format === TEMPLATE_FORMAT) return { ok: true, kind: 'template' };
  return { ok: true, kind: 'json' };
}
