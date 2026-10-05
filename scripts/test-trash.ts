// Self-check for the Trash — src/app/trash.ts over src/app/trashStore.ts, and
// the alert rule's round trip through alertStore.deleteRule / restoreRule.
//
// Real modules, real disk (userData in a temp dir). The
// properties that fail silently get the attention:
//
//   1. A DELETE IS A MOVE: the record leaves every lister at once, and a
//      dataset's Parquet files leave the live tree with it.
//   2. CASCADE: a dataset takes its visuals along, and restoring the dataset
//      brings exactly those back.
//   3. REVERSE CASCADE: restoring a visual whose dataset is in the trash brings
//      the dataset back too — and only the dataset.
//   4. PURGE BY DATE: 30 days, not 29; version history goes with the record.
//   5. PATH GUARDS: no id reaches a path unchecked.
//
//   npm run build:ts && node scripts/test-trash.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-trash-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// ponytail: compiled siblings of the real modules.
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const reportSpec: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const store: typeof import('../src/app/trashStore') = require('../src/app/trashStore');

const DAY = 86_400_000;
const ids = (list: { id: string }[]): string[] => list.map((x) => x.id).sort();

async function main(): Promise<void> {
  await projects.init();
  const pid = (await projects.createProject('Trash')).id;
  const projDir = path.join(tmpUserData, 'projects', pid);

  const mk = async (name: string) => {
    const d = await datasets.saveDataset(pid, {
      name, sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'sales', type: 'number' }],
      rows: [['East', 10], ['West', 20], ['West', 5]],
    } as never);
    if (!d) throw new Error('dataset not saved');
    return d;
  };
  const D = await mk('Orders');
  const other = await mk('Other');
  const vis = async (datasetId: string, name: string) => {
    const v = await visuals.saveVisual(pid, {
      name, datasetId, chartType: 'column',
      encoding: { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] },
    });
    if (!v) throw new Error('visual not saved');
    return v;
  };
  const V1 = await vis(D.id, 'Sales by region');
  const V2 = await vis(D.id, 'Sales again');
  const V3 = await vis(other.id, 'Unrelated');

  // ── 1 + 2: a dataset delete is a move, and takes its visuals ────────────────
  let res = await trash.trashRecord(pid, 'dataset', D.id);
  ok('deleting a dataset succeeds and names it', res.ok && res.name === 'Orders', JSON.stringify(res));
  ok('…taking its two visuals along (and only those)', res.cascaded === 2, JSON.stringify(res));
  ok('…the dataset is gone from every lister',
    !(await datasets.listDatasets(pid)).some((d) => d.id === D.id) && (await datasets.getDatasetMeta(pid, D.id)) === null);
  ok('…its visuals are gone from the gallery, the unrelated one is not',
    JSON.stringify(ids(await visuals.listVisuals(pid))) === JSON.stringify([V3.id]));
  ok('…and its Parquet left the live tree for the trash',
    !fs.existsSync(path.join(projDir, 'datasets', D.id + '.parquet'))
    && fs.existsSync(path.join(projDir, 'trash', 'dataset', D.id + '.parquet')));
  let items = await trash.list(pid);
  ok('the trash lists the dataset and both visuals', items.length === 3, JSON.stringify(items));
  ok('…the visuals marked as deleted WITH the dataset',
    items.filter((e) => e.type === 'visual').every((e) => e.deletedWith === D.id));
  ok('…each with 30 days left', items.every((e) => e.daysLeft === 30), JSON.stringify(items.map((e) => e.daysLeft)));
  ok('…and deletedAt is stamped on the record itself',
    typeof (await store.readEntry(pid, 'dataset', D.id)).deletedAt === 'string');

  let back = await trash.restore(pid, 'dataset', D.id);
  ok('restoring the dataset succeeds', back.ok, JSON.stringify(back));
  ok('…and brings exactly its two visuals back with it',
    back.restored[0].id === D.id && JSON.stringify(ids(back.restored.slice(1))) === JSON.stringify([V1.id, V2.id].sort()),
    JSON.stringify(back.restored));
  const rows = await datasets.getDataset(pid, D.id);
  ok('…its table reads again, rows intact', !!rows && rows.rowCount === 3 && rows.rows.length === 3);
  ok('…the trash is empty again', (await trash.list(pid)).length === 0);
  ok('…with no deletedAt left on the live record', !('deletedAt' in (JSON.parse(fs.readFileSync(path.join(projDir, 'datasets', D.id + '.json'), 'utf8')))));

  // ── 3: reverse cascade ──────────────────────────────────────────────────────
  await trash.trashRecord(pid, 'dataset', D.id);
  back = await trash.restore(pid, 'visual', V1.id);
  ok('restoring a visual whose dataset is in the trash restores the dataset too',
    back.ok && back.restored.length === 2 && back.restored[0].id === V1.id
    && back.restored[1].type === 'dataset' && back.restored[1].id === D.id, JSON.stringify(back.restored));
  ok('…and ONLY the dataset — its other visual stays in the trash',
    JSON.stringify((await trash.list(pid)).map((e) => e.id)) === JSON.stringify([V2.id]));
  ok('…and the visual draws from a live dataset', !!(await datasets.getDatasetMeta(pid, D.id)));
  await trash.restore(pid, 'visual', V2.id);

  // ── every other record type round-trips ─────────────────────────────────────
  const A = await analysis.saveAnalysis(pid, { name: 'Board', sheets: [] });
  const M = await metrics.saveMetric(pid, { name: 'Sales', datasetId: D.id, definition: { column: 'sales', aggregation: 'sum' } });
  const R = await reportSpec.saveReport(pid, { analysisId: A!.id, name: 'Weekly' });
  for (const [type, id, lister] of [
    ['dashboard', A!.id, () => analysis.listAnalyses(pid)],
    ['metric', M!.id, () => metrics.listMetrics(pid)],
    ['report', R!.id, () => reportSpec.listReports(pid)],
  ] as const) {
    const r = await trash.trashRecord(pid, type, id);
    const gone = !(await lister()).some((x: any) => x.id === id);
    const b = await trash.restore(pid, type, id);
    const again = (await lister()).some((x: any) => x.id === id);
    ok(`a ${type} goes to the trash and comes back`, r.ok && gone && b.ok && again, JSON.stringify({ r, gone, b, again }));
  }

  // Alerts share one alerts.json: the rule is stashed out of it, with its events.
  const rule = await alertStore.saveRule(pid, {
    name: 'Sales under 20', datasetId: D.id, metric: { column: 'sales', aggregation: 'sum' },
    compare: 'threshold', threshold: { op: '<', value: 20 },
  });
  if (!rule) throw new Error('rule not saved');
  const file = await alertStore.load(pid);
  file.events.push({ id: '90000000-0000-4000-8000-000000000001', ruleId: rule.id, ruleName: rule.name } as never);
  fs.writeFileSync(path.join(projDir, 'alerts.json'), JSON.stringify(file));
  res = await trash.trashRecord(pid, 'alert', rule.id);
  ok('an alert rule goes to the trash', res.ok && !(await alertStore.load(pid)).rules.some((r) => r.id === rule.id));
  ok('…listed by its name', (await trash.list(pid)).some((e) => e.type === 'alert' && e.name === 'Sales under 20'));
  back = await trash.restore(pid, 'alert', rule.id);
  const reloaded = await alertStore.load(pid);
  ok('…and comes back with its inbox events',
    back.ok && reloaded.rules.some((r) => r.id === rule.id) && reloaded.events.some((e) => e.ruleId === rule.id));

  // ── 4: purge by date, with version history ─────────────────────────────────
  const now = Date.now();
  await trash.trashRecord(pid, 'visual', V3.id);
  await versions.record(pid, 'visual', { id: V3.id, name: 'x' });
  await versions.record(pid, 'visual', { id: V2.id, name: 'y' });
  // Backdate two entries by hand: one 31 days old, one 29.
  const old = await store.readEntry(pid, 'visual', V3.id);
  await store.stash(pid, 'visual', V3.id, { ...old, deletedAt: undefined }, { now: new Date(now - 31 * DAY) });
  await trash.trashRecord(pid, 'visual', V2.id);
  const young = await store.readEntry(pid, 'visual', V2.id);
  await store.stash(pid, 'visual', V2.id, { ...young, deletedAt: undefined }, { now: new Date(now - 29 * DAY) });
  items = await trash.list(pid, now);
  ok('days left counts down (29 days in → 1 left)', items.find((e) => e.id === V2.id)!.daysLeft === 1,
    JSON.stringify(items.map((e) => [e.id === V2.id, e.daysLeft])));
  const purged = await trash.purgeExpired(now);
  items = await trash.list(pid, now);
  ok('the tick purges what is past 30 days', purged === 1 && !items.some((e) => e.id === V3.id), String(purged));
  ok('…and keeps what is not', items.some((e) => e.id === V2.id));
  ok('…taking the purged record\'s version history with it',
    (await versions.list(pid, 'visual', V3.id)).length === 0 && (await versions.list(pid, 'visual', V2.id)).length === 1);

  // Delete permanently, then empty.
  ok('delete permanently removes one entry', (await trash.purge(pid, 'visual', V2.id)) && (await trash.list(pid)).length === 0);
  await trash.trashRecord(pid, 'dataset', D.id);
  await trash.trashRecord(pid, 'dashboard', A!.id);
  ok('empty removes everything', (await trash.empty(pid)) === 3 && (await trash.list(pid)).length === 0);
  ok('…including a trashed dataset\'s Parquet',
    !fs.readdirSync(path.join(projDir, 'trash', 'dataset')).some((n) => n.endsWith('.parquet')));

  // ── 5: guards ───────────────────────────────────────────────────────────────
  ok('a traversal id is refused', !(await trash.trashRecord(pid, 'visual', '../../x')).ok);
  ok('an unknown type is refused', !(await trash.trashRecord(pid, 'project' as never, V1.id)).ok);
  ok('a traversal project id is refused', !(await trash.trashRecord('..', 'visual', V1.id)).ok);
  ok('restore of something not in the trash says so', !(await trash.restore(pid, 'visual', V1.id)).ok);
  const liveM = path.join(projDir, 'metrics', M!.id + '.json');
  const before = fs.readFileSync(liveM, 'utf8');
  await store.stash(pid, 'metric', M!.id, { id: M!.id, name: 'Impostor' });
  ok('restore never overwrites a live record',
    !(await trash.restore(pid, 'metric', M!.id)).ok && fs.readFileSync(liveM, 'utf8') === before);

  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
