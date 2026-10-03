// The composer's state and its pure rules (legacy composer.ts / composerGrid.ts).
//
// The canvas is a horizontal CHAIN — the engine (combine.composeTables) is a
// left-to-right fold — and the browser never computes a joined row: every
// preview, row count and warning comes from dataset:composePreview. What
// lives here is only bookkeeping: which tables are on the chain, how they
// join, and the field mapping (rename / retype / drop), which saves as
// ordinary prepare steps.

import type { Cell, ColType, JoinRef, TableRef } from './api';
import type { GridColumn } from '../../ui/DataGrid/DataGrid';

export type Mode = 'inner' | 'left' | 'append';

/** One table on the canvas. `ref` is what the server takes: a saved id or the import itself. */
export interface ChainTable {
  label: string;
  rows: number;
  kind: string;
  ref: TableRef;
  columns: string[];
}

export interface Link {
  table: ChainTable;
  mode: Mode;
  on?: { left: string; right: string };
}

/** A column's mapping, keyed by its ORIGINAL name. */
export interface ColMap {
  name: string;
  type: ColType;
  dropped: boolean;
}

export const MODES: readonly { id: Mode; label: string; hint: string }[] = [
  { id: 'inner', label: 'Inner', hint: 'Only rows that match on both sides' },
  { id: 'left', label: 'Left', hint: 'Every row on the left; blanks where nothing matches' },
  { id: 'append', label: 'Append', hint: 'Stack the rows; columns line up by name' },
];

/** The mapping for a column, defaulted from what the server returned. */
export function mapFor(map: Readonly<Record<string, ColMap>>, col: GridColumn): ColMap {
  return map[col.name] ?? { name: col.name, type: col.type, dropped: false };
}

/**
 * Best guess for a join key: an exact column-name match, then a
 * case-insensitive one. No match stays empty — a wrong guessed key is worse
 * than an obvious blank (the badge goes amber).
 */
export function guessKeys(left: readonly string[], right: readonly string[]): { left: string; right: string } | undefined {
  for (const l of left) if (right.includes(l)) return { left: l, right: l };
  const lower = right.map((c) => c.toLowerCase());
  for (const l of left) {
    const i = lower.indexOf(l.toLowerCase());
    if (i >= 0) return { left: l, right: right[i] };
  }
  return undefined;
}

/**
 * The columns available on the LEFT of link `i`. The preview's own columns
 * are the honest answer for the last link; for an earlier one, the union of
 * the base and each preceding table (a superset).
 */
export function columnsBefore(base: ChainTable | null, links: readonly Link[], i: number, previewCols: readonly GridColumn[]): string[] {
  if (i === 0) return base ? base.columns.slice() : [];
  if (i === links.length - 1 && previewCols.length) return previewCols.map((c) => c.name);
  const names = base ? base.columns.slice() : [];
  for (let k = 0; k < i; k++) for (const c of links[k].table.columns) if (!names.includes(c)) names.push(c);
  return names;
}

/** A link with no key on a join (append needs none): the badge warns, the save refuses. */
export const missingKey = (l: Link): boolean => l.mode !== 'append' && !l.on;

export function joinsOf(links: readonly Link[]): JoinRef[] {
  return links.map((l) => {
    const id = 'datasetId' in l.table.ref ? l.table.ref.datasetId : '';
    return { datasetId: id, mode: l.mode, ...(l.on ? { on: l.on } : {}) };
  });
}

/**
 * The mapping as REAL prepare steps, so the saved dataset opens with its
 * pipeline visible and every mapping reversible. Renames first; a dropped
 * column is dropped by its original name (a dropped column is never renamed).
 */
export function mappingSteps(cols: readonly GridColumn[], map: Readonly<Record<string, ColMap>>): { type: string; [k: string]: unknown }[] {
  const steps: { type: string; [k: string]: unknown }[] = [];
  for (const c of cols) {
    const m = mapFor(map, c);
    if (!m.dropped && m.name && m.name !== c.name) steps.push({ type: 'rename_column', from: c.name, to: m.name });
  }
  for (const c of cols) if (mapFor(map, c).dropped) steps.push({ type: 'drop_column', column: c.name });
  return steps;
}

/** The kept columns as saved (mapped name + type) — sent only when a type changed. */
export function retypeOf(cols: readonly GridColumn[], map: Readonly<Record<string, ColMap>>): { name: string; type: ColType }[] | undefined {
  const changed = cols.some((c) => !mapFor(map, c).dropped && mapFor(map, c).type !== c.type);
  if (!changed) return undefined;
  return cols.filter((c) => !mapFor(map, c).dropped).map((c) => ({ name: mapFor(map, c).name, type: mapFor(map, c).type }));
}

/** Indexes of the columns still shown (not dropped), in order. */
export function keptIndexes(cols: readonly GridColumn[], map: Readonly<Record<string, ColMap>>): number[] {
  return cols.flatMap((c, i) => (mapFor(map, c).dropped ? [] : [i]));
}

/**
 * Writes one corrected cell into an inline base's rows (a capture's — the
 * only editable source) and returns the new ref; null when the ref has no
 * rows to edit. The value is what was typed: the server types it on save.
 */
export function withCell(ref: TableRef, row: number, col: number, value: string): TableRef | null {
  if (!('inline' in ref) || !ref.inline.rows || !ref.inline.rows[row]) return null;
  const rows = ref.inline.rows.slice();
  const next: Cell[] = rows[row].slice();
  next[col] = value;
  rows[row] = next;
  return { inline: { ...ref.inline, rows } };
}
