// An input table's EDIT MODEL — PURE, and loaded by BOTH processes:
//
//   main      `import * as edits from './edits'` — the save path replays the
//             renderer's batches over the stored table (./store.ts), trusting
//             nothing: every op is re-checked here before it touches a row;
//   renderer  `<script src="../../src/data/inputTable/edits.js">` between
//             cjsShim.js and inputBind.js, which expose it as `OrdInputEdits` —
//             the grid applies the SAME batches to what it shows, and keeps its
//             undo stack of them.
//
// One module, so the grid and the stored table cannot disagree about what a
// paste, a fill or a row delete does. THIS FILE MUST NOT IMPORT ANYTHING AT
// RUNTIME (the renderer loads its CommonJS output through a shim with no
// `require`), and no function may read an EXPORTED const — tsc compiles that
// read as `exports.X`, and the binder clears `exports` once it has the module.
// Limits live in module-local consts, exported as aliases.
//
// ── The model ────────────────────────────────────────────────────────────────
// A BATCH is one user action — a cell edit, a paste block, a fill, a clear, a
// row add or delete — and it is applied ATOMICALLY: every op is checked, and one
// bad op rejects the whole batch with the rows untouched. Applying a batch
// returns its exact INVERSE, built from the values it overwrote, so undo is
// "apply the inverse" and redo is "apply the batch again". One batch is one undo
// step, and (./store.ts) one version in the dataset's history.
//
// Rows are copy-on-write: `applyBatch` never mutates the array or any row it was
// given, which is what lets the renderer's undo entries and main's
// before-the-save table share rows safely.
//
// Cells here are what the user TYPED — `'12'` in a number column stays a string.
// Coercion to the column's type (and the reasons a value is refused) is main's
// job, in ./validate.ts; this file only moves values around.

export type Cell = string | number | null;

/**
 * One op. `set` writes a rectangle whose top-left is (r, c) — a single cell is
 * a 1×1 rectangle, a paste row is 1×n. `ins` inserts whole rows before `at`
 * (at === rowCount appends). `del` removes `n` rows starting at `at`.
 */
export type Op =
  | { t: 'set'; r: number; c: number; cells: Cell[][] }
  | { t: 'ins'; at: number; rows: Cell[][] }
  | { t: 'del'; at: number; n: number };

export interface Batch {
  label: string;
  ops: Op[];
}

export interface Applied {
  rows: Cell[][];
  inverse: Batch;
}

export interface Range {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** Characters one cell may hold. The grid's editor caps typing at the same. */
const MAX_TEXT = 5000;
/** Ops in one batch: a paste of every row of a full table, one op per row, and room. */
const MAX_OPS = 20_000;
/** Undo steps kept — the dashboard editor's number (dashHistory.ts DASH_HIST_CAP). */
const HIST_CAP = 50;

export const MAX_CELL_TEXT = MAX_TEXT;
export const MAX_BATCH_OPS = MAX_OPS;
export const UNDO_CAP = HIST_CAP;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * A value as the grid stores it, or `undefined` when it cannot be stored.
 * `''` IS empty (null) — the app's one empty — so a cleared cell and a deleted
 * value are the same cell and undo round-trips them identically.
 */
export function cleanCell(v: unknown): Cell | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  if (v === '') return null;
  return v.length <= MAX_TEXT ? v : undefined;
}

function emptyRow(width: number): Cell[] {
  return new Array(width).fill(null);
}

/**
 * Apply one batch to `rows` (each `width` cells wide), refusing to grow past
 * `cap` rows. Returns the new rows and the batch that undoes it, or null when
 * any op is malformed or out of range — in which case nothing was applied.
 */
export function applyBatch(rows: Cell[][], batch: unknown, width: number, cap: number): Applied | null {
  const b = batch as Batch;
  if (!b || typeof b !== 'object' || !Array.isArray(b.ops) || b.ops.length === 0 || b.ops.length > MAX_OPS) return null;
  if (!Array.isArray(rows) || !isInt(width) || width < 1 || !isInt(cap)) return null;
  let out = rows.slice();
  const inverse: Op[] = [];
  for (const raw of b.ops) {
    const op = raw as Op;
    if (!op || typeof op !== 'object') return null;
    if (op.t === 'set') {
      const { r, c } = op;
      if (!isInt(r) || !isInt(c) || r < 0 || c < 0 || !Array.isArray(op.cells) || op.cells.length === 0) return null;
      if (r + op.cells.length > out.length) return null;
      const before: Cell[][] = [];
      const after: Cell[][] = [];
      for (let i = 0; i < op.cells.length; i++) {
        const src = op.cells[i];
        if (!Array.isArray(src) || src.length === 0 || c + src.length > width) return null;
        const clean: Cell[] = [];
        for (const v of src) {
          const cell = cleanCell(v);
          if (cell === undefined) return null;
          clean.push(cell);
        }
        const row = out[r + i].slice();
        before.push(row.slice(c, c + clean.length));
        for (let j = 0; j < clean.length; j++) row[c + j] = clean[j];
        out[r + i] = row;
        after.push(clean);
      }
      inverse.push({ t: 'set', r, c, cells: before });
    } else if (op.t === 'ins') {
      const { at } = op;
      if (!isInt(at) || at < 0 || at > out.length || !Array.isArray(op.rows) || op.rows.length === 0) return null;
      if (out.length + op.rows.length > cap) return null;
      const added: Cell[][] = [];
      for (const src of op.rows) {
        if (!Array.isArray(src) || src.length > width) return null;
        const row = emptyRow(width);
        for (let j = 0; j < src.length; j++) {
          const cell = cleanCell(src[j]);
          if (cell === undefined) return null;
          row[j] = cell;
        }
        added.push(row);
      }
      out = out.slice(0, at).concat(added, out.slice(at));
      inverse.push({ t: 'del', at, n: added.length });
    } else if (op.t === 'del') {
      const { at, n } = op;
      if (!isInt(at) || !isInt(n) || at < 0 || n < 1 || at + n > out.length) return null;
      const removed = out.slice(at, at + n);
      out = out.slice(0, at).concat(out.slice(at + n));
      inverse.push({ t: 'ins', at, rows: removed });
    } else {
      return null;
    }
  }
  inverse.reverse();
  return { rows: out, inverse: { label: labelOf(b), ops: inverse } };
}

function labelOf(b: Batch): string {
  return typeof b.label === 'string' && b.label ? b.label.slice(0, 120) : 'Edit';
}

// ── The undo stack ───────────────────────────────────────────────────────────
//
// The dashboard editor's semantics (dashHistory.ts): a new change abandons the
// redo branch, the cap drops the OLDEST step rather than refusing the newest,
// and each entry carries the label the buttons and the toast say. It keeps
// BATCHES rather than whole-table snapshots — a snapshot per step of a
// 10,000-row table is fifty copies of it, and a snapshot cannot be replayed in
// main as the edit it was.

export interface HistEntry {
  label: string;
  forward: Batch;
  inverse: Batch;
}

export interface History {
  past: HistEntry[];
  future: HistEntry[];
}

export function histNew(): History {
  return { past: [], future: [] };
}

export function histPush(h: History, e: HistEntry): void {
  h.past.push(e);
  if (h.past.length > HIST_CAP) h.past.shift();
  h.future.length = 0;
}

/** The step to undo (apply its `inverse`), or null. */
export function histUndo(h: History): HistEntry | null {
  const e = h.past.pop();
  if (!e) return null;
  h.future.push(e);
  return e;
}

/** The step to redo (apply its `forward`), or null. */
export function histRedo(h: History): HistEntry | null {
  const e = h.future.pop();
  if (!e) return null;
  h.past.push(e);
  return e;
}

export function histLabels(h: History | null): { undo: string | null; redo: string | null } {
  return {
    undo: h && h.past.length ? h.past[h.past.length - 1].label : null,
    redo: h && h.future.length ? h.future[h.future.length - 1].label : null,
  };
}

// ── Clipboard text ───────────────────────────────────────────────────────────

/**
 * Tab-separated text, the way Excel, Numbers and Google Sheets put a block on
 * the clipboard: tabs between cells, LF / CRLF / CR between rows, a single
 * trailing newline ignored. A cell that STARTS with `"` and closes with `"`
 * right before a tab, a newline or the end is quoted — it may hold tabs and
 * newlines, and `""` is one quote. Any other quote is a literal character
 * (`5" pipe` stays `5" pipe`), which is where a CSV parser would go wrong on
 * pasted prose. Rows keep their own length — a ragged row pastes fewer cells.
 */
export function parseTsv(text: string): string[][] {
  const s = typeof text === 'string' ? text : '';
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let atStart = true;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (atStart && ch === '"') {
      let j = i + 1;
      let val = '';
      let closed = false;
      while (j < n) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') { val += '"'; j += 2; continue; }
          closed = true;
          j += 1;
          break;
        }
        val += s[j];
        j += 1;
      }
      if (closed && (j >= n || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) {
        field = val;
        atStart = false;
        i = j;
        continue;
      }
      // Not a quoted cell after all: the quote is text, read on from it.
    }
    if (ch === '\t') {
      row.push(field);
      field = '';
      atStart = true;
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
      atStart = true;
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    atStart = false;
    i += 1;
  }
  if (!atStart || field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

/** A block as clipboard text — the inverse of parseTsv for anything it produced. */
export function toTsv(block: Cell[][]): string {
  return block
    .map((row) => row.map((v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join('\t'))
    .join('\n');
}

// ── Batches the grid builds ──────────────────────────────────────────────────

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : one + 's'}`;

function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  const x = a === undefined || a === null ? '' : String(a);
  const y = b === undefined || b === null ? '' : String(b);
  return x === y;
}

/**
 * Type into one cell. `r === rows.length` is the grid's trailing new-row line:
 * the batch appends a row and writes into it. Null when nothing would change.
 */
export function editBatch(rows: Cell[][], r: number, c: number, raw: string, column: string, cap: number): Batch | null {
  const v = cleanCell(typeof raw === 'string' ? raw.slice(0, MAX_TEXT) : raw);
  if (v === undefined) return null;
  const label = `Edit ${column || 'cell'}`;
  if (r === rows.length) {
    if (v === null || rows.length >= cap) return null;
    return { label, ops: [{ t: 'ins', at: r, rows: [[]] }, { t: 'set', r, c, cells: [[v]] }] };
  }
  if (r < 0 || r > rows.length || sameCell(rows[r][c], v)) return null;
  return { label, ops: [{ t: 'set', r, c, cells: [[v]] }] };
}

export interface PastePlan {
  batch: Batch;
  /** The rectangle the paste covers, for the grid to select. */
  range: Range;
  /** Cells that did not fit: columns past the last one, rows past the cap. */
  clipped: number;
}

/**
 * Paste clipboard text at the selection. A single value pasted onto a larger
 * selection fills it (as spreadsheets do); a block lands with its top-left at
 * the selection's, adding rows at the end as needed up to `cap`. Cells past the
 * last column or the cap are dropped and counted. Null for empty text.
 */
export function pasteBatch(text: string, sel: Range, rowCount: number, width: number, cap: number): PastePlan | null {
  const grid = parseTsv(text);
  if (!grid.length) return null;
  const r0 = Math.max(0, Math.min(sel.r0, sel.r1));
  const c0 = Math.max(0, Math.min(sel.c0, sel.c1));
  const cut = (s: string): string => s.slice(0, MAX_TEXT);

  if (grid.length === 1 && grid[0].length === 1 && (sel.r1 !== sel.r0 || sel.c1 !== sel.c0)) {
    const r1 = Math.min(Math.max(sel.r0, sel.r1), rowCount - 1);
    const c1 = Math.min(Math.max(sel.c0, sel.c1), width - 1);
    if (r1 < r0) return null;
    const v = cut(grid[0][0]);
    const cells: Cell[][] = [];
    for (let r = r0; r <= r1; r++) cells.push(new Array(c1 - c0 + 1).fill(v));
    const n = cells.length * (c1 - c0 + 1);
    return { batch: { label: `Paste into ${plural(n, 'cell')}`, ops: [{ t: 'set', r: r0, c: c0, cells }] }, range: { r0, c0, r1, c1 }, clipped: 0 };
  }

  let clipped = 0;
  const room = Math.max(0, cap - rowCount);
  const fit = Math.min(grid.length, Math.max(0, rowCount - r0) + room);
  for (let i = fit; i < grid.length; i++) clipped += grid[i].length;
  const ops: Op[] = [];
  const grow = Math.max(0, r0 + fit - rowCount);
  if (grow > 0) ops.push({ t: 'ins', at: rowCount, rows: Array.from({ length: grow }, () => []) });
  let n = 0;
  let wide = 0;
  for (let i = 0; i < fit; i++) {
    const src = grid[i];
    const keep = Math.max(0, Math.min(src.length, width - c0));
    clipped += src.length - keep;
    if (!keep) continue;
    ops.push({ t: 'set', r: r0 + i, c: c0, cells: [src.slice(0, keep).map(cut)] });
    n += keep;
    wide = Math.max(wide, keep);
  }
  if (!n) return null;
  return {
    batch: { label: `Paste ${plural(n, 'cell')}`, ops },
    range: { r0, c0, r1: r0 + fit - 1, c1: c0 + wide - 1 },
    clipped,
  };
}

/**
 * ⌘D: copy the selection's FIRST row down over the rest of it — a plain copy,
 * no series (1, 2 stays 1, 1), like Google Sheets. A one-row selection copies
 * the row above it down into it. Null when there is nothing to fill or every
 * target already holds the value.
 */
export function fillDownBatch(rows: Cell[][], sel: Range): Batch | null {
  let r0 = Math.min(sel.r0, sel.r1);
  const r1 = Math.min(Math.max(sel.r0, sel.r1), rows.length - 1);
  const c0 = Math.min(sel.c0, sel.c1);
  const c1 = Math.max(sel.c0, sel.c1);
  if (r0 === r1) r0 -= 1;
  if (r0 < 0 || r1 <= r0 || r1 >= rows.length) return null;
  const src = rows[r0].slice(c0, c1 + 1);
  const cells: Cell[][] = [];
  let changed = 0;
  for (let r = r0 + 1; r <= r1; r++) {
    cells.push(src.slice());
    for (let j = 0; j < src.length; j++) if (!sameCell(rows[r][c0 + j], src[j])) changed++;
  }
  if (!changed) return null;
  return { label: `Fill down ${plural(cells.length * src.length, 'cell')}`, ops: [{ t: 'set', r: r0 + 1, c: c0, cells }] };
}

/** Delete / Backspace over a selection. Null when it is already empty. */
export function clearBatch(rows: Cell[][], sel: Range): Batch | null {
  const r0 = Math.min(sel.r0, sel.r1);
  const r1 = Math.min(Math.max(sel.r0, sel.r1), rows.length - 1);
  const c0 = Math.min(sel.c0, sel.c1);
  const c1 = Math.max(sel.c0, sel.c1);
  if (r1 < r0) return null;
  let filled = 0;
  const cells: Cell[][] = [];
  for (let r = r0; r <= r1; r++) {
    cells.push(new Array(c1 - c0 + 1).fill(null));
    for (let c = c0; c <= c1; c++) if (!sameCell(rows[r][c], null)) filled++;
  }
  if (!filled) return null;
  return { label: `Clear ${plural(filled, 'cell')}`, ops: [{ t: 'set', r: r0, c: c0, cells }] };
}

/** "+ Row": `n` empty rows before `at`. Null at the cap. */
export function insertRowsBatch(at: number, n: number, rowCount: number, cap: number): Batch | null {
  const k = Math.min(n, cap - rowCount);
  if (k < 1 || at < 0 || at > rowCount) return null;
  return { label: k === 1 ? 'Add row' : `Add ${k} rows`, ops: [{ t: 'ins', at, rows: Array.from({ length: k }, () => []) }] };
}

/** Delete rows r0..r1 (inclusive). */
export function deleteRowsBatch(r0: number, r1: number, rowCount: number): Batch | null {
  const a = Math.max(0, Math.min(r0, r1));
  const b = Math.min(rowCount - 1, Math.max(r0, r1));
  if (b < a) return null;
  return { label: `Delete ${plural(b - a + 1, 'row')}`, ops: [{ t: 'del', at: a, n: b - a + 1 }] };
}
