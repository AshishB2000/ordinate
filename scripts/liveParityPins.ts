// The NAMED divergences between a live answer and the extract's — each one a
// test that shows it, exactly, so it can never widen unnoticed and never hide
// inside a loosened comparison. Helper for scripts/test-liveParity.ts, and run
// again on every real engine (L2.8): each pin's twin table is loaded through
// the engine under test, so a pin that holds on DuckDB is re-proved on Postgres,
// ClickHouse, Snowflake and BigQuery — or fails there, naming the engine.
//
//   1. Ties AT the 50 cut: extract keeps the first-seen, live the smaller label.
//   2. Ties AT a top-N cut (answers): the same rule.
//   3. A split answer's top N: live ranks a category by its TOTAL, the extract
//      by the first series' value (`answers.ranked` reads series[0]).
//   4. sum over a text column: live REFUSES; the extract draws nulls.
//   5. JS whitespace past sqlGen.WS_CLASS (U+3000, U+2028…): live agrees with the
//      JS reference; the RESIDENT extract path does not (a resident-layer gap,
//      reported, not live's).
//   6. Text ordering filters on astral characters: DuckDB orders UTF-8 bytes, JS
//      UTF-16 units — live and the resident path agree, the JS fold differs
//      (inherited, residentQuery.ts header).
//   7. A TIMESTAMP-held date: buckets and periods agree; a text comparison does
//      not (live compares the day, the extract the stored timestamp text).
//   8. −0: a warehouse can return it, an extract never stores it; live reports 0.

import type { FilterStep } from '../src/data/transforms';
import type { LiveIR } from '../src/engine/live/liveSpec';
import type { CompileEnv } from '../src/engine/live/compile';
import type { LiveOutcome } from '../src/engine/live/evaluate';
import type { ParityEngine, Store } from './liveParityFixture';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const dashIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const metricValue: typeof import('../src/analysis/metricValue') = require('../src/analysis/metricValue');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');

type Ok = (label: string, cond: boolean, extra?: unknown) => void;
type Live = (ir: LiveIR, env: CompileEnv) => Promise<LiveOutcome>;
type Cell = string | number | null;

const show = (v: unknown): string => JSON.stringify(v);

interface Ctx {
  pid: string;
  ok: Ok;
  live: Live;
  env: CompileEnv;
  stored: { columns: import('../src/data/parse').ParsedColumn[]; rows: Cell[][] };
  /** Where the twins are loaded and the live side runs. */
  engine: ParityEngine;
}

/** A small extract (typed as an import types it) + its warehouse twin, loaded through the engine under test. */
async function twin(c: Ctx, name: string, columns: import('../src/engine/live/liveSpec').LiveColumn[], rows: Cell[][], stores: Record<string, Store> = {}):
  Promise<{ did: string; env: CompileEnv }> {
  const ds = await datasets.saveDataset(c.pid, { name, sourceKind: 'csv', ...fx.importTyped(columns, rows) });
  if (!ds) throw new Error(`could not save ${name}`);
  const stored = columns.map((x) => ({ name: x.name, store: stores[x.name] ?? (x.type === 'number' ? 'float' : x.type === 'date' ? 'date' : 'text') as Store }));
  const source = await c.engine.load(name, stored, rows);
  return { did: ds.id, env: fx.env(source, mx.declared(c.engine, stored, columns), c.engine.dialect) };
}

async function liveChart(c: Ctx, a: ReturnType<typeof spec.fromVizEncoding>, env: CompileEnv): Promise<{ labels: string[]; values: (number | null)[] } | null> {
  if (!a.ok) return null;
  const out = await c.live(a.ir, env);
  if (!out.ok || out.kind !== 'chart') return null;
  return { labels: out.chart.data.labels, values: out.chart.data.series[0].values };
}

export async function run(c: Ctx): Promise<void> {
  const ok: Ok = (label, cond, extra) => c.ok(c.engine.name === 'duckdb' ? label : `${c.engine.name}: ${label}`, cond, extra);

  // 1 + 2. Ties at a cut. 51 categories, one row each, seen in REVERSE label order.
  const tieRows: Cell[][] = [];
  for (let i = 50; i >= 0; i -= 1) tieRows.push([`t${String(i).padStart(2, '0')}`, 1]);
  const ties = await twin(c, 'pin_ties', [{ name: 'k', type: 'text' }, { name: 'v', type: 'number' }], tieRows);
  const enc = { category: 'k', values: [{ column: 'v', aggregation: 'sum' as const }] };
  const ext = await visualsIpc.vizDataFor(c.pid, ties.did, enc, []);
  const lv = await liveChart(c, spec.fromVizEncoding(enc, [], ties.env.columns, {}), ties.env);
  ok('PIN 1 (50-cut ties): the extract keeps the first 50 SEEN — t50…t01, folding t00',
    ext.ok && ext.data.labels.includes('t50') && !ext.data.labels.includes('t00') && ext.data.labels.includes('Other'), ext.ok ? show(ext.data.labels.slice(-3)) : '');
  ok('PIN 1 (50-cut ties): live keeps the 50 smallest LABELS — t00…t49, folding t50; "Other" is 1 on both',
    !!lv && lv.labels.includes('t00') && !lv.labels.includes('t50') && lv.values[lv.labels.indexOf('Other')] === 1, show(lv && lv.labels.slice(-3)));

  const topSpec = { datasetId: ties.did, category: 'k', measures: [{ column: 'v', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: 't', top: 1 };
  const card = await answers.computeCard(c.pid, topSpec);
  const la = spec.fromAnswerSpec(topSpec, ties.env.columns, {});
  const lo = la.ok ? await c.live(la.ir, ties.env) : null;
  ok('PIN 2 (top-N ties): the extract keeps the first-seen tied category, live the smallest label — same value',
    !('ok' in card) && show(card.card.data.labels) === '["t50"]' && !!lo && lo.ok && lo.kind === 'chart'
      && show(lo.chart.data.labels) === '["Other"]' && lo.chart.data.series[0].values[0] === 1,
    show([!('ok' in card) && card.card.data.labels, lo && lo.ok && lo.kind === 'chart' && lo.chart.data.labels]));

  // 3. A split answer's top N ranks a category by its total on live.
  const sr = await twin(c, 'pin_splitrank', [{ name: 'k', type: 'text' }, { name: 's', type: 'text' }, { name: 'v', type: 'number' }],
    [['A', 's1', 1], ['B', 's1', 2], ['A', 's2', 10]]);
  const srSpec = { datasetId: sr.did, category: 'k', series: 's', measures: [{ column: 'v', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: 't', top: 1 };
  const srCard = await answers.computeCard(c.pid, srSpec);
  const srA = spec.fromAnswerSpec(srSpec, sr.env.columns, {});
  const srOut = srA.ok ? await c.live(srA.ir, sr.env) : null;
  ok('PIN 3 (split + top N): the extract ranks by the first series (B: s1 = 2), live by the total (A: 11)',
    !('ok' in srCard) && show(srCard.card.data.labels) === '["B"]' && !!srOut && srOut.ok && srOut.kind === 'chart' && show(srOut.chart.data.labels) === '["A"]');

  // 4. sum over text.
  const sumText = spec.fromVizEncoding({ category: 'region', values: [{ column: 'cat', aggregation: 'sum' }] }, [], c.env.columns, {});
  ok('PIN 4 (sum over text): live refuses, typed and in a catalog sentence',
    !sumText.ok && sumText.code === 'notNumeric' && sumText.message.includes('"cat"'));

  // 5. JS whitespace beyond the resident class.
  const wsRows: Cell[][] = ['\u3000', '\u2028', '\u1680', '\u202f', 'x', ' ', null].map((w) => ['all', w]);
  const ws = await twin(c, 'pin_ws', [{ name: 'g', type: 'text' }, { name: 'w', type: 'text' }], wsRows);
  const wsStored = await datasets.getDataset(c.pid, ws.did);
  const reference = metricValue.computeMetric(wsStored!.columns, wsStored!.rows, { column: 'w', aggregation: 'count' });
  const fm = spec.fromMetric({ column: 'w', aggregation: 'count' }, [], ws.env.columns, {});
  const wsLive = fm.ok ? await c.live(fm.ir, ws.env) : null;
  ok('PIN 5 (JS whitespace): live counts U+3000/U+2028/U+1680/U+202F as empty, like the JS reference (1)',
    reference === 1 && !!wsLive && wsLive.ok && wsLive.kind === 'metric' && wsLive.value === 1, show([reference, wsLive]));
  // A chart takes the resident path at any size (a KPI only past 1,000 rows).
  const resident = await visualsIpc.vizDataFor(c.pid, ws.did, { category: 'g', values: [{ column: 'w', aggregation: 'count' }] }, []);
  ok('PIN 5 (KNOWN resident gap — when this fails, sqlGen.WS_CLASS was fixed: delete this pin): the resident chart counts them',
    resident.ok && resident.data.series[0].values[0] === 5, show(resident.ok && resident.data));

  // 6. Astral characters under a text ORDERING filter.
  const gtF: FilterStep[] = [{ type: 'filter', column: 'cat', op: '>', value: '\ufffd' }];
  const astralEnc = { category: 'cat', values: [{ column: 'amt', aggregation: 'count' as const }] };
  const jsRef = vizData.buildVizData(c.stored.columns, c.stored.rows, astralEnc, gtF);
  const astralLive = await liveChart(c, spec.fromVizEncoding(astralEnc, gtF, c.env.columns, {}), c.env);
  ok('PIN 6 (astral order): `cat > U+FFFD` keeps 😀 on live (UTF-8 bytes) and nothing in the JS fold (UTF-16 units)',
    jsRef.data.labels.length === 0 && !!astralLive && show(astralLive.labels) === '["😀"]', show([jsRef.data.labels, astralLive]));

  // 7. A date the warehouse holds as a TIMESTAMP, the extract as its UTC ISO text.
  const tsRows: Cell[][] = [['2024-01-05T10:00:00.000Z', 1], ['2024-01-05T23:30:00.000Z', 2], ['2024-02-01T00:00:00.000Z', 4]];
  const ts = await twin(c, 'pin_ts', [{ name: 't', type: 'date' }, { name: 'v', type: 'number' }], tsRows, { t: 'timestamp' });
  const tsEnc = { category: 't', grain: 'month' as const, values: [{ column: 'v', aggregation: 'sum' as const }] };
  const tsExt = await visualsIpc.vizDataFor(c.pid, ts.did, tsEnc, []);
  const tsLive = await liveChart(c, spec.fromVizEncoding(tsEnc, [], ts.env.columns, {}), ts.env);
  ok('PIN 7 (timestamps): month buckets agree', tsExt.ok && !!tsLive && show(tsExt.data.labels) === show(tsLive.labels)
    && show(tsExt.data.series[0].values) === show(tsLive.values), show([tsExt.ok && tsExt.data, tsLive]));
  const eqF: FilterStep[] = [{ type: 'filter', column: 't', op: '=', value: '2024-01-05' }];
  const tsEq = await dashIpc.computeCardMetric(c.pid, ts.did, { column: 'v', aggregation: 'sum' }, eqF);
  const tsEqA = spec.fromMetric({ column: 'v', aggregation: 'sum' }, eqF, ts.env.columns, {});
  const tsEqL = tsEqA.ok ? await c.live(tsEqA.ir, ts.env) : null;
  ok('PIN 7 (timestamps): `= 2024-01-05` matches the DAY on live (3), the stored text on the extract (nothing)',
    tsEq.value === null && !!tsEqL && tsEqL.ok && tsEqL.kind === 'metric' && tsEqL.value === 3, show([tsEq.value, tsEqL]));

  // 8. −0 from the warehouse.
  const zeroF: FilterStep[] = [{ type: 'filter', column: 'amt', op: '=', value: 0 }];
  for (const aggregation of ['min', 'max', 'sum'] as const) {
    const zA = spec.fromMetric({ column: 'amt', aggregation }, zeroF, c.env.columns, {});
    const z = zA.ok ? await c.live(zA.ir, c.env) : null;
    ok(`PIN 8 (−0): ${aggregation} over the −0 cells is +0 on live, as the extract stores it`,
      !!z && z.ok && z.kind === 'metric' && Object.is(z.value, 0), show(z));
  }
}
