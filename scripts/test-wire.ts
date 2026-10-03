// Differential self-check for src/server/wire.ts, the RPC wire codec.
//
// Under Electron a handler's reply crossed IPC by structured clone; over HTTP it
// crosses as wire.ts's tagged JSON. The reference is therefore
// `structuredClone(x)`, and every assertion is `same(structuredClone(x),
// decode(encode(x)))` — never a hand-written expectation. `same` walks both
// values and compares, at EVERY node: typeof, prototype, array holes, key ORDER,
// Map/Set entry order, and every leaf with Object.is (so NaN ≡ NaN, -0 ≢ 0).
//
// Inputs: a fixture set aimed at what JSON loses or a tag could forge, and the
// REAL outputs of the chart, KPI, metric, stats and anomaly handlers over the
// bundled sample project.
//
//   npm run build:ts && node scripts/test-wire.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // any: the loader hook has no public type

const REPO = path.resolve(__dirname, '..');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-wire-'));
// The stub goes in before anything reads app paths (house pattern, see
// test-sampleProject.ts). Handlers land in the RPC registry, not the stub.
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') {
    return {
      app: { getPath: () => tmpUserData, getAppPath: () => REPO, getVersion: () => '0.0.0-test' },
      net: {}, dialog: {}, shell: {}, nativeImage: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const wire: typeof import('../src/server/wire') = require('../src/server/wire');
// any: IPC replies are untyped JSON-ish trees; `same` inspects them structurally.
const handlers: Map<string, (e: unknown, p?: unknown) => Promise<any>> = require('../src/server/rpc').handlers;

/** The first path where a and b differ, or null when they are the same value. */
function diff(a: unknown, b: unknown, at = '$'): string | null {
  if (typeof a !== typeof b) return `${at}: typeof ${typeof a} vs ${typeof b}`;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return Object.is(a, b) ? null : `${at}: ${String(a)} vs ${String(b)}`;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
    return `${at}: prototype ${Object.prototype.toString.call(a)}/${a.constructor?.name} vs ${Object.prototype.toString.call(b)}/${b.constructor?.name}`;
  }
  if (a instanceof Date) return Object.is(a.getTime(), (b as Date).getTime()) ? null : `${at}: date ${a.getTime()} vs ${(b as Date).getTime()}`;
  if (a instanceof Uint8Array) {
    const y = b as Uint8Array;
    if (a.length !== y.length) return `${at}: byte length ${a.length} vs ${y.length}`;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== y[i]) return `${at}[${i}]: byte ${a[i]} vs ${y[i]}`;
    return null;
  }
  if (a instanceof Map || a instanceof Set) {
    const ea = [...(a as Map<unknown, unknown>).entries()];
    const eb = [...(b as Map<unknown, unknown>).entries()];
    if (ea.length !== eb.length) return `${at}: size ${ea.length} vs ${eb.length}`;
    for (let i = 0; i < ea.length; i += 1) {
      const d = diff(ea[i][0], eb[i][0], `${at}<key ${i}>`) ?? diff(ea[i][1], eb[i][1], `${at}<value ${i}>`);
      if (d) return d;
    }
    return null;
  }
  if (Array.isArray(a)) {
    const y = b as unknown[];
    if (a.length !== y.length) return `${at}: length ${a.length} vs ${y.length}`;
    for (let i = 0; i < a.length; i += 1) {
      if (i in a !== i in y) return `${at}[${i}]: hole vs value`;
      const d = diff(a[i], y[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.join('\u0000') !== kb.join('\u0000')) return `${at}: keys [${ka.join(',')}] vs [${kb.join(',')}]`;
  for (const k of ka) {
    const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

/** An array of `length` with only `at`'s indexes set — holes everywhere else. */
function holes(length: number, at: Record<number, unknown>): unknown[] {
  const a = new Array<unknown>(length);
  for (const [i, v] of Object.entries(at)) a[Number(i)] = v;
  return a;
}

/** The differential assertion: the codec gives what structured clone gave. */
function roundTrips(label: string, x: unknown): void {
  let d: string | null;
  try {
    d = diff(structuredClone(x), wire.decode(wire.encode(x)));
  } catch (err) {
    d = `threw ${String(err)}`;
  }
  ok(`round-trips like structuredClone: ${label}`, d === null, d);
}

function refuses(label: string, x: unknown): void {
  let threw = false;
  try { wire.encode(x); } catch (err) { threw = err instanceof TypeError; }
  ok(`encode refuses (TypeError): ${label}`, threw);
}

// ── The walker itself must catch what it claims to ───────────────────────────
// Negative controls: if `diff` were too lenient every round-trip below would pass vacuously.
ok('walker: NaN ≡ NaN', diff(NaN, NaN) === null);
ok('walker: -0 ≢ 0', diff(-0, 0) !== null);
ok('walker: null ≢ NaN (what plain JSON does)', diff(NaN, JSON.parse(JSON.stringify(NaN))) !== null);
ok('walker: hole ≢ undefined', diff(holes(2, { 1: 1 }), [undefined, 1]) !== null);
ok('walker: key order matters', diff({ a: 1, b: 2 }, { b: 2, a: 1 }) !== null);
ok('walker: Buffer ≢ Uint8Array (prototype)', diff(Buffer.from([1]), new Uint8Array([1])) !== null);
ok('walker: Map entry order matters', diff(new Map([[1, 1], [2, 2]]), new Map([[2, 2], [1, 1]])) !== null);
ok('walker: Date by time', diff(new Date(5), new Date(6)) !== null && diff(new Date(NaN), new Date(NaN)) === null);

// ── Buffer: what structured clone gives, and what we give ────────────────────
// structuredClone(Buffer) is a plain Uint8Array (Buffer's prototype does not
// survive the clone — Electron IPC behaves the same), so that is the contract.
ok('reference: structuredClone(Buffer) is a plain Uint8Array',
  Object.getPrototypeOf(structuredClone(Buffer.from('hi'))) === Uint8Array.prototype);
ok('codec: a Buffer decodes as a plain Uint8Array',
  Object.getPrototypeOf(wire.decode(wire.encode(Buffer.from('hi')))) === Uint8Array.prototype);

// ── Fixtures ──────────────────────────────────────────────────────────────────
class Point { constructor(public x: number, public y: number) {} get len(): number { return Math.hypot(this.x, this.y); } }
const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
const big = new Uint8Array(200_000).map((_, i) => (i * 7) % 256); // past one fromCharCode chunk

const fixtures: [string, unknown][] = [
  ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['-0', -0], ['0', 0],
  ['max/min doubles', [Number.MAX_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE, 0.1 + 0.2, 1e-320]],
  ['undefined at top level', undefined], ['null', null], ['true', true], ['empty string', ''],
  ['undefined in an array', [undefined, 1, undefined]],
  ['undefined as an object value', { a: undefined, b: 1 }],
  ['array holes', holes(5, { 1: 1, 3: 3 })],
  ['empty array / object', [[], {}]],
  ['Date', new Date('2026-10-02T12:34:56.789Z')], ['Invalid Date', new Date(NaN)],
  ['Map with mixed keys', new Map<unknown, unknown>([[NaN, 'nan key'], [-0, 'minus zero'], [{ k: 1 }, [1, 2]], ['s', undefined]])],
  ['Set', new Set<unknown>([1, 'a', NaN, undefined, null, { x: -0 }])],
  ['Uint8Array', new Uint8Array([0, 1, 127, 128, 255])], ['empty Uint8Array', new Uint8Array(0)],
  ['200 KB Uint8Array', big],
  ['Buffer', Buffer.from('héllo wörld')],
  ['BigInt', [0n, -1n, 2n ** 64n, -(10n ** 30n)]],
  ['figures with NaN inside a chart reply', { ok: true, data: { labels: ['a', 'b'], series: [{ name: 'v', values: [1.5, NaN, -0, Infinity] }] } }],
  ['nested everything', { m: new Map([['d', new Date(0)]]), s: new Set([new Uint8Array([9])]), n: [[[NaN]]], b: 1n }],
  ['a plain object that looks like a tag', { $: 'NaN' }],
  ['a plain object that looks like an escape', { $: 'O', v: { $: 'u' } }],
  ['a plain object with "$" among other keys', { a: 1, $: 'D', v: 5 }],
  ['tag-looking objects inside a Map and an array', [new Map([[{ $: 'h' }, { $: 'Inf' }]]), { $: 'h' }]],
  ['strings that look like tags', ['{"$":"NaN"}', '$', 'NaN', 'Infinity']],
  ['an own "__proto__" key', JSON.parse('{"__proto__": {"polluted": 1}, "a": 1}')],
  ['integer-like keys (order rules)', { b: 1, 2: 'two', a: 2, 1: 'one' }],
  ['unicode, including a lone surrogate', ['é', '😀', '\uD800', '\u0000', ' ']],
  ['a class instance (clones as a plain object)', new Point(3, 4)],
  ['a null-prototype object (clones with Object.prototype)', nullProto],
];
for (const [label, x] of fixtures) roundTrips(label, x);

ok('"__proto__" stays a key and pollutes nothing',
  ({} as Record<string, unknown>).polluted === undefined
  && Object.prototype.hasOwnProperty.call(wire.decode(wire.encode(JSON.parse('{"__proto__":{"polluted":1}}'))), '__proto__'));

// Things the codec must refuse rather than mangle.
const cyc: Record<string, unknown> = {};
cyc.self = cyc;
refuses('a cycle', cyc);
refuses('a Float64Array (only Uint8Array is carried)', new Float64Array([1]));
refuses('an ArrayBuffer', new ArrayBuffer(4));
refuses('a function', () => 1);
refuses('a symbol', Symbol('s'));
refuses('an Error', new Error('x'));
refuses('a RegExp', /x/);
// A shared reference is not a cycle: it is copied (structuredClone would keep one object).
const shared = { v: 1 };
ok('a shared (non-cyclic) reference encodes, by value', diff(wire.decode(wire.encode([shared, shared])), [{ v: 1 }, { v: 1 }]) === null);

// Malformed wire input must throw, not guess.
for (const [label, text] of [
  ['unknown tag', '{"$":"nope"}'], ['bigint that is not digits', '{"$":"B","v":"1e3"}'],
  ['map entry not a pair', '{"$":"M","v":[[1]]}'], ['bytes not a string', '{"$":"U8","v":1}'],
  ['escape whose v is an array', '{"$":"O","v":[]}'], ['date of a string', '{"$":"D","v":"2020"}'],
] as const) {
  let threw = false;
  try { wire.decode(text); } catch (err) { threw = err instanceof TypeError; }
  ok(`decode refuses: ${label}`, threw);
}

// ── Real handler outputs over the sample project ──────────────────────────────
async function realOutputs(): Promise<void> {
  const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
  const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
  const { sampledVizData }: typeof import('../src/ipc/vizSampleData') = require('../src/ipc/vizSampleData');
  for (const m of ['visuals', 'dashboards', 'metrics', 'datasets', 'stats', 'insights']) {
    (require(`../src/ipc/${m}`) as { register: () => void }).register();
  }
  await projects.init();
  const seeded = await sample.seedSampleProject();
  const projectId = String(seeded.projectId);
  const ds = (await datasets.listDatasets(projectId))[0];
  const dash = await analysisStore.getAnalysis(projectId, (await analysisStore.listAnalyses(projectId))[0].id);
  const cards: any[] = dash!.sheets[0].cards; // any: card union, read structurally
  const call = (ch: string, p: unknown): Promise<unknown> => handlers.get(ch)!(null, p);

  const outputs: [string, unknown][] = [];
  for (const c of cards.filter((x) => x.type === 'visual')) {
    const v = (await visuals.getVisual(projectId, c.visualId))!;
    const args = { projectId, datasetId: v.datasetId, encoding: v.encoding, filters: v.filters || [] };
    outputs.push([`visual:data ${v.chartType}`, await call('visual:data', args)]);
    outputs.push([`vizDataFor ${v.chartType}`, await ipcVisuals.vizDataFor(projectId, v.datasetId, v.encoding, v.filters || [])]);
    // null below SAMPLE_MIN_ROWS (250k) — the 5k-row sample is computed in full.
    outputs.push([`sampledVizData ${v.chartType}`, await sampledVizData(projectId, v.datasetId, v.encoding, v.filters || [])]);
  }
  for (const c of cards.filter((x) => x.type === 'metric')) {
    outputs.push([`dashboard:metric ${c.metric.label}`, await call('dashboard:metric', {
      projectId, datasetId: c.metric.datasetId, column: c.metric.column, aggregation: c.metric.aggregation, filters: [],
    })]);
  }
  await call('metric:ensureDefaults', { projectId, datasetId: ds.id });
  const metricList: any = await call('metric:list', { projectId }); // any: IPC reply
  outputs.push(['metric:list', metricList]);
  for (const m of (metricList?.metrics ?? []).slice(0, 4)) {
    outputs.push([`metric:value ${m.name}`, await call('metric:value', { projectId, id: m.id, filters: [] })]);
    outputs.push([`metric:series ${m.name}`, await call('metric:series', { projectId, id: m.id, column: 'order_date', filters: [] })]);
  }
  outputs.push(['dataset:stats', await call('dataset:stats', { projectId, datasetId: ds.id })]);
  for (const spec of [
    { kind: 'regression', datasetId: ds.id, target: 'revenue', predictors: ['units', 'unit_price', 'discount', 'region'] },
    { kind: 'correlation', datasetId: ds.id, columns: ['units', 'unit_price', 'discount', 'revenue', 'profit', 'ship_days'] },
    { kind: 'groups', datasetId: ds.id, columns: [], group: 'region', outcome: 'profit' },
    { kind: 'distribution', datasetId: ds.id, columns: ['profit'] },
  ]) {
    outputs.push([`stats:run ${spec.kind}`, await call('stats:run', { projectId, spec })]);
  }
  outputs.push(['insights:list (anomalies)', await call('insights:list', { projectId, datasetId: ds.id })]);

  ok('real outputs: every handler answered', outputs.every(([, o]) => o !== undefined),
    outputs.filter(([, o]) => o === undefined).map(([l]) => l).join(', '));
  ok('real outputs: the KPIs and charts computed (not error replies)',
    outputs.filter(([l]) => /^(visual:data|dashboard:metric)/.test(l)).every(([, o]: [string, any]) => o && o.ok !== false));
  ok('real outputs: stats:run answered every spec (not error replies)',
    outputs.filter(([l]) => l.startsWith('stats:run')).every(([, o]: [string, any]) => o && o.ok === true && o.result?.ok !== false));
  for (const [label, o] of outputs) roundTrips(`real ${label}`, o);
  // How many replies carry something plain JSON would have changed — what the codec is for.
  const lossy = outputs.filter(([, o]) => o !== undefined && wire.encode(o) !== JSON.stringify(o)).map(([l]) => l);
  console.log(`     ${outputs.length} real replies, ${lossy.length} carry a value plain JSON would change${lossy.length ? ': ' + lossy.join(', ') : ''}`);

  // Cost on the largest real reply — the number the log records.
  const [bigLabel, bigOut] = outputs.reduce((m, o) => (JSON.stringify(o[1] ?? null).length > JSON.stringify(m[1] ?? null).length ? o : m));
  const N = 50;
  let text = '';
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) text = wire.encode(bigOut);
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) wire.decode(text);
  const t2 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) JSON.parse(JSON.stringify(bigOut));
  const t3 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) structuredClone(bigOut);
  const t4 = process.hrtime.bigint();
  const ms = (a: bigint, b: bigint): string => (Number(b - a) / 1e6 / N).toFixed(3);
  console.log(`     largest real reply: ${bigLabel}, ${text.length} bytes wire, ${JSON.stringify(bigOut).length} bytes plain JSON`);
  console.log(`     per call: encode ${ms(t0, t1)} ms, decode ${ms(t1, t2)} ms, plain JSON round trip ${ms(t2, t3)} ms, structuredClone ${ms(t3, t4)} ms`);
}

realOutputs()
  .catch((err) => ok('real outputs ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    finish();
  });
