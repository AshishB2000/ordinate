// Cross-dataset combination: append, inner/left join, and the compose chain the
// dataset composer folds. MAIN PROCESS, PURE logic — no I/O, invoked ONLY by the
// IPC layer and by datasetRefresh.
//
// This is deliberately NOT part of applyPipeline. A prepare pipeline transforms
// ONE table and is the single source of truth for that; combining is a different
// job with a different failure mode (a cartesian blow-up, not a bad step), and
// keeping the two apart is what stops either growing into the other. transforms.ts
// carried this section until it pushed that file past the 800-line cap
// (.claude/rules/file-size.md), which is the same argument in numbers.
//
// Depends on transforms.ts for the shared table helpers; transforms.ts does NOT
// depend on this, so there is no import cycle.

import type { ParsedColumn } from './parse';
import type { ApplyResult, Cell, TableData } from './transforms';
import { cellToString, colIndex, retypeColumn } from './transforms';

// ── combineTables: cross-dataset (pure; invoked ONLY by the IPC layer) ─────────
//
// NEVER called inside applyPipeline — that keeps the pipeline core single-source.
// `append` unions columns by name and stacks rows (missing → null). `inner` and
// `left` join on the `on` pair, concatenating right's non-key columns; they differ
// only in what happens to a left row with no match (dropped, or kept and padded
// with null). All three re-detect column types over the combined cells (the
// strict-number path).

/** The three shapes the engine actually runs. Nothing else may be drawn on the canvas. */
export type CombineMode = 'append' | 'inner' | 'left';

/**
 * What a CALLER may send. `'join'` is the historical spelling of `'inner'` and is
 * accepted forever: it is written into every `origin: 'combined'` record already on
 * disk, so dropping it would silently break refresh for existing combined datasets.
 */
export type CombineModeInput = CombineMode | 'join';

/** `'join'` → `'inner'`; anything unrecognised → null (the caller reports it). */
export function normalizeCombineMode(mode: unknown): CombineMode | null {
  if (mode === 'append' || mode === 'inner' || mode === 'left') return mode;
  if (mode === 'join') return 'inner';
  return null;
}

export function combineTables(
  left: TableData,
  right: TableData,
  mode: CombineModeInput,
  on?: { left: string; right: string },
  limit = 50_000,
): ApplyResult {
  const m = normalizeCombineMode(mode);
  if (m === null) return { columns: [], rows: [], rowCount: 0, warnings: [`Unknown combine mode "${mode}"`] };
  if (m === 'append') return appendTables(left, right);
  return joinTables(left, right, on, limit, m === 'left');
}

/** One step of a compose chain: join THIS table onto whatever has been built so far. */
export interface ComposeJoin {
  table: TableData;
  mode: CombineModeInput;
  on?: { left: string; right: string };
}

/**
 * A left-to-right fold of `combineTables` over `base` and each join in turn — the
 * whole data model behind the composer canvas, which is why that canvas is a CHAIN
 * and not free 2-D placement: there is no graph here to draw.
 *
 * Pure, no I/O. `limit` applies at EVERY step, not just the last, so an early
 * many-to-many blow-up is bounded before it can feed the next one.
 */
export function composeTables(base: TableData, joins: ComposeJoin[], limit = 50_000): ApplyResult {
  const warnings: string[] = [];
  let acc: TableData = {
    columns: base.columns.map((c) => ({ ...c })),
    rows: base.rows.map((r) => r.slice()),
  };
  for (const j of Array.isArray(joins) ? joins : []) {
    const res = combineTables(acc, j.table, j.mode, j.on, limit);
    warnings.push(...res.warnings);
    acc = { columns: res.columns, rows: res.rows };
  }
  return { columns: acc.columns, rows: acc.rows, rowCount: acc.rows.length, warnings };
}

function appendTables(left: TableData, right: TableData): ApplyResult {
  const warnings: string[] = [];

  // Union of column names, left order first then right's new names.
  const names: string[] = left.columns.map((c) => c.name);
  const seen = new Set(names);
  for (const c of right.columns) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      names.push(c.name);
    }
  }

  const leftIdx = new Map(left.columns.map((c, i) => [c.name, i]));
  const rightIdx = new Map(right.columns.map((c, i) => [c.name, i]));

  const rows: Cell[][] = [];
  for (const r of left.rows) {
    rows.push(names.map((n) => (leftIdx.has(n) ? r[leftIdx.get(n) as number] ?? null : null)));
  }
  for (const r of right.rows) {
    rows.push(names.map((n) => (rightIdx.has(n) ? r[rightIdx.get(n) as number] ?? null : null)));
  }

  const columns: ParsedColumn[] = names.map((name) => ({ name, type: 'text' }));
  for (let c = 0; c < columns.length; c += 1) retypeColumn(columns, rows, c);

  return { columns, rows, rowCount: rows.length, warnings };
}

function joinTables(
  left: TableData,
  right: TableData,
  on?: { left: string; right: string },
  limit = 50_000,
  keepUnmatched = false,
): ApplyResult {
  const warnings: string[] = [];
  if (!on || typeof on.left !== 'string' || typeof on.right !== 'string') {
    return { columns: left.columns.map((c) => ({ ...c })), rows: left.rows.map((r) => r.slice()), rowCount: left.rows.length, warnings: ['Join skipped: missing "on" key pair'] };
  }
  const li = colIndex(left.columns, on.left);
  const ri = colIndex(right.columns, on.right);
  if (li < 0 || ri < 0) {
    return { columns: left.columns.map((c) => ({ ...c })), rows: left.rows.map((r) => r.slice()), rowCount: left.rows.length, warnings: [`Join skipped: unknown key column(s) "${on.left}"/"${on.right}"`] };
  }

  // Output columns: all left columns, then right's non-key columns (rename
  // collisions with a "_right" suffix so no two columns share a name).
  const usedNames = new Set(left.columns.map((c) => c.name));
  const rightOutCols: { srcIdx: number; name: string }[] = [];
  right.columns.forEach((c, i) => {
    if (i === ri) return; // drop the join key from the right side
    let name = c.name;
    if (usedNames.has(name)) name = `${name}_right`;
    usedNames.add(name);
    rightOutCols.push({ srcIdx: i, name });
  });

  // Index right rows by the stringified key value.
  const rightByKey = new Map<string, Cell[][]>();
  for (const r of right.rows) {
    const key = cellToString(r[ri]);
    const bucket = rightByKey.get(key);
    if (bucket) bucket.push(r);
    else rightByKey.set(key, [r]);
  }

  // Bound the OUTPUT at `limit` while building. A many-to-many join on a low-
  // cardinality/duplicate key is the full cartesian product (50k × 50k = 2.5B rows),
  // which would OOM the main process BEFORE any post-hoc slice ran. Stop pushing at
  // the cap (the IPC already intends to slice there) so retypeColumn walks ≤ limit rows.
  const rows: Cell[][] = [];
  let capped = false;
  outer: for (const lr of left.rows) {
    const key = cellToString(lr[li]);
    const matches = rightByKey.get(key);
    if (!matches) {
      // inner drops an unmatched left row; left keeps it, padded with nulls for
      // every right column. The cap applies to a padded row like any other.
      if (!keepUnmatched) continue;
      if (rows.length >= limit) { capped = true; break outer; }
      rows.push(lr.slice().concat(rightOutCols.map(() => null)));
      continue;
    }
    for (const rr of matches) {
      if (rows.length >= limit) { capped = true; break outer; }
      rows.push(lr.slice().concat(rightOutCols.map((rc) => rr[rc.srcIdx] ?? null)));
    }
  }
  if (capped) warnings.push(`Join row cap reached — kept first ${limit} matched rows`);

  const columns: ParsedColumn[] = left.columns.map((c) => ({ ...c }));
  for (const rc of rightOutCols) columns.push({ name: rc.name, type: 'text' });
  for (let c = 0; c < columns.length; c += 1) retypeColumn(columns, rows, c);

  return { columns, rows, rowCount: rows.length, warnings };
}
