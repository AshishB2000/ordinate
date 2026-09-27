// Data snapshots — the names on disk, retention and the as-of rule. PURE: no fs
// and no electron, so trashStore (which may import no record store) and the
// tests can both use it.
//
//   <id>.<stamp>.parquet          the derived table as it was
//   <id>.<stamp>.source.parquet   its prepare source, when it had a pipeline
//   <id>.snapshots.json           the index: retention + each snapshot's columns
//
// <stamp> is when the kept data was FETCHED (the record's lastRefreshedAt, else
// its updatedAt), i.e. the time that data became current — "valid from", which
// is exactly what the as-of rule below needs. ':' and '.' become '-' (Windows
// refuses ':'), the shape of a version key and a backup name, so the stamps sort
// in time order as plain strings.
//
// A directory listing is matched STRICTLY: only `^<uuid>\.<stamp>\.parquet$`
// (and its `.source.parquet` companion) is ever a snapshot, and the stamp must
// round-trip through Date exactly. A stray file, a temp, another dataset's
// snapshot or a hostile name is never listed, moved or deleted by this feature.

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_KEEP = 10;
export const MAX_KEEP = 100;

/** An ISO time → its file stamp, or null when it is not a time. */
export function stampOf(iso: unknown): string | null {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = new Date(t).toISOString().replace(/:/g, '-').replace('.', '-');
  return STAMP_RE.test(s) ? s : null;
}

/** A stamp back to its ISO time, or null. Strict: it must round-trip exactly, so
 *  `2026-02-30…` or `…T24-…` is refused rather than rolled over. */
export function parseStamp(stamp: unknown): string | null {
  if (typeof stamp !== 'string') return null;
  const m = STAMP_RE.exec(stamp);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) && new Date(t).toISOString() === iso ? iso : null;
}

export function snapshotName(id: string, stamp: string): string {
  return `${id}.${stamp}.parquet`;
}

export function sourceName(id: string, stamp: string): string {
  return `${id}.${stamp}.source.parquet`;
}

export function indexName(id: string): string {
  return `${id}.snapshots.json`;
}

/** What `name` is to dataset `id`: one of its snapshots (or a snapshot's source
 *  companion), or null. */
export function matchName(id: string, name: string): { stamp: string; source: boolean } | null {
  if (!UUID_RE.test(id) || typeof name !== 'string' || !name.startsWith(id + '.')) return null;
  const m = /^([0-9TZ-]+)\.(source\.)?parquet$/.exec(name.slice(id.length + 1));
  if (!m || !parseStamp(m[1])) return null;
  return { stamp: m[1], source: Boolean(m[2]) };
}

/** Every file of `id`'s snapshots among `names` — what travels with it to the trash. */
export function snapshotFiles(id: string, names: string[]): string[] {
  return names.filter((n) => (UUID_RE.test(id) && n === indexName(id)) || matchName(id, n) !== null);
}

/** The retention setting: a whole number in 0..MAX_KEEP; anything else is the default. */
export function sanitizeKeep(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_KEEP;
  return Math.min(MAX_KEEP, Math.max(0, Math.floor(v)));
}

/** The stamps to delete so only the newest `keep` remain — oldest go first. */
export function planPrune(stamps: string[], keep: number): string[] {
  const valid = [...new Set(stamps.filter((s) => parseStamp(s) !== null))].sort().reverse();
  return valid.slice(Math.max(0, Math.floor(keep)));
}

/**
 * Whether a dataset keeps snapshots on refresh: it has a refresh SCHEDULE, or
 * it reads a live CONNECTION. A one-off import re-read by hand is not a series
 * of observations, and keeping copies of it nobody asked for is disk for nothing.
 */
export function isEligible(rec: { origin?: { kind?: string } | null; autoRefresh?: unknown } | null | undefined): boolean {
  return Boolean(rec && (rec.autoRefresh || (rec.origin && rec.origin.kind === 'connection')));
}

export type AsOfPick = { kind: 'current' } | { kind: 'snapshot'; stamp: string } | { kind: 'none' };

/**
 * Which version of ONE dataset was current at `at` (ms since epoch).
 *
 * Every version is valid FROM its stamp until the next one begins. The newest
 * version valid at or before `at` wins, and the current data wins a tie (a tie
 * is the same fetch). Before the first version there was no data: 'none', which
 * the caller must show as "No data as of <time>" — never quietly the latest,
 * which would be a figure from the wrong time presented as the right one.
 *
 * A current record whose own time cannot be read is taken as current: with no
 * time to compare, the latest data is the only honest answer.
 */
export function pickAsOf(stamps: string[], currentFrom: number, at: number): AsOfPick {
  if (!Number.isFinite(at) || !Number.isFinite(currentFrom) || currentFrom <= at) return { kind: 'current' };
  let best: string | null = null;
  let bestT = -Infinity;
  for (const s of stamps) {
    const iso = parseStamp(s);
    if (!iso) continue;
    const t = Date.parse(iso);
    if (t <= at && t > bestT) {
      best = s;
      bestT = t;
    }
  }
  return best ? { kind: 'snapshot', stamp: best } : { kind: 'none' };
}
