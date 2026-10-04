// Per-org DuckDB workers — SERVER ONLY (T4.3). `routeByOrg()` (src/server/main.ts)
// points src/engine/duckdb.ts's async calls here, so every resident module's
// `duck.queryAsync(...)` runs in the CALLER'S org's worker, picked by `ctx()` —
// no call site changed.
//
// ── ISOLATION ────────────────────────────────────────────────────────────────
// Each worker is its own in-memory DuckDB instance, locked at start, before it
// reports ready (a worker that cannot lock itself never answers):
//
//   SET memory_limit='…'; SET threads=…;
//   SET temp_directory='<DATA_DIR>/orgs/<org>/temp/duckdb';   -- spills stay in the org
//   SET allowed_directories=['<DATA_DIR>/orgs/<org>/'];        -- before the next line, or it is refused
//   SET enable_external_access=false;
//   SET lock_configuration=true;
//
// So org A's SQL cannot read org B's Parquet, `/etc/passwd`, glob, ATTACH,
// COPY TO, or LOAD an extension, and cannot SET any of it back — measured and
// pinned by scripts/test-duckdbPool.ts. The root is realpath'd with a trailing
// `/` (`orgs/a` must not admit `orgs/ab`); `..` and symlinks out are refused by
// DuckDB itself (measured). The lock is per INSTANCE, so it fixes the
// process-wide limitation the desktop's single connection has
// (src/ipc/mosaic.ts `hardenConnection`).
//
// ── S3 (T5.2) ────────────────────────────────────────────────────────────────
// With STORAGE_URL=s3://…, `orgSetup()` first runs storage.workerSetup — BEFORE
// `enable_external_access=false` (after it, LOAD is refused):
//   LOAD httpfs; LOAD aws;                         -- shipped in the image, never INSTALLed at runtime
//   CREATE SECRET (TYPE s3, PROVIDER credential_chain, …, SCOPE 's3://<bucket>/<prefix>/orgs/<org>/');
// and appends 's3://<bucket>/<prefix>/orgs/<org>/' to allowed_directories. The
// pod's IAM role is the credential; the secret's SCOPE and the allow-list both
// name only the org's prefix. Another org's prefix, a sibling `orgs/<org>x/` and
// a `..` key are refused inside the worker (scripts/test-storageS3.ts, MinIO).
// User SQL could CREATE another SECRET here (the lock does not cover secrets) —
// it still reaches only allowed_directories, and src/engine/sqlGate.ts admits
// a single read-only statement, so no user text gets that far.
//
// ── LIMITS ───────────────────────────────────────────────────────────────────
// At most `maxWorkers` live workers. A new org beyond that evicts the least
// recently used one with nothing in flight (or, if every one is busy, the least
// recently used anyway — it drains its queue, then exits). A worker idle for
// `idleMs` is closed; idle means no call waiting on its start, queued, in flight
// or leased — a call handed a worker before its close always runs. Closing is
// ALWAYS the worker's own queued exit, never `terminate()` (that aborts the
// process mid-native-call — src/engine/duckdb.ts `closeWorker`). Views and per-run relations live in the worker that ran them:
// `datasetView.ensureView` and the queries that read it run in the same org's
// worker because both go through `ctx()`; `withRelationAsync` is SQL text,
// inlined into the query, so it travels with it. Eviction drops an org's views;
// every caller creates its view in the same flow that reads it.
//
// ponytail: ONE connection per org, calls served in order — 20 users of one org
// queue behind each other (each query still uses `threads` cores). A connection
// pool inside the worker is the upgrade if one org's p95 matters.

import * as fs from 'fs';
import * as path from 'path';
import { MessageChannel, Worker } from 'worker_threads';
import * as duck from './duckdb';
import { DuckClient } from './duckdbClient';
import { ORG_RE } from '../app/paths';
import { ctx } from '../server/context';
import type { S3Env } from '../server/env';
import { orgUrl, workerSetup } from './storage';

export interface PoolConfig {
  /** DATA_DIR: org roots are `<dataDir>/orgs/<org>/`. */
  readonly dataDir: string;
  readonly maxWorkers: number;
  /** DuckDB size literal ('512MiB'), validated by src/server/env.ts. */
  readonly memoryLimit: string;
  readonly threads: number;
  readonly queryTimeoutMs: number;
  readonly idleMs: number;
  /** STORAGE_URL=s3://… (T5.2): each worker may also read its org's prefix there. */
  readonly s3?: S3Env | null;
}

const STARTUP_TIMEOUT_MS = 20_000;
const MAX_RESULT_BYTES = 512 << 20; // the bridge's own result ceiling
// Not an org id (ORG_RE has no NUL), so it can never collide with one.
const PROBE_KEY = '\u0000probe';

interface OrgWorker {
  readonly worker: Worker;
  readonly client: DuckClient;
  readonly ready: Promise<void>;
  leases: number;
  /** `call()`s from `get()` until their reply — covers the start and the wait on `ready`, which the client cannot see. */
  waiting: number;
  /** Out of the map; the exit is posted once `waiting` drains, so it queues behind every call already handed this worker. */
  closing: boolean;
  lastUsed: number;
}

const idle = (w: OrgWorker): boolean => w.waiting === 0 && w.client.busy === 0 && w.leases === 0;

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export class DuckPool {
  // Map order is recency order: a use moves the entry to the end.
  private readonly workers = new Map<string, OrgWorker>();
  private binding: boolean | null = null;
  private readonly sweep: NodeJS.Timeout;

  constructor(private readonly cfg: PoolConfig) {
    this.sweep = setInterval(() => this.closeIdle(), Math.max(50, Math.min(cfg.idleMs, 30_000) / 2));
    this.sweep.unref();
  }

  async call(org: string, kind: 'query' | 'exec', sql: string, params: duck.DuckValue[], signal?: AbortSignal): Promise<string> {
    const w = this.get(org);
    w.waiting++;
    try {
      await w.ready;
      return await w.client.call(kind, sql, params, signal);
    } finally {
      w.waiting--;
      w.lastUsed = Date.now();
      if (w.closing && w.waiting === 0) postClose(w);
    }
  }

  /** A port from a compute thread straight to `org`'s worker; the worker is not evicted until `release()`. */
  lease(org: string): { port: import('worker_threads').MessagePort; timeoutMs: number; release(): void } {
    const w = this.get(org);
    const { port1, port2 } = new MessageChannel();
    w.worker.postMessage({ kind: 'port', port: port1 }, [port1]);
    w.leases++;
    let released = false;
    return {
      port: port2,
      timeoutMs: this.cfg.queryTimeoutMs,
      release: () => {
        if (released) return;
        released = true;
        w.leases--;
        w.lastUsed = Date.now();
      },
    };
  }

  /** False once a worker failed to start — callers then take the pure-JS path. */
  available(): boolean {
    return this.binding !== false;
  }

  /** /readyz: true once any worker has started; otherwise start a locked, empty one and ask it. */
  async probe(): Promise<boolean> {
    if (this.binding) return true;
    try {
      return (await this.call(PROBE_KEY, 'query', 'SELECT 1 AS ok', [])).length > 0;
    } catch {
      return false;
    }
  }

  /** Orgs with a live worker, least recently used first (tests). */
  orgs(): string[] {
    return [...this.workers.keys()].filter((k) => k !== PROBE_KEY);
  }

  shutdown(): void {
    clearInterval(this.sweep);
    for (const org of this.workers.keys()) this.close(org); // deleting the current key mid-iteration is safe
  }

  private get(org: string): OrgWorker {
    if (org !== PROBE_KEY && !ORG_RE.test(org)) throw new duck.DuckDBError('query', 'invalid org id');
    const hit = this.workers.get(org);
    if (hit) {
      this.workers.delete(org);
      this.workers.set(org, hit);
      hit.lastUsed = Date.now();
      return hit;
    }
    if (this.workers.size >= this.cfg.maxWorkers) {
      const free = [...this.workers].find(([, w]) => idle(w));
      this.close(free ? free[0] : this.workers.keys().next().value as string);
    }
    const w = this.spawn(org);
    this.workers.set(org, w);
    return w;
  }

  private spawn(org: string): OrgWorker {
    const worker = new Worker(path.join(__dirname, 'duckdbWorker.js'), {
      workerData: {
        // The sync path's buffers: required by the worker, never used here.
        control: new SharedArrayBuffer(16),
        payload: new SharedArrayBuffer(1024),
        dbPath: ':memory:',
        maxBytes: MAX_RESULT_BYTES,
        // The probe loads the S3 extensions too, so /readyz fails on an image without them.
        setup: org === PROBE_KEY ? lockedSetup(this.cfg, [], undefined, this.cfg.s3 ? workerSetup(this.cfg.s3, null) : []) : orgSetup(this.cfg, org),
      },
    });
    const client = new DuckClient(worker, this.cfg.queryTimeoutMs);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new duck.DuckDBError('unavailable', 'DuckDB worker did not start')), STARTUP_TIMEOUT_MS);
      timer.unref();
      worker.on('message', (m: { type?: string; message?: string }) => {
        if (m.type === 'ready') {
          this.binding = true;
          clearTimeout(timer);
          resolve();
        } else if (m.type === 'init-error') {
          if (this.binding === null) this.binding = false;
          clearTimeout(timer);
          reject(new duck.DuckDBError('unavailable', 'DuckDB worker failed to start: ' + m.message));
        }
      });
    });
    ready.catch(() => {
      this.forget(org, entry);
      worker.postMessage({ kind: 'close' }); // a worker that could not lock itself is never used
    });
    const entry: OrgWorker = { worker, client, ready, leases: 0, waiting: 0, closing: false, lastUsed: Date.now() };
    const gone = (): void => {
      client.fail(new duck.DuckDBError('unavailable', 'the DuckDB worker stopped'));
      this.forget(org, entry);
    };
    worker.on('error', gone);
    worker.on('exit', gone);
    // Held open while it starts (someone is awaiting `ready`); after that the
    // client refs it exactly while a call is in flight.
    void ready.then(() => worker.unref(), () => worker.unref());
    return entry;
  }

  private forget(org: string, w: OrgWorker): void {
    if (this.workers.get(org) === w) this.workers.delete(org);
  }

  /** Queued exit: runs after every call already queued, so nothing native is cut off. */
  private close(org: string): void {
    const w = this.workers.get(org);
    if (!w) return;
    this.workers.delete(org);
    w.closing = true;
    if (w.waiting === 0) postClose(w);
  }

  private closeIdle(): void {
    const cutoff = Date.now() - this.cfg.idleMs;
    for (const [org, w] of this.workers) {
      if (idle(w) && w.lastUsed < cutoff) this.close(org);
    }
  }
}

function postClose(w: OrgWorker): void {
  try {
    w.worker.postMessage({ kind: 'close' });
  } catch {
    /* already gone */
  }
}

/** The statements that lock `org`'s worker — see ISOLATION above. Exported for the tests. */
export function orgSetup(cfg: Pick<PoolConfig, 'dataDir' | 'memoryLimit' | 'threads' | 's3'>, org: string): string[] {
  if (!ORG_RE.test(org)) throw new Error('invalid org id');
  const root = path.join(cfg.dataDir, 'orgs', org);
  const spill = path.join(root, 'temp', 'duckdb');
  fs.mkdirSync(spill, { recursive: true });
  // DuckDB compares the canonical path (/var → /private/var on macOS).
  const real = fs.realpathSync(root);
  const s3 = cfg.s3 ?? null;
  const dirs = s3 ? [real + path.sep, orgUrl(s3, org)] : [real + path.sep];
  return lockedSetup(cfg, dirs, path.join(real, 'temp', 'duckdb'), s3 ? workerSetup(s3, org) : []);
}

function lockedSetup(cfg: Pick<PoolConfig, 'memoryLimit' | 'threads'>, dirs: string[], spill?: string, first: string[] = []): string[] {
  return [
    ...first,
    `SET memory_limit=${sqlStr(cfg.memoryLimit)};`,
    `SET threads=${Math.max(1, Math.floor(cfg.threads))};`,
    ...(spill ? [`SET temp_directory=${sqlStr(spill)};`] : []),
    ...(dirs.length ? [`SET allowed_directories=[${dirs.map(sqlStr).join(', ')}];`] : []),
    'SET enable_external_access=false;',
    'SET lock_configuration=true;',
  ];
}

/**
 * Server boot: send every async DuckDB call to the caller's org worker. Outside
 * a request (no `ctx()`) a call rejects — a resident caller falls back to JS.
 */
export function routeByOrg(cfg: PoolConfig): DuckPool {
  const pool = new DuckPool(cfg);
  duck.setRouter({
    call: async (kind, sql, params) => {
      const c = ctx();
      return pool.call(c.org.id, kind, sql, params, c.signal);
    },
    available: () => pool.available(),
    probe: () => pool.probe(),
    lease: () => pool.lease(ctx().org.id),
    shutdown: () => pool.shutdown(),
  });
  return pool;
}
