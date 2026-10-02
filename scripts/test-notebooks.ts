'use strict';

// Self-check for notebooks (src/analysis/notebook/): view naming, the
// dependency graph and staleness, cache keys, the Markdown export and the
// record's whitelist — asserted directly — then a REAL run over REAL Parquet
// under the real engine lock ('electron' stubbed only to point userData at a
// temp dir, as test-sqlDatasets.ts does):
//
//   · a SQL cell reads another cell's view and a [[parameter]];
//   · DIFFERENTIAL: a chart cell over a SQL cell equals vizData.buildVizData
//     over the dataset's own rows, value for value with Object.is — the view
//     chain and the JS bridge agree;
//   · a formula cell is the Prepare pipeline's calculated field;
//   · the cache answers a re-run, and a dataset write moves the key;
//   · a `notebook` origin survives the whitelist and refreshes the dataset;
//   · Cancel ends a run as cancelled.
//
//   npm run build:ts && node scripts/test-notebooks.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-nb-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData }, ipcMain: {}, dialog: {} };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources under test.
const graph: typeof import('../src/analysis/notebook/graph') = require('../src/analysis/notebook/graph');
const model: typeof import('../src/analysis/notebook/model') = require('../src/analysis/notebook/model');
const exp: typeof import('../src/analysis/notebook/exportMd') = require('../src/analysis/notebook/exportMd');
const store: typeof import('../src/analysis/notebook/store') = require('../src/analysis/notebook/store');
const run: typeof import('../src/analysis/notebook/run') = require('../src/analysis/notebook/run');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const origin: typeof import('../src/data/datasetOrigin') = require('../src/data/datasetOrigin');
const refresh: typeof import('../src/data/datasetRefresh') = require('../src/data/datasetRefresh');
const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 100;
const newId = (): string => U(seq++);

type Cells = import('../src/analysis/notebook/model').NbCell[];
const sql = (n: number, text: string, title?: string): any => ({ id: U(n), kind: 'sql', sql: text, ...(title ? { title } : {}) });
const param = (n: number, name: string, type: string, value: unknown): any => ({ id: U(n), kind: 'param', name, type, value });
const clean = (raw: any[]): Cells => model.sanitizeCells(raw, newId);

// ─────────────────────────────────────────────────────────────────────────────
// 1. View names
// ─────────────────────────────────────────────────────────────────────────────
{
  const cells = clean([
    { id: U(1), kind: 'markdown', text: '# hi' },
    sql(2, 'select 1'),
    sql(3, 'select 2', 'Revenue by Region'),
    sql(4, 'select 3', '2024 sales'),
    sql(5, 'select 4', 'Order'),
    sql(6, 'select 5', 'revenue by region!'),
    sql(7, 'select 6', 'Sales'),
    sql(8, 'select 7', '!!!'),
  ]);
  const v = graph.assignCellViews(cells, ['Sales', 'sales', 'retail_orders']);
  ok('views: an untitled SQL cell is cell_<1-based position>', v.get(U(2)) === 'cell_2');
  ok('views: a title is slugged lower-case [a-z0-9_]', v.get(U(3)) === 'revenue_by_region');
  ok('views: a slug never starts with a digit', v.get(U(4)) === '_2024_sales');
  ok('views: a reserved word works unquoted', v.get(U(5)) === 'order_');
  ok('views: a repeated title is de-duplicated with a suffix', v.get(U(6)) === 'revenue_by_region_2');
  ok('views: never a dataset\'s exposed name (case-insensitively)', v.get(U(7)) === 'sales_2', String(v.get(U(7))));
  ok('views: a title with nothing to slug falls back to cell_N', v.get(U(8)) === 'cell_8');
  ok('views: only SQL cells get one', !v.has(U(1)));
  const clash = graph.assignCellViews(clean([sql(1, 'x', 'cell 2'), sql(2, 'y')]), []);
  ok('views: a title that takes an untitled cell\'s name pushes that one on', clash.get(U(1)) === 'cell_2' && clash.get(U(2)) === 'cell_2_2');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The graph, staleness
// ─────────────────────────────────────────────────────────────────────────────
{
  const cells = clean([
    param(1, 'min_amount', 'number', 10),
    sql(2, 'select region, amount from sales'),
    sql(3, "select * from cell_2 where amount > [[min_amount]] -- cell_4 in a comment\n and region <> 'cell_4'"),
    { id: U(4), kind: 'formula', expression: '[amount] * 2', column: 'double' },
    { id: U(5), kind: 'chart', sourceCellId: U(3), chartType: 'column', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } },
    sql(6, 'select * from cell_7'),
    sql(7, 'select [[nope]] as x'),
    sql(8, 'select * from cell_8'),
    { id: U(9), kind: 'chart', sourceCellId: U(10), chartType: 'column', encoding: { category: 'a', values: [{ column: 'b', aggregation: 'sum' }] } },
    { id: U(10), kind: 'markdown', text: 'note' },
  ]);
  const g = graph.analyzeNotebook(cells, ['sales']);
  const at = (n: number): any => g.cells.find((c) => c.id === U(n));
  ok('graph: a SQL cell depends on the view it names', JSON.stringify(at(3).deps) === JSON.stringify([U(2), U(1)]), JSON.stringify(at(3).deps));
  ok('graph: names in strings and comments do not count', !at(3).deps.includes(U(4)) && at(3).error === null, String(at(3).error));
  ok('graph: a formula reads the nearest SQL/formula cell above', JSON.stringify(at(4).deps) === JSON.stringify([U(3)]));
  ok('graph: a chart depends on its source', JSON.stringify(at(5).deps) === JSON.stringify([U(3)]));
  ok('graph: a view BELOW is a clear error, not a dependency', /cell_7 is a cell below/.test(String(at(6).error)) && at(6).deps.length === 0);
  ok('graph: an unknown [[name]] is a clear cell error', at(7).error === '[[nope]] has no parameter cell above it.', String(at(7).error));
  ok('graph: a cell cannot read its own view', /own view/.test(String(at(8).error)));
  ok('graph: a chart must chart a SQL/formula cell ABOVE it', /Choose a SQL or formula cell/.test(String(at(9).error)));

  const last: Record<string, string> = {};
  for (const c of g.cells) last[c.id] = c.sig;
  ok('stale: nothing is stale against its own sigs', graph.staleIds(g, last).length === 0);

  const edited = cells.map((c) => (c.id === U(2) ? { ...c, sql: 'select region, amount from sales where amount > 0' } : c)) as Cells;
  const g2 = graph.analyzeNotebook(edited, ['sales']);
  const stale = graph.staleIds(g2, last);
  ok('stale: editing cell 2 marks everything downstream of it stale — and only that',
    JSON.stringify(stale) === JSON.stringify([U(2), U(3), U(4), U(5)]), JSON.stringify(stale));
  ok('stale: downstreamOf agrees with the sigs', JSON.stringify(graph.downstreamOf(g2, U(2))) === JSON.stringify([U(3), U(4), U(5)]));

  const p2 = cells.map((c) => (c.id === U(1) ? { ...c, value: 20 } : c)) as Cells;
  const g3 = graph.analyzeNotebook(p2, ['sales']);
  ok('stale: a parameter\'s new value stales the cells that read it, not the ones that do not',
    JSON.stringify(graph.staleIds(g3, last)) === JSON.stringify([U(1), U(3), U(4), U(5)]), JSON.stringify(graph.staleIds(g3, last)));
  const titled = cells.map((c) => (c.id === U(4) ? { ...c, title: 'Renamed' } : c)) as Cells;
  ok('stale: a title is not content — titling a formula stales nothing',
    graph.staleIds(graph.analyzeNotebook(titled, ['sales']), last).length === 0);
  const renamed = graph.analyzeNotebook(cells.map((c) => (c.id === U(2) ? { ...c, title: 'Base' } : c)) as Cells, ['sales']);
  ok('graph: titling a SQL cell renames its view — a reader of the old name is told why',
    renamed.cells[1].view === 'base' && /No cell above is called cell_2/.test(String(renamed.cells[2].error)), String(renamed.cells[2].error));
  ok('stale: a cell never run is not stale', graph.staleIds(g2, {}).length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cache keys
// ─────────────────────────────────────────────────────────────────────────────
{
  const base = {
    kind: 'sql' as const, text: [['cell_2', 'select 1'], 'select * from cell_2'], params: { p: ['number', 1] },
    inputs: ['k1'], datasets: [{ id: U(1), updatedAt: 'a' }, { id: U(2), updatedAt: 'b' }],
  };
  const k = graph.cellCacheKey(base);
  ok('key: sha256 hex', /^[0-9a-f]{64}$/.test(k));
  ok('key: dataset order does not matter', k === graph.cellCacheKey({ ...base, datasets: [base.datasets[1], base.datasets[0]] }));
  ok('key: a dataset write (updatedAt) moves it', k !== graph.cellCacheKey({ ...base, datasets: [{ id: U(1), updatedAt: 'a2' }, base.datasets[1]] }));
  ok('key: a parameter value moves it', k !== graph.cellCacheKey({ ...base, params: { p: ['number', 2] } }));
  ok('key: an input cell\'s result key moves it', k !== graph.cellCacheKey({ ...base, inputs: ['k2'] }));
  ok('key: the resolved SQL moves it', k !== graph.cellCacheKey({ ...base, text: [['cell_2', 'select 2'], 'select * from cell_2'] }));
  ok('key: the same parts are the same key', k === graph.cellCacheKey(JSON.parse(JSON.stringify(base))));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The Markdown export
// ─────────────────────────────────────────────────────────────────────────────
{
  const cells = clean([
    { id: U(1), kind: 'markdown', text: '# Notes\nWhy this exists.' },
    param(2, 'min', 'number', 5),
    sql(3, 'select a | b as x from t -- ```'),
    { id: U(4), kind: 'formula', expression: '[x] * 2', column: 'y' },
    { id: U(5), kind: 'chart', title: 'By [region]', sourceCellId: U(3), chartType: 'column', encoding: { category: 'x', values: [{ column: 'x', aggregation: 'sum' }] } },
    { id: U(6), kind: 'chart', sourceCellId: U(3), chartType: 'column', encoding: { category: 'x', values: [{ column: 'x', aggregation: 'sum' }] } },
    sql(7, 'select broken'),
  ]);
  const rows = Array.from({ length: 25 }, (_, i) => [`v|${i}\nz`, i]);
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const md = exp.notebookMarkdown({
    name: 'Q3 review',
    cells,
    graph: graph.analyzeNotebook(cells, []),
    results: {
      [U(3)]: { columns: [{ name: 'x', type: 'text' }, { name: 'n', type: 'number' }], rows, rowCount: 25, truncated: false, elapsedMs: 7 },
      [U(7)]: { error: 'Binder Error: column "broken" not found' },
    },
    charts: { [U(5)]: png, [U(6)]: 'data:text/html;base64,PHNjcmlwdD4=' },
    exportedAt: new Date('2026-10-01T12:00:00Z'),
  });
  ok('export: the notebook name is the title', md.startsWith('# Q3 review\n'));
  ok('export: markdown cells are kept verbatim', md.includes('# Notes\nWhy this exists.'));
  ok('export: a parameter is its binding', md.includes('**Parameter** `[[min]]` = `5` (number)'));
  ok('export: SQL is fenced, longer than any backtick run inside it', md.includes('````sql\nselect a | b as x from t -- ```\n````'));
  ok('export: a formula is [column] = expression', md.includes('```\n[y] = [x] * 2\n```'));
  ok('export: a result table, numbers right-aligned', md.includes('| x | n |\n| --- | ---: |'));
  ok('export: pipes are escaped and line breaks flattened in cells', md.includes('| v\\|0 z | 0 |'));
  ok('export: at most 20 rows, then "… N more rows"', md.includes('| v\\|19 z | 19 |') && !md.includes('| v\\|20 z |') && md.includes('… 5 more rows'));
  ok('export: the row count and run time', md.includes('_25 rows · 7 ms_'));
  ok('export: a chart is an embedded PNG, its alt text safe', md.includes(`![By region](${png})`));
  ok('export: anything but a PNG data URL is refused', !md.includes('text/html') && md.includes('_The chart had not been drawn when this was exported._'));
  ok('export: an error is said, not hidden', md.includes('> **Error:** Binder Error: column "broken" not found'));
  ok('export: a cell never run says so', md.includes('_Not run._'));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The record's whitelist
// ─────────────────────────────────────────────────────────────────────────────
{
  const out = clean([
    { id: U(1), kind: 'sql', sql: 'select 1' },
    { id: U(1), kind: 'sql', sql: 'select 2' },
    { id: '../../etc', kind: 'markdown', text: 'x' },
    { id: U(3), kind: 'shell', cmd: 'rm -rf /' },
    { id: U(4), kind: 'param', name: 'bad name', type: 'number', value: 'abc' },
    { id: U(5), kind: 'param', name: 'd', type: 'date', value: '2024-02-30' },
    { id: U(6), kind: 'chart', sourceCellId: 'nope', chartType: '', encoding: { category: 'a', values: [{ column: 'b', aggregation: 'evil' }] } },
  ]);
  ok('model: an unknown kind is dropped', out.length === 6 && !out.some((c: any) => c.kind === 'shell'));
  ok('model: a duplicated id is re-minted', out[0].id === U(1) && out[1].id !== U(1));
  ok('model: a non-UUID id is re-minted', /^[0-9a-f-]{36}$/.test(out[2].id) && out[2].id !== '../../etc');
  ok('model: a bad parameter name is blanked, a non-number value is null', (out[3] as any).name === '' && (out[3] as any).value === null);
  ok('model: an impossible date is null', (out[4] as any).value === null);
  ok('model: a chart\'s source must be a UUID and its encoding is the visuals whitelist',
    (out[5] as any).sourceCellId === '' && (out[5] as any).chartType === 'column' && (out[5] as any).encoding.values[0].aggregation === 'sum');

  const o = origin.sanitizeOrigin({ kind: 'notebook', notebookId: U(1), cellId: U(2), deps: [U(3), U(3)] }) as any;
  ok('origin: a notebook origin survives, deps de-duplicated', !!o && o.kind === 'notebook' && o.cellId === U(2) && o.deps.length === 1);
  ok('origin: a non-UUID notebook id drops it', origin.sanitizeOrigin({ kind: 'notebook', notebookId: '../x', cellId: U(2), deps: [] }) === undefined);
  ok('origin: a bad dep drops it', origin.sanitizeOrigin({ kind: 'notebook', notebookId: U(1), cellId: U(2), deps: ['x'] }) === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. A real run
// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Notebook project');
  const pid = proj!.id;
  const data: any[][] = [];
  for (let i = 0; i < 300; i += 1) data.push(['region' + (i % 7), String(i % 50).padStart(3, '0'), (i % 97) - 10, i % 3 === 0 ? '' : 'n' + i]);
  const sales = await datasets.saveDataset(pid, {
    name: 'Sales',
    sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'sku', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'note', type: 'text' }],
    rows: data,
  });
  ok('fixture: the dataset is Parquet-backed', !!sales && !!(await datasets.getDatasetMeta(pid, sales!.id))!.resident);

  const nb = await store.createNotebook(pid, {
    name: 'Regional review',
    cells: [
      param(1, 'min_amount', 'number', 50),
      sql(2, 'select region, sku, amount from sales'),
      sql(3, 'select region, sum(amount) as total, count(*) as n\nfrom cell_2\nwhere amount > [[min_amount]]\ngroup by 1\norder by 1', 'Big orders'),
      { id: U(4), kind: 'formula', expression: '[total] / [n]', column: 'avg_big' },
      { id: U(5), kind: 'chart', sourceCellId: U(2), chartType: 'column', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } },
      { id: U(6), kind: 'markdown', text: 'Done.' },
    ],
  });
  ok('store: created, cells kept with their ids', !!nb && nb.cells.length === 6 && nb.cells[2].id === U(3));
  const listed = await store.listNotebooks(pid);
  ok('store: listed with its kinds', listed.length === 1 && listed[0].kinds.sql === 2 && listed[0].kinds.chart === 1 && listed[0].excerpt === 'Done.');

  const r3: any = await run.runCell(pid, nb!, U(3));
  ok('run: a SQL cell reads cell_2 and [[min_amount]]', r3.ok && r3.columns.map((c: any) => c.name).join() === 'region,total,n', JSON.stringify(r3));
  const expect = new Map<string, { t: number; n: number }>();
  for (const r of data) if (r[2] > 50) { const e = expect.get(r[0]) || { t: 0, n: 0 }; e.t += r[2]; e.n += 1; expect.set(r[0], e); }
  ok('run: …and its figures are the JS fold\'s', r3.ok && r3.rows.length === expect.size
    && r3.rows.every((row: any[]) => Object.is(row[1], expect.get(row[0])!.t) && Object.is(row[2], expect.get(row[0])!.n)), JSON.stringify(r3.rows));
  ok('run: row count, elapsed and the sig it ran under', r3.ok && r3.rowCount === expect.size && typeof r3.elapsedMs === 'number'
    && r3.sig === (await run.graphFor(pid, nb!)).cells[2].sig);
  ok('run: the result read the Sales dataset', r3.ok && JSON.stringify(r3.deps) === JSON.stringify([sales!.id]));

  const again: any = await run.runCell(pid, nb!, U(3));
  ok('cache: a re-run with nothing changed is a cache hit with the same key', again.ok && again.cached === true && again.key === r3.key);

  const r4: any = await run.runCell(pid, nb!, U(4));
  ok('run: a formula cell appends its column over the cell above',
    r4.ok && r4.columns.map((c: any) => c.name).join() === 'region,total,n,avg_big'
    && r4.rows.every((row: any[]) => Object.is(row[3], row[1] / row[2])), JSON.stringify(r4.rows && r4.rows[0]));

  // DIFFERENTIAL: the chart over the view chain vs the JS bridge over the dataset itself.
  const r5: any = await run.runCell(pid, nb!, U(5));
  const full = await datasets.getDataset(pid, sales!.id);
  const ref = vizData.buildVizData(full!.columns, full!.rows, { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] });
  const got = r5.ok ? r5.chart.data : { labels: [], series: [] };
  ok('differential: the chart cell\'s labels are vizData\'s over the dataset',
    JSON.stringify(got.labels) === JSON.stringify(ref.data.labels), JSON.stringify([got.labels, ref.data.labels]));
  ok('differential: …and every value agrees with Object.is',
    got.series.length === 1 && got.series[0].values.length === ref.data.series[0].values.length
    && got.series[0].values.every((v: number, i: number) => Object.is(v, ref.data.series[0].values[i])), JSON.stringify([got.series, ref.data.series]));
  ok('run: a chart cell says how many rows it charted', r5.ok && r5.rowCount === 300);

  const table = await run.cellTable(pid, nb!, U(2));
  ok('cellTable: a SQL cell\'s WHOLE result, past the 500-row preview limit is not hit here', table.ok && table.rows.length === 300);

  // A param edit is a different key; a dataset write is a different key.
  const nb2 = await store.updateNotebook(pid, nb!.id, { cells: nb!.cells.map((c: any) => (c.id === U(1) ? { ...c, value: 80 } : c)) });
  const r3b: any = await run.runCell(pid, nb2!, U(3));
  ok('cache: a new parameter value is a new key and a fresh run', r3b.ok && !r3b.cached && r3b.key !== r3.key && r3b.rows.length > 0);
  await datasets.updateDatasetData(pid, sales!.id, { columns: full!.columns, rows: data.slice(0, 100) });
  const r3c: any = await run.runCell(pid, nb2!, U(3));
  ok('cache: a dataset write moves the key — never a stale answer', r3c.ok && !r3c.cached && r3c.key !== r3b.key);

  // Blocked cells.
  const bad = await store.updateNotebook(pid, nb!.id, { cells: [...nb2!.cells, sql(7, 'select [[nope]]')] });
  const r7: any = await run.runCell(pid, bad!, U(7));
  ok('run: an unknown [[name]] is refused with the graph\'s message', !r7.ok && r7.error === '[[nope]] has no parameter cell above it.', JSON.stringify(r7));
  const unset = await store.updateNotebook(pid, nb!.id, { cells: bad!.cells.map((c: any) => (c.id === U(1) ? { ...c, value: null } : c)) });
  const r3u: any = await run.runCell(pid, unset!, U(3));
  ok('run: a parameter with no value says so', !r3u.ok && /\[\[min_amount\]\] has no value yet/.test(r3u.error), JSON.stringify(r3u));

  // Cancel.
  const ctl = new AbortController();
  ctl.abort();
  const rc: any = await run.runCell(pid, nb2!, U(2), ctl.signal);
  ok('cancel: an aborted run ends as cancelled', !rc.ok && rc.cancelled === true, JSON.stringify(rc));

  // A dataset saved from a cell, and its refresh.
  const t3 = await run.cellTable(pid, nb2!, U(3));
  const saved = t3.ok ? await datasets.saveDataset(pid, {
    name: 'Big orders', sourceKind: 'notebook', columns: t3.columns, rows: t3.rows,
    origin: { kind: 'notebook', notebookId: nb!.id, cellId: U(3), deps: t3.deps },
  }) : null;
  const meta = saved ? await datasets.getDatasetMeta(pid, saved.id) : null;
  ok('origin: a dataset saved from a cell keeps its notebook origin', !!meta && (meta.origin as any).kind === 'notebook' && (meta.origin as any).cellId === U(3));
  const summary = (await datasets.listDatasets(pid)).find((d) => d.id === (saved && saved.id));
  ok('origin: its summary names its inputs for lineage and push refresh',
    !!summary && summary.originKind === 'notebook' && JSON.stringify(summary.originDeps) === JSON.stringify([sales!.id]));
  await store.updateNotebook(pid, nb!.id, { cells: nb2!.cells.map((c: any) => (c.id === U(1) ? { ...c, value: 0 } : c)) });
  const rf = saved ? await refresh.refreshDataset(pid, saved.id) : null;
  const after = saved ? await datasets.getDataset(pid, saved.id) : null;
  ok('refresh: re-runs the cell from the notebook as saved', !!rf && rf.ok && !!after && after.rows.length > 0 && after.lastRefreshStatus === 'ok', JSON.stringify(rf && !rf.ok && rf));
  await store.deleteNotebook(pid, nb!.id);
  const gone = saved ? await refresh.refreshDataset(pid, saved.id) : null;
  ok('refresh: a deleted notebook fails cleanly and keeps the rows',
    !!gone && !gone.ok && /deleted/.test(gone.error) && ((await datasets.getDataset(pid, saved!.id))!.rows.length === after!.rows.length));
}

main()
  .then(() => {
    duck.shutdown();
    Module._load = origLoad;
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    if (failureCount()) console.error('\n' + failureCount() + ' notebook check(s) FAILED');
    else console.log('\nAll notebook checks passed.');
    finish();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
