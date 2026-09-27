// An input table's COLUMN DEFINITIONS and its stored overlay — MAIN, pure.
//
// An input table is an ordinary dataset (`sourceKind: 'input'`) whose base
// table — the prepare SOURCE when it has a pipeline, else the table itself — is
// typed in the app. Its column definitions ARE that base table's column
// metadata: `{ name, type }` like every dataset, plus two optional keys only an
// input table sets, `required` and `lookup` (another dataset's key column).
// Everything downstream reads `name`/`type` and ignores the rest, which is what
// lets relationships, metrics, joins and alerts use an input table unchanged.
//
// The OVERLAY (`record.input.invalid`) is the text a user typed that the column's
// type cannot hold — `abc` in a number column. The Parquet stores NULL there
// (it must never hold a value that violates its column's type), and the overlay
// keeps what was typed so the grid can still show it, flagged, until it is
// fixed. It is data about the base table, positionally: [row, column, text].
//
// Every id is UUID-checked; every string is capped; anything malformed is
// dropped on the way in, from the renderer and from disk alike.

import type { ColumnType, ParsedColumn } from '../parse';
import type { Cell } from './edits';
import { isValidId } from '../../app/ids';

export interface InputLookup {
  datasetId: string;
  column: string;
}

export interface InputColumn extends ParsedColumn {
  required?: boolean;
  lookup?: InputLookup;
}

/** The record's `input` block. Absent when there is nothing in it. */
export interface InputBlock {
  invalid?: Array<[number, number, string]>;
}

/** The row cap — stated in the grid, enforced here and in every save. */
export const MAX_INPUT_ROWS = 10_000;
export const MAX_INPUT_COLUMNS = 50;
const MAX_NAME = 100;
const TYPES: readonly ColumnType[] = ['text', 'number', 'date'];

type Check = { ok: true; columns: InputColumn[] } | { ok: false; error: string };

function lookupOf(raw: unknown): InputLookup | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const col = typeof o.column === 'string' ? o.column.trim() : '';
  if (!isValidId(o.datasetId) || !col || col.length > 200) return undefined;
  return { datasetId: o.datasetId, column: col };
}

function columnOf(raw: unknown): InputColumn | string {
  if (!raw || typeof raw !== 'object') return 'Not a column';
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return 'Every column needs a name';
  if (name.length > MAX_NAME) return `Keep column names under ${MAX_NAME} characters`;
  const type = TYPES.includes(o.type as ColumnType) ? (o.type as ColumnType) : 'text';
  const col: InputColumn = { name, type };
  if (o.required === true) col.required = true;
  const lookup = lookupOf(o.lookup);
  if (lookup) col.lookup = lookup;
  return col;
}

/**
 * Validate the definitions a user sent (create, or Edit columns). The error is a
 * sentence the dialog shows as-is. Names are unique ignoring case — two columns
 * a reader cannot tell apart are one column too many.
 */
export function checkColumns(raw: unknown): Check {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Add at least one column' };
  if (raw.length > MAX_INPUT_COLUMNS) return { ok: false, error: `An input table can have up to ${MAX_INPUT_COLUMNS} columns` };
  const columns: InputColumn[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const c = columnOf(r);
    if (typeof c === 'string') return { ok: false, error: c };
    const key = c.name.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `Two columns are called "${c.name}"` };
    seen.add(key);
    columns.push(c);
  }
  return { ok: true, columns };
}

/** Stored definitions, leniently: a malformed column keeps its name and type. */
export function sanitizeColumns(raw: unknown): InputColumn[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r, i) => {
    const c = columnOf(r);
    return typeof c === 'string' ? { name: `col${i + 1}`, type: 'text' as ColumnType } : c;
  });
}

/** The record's overlay, off disk: in-range positions, strings only, one per cell. */
export function sanitizeInputBlock(raw: unknown, rowCount = MAX_INPUT_ROWS, width = MAX_INPUT_COLUMNS): InputBlock | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const list = (raw as Record<string, unknown>).invalid;
  if (!Array.isArray(list)) return undefined;
  const seen = new Set<string>();
  const invalid: Array<[number, number, string]> = [];
  for (const e of list) {
    if (!Array.isArray(e) || e.length !== 3) continue;
    const [r, c, t] = e;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= rowCount || c >= width) continue;
    if (typeof t !== 'string' || !t || t.length > 5000 || seen.has(r + ':' + c)) continue;
    seen.add(r + ':' + c);
    invalid.push([r, c, t]);
  }
  return invalid.length ? { invalid } : undefined;
}

/** The table as the grid shows it: the stored cells, with typed-but-refused text back in place. */
export function withOverlay(rows: Cell[][], block: InputBlock | undefined, width: number): Cell[][] {
  const out = rows.map((r) => {
    const row = Array.isArray(r) ? r.slice(0, width) : [];
    while (row.length < width) row.push(null);
    return row;
  });
  for (const [r, c, t] of (block && block.invalid) || []) {
    if (r < out.length && c < width && out[r][c] === null) out[r][c] = t;
  }
  return out;
}
