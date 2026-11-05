// Status in the lists that name an item (semantic layer part 4, D7): metric:list, metric:table, dataset:list, catalog:list
// and term:list say `status` on each item that has one, over the real route (dev sign-in, temp DATA_DIR). The viewer and
// row-restricted part is scripts/test-governanceReplies-db.ts.
//
// 1. Nothing has status: no reply carries a status key (NEGATIVE CONTROL: byte-identical to before).
// 2. Certified, retired (with its replacement by name) and needs_review show in every list that names the item.
// 3. An item without status is unchanged; no list reply carries a pin.
//
//   npm run build:ts && node scripts/test-governanceReplies.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-govreplies-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const store: typeof import('../src/analysis/statusStore') = require('../src/analysis/statusStore');
const { pinOf } = require('../src/analysis/statusPin') as typeof import('../src/analysis/statusPin');
const { stableStringify } = require('../src/engine/queryCache') as typeof import('../src/engine/queryCache');

type Raw = Record<string, any>; // any: each channel's own reply
const EMAIL = 'ana@acme.test';
const ADMIN = { user: { email: EMAIL, role: 'admin' as const }, org: { id: 'acme' } };
const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, 'gov-replies', fn);
const COLS = [{ name: 'region', type: 'text' as const }, { name: 'sales', type: 'number' as const }, { name: 'qty', type: 'number' as const }];
const ROWS = [['EU', 10, 1], ['ME', 20, 2], ['US', 5, 3]];
const NARROWER = { type: 'filter', column: 'region', op: 'in', values: ['EU'] };
const F0 = { type: 'filter', column: 'qty', op: '>', value: 1 };

let call: (channel: string, payload: unknown) => Promise<Raw> = async () => { throw new Error('no app'); };

const certifyNow = (P: string, ref: string) => as(async () => store.certify(P, ref, (await pinOf(P, ref))!, ''));
const itemOf = (list: Raw[], id: string): Raw => list.find((i) => i.id === id) as Raw;

async function main(): Promise<void> {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  call = async (channel, payload) => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
    return { status: r.statusCode, text: r.body, body: r.statusCode === 200 ? wire.decode(r.body) : null };
  };
  const P = await as(async () => { await projects.init(); return (await projects.createProject('Replies')).id; });
  const { OLD, NEW, REV, OTHER, EMEA } = await as(async () => {
    const save = async (name: string) => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: COLS, rows: ROWS }))!.id;
    const [old, nw] = [await save('Old'), await save('New')];
    const m = async (name: string) => (await metrics.saveMetric(P, { name, datasetId: old, definition: { column: 'sales', aggregation: 'sum' } }))!.id;
    const emea = (await terms.saveTerm(P, { name: 'EMEA', aliases: [], description: '', datasetId: old, filters: [{ type: 'filter', column: 'region', op: 'in', values: ['EU', 'ME'] }] as never }))!.id;
    return { OLD: old, NEW: nw, REV: await m('Revenue'), OTHER: await m('Other'), EMEA: emea };
  });
  const lists = async (): Promise<Raw> => ({
    'metric:list': (await call('metric:list', { projectId: P })).body.metrics,
    'metric:table': (await call('metric:table', { projectId: P })).body,
    'dataset:list': (await call('dataset:list', { projectId: P })).body,
    'catalog:list': (await call('catalog:list', { projectId: P })).body,
    'term:list': (await call('term:list', { projectId: P })).body,
  });
  const before = await lists();
  ok('lists answered', Array.isArray(before['metric:list']) && before['metric:table'].ok && before['catalog:list'].ok && before['term:list'].ok && before['dataset:list'].length === 2);
  ok('NEGATIVE CONTROL: nothing has status, so no reply carries a status key', !/"status"/.test(stableStringify(before)));

  await certifyNow(P, `metric:${REV}`);
  await certifyNow(P, `term:${EMEA}`);
  await as(() => store.retire(P, `dataset:${OLD}`, `dataset:${NEW}`, 'use New'));
  const after = await lists();
  ok('metric:list and metric:table: Revenue certified', itemOf(after['metric:list'], REV).status?.state === 'certified' && itemOf(after['metric:table'].metrics, REV).status?.state === 'certified');
  ok('term:list: EMEA certified', itemOf(after['term:list'].terms, EMEA).status?.state === 'certified');
  const old = itemOf(after['dataset:list'], OLD).status;
  ok('dataset:list: Old retired, use New by name', old?.state === 'retired' && old.replacedBy?.name === 'New');
  ok('catalog:list rows carry it too', after['catalog:list'].rows.find((r: Raw) => r.ref === `dataset:${OLD}`)?.status?.state === 'retired'
    && after['catalog:list'].rows.find((r: Raw) => r.ref === `metric:${REV}`)?.status?.state === 'certified');
  ok('items without status are unchanged', stableStringify(itemOf(after['metric:list'], OTHER)) === stableStringify(itemOf(before['metric:list'], OTHER))
    && stableStringify(itemOf(after['dataset:list'], NEW)) === stableStringify(itemOf(before['dataset:list'], NEW))
    && !('status' in after['catalog:list'].rows.find((r: Raw) => r.ref === `metric:${OTHER}`)));
  ok('no list reply carries a pin', !/"pin"/.test(stableStringify(after)));

  await as(() => terms.updateTerm(P, EMEA, { filters: [NARROWER] as never }));
  await as(() => metrics.updateMetric(P, REV, { filters: [F0] as never }));
  const edited = await lists();
  ok('a term edit turns the certified term needs_review in term:list', itemOf(edited['term:list'].terms, EMEA).status?.state === 'needs_review');
  ok('a metric edit turns it needs_review in metric:list, metric:table and catalog:list', itemOf(edited['metric:list'], REV).status?.state === 'needs_review'
    && itemOf(edited['metric:table'].metrics, REV).status?.state === 'needs_review'
    && edited['catalog:list'].rows.find((r: Raw) => r.ref === `metric:${REV}`)?.status?.state === 'needs_review');
}

main().catch((err) => { console.error('FAIL harness', err); process.exitCode = 1; }).finally(() => { fs.rmSync(DATA, { recursive: true, force: true }); finish(); });
