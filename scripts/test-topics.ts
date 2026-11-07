// Topics (semantic layer part 6, D14–D16): a team's named, ordered short list of the project's datasets (each with an
// optional field subset), metrics and terms. Real modules over a temp DATA_DIR, the real RPC route (dev sign-in).
//
//   § record      saved trimmed and in order; a name unique ignoring case; 13 datasets and a member that does not exist
//                 are refused; stale members (a deleted dataset or metric, a column a refresh dropped) drop on read,
//                 counted, and reading writes nothing; a stale base is a 409; Trash round-trips; the bundle carries it
//   § channels    topic:save creates and updates (its tag the next base, a stale one 409), topic:get gives the tag and
//                 the stale count, topic:delete goes to the Trash and model:navigation stops listing it; a dataset in no
//                 topic answers visual:data the same, cell by cell, before any topic exists and after two do (D15)
// What a row-restricted viewer reads of a topic is pinned in scripts/test-rowPolicySafetyNet.ts (its world).
//
//   npm run build:ts && node scripts/test-topics.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-topics-'));

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
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
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  type Reply = { status: number; text: string; body: any }; // any: each channel's own reply
  const call = async (channel: string, payload: unknown): Promise<Reply> => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
    });
    let body: unknown = null;
    try { body = r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body); } catch { body = null; }
    return { status: r.statusCode, text: r.body, body };
  };
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

  // ── § channels ────────────────────────────────────────────────────────────
  const { Q, A, B } = await as(async () => {
    const Q = (await projects.createProject('Topic channels')).id;
    const a = await datasets.saveDataset(Q, { name: 'Orders', sourceKind: 'csv', columns: [T('region'), N('revenue')], rows: [['East', 10], ['West', 5], ['East', 2]] });
    const b = await datasets.saveDataset(Q, { name: 'Returns', sourceKind: 'csv', columns: [T('reason'), N('amount')], rows: [['Late', 3], ['Broken', 4], ['Late', 1.5]] });
    if (!a || !b) throw new Error('fixture not saved');
    return { Q, A: a.id, B: b.id };
  });
  const outside = { projectId: Q, datasetId: B, encoding: { category: 'reason', values: [{ column: 'amount', aggregation: 'sum' }] } };
  const before = await call('visual:data', outside);
  const body = { name: 'Sales', description: 'What the sales team reads first', datasets: [{ id: A, fields: ['region'] }], metricIds: [], termIds: [] };
  const saved = await call('topic:save', { projectId: Q, topic: body });
  ok('topic:save creates, and says its tag', saved.body?.ok === true && saved.body.topic.name === 'Sales' && typeof saved.body.tag === 'string', saved.text.slice(0, 300));
  const id: string = saved.body?.topic?.id ?? '';
  const got = await call('topic:get', { projectId: Q, id });
  ok('topic:get: the topic as stored, its tag and stale: 0', got.body?.ok === true && got.body.topic.id === id && got.body.tag === saved.body.tag && got.body.stale === 0, got.text.slice(0, 300));
  const up = await call('topic:save', { projectId: Q, id, base: got.body?.tag, topic: { ...body, name: 'Sales team' } });
  ok('an update with that tag lands, and says the next tag', up.body?.ok === true && up.body.topic.id === id && up.body.topic.name === 'Sales team' && up.body.tag !== got.body.tag, up.text.slice(0, 300));
  const stale = await call('topic:save', { projectId: Q, id, base: got.body?.tag, topic: { ...body, name: 'Stale' } });
  ok('…and one with the old tag is refused 409 record_changed', stale.status === 409 && stale.body?.code === 'record_changed', stale.text.slice(0, 200));
  const taken = await call('topic:save', { projectId: Q, topic: { ...body, name: 'sales TEAM' } });
  ok('a taken name is refused with its sentence, beside the name', taken.body?.ok === false && taken.body.field === 'name' && taken.body.error === msg.topicNameTaken('sales TEAM'), taken.text.slice(0, 200));
  ok('a 13th dataset is refused by the contract', (await call('topic:save', { projectId: Q, topic: { ...body, name: 'Big', datasets: THIRTEEN } })).status === 400);
  const second = await call('topic:save', { projectId: Q, topic: { ...body, name: 'Finance', datasets: [{ id: A }] } });
  const nav = await call('model:navigation', { projectId: Q });
  ok('model:navigation lists the topics by name, for readers', nav.body?.ok === true && JSON.stringify(nav.body.topics.map((x: { name: string }) => x.name)) === '["Finance","Sales team"]'
    && JSON.stringify(nav.body.topics[1]) === JSON.stringify({ id, name: 'Sales team', description: 'What the sales team reads first', datasets: [{ id: A, fields: ['region'] }], metricIds: [], termIds: [] }), nav.text.slice(0, 400));
  const after = await call('visual:data', outside);
  const cells = (r: Reply): unknown[][] => (r.body?.ok ? [r.body.data.labels, ...r.body.data.series.map((x: { values: unknown[] }) => x.values)] : []);
  const same = (a: unknown[][], b: unknown[][]): boolean => a.length > 1 && a.length === b.length && a.every((row, i) => row.length === b[i].length && row.every((v, j) => Object.is(v, b[i][j])));
  ok('D15: a dataset in no topic answers visual:data the same, cell by cell, with two topics as with none', second.body?.ok === true && same(cells(before), cells(after)), `${before.text.slice(0, 200)} | ${after.text.slice(0, 200)}`);
  const del = await call('topic:delete', { projectId: Q, id });
  const inTrash = (await call('trash:list', { projectId: Q })).body;
  const navAfter = await call('model:navigation', { projectId: Q });
  ok('topic:delete moves it to the Trash, and model:navigation no longer lists it', del.body?.ok === true && Array.isArray(inTrash) && inTrash.some((e: { type: string; id: string }) => e.type === 'topic' && e.id === id)
    && navAfter.body?.topics.map((x: { id: string }) => x.id).join() === second.body.topic.id, navAfter.text.slice(0, 300));
  ok('topic:get of a deleted topic says so', (await call('topic:get', { projectId: Q, id })).body?.ok === false);
  const keeps = await call('topic:save', { projectId: Q, topic: { ...body, name: 'Ops', datasets: [{ id: A, fields: ['region', 'revenue'] }, { id: B }] } });
  await as(() => datasets.deleteDataset(Q, B));
  const opened = await call('topic:get', { projectId: Q, id: keeps.body?.topic?.id });
  ok('topic:get of a topic with a gone member: as stored, stale 1, and `kept` without it', opened.body?.ok === true && opened.body.stale === 1 && opened.body.topic.datasets.length === 2
    && JSON.stringify(opened.body.kept.datasets) === JSON.stringify([{ id: A, fields: ['region', 'revenue'] }]), opened.text.slice(0, 400));

  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
