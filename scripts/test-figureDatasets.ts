// figureDatasets(source) — the datasets a send's figures can come from, which
// deliver() computes itself and item 5 refuses policy datasets on
// (docs/email/00-design.md §2). Records on disk; no Postgres, no network.
//
// Each case is its own dashboard (or alert rule), so the set it must give is
// exact: an over-approximation is the goal, but a dataset the source cannot
// reach is a bug too.
//
//   lineage     composed(B), Prepare lookup_join(B), a sql origin's deps
//               (NEGATIVE CONTROL: the graph without the new edge misses it)
//   relations   a related dataset, and THAT one's own upstream
//   metrics     a formula KPI naming a metric on another dataset; an analytics
//               overlay over a saved metric
//   walk        a parameter's option dataset, an inline visual, a
//               categoryDatasetId
//   alert       a rule's dataset and its saved metric's upstream
//   edges       a test is []; a missing root throws; deliver() refuses a gone
//               dashboard as compute_failed, before reading any channel secret
//   memo        one read per source for all the channels of a run (control:
//               without the memo, one per channel); a failed read memoised
//   control     a plain dashboard gives exactly its one dataset
//
//   npm run build:ts && node scripts/test-figureDatasets.js

export {}; // module scope
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { finish, ok } from './selfcheck';

const context: typeof import('../src/server/context') = require('../src/server/context');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const lineage: typeof import('../src/analysis/lineage') = require('../src/analysis/lineage');
const fd: typeof import('../src/server/subscriptions/figureDatasets') = require('../src/server/subscriptions/figureDatasets');
const deliverMod: typeof import('../src/server/subscriptions/deliver') = require('../src/server/subscriptions/deliver');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-figds-'));
const DEV = { user: { email: 'dev@local', role: 'admin' as const }, org: { id: 'default' } };
const COLS = [{ name: 'k', type: 'text' as const }, { name: 'v', type: 'number' as const }];
const ROWS: Array<[string, number]> = [['a', 1], ['b', 2]];
const same = (a: string[], b: string[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function main(): Promise<void> {
  context.enterServerMode(DATA);
  await context.runInContext(DEV, 'figds', async () => {
    const pid = (await projects.createProject('Figures')).id;
    const ds = async (name: string, origin?: unknown): Promise<string> => {
      const d = await datasets.saveDataset(pid, { name, sourceKind: 'csv', columns: COLS, rows: ROWS, ...(origin ? { origin } : {}) });
      if (!d) throw new Error(`dataset ${name}`);
      return d.id;
    };
    const card = (type: string, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x: 0, y: 0, w: 3, h: 4 }, ...extra });
    const kpi = (datasetId: string, extra: object = {}) => card('metric', { metric: { datasetId, column: 'v', aggregation: 'sum', ...extra } });
    const dash = async (cards: object[], extra: object = {}): Promise<string> => {
      const a = await analysis.saveAnalysis(pid, { name: 'D', sheets: [{ name: 'S', cards }], ...extra } as never);
      if (!a) throw new Error('analysis');
      return a.id;
    };
    const of = (analysisId: string): Promise<string[]> => fd.figureDatasets({ kind: 'dashboard', projectId: pid, analysisId });
    const visual = async (datasetId: string, extra: object = {}): Promise<string> => {
      const v = await visuals.saveVisual(pid, { name: 'V', datasetId, chartType: 'bar', encoding: { category: 'k', values: [{ column: 'v', aggregation: 'sum' }] }, filters: [], ...extra } as never);
      if (!v) throw new Error('visual');
      return v.id;
    };

    // ── Control: a plain dashboard ─────────────────────────────────────────
    const plain = await ds('Plain');
    const plainDash = await dash([card('visual', { visualId: await visual(plain) })]);
    ok('NEGATIVE CONTROL: a plain dashboard gives exactly its one dataset', same(await of(plainDash), [plain]), await of(plainDash));

    // ── Lineage ────────────────────────────────────────────────────────────
    const base1 = await ds('Base1');
    const joinB = await ds('JoinB');
    const composed = await ds('Composed', { kind: 'composed', baseId: base1, joins: [{ datasetId: joinB, mode: 'join', on: { left: 'k', right: 'k' } }] });
    ok('composed(B): a card on it includes B and its base', same(await of(await dash([kpi(composed)])), [composed, base1, joinB]));

    const lookB = await ds('LookB');
    const looked = await ds('Looked');
    const stepped = await datasets.updateSteps(pid, looked, [{ type: 'lookup_join', datasetId: lookB, leftKey: 'k', rightKey: 'k', columns: ['v'], prefix: 'b_' }]);
    ok('lookup_join(B): the step was kept', !!stepped && (stepped.dataset.steps ?? []).some((s) => s.type === 'lookup_join'));
    ok('lookup_join(B): a card on it includes B', same(await of(await dash([kpi(looked)])), [looked, lookB]));

    const sqlDep = await ds('SqlDep');
    const sqlDs = await ds('Sql', { kind: 'sql', sql: 'select * from sqldep', deps: [sqlDep] });
    ok('a sql origin\'s deps: a card on it includes them', same(await of(await dash([kpi(sqlDs)])), [sqlDs, sqlDep]));
    const meta = await datasets.getDatasetMeta(pid, sqlDs);
    if (!meta) throw new Error('sql dataset meta');
    const up = (input: import('../src/analysis/lineage').LineageInput): boolean => lineage.buildGraph(input).edges.some((e) => e.from === `dataset:${sqlDep}` && e.to === `dataset:${sqlDs}`);
    const others = { visuals: [], dashboards: [], metrics: [], reports: [], alerts: [] };
    const depMeta = await datasets.getDatasetMeta(pid, sqlDep);
    if (!depMeta) throw new Error('dep dataset meta');
    ok('the lineage edge for a sql origin exists', up({ datasets: [meta, depMeta], ...others }));
    ok('NEGATIVE CONTROL: without that origin the graph has no such edge', !up({ datasets: [{ ...meta, origin: { kind: 'url', url: 'https://x.test/a.csv' } }, depMeta], ...others }));

    // ── Relationships ──────────────────────────────────────────────────────
    const relA = await ds('RelA');
    const relUp = await ds('RelUp');
    const relB = await ds('RelB', { kind: 'composed', baseId: relUp, joins: [{ datasetId: plain, mode: 'join', on: { left: 'k', right: 'k' } }] });
    const saved = await rels.saveRelationship(pid, { from: { datasetId: relA, column: 'k' }, to: { datasetId: relB, column: 'k' }, cardinality: 'many_to_one' });
    ok('a relationship was saved', !!saved);
    ok('a related dataset, and its own upstream, are included', same(await of(await dash([kpi(relA)])), [relA, relB, relUp, plain]));

    // ── Metrics ────────────────────────────────────────────────────────────
    const mDs1 = await ds('MetricDs1');
    const mDs2 = await ds('MetricDs2');
    const m1 = await metrics.saveMetric(pid, { name: 'Gross', datasetId: mDs1, definition: { column: 'v', aggregation: 'sum' }, format: { kind: 'number', decimals: 0 } } as never);
    const m2 = await metrics.saveMetric(pid, { name: 'Doubled', datasetId: mDs2, definition: { formula: '[Gross] * 2' }, format: { kind: 'number', decimals: 0 } } as never);
    if (!m1 || !m2) throw new Error('metrics');
    ok('a formula KPI includes the dataset of the metric it names', same(await of(await dash([kpi(mDs2, { metricId: m2.id })])), [mDs2, mDs1]));
    const anDs = await ds('AnalyticsDs');
    const anMetricDs = await ds('AnalyticsMetricDs');
    const anMetric = await metrics.saveMetric(pid, { name: 'Target', datasetId: anMetricDs, definition: { column: 'v', aggregation: 'avg' }, format: { kind: 'number', decimals: 0 } } as never);
    const anVis = await visual(anDs, { analytics: [{ id: crypto.randomUUID(), kind: 'reference', value: { type: 'metric', metricId: anMetric?.id } }] });
    const kept = await visuals.getVisual(pid, anVis);
    ok('the analytics overlay was kept on the visual', JSON.stringify(kept).includes(String(anMetric?.id)));
    ok('an analytics overlay over a saved metric includes that metric\'s dataset', same(await of(await dash([card('visual', { visualId: anVis })])), [anDs, anMetricDs]));

    // ── The walk ───────────────────────────────────────────────────────────
    const paramDs = await ds('ParamDs');
    const kpiDs = await ds('KpiDs');
    const pDash = await dash([kpi(kpiDs)], { parameters: [{ id: crypto.randomUUID(), name: 'region', kind: 'list', value: 'a', list: { datasetId: paramDs, column: 'k' } }] });
    const pRec = await analysis.getAnalysis(pid, pDash);
    ok('the parameter\'s option dataset was kept', JSON.stringify(pRec?.parameters ?? []).includes(paramDs));
    ok('a parameter over another dataset includes it', same(await of(pDash), [kpiDs, paramDs]));
    const inlineDs = await ds('InlineDs');
    const iDash = await dash([card('visual', { visual: { name: 'Inline', datasetId: inlineDs, chartType: 'bar', encoding: { category: 'k', values: [{ column: 'v', aggregation: 'sum' }] }, filters: [] } })]);
    ok('an inline visual\'s dataset is included', (await of(iDash)).includes(inlineDs));
    const catDs = await ds('CategoryDs');
    const catVis = await visual(plain, { encoding: { category: 'k', categoryDatasetId: catDs, values: [{ column: 'v', aggregation: 'sum' }] } });
    ok('a categoryDatasetId is included', (await of(await dash([card('visual', { visualId: catVis })]))).includes(catDs));

    // ── Alerts ─────────────────────────────────────────────────────────────
    const alertDs = await ds('AlertDs');
    const rule = await alertStore.saveRule(pid, { name: 'R', datasetId: alertDs, metric: { column: 'v', aggregation: 'sum', metricId: m2.id }, compare: 'threshold', threshold: { op: '>', value: 1 }, enabled: true });
    if (!rule) throw new Error('rule');
    const alertSet = await fd.figureDatasets({ kind: 'alert', projectId: pid, ruleId: rule.id });
    ok('an alert rule: its dataset and its saved metric\'s upstream', same(alertSet, [alertDs, mDs2, mDs1]), alertSet);

    // ── Edges ──────────────────────────────────────────────────────────────
    ok('a test send reads no dataset', same(await fd.figureDatasets({ kind: 'test' }), []));
    const gone = await fd.figureDatasets({ kind: 'dashboard', projectId: pid, analysisId: crypto.randomUUID() }).then(() => 'resolved', () => 'threw');
    ok('a dashboard that is gone throws', gone === 'threw');
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 60; i++) { cur.x = {}; cur = cur.x as Record<string, unknown>; }
    let tooDeep = '';
    try { fd.collectIds(deep, { all: new Set(), datasets: new Set(), visuals: new Set() }); } catch (err) { tooDeep = (err as Error).message; }
    ok('a record nested past the bound throws rather than reading half of it', tooDeep.includes('too deep'));
    const channel = { id: crypto.randomUUID(), name: '#x', kind: 'slack' as const, createdBy: 'dev@local', createdAt: '', updatedAt: '' };
    const r = await deliverMod.deliver(channel, { kind: 'dashboard', projectId: pid, analysisId: crypto.randomUUID(), message: {} as never });
    ok('deliver: a gone dashboard is compute_failed — refused before any channel secret is read', r.ok === false && r.code === 'compute_failed', r);

    // ── One read per source per run, however many channels ─────────────────
    const real = fd.figureDatasets;
    let reads = 0;
    (fd as { figureDatasets: typeof real }).figureDatasets = async (d) => { reads++; return real(d); };
    const src = { kind: 'dashboard' as const, projectId: pid, analysisId: plainDash, message: {} as never };
    const five = Array.from({ length: 5 }, () => ({ ...channel, id: crypto.randomUUID() }));
    const memo: import('../src/server/subscriptions/deliver').DatasetsMemo = new Map();
    for (const c of five) await deliverMod.deliver(c, src, memo);
    const once = reads;
    reads = 0;
    for (const c of five) await deliverMod.deliver(c, src);
    ok(`memo: 5 channels of one run read the source once (${once}); NEGATIVE CONTROL: without the memo, 5 times (${reads})`, once === 1 && reads === 5);
    reads = 0;
    const goneSrc = { ...src, analysisId: crypto.randomUUID() };
    const goneMemo: import('../src/server/subscriptions/deliver').DatasetsMemo = new Map();
    const refusals: string[] = [];
    for (const c of five) refusals.push((await deliverMod.deliver(c, goneSrc, goneMemo)).code);
    ok('memo: a failed read is remembered too — every channel refuses alike, one read', reads === 1 && refusals.every((x) => x === 'compute_failed'));
    (fd as { figureDatasets: typeof real }).figureDatasets = real;
  });
}

main().then(finish, (err) => {
  ok('suite ran', false, err);
  finish();
});
