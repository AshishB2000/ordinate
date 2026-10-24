// Parsed-but-unsaved tables, held in MAIN between the parse and the save.
//
// The import used to send the WHOLE parsed file to the renderer (a 1M-row
// structured clone, seconds long) only for the composer to send it straight
// back on Save. Now the parse (a job, in a compute worker) lands here; the
// renderer gets a display slice and a `stagedId`, and the composer's preview
// and save resolve that id in main. One copy of the rows, never crossing IPC.
//
// Bounded: at most MAX_STAGED tables PER OWNER (their oldest goes first) and
// each for at most TTL_MS — an abandoned import must not pin a million rows
// forever. A save takes its table out.
//
// OWNED: a staged table belongs to the org + user who parsed it (ctx(); the
// desktop is one fixed owner). On the server a stagedId is only a random UUID,
// so without this anyone who learned one could save — or drop — another org's
// upload. `get` / `drop` by anyone else behave exactly as for an unknown id.
//
// ANY POD: with DATABASE_URL a stage is a row plus a Parquet file in the org's
// staging area (./stageStore.ts), so the parse, the preview and the save can
// each land on a different pod. The Map below is the store without a database.

import { randomUUID } from 'crypto';
import { ctx, serverDataDir } from '../server/context';
import * as stageStore from './stageStore';
import type { ParseResult } from './parse';

// ponytail: per owner, so a server holds at most users × MAX_STAGED tables; add a global byte budget if that bites.
export const MAX_STAGED = stageStore.MAX_STAGED;
export const TTL_MS = stageStore.TTL_MS;
/** Rows the renderer gets to paint — the composer draws 100 per page. */
export const PREVIEW_ROWS = 2000;
/** What a save says when the staged table it names is gone (or was never the caller's). */
export const GONE = 'This import is no longer available — bring the file in again.';

interface Staged {
  table: ParseResult;
  at: number;
  owner: string;
}

const staged = new Map<string, Staged>();
let now = (): number => Date.now();

/** Who is asking: org + user on the server, the one desktop user otherwise. */
function ownerNow(): string {
  const c = ctx();
  return c.org.id + '\u0000' + c.user.email;
}

function sweep(): void {
  const t = now();
  for (const [id, s] of staged) if (t - s.at > TTL_MS) staged.delete(id);
  // Insertion order is age order: walking newest-first keeps each owner's newest MAX_STAGED.
  const kept = new Map<string, number>();
  for (const [id, s] of [...staged].reverse()) {
    const n = (kept.get(s.owner) ?? 0) + 1;
    kept.set(s.owner, n);
    if (n > MAX_STAGED) staged.delete(id);
  }
}

const shared = (): boolean => stageStore.dbOn() && serverDataDir() !== null;

/** Hold a parsed table for the caller; returns the id the renderer refers to it by. */
export async function put(table: ParseResult): Promise<string> {
  if (shared()) return stageStore.put(table);
  const id = randomUUID();
  staged.set(id, { table, at: now(), owner: ownerNow() });
  sweep();
  return id;
}

/**
 * The caller's own staged table, or null (unknown, expired, already saved — or someone else's).
 * With `limit`, only its first `limit` rows; `rowCount` is still the whole table's.
 */
export async function get(id: unknown, limit?: number | null): Promise<ParseResult | null> {
  if (shared()) return stageStore.get(id, limit ?? undefined);
  sweep();
  if (typeof id !== 'string') return null;
  const s = staged.get(id);
  const t = s && s.owner === ownerNow() ? s.table : null;
  return t && typeof limit === 'number' ? { ...t, rows: t.rows.slice(0, limit) } : t;
}

export async function drop(id: unknown): Promise<void> {
  if (shared()) return stageStore.drop(id);
  if (typeof id === 'string' && staged.get(id)?.owner === ownerNow()) staged.delete(id);
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
