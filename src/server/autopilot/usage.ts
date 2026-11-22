// What Autopilot watches (0044_autopilot_usage.sql, docs/autopilot/00-design.md): per chart and per dashboard, per UTC day,
// whether it was OPENED and how long the server took to COMPUTE it. Per item only, never who.
//
// NEVER ON THE REQUEST PATH. A hook here is a synchronous Map update (`note`): no await, no query, no throw. A timer on every
// pod writes the batch (`flushUsage`), as one INSERT per org, and a failed write puts the batch back for the next tick. So an
// open never waits on Postgres, and the browser makes no request for it: the server records what it already serves.
//
// WITHOUT A DATABASE (desktop, dev file mode) every call is a no-op, as `readersOf` (../dashboardReads.ts) is: Autopilot is a
// server feature and reads these rows from Postgres. The buffer holds only a write-behind batch, nothing a later request
// needs, so any pod serves any request; a pod that dies loses at most FLUSH_MS of counts (a missed open only delays a cleanup).
//
// WHAT IS AN OPEN (counted when unsure: a spurious open delays a cleanup, a missed one could trash a chart somebody uses):
//   visual    `visual:get` (the chart page), and every `visual:data` that names the saved visual (a dashboard tile, a Story, a
//             scheduled report, a Slack answer): `visualId` is how the tile says which chart it draws.
//   dashboard `analysis:open` (an editor's and a viewer's, the draft and the published copy), a published page `/p/<id>/<page>`,
//             and an embed. An API token calls the same channels, so an MCP-style client counts the same way.
//   NOT       lists, thumbs, the gallery, and a publish or bundle build (those compute, they are not opened).

import { performance } from 'node:perf_hooks';
import { isValidId } from '../../app/ids';
import { logger } from '../../app/logger';
import { ctx } from '../context';
import { inOrg, orgDb } from '../db/inOrg';

export type Kind = 'visual' | 'dashboard';

interface Entry {
  org: string;
  projectId: string;
  kind: Kind;
  id: string;
  day: string;
  opened: boolean;
  computes: number;
  totalMs: number;
  maxMs: number;
}

/** How long a batch waits before it is written. A pod that dies loses this much. */
export const FLUSH_MS = 10_000;
/** The most distinct (item, day) rows a pod holds between writes; past it a new one is dropped (a flood of junk ids cannot grow memory). */
export const MAX_ENTRIES = 5_000;

let buf = new Map<string, Entry>();
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
let clock: () => number = Date.now;
let warned = false;

/** Test hook: a fake clock for the UTC day (null restores Date.now). */
export function setClockForTest(fn: (() => number) | null): void {
  clock = fn ?? Date.now;
}

/** Test hook: drop the buffer and stop the timer. */
export function resetForTest(): void {
  buf = new Map();
  if (timer) clearInterval(timer);
  timer = null;
  flushing = null;
  failedAt = 0;
  warned = false;
}

/** Rows waiting to be written (the tests). */
export const pending = (): number => buf.size;

const utcDay = (): string => new Date(clock()).toISOString().slice(0, 10);

/** After a failed write no new write is kicked off by a full buffer for this long. */
const RETRY_MS = 5_000;
let failedAt = 0;

function add(e: Entry): void {
  const key = `${e.org}\u0000${e.projectId}\u0000${e.kind}\u0000${e.id}\u0000${e.day}`;
  const have = buf.get(key);
  if (have) {
    have.opened ||= e.opened;
    have.computes += e.computes;
    have.totalMs += e.totalMs;
    have.maxMs = Math.max(have.maxMs, e.maxMs);
    return;
  }
  if (buf.size >= MAX_ENTRIES) {
    // Full (a flood of made-up ids, or the database is down). Write what is waiting: the flush drops ids that are not records, so a
    // flood empties out. While a write is running or just failed, an open still wins a place over a compute-only row.
    if (!flushing && Date.now() - failedAt > RETRY_MS) void flushUsage();
    if (buf.size >= MAX_ENTRIES) {
      if (!e.opened) return;
      const victim = [...buf].find(([, v]) => !v.opened);
      if (!victim) return;
      buf.delete(victim[0]);
    }
  }
  buf.set(key, e);
}

function arm(): void {
  if (timer) return;
  timer = setInterval(() => void flushUsage(), FLUSH_MS);
  timer.unref(); // never keeps a process (a self-check suite) alive
}

/**
 * Remember one event. Synchronous and total: a bad id, no database, or a missing request context is a no-op, never a throw.
 * `org` is the caller's unless the caller is outside a request (a published page, an embed), which passes it.
 */
function note(kind: Kind, projectId: unknown, id: unknown, o: { opened: boolean; ms?: number; org?: string }): void {
  try {
    if (!orgDb() || !isValidId(projectId) || !isValidId(id)) return;
    const ms = o.ms === undefined ? undefined : Math.max(0, Math.round(o.ms));
    add({
      org: o.org ?? ctx().org.id, projectId: projectId.toLowerCase(), kind, id: id.toLowerCase(), day: utcDay(),
      opened: o.opened, computes: ms === undefined ? 0 : 1, totalMs: ms ?? 0, maxMs: ms ?? 0,
    });
    arm();
  } catch {
    // recording must never fail what it records
  }
}

/** `kind` `id` was opened. */
export const noteOpen = (kind: Kind, projectId: unknown, id: unknown, org?: string): void => note(kind, projectId, id, { opened: true, ...(org ? { org } : {}) });

/** `kind` `id` took `ms` to compute. `opened: false` for a build that nobody opened (a publish). */
export const noteCompute = (kind: Kind, projectId: unknown, id: unknown, ms: number, o: { opened?: boolean; org?: string } = {}): void =>
  note(kind, projectId, id, { opened: o.opened ?? true, ms, ...(o.org ? { org: o.org } : {}) });

/** `reply` as it is, and a visual open recorded when it is not null (a refused or missing chart answers null: nothing to record). */
export function opened<T>(kind: Kind, projectId: unknown, id: unknown, reply: T): T {
  if (reply) noteOpen(kind, projectId, id);
  return reply;
}

/**
 * A published page `file` of `site` was served in `org`: the dashboard it shows was opened. A site published before pages named
 * their dashboard counts every dashboard of the link (an over-count, the safe side). The list page, a story and a scorecard are not opens.
 */
export function noteSiteOpen(site: { projectId: string; pages: ReadonlyArray<{ file: string; kind: string; id?: string }>; config: { dashboardIds: readonly string[] } }, file: string, org: string): void {
  const page = site.pages.find((p) => p.file === file);
  if (!page || page.kind !== 'dashboard') return;
  for (const id of page.id ? [page.id] : site.config.dashboardIds) noteOpen('dashboard', site.projectId, id, org);
}

/** A handler that records an open of `{ projectId, id }` when it answers `{ ok: true }` (`analysis:open`: a refusal records nothing). */
export function openWhenOk(kind: Kind, handler: (e: unknown, args: any) => Promise<unknown>) { // any: the channel's own untrusted input
  return async (e: unknown, args?: { projectId?: unknown; id?: unknown }): Promise<unknown> => {
    const reply = await handler(e, args);
    if ((reply as { ok?: unknown } | null)?.ok === true) noteOpen(kind, args?.projectId, args?.id);
    return reply;
  };
}

/** The chart door's handler, timed. A request that names its saved visual (`visualId`) is a compute (and, but for a build, an open) of it. */
export function timedViz<R>(fn: (args: any) => Promise<R>) { // any: the chart door's own untrusted request
  return async (args: any): Promise<R> => {
    const t0 = performance.now();
    const reply = await fn(args);
    const share = args?.share;
    if (args?.visualId) noteCompute('visual', args.projectId, args.visualId, performance.now() - t0, { opened: share !== 'publish' && share !== 'bundle' });
    return reply;
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

// One statement per org. An item that is not (or no longer) a record of the project is left out, so an id a client made up
// never becomes a row. `opened` and the compute figures merge exactly: or, sum, max.
const UPSERT = `
  INSERT INTO item_usage_daily AS u (org_id, project_id, kind, item_id, day, opened, computes, total_ms, max_ms)
  SELECT $1, t.p::uuid, t.k, t.i::uuid, t.d::date, t.o, t.n, t.s, t.m
    FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::int[], $8::bigint[], $9::int[]) AS t(p, k, i, d, o, n, s, m)
   WHERE EXISTS (SELECT 1 FROM records r WHERE r.org_id = $1
                   AND r.path = 'projects/' || t.p || '/' || CASE t.k WHEN 'visual' THEN 'visuals' ELSE 'analyses' END || '/' || t.i || '.json')
  ON CONFLICT (org_id, project_id, kind, item_id, day) DO UPDATE
    SET opened = u.opened OR excluded.opened, computes = u.computes + excluded.computes,
        total_ms = u.total_ms + excluded.total_ms, max_ms = GREATEST(u.max_ms, excluded.max_ms)`;

async function writeOrg(org: string, rows: Entry[]): Promise<void> {
  await inOrg((c) => c.query(UPSERT, [
    org, rows.map((r) => r.projectId), rows.map((r) => r.kind), rows.map((r) => r.id), rows.map((r) => r.day),
    rows.map((r) => r.opened), rows.map((r) => r.computes), rows.map((r) => r.totalMs), rows.map((r) => r.maxMs),
  ]), org);
}

/** Write what is waiting. A failed org's rows go back for the next tick; resolves when every org is done. */
export function flushUsage(): Promise<void> {
  if (flushing) return flushing; // one write at a time; the next tick takes what arrived meanwhile
  const batch = buf;
  buf = new Map();
  if (!batch.size) return Promise.resolve();
  const byOrg = new Map<string, Entry[]>();
  for (const e of batch.values()) (byOrg.get(e.org) ?? byOrg.set(e.org, []).get(e.org) as Entry[]).push(e);
  flushing = (async () => {
    for (const [org, rows] of byOrg) {
      try {
        if (!orgDb()) continue; // un-wired meanwhile (a test, a shutdown): nothing to write to
        await writeOrg(org, rows);
      } catch (err) {
        failedAt = Date.now();
        for (const r of [...rows].sort((a, b) => Number(b.opened) - Number(a.opened))) add(r); // opens first: they are what a cleanup cannot do without
        if (!warned) {
          warned = true;
          logger.warn(`[autopilot] usage could not be written (${String((err as { code?: unknown })?.code ?? 'error')}); it is retried on the next tick. Further failures are not logged.`);
        }
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

/** Shutdown: stop the timer and write the last batch (before the pool ends). */
export async function stopUsage(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (flushing) await flushing; // a write already running holds an older batch: wait for it, then write what arrived since
  await flushUsage();
}
