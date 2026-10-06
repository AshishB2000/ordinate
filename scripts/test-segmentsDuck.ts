// Find segments and RFM against DuckDB — every comparison with Object.is.
//
//   1. the step    the JS fold (the reference) against runOnDuckDb and the
//                  resident pipeline: labels, types, warnings, row counts,
//                  ties, skips, a bail after a column typed from data
//   2. the reader  engine/segmentResident against segmentModel.jsSegmentIo:
//                  stats, the stride sample, the all-row summary, and the
//                  whole fit — on a small table and on 60,000 rows (ordered
//                  sums keep it exact past one vector)
//   3. RFM         rfmCustomersResident against rfmCustomersJs
//   4. handlers    segments:features / fit / rfm through the SHIPPED IPC with
//                  a hydration spy (the resident path never reads the table),
//                  saveColumn reproducing the fit's labels on every row, the
//                  compute-worker op, rfmSave writing an ordinary dataset
//
//   npm run build:ts && node scripts/test-segmentsDuck.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Cell, TableData, TransformStep } from '../src/data/transforms';
import type { ParsedColumn } from '../src/data/parse';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-segments-'));
// Handlers land in the RPC registry (src/ipc/bus.ts).
const handlers: Map<string, IpcHandler> = require('../src/server/rpc').handlers;
process.env.ORDINATE_LOCAL_DIR = tmp;
process.env.ORDINATE_COMPUTE_INLINE = '1'; // section 4 turns it off once to prove the worker op

const { applyPipeline }: typeof import('../src/data/transforms') = require('../src/data/transforms');
const { runOnDuckDb, runResidentPipeline }: typeof import('../src/engine/pipelineDuck') = require('../src/engine/pipelineDuck');
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const model: typeof import('../src/analysis/segmentModel') = require('../src/analysis/segmentModel');
const math: typeof import('../src/analysis/segmentMath') = require('../src/analysis/segmentMath');
const resident: typeof import('../src/engine/segmentResident') = require('../src/engine/segmentResident');
const rfm: typeof import('../src/analysis/rfm') = require('../src/analysis/rfm');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const computePool: typeof import('../src/engine/computePool') = require('../src/engine/computePool');
const segmentsIpc: typeof import('../src/ipc/segments') = require('../src/ipc/segments');

const N = (name: string): ParsedColumn => ({ name, type: 'number' });
const X = (name: string): ParsedColumn => ({ name, type: 'text' });

/** Deep equality where every leaf is compared with Object.is. */
function same(a: unknown, b: unknown, at = '$'): string | null {
  if (typeof a === 'number' || typeof b === 'number' || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return Object.is(a, b) ? null : `${at}: ${String(a)} vs ${String(b)}`;
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.join(',') !== kb.join(',')) return `${at}: keys ${ka.join(',')} vs ${kb.join(',')}`;
  for (const k of ka) {
    const d = same((a as any)[k], (b as any)[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

let staged = 0;
function stage(t: TableData): { file: string; rows: Cell[][] } {
  const file = path.join(tmp, `t${staged++}.parquet`);
  pqSync.writeTable(file, t.columns, t.rows);
  const back = pqSync.readTable(file, t.columns);
  return { file, rows: back ? back.rows : [] };
}

/** A table with three measures, a text tag, nulls, a non-number and a tie-maker. */
function fixture(n: number, seed: number): TableData {
  const rng = math.mulberry32(seed);
  const rows: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const g = i % 3;
    const revenue = Math.round((g * 40 + rng() * 10) * 100) / 100;
    const discount = g === 1 ? rng() / 10 : rng() / 3;
    const units = Math.floor(rng() * 20) - (g === 2 ? 30 : 0);
    rows.push([i % 17 === 0 ? null : revenue, discount, units, `t${g}`]);
  }
  return { columns: [N('revenue'), N('discount'), N('units'), X('tag')], rows };
}

async function main(): Promise<void> {
  // ── 1. the step ───────────────────────────────────────────────────────────
  const small = fixture(90, 11);
  const fit = await model.runFit(small.columns, ['revenue', 'discount', 'units'], model.jsSegmentIo(small.columns, small.rows));
  ok('fixture fit ran', !!fit && !('error' in fit), JSON.stringify(fit).slice(0, 200));
  if (!fit || 'error' in fit) return;
  const step = fit.step;
  const compare = (label: string, sql: ReturnType<typeof applyPipeline> | null, js: ReturnType<typeof applyPipeline>): void => {
    ok(`${label}: the SQL path ran`, sql !== null);
    if (!sql) return;
    const d = same({ columns: js.columns, rows: js.rows, warnings: js.warnings, counts: js.stepCounts }, { columns: sql.columns, rows: sql.rows, warnings: sql.warnings, counts: sql.stepCounts });
    ok(`${label}: columns, every cell, warnings and counts agree`, d === null, d);
  };
  const both = async (label: string, steps: TransformStep[], t: TableData = small): Promise<void> => {
    const js = applyPipeline(t, steps);
    compare(`${label} (in memory)`, await runOnDuckDb(t, steps, { force: true }), js);
    const { file } = stage(t);
    compare(`${label} (resident)`, await runResidentPipeline(file, t.columns, steps), js);
  };
  await both('segment step', [step]);
  await both('after a rename and a filter', [{ type: 'rename_column', from: 'tag', to: 'kind' }, { type: 'filter', column: 'units', op: '>', value: -25 }, step]);
  await both('an unknown feature skips with the fold’s warning', [{ ...step, features: ['revenue', 'discount', 'gone'] }]);
  await both('a taken column name skips', [{ ...step, column: 'tag' }]);
  await both('a text feature skips', [{ ...step, features: ['revenue', 'discount', 'tag'] }]);
  const ties: TransformStep = { ...step, centroids: [step.centroids[0], step.centroids[0], ...step.centroids.slice(2)] };
  await both('duplicate centroids: the lowest index wins in both', [ties]);
  const huge: TransformStep = { ...step, means: [1e20, -3.5e-7, 12], stds: [2e19, 1e-9, 0.1] };
  await both('extreme means and stds bind exactly', [huge]);
  const oddRows: TableData = { columns: small.columns, rows: [[0, 0, 0, 'a'], [-0.0000001, 1e-12, 5, 'b'], ['x', 1, 2, 'c'], [3, null, 1, 'd'], [2.5, 0.25, -7, ''], [1e15, 0.5, 3, null]] as Cell[][] };
  await both('zeros, a string in a number column, tiny and large values', [step], oddRows);
  ok('a feature typed from data declines to the fold, never a guess',
    await runOnDuckDb(small, [{ type: 'fill_empty', column: 'revenue', value: 0 }, step], { force: true }) === null);

  // ── 2. the reader ─────────────────────────────────────────────────────────
  const readers = async (label: string, t: TableData, features: string[], cap: number): Promise<void> => {
    const { file, rows } = stage(t);
    const js = model.jsSegmentIo(t.columns, rows);
    const res = resident.residentSegmentIo({ parquetPath: file, columns: t.columns });
    const idx = features.map((f) => t.columns.findIndex((c) => c.name === f));
    const a = js.stats(idx);
    const b = await res.stats(idx);
    ok(`${label}: stats agree (count, means, stds)`, !!b && same(a, b) === null, same(a, b));
    const sa = js.sample(idx, a!.count, cap);
    const sb = await res.sample(idx, a!.count, cap);
    ok(`${label}: the stride sample agrees row for row`, !!sb && sa!.length === Math.min(cap, a!.count) && same(sa, sb) === null, same(sa, sb));
    const fj = await model.runFit(t.columns, features, js);
    const fr = await model.runFit(t.columns, features, res);
    ok(`${label}: the whole fit agrees`, !!fr && same(fj, fr) === null, same(fj, fr));
    if (fj && !('error' in fj)) {
      const ua = js.summary(fj.step);
      const ub = await res.summary(fj.step);
      ok(`${label}: the all-row summary agrees`, !!ub && same(ua, ub) === null, same(ua, ub));
    }
  };
  await readers('small', small, ['revenue', 'discount', 'units'], 25);
  await readers('60,000 rows', fixture(60_000, 5), ['revenue', 'units'], 7_000);

  // ── 3. RFM ────────────────────────────────────────────────────────────────
  const rfmTable = (n: number, seed: number): TableData => {
    const rng = math.mulberry32(seed);
    const shapes = (d: number): string => {
      const iso = new Date(Date.UTC(2023, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
      const [y, m, dd] = iso.split('-');
      return d % 11 === 0 ? `${m}/${dd}/${y}` : d % 13 === 0 ? `${iso} 13:05` : d % 37 === 0 ? `${y}-02-30` : iso;
    };
    const rows: Cell[][] = [];
    for (let i = 0; i < n; i++) {
      const c = Math.floor(rng() * Math.max(3, n / 12));
      const id = i % 29 === 0 ? '  ' : i % 31 === 0 ? null : c === 7 ? '007' : c === 8 ? '7' : `C${c}`;
      rows.push([id, shapes(Math.floor(rng() * 700)), i % 23 === 0 ? null : Math.round(rng() * 50_000) / 100]);
    }
    return { columns: [X('customer'), { name: 'day', type: 'date' }, N('amount')], rows };
  };
  for (const [label, t] of [['RFM small', rfmTable(200, 3)], ['RFM 40,000 rows', rfmTable(40_000, 9)]] as Array<[string, TableData]>) {
    const { file, rows } = stage(t);
    const spec = { id: 'customer', date: 'day', amount: 'amount' };
    const a = rfm.rfmCustomersJs({ columns: t.columns, rows }, spec);
    const b = await resident.rfmCustomersResident({ parquetPath: file, columns: t.columns }, spec);
    ok(`${label}: per-customer aggregates agree (ids, last day, frequency, monetary)`, !!b && same(a, b) === null, same(a, b));
    if (rows.length > 1000) ok(`${label}: '007' and '7' stay two customers`, a.customers.filter((c) => c.id === '007' || c.id === '7').length === 2);
  }

  // ── 4. the shipped handlers ───────────────────────────────────────────────
  segmentsIpc.register();
  const proj = await projects.createProject('Segments');
  const big = fixture(3_000, 21);
  const rec = await datasets.saveDataset(proj.id, { name: 'Orders', sourceKind: 'csv', columns: big.columns, rows: big.rows });
  ok('handler fixture saved', !!rec);
  if (!rec) return;
  const call = (ch: string, payload: unknown) => (handlers.get(ch) as IpcHandler)(null, payload);

  const realGet = datasets.getDataset;
  let hydrations = 0;
  (datasets as any).getDataset = async (...args: any[]): Promise<any> => { hydrations += 1; return (realGet as any)(...args); };
  trace.reset();

  const feats = await call('segments:features', { projectId: proj.id, datasetId: rec.id });
  ok('segments:features: every number column, all three ticked', feats.ok && feats.features.map((f: any) => `${f.name}:${f.checked}`).join(',') === 'revenue:true,discount:true,units:true', JSON.stringify(feats.features));
  ok('segments:features: RFM defaults guessed', feats.rfm && feats.rfm.amount === 'revenue', JSON.stringify(feats.rfm));
  const got = await call('segments:fit', { projectId: proj.id, datasetId: rec.id, features: ['revenue', 'discount', 'units'] });
  ok('segments:fit answers { ok, result }', got.ok === true && got.result && got.result.k >= 2, JSON.stringify(got).slice(0, 200));
  ok('segments:features + fit: the table was NEVER hydrated', hydrations === 0, String(hydrations));
  const snap = trace.snapshot();
  ok('the fit was answered by the resident path', (snap.segmentFit?.resident || 0) === 1 && (snap.segmentFit?.failed || 0) === 0, JSON.stringify(snap.segmentFit));
  const ds = await realGet(proj.id, rec.id);
  const ref = await model.runFit(ds!.columns, ['revenue', 'discount', 'units'], model.jsSegmentIo(ds!.columns, ds!.rows));
  ok('segments:fit equals the JS reference over the hydrated table', same(got.result, ref) === null, same(got.result, ref));
  const job = jobs.snapshot().recent.find((j) => j.kind === 'analysis');
  ok('the fit ran as an "analysis" job and finished', !!job && job.state === 'done' && /Find segments/.test(job.label), JSON.stringify(job));
  const badFit = await call('segments:fit', { projectId: proj.id, datasetId: rec.id, features: ['revenue', 'tag'] });
  ok('segments:fit refuses a text feature', badFit.ok === false && /not a number column/.test(badFit.error));

  hydrations = 0;
  const scored = await call('segments:rfm', { projectId: proj.id, datasetId: rec.id, spec: { id: 'tag', date: 'revenue', amount: 'units' } });
  ok('segments:rfm: no readable dates is an answer, not a crash', scored.ok === false && /No row/.test(scored.error), JSON.stringify(scored));
  ok('segments:rfm: resident, never hydrated', hydrations === 0);

  (datasets as any).getDataset = realGet;

  // The worker op: the same fit off the main thread.
  delete process.env.ORDINATE_COMPUTE_INLINE;
  const viaWorker = await segmentsIpc.fitDataset(proj.id, rec.id, ['revenue', 'discount', 'units']);
  process.env.ORDINATE_COMPUTE_INLINE = '1';
  ok('the compute-worker op returns the identical fit', same(viaWorker, got.result) === null, same(viaWorker, got.result));
  await computePool.shutdown();

  // Save as column: a Prepare step whose output IS the fit's assignment.
  const saved = await call('segments:saveColumn', { projectId: proj.id, datasetId: rec.id, step: { ...got.result.step, column: 'segment' } });
  ok('segments:saveColumn adds the step', saved.ok === true && saved.column === 'segment' && saved.steps === 1, JSON.stringify(saved));
  const after = await realGet(proj.id, rec.id);
  const col = after ? after.columns.findIndex((c) => c.name === 'segment') : -1;
  ok('the column is an ordinary text dimension', col >= 0 && after!.columns[col].type === 'text');
  const counts = got.result.names.map((n: string) => after!.rows.filter((r) => r[col] === n).length);
  ok('every row holds its segment: the counts are the fit’s sizes', counts.join(',') === got.result.sizes.join(','), `${counts} vs ${got.result.sizes}`);
  ok('rows without a value hold an empty cell', after!.rows.filter((r) => r[col] === null).length === got.result.empty && got.result.empty === 177, String(got.result.empty));
  const sample = model.jsSegmentIo(ds!.columns, ds!.rows);
  const st = sample.stats([0, 1, 2])!;
  const core = model.fitCore(sample.sample([0, 1, 2], st.count, model.SAMPLE_CAP)!, st);
  const labelled = after!.rows.filter((r) => r[col] !== null).map((r) => r[col]);
  ok('the stored step reproduces the fit’s own labels, row for row',
    !('error' in core) && labelled.every((v, i) => v === got.result.names[core.labels[i]]));
  const again = await call('segments:saveColumn', { projectId: proj.id, datasetId: rec.id, step: { ...got.result.step, column: 'segment' } });
  ok('saving the same column twice is refused', again.ok === false && /already a column/.test(again.error));
  const forged = await call('segments:saveColumn', { projectId: proj.id, datasetId: rec.id, step: { ...got.result.step, column: 's2', stds: [0, 1, 1] } });
  ok('a forged model is refused', forged.ok === false);

  // RFM on a customer table, then Save as dataset.
  const cust = rfmTable(600, 4);
  const crec = await datasets.saveDataset(proj.id, { name: 'Customer orders', sourceKind: 'csv', columns: cust.columns, rows: cust.rows });
  const spec = { id: 'customer', date: 'day', amount: 'amount' };
  const r = await call('segments:rfm', { projectId: proj.id, datasetId: crec!.id, spec });
  const cds = await realGet(proj.id, crec!.id);
  const want = rfm.rfmBreakdown(rfm.rfmCustomersJs(cds!, spec));
  ok('segments:rfm equals the JS reference', r.ok && same(r.result, want) === null, same(r.result, want));
  ok('segments:rfm: eleven rows', r.ok && r.result.segments.length === 11);
  const out = await call('segments:rfmSave', { projectId: proj.id, datasetId: crec!.id, spec });
  const made = out.ok ? await realGet(proj.id, out.dataset.id) : null;
  ok('segments:rfmSave writes an ordinary dataset, one row per customer',
    !!made && made.rowCount === want.customers && made.columns.map((c) => c.name).join(',') === 'customer,recency,frequency,monetary,r,f,m,rfm_segment', JSON.stringify(out));
  ok('the saved segments match the breakdown',
    !!made && want.segments.every((s) => made.rows.filter((row) => row[7] === s.name).length === s.count));
}

void main()
  .catch((err) => { ok('unexpected error', false, err && err.stack ? err.stack : err); })
  .then(() => {
    duck.shutdown();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
    finish();
  });
