// Scheduled jobs across N pods — the Postgres `jobs` table (migration 0005).
//
// The desktop app runs its schedules on in-process timers (src/app/refreshWiring.ts).
// N server pods doing that would run every schedule N times, so on the server a
// schedule is a ROW — (org, kind, target) with next_run_at — and a run is a CLAIM:
//
//   1. every pod polls (POLL_MS) and claims ONE due row in one statement:
//      `SELECT … WHERE next_run_at <= now() AND lease expired … FOR UPDATE SKIP LOCKED`
//      feeding an UPDATE that stamps `lease_owner = '<pod>/<claim uuid>'` and
//      `lease_until = now() + LEASE_MS`. SKIP LOCKED lets two pods polling at the
//      same instant pass each other instead of queueing; the LEASE is what keeps
//      the row taken after that statement commits.
//   2. while the job runs, a heartbeat every LEASE_MS/3 pushes lease_until on;
//   3. on finish (success or failure) next_run_at = now() + everyMs, the lease is
//      cleared and `runs` counted — ONLY `WHERE lease_owner = <this claim>`.
//
// CRASH SAFETY. A pod killed mid-run never reschedules: next_run_at stays in the
// past, its heartbeat stops, and once lease_until passes the next poll on any
// pod retakes the row (≤ LEASE_MS + POLL_MS). A pod whose event loop stalls past
// its lease (a blocking DuckDB call) can be overtaken while still running; its
// late finish then matches no row (the owner column is the fence) and is logged,
// not applied. So a run is ONCE across pods in normal operation and AT LEAST
// once across a crash or a stall — a job must tolerate a repeat, which the
// desktop's schedules already do (each stamps its own "last run" first).
//
// Each pod runs claimed jobs ONE AT A TIME: refreshScheduler.tickNow is strictly
// serial per process (its `running` flag would skip a second org's tick and the
// row would be rescheduled as if it had run). N pods = N jobs in parallel.
//
// ROWS. A kind is declared in code (`defineJob`); every pod inserts the row for
// each org it can see under DATA_DIR/orgs × each kind it knows, ON CONFLICT DO
// NOTHING, first due one interval from now (the desktop's "no tick at launch").
// A pod only claims kinds it knows, so a rolling deploy that adds a kind never
// hands an old pod a job it cannot run.
//
// THE HOOK for later schedules (S3 GC, T5.2): `defineJob('s3:gc', { everyMs, run })`
// before startRunner — nothing else changes.
//
// Must load without Electron (scripts/test-server-boot.ts).

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Pool } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { runInContext, type Identity } from '../context';

export interface JobKind {
  /** Interval between the end of one run and the next. */
  readonly everyMs: number;
  /** Runs inside the org's context: `ctx().org.id` is the row's org, `ctx().client` a no-op. */
  run(target: string): Promise<void>;
}

export interface Claim {
  readonly orgId: string;
  readonly kind: string;
  readonly target: string;
  readonly owner: string;
}

let pollMs = 5_000;
let leaseMs = 60_000;

/** Test hook: shorter poll and lease, for runners started after this call. */
export function setTimingForTest(t: { pollMs?: number; leaseMs?: number }): void {
  pollMs = t.pollMs ?? pollMs;
  leaseMs = t.leaseMs ?? leaseMs;
}

/** This process, as it appears in lease_owner (hostname is the pod name under Kubernetes). */
export const POD = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/; // the same rule src/app/paths.ts enforces
const ERROR_MAX = 500;

const kinds = new Map<string, JobKind>();

/** Declares a scheduled kind. Once per kind per process. */
export function defineJob(kind: string, def: JobKind): void {
  if (kinds.has(kind)) throw new Error(`job kind ${kind} is already defined`);
  if (!(def.everyMs >= 1000)) throw new Error(`job kind ${kind}: everyMs must be at least 1000`);
  kinds.set(kind, def);
}

/** Who a job acts as. Org-scoped; there is no tab to push to. */
const systemIdentity = (org: string): Identity => ({ user: { email: 'jobs@system', role: 'admin' }, org: { id: org } });

/** Claims one due row of these kinds for `owner`'s pod, or null when nothing is due. */
export async function claimOne(pool: Pool, kindNames: readonly string[], lease: number = leaseMs): Promise<Claim | null> {
  const owner = `${POD}/${randomUUID()}`;
  const r = await pool.query<{ org_id: string; kind: string; target: string }>(
    `WITH due AS (
       SELECT org_id, kind, target FROM jobs
        WHERE next_run_at <= now()
          AND (lease_until IS NULL OR lease_until < now())
          AND kind = ANY($2::text[])
        ORDER BY next_run_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
     UPDATE jobs j
        SET lease_owner = $1, lease_until = now() + $3 * interval '1 millisecond', last_started_at = now()
       FROM due
      WHERE j.org_id = due.org_id AND j.kind = due.kind AND j.target = due.target
     RETURNING j.org_id, j.kind, j.target`,
    [owner, kindNames, lease],
  );
  const row = r.rows[0];
  return row ? { orgId: row.org_id, kind: row.kind, target: row.target, owner } : null;
}

const KEY_WHERE = 'org_id = $1 AND kind = $2 AND target = $3 AND lease_owner = $4';

/** Runs a claimed row to completion and reschedules it, fenced on the claim. Never throws on a job failure. */
export async function runClaim(pool: Pool, c: Claim, log: FastifyBaseLogger): Promise<void> {
  const def = kinds.get(c.kind);
  const key = [c.orgId, c.kind, c.target, c.owner];
  const hb = setInterval(() => {
    pool.query(`UPDATE jobs SET lease_until = now() + $5 * interval '1 millisecond' WHERE ${KEY_WHERE}`, [...key, leaseMs]).then(
      (r) => { if (r.rowCount === 0) log.warn({ org: c.orgId, kind: c.kind }, 'job lease lost while running; another pod may have retaken it'); },
      (err: unknown) => log.warn({ err, kind: c.kind }, 'job heartbeat failed'),
    );
  }, Math.max(100, Math.floor(leaseMs / 3)));
  let error: string | null = null;
  try {
    if (!def) throw new Error(`unknown job kind ${c.kind}`);
    await runInContext(systemIdentity(c.orgId), `job:${c.kind}:${c.orgId}`, () => def.run(c.target));
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX);
    log.error({ err, org: c.orgId, kind: c.kind }, 'scheduled job failed');
  } finally {
    clearInterval(hb);
  }
  const every = def ? def.everyMs : 60_000;
  const r = await pool.query(
    `UPDATE jobs SET next_run_at = now() + $5 * interval '1 millisecond', lease_owner = NULL, lease_until = NULL,
            runs = runs + 1, last_finished_at = now(), last_error = $6
      WHERE ${KEY_WHERE}`,
    [...key, every, error],
  );
  if (r.rowCount === 0) log.warn({ org: c.orgId, kind: c.kind }, 'job finished after its lease was retaken; not rescheduled by this pod');
}

/** The orgs this pod can see. ponytail: DATA_DIR/orgs until T3.2's `orgs` table. */
function orgIds(dataDir: string): string[] {
  try {
    return fs.readdirSync(path.join(dataDir, 'orgs')).filter((n) => ORG_RE.test(n));
  } catch {
    return [];
  }
}

/** Starts this pod's poller. `stop()` ends polling and waits for the job in flight. */
export function startRunner(pool: Pool, dataDir: string, log: FastifyBaseLogger): { stop(): Promise<void> } {
  const ensured = new Set<string>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let pass: Promise<void> | null = null;

  async function ensureRows(): Promise<void> {
    const orgs: string[] = [];
    const ks: string[] = [];
    const every: number[] = [];
    for (const org of orgIds(dataDir)) {
      for (const [kind, def] of kinds) {
        if (ensured.has(`${org}\n${kind}`)) continue;
        orgs.push(org);
        ks.push(kind);
        every.push(def.everyMs);
      }
    }
    if (!orgs.length) return;
    await pool.query(
      `INSERT INTO jobs (org_id, kind, next_run_at)
       SELECT o, k, now() + e * interval '1 millisecond' FROM unnest($1::text[], $2::text[], $3::int8[]) AS t(o, k, e)
       ON CONFLICT DO NOTHING`,
      [orgs, ks, every],
    );
    orgs.forEach((o, i) => ensured.add(`${o}\n${ks[i]}`));
  }

  async function drain(): Promise<void> {
    await ensureRows();
    const names = [...kinds.keys()];
    while (!stopped && names.length) {
      const c = await claimOne(pool, names);
      if (!c) return;
      await runClaim(pool, c, log);
    }
  }

  const poll = (): void => {
    pass = drain()
      .catch((err: unknown) => log.warn({ err }, 'job poll failed'))
      .finally(() => {
        pass = null;
        if (!stopped) timer = setTimeout(poll, pollMs);
      });
  };
  poll();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await pass;
    },
  };
}
