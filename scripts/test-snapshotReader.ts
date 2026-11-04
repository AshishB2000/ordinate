// A metric's `snapshot` (semantic layer part 1, PR 02a) — the READER half.
//
// A LATER release writes `snapshot: {column, take}` (a stock count is the last day's value, not a sum over
// every day). A pod of THIS release that reads such a record must (1) keep it through every re-save, duplicate
// and tree save, and (2) never draw the plain sum over every date in its place: every figure path that would
// do so refuses or shows no figure, until the release that computes snapshots removes the refusals.
//
//   npm run build:ts && node scripts/test-snapshotReader.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-snapshot-reader-'));

const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const driverShape: typeof import('../src/analysis/driverShape') = require('../src/analysis/driverShape');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const api: typeof import('../src/api/metrics') = require('../src/api/metrics');
const ipcTree: typeof import('../src/ipc/metricTree') = require('../src/ipc/metricTree');
const treeRef: typeof import('../src/analysis/metricTreeJs') = require('../src/analysis/metricTreeJs');
const treeMsg: typeof import('../src/analysis/metricTreeMessages') = require('../src/analysis/metricTreeMessages');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const stories: typeof import('../src/ipc/stories') = require('../src/ipc/stories');
const embedLock: typeof import('../src/publish/embedLock') = require('../src/publish/embedLock');
const ipcScenarios: typeof import('../src/ipc/scenarios') = require('../src/ipc/scenarios');
const ipcTemplates: typeof import('../src/ipc/templates') = require('../src/ipc/templates');
const scenarioResolve: typeof import('../src/analysis/scenarioResolve') = require('../src/analysis/scenarioResolve');
const scenarioModel: typeof import('../src/analysis/scenarioModel') = require('../src/analysis/scenarioModel');
const planExec: typeof import('../src/ai/planExec') = require('../src/ai/planExec');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const versions: typeof import('../src/ipc/versions') = require('../src/ipc/versions');

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const COLS = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'units', type: 'number' }] as any; // any: the dataset column shape, as the sibling suites build it

void (async () => {
  await projects.init();
  ipcVisuals.register();
  ipcScenarios.register();
  ipcTemplates.register();
  const viz = handlers.get('visual:data');
  ok('the shipped handler is registered', !!viz);
  if (!viz) return finish();
  const pid = (await projects.createProject('Snapshot')).id;
  const rows: Array<[string, string, number]> = [];
  for (let i = 0; i < 40; i += 1) rows.push([`2024-0${i < 20 ? 1 : 2}-${String((i % 20) + 1).padStart(2, '0')}`, i % 2 ? 'East' : 'West', 10 + i]);
  const ds = (await datasets.saveDataset(pid, { name: 'Stock', sourceKind: 'csv', columns: COLS, rows } as any))!; // any: the sibling suites' save shape

  const def = { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } };
  ok('sanitize keeps a snapshot', JSON.stringify(metrics.sanitizeDefinition(def)) === '{"column":"units","aggregation":"sum","snapshot":{"column":"day","take":"last"}}');
  ok('no snapshot: byte-identical to today', JSON.stringify(metrics.sanitizeDefinition({ column: 'units', aggregation: 'sum' })) === '{"column":"units","aggregation":"sum"}');
  for (const bad of [{ column: '', take: 'last' }, { column: 'day', take: 'middle' }, { column: 7, take: 'last' }, 'day', null]) {
    ok(`NEGATIVE CONTROL: sanitize drops ${JSON.stringify(bad)}`, !('snapshot' in metrics.sanitizeDefinition({ column: 'units', aggregation: 'sum', snapshot: bad })));
  }
  ok('a formula never carries one', JSON.stringify(metrics.sanitizeDefinition({ formula: '[A]', snapshot: def.snapshot })) === '{"formula":"[A]"}');

  // A record a newer pod wrote. The store API is what step 07's writer calls.
  const m = (await metrics.saveMetric(pid, { name: 'Stock', datasetId: ds.id, definition: def }))!;
  await metrics.updateMetric(pid, m.id, { name: 'Stock on hand' });
  ok('a rename that sends only the name keeps it', isDeepStrictEqual((await metrics.getMetric(pid, m.id))!.definition, def));
  // The release-1 editor sends every field on every save, its definition as {column, aggregation} (MetricEditor.tsx).
  await metrics.updateMetric(pid, m.id, { name: 'Stock on hand', definition: { column: 'units', aggregation: 'sum' }, filters: [], format: { kind: 'number', decimals: 0 } });
  ok('a rename as the editor sends it (the full simple definition, no snapshot key) keeps it', isDeepStrictEqual((await metrics.getMetric(pid, m.id))!.definition, def));
  await metrics.updateMetric(pid, m.id, { tree: { relation: 'sum', children: [{ metricId: U1 }, { metricId: U2 }] } }, undefined, 'metricTree');
  ok('a tree save keeps it', isDeepStrictEqual((await metrics.getMetric(pid, m.id))!.definition, def));
  ok('a duplicate keeps it', isDeepStrictEqual((await metrics.duplicateMetric(pid, m.id))!.definition, def));
  ok('the contract still refuses a writer', !api.metrics['metric:save'].input.safeParse({ projectId: pid, input: { name: 'x', datasetId: ds.id, definition: def } }).success);

  ok('no figure until step 07, never the sum over every date', (await ipcMetrics.resolveMetric(pid, m.id))!.value === null);
  const plain = (await metrics.saveMetric(pid, { name: 'Units', datasetId: ds.id, definition: { column: 'units', aggregation: 'sum' } }))!;
  ok('NEGATIVE CONTROL: the same column without a snapshot has a figure', typeof (await ipcMetrics.resolveMetric(pid, plain.id))!.value === 'number');

  const f = (await metrics.saveMetric(pid, { name: 'Double', datasetId: ds.id, definition: { formula: '[Stock on hand] * 2' } }))!;
  const c = await viz(null, { projectId: pid, datasetId: ds.id, encoding: { category: 'region', values: [{ column: 'Double', aggregation: 'sum', metricId: f.id }] } });
  ok('a chart over it says why', c.ok === false && c.error === msg.measureSnapshotPending('Stock on hand'), JSON.stringify(c).slice(0, 300));
  const fp = (await metrics.saveMetric(pid, { name: 'Double units', datasetId: ds.id, definition: { formula: '[Units] * 2' } }))!;
  const cp = await viz(null, { projectId: pid, datasetId: ds.id, encoding: { category: 'region', values: [{ column: 'Double units', aggregation: 'sum', metricId: fp.id }] } });
  ok('NEGATIVE CONTROL: the same chart over a metric without a snapshot draws', cp.ok === true, JSON.stringify(cp).slice(0, 300));

  const shape = (d: unknown) => driverShape.metricShape(ds.id, COLS, d as never, [], new Map());
  ok('key drivers refuse it', shape(def).kind === 'none');
  ok('NEGATIVE CONTROL: key drivers take the same column without a snapshot', shape({ column: 'units', aggregation: 'sum' }).kind === 'additive');

  // ── every other reader of a SIMPLE definition (the metricId on a chart, a tree part, a KPI-shaped lookup) ──
  const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const drawn = (encoding: Record<string, unknown>) => viz(null, { projectId: pid, datasetId: ds.id, encoding });
  const pending = msg.measureSnapshotPending('Stock on hand');
  const direct = await drawn({ category: 'region', values: [{ column: 'units', aggregation: 'sum', metricId: m.id }] });
  ok('chart door: a measure that is a simple snapshot metric is refused', direct.ok === false && direct.error === pending, JSON.stringify(direct).slice(0, 300));
  const directPlain = await drawn({ category: 'region', values: [{ column: 'units', aggregation: 'sum', metricId: plain.id }] });
  ok('NEGATIVE CONTROL: the same chart over the metric without a snapshot draws its total', directPlain.ok === true && typeof directPlain.data.series[0].values[0] === 'number');
  const asPivot = (metricId: string) => drawn({ values: [], pivot: { rows: [{ column: 'region' }], columns: [], values: [{ column: 'units', aggregation: 'sum', metricId }], totals: { rows: true, columns: true, grand: true } } });
  const pivotSnap = await asPivot(m.id);
  ok('chart door: a pivot value that is a snapshot metric is refused', pivotSnap.ok === false && pivotSnap.error === pending, JSON.stringify(pivotSnap).slice(0, 300));
  ok('NEGATIVE CONTROL: the same pivot over the metric without a snapshot draws', (await asPivot(plain.id)).ok === true);
  const split = (second: string) => drawn({ category: 'region', series: 'day', values: [{ column: 'units', aggregation: 'sum', metricId: plain.id }, { column: 'units', aggregation: 'sum', metricId: second }] });
  ok('NEGATIVE CONTROL: with a split only the first measure is drawn, so a snapshot second one is not refused', (await split(m.id)).ok === true);

  // The metric tree: the door shows no figure and says why; its JS reference agrees with it, Object.is.
  const feb = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-02-01', to: '2024-02-29' } }] as any[]; // any: the filter step wire shape
  const jan = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-01-01', to: '2024-01-31' } }] as any[];
  const hydrated = (await datasets.getDataset(pid, ds.id))!;
  const reference = async (id: string) => {
    const all = (await Promise.all((await metrics.listMetrics(pid)).map((x) => metrics.getMetric(pid, x.id)))) as Array<NonNullable<Awaited<ReturnType<typeof metrics.getMetric>>>>;
    return treeRef.treeJs({ columns: hydrated.columns, rows: hydrated.rows, metrics: all, tree: all.find((x) => x.id === id)!.tree as never, current: feb, previous: jan });
  };
  const tree = async (id: string): Promise<any> => ipcTree.computeTree(pid, id, { filters: feb, compare: { mode: 'previous_period' } }); // any: the reply is narrowed field by field below
  const withTree = async (name: string, definition: unknown, t: unknown) => {
    const x = (await metrics.saveMetric(pid, { name, datasetId: ds.id, definition }))!;
    await metrics.updateMetric(pid, x.id, { tree: t }, undefined, 'metricTree');
    return x;
  };
  const snapRoot = await withTree('Stock tree', def, { split: 'region' });
  const plainRoot = await withTree('Units tree', { column: 'units', aggregation: 'sum' }, { split: 'region' });
  const [rs, rp] = [await tree(snapRoot.id), await tree(plainRoot.id)];
  ok('tree door: a snapshot root has no figure and no split, and says why', rs.ok && rs.root.current === null && rs.root.previous === null && rs.root.display === '—' && rs.root.children.length === 0 && typeof rs.root.note === 'string', JSON.stringify(rs).slice(0, 300));
  const refS = await reference(snapRoot.id);
  ok('tree JS reference: the snapshot root agrees with the door (Object.is)', Object.is(refS.current, rs.root.current) && Object.is(refS.previous, rs.root.previous) && refS.children.length === 0, JSON.stringify(refS).slice(0, 300));
  const refP = await reference(plainRoot.id);
  ok('NEGATIVE CONTROL: the same tree without a snapshot has figures and segments, and the reference agrees (Object.is)',
    rp.ok && typeof rp.root.current === 'number' && rp.root.children.length > 0 && Object.is(refP.current, rp.root.current) && Object.is(refP.previous, rp.root.previous), JSON.stringify(rp).slice(0, 300));
  const snapPart = (await metrics.saveMetric(pid, { name: 'Stock part', datasetId: ds.id, definition: def }))!;
  const plainPart = (await metrics.saveMetric(pid, { name: 'Units part', datasetId: ds.id, definition: { column: 'units', aggregation: 'sum' } }))!;
  const sumOf = (a: string, b: string) => ({ relation: 'sum', children: [{ metricId: a }, { metricId: b }] });
  const partSnap = await withTree('Parts with a snapshot', { column: 'units', aggregation: 'sum' }, sumOf(snapPart.id, plainPart.id));
  const partPlain = await withTree('Parts without one', { column: 'units', aggregation: 'sum' }, sumOf(plainPart.id, plainPart.id));
  const [ps, pp] = [await tree(partSnap.id), await tree(partPlain.id)];
  ok('tree door: a snapshot part has no figure, and its parent names it', ps.ok && ps.root.children[0].current === null && ps.root.children[0].display === '—' && ps.root.note === treeMsg.partMissing('Stock part'), JSON.stringify(ps).slice(0, 300));
  const refPart = await reference(partSnap.id);
  ok('tree JS reference: the snapshot part agrees with the door (Object.is)', Object.is(refPart.children[0].current, ps.root.children[0].current) && Object.is(refPart.children[0].previous, ps.root.children[0].previous));
  ok('NEGATIVE CONTROL: the same parts without a snapshot have figures and no note', pp.ok && typeof pp.root.children[0].current === 'number' && pp.root.note === undefined, JSON.stringify(pp).slice(0, 300));

  // The Assistant's metric vocabulary, a plan's, a template's role mapping, a story's reuse, an embed's lock.
  const named = (await answers.specMetrics(pid)).map((x) => x.id);
  ok('answers: a snapshot metric is not offered to a spec', !named.includes(m.id) && named.includes(plain.id), JSON.stringify(named));
  const planned = (await planExec.loadProjectCtx(pid)).metrics.map((x) => x.id);
  ok('plans: a plan step cannot name a snapshot metric', !planned.includes(m.id) && planned.includes(plain.id), JSON.stringify(planned));
  // A fresh project per case: the plan's inline KPI is tied to a saved metric with the same column and total, if one exists.
  const kpiBlock = async (definition: unknown) => {
    const p2 = (await projects.createProject('Story KPI')).id;
    const d2 = (await datasets.saveDataset(p2, { name: 'Stock', sourceKind: 'csv', columns: COLS, rows } as any))!; // any: as above
    const saved = (await metrics.saveMetric(p2, { name: 'Stock', datasetId: d2.id, definition }))!;
    const out = await stories.blocksFromRecords(p2, { name: 'S', sheets: [{ name: 'A', cards: [{ type: 'metric', metric: { datasetId: d2.id, column: 'units', aggregation: 'sum' } }] }] }, '');
    const id = (out.find((b) => b.kind === 'metric') as { metricId?: string } | undefined)?.metricId;
    return { saved, tied: id ? await metrics.getMetric(p2, id) : null };
  };
  const forSnap = await kpiBlock(def);
  ok('stories: an inline KPI is not tied to a snapshot metric of the same column (a new plain one is made)', !!forSnap.tied && forSnap.tied.id !== forSnap.saved.id && !('snapshot' in forSnap.tied.definition), JSON.stringify(forSnap.tied));
  const forPlain = await kpiBlock({ column: 'units', aggregation: 'sum' });
  ok('NEGATIVE CONTROL: it is tied to a plain metric of the same column', !!forPlain.tied && forPlain.tied.id === forPlain.saved.id);
  const open = { covers: async () => true } as never; // any lock that covers the dataset
  ok('embed: a KPI of a snapshot metric is not allowed under a lock', (await embedLock.metricAllowed(open, pid, { metricId: m.id, datasetId: ds.id, column: 'units' })) === false);
  ok('NEGATIVE CONTROL: the same KPI of the metric without a snapshot is allowed', (await embedLock.metricAllowed(open, pid, { metricId: plain.id, datasetId: ds.id, column: 'units' })) === true);

  // Scenarios: the picker leaves it out, and a driver nudging its column never re-sums it over every date.
  const listed = ((await handlers.get('scenario:metrics')!(null, { projectId: pid })) as Array<{ id: string }>).map((x) => x.id);
  ok('scenarios: the picker does not offer a snapshot metric', !listed.includes(m.id) && listed.includes(plain.id), JSON.stringify(listed));
  const run = await scenarioResolve.computeScenario(pid, { id: U(1), name: 't', baseMetricIds: [m.id, plain.id], drivers: scenarioModel.sanitizeDrivers([{ kind: 'pct', target: { column: 'units' }, value: 10 }]) });
  const row = (id: string) => run.metrics.find((x) => x.metricId === id)!;
  ok('scenarios: a snapshot metric under a driver has no figure', row(m.id).value === null && row(m.id).baseline === null, JSON.stringify(row(m.id)));
  ok('NEGATIVE CONTROL: the same column without a snapshot moves with the driver', typeof row(plain.id).value === 'number' && (row(plain.id).value as number) > (row(plain.id).baseline as number), JSON.stringify(row(plain.id)));

  // A template's measure role takes the metric's column only when the metric is a plain total.
  const ds2 = (await datasets.saveDataset(pid, { name: 'Stock 2', sourceKind: 'csv', columns: COLS, rows } as any))!; // any: as above
  const snapRev = (await metrics.saveMetric(pid, { name: 'Revenue', datasetId: ds.id, definition: { ...def } }))!;
  const plainRev = (await metrics.saveMetric(pid, { name: 'Revenue', datasetId: ds2.id, definition: { column: 'units', aggregation: 'sum' } }))!;
  const roleMetrics = async (datasetId: string): Promise<string[]> => {
    const r = await handlers.get('template:list')!(null, { projectId: pid, datasetId });
    return r.templates.flatMap((t: { matches: Array<{ metricId?: string }> }) => t.matches.map((x) => x.metricId)).filter(Boolean);
  };
  ok('templates: a role does not take a snapshot metric\'s column', !(await roleMetrics(ds.id)).includes(snapRev.id));
  ok('NEGATIVE CONTROL: the same name on a plain metric is taken by a role', (await roleMetrics(ds2.id)).includes(plainRev.id));

  // ── an edit through updateMetric: only an explicit null clears the snapshot ──
  const fresh = async (name: string, definition: unknown) => (await metrics.saveMetric(pid, { name, datasetId: ds.id, definition }))!;
  const editedWith = async (id: string, definition: unknown) => {
    await metrics.updateMetric(pid, id, { definition });
    return (await metrics.getMetric(pid, id))!.definition;
  };
  const cleared = await fresh('Clear me', def);
  ok('an update with `snapshot: null` clears it, and writes no key', JSON.stringify(await editedWith(cleared.id, { column: 'units', aggregation: 'sum', snapshot: null })) === '{"column":"units","aggregation":"sum"}');
  const replaced = await fresh('Replace me', def);
  ok('an update with a valid snapshot replaces it', isDeepStrictEqual(await editedWith(replaced.id, { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'first' } }), { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'first' } }));
  const junk = await fresh('Junk me', def);
  ok('an update with a malformed snapshot is not a clear: the stored one stays', isDeepStrictEqual(await editedWith(junk.id, { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'middle' } }), def));
  const toFormula = await fresh('Formula me', def);
  ok('a formula definition never carries one', JSON.stringify(await editedWith(toFormula.id, { formula: '[Units]', snapshot: def.snapshot })) === '{"formula":"[Units]"}');
  const aPlain = await fresh('Stays plain', { column: 'units', aggregation: 'sum' });
  const afterPlain = await editedWith(aPlain.id, { column: 'units', aggregation: 'avg' });
  ok('NEGATIVE CONTROL: a plain metric\'s update writes no snapshot key, in the record or on disk',
    JSON.stringify(afterPlain) === '{"column":"units","aggregation":"avg"}'
    && !fs.readFileSync(path.join(process.env.ORDINATE_LOCAL_DIR as string, 'projects', pid, 'metrics', aPlain.id + '.json'), 'utf8').includes('snapshot'));
  // Restoring a version that had no snapshot restores to none (the update that omits the key would keep the stored one).
  const restored = await fresh('Restore me', def);
  await versions.writeBack(pid, 'metric', restored.id, { name: 'Restore me', definition: { column: 'units', aggregation: 'sum' }, filters: [], format: { kind: 'number', decimals: 0 } });
  ok('restoring a version without a snapshot makes the metric plain again', JSON.stringify((await metrics.getMetric(pid, restored.id))!.definition) === '{"column":"units","aggregation":"sum"}');
  await versions.writeBack(pid, 'metric', restored.id, { name: 'Restore me', definition: def, filters: [], format: { kind: 'number', decimals: 0 } });
  ok('restoring a version that had one brings it back', isDeepStrictEqual((await metrics.getMetric(pid, restored.id))!.definition, def));

  // ── the alert job: a rule made from a snapshot metric's KPI keeps only its column and total ──
  const rule = (metric: Record<string, unknown>) => ({ name: 'Units above 0', datasetId: ds.id, metric: { column: 'units', aggregation: 'sum', ...metric }, compare: 'threshold', threshold: { op: '>', value: 0 } });
  const alertOn = await alertStore.testRule(pid, rule({ metricId: m.id }));
  ok('alerts: a rule on a snapshot metric reads no figure and does not fire', alertOn.ok && alertOn.value === null && alertOn.fire === false, JSON.stringify(alertOn));
  const alertPlain = await alertStore.testRule(pid, rule({ metricId: plain.id }));
  ok('NEGATIVE CONTROL: the same rule on a plain metric reads the total and fires', alertPlain.ok && typeof alertPlain.value === 'number' && alertPlain.fire === true, JSON.stringify(alertPlain));
  const alertBare = await alertStore.testRule(pid, rule({}));
  ok('NEGATIVE CONTROL: the same rule with no saved metric reads the total, as before', alertBare.ok && Object.is(alertBare.value, alertPlain.value), JSON.stringify(alertBare));
  const changeRule = { ...rule({ metricId: m.id }), compare: 'change', threshold: undefined, change: { pct: 10, direction: 'either', vs: 'previous_period', periodColumn: 'day' } };
  const alertChange = await alertStore.testRule(pid, changeRule);
  ok('alerts: a previous-period rule on a snapshot metric reads no figure either', alertChange.value === null && alertChange.previous === null && alertChange.fire === false, JSON.stringify(alertChange));

  finish();
})();
