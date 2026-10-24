// One SIGTERM scenario against the real entry point (`node src/server/main.js`),
// for scripts/test-server-boot.ts (docs/pod-lifecycle/00-design.md §3.10).
//
//   inflight  the in-process job (`sql:prepareSave`, a slow cross join) is the
//             query RUNNING in the org worker; `sql:run` with the same SQL
//             queues behind it, its HTTP open. Signalled once /metrics shows
//             the worker busy.
//   hungup    `sql:run` is running; the client destroys its socket at the
//             signal, so the interrupted query is still unwinding in the
//             worker when the process decides to exit.
//   idle      one quick query, then the signal: a live, idle worker.
//
// It reports what a kubelet would see: the exit, a native abort (SIGABRT /
// 134 / libc++abi / Napi::Error), and an overrun (still alive at the budget
// + 3 s, then SIGKILLed here, as the kubelet would).

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as net from 'net';
import * as path from 'path';
import { withCsrf } from './csrfPair';

const wire: typeof import('../src/server/wire') = require('../src/server/wire');

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');
/** ~1e11 rows: minutes of work with one thread, so only the shutdown can end it. */
export const SLOW_SQL = 'SELECT count(*) AS n FROM range(100000) a(x), range(1000000) b(y) WHERE (x + y) % 7 = 3';

export type Kind = 'inflight' | 'hungup' | 'idle';

export interface Outcome {
  kind: Kind;
  code: number | null;
  signal: string | null;
  aborted: boolean;
  overran: boolean;
  /** Signal → 'exit', ms. */
  goneMs: number;
  readyz503: boolean;
  /** inflight: the job's final state and error, as its tab's stream heard them. */
  job?: { state: string; error?: string };
  stderrTail: string;
  setupError?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function until(pred: () => boolean | Promise<boolean>, ms: number, step = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(step);
  }
  return false;
}

/** Runs one scenario. `env` is the child's whole environment; `graceS` its SHUTDOWN_GRACE_SECONDS. */
export async function runOnce(kind: Kind, env: NodeJS.ProcessEnv, graceS: number, opts: { s3Read?: boolean } = {}): Promise<Outcome> {
  const metricsPort = await freePort();
  const child = spawn(process.execPath, [MAIN], {
    env: { ...env, PORT: '0', METRICS_PORT: String(metricsPort), SHUTDOWN_GRACE_SECONDS: String(graceS), DUCKDB_THREADS: '1', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  let exitAt = 0;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on('exit', (code, signal) => { exitAt = Date.now(); resolve({ code, signal }); }));
  const out: Outcome = { kind, code: null, signal: null, aborted: false, overran: false, goneMs: 0, readyz503: false, stderrTail: '' };
  const kill = async (why: string): Promise<Outcome> => {
    out.setupError = why;
    child.kill('SIGKILL');
    await exited;
    out.stderrTail = (stderr || stdout).slice(-600);
    return out;
  };

  let base = '';
  if (!(await until(() => {
    const m = /"msg":"Server listening at (http:\/\/[^"]+)"/.exec(stdout);
    if (m) base = m[1];
    return !!m || exitAt > 0;
  }, 20_000)) || !base) return kill('the server did not start');

  const rpc = async (channel: string, input: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST', body: wire.encode({ args: [input] }), headers: withCsrf({ 'content-type': 'application/json', ...headers }), signal,
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = wire.decode(text); } catch { /* not wire */ }
    return { status: res.status, body };
  };
  const busy = async (): Promise<boolean> => {
    try {
      const t = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
      return /^ordinate_duckdb_busy_workers 1$/m.test(t);
    } catch {
      return false;
    }
  };

  const made = await rpc('projects:create', { name: `Boot ${kind}` });
  const projectId = (made.body as { id?: string } | null)?.id;
  if (made.status !== 200 || !projectId) return kill(`projects:create → ${made.status} ${JSON.stringify(made.body).slice(0, 200)}`);

  if (opts.s3Read) {
    // A table on S3 read once: storage.readPath starts filling the local cache,
    // which opens s3.ts's main-thread DuckDB to resolve credentials (refutation M1).
    const save = await rpc('sql:prepareSave', { projectId, sql: 'SELECT range AS x FROM range(1000)', params: [] });
    const staged = (save.body as { stagedId?: string } | null)?.stagedId;
    if (!staged) return kill(`sql:prepareSave → ${JSON.stringify(save.body).slice(0, 200)}`);
    const saved = await rpc('dataset:composeSave', { projectId, name: 'OnS3', base: { inline: { name: 'OnS3', stagedId: staged } }, joins: [], steps: [], sourceKind: 'sql' });
    if (saved.status !== 200 || (saved.body as { ok?: boolean } | null)?.ok === false) return kill(`dataset:composeSave → ${saved.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
    const read = await rpc('sql:run', { projectId, sql: 'SELECT count(*) AS n FROM "OnS3"', params: [] });
    if (read.status !== 200) return kill(`sql:run on S3 → ${read.status} ${JSON.stringify(read.body).slice(0, 200)}`);
  }

  // The tab's event stream: the job's pushes arrive here.
  const client = randomUUID();
  const frames: Array<{ event: string; data: unknown }> = [];
  const sse = new AbortController();
  const stream = await fetch(`${base}/api/events?client=${client}`, { signal: sse.signal }).catch(() => null);
  if (!stream || !stream.body) return kill('no event stream');
  void (async () => {
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(frame);
          const da = /^data: (.*)$/m.exec(frame);
          if (ev && da) frames.push({ event: ev[1], data: wire.decode(da[1]) });
        }
      }
    } catch { /* the stream ended with the server */ }
  })();
  await sleep(100); // the stream is registered once its headers are back; a beat for good measure

  const pending: Array<Promise<unknown>> = [];
  const hangUp = new AbortController();
  let jobId = '';
  if (kind === 'inflight') {
    pending.push(rpc('sql:prepareSave', { projectId, sql: SLOW_SQL, params: [] }, { 'x-ordinate-client': client }).catch(() => null));
    const running = await until(() => frames.some((f) => {
      const a = (f.data as { active?: Array<{ id: string; state: string }> } | null)?.active ?? [];
      const j = f.event === 'jobs:changed' ? a.find((x) => x.state === 'running') : undefined;
      if (j) jobId = j.id;
      return !!j;
    }), 10_000);
    if (!running) return kill('the job never ran');
    if (!(await until(busy, 10_000))) return kill('the worker never got busy');
    await sleep(200);
    pending.push(rpc('sql:run', { projectId, sql: SLOW_SQL, params: [] }).catch(() => null));
    await sleep(100);
  } else if (kind === 'hungup') {
    pending.push(rpc('sql:run', { projectId, sql: SLOW_SQL, params: [] }, {}, hangUp.signal).catch(() => null));
    if (!(await until(busy, 10_000))) return kill('the worker never got busy');
    await sleep(200);
  } else {
    const q = await rpc('sql:run', { projectId, sql: 'SELECT 42 AS x', params: [] });
    if (q.status !== 200) return kill(`sql:run → ${q.status}`);
  }

  // The signal. A kubelet sends one; Compose sends one.
  if (kind === 'hungup') hangUp.abort();
  const t0 = Date.now();
  child.kill('SIGTERM');
  void (async () => {
    while (!exitAt) {
      try {
        const r = await fetch(`${base}/readyz`);
        const b = (await r.json()) as { draining?: boolean };
        if (r.status === 503 && b.draining) out.readyz503 = true;
      } catch {
        break; // the listener has closed
      }
      await sleep(50);
    }
  })();
  const budget = graceS * 1000 + 3000;
  const timer = setTimeout(() => { if (!exitAt) { out.overran = true; child.kill('SIGKILL'); } }, budget);
  const { code, signal } = await exited;
  clearTimeout(timer);
  sse.abort();
  await Promise.all(pending);
  out.code = code;
  out.signal = signal;
  out.goneMs = exitAt - t0;
  out.aborted = signal === 'SIGABRT' || code === 134 || /libc\+\+abi|Napi::Error/.test(stderr);
  out.stderrTail = stderr.slice(-600);
  if (kind === 'inflight') {
    for (const f of frames) {
      const lists = f.data as { recent?: Array<{ id: string; state: string; error?: string }> } | null;
      const j = f.event === 'jobs:changed' ? lists?.recent?.find((x) => x.id === jobId) : undefined;
      if (j) out.job = { state: j.state, error: j.error };
    }
  }
  return out;
}

/** A one-line summary of a scenario for the log and the PR body. */
export function line(o: Outcome): string {
  return `${o.kind}: exit ${o.signal ?? o.code} in ${o.goneMs} ms${o.aborted ? ' ABORT' : ''}${o.overran ? ' OVERRUN' : ''}`
    + `${o.kind === 'inflight' ? ` readyz503=${o.readyz503} job=${o.job ? `${o.job.state}/${o.job.error ?? ''}` : 'none'}` : ''}`
    + `${o.setupError ? ` SETUP: ${o.setupError}` : ''}`;
}
