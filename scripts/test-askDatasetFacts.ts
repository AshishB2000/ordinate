// An Assistant question on an open dataset or dashboard reads only what it needs (docs/assistant/00-design.md, "Scale
// rules", PR 4), through ../src/ipc/copilot `buildFacts`. No database: records are files, and without Postgres a viewer
// is restricted with no entitlement, so Mixed's rule on `salary` hides it from them (as test-metricHiddenOnce).
//
//   1. THE DIFFERENTIAL: the facts the model gets for a dataset — column summaries, quality issues and sample rows, as
//      text, ledger and provenance — are Object.is-equal between the resident read (../src/ipc/copilotTable
//      `residentTable`) and the hydrated reference (`hydratedTable`), for an admin and for a viewer salary is hidden
//      from, over numbers (dyadic, so float summation order cannot reach `mean`: statsResident's header), text, dates,
//      empties and values the engine must read as JS does (a leading U+FEFF, NBSP and tab cells, `007`, a tie for the
//      most common value). Each piece is compared on its own too, key sets included. NEGATIVE CONTROL: the viewer's
//      summaries read without the hidden column's file positions (statsResident `positions`) differ.
//   2. NEGATIVE CONTROL: with datasets.getDataset spied, the resident facts call it 0 times; the reference calls it.
//   3. The viewer's facts leave salary out, and count duplicate rows over the columns they see (more than the admin's).
//   4. A dashboard over 2 of 10 datasets, two metrics on each of the 10: for a question that names no metric,
//      resolveMetric runs only for the 2 datasets' metrics; for one that names "Revenue", also for at most
//      QUESTION_METRICS step 3 finds elsewhere (Q12). NEGATIVE CONTROL: factMetrics over every dataset resolves all 20.
//   5. A metric on the dashboard's dataset reads to the model as it did: its line is the old call's, word for word.
//
//   npm run build:ts && node scripts/test-askDatasetFacts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-askfacts-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const factMetricsMod: typeof import('../src/ipc/factMetrics') = require('../src/ipc/factMetrics');
const copilotTable: typeof import('../src/ipc/copilotTable') = require('../src/ipc/copilotTable');
const statsResident: typeof import('../src/engine/statsResident') = require('../src/engine/statsResident');
const metricsIpc: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const { savedScope }: typeof import('../src/ipc/copilotCards') = require('../src/ipc/copilotCards');
const { factsOf }: typeof import('../src/ai/hiddenFacts') = require('../src/ai/hiddenFacts');
const { metricLines, SAMPLE_ROWS }: typeof import('../src/ai/copilotFacts') = require('../src/ai/copilotFacts');

type Role = import('../src/server/context').Identity['user']['role'];
const HR_TEAM = '11111111-1111-4111-8111-111111111111';
let req = 0;
const as = <T>(role: Role, fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: `${role}@acme.test`, role }, org: { id: 'acme' } }, `f${++req}`, fn);

/** Structurally equal, leaves by Object.is, key sets included (a `min` absent is not a `min: undefined`). */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a).sort(), Object.keys(b).sort()];
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
const show = (v: unknown): string => JSON.stringify(v).slice(0, 500);

/** getDataset calls while `fn` runs. */
async function hydrations<T>(fn: () => Promise<T>): Promise<{ out: T; calls: number }> {
  const real = datasets.getDataset;
  let calls = 0;
  (datasets as { getDataset: unknown }).getDataset = (...a: Parameters<typeof real>) => { calls++; return real(...a); };
  try {
    return { out: await fn(), calls };
  } finally {
    (datasets as { getDataset: unknown }).getDataset = real;
  }
}

/** `fn` with the resident read off, so buildFacts takes the reference: the old JS path, whole. */
async function reference<T>(fn: () => Promise<T>): Promise<T> {
  const real = copilotTable.residentTable;
  (copilotTable as { residentTable: unknown }).residentTable = async () => null;
  try {
    return await fn();
  } finally {
    (copilotTable as { residentTable: unknown }).residentTable = real;
  }
}

const REGIONS = ['West', '\uFEFFSouth', 'East', '', '   ', '\u00A0', '\t', 'North', null]; // a leading BOM in the sample rows
const AMOUNTS = [3, 1.5, null, -0.5, 2.25, 10, 0, 4.75];
const CODES = ['007', '7', null, '0070', '007'];
type Cell = string | number | null;
/**
 * 1,000 rows, every one different even without salary (the cells' periods have no common multiple under 2,520), then 10
 * copies of the last 10: 8 differ from theirs only by salary, 2 are whole duplicates. 1,010 rows: past the metric door's
 * 1,000-row cost model (../src/ipc/dashboards RESIDENT_MIN_ROWS), so its metric is read in the engine as well.
 */
function mixedRows(): Cell[][] {
  const row = (i: number, salary: number): Cell[] => [
    REGIONS[i % 9], salary, AMOUNTS[i % 8], i % 7 === 3 ? null : `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, CODES[i % 5],
    i % 2 ? 'a' : 'b', // 505 each in the end: the tie goes to the first seen
    i % 5 ? 'same' : null, i % 3 ? null : 'x',
  ];
  const base = Array.from({ length: 1000 }, (_, i) => row(i, 10_000 + i));
  return [...base, ...base.slice(990).map((r, j) => (j < 8 ? [r[0], 20_000 + j, ...r.slice(2)] : r.slice()))];
}

async function datasetLeg(): Promise<void> {
  const { P, D } = await as('admin', async () => {
    const P = (await projects.createProject('Ask dataset facts'))!.id;
    const t = (name: string, type: 'text' | 'number' | 'date') => ({ name, type });
    const D = (await datasets.saveDataset(P, {
      name: 'Mixed', sourceKind: 'csv',
      // salary second: the columns after it are read at their own file positions, not shifted (statsResident `positions`).
      columns: [t('region', 'text'), t('salary', 'number'), t('amount', 'number'), t('day', 'date'), t('code', 'text'), t('tie', 'text'), t('constant', 'text'), t('sparse', 'text')],
      rows: mixedRows(),
    }))!.id;
    await metrics.saveMetric(P, { name: 'Amount', datasetId: D, definition: { column: 'amount', aggregation: 'sum' } });
    const planted = await rec.serialized(rec.datasetFilePath(P, D), (raw) => {
      raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'salary', visibleTo: [{ teamId: HR_TEAM }] }], 'admin@acme.test', new Date().toISOString());
      return true;
    });
    if (!planted) throw new Error('fixture: the column rule');
    return { P, D };
  });
  ok('fixture: Mixed is resident (its table is Parquet)', (await as('admin', () => datasets.getDatasetMeta(P, D)))?.resident === true);

  const issuesOf: Record<string, unknown[]> = {};
  const factsFor: Record<string, unknown> = {};
  for (const role of ['admin', 'viewer'] as const) {
    // Each piece, resident against the reference, in the scope buildFacts reads them in (../src/ai/hiddenFacts).
    const [fast, slow] = await as(role, () => factsOf(P, D, async (hidden) => [await copilotTable.residentTable(P, D, hidden), await copilotTable.hydratedTable(P, D, hidden)]));
    ok(`${role}: both paths read Mixed`, !!fast && !!slow);
    if (!fast || !slow) continue;
    issuesOf[role] = fast.issues;
    if (role === 'viewer') {
      // The columns after salary are read at their file positions: without them, one column early (salary as amount).
      const shifted = await as(role, () => factsOf(P, D, async (hidden) => {
        const src = await datasets.residentSource(P, D);
        return src && statsResident.computeColumnSummariesResident({ parquetPath: src.parquetPath, columns: src.columns.filter((c) => !hidden.has(c.name)) });
      }));
      ok('NEGATIVE CONTROL: without the file positions the viewer\'s summaries are wrong, and the comparison sees it', !!shifted && !same(shifted, slow.summaries));
    }
    ok(`${role}: the column summaries are the same, key for key, Object.is`, same(fast.summaries, slow.summaries), show([fast.summaries, slow.summaries]));
    ok(`${role}: …the quality issues`, same(fast.issues, slow.issues), show([fast.issues, slow.issues]));
    ok(`${role}: …the sample rows (the first ${SAMPLE_ROWS})`, fast.ds.rows.length === SAMPLE_ROWS && same(fast.ds.rows, slow.ds.rows.slice(0, SAMPLE_ROWS)), show([fast.ds.rows, slow.ds.rows.slice(0, SAMPLE_ROWS)]));
    ok(`${role}: …and the name, row count and columns`, same([fast.ds.name, fast.ds.rowCount, fast.ds.columns], [slow.ds.name, slow.ds.rowCount, slow.ds.columns]));

    // The whole facts block, through buildFacts, both ways.
    const ask = () => as(role, () => copilotIpc.buildFacts(P, { kind: 'dataset', id: D }, undefined, 'what is the amount?'));
    const quick = await hydrations(ask);
    const whole = await hydrations(() => reference(ask));
    ok(`${role}: the facts the model is sent are the same text, resident and reference`, Object.is(quick.out.text, whole.out.text), show([quick.out.text, whole.out.text]));
    ok(`${role}: …the same ledger and provenance, Object.is`, same(quick.out.ledger, whole.out.ledger) && same(quick.out.provenance, whole.out.provenance));
    ok(`${role}: the resident facts never load the table (getDataset: ${quick.calls} calls)`, quick.calls === 0);
    ok(`${role}: NEGATIVE CONTROL: the reference loads it (getDataset: ${whole.calls} calls)`, whole.calls > 0);
    const text = quick.out.text;
    factsFor[role] = { text, summaries: fast.summaries };
    ok(`${role}: the facts carry the figures (a dataset with every kind of column, a metric beside them)`,
      /Dataset: "Mixed" \(1010 rows, \d+ columns\)/.test(text) && text.includes('- amount (number): ') && text.includes('Data-quality notes:') && text.includes(`Sample rows (first ${SAMPLE_ROWS}):`) && text.includes('"Amount"') && /- tie \(text\): 2 distinct, 1010 non-empty, most common .*b.* \(505x\)/.test(text), text);
    ok(`${role}: salary is ${role === 'admin' ? 'in' : 'out of'} them`, text.includes('salary') === (role === 'admin'), text);
  }
  const dups = (list: unknown[] | undefined): number => Number(/(\d+) fully-duplicate/.exec(JSON.stringify(list))?.[1] ?? 0);
  ok('NEGATIVE CONTROL: the comparison tells the admin\'s facts and summaries from the viewer\'s', !same(factsFor.admin, factsFor.viewer));
  ok('the viewer\'s duplicate rows are counted over what they see: 10, the admin\'s 2', dups(issuesOf.viewer) === 10 && dups(issuesOf.admin) === 2, show(issuesOf));
}

async function dashboardLeg(): Promise<void> {
  const W = await as('admin', async () => {
    const P = (await projects.createProject('Ask dashboard facts'))!.id;
    const ids: string[] = [];
    const datasetOf = new Map<string, string>();
    for (let i = 0; i < 10; i++) {
      const d = (await datasets.saveDataset(P, { name: `Sales ${i}`, sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['West', 10 + i], ['East', 2 * i]] }))!.id;
      ids.push(d);
      for (const [name, definition] of [[`Revenue ${i}`, { column: 'amount', aggregation: 'sum' }], [`Orders ${i}`, { column: 'region', aggregation: 'count' }]] as const) {
        datasetOf.set((await metrics.saveMetric(P, { name, datasetId: d, definition }))!.id, d);
      }
    }
    const v = (await visuals.saveVisual(P, { name: 'Revenue by region', datasetId: ids[0], chartType: 'column', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } }))!;
    const kpi = [...datasetOf].find(([, d]) => d === ids[1])![0];
    const board = (await analysis.saveAnalysis(P, {
      name: 'Two datasets',
      sheets: [{ name: 'S1', cards: [
        { type: 'visual', layout: { x: 0, y: 0, w: 6, h: 4 }, visualId: v.id },
        { type: 'metric', layout: { x: 6, y: 0, w: 3, h: 2 }, metric: { datasetId: ids[1], column: 'amount', aggregation: 'sum', metricId: kpi } },
        { type: 'text', layout: { x: 0, y: 4, w: 12, h: 2 }, heading: 'Notes' },
      ] }],
    }))!;
    return { P, ids, datasetOf, board };
  });

  /** The datasets whose metrics resolveMetric was asked for while `fn` ran, and how many asks. */
  const resolved = async <T>(fn: () => Promise<T>): Promise<{ out: T; on: Set<string>; calls: number }> => {
    const real = metricsIpc.resolveMetric;
    const on = new Set<string>();
    let calls = 0;
    (metricsIpc as { resolveMetric: unknown }).resolveMetric = (...a: Parameters<typeof real>) => { calls++; on.add(W.datasetOf.get(a[1]) ?? '?'); return real(...a); };
    try {
      return { out: await fn(), on, calls };
    } finally {
      (metricsIpc as { resolveMetric: unknown }).resolveMetric = real;
    }
  };
  const Q = 'what is Revenue 0?';
  const two = new Set([W.ids[0], W.ids[1]]);
  // A question that names no metric: only the dashboard's datasets' metrics.
  const plain = await resolved(() => as('admin', () => copilotIpc.buildFacts(W.P, { kind: 'analysis', id: W.board.id }, undefined, 'what changed?')));
  ok(`a dashboard resolves only its 2 datasets' metrics (${plain.calls} resolveMetric calls)`, same([...plain.on].sort(), [...two].sort()) && plain.calls <= 5, show([...plain.on]));
  // One that names "Revenue": those too, and the few step 3 finds for it elsewhere (Q12), never more than QUESTION_METRICS.
  const asked = await resolved(() => as('admin', () => copilotIpc.buildFacts(W.P, { kind: 'analysis', id: W.board.id }, undefined, Q)));
  const extra = [...asked.on].filter((d) => !two.has(d));
  ok(`…and a question's metrics found elsewhere, at most ${factMetricsMod.QUESTION_METRICS} (${asked.calls} calls, ${extra.length} datasets more)`,
    [...two].every((d) => asked.on.has(d)) && extra.length > 0 && asked.calls <= plain.calls + factMetricsMod.QUESTION_METRICS, show([...asked.on]));
  const all = await resolved(() => as('admin', () => copilotIpc.factMetrics(W.P, new Set(W.ids), savedScope(W.board), Q)));
  ok(`NEGATIVE CONTROL: the old call (every dataset's metrics) resolves all 20 (${all.calls} calls)`, all.on.size === 10 && all.calls === 20 && all.out.length === 20);

  // The model's line for a metric on the dashboard's dataset, under the old call: in the new facts, word for word.
  const old = all.out.find((m) => m.name === 'Revenue 0');
  const line: string[] = [];
  if (old) metricLines(line, [], [old]);
  const text = asked.out.text;
  ok('a metric on the dashboard\'s dataset reads to the model exactly as under the old call', !!old && text.split('\n').includes(line[2]), show([line, text]));
  ok('…and with a question that names none, one on a dataset the dashboard does not use is not in its facts', !plain.out.text.includes('Revenue 5') && all.out.some((m) => m.name === 'Revenue 5'));
}

void (async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  try {
    await as('admin', () => projects.init());
    await datasetLeg();
    await dashboardLeg();
  } catch (err) {
    ok('the suite ran', false, err instanceof Error ? err.stack : err);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  }
})();
