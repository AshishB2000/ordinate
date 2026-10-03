// Self-check for the statistics workbench's DATA path — the differential half
// of the house style.
//
//   1. engine/statsVectors.loadVectorsResident (SQL over the stored Parquet,
//      async bridge) ≡ analysis/stats/vectorsJs.loadVectorsJs (the hydrated
//      reference), cell for cell with Object.is, over the SAME bytes read back
//      through parquetStore.readTable: declared-type casts only ('007' stays a
//      label, a text column is never read as a number), empty = null / '' /
//      whitespace (NBSP and tab included), file order, dashboard filters.
//   2. The analyses run on either vector set agree exactly.
//   3. The SHIPPED handlers (electron stubbed, register() called): stats:run
//      answers without hydrating the table (datasets.getDataset spied), and
//      agrees with the reference; stats:saveFormula adds predicted_<target> as a
//      calculated field whose values ARE the model's fitted values; stats:tile
//      presents it; a dashboard "stats" card keeps only a whitelisted spec.
//   4. The Assistant's facts: each kind's text passes the number audit against
//      its own ledger, and a spec over a sensitive column is withheld whole.
//
//   npm run build:ts && node scripts/test-statsVectors.js

export {};
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type FilterStep = import('../src/data/transforms').FilterStep;
type VectorNeed = import('../src/analysis/stats/spec').VectorNeed;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-statsvec-'));
// Handlers land in the RPC registry (src/ipc/bus.ts outside Electron), not the stub.
const handlers: Map<string, IpcHandler> = require('../src/server/rpc').handlers;
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test' },
      dialog: {}, net: {}, nativeImage: {}, shell: {}, BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};
process.env.ORDINATE_COMPUTE_INLINE = '1'; // no worker threads in a unit test

// ponytail: compiled siblings of the REAL modules (built by pretest).
const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const statsVectors: typeof import('../src/engine/statsVectors') = require('../src/engine/statsVectors');
const vectorsJs: typeof import('../src/analysis/stats/vectorsJs') = require('../src/analysis/stats/vectorsJs');
const run: typeof import('../src/analysis/stats/run') = require('../src/analysis/stats/run');
const reg: typeof import('../src/analysis/stats/regression') = require('../src/analysis/stats/regression');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const statsFactsMod: typeof import('../src/ai/statsFacts') = require('../src/ai/statsFacts');
const audit: typeof import('../src/ai/numberAudit') = require('../src/ai/numberAudit');
const statsIpc: typeof import('../src/ipc/stats') = require('../src/ipc/stats');

statsIpc.register();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-statsvec-files-'));
let seq = 0;
const T = (name: string): ParsedColumn => ({ name, type: 'text' });
const N = (name: string): ParsedColumn => ({ name, type: 'number' });
const D = (name: string): ParsedColumn => ({ name, type: 'date' });

/** Both loaders over the same file; every vector compared with Object.is. */
async function agree(label: string, columns: ParsedColumn[], rows: Cell[][], needs: VectorNeed[], filters: FilterStep[] = []): Promise<import('../src/analysis/stats/run').StatsVectors | null> {
  const file = path.join(tmpDir, `f${++seq}.parquet`);
  pqSync.writeTable(file, columns, rows);
  const back = pqSync.readTable(file, columns);
  if (!back) { ok(`${label}: fixture reads back`, false); return null; }
  const want = vectorsJs.loadVectorsJs(columns, back.rows, needs, filters);
  const got = await statsVectors.loadVectorsResident({ parquetPath: file, columns }, needs, filters);
  if (!want || !got) { ok(`${label}: both loaders answer`, false, `js=${!!want} resident=${!!got}`); return null; }
  let same = want.rows === got.rows;
  let detail = same ? '' : `rows ${want.rows} vs ${got.rows}`;
  for (const n of needs) {
    const a = (n.as === 'number' ? want.number : want.label).get(n.column) as unknown[];
    const b = (n.as === 'number' ? got.number : got.label).get(n.column) as unknown[];
    if (!a || !b || a.length !== b.length) { same = false; detail = `${n.column}: lengths`; break; }
    const at = a.findIndex((v, i) => !Object.is(v, b[i]));
    if (at >= 0) { same = false; detail = `${n.column}[${at}]: ${JSON.stringify(a[at])} vs ${JSON.stringify(b[at])}`; break; }
  }
  ok(`${label}: resident vectors ≡ JS reference (Object.is)`, same, detail);
  return got;
}

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();
  if (!parquetStore.isSupported()) {
    console.log('#    DuckDB bridge UNAVAILABLE — nothing to test, the JS path is always used');
    return;
  }

  // ── 1. The loaders agree ──────────────────────────────────────────────────
  const cols = [T('region'), N('amount'), T('code'), D('day'), N('flag')];
  const rows: Cell[][] = [
    ['West', 12.5, '007', '2024-01-02', 1], ['East', -3, '010', '2024-01-03', 0], ['', 7, '   ', '', 1],
    [null, null, null, null, null], [' ', 0.1, '\t', '2024-02-01', 0], [' West', 1e21, 'x', '2024-02-02', 2.5],
    ['﻿North', 4, '﻿007', '2024-03-01', 1], ['West', NaN as unknown as number, 'y', '2024-03-02', Infinity as unknown as number],
  ];
  const needs: VectorNeed[] = [
    { column: 'region', as: 'label' }, { column: 'amount', as: 'number' }, { column: 'code', as: 'label' },
    { column: 'day', as: 'label' }, { column: 'flag', as: 'label' }, { column: 'flag', as: 'number' },
  ];
  const v = await agree('edge cells', cols, rows, needs);
  if (v) {
    ok("'007' stays the label '007' (never cast)", v.label.get('code')![0] === '007');
    ok("'', whitespace, NBSP and tab are all empty", v.label.get('region')![2] === null && v.label.get('region')![4] === null && v.label.get('code')![2] === null && v.label.get('code')![4] === null);
    ok('an untrimmed label stays untrimmed', v.label.get('region')![5] === ' West');
    ok('a leading BOM survives the bridge', v.label.get('region')![6] === '﻿North');
    ok('a number column as a label is String(n)', v.label.get('flag')![5] === '2.5' && v.label.get('flag')![0] === '1');
    ok('non-finite numbers are null', v.number.get('amount')![7] === null && v.number.get('flag')![7] === null);
  }
  await agree('filters: eq', cols, rows, needs, [{ type: 'filter', column: 'region', op: '=', value: 'West' } as FilterStep]);
  await agree('filters: numeric gt + unknown column skipped', cols, rows, needs, [
    { type: 'filter', column: 'amount', op: '>', value: 0 } as FilterStep, { type: 'filter', column: 'nope', op: '=', value: 'x' } as FilterStep,
  ]);
  await agree('filters: in-list', cols, rows, needs, [{ type: 'filter', column: 'region', op: 'in', values: ['West', 'East'] } as FilterStep]);

  // A bigger deterministic table: order is the file's, not the scan's.
  let s = 7;
  const lcg = (): number => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const big: Cell[][] = [];
  for (let i = 0; i < 3000; i++) {
    const x = Math.round(lcg() * 1000) / 10;
    big.push(['g' + (i % 5), x, 2 * x + 3 + Math.round((lcg() - 0.5) * 100) / 10, i % 11 === 0 ? null : (lcg() < 0.4 ? 'yes' : 'no')]);
  }
  const bigCols = [T('g'), N('x'), N('y'), T('won')];
  const bigNeeds: VectorNeed[] = [{ column: 'g', as: 'label' }, { column: 'x', as: 'number' }, { column: 'y', as: 'number' }, { column: 'won', as: 'label' }];
  const bv = await agree('3,000 rows in file order', bigCols, big, bigNeeds);

  // The gate: a declared-text column is never read as a number, on either side.
  {
    const file = path.join(tmpDir, `gate.parquet`);
    pqSync.writeTable(file, [T('code')], [['007'], ['13']]);
    const back = pqSync.readTable(file, [T('code')]);
    ok('gate: the JS reference declines a text column as a number', vectorsJs.loadVectorsJs([T('code')], back!.rows, [{ column: 'code', as: 'number' }]) === null);
    ok('gate: the resident loader declines it too (no TRY_CAST of text)',
      (await statsVectors.loadVectorsResident({ parquetPath: file, columns: [T('code')] }, [{ column: 'code', as: 'number' }])) === null);
    ok('an unknown column is a fallback, not a guess',
      (await statsVectors.loadVectorsResident({ parquetPath: file, columns: [T('code')] }, [{ column: 'nope', as: 'label' }])) === null);
  }

  // ── 2. The analyses agree on either vector set ────────────────────────────
  if (bv) {
    const back = pqSync.readTable(path.join(tmpDir, `f${seq}.parquet`), bigCols)!;
    const js = vectorsJs.loadVectorsJs(bigCols, back.rows, bigNeeds)!;
    const specs: any[] = [
      { kind: 'correlation', datasetId: 'x', columns: ['x', 'y'], method: 'spearman' },
      { kind: 'regression', datasetId: 'x', columns: [], target: 'y', predictors: ['x', 'g'] },
      { kind: 'groups', datasetId: 'x', columns: [], group: 'g', outcome: 'y' },
      { kind: 'groups', datasetId: 'x', columns: [], group: 'g', outcome: 'won' },
      { kind: 'distribution', datasetId: 'x', columns: ['y'] },
    ];
    for (const spec of specs) {
      const a = JSON.stringify(run.runStats(spec, js));
      const b = JSON.stringify(run.runStats(spec, bv));
      ok(`${spec.kind}${spec.outcome ? ' ' + spec.outcome : ''}: identical results on either vector set`, a === b);
    }
  }

  // ── 3. The shipped handlers ───────────────────────────────────────────────
  const proj = await projects.createProject('stats');
  const ds = await datasets.saveDataset(proj.id, { name: 'Points', sourceKind: 'csv', columns: bigCols, rows: big });
  ok('fixture dataset saved (resident)', !!ds && !!(await datasets.getDatasetMeta(proj.id, ds!.id))?.resident);
  const runH = handlers.get('stats:run');
  const saveH = handlers.get('stats:saveFormula');
  const tileH = handlers.get('stats:tile');
  const pairH = handlers.get('stats:pair');
  ok('stats:run, :pair, :tile and :saveFormula are registered', !!runH && !!saveH && !!tileH && !!pairH);
  if (ds && runH && saveH && tileH && pairH) {
    const spec = { kind: 'regression', datasetId: ds.id, target: 'y', predictors: ['x', 'g'] };
    const realGet = datasets.getDataset;
    let hydrated = 0;
    (datasets as any).getDataset = async (...args: any[]): Promise<any> => { hydrated += 1; return (realGet as any)(...args); };
    let res: any;
    try {
      res = await runH({}, { projectId: proj.id, spec });
      ok('stats:run answers', !!res && res.ok && res.result.ok, JSON.stringify(res && (res.error || res.result?.error)));
      ok('stats:run never hydrated the table (resident path)', hydrated === 0, `getDataset called ${hydrated}x`);
      const pr = await pairH({}, { projectId: proj.id, spec: { kind: 'correlation', datasetId: ds.id, columns: ['x', 'y'] }, x: 'x', y: 'y' });
      ok('stats:pair answers with a fit line, never hydrating', !!pr && pr.ok && !!pr.pair.fit && hydrated === 0);
    } finally {
      (datasets as any).getDataset = realGet;
    }
    const full = await datasets.getDataset(proj.id, ds.id);
    const ref = run.runStats(spec as any, vectorsJs.loadVectorsJs(full!.columns, full!.rows, [{ column: 'y', as: 'number' }, { column: 'x', as: 'number' }, { column: 'g', as: 'label' }])!);
    ok('stats:run ≡ the JS reference', !!res && JSON.stringify(res.result) === JSON.stringify(ref));
    const bad = await runH({}, { projectId: proj.id, spec: { kind: 'correlation', datasetId: ds.id, columns: ['x'] } });
    ok('stats:run: one column → "Pick at least two numeric columns"', !!bad && bad.ok && !bad.result.ok && /Pick at least two numeric columns/.test(bad.result.error));
    const junk = await runH({}, { projectId: proj.id, spec: { kind: 'correlation', datasetId: '../../etc' } });
    ok('stats:run: a non-UUID dataset id is refused before any path', !!junk && junk.ok === false);

    const saved = await saveH({}, { projectId: proj.id, spec });
    ok('stats:saveFormula adds predicted_y', !!saved && saved.ok && saved.name === 'predicted_y', JSON.stringify(saved));
    const after = await datasets.getDataset(proj.id, ds.id);
    const ci = after ? after.columns.findIndex((c) => c.name === 'predicted_y') : -1;
    ok('predicted_y is a number column on the dataset', ci >= 0 && after!.columns[ci].type === 'number');
    ok('predicted_y is an ordinary calculated_field step', !!after && (after.steps || []).some((st: any) => st.type === 'calculated_field' && st.name === 'predicted_y'));
    if (ci >= 0 && ref.ok && ref.kind === 'regression') {
      const { intercept, fits } = reg.modelFits(ref.fit);
      const xi = after!.columns.findIndex((c) => c.name === 'x');
      const gi = after!.columns.findIndex((c) => c.name === 'g');
      const sameAll = after!.rows.every((r) => Object.is(r[ci], reg.fittedAt(intercept, fits, (c) => (c === 'x' ? r[xi] : r[gi]) as number | string | null)));
      ok('predicted_y reproduces the fitted values on every row (Object.is)', sameAll);
    }
    const again = await saveH({}, { projectId: proj.id, spec });
    ok('saving again replaces the step rather than adding a second', !!again && again.ok && again.replaced === true
      && ((await datasets.getDataset(proj.id, ds.id))!.steps || []).filter((st: any) => st.name === 'predicted_y').length === 1);

    const tile = await tileH({}, { projectId: proj.id, spec: { kind: 'groups', datasetId: ds.id, group: 'g', outcome: 'y', view: 'chart' } });
    ok('stats:tile presents a table, a numeric grid and a chart', !!tile && tile.ok && tile.view === 'chart'
      && tile.tile.table.rows.length === 5 && tile.tile.numeric.labels.length === 5 && tile.tile.chart.chartType === 'column', JSON.stringify(tile && tile.error));
    const filtered = await tileH({}, { projectId: proj.id, spec: { kind: 'distribution', datasetId: ds.id, columns: ['x'] }, filters: [{ type: 'filter', column: 'g', op: '=', value: 'g1' }] });
    ok('stats:tile applies the dashboard filters', !!filtered && filtered.ok && filtered.tile.table.rows[0][1] === '600');

    // The card stores a whitelisted SPEC and nothing else.
    const card = dashboards.sanitizeCard({ type: 'stats', layout: { x: 0, y: 0, w: 6, h: 6 }, stats: { kind: 'groups', datasetId: ds.id, group: 'g', outcome: 'y', view: 'chart', result: { f: 1 }, evil: '<script>' } });
    ok('a stats card keeps its spec', !!card && card.type === 'stats' && card.stats!.group === 'g' && card.stats!.view === 'chart');
    ok('a stats card stores no figures and no stray keys', !!card && !('result' in (card.stats as any)) && !('evil' in (card.stats as any)));
    ok('a stats card with no valid spec is dropped', dashboards.sanitizeCard({ type: 'stats', layout: {}, stats: { kind: 'groups', datasetId: 'nope' } }) === null);

    // ── 4. Facts ────────────────────────────────────────────────────────────
    const kinds: any[] = [
      { kind: 'correlation', datasetId: ds.id, columns: ['x', 'y'] },
      spec,
      { kind: 'groups', datasetId: ds.id, group: 'g', outcome: 'y', levels: ['g0', 'g3'] },
      { kind: 'groups', datasetId: ds.id, group: 'g', outcome: 'y' },
      { kind: 'groups', datasetId: ds.id, group: 'g', outcome: 'won', levels: ['g0', 'g1'] },
      { kind: 'distribution', datasetId: ds.id, columns: ['y'] },
    ];
    for (const k of kinds) {
      const facts = await statsIpc.statsPanelFacts(proj.id, k);
      const a = facts ? audit.auditNumbers(facts.text, facts.ledger) : null;
      ok(`facts (${k.kind}${k.levels ? ' ' + k.levels.length : ''}): the text passes the audit against its own ledger`, !!a && a.ok, a ? a.violations.map((x) => x.token).join(', ') : 'no facts');
    }
    const two = await statsIpc.statsPanelFacts(proj.id, kinds[2]);
    ok("facts carry the app's sentence verbatim", !!two && /App's sentence: .*average y/.test(two.text));
    const empty = statsFactsMod.statsFacts([{ spec: kinds[0], result: { ok: false, kind: 'correlation', error: 'Pick at least two numeric columns.' } }], 'Points');
    ok('facts for a result that could not run say why', /Not computed: Pick at least two/.test(empty.text));
    await catalog.setColumn(proj.id, ds.id, 'g', { sensitivity: 'personal' } as any); // any: a ColumnPatch literal
    const hidden = await statsIpc.statsPanelFacts(proj.id, kinds[2]);
    ok('a spec over a sensitive column is withheld from the Assistant, whole', !!hidden && /withheld from the Assistant/.test(hidden.text) && hidden.ledger.length === 0 && !/g0/.test(hidden.text));
  }
}

void main()
  .catch((err) => { ok('unexpected error', false, err && err.stack ? err.stack : err); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' stats-vector check(s) FAILED'); process.exit(1); }
    console.log('\nAll stats-vector checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
