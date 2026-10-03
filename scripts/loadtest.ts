// Load test for T4.3 — NOT part of `npm test` (not a test-*.ts; it takes minutes).
//
//   npm run build:ts && node scripts/loadtest.js [--vus 20] [--iterations 5] [--rows 1000000]
//
// 1. SEED, in this process: a temp DATA_DIR, org `default`, one project and one
//    `--rows`-row dataset saved through the ordinary `datasets.saveDataset`
//    (Parquet), as the dev admin.
// 2. SERVE: the real server (`src/server/main.js`, dev sign-in, per-org DuckDB
//    workers) in a child process, with THIS file preloaded as a probe: it runs
//    `perf_hooks.monitorEventLoopDelay` inside the server and answers over IPC.
// 3. LOAD: `--vus` virtual users, each `--iterations` times, over HTTP RPC:
//    open the dataset (`dataset:columns`), one page (random offset, sorted every
//    other time), three chart queries at once as a dashboard does
//    (`visual:data`: sum by region, monthly average, max + count by category,
//    each under a random filter so the answer cache rarely helps), one stats
//    run (`dataset:stats`: every column summary + quality issues).
// 4. REPORT: p50/p95 per operation (client side, includes queueing) and the
//    server's event-loop delay p50/p99/max over the load window. Exit 1 when
//    lag p99 ≥ 50 ms (T4.3's bar) or any request failed.

export {}; // module scope — sibling scripts share top-level names
import { withCsrf } from './csrfPair';

if (process.env.ORDINATE_LOADTEST_PROBE === '1') installProbe();
else if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

/** Inside the server: the event-loop delay histogram, read and reset over IPC. */
function installProbe(): void {
  const { monitorEventLoopDelay }: typeof import('perf_hooks') = require('perf_hooks');
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const ms = (ns: number): number => Math.round(ns / 1e4) / 100;
  process.on('message', (m: unknown) => {
    if (m === 'reset') h.reset();
    if (m === 'read' && process.send) {
      process.send({ p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max), mean: ms(h.mean), samples: h.count });
    }
  });
}

interface Lag { p50: number; p99: number; max: number; mean: number; samples: number }

async function main(): Promise<void> {
  const fs: typeof import('fs') = require('fs');
  const os: typeof import('os') = require('os');
  const path: typeof import('path') = require('path');
  const { fork }: typeof import('child_process') = require('child_process');
  const wire: typeof import('../src/server/wire') = require('../src/server/wire');

  const arg = (name: string, dflt: number): number => {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? Number(process.argv[i + 1]) : dflt;
  };
  const VUS = arg('vus', 20);
  const ITERATIONS = arg('iterations', 5);
  const ROWS = arg('rows', 1_000_000);

  // ── 1. Seed ──────────────────────────────────────────────────────────────
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-load-'));
  const t0 = Date.now();
  const { projectId, datasetId } = await seed(dataDir, ROWS);
  console.log(`seeded ${ROWS.toLocaleString('en-US')} rows in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // ── 2. Serve ─────────────────────────────────────────────────────────────
  const child = fork(path.join(__dirname, '..', 'src', 'server', 'main.js'), [], {
    cwd: path.join(__dirname, '..'),
    execArgv: ['--require', __filename],
    env: { ...process.env, ORDINATE_LOADTEST_PROBE: '1', DATABASE_URL: '', PORT: '0', DATA_DIR: dataDir, ORDINATE_ENV: 'dev', AUTH_MODE: 'dev', LOG_LEVEL: 'info' },
    silent: true,
  });
  let out = '';
  const base = await new Promise<string>((resolve, reject) => {
    const onData = (c: Buffer): void => {
      out += c.toString();
      const m = /"msg":"Server listening at (http:\/\/[^"]+)"/.exec(out);
      if (m?.[1]) resolve(m[1]);
      if (out.length > 1e6) out = out.slice(-1e5); // keep draining: the server's log is a pipe
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited (${code}):\n${out}`)));
  });
  const lag = (msg: 'read' | 'reset'): Promise<Lag | void> =>
    new Promise((resolve) => {
      if (msg === 'reset') { child.send('reset'); resolve(); return; }
      child.once('message', (m) => resolve(m as Lag));
      child.send('read');
    });

  const rpc = async (channel: string, payload: unknown): Promise<unknown> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json' }),
      body: wire.encode({ args: [payload] }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`${channel}: HTTP ${res.status} ${text.slice(0, 200)}`);
    const body = wire.decode(text) as { ok?: boolean; error?: string } | null;
    if (body && typeof body === 'object' && body.ok === false) throw new Error(`${channel}: ${body.error}`);
    return body;
  };

  // ── 3. Load ──────────────────────────────────────────────────────────────
  const REGIONS = ['north', 'south', 'east', 'west', 'central', 'coastal', 'mountain', 'island'];
  const CATEGORIES = Array.from({ length: 24 }, (_, i) => `cat-${String(i).padStart(2, '0')}`);
  const pick = <T>(xs: readonly T[], n: number): T[] => [...xs].sort(() => Math.random() - 0.5).slice(0, n);
  const times: Record<string, number[]> = {};
  let failures = 0;
  const timed = async (op: string, fn: () => Promise<unknown>): Promise<void> => {
    const s = performance.now();
    try {
      await fn();
      (times[op] ??= []).push(performance.now() - s);
    } catch (err) {
      failures++;
      console.error(`FAIL ${op}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const iteration = async (i: number): Promise<void> => {
    await timed('open dataset (dataset:columns)', () => rpc('dataset:columns', { projectId, id: datasetId }));
    const sorted = i % 2 === 1;
    await timed(`page (dataset:page${sorted ? ', sorted' : ''})`, () =>
      rpc('dataset:page', { projectId, datasetId, offset: Math.floor(Math.random() * (ROWS - 100)), limit: 100, ...(sorted ? { sortColumn: 'sales', sortDir: 'desc' } : {}) }));
    await Promise.all([
      timed('chart: sum(sales) by region', () => rpc('visual:data', {
        projectId, datasetId, encoding: { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] },
        filters: [{ type: 'filter', column: 'category', op: 'in', values: pick(CATEGORIES, 6) }],
      })),
      timed('chart: avg(qty) by month', () => rpc('visual:data', {
        projectId, datasetId, encoding: { category: 'day', grain: 'month', values: [{ column: 'qty', aggregation: 'avg' }] },
        filters: [{ type: 'filter', column: 'region', op: 'in', values: pick(REGIONS, 3) }],
      })),
      timed('chart: max(sales), count by category', () => rpc('visual:data', {
        projectId, datasetId, encoding: { category: 'category', values: [{ column: 'sales', aggregation: 'max' }, { column: 'qty', aggregation: 'count' }] },
        filters: [{ type: 'filter', column: 'region', op: 'in', values: pick(REGIONS, 5) }],
      })),
    ]);
    await timed('stats run (dataset:stats)', () => rpc('dataset:stats', { projectId, datasetId }));
  };

  // Warm-up: one pass alone (starts the org worker, first reads of the file).
  const meta = (await rpc('dataset:columns', { projectId, id: datasetId })) as { rowCount?: number } | null;
  if (meta?.rowCount !== ROWS) throw new Error(`the dataset has ${String(meta?.rowCount)} rows, not ${ROWS}`);
  await iteration(0);
  for (const k of Object.keys(times)) times[k] = [];
  failures = 0;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  await sleep(200);
  await lag('reset');
  await sleep(2000);
  const idle = (await lag('read')) as Lag;
  await lag('reset');
  const started = performance.now();
  await Promise.all(Array.from({ length: VUS }, async () => {
    for (let i = 0; i < ITERATIONS; i++) await iteration(i);
  }));
  const wall = performance.now() - started;
  const under = (await lag('read')) as Lag;

  // ── 4. Report ────────────────────────────────────────────────────────────
  const pct = (xs: number[], p: number): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
  };
  const f = (n: number): string => n.toFixed(1).padStart(8);
  console.log(`\n${VUS} virtual users × ${ITERATIONS} iterations, ${ROWS.toLocaleString('en-US')} rows, ${(wall / 1000).toFixed(1)} s wall, load avg ${os.loadavg().map((x) => x.toFixed(1)).join(' ')}`);
  console.log('operation'.padEnd(42) + '       n   p50 ms   p95 ms   max ms');
  let n = 0;
  for (const [op, xs] of Object.entries(times)) {
    n += xs.length;
    console.log(op.padEnd(42) + String(xs.length).padStart(8) + f(pct(xs, 50)) + f(pct(xs, 95)) + f(Math.max(...xs)));
  }
  console.log(`${n} requests, ${failures} failed, ${(n / (wall / 1000)).toFixed(1)} req/s`);
  console.log(`server event-loop delay, idle (2 s):  p50 ${idle.p50} ms  p99 ${idle.p99} ms  max ${idle.max} ms`);
  console.log(`server event-loop delay, under load:  p50 ${under.p50} ms  p99 ${under.p99} ms  max ${under.max} ms  (${under.samples} samples, resolution 10 ms)`);

  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  fs.rmSync(dataDir, { recursive: true, force: true });
  const pass = under.p99 < 50 && failures === 0;
  console.log(pass ? 'PASS: event-loop delay p99 < 50 ms, no failures' : 'FAIL: event-loop delay p99 ≥ 50 ms or a request failed');
  process.exit(pass ? 0 : 1);
}

/** The dataset, written the ordinary way into org `default` (dev sign-in's org). */
async function seed(dataDir: string, rows: number): Promise<{ projectId: string; datasetId: string }> {
  const context: typeof import('../src/server/context') = require('../src/server/context');
  context.enterServerMode(dataDir);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
  const dev = { user: { email: 'dev@local', role: 'admin' as const }, org: { id: 'default' } };
  return context.runInContext(dev, 'seed', async () => {
    await projects.init();
    await datasets.init();
    const projectId = (await projects.createProject('Load test')).id;
    const REGIONS = ['north', 'south', 'east', 'west', 'central', 'coastal', 'mountain', 'island'];
    let x = 42;
    const rnd = (): number => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    const day0 = Date.UTC(2023, 0, 1);
    const data: (string | number | null)[][] = new Array(rows);
    for (let i = 0; i < rows; i++) {
      data[i] = [
        REGIONS[Math.floor(rnd() * REGIONS.length)],
        `cat-${String(Math.floor(rnd() * 24)).padStart(2, '0')}`,
        Math.round(rnd() * 100_000) / 100,
        Math.floor(rnd() * 50),
        new Date(day0 + Math.floor(rnd() * 1095) * 86_400_000).toISOString().slice(0, 10),
      ];
    }
    const saved = await datasets.saveDataset(projectId, {
      name: 'orders',
      sourceKind: 'csv',
      columns: [
        { name: 'region', type: 'text' }, { name: 'category', type: 'text' }, { name: 'sales', type: 'number' },
        { name: 'qty', type: 'number' }, { name: 'day', type: 'date' },
      ],
      rows: data,
    });
    if (!saved) throw new Error('seeding the dataset failed');
    duck.shutdown();
    return { projectId, datasetId: saved.id };
  });
}
