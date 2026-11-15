// A metric's "reads a hidden column" check (src/analysis/columnHidden.ts, semantic layer part 4, D19) is worked out
// once per request: a list asks it per metric, and each answer used to read every metric record (metricsByName), so
// one specMetrics call was O(M²) record reads for a caller with any hidden column.
//
// No database: without Postgres a viewer is restricted with no entitlement, so *Staff*'s rule on `salary` hides it.
//   1. LINEAR: one specMetrics call as the restricted viewer, in one request, reads at most 5·M + 10 metric records
//      (its own list and reads, the hidden check's one metricsByName, one read per metric).
//   2. NEGATIVE CONTROL: with the memo off (the old shape) the same call reads more than M²/2.
//   3. SAME ANSWERS: specMetrics' ids, and every metricHidden boolean, Object.is-equal memo on and off; and hidden is
//      what each metric reads (sum of salary, a formula naming one, a filter on it: hidden; a count: not).
//   4. An unrestricted caller (an org admin) reads no metric record for the hidden check.
//   5. Per request, not per process: a metric changed between two requests is answered anew by the second.
//
//   npm run build:ts && node scripts/test-metricHiddenOnce.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-metrichidden-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const hiddenMod: typeof import('../src/analysis/columnHidden') = require('../src/analysis/columnHidden');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');

type Role = import('../src/server/context').Identity['user']['role'];
const HR_TEAM = '11111111-1111-4111-8111-111111111111';
let req = 0;
const as = <T>(role: Role, fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: `${role}@acme.test`, role }, org: { id: 'acme' } }, `r${++req}`, fn);
const asAdmin = <T>(fn: () => Promise<T>): Promise<T> => as('admin', fn);
const asViewer = <T>(fn: () => Promise<T>): Promise<T> => as('viewer', fn);

/** Metric record reads while `fn` runs. */
async function metricReads<T>(fn: () => Promise<T>): Promise<{ out: T; reads: number }> {
  const readFile = recordFs.readFile;
  let reads = 0;
  (recordFs as { readFile: unknown }).readFile = (p: string, enc?: BufferEncoding) => {
    if (typeof p === 'string' && /[\\/]metrics[\\/]/.test(p)) reads++;
    return (readFile as (p: string, e?: BufferEncoding) => Promise<unknown>)(p, enc);
  };
  try {
    return { out: await fn(), reads };
  } finally {
    (recordFs as { readFile: unknown }).readFile = readFile;
  }
}

/** A project with `m` metrics on Staff (dept, salary, employee_id), salary visible to HR only. */
async function world(m: number): Promise<{ P: string; ids: string[]; expect: Map<string, boolean> }> {
  return asAdmin(async () => {
    const P = (await projects.createProject(`Metric hidden ${m}`))!.id;
    const staff = (await datasets.saveDataset(P, {
      name: 'Staff', sourceKind: 'csv',
      columns: [{ name: 'dept', type: 'text' }, { name: 'salary', type: 'number' }, { name: 'employee_id', type: 'text' }],
      rows: [['Ops', 1000, 'e1'], ['Eng', 1200, 'e2']],
    }))!.id;
    const planted = await rec.serialized(rec.datasetFilePath(P, staff), (raw) => {
      raw.columnAccess = access.buildColumnAccess(raw, [{ column: 'salary', visibleTo: [{ teamId: HR_TEAM }] }], 'admin@acme.test', new Date().toISOString());
      return true;
    });
    if (!planted) throw new Error('column rule not planted');
    const ids: string[] = [];
    const expect = new Map<string, boolean>();
    const save = async (name: string, definition: object, hidden: boolean, filters: object[] = []): Promise<void> => {
      const saved = await metrics.saveMetric(P, { name, datasetId: staff, definition, filters });
      if (!saved) throw new Error(`metric ${name} not saved`);
      ids.push(saved.id);
      expect.set(saved.id, hidden);
    };
    for (let i = 0; i < m - 3; i++) {
      if (i % 2) await save(`Count ${i}`, { column: 'employee_id', aggregation: 'count' }, false);
      else await save(`Pay ${i}`, { column: 'salary', aggregation: 'sum' }, true);
    }
    await save('Pay per head', { formula: '[Pay 0] / [Count 1]' }, true); // hidden through the metric it names
    await save('Heads per head', { formula: '[Count 1] / [Count 3]' }, false);
    await save('Well paid', { column: 'employee_id', aggregation: 'count' }, true, [{ type: 'filter', column: 'salary', op: '>', value: 1100 }]);
    return { P, ids, expect };
  });
}

/** One request: specMetrics' ids, then metricHidden for every metric. */
const ask = (P: string, ids: string[]) => asViewer(async () => ({
  spec: (await answers.specMetrics(P)).map((s) => s.id).sort(),
  hidden: await Promise.all(ids.map((id) => hiddenMod.metricHidden(P, id))),
}));

void (async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  try {
    await asAdmin(() => projects.init());
    const M = 60;
    const { P, ids, expect } = await world(M);

    // 1. linear
    const on = await metricReads(() => asViewer(() => answers.specMetrics(P)));
    ok(`one specMetrics call as a restricted viewer reads at most 5·M + 10 metric records (M=${M})`, on.reads <= 5 * M + 10, on.reads);

    // 2. NEGATIVE CONTROL
    hiddenMod._setHiddenMemo(false);
    let off: { out: Array<{ id: string }>; reads: number };
    let offAnswers: { spec: string[]; hidden: boolean[] };
    try {
      off = await metricReads(() => asViewer(() => answers.specMetrics(P)));
      offAnswers = await ask(P, ids);
    } finally {
      hiddenMod._setHiddenMemo(true);
    }
    ok(`NEGATIVE CONTROL: with the memo off the same call reads more than M²/2 (${M * M / 2})`, off.reads > (M * M) / 2, off.reads);

    // 3. same answers
    const onAnswers = await ask(P, ids);
    const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
    ok('specMetrics names the same metrics, memo on and off', sameList(on.out.map((s) => s.id).sort(), off.out.map((s) => s.id).sort()) && sameList(onAnswers.spec, offAnswers.spec));
    ok('every metricHidden boolean is the same, memo on and off', sameList(onAnswers.hidden, offAnswers.hidden), JSON.stringify([onAnswers.hidden, offAnswers.hidden]));
    ok('…and each is what the metric reads (salary sum, a formula naming one, a salary filter: hidden; a count: not)', sameList(onAnswers.hidden, ids.map((id) => expect.get(id))), JSON.stringify(onAnswers.hidden));
    ok('NEGATIVE CONTROL: some metrics are hidden and some are not', onAnswers.hidden.includes(true) && onAnswers.hidden.includes(false));
    ok('specMetrics leaves out every hidden simple metric', onAnswers.spec.every((id) => expect.get(id) === false) && onAnswers.spec.length > 0);

    // 4. unrestricted
    const admin = await metricReads(() => asAdmin(async () => Promise.all(ids.map((id) => hiddenMod.metricHidden(P, id)))));
    ok('an org admin reads no metric record for the hidden check, and nothing is hidden from them', admin.reads === 0 && admin.out.every((h) => h === false), admin.reads);

    // 5. per request
    const count1 = ids[1];
    await asAdmin(async () => { await metrics.updateMetric(P, count1, { definition: { column: 'salary', aggregation: 'sum' } }); });
    ok('a metric changed between requests is answered anew by the next request', (await asViewer(() => hiddenMod.metricHidden(P, count1))) === true);
  } catch (err) {
    ok('the suite ran', false, err instanceof Error ? err.stack : err);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  }
})();
