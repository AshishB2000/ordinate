// Self-check for the SHIPPED `visual:data` path of the cohort and event-funnel
// visuals (src/ipc/visualsEngines.ts).
//
// test-cohort.ts and test-funnelEvents.ts compare the two engines directly;
// this one asks the real IPC handler, over a dataset saved through the real
// `datasets.saveDataset`, and holds the reply to the JS reference `Object.is`,
// leaf by leaf. And it SPIES on `datasets.getDataset`: the resident path must
// answer without hydrating a single row, so a fast path that silently stops
// firing fails here instead of passing green and inert. The one case that must
// hydrate — a filter that warns — is asserted to, so the spy is proven live.
//
//   npm run build:ts && node scripts/test-engineIpc.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // any: the loader hook has no public type

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-engine-ipc-'));
const handlers = new Map<string, (e: unknown, arg: unknown) => Promise<any>>(); // any: IPC replies
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') {
    return {
      app: { getPath: () => tmpUserData },
      ipcMain: { handle: (channel: string, fn: (e: unknown, arg: unknown) => Promise<any>) => { handlers.set(channel, fn); } }, // any: IPC replies
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const engineViz: typeof import('../src/analysis/engineViz') = require('../src/analysis/engineViz');
const visualsMod: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type Cell = import('../src/data/transforms').Cell;

const realGetDataset = datasets.getDataset;
let hydrations = 0;
(datasets as any).getDataset = async (...args: any[]): Promise<any> => { // any: forwarding spy
  hydrations += 1;
  return (realGetDataset as any)(...args); // any: forwarding spy
};

function firstDiff(a: unknown, b: unknown, where = '$'): string {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${where}.length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) { const d = firstDiff(a[i], b[i], `${where}[${i}]`); if (d) return d; }
    return '';
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = firstDiff((a as any)[k], (b as any)[k], `${where}.${k}`); // any: generic walk
      if (d) return d;
    }
    return '';
  }
  return Object.is(a, b) ? '' : `${where}: ${String(a)} vs ${String(b)}`;
}

const COLS: ParsedColumn[] = [
  { name: 'user', type: 'text' }, { name: 'event', type: 'text' }, { name: 'ts', type: 'date' },
  { name: 'value', type: 'number' }, { name: 'plan', type: 'text' },
];

/** A small deterministic event log: 40 users, signup → trial → purchase over three months. */
function events(): Cell[][] {
  const rows: Cell[][] = [];
  for (let u = 0; u < 40; u += 1) {
    const day0 = 1 + (u % 27);
    const month = 1 + (u % 3);
    const d = (m: number, day: number, h = 9): string =>
      `2024-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(h).padStart(2, '0')}:00:00`;
    const plan = ['free', 'pro', 'team'][u % 3];
    rows.push([`u${u}`, 'signup', d(month, day0), 10 + u, plan]);
    if (u % 2 === 0) rows.push([`u${u}`, 'trial', d(month, day0, 9 + (u % 5)), 5, plan]);
    if (u % 4 === 0) rows.push([`u${u}`, 'purchase', d(Math.min(month + 1, 4), 2), 99, plan]);
    if (u % 5 === 0) rows.push([`u${u}`, 'signup', d(month, day0), 10 + u, plan]); // an exact duplicate
  }
  rows.push(['', 'signup', '2024-01-01', 1, 'free'], ['x', 'signup', 'not a time', 1, 'free']);
  return rows;
}

async function main(): Promise<void> {
  if (!parquetStore.isSupported()) {
    console.log('ok   (skipped) the DuckDB bridge is unavailable — the resident path cannot be exercised');
    return finish();
  }
  ipcVisuals.register();
  const visualData = handlers.get('visual:data');
  ok('visual:data handler registered', typeof visualData === 'function');
  if (!visualData) return finish();
  await projects.init();
  await datasets.init();
  const proj = await projects.createProject('Engines');
  const saved = await datasets.saveDataset(proj.id, { name: 'Events', sourceKind: 'csv', columns: COLS, rows: events() });
  if (!saved) throw new Error('saveDataset failed');
  const back = await realGetDataset(proj.id, saved.id);
  if (!back) throw new Error('read-back failed');
  ok('the fixture is resident (v3)', (await datasets.residentSource(proj.id, saved.id)) !== null);

  const cases: Array<{ label: string; encoding: unknown; filters?: unknown[]; hydrates: boolean; op?: string }> = [
    { label: 'cohort, monthly retention', op: 'vizCohort', hydrates: false,
      encoding: { category: 'ts', values: [{ column: 'user', aggregation: 'count' }], cohort: { entity: 'user', date: 'ts', grain: 'month', show: 'retention' } } },
    { label: 'cohort, weekly value, filtered', op: 'vizCohort', hydrates: false, filters: [{ type: 'filter', column: 'plan', op: '=', value: 'pro' }],
      encoding: { category: 'ts', values: [], cohort: { entity: 'user', date: 'ts', value: 'value', grain: 'week', show: 'value', curve: true } } },
    { label: 'event funnel with a breakdown', op: 'vizEventFunnel', hydrates: false,
      encoding: { category: 'event', values: [], eventFunnel: { entity: 'user', event: 'event', time: 'ts', steps: ['signup', 'trial', 'purchase'], window: { n: 45, unit: 'days' }, breakdown: 'plan' } } },
    { label: 'an incomplete funnel answers from columns alone', hydrates: false,
      encoding: { category: '', values: [], eventFunnel: { entity: 'user', event: 'event', time: 'ts', steps: ['signup'] } } },
    { label: 'a filter that warns falls back to the JS reference', hydrates: true, filters: [{ type: 'filter', column: 'nope', op: '=', value: 'x' }],
      encoding: { category: 'ts', values: [], cohort: { entity: 'user', date: 'ts', grain: 'quarter' } } },
  ];
  for (const c of cases) {
    hydrations = 0;
    const before = c.op ? (trace.snapshot()[c.op] || { resident: 0 }).resident : 0;
    const got = await visualData(null, { projectId: proj.id, datasetId: saved.id, encoding: c.encoding, filters: c.filters || [] });
    const enc = visualsMod.sanitizeEncoding(c.encoding);
    const ref = engineViz.engineVizData(back.columns, back.rows, enc, visualsMod.sanitizeFilters(c.filters || []));
    ok(`${c.label}: ok`, !!got && got.ok === true, JSON.stringify(got && got.error));
    if (!got || !got.ok || !ref) continue;
    const d = firstDiff({ labels: got.data.labels, series: got.data.series, cohort: got.data.cohort, eventFunnel: got.data.eventFunnel },
      { labels: ref.data.labels, series: ref.data.series, cohort: ref.data.cohort, eventFunnel: ref.data.eventFunnel });
    ok(`${c.label}: reply ≡ the JS reference, Object.is`, d === '', d);
    ok(`${c.label}: warnings identical`, JSON.stringify(got.warnings) === JSON.stringify(ref.warnings));
    ok(`${c.label}: ${c.hydrates ? 'HYDRATED (the spy is live)' : 'never hydrated a row'}`, (hydrations > 0) === c.hydrates, `${hydrations} getDataset call(s)`);
    if (c.op) ok(`${c.label}: residentTrace recorded a resident answer`, (trace.snapshot()[c.op] || { resident: 0 }).resident === before + 1);
  }
  const fun = await visualData(null, { projectId: proj.id, datasetId: saved.id, encoding: cases[2].encoding });
  ok('the funnel is a real one: 40 entered, fewer tried, fewer bought',
     !!fun.data.eventFunnel && fun.data.eventFunnel.counts[0] === 40 && fun.data.eventFunnel.counts[1] < 40
     && fun.data.eventFunnel.counts[2] < fun.data.eventFunnel.counts[1], JSON.stringify(fun.data.eventFunnel && fun.data.eventFunnel.counts));
  ok('two bad rows were excluded and counted', !!fun.data.eventFunnel && fun.data.eventFunnel.excluded === 2);
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
  finish();
}

main().catch((e) => { ok('test-engineIpc ran', false, e && e.stack); finish(); });
