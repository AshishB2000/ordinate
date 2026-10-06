// Capture → dataset bridge — PURE logic, MAIN PROCESS.
// Imports only ./parse (no fs), exactly like parse.ts, so it is
// unit-testable under plain `node`. Its whole job is to resolve the mismatch
// between the capture pipeline's `extractedTable` (columns carry id/label/role +
// a MODEL type hint; rows are OBJECTS keyed by column id) and a Dataset (columns
// are {name,type}; rows are ARRAYS in column order; types decided by the STRICT
// number rule, never trusted from the model).
//
// The single source of truth for typing/coercion is parse.ts. buildDraft routes
// through parse.finalizeTable (same ragged-fix + detectColumnType + coerce +
// warnings used by CSV/JSON/xlsx); coerceFinal + alignForAppend route through
// parse.coerceValue (the same helper datasets.updateDataset uses on a retype). So
// a screenshot of a spreadsheet/PDF/dashboard/table normalizes IDENTICALLY to an
// imported file, and identifier columns ("007"/zip/>15-digit id) stay text.

import * as parse from './parse';
import type { ParsedColumn, ParseResult } from './parse';

// The shape parseReply() produces in src/analyze.ts. Everything is optional/loose
// because this receives an untrusted, possibly-empty extraction.
export interface ExtractedTable {
  columns?: Array<{ id?: string; label?: string; role?: string | null; type?: string | null; periodOrder?: number } | null>;
  rows?: Array<Record<string, unknown> | null>;
}

// ── toBody ────────────────────────────────────────────────────────────────────
// Project the object-keyed extraction into a header + string body in COLUMN ORDER.
// `header` = each column's label (fallback id). For each row, emit cells by
// looking up row[col.id]; a missing key or null → '', anything else → String(v).
// Extra/ragged keys in a row object are ignored (only declared columns project).
// Empty columns → { header: [], body: [] } (no spurious empty-row arrays).
export function toBody(extractedTable: ExtractedTable | null | undefined): { header: string[]; body: string[][] } {
  const cols = Array.isArray(extractedTable?.columns) ? extractedTable!.columns : [];
  const rows = Array.isArray(extractedTable?.rows) ? extractedTable!.rows : [];
  if (cols.length === 0) return { header: [], body: [] };

  const ids = cols.map((c) => (c && typeof c.id === 'string' ? c.id : ''));
  const header = cols.map((c, i) => {
    const label = c && typeof c.label === 'string' && c.label.trim() ? c.label : ids[i];
    return label;
  });
  const body = rows.map((row) =>
    ids.map((id) => {
      const v = row && typeof row === 'object' ? (row as Record<string, unknown>)[id] : undefined;
      return v == null ? '' : String(v);
    }),
  );
  return { header, body };
}

// ── buildDraft / extractedTableToTable ──────────────────────────────────────────
// The review-grid seed. Runs the SAME finalize as every file parser, so odd/
// empty/ragged extractions surface as `warnings` ("Ragged rows — padded to N
// columns", "No rows found") the grid can show, and each column's type is the
// strict-rule detection — never the model's hint. Returns a full ParseResult.
export function extractedTableToTable(extractedTable: ExtractedTable | null | undefined): ParseResult {
  const { header, body } = toBody(extractedTable);
  return parse.finalizeTable(header, body);
}

// Spec alias — the review UI calls this the "draft".
export const buildDraft = extractedTableToTable;

// ── coerceFinal ──────────────────────────────────────────────────────────────
// Applied on SAVE, after the user may have renamed columns / changed types / edited
// cells in the review grid. The user's explicit type choice must WIN, so we do NOT
// re-detect here — we coerce each cell to the chosen column type via the same
// parse.coerceValue used on a retype (number→ keeps lossless digits or nulls a
// non-number, text/date→ keep the string). A non-empty cell that becomes null on a
// `number` column is a value the model likely mis-read and the user didn't fix, so
// we surface a soft warning per affected column.
export function coerceFinal(
  columns: ParsedColumn[],
  body: string[][],
): { rows: (string | number | null)[][]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: (string | number | null)[][] = body.map((r) =>
    columns.map((col, c) => parse.coerceValue(r[c] ?? '', col.type)),
  );
  columns.forEach((col, c) => {
    if (col.type !== 'number') return;
    let lost = 0;
    for (const r of body) {
      const raw = r[c];
      if (raw != null && String(raw).trim() !== '' && parse.coerceValue(raw, 'number') === null) lost += 1;
    }
    if (lost > 0) {
      warnings.push(`${lost} non-numeric value${lost === 1 ? '' : 's'} in "${col.name}" ${lost === 1 ? 'was' : 'were'} left empty`);
    }
  });
  return { rows, warnings };
}

// ── alignForAppend ───────────────────────────────────────────────────────────
// APPEND a fresh capture into an existing capture-dataset. Match incoming columns
// to existing ones BY NAME (case-insensitive, trimmed); build each new row in the
// EXISTING column order, filling an unmatched existing column with '' then coercing
// to that existing column's type. Warn on dropped unmatched incoming columns and on
// existing columns that got no incoming match. Returns only the NEW rows — the
// caller concatenates them onto existing.rows.
export function alignForAppend(
  existingColumns: ParsedColumn[],
  draftColumns: ParsedColumn[],
  draftBody: string[][],
): { rows: (string | number | null)[][]; warnings: string[] } {
  const warnings: string[] = [];
  const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

  // First incoming column wins on a duplicate name.
  const draftIndexByName = new Map<string, number>();
  draftColumns.forEach((c, i) => {
    const k = norm(c.name);
    if (!draftIndexByName.has(k)) draftIndexByName.set(k, i);
  });

  const existingNames = new Set(existingColumns.map((c) => norm(c.name)));
  for (const c of draftColumns) {
    if (!existingNames.has(norm(c.name))) warnings.push(`Column "${c.name}" is not in the target dataset — dropped`);
  }

  const matchIdx = existingColumns.map((ec) => {
    const di = draftIndexByName.get(norm(ec.name));
    return di === undefined ? -1 : di;
  });
  matchIdx.forEach((di, i) => {
    if (di === -1) warnings.push(`No incoming column matched "${existingColumns[i].name}" — filled empty`);
  });

  const rows: (string | number | null)[][] = draftBody.map((r) =>
    existingColumns.map((ec, i) => {
      const di = matchIdx[i];
      const raw = di === -1 ? '' : r[di] ?? '';
      return parse.coerceValue(raw, ec.type);
    }),
  );
  return { rows, warnings };
}
