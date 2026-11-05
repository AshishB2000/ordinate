// Topics (semantic layer part 6, D14–D16): a team's named, ordered short list of the project's datasets (each with an
// optional field subset), metrics and terms. Real modules over a temp DATA_DIR, the real RPC route (dev sign-in).
//
//   § record      saved trimmed and in order; a name unique ignoring case; 13 datasets and a member that does not exist
//                 are refused; stale members (a deleted dataset or metric, a column a refresh dropped) drop on read,
//                 counted, and reading writes nothing; a stale base is a 409; Trash round-trips; the bundle carries it
//
//   npm run build:ts && node scripts/test-topics.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-topics-'));

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const msg: typeof import('../src/analysis/topicMessages') = require('../src/analysis/topicMessages');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const editConflict: typeof import('../src/app/editConflict') = require('../src/app/editConflict');
const bundleRules: typeof import('../src/app/bundleRules') = require('../src/app/bundleRules');
const { stableStringify }: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');

type Identity = import('../src/server/context').Identity;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const T = (name: string) => ({ name, type: 'text' as const });
const N = (name: string) => ({ name, type: 'number' as const });

const caught = async (f: () => Promise<unknown>): Promise<unknown> => f().then(() => null, (e: unknown) => e);
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, 'topics', fn);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');

  const { P, ORDERS, REGIONS, REV } = await as(async () => {
    await projects.init();
    const P = (await projects.createProject('Topics')).id;
    const o = await datasets.saveDataset(P, { name: 'Retail orders', sourceKind: 'csv', columns: [T('region'), N('revenue'), T('state')], rows: [['East', 10, 'NY'], ['West', 5, 'CA']] });
    const r = await datasets.saveDataset(P, { name: 'Regions', sourceKind: 'csv', columns: [T('region'), T('manager')], rows: [['East', 'Ann']] });
    if (!o || !r) throw new Error('fixture not saved');
    const m = await metrics.saveMetric(P, { name: 'Revenue', datasetId: o.id, definition: { column: 'revenue', aggregation: 'sum' } } as never);
    if (!m) throw new Error('metric not saved');
    return { P, ORDERS: o.id, REGIONS: r.id, REV: m.id };
  });
  const THIRTEEN = Array.from({ length: 13 }, (_, i) => ({ id: uuid(i + 1) }));
  const IN = { name: 'Sales', datasets: [{ id: ORDERS, fields: ['region', 'revenue'] }, { id: REGIONS }], metricIds: [REV], termIds: [] };

  // ── § record ──────────────────────────────────────────────────────────────
  await as(async () => {
    const t = await topics.saveTopic(P, { ...IN, name: ' Sales ' });
    if (!t) throw new Error('no topic');
    ok('saved, trimmed, ordered, stamped', t.name === 'Sales' && t.datasets.map((d) => d.id).join() === `${ORDERS},${REGIONS}` && t.schemaVersion === 1
      && t.updatedBy === 'ana@acme.test' && stableStringify(t.datasets[0].fields) === '["region","revenue"]' && !('fields' in t.datasets[1]), JSON.stringify(t));
    ok('a name is unique, ignoring case', (await topics.topicProblem(P, { name: 'sales', datasets: [] }))?.error === msg.topicNameTaken('sales'));
    ok('NEGATIVE CONTROL: the topic being edited keeps its own name', (await topics.topicProblem(P, { name: 'SALES', datasets: [] }, t.id)) === null);
    ok('thirteen datasets are refused', (await topics.topicProblem(P, { name: 'Big', datasets: THIRTEEN }))?.field === 'datasets');
    ok('a member that does not exist is refused on save', (await topics.topicProblem(P, { name: 'X', datasets: [{ id: uuid(999) }] }))?.error === msg.topicMemberGone());
    ok('…a field the dataset lacks, a metric or a term that does not exist too',
      (await topics.topicProblem(P, { name: 'X', datasets: [{ id: ORDERS, fields: ['nope'] }] }))?.field === 'datasets'
      && (await topics.topicProblem(P, { name: 'X', datasets: [], metricIds: [uuid(5)] }))?.field === 'metricIds'
      && (await topics.topicProblem(P, { name: 'X', datasets: [], termIds: [uuid(6)] }))?.field === 'termIds');
    ok('NEGATIVE CONTROL: a good input has no problem', (await topics.topicProblem(P, { ...IN, name: 'Marketing' })) === null);
    const twice = topics.sanitizeTopic(topics.sanitizeTopic({ ...t, datasets: [{ id: ORDERS, fields: ['a', 'a', 'b'] }, { id: ORDERS }, { id: 'bad' }] }, P), P);
    ok('sanitizing twice is sanitizing once: a repeated dataset or field is kept once (first wins), a bad id dropped',
      stableStringify(twice) === stableStringify(topics.sanitizeTopic({ ...t, datasets: [{ id: ORDERS, fields: ['a', 'a', 'b'] }, { id: ORDERS }] }, P))
      && stableStringify(twice.datasets) === stableStringify([{ id: ORDERS, fields: ['a', 'b'] }]), JSON.stringify(twice.datasets));

    await datasets.deleteDataset(P, REGIONS);
    await metrics.deleteMetric(P, REV);
    await datasets.updateDatasetData(P, ORDERS, { columns: [N('revenue'), T('state')], rows: [[10, 'NY'], [5, 'CA']] }); // a refresh drops `region`
    const r = await topics.topicForReaders(P, (await topics.readTopic(P, t.id))!.rec);
    ok('stale members drop on read, counted, in order', r.stale === 3 && stableStringify(r.topic.datasets) === stableStringify([{ id: ORDERS, fields: ['revenue'] }]) && r.topic.metricIds.length === 0, JSON.stringify(r));
    ok('NEGATIVE CONTROL: reading wrote nothing', stableStringify((await topics.readTopic(P, t.id))!.rec) === stableStringify(t));
    const stale = await caught(() => topics.updateTopic(P, t.id, { ...IN, name: 'Y' }, 'stale'));
    ok('a stale base is a 409', editConflict.isRecordChanged(stale), String(stale));
    const open = await topics.readTopic(P, t.id);
    const moved = await topics.updateTopic(P, t.id, { name: 'Sales team', datasets: [{ id: ORDERS }], metricIds: [], termIds: [] }, open?.tag);
    ok('NEGATIVE CONTROL: the open tag saves the whole topic', moved?.name === 'Sales team' && stableStringify(moved.datasets) === stableStringify([{ id: ORDERS }]) && moved.id === t.id);

    const del = await trash.trashRecord(P, 'topic', t.id);
    const listed = (await trash.list(P)).some((e) => e.type === 'topic' && e.id === t.id && e.name === 'Sales team');
    const goneNow = (await topics.readTopic(P, t.id)) === null && !(await topics.listTopics(P)).some((x) => x.id === t.id);
    const back = await trash.restore(P, 'topic', t.id);
    ok('Trash: delete → listed → restore → readable', del.ok && listed && goneNow && back.ok && (await topics.readTopic(P, t.id))?.rec.name === 'Sales team', JSON.stringify({ del, listed, goneNow, back }));

    // A corrupt file is skipped; the list is by name.
    const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
    fs.writeFileSync(path.join(appPaths.userData(), 'projects', P, 'topics', `${uuid(7)}.json`), '{ not json');
    await topics.saveTopic(P, { name: 'Analytics', datasets: [] });
    ok('listTopics: by name, a corrupt file skipped', (await topics.listTopics(P)).map((x) => x.name).join('|') === 'Analytics|Sales team', (await topics.listTopics(P)).map((x) => x.name).join('|'));
  });
  ok('the bundle carries topics', bundleRules.ruleFor(`topics/${uuid(1)}.json`)?.count === 'topics');
  ok('NEGATIVE CONTROL: topics keep no history, so the bundle has no topic history entry', bundleRules.ruleFor(`history/topic/${uuid(1)}/2026-11-04T10-00-00-000Z.json`) === undefined);

  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
