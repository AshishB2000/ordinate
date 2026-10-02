// Self-check for the Pipelines DAG and its runner: src/app/pipelines.ts.
//
// The graph is built the way the app builds it — real records through
// lineage.buildGraph, then buildPipeline — so a lineage change that loses a
// reference shows up here as a missing pipeline edge. Then the runner, with
// every effect injected: topological order with parallel branches, retries
// with doubling backoff, and a failure blocking everything after it.
//
//   npm run build:ts && node scripts/test-pipelines.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const P: typeof import('../src/app/pipelines') = require('../src/app/pipelines');
const L: typeof import('../src/analysis/lineage') = require('../src/analysis/lineage');

type Graph = import('../src/app/pipelines').PipelineGraph;
type Exec = import('../src/app/pipelines').ExecResult;

const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const has = (g: Graph, from: string, to: string): boolean => g.edges.some((e) => e.from === from && e.to === to);

async function main(): Promise<void> {
  // ── 1. DAG construction from real records ─────────────────────────────────
  const [C, A, B, I, LK, S, PASTE, V, D, R, AL] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(u);
  const input = {
    connections: [{ id: C, name: 'Warehouse', kind: 'postgres' }],
    datasets: [
      { id: A, name: 'Orders', sourceKind: 'postgres', origin: { kind: 'connection', connId: C, table: 'orders' }, steps: [{ type: 'filter' }] },
      { id: B, name: 'Targets file', sourceKind: 'csv', origin: { kind: 'file', path: '/data/targets.csv' } },
      { id: I, name: 'Region map', sourceKind: 'input' },
      { id: LK, name: 'Mapped', sourceKind: 'csv', steps: [{ type: 'lookup_join', datasetId: I }] },
      { id: S, name: 'Orders vs targets', sourceKind: 'sql', origin: { kind: 'sql', deps: [A, B] } },
      { id: PASTE, name: 'Scratch', sourceKind: 'paste' },
    ],
    visuals: [{ id: V, name: 'Gap', datasetId: S, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'gap' }] } }],
    dashboards: [{ id: D, name: 'Ops', sheets: [{ cards: [{ type: 'visual', visualId: V }] }] }],
    metrics: [],
    reports: [{ id: R, name: 'Ops weekly', analysisId: D, format: 'pdf' }],
    alerts: [{ id: AL, name: 'Orders drop', datasetId: A, metric: { column: 'amount' }, compare: 'threshold' }],
  };
  const built = P.buildPipeline(L.buildGraph(input), {
    qualityDatasets: [A],
    publish: { dashboardIds: [D], outDir: '/out/site' },
    sqlDeps: { [S]: [A, B] },
    runnable: [A, B, S, LK],
  });
  ok('build: a graph, not a refusal', built.ok, JSON.stringify(built));
  if (!built.ok) return;
  const stage = (id: string): number => (built.nodes.find((n) => n.id === id) || { stage: -1 }).stage;
  ok('build: the connection and the file are sources (stage 0)', stage('source:conn:' + C) === 0 && stage('source:file:/data/targets.csv') === 0);
  ok('build: imported/pasted/typed sources are not pipeline steps', !built.nodes.some((n) => n.id.startsWith('source:import:')));
  ok('build: datasets with no dataset parent are stage 1', stage('dataset:' + A) === 1 && stage('dataset:' + B) === 1 && stage('dataset:' + I) === 1);
  ok('build: SQL and input-table-derived datasets are stage 2', stage('dataset:' + S) === 2 && stage('dataset:' + LK) === 2);
  ok('build: quality 3, alert 4, report and publish 5',
    stage('quality:' + A) === 3 && stage('alert:' + AL) === 4 && stage('report:' + R) === 5 && stage('publish') === 5);
  ok('build: a pasted dataset nothing reads is not part of any pipeline', stage('dataset:' + PASTE) === -1);
  ok('build: sources feed their datasets', has(built, 'source:conn:' + C, 'dataset:' + A) && has(built, 'source:file:/data/targets.csv', 'dataset:' + B));
  ok('build: a SQL dataset hangs off every dataset its query reads', has(built, 'dataset:' + A, 'dataset:' + S) && has(built, 'dataset:' + B, 'dataset:' + S));
  ok('build: a lookup on an input table makes it an input', has(built, 'dataset:' + I, 'dataset:' + LK));
  ok('build: a report connects through visual → dashboard to its dataset', has(built, 'dataset:' + S, 'report:' + R));
  ok('build: the publish connects through its dashboards', has(built, 'dataset:' + S, 'publish'));
  ok('build: the quality gate — the alert waits on the checks, not the dataset',
    has(built, 'quality:' + A, 'alert:' + AL) && !has(built, 'dataset:' + A, 'alert:' + AL));
  ok('build: a derived dataset is NOT gated by quality (it is an earlier stage)', has(built, 'dataset:' + A, 'dataset:' + S));
  ok('build: every edge points left to right or within a stage',
    built.edges.every((e) => stage(e.from) <= stage(e.to)), JSON.stringify(built.edges));
  ok('build: an empty project is an empty pipeline', (() => {
    const e = P.buildPipeline(L.buildGraph({ datasets: [], visuals: [], dashboards: [], metrics: [], reports: [], alerts: [] }));
    return e.ok && e.nodes.length === 0 && e.edges.length === 0;
  })());

  // ── 2. Cycle refusal ─────────────────────────────────────────────────────
  const [X, Y] = [21, 22].map(u);
  const loop = P.buildPipeline(L.buildGraph({
    datasets: [
      { id: X, name: 'X', origin: { kind: 'combined', leftId: Y, rightId: Y } },
      { id: Y, name: 'Y', origin: { kind: 'combined', leftId: X, rightId: X } },
    ],
    visuals: [], dashboards: [], metrics: [], reports: [], alerts: [],
  }));
  ok('cycle: two datasets combined from each other are refused', !loop.ok && JSON.stringify(loop.cycle.sort()) === '["X","Y"]', JSON.stringify(loop));
  const t = P.topoOrder(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }]);
  ok('cycle: topoOrder orders what it can and names the rest', JSON.stringify(t) === JSON.stringify({ order: ['a'], cycle: ['b', 'c'] }));
  let threw = false;
  try {
    await P.runGraph({ nodes: [{ id: 'b' }, { id: 'c' }] as any, edges: [{ from: 'b', to: 'c' }, { from: 'c', to: 'b' }] }, ['b'],
      { exec: async () => ({ ok: true }), policy: { retries: 0, backoffMs: 1000 }, sleep: async () => undefined });
  } catch (_) { threw = true; }
  ok('cycle: the runner refuses a looped graph rather than hanging', threw);

  // ── 3. Topological order with parallel branches ──────────────────────────
  //   a → b → d,  a → c → d,  d → e;  f stands alone (not downstream of a)
  const node = (id: string): any => ({ id, kind: 'dataset', stage: 1, name: id.toUpperCase(), sub: '' });
  const diamond: Graph = {
    nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map(node),
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }, { from: 'd', to: 'e' }],
  };
  const log: string[] = [];
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const DUR: Record<string, number> = { a: 5, b: 40, c: 10, d: 5, e: 5, f: 5 };
  const out = await P.runGraph(diamond, ['a'], {
    exec: async (id) => { log.push('start ' + id); await wait(DUR[id]); log.push('end ' + id); return { ok: true }; },
    policy: { retries: 0, backoffMs: 1000 }, sleep: async () => undefined,
  });
  const at = (s: string): number => log.indexOf(s);
  ok('order: everything downstream of the start runs, nothing else', JSON.stringify(out.map((o) => o.nodeId).sort()) === '["a","b","c","d","e"]', log.join(', '));
  ok('order: a finishes before either branch starts', at('end a') < at('start b') && at('end a') < at('start c'));
  ok('order: the two branches run SIDE BY SIDE (both start before either ends)',
    at('start b') < at('end c') && at('start c') < at('end b'), log.join(', '));
  ok('order: the join waits for BOTH branches', at('start d') > at('end b') && at('start d') > at('end c'));
  ok('order: then the tail', at('start e') > at('end d'));
  ok('order: all ok, one attempt each', out.every((o) => o.status === 'ok' && o.attempts === 1));

  // ── 4. Retries with backoff, and blocked propagation ─────────────────────
  const sleeps: number[] = [];
  let tries = 0;
  const flaky = await P.runGraph(diamond, ['a'], {
    exec: async (id) => (id === 'b' && ++tries < 3 ? { ok: false, error: 'timeout' } : { ok: true }),
    policy: { retries: 2, backoffMs: 1000 }, sleep: async (ms) => { sleeps.push(ms); },
  });
  const st = (os: typeof flaky, id: string): any => os.find((o) => o.nodeId === id);
  ok('retry: a step that fails twice then works is ok after 3 attempts', st(flaky, 'b').status === 'ok' && st(flaky, 'b').attempts === 3);
  ok('retry: the backoff doubles — 1s then 2s', JSON.stringify(sleeps) === '[1000,2000]', JSON.stringify(sleeps));
  ok('retry: downstream still runs once it recovers', st(flaky, 'd').status === 'ok' && st(flaky, 'e').status === 'ok');

  sleeps.length = 0;
  const ran: string[] = [];
  const broken = await P.runGraph(diamond, ['a'], {
    exec: async (id) => { ran.push(id); return id === 'b' ? { ok: false, error: 'source gone' } : { ok: true }; },
    policy: { retries: 1, backoffMs: 500 }, sleep: async (ms) => { sleeps.push(ms); },
  });
  ok('blocked: the failing step is failed after 1 + 1 retries', st(broken, 'b').status === 'failed' && st(broken, 'b').attempts === 2 && JSON.stringify(sleeps) === '[500]');
  ok('blocked: its error is kept', st(broken, 'b').result.error === 'source gone');
  ok('blocked: the parallel branch is unaffected', st(broken, 'c').status === 'ok');
  ok('blocked: the join is blocked, naming the failure', st(broken, 'd').status === 'blocked' && st(broken, 'd').blockedBy === 'b');
  ok('blocked: and so is everything after it, naming the ROOT failure', st(broken, 'e').status === 'blocked' && st(broken, 'e').blockedBy === 'b');
  ok('blocked: a blocked step never runs', !ran.includes('d') && !ran.includes('e'), ran.join(','));

  sleeps.length = 0;
  const gate = await P.runGraph(diamond, ['a'], {
    exec: async (id): Promise<Exec> => (id === 'c' ? { ok: false, retryable: false, error: '2 FAIL rules failing' } : { ok: true }),
    policy: { retries: 3, backoffMs: 1000 }, sleep: async (ms) => { sleeps.push(ms); },
  });
  ok('retry: a failure that cannot change (retryable:false) is not retried', st(gate, 'c').attempts === 1 && sleeps.length === 0);
  const thrown = await P.runGraph(diamond, ['d'], {
    exec: async (id) => { if (id === 'd') throw new Error('boom'); return { ok: true }; },
    policy: { retries: 0, backoffMs: 1000 }, sleep: async () => undefined,
  });
  ok('retry: a thrown step is a failed attempt, never a rejected run', st(thrown, 'd').status === 'failed' && st(thrown, 'd').result.error === 'boom' && st(thrown, 'e').status === 'blocked');
  const paused = await P.runGraph(diamond, ['a'], {
    exec: async () => ({ ok: true }), policy: { retries: 0, backoffMs: 1000 }, sleep: async () => undefined, paused: new Set(['b']),
  });
  ok('pause: a paused step is stepped over, and what follows still runs', st(paused, 'b').status === 'paused' && st(paused, 'b').attempts === 0 && st(paused, 'd').status === 'ok');

  // ── 5. Policy whitelist ──────────────────────────────────────────────────
  ok('policy: retries clamp to 0–3', P.sanitizePolicy({ retries: 9 }).retries === 3 && P.sanitizePolicy({ retries: -2 }).retries === 0 && P.sanitizePolicy({}).retries === 0);
  ok('policy: backoff is at least a second', P.sanitizePolicy({ backoffMs: 5 }).backoffMs === 1000 && P.backoffFor({ retries: 3, backoffMs: 1000 }, 3) === 4000);
}

main().then(finish, (err) => { console.error('FAIL (threw)', err); process.exit(1); });
