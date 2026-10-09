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
//
// Label values are bounded: a channel without a contract is `unknown`, a route
// is Fastify's pattern (`/api/files/:token`), never the raw URL — a token or an
// id never becomes a label.

import * as http from 'http';
import type { FastifyInstance } from 'fastify';
import { contractFor } from '../api/index';
import * as computePool from '../engine/computePool';
import * as residentTrace from '../engine/residentTrace';
import * as jobs from '../app/jobs';
import { runStats } from './jobs/runner';
import { RPC_ROUTE } from './limits';

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
  return out.join('\n') + '\n';
}

/**
 * The metrics listener: GET /metrics and nothing else (404). Plain `http`, not
 * a second Fastify app — no auth, CSRF, CSP or rate limits are needed for a
 * port only the cluster's scraper reaches.
 */
export function startMetricsServer(port: number, host: string): Promise<http.Server> {
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
