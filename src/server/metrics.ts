// GET /metrics — Prometheus text exposition (format 0.0.4), no dependency.
//
// Served ONLY on its own listener (METRICS_PORT, ./main.ts), never on the app
// port: the ingress routes the app port, so a scrape endpoint there would be
// public by accident. The app port answers /metrics with a plain 404.
//
// What it reports, per process (Prometheus scrapes each pod):
//   ordinate_rpc_requests_total / _duration_seconds      per RPC channel (contracted names only)
//   ordinate_http_requests_total / _duration_seconds     every other route, by route pattern
//   ordinate_jobs                                        the job queue now, by state
//   ordinate_jobs_finished_total                         finished jobs, by kind and final state
//   ordinate_scheduled_job_runs_total                    the Postgres-claimed runs (./jobs/runner.ts)
//   ordinate_compute_pool_*                              compute workers and the queue waiting for one
//   ordinate_resident_calls_total                        residentTrace outcomes per call site (live:<dialect> too)
//   what saturates (docs/server/monitoring.md):
//   ordinate_duckdb_queue_depth / _busy_workers          the per-org DuckDB workers, summed — never by org
//   ordinate_duckdb_wait_seconds                         enqueue → DuckDB starting the call
//   ordinate_pg_pool_clients{state}                      pg's own total / idle / waiting
//   ordinate_event_loop_delay_seconds{quantile}          the last completed 30 s window
//   process_resident_memory_bytes, nodejs_heap_used_bytes, nodejs_external_memory_bytes
//   ordinate_sse_streams, ordinate_live_queries_in_flight, ordinate_draining
//
// Label values are bounded: a channel without a contract is `unknown`, a route
// is Fastify's pattern (`/api/files/:token`), never the raw URL — a token or an
// id never becomes a label.

import * as http from 'http';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { contractFor } from '../api/index';
import * as computePool from '../engine/computePool';
import * as residentTrace from '../engine/residentTrace';
import * as jobs from '../app/jobs';
import { poolStats, WAIT_BUCKETS } from '../engine/duckdbPool';
import { inFlight as liveInFlight } from '../engine/live/liveBudget';
import { runStats } from './jobs/runner';
import { isDraining } from './lifecycle';
import { RPC_ROUTE } from './limits';
import { streamCount } from './sse';

/** A Live question's outcomes (residentTrace, docs/live-data/00-plan.md L2.3). */
const LIVE_OUTCOMES = ['hit', 'warehouse', 'stale', 'refused', 'failed', 'cancelled'] as const;

/** Seconds. Interactive calls sit in the first half; the tail reaches RPC_TIMEOUT_SECONDS' default. */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
  codes: Map<number, number>;
}

let pgPool: Pool | null = null;

/** The app's Postgres pool, for ordinate_pg_pool_clients (./app.ts; null: no database). */
export function watchPgPool(pool: Pool | null): void {
  pgPool = pool;
}

// Event-loop delay over fixed 30 s windows (a scrape only READS: the chart's own
// annotations put two scrapers on each pod). Until the first window completes,
// the one in progress.
const LOOP_WINDOW_MS = 30_000;
let loop: IntervalHistogram | null = null;
let lastLoop: Record<string, number> | null = null;
function loopDelay(): Record<string, number> {
  if (!loop) {
    loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    setInterval(() => {
      lastLoop = loopQuantiles(loop as IntervalHistogram);
      (loop as IntervalHistogram).reset();
    }, LOOP_WINDOW_MS).unref();
  }
  return lastLoop ?? loopQuantiles(loop);
}
function loopQuantiles(h: IntervalHistogram): Record<string, number> {
  const s = (ns: number): number => (h.count ? ns / 1e9 : 0);
  return { '0.5': s(h.percentile(50)), '0.9': s(h.percentile(90)), '0.99': s(h.percentile(99)), '1': s(h.max) };
}

const rpc = new Map<string, Series>();
const routes = new Map<string, Series>();
const finished = new Map<string, number>();
let finishHooked = false;

function observe(map: Map<string, Series>, key: string, code: number, seconds: number): void {
  let s = map.get(key);
  if (!s) map.set(key, (s = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0), codes: new Map() }));
  s.count += 1;
  s.sum += seconds;
  for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) s.buckets[i] += 1;
  s.codes.set(code, (s.codes.get(code) ?? 0) + 1);
}

/** Times every response of `app`, and makes /metrics a 404 on it (it lives on METRICS_PORT). */
export function registerRequestMetrics(app: FastifyInstance): void {
  if (!finishHooked) {
    finishHooked = true;
    jobs.onFinish((j) => {
      const k = `${j.kind}\n${j.state}`;
      finished.set(k, (finished.get(k) ?? 0) + 1);
    });
  }
  app.get('/metrics', async (_req, reply) => reply.code(404).send({ error: 'not found' }));
  app.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions.url;
    const seconds = reply.elapsedTime / 1000;
    if (route === RPC_ROUTE) {
      const channel = (req.params as { channel?: string }).channel ?? '';
      observe(rpc, contractFor(channel) ? channel : 'unknown', reply.statusCode, seconds);
    } else {
      observe(routes, `${req.method} ${route ?? 'unmatched'}`, reply.statusCode, seconds);
    }
    done();
  });
}

/** A label value as the exposition format quotes it. */
export function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

const labels = (l: Record<string, string>): string =>
  '{' + Object.entries(l).map(([k, v]) => `${k}="${esc(v)}"`).join(',') + '}';

function family(out: string[], name: string, type: string, help: string): void {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
}

function requestFamilies(out: string[], prefix: string, label: string, map: Map<string, Series>, what: string): void {
  // A route key is `<METHOD> <pattern>` (see registerRequestMetrics).
  const baseOf = (key: string): Record<string, string> =>
    label === 'route' ? { method: key.slice(0, key.indexOf(' ')), route: key.slice(key.indexOf(' ') + 1) } : { [label]: key };
  family(out, `${prefix}_requests_total`, 'counter', `${what} answered, by status code.`);
  for (const [key, s] of map) {
    const base = baseOf(key);
    for (const [code, n] of s.codes) out.push(`${prefix}_requests_total${labels({ ...base, code: String(code) })} ${n}`);
  }
  family(out, `${prefix}_request_duration_seconds`, 'histogram', `Time to answer ${what.toLowerCase()}, in seconds.`);
  for (const [key, s] of map) {
    const base = baseOf(key);
    BUCKETS.forEach((b, i) => out.push(`${prefix}_request_duration_seconds_bucket${labels({ ...base, le: String(b) })} ${s.buckets[i]}`));
    out.push(`${prefix}_request_duration_seconds_bucket${labels({ ...base, le: '+Inf' })} ${s.count}`);
    out.push(`${prefix}_request_duration_seconds_sum${labels(base)} ${s.sum}`);
    out.push(`${prefix}_request_duration_seconds_count${labels(base)} ${s.count}`);
  }
}

/** The whole exposition, as of now. */
export function metricsText(): string {
  const out: string[] = [];
  requestFamilies(out, 'ordinate_rpc', 'channel', rpc, 'RPC calls');
  requestFamilies(out, 'ordinate_http', 'route', routes, 'HTTP requests other than RPC');

  const active = jobs.snapshot().active;
  family(out, 'ordinate_jobs', 'gauge', 'Jobs in this process now, by state.');
  for (const state of ['queued', 'running']) out.push(`ordinate_jobs${labels({ state })} ${active.filter((j) => j.state === state).length}`);
  family(out, 'ordinate_jobs_finished_total', 'counter', 'Jobs that reached a final state, by kind and state.');
  for (const [k, n] of finished) {
    const [kind, state] = k.split('\n');
    out.push(`ordinate_jobs_finished_total${labels({ kind, state })} ${n}`);
  }
  family(out, 'ordinate_scheduled_job_runs_total', 'counter', 'Scheduled job runs this pod claimed and finished, by kind and outcome.');
  for (const [k, n] of runStats()) {
    const [kind, outcome] = k.split('\n');
    out.push(`ordinate_scheduled_job_runs_total${labels({ kind, outcome })} ${n}`);
  }

  const pool = computePool.stats();
  family(out, 'ordinate_compute_pool_queue_depth', 'gauge', 'Compute ops waiting for a free worker.');
  out.push(`ordinate_compute_pool_queue_depth ${pool.waiting}`);
  family(out, 'ordinate_compute_pool_workers', 'gauge', 'Compute worker threads, by whether they are running an op.');
  out.push(`ordinate_compute_pool_workers${labels({ state: 'busy' })} ${pool.busy}`);
  out.push(`ordinate_compute_pool_workers${labels({ state: 'idle' })} ${pool.workers - pool.busy}`);

  family(out, 'ordinate_resident_calls_total', 'counter', 'Which path answered each resident call site: resident, skipped or failed (failed should stay 0); cache:<op> sites count hit and miss; live:<dialect> sites count hit, warehouse, stale, refused, failed and cancelled.');
  for (const [op, c] of Object.entries(residentTrace.snapshot())) {
    const outcomes = op.startsWith('cache:') ? (['hit', 'miss'] as const)
      : op.startsWith('live:') ? LIVE_OUTCOMES
      : (['resident', 'skipped', 'failed'] as const);
    for (const outcome of outcomes) out.push(`ordinate_resident_calls_total${labels({ op, outcome })} ${c[outcome]}`);
  }
  saturation(out);
  return out.join('\n') + '\n';
}

/** What fills up first (docs/server/monitoring.md). No org label anywhere: cardinality, and tenant names. */
function saturation(out: string[]): void {
  const duck = poolStats() ?? { queueDepth: 0, busyWorkers: 0, wait: { buckets: WAIT_BUCKETS.map(() => 0), sum: 0, count: 0 } };
  family(out, 'ordinate_duckdb_queue_depth', 'gauge', 'Calls handed to an org DuckDB worker that have not started, all orgs together.');
  out.push(`ordinate_duckdb_queue_depth ${duck.queueDepth}`);
  family(out, 'ordinate_duckdb_busy_workers', 'gauge', 'Org DuckDB workers with a call waiting, running or leased.');
  out.push(`ordinate_duckdb_busy_workers ${duck.busyWorkers}`);
  family(out, 'ordinate_duckdb_wait_seconds', 'histogram', 'Time from a DuckDB call being asked for to DuckDB starting it, in seconds.');
  let cum = 0;
  WAIT_BUCKETS.forEach((b, i) => {
    cum += duck.wait.buckets[i];
    out.push(`ordinate_duckdb_wait_seconds_bucket${labels({ le: String(b) })} ${cum}`);
  });
  out.push(`ordinate_duckdb_wait_seconds_bucket${labels({ le: '+Inf' })} ${duck.wait.count}`);
  out.push(`ordinate_duckdb_wait_seconds_sum ${duck.wait.sum}`, `ordinate_duckdb_wait_seconds_count ${duck.wait.count}`);

  if (pgPool) {
    family(out, 'ordinate_pg_pool_clients', 'gauge', 'Postgres pool clients, by state: total open, idle, and queries waiting for one.');
    out.push(`ordinate_pg_pool_clients${labels({ state: 'total' })} ${pgPool.totalCount}`);
    out.push(`ordinate_pg_pool_clients${labels({ state: 'idle' })} ${pgPool.idleCount}`);
    out.push(`ordinate_pg_pool_clients${labels({ state: 'waiting' })} ${pgPool.waitingCount}`);
  }

  family(out, 'ordinate_event_loop_delay_seconds', 'gauge', 'Event-loop delay over the last completed 30 s window, by quantile (1 = the max), in seconds.');
  for (const [quantile, v] of Object.entries(loopDelay())) out.push(`ordinate_event_loop_delay_seconds${labels({ quantile })} ${v}`);

  const mem = process.memoryUsage();
  family(out, 'process_resident_memory_bytes', 'gauge', 'Resident set size, in bytes.');
  out.push(`process_resident_memory_bytes ${mem.rss}`);
  family(out, 'nodejs_heap_used_bytes', 'gauge', 'V8 heap in use, in bytes.');
  out.push(`nodejs_heap_used_bytes ${mem.heapUsed}`);
  family(out, 'nodejs_external_memory_bytes', 'gauge', 'Memory held outside the V8 heap (Buffers and the like), in bytes.');
  out.push(`nodejs_external_memory_bytes ${mem.external}`);

  family(out, 'ordinate_sse_streams', 'gauge', 'Open event streams (browser tabs) on this pod.');
  out.push(`ordinate_sse_streams ${streamCount()}`);
  family(out, 'ordinate_live_queries_in_flight', 'gauge', 'Live warehouse statements running from this pod, all orgs together.');
  out.push(`ordinate_live_queries_in_flight ${liveInFlight()}`);
  family(out, 'ordinate_draining', 'gauge', '1 while the pod is shutting down (/readyz answers 503), else 0.');
  out.push(`ordinate_draining ${isDraining() ? 1 : 0}`);
}

/**
 * The metrics listener: GET /metrics and nothing else (404). Plain `http`, not
 * a second Fastify app — no auth, CSRF, CSP or rate limits are needed for a
 * port only the cluster's scraper reaches.
 */
export function startMetricsServer(port: number, host: string): Promise<http.Server> {
  loopDelay(); // the first window starts now, not at the first scrape
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metricsText());
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
