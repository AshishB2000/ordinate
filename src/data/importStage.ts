// Parsed-but-unsaved tables, held in MAIN between the parse and the save.
//
// The import used to send the WHOLE parsed file to the renderer (a 1M-row
// structured clone, seconds long) only for the composer to send it straight
// back on Save. Now the parse (a job, in a compute worker) lands here; the
// renderer gets a display slice and a `stagedId`, and the composer's preview
// and save resolve that id in main. One copy of the rows, never crossing IPC.
//
// Bounded: at most MAX_STAGED tables (the oldest goes first) and each for at
// most TTL_MS — an abandoned import must not pin a million rows forever. A
// save takes its table out.

import { randomUUID } from 'crypto';
import type { ParseResult } from './parse';

export const MAX_STAGED = 2;
export const TTL_MS = 30 * 60 * 1000;
/** Rows the renderer gets to paint — the composer draws 100 per page. */
export const PREVIEW_ROWS = 2000;

interface Staged {
  table: ParseResult;
  at: number;
}

const staged = new Map<string, Staged>();
let now = (): number => Date.now();

function sweep(): void {
  const t = now();
  for (const [id, s] of staged) if (t - s.at > TTL_MS) staged.delete(id);
  while (staged.size > MAX_STAGED) {
    const oldest = staged.keys().next();
    if (oldest.done) break;
    staged.delete(oldest.value);
  }
}

/** Hold a parsed table; returns the id the renderer refers to it by. */
export function put(table: ParseResult): string {
  const id = randomUUID();
  staged.set(id, { table, at: now() });
  sweep();
  return id;
}

/** The staged table, or null (unknown, expired, or already saved). */
export function get(id: unknown): ParseResult | null {
  sweep();
  if (typeof id !== 'string') return null;
  const s = staged.get(id);
  return s ? s.table : null;
}

export function drop(id: unknown): void {
  if (typeof id === 'string') staged.delete(id);
}

/** What the renderer receives: the parse minus most rows, plus the handle. */
export function previewOf(table: ParseResult, stagedId: string): ParseResult & { stagedId: string; staged: true } {
  return { ...table, rows: table.rows.slice(0, PREVIEW_ROWS), stagedId, staged: true };
}

/** Test hooks. */
export function resetForTest(clock?: () => number): void {
  staged.clear();
  now = clock || (() => Date.now());
}
export function sizeForTest(): number {
  return staged.size;
}
