// The compute worker (src/engine/computeWorker.ts + computePool.ts): jobs run
// their CPU and DuckDB work OFF the main thread.
//
// Proves, in order:
//   1. nothing the worker loads reaches src/server/context or a handler module
//      (a worker thread has no request context);
//   2. the main thread keeps turning while an op burns CPU in the worker;
//   3. progress arrives, and Cancel terminates the op (and only that op);
//   4. DIFFERENTIAL: the worker's insights and quality answers are identical
//      (Object.is on every figure) to the same functions run on this thread;
//   5. the parse op returns what parseFile returns.
//
//   npm run build:ts && node scripts/test-computeWorker.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pool from '../src/engine/computePool';
import * as pqSync from '../src/engine/parquetStoreSync';
import { detectAnomaliesResident } from '../src/engine/anomaliesResident';
import { detectInsights, fromAnomaly, residentAgg } from '../src/analysis/insights';
import type { Insight } from '../src/analysis/insights';
import { evaluateRulesResident } from '../src/engine/qualityResident';
import { parseFile } from '../src/data/fileImport';

const ROOT = path.resolve(__dirname, '..');

/** Every file the worker's import graph pulls in, by walking the emitted requires. */
function graph(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
    let p = path.resolve(path.dirname(file), m[1]);
    if (!p.endsWith('.js')) p += '.js';
    if (fs.existsSync(p)) graph(p, seen);
  }
  return seen;
}

void (async () => {
  // ── 1. No request context anywhere under the worker ───────────────────────
  const files = [...graph(path.join(ROOT, 'src', 'engine', 'computeWorker.js'))];
  const reached = files.filter((f) => /[\\/]src[\\/](server[\\/]context|ipc[\\/][^\\/]+)\.js$/.test(f));
  ok('worker import graph never reaches server/context or src/ipc', files.length > 5 && reached.length === 0,
    reached.map((f) => path.relative(ROOT, f)).join(', '));

  // ── 2. Off the main thread ────────────────────────────────────────────────
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  const progress: number[] = [];
  const spun = await pool.run<string>('spin', { ms: 400 }, { onProgress: (f) => progress.push(f) });
  clearInterval(timer);
  ok('a 400 ms CPU op in the worker resolves', spun === 'spun');
  ok('the main event loop kept ticking during it (≥ 15 ticks of 10 ms)', ticks >= 15, ticks);
  ok('progress arrived from the worker', progress.length > 3 && progress[progress.length - 1] > 0.5, progress.length);

  // ── 3. Cancel ────────────────────────────────────────────────────────────
  const ctl = new AbortController();
  const t0 = Date.now();
  const long = pool.run('spin', { ms: 10_000 }, { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 50);
  let cancelled = false;
  try { await long; } catch (e: any) { cancelled = e && e.name === 'JobCancelled'; }
  ok('cancel rejects with JobCancelled (the name the jobs system reads)', cancelled);
  ok('…promptly — the worker was terminated, not waited out', Date.now() - t0 < 2000, Date.now() - t0);
  const after = await pool.run<string>('spin', { ms: 10 });
  ok('the pool serves the next op after a cancel', after === 'spun');
  let unknown = '';
  try { await pool.run('rm-rf', {}); } catch (e: any) { unknown = String(e && e.message); }
  ok('an unknown op is an error, not a hang', /Unknown compute op/.test(unknown));
  const [a, b, c] = await Promise.all([pool.run('spin', { ms: 30 }), pool.run('spin', { ms: 30 }), pool.run('spin', { ms: 30 })]);
  ok('three ops at once all complete', a === 'spun' && b === 'spun' && c === 'spun');

  // ── 4. Differential: worker vs this thread, on a real Parquet file ─────────
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compute-worker-'));
  const file = path.join(dir, 'd.parquet');
  const columns = [
    { name: 'region', type: 'text' as const },
    { name: 'day', type: 'date' as const },
    { name: 'amount', type: 'number' as const },
    { name: 'units', type: 'number' as const },
  ];
  const rows: (string | number | null)[][] = [];
  for (let i = 0; i < 6000; i++) {
    const d = new Date(Date.UTC(2025, 0, 1) + (i % 180) * 86400000).toISOString().slice(0, 10);
    rows.push(['r' + (i % 5), d, i % 97 === 0 ? 5000 : (i % 50) + (i % 180 > 150 ? 40 : 0), i % 7 === 0 ? null : i % 11]);
  }
  pqSync.writeTable(file, columns, rows);
  const src = { parquetPath: file, columns };
  const inlineAnoms = await detectAnomaliesResident(src);
  const inline: Insight[] | null = inlineAnoms
    ? [...(await detectInsights('ds', columns, residentAgg(src))),
      ...inlineAnoms.map((x) => fromAnomaly('ds', x, columns)).filter((i): i is Insight => !!i)]
    : null;
  const viaWorker = await pool.run<Insight[] | null>('insights', { datasetId: 'ds', src });
  ok('insights: the resident path answered on both threads', Array.isArray(inline) && Array.isArray(viaWorker));
  ok('insights: worker and this thread agree exactly',
    JSON.stringify(viaWorker) === JSON.stringify(inline), `${(viaWorker || []).length} vs ${(inline || []).length}`);
  const figures = (list: Insight[] | null) => (list || []).flatMap((i) => Object.values(i.facts || {}).filter((v) => typeof v === 'number'));
  const fw = figures(viaWorker);
  const fi = figures(inline);
  ok('insights: every figure is Object.is-identical', fw.length === fi.length && fw.every((v, i) => Object.is(v, fi[i])));

  const rules: any[] = [ // any: QualityRule literals, sanitized shape
    { id: 'r1', kind: 'not_null', severity: 'fail', column: 'units', args: {} },
    { id: 'r2', kind: 'range', severity: 'warn', column: 'amount', args: { min: 0, max: 100 } },
  ];
  const qInline = await evaluateRulesResident(src, rules, new Map());
  const qWorker = await pool.run('quality', { src, rules, refs: [] });
  ok('quality: the resident path answered (not a null on both sides)', Array.isArray(qInline) && qInline.length === 2, JSON.stringify(qInline));
  ok('quality: worker and this thread agree exactly', JSON.stringify(qWorker) === JSON.stringify(qInline), JSON.stringify(qWorker));

  // ── 5. Parse ─────────────────────────────────────────────────────────────
  const csv = path.join(dir, 'x.csv');
  fs.writeFileSync(csv, 'zip,amount\n007,1.5\n02134,2\n,3\n');
  const direct = await parseFile(csv, 'csv');
  const worker = await pool.run('parse', { filePath: csv, kind: 'csv' });
  ok('parse: the worker parses exactly what parseFile parses (007 stays text)',
    JSON.stringify(worker) === JSON.stringify(direct) && direct.rows[0][0] === '007');

  await pool.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  finish();
})().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
