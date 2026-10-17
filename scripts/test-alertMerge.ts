// Alerts: an evaluation never writes back the file it read
// (src/analysis/alertStore.ts evaluateProject, docs/record-locks/00-design.md).
//
// `computeCardMetric` is parked on a gate, so the evaluator is stopped where a
// Live rule waits on its warehouse. During the park:
//   - deleteRule(B), saveRule(C) and patchRule(D) all resolve — nothing waits on
//     the evaluation;
//   - after release, B stays gone, C is there, D carries its new name (its stale
//     result is dropped), and E — untouched — has one more history point; only
//     E's event is returned;
//   - two evaluators at once fire once in total;
//   - recordEvents and setDigest issued during the park survive;
//   - a new project's alerts.json starts empty — the first project's rule once
//     rode along in a shared EMPTY array.
// NEGATIVE CONTROL: the old shape — a plain read, the wait, a whole-file
// write — brings the deleted B back.
//
// On files always; on Postgres too with DATABASE_URL (a scratch database).
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-alertMerge.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-alertmerge-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(TMP);
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const store: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const dashboards: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');

// The metric every rule reads: 100, after the gate (when one is up).
let gate: Promise<void> | null = null;
let asked = 0;
(dashboards as { computeCardMetric: unknown }).computeCardMetric = async () => {
  asked++;
  if (gate) await gate;
  return { ok: true, value: 100 };
};
function park(): () => void {
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  asked = 0;
  return () => { gate = null; open(); };
}
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

let req = 0;
const as = <T>(fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } }, `r${++req}`, fn);

const rule = (name: string) => ({
  name,
  datasetId: randomUUID(), // no table behind it: the diagnosis finds nothing, which is best effort
  metric: { column: 'revenue', aggregation: 'sum' },
  compare: 'threshold',
  threshold: { op: '>', value: 50 },
  enabled: true,
});

async function leg(name: string): Promise<void> {
  const p = await as(() => projects.createProject('Alerts ' + name));
  const [B, D, E] = await as(async () => [await store.saveRule(p.id, rule('B')), await store.saveRule(p.id, rule('D')), await store.saveRule(p.id, rule('E'))]);
  ok(`${name}: three rules saved`, !!B && !!D && !!E);
  const fresh = await as(() => projects.createProject('Fresh ' + name));
  ok(`${name}: another new project starts with no rules — never a rule saved into the first one`, (await as(() => store.load(fresh.id))).rules.length === 0);

  // ── One evaluation, parked, with edits landing meanwhile ────────────────
  const release = park();
  const evaluation = as(() => store.evaluateProject(p.id));
  await until(() => asked > 0);
  const edits = await as(() => Promise.race([
    Promise.all([store.deleteRule(p.id, B!.id), store.saveRule(p.id, rule('C')), store.patchRule(p.id, D!.id, { name: 'D renamed' })]),
    new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), 5_000)),
  ]));
  ok(`${name}: during the parked evaluation, delete B, save C and patch D all resolve`, Array.isArray(edits) && edits[0] === true && !!edits[1] && edits[2]?.name === 'D renamed', JSON.stringify(edits).slice(0, 200));
  release();
  const fired = await evaluation;
  const after = await as(() => store.load(p.id));
  const byName = (n: string) => after.rules.find((r) => r.name === n);
  ok(`${name}: after release, B is still gone`, !after.rules.some((r) => r.id === B!.id), after.rules.map((r) => r.name).join());
  ok(`${name}: C is there`, !!byName('C'));
  ok(`${name}: D keeps its new name (its stale result was dropped)`, !!byName('D renamed') && !byName('D') && !byName('D renamed')!.lastEvaluatedAt);
  ok(`${name}: E has one more history point`, (byName('E')!.history || []).length === 1, JSON.stringify(byName('E')));
  ok(`${name}: only E's event is returned, and stored`, fired.length === 1 && fired[0].ruleId === E!.id && after.events.length === 1 && after.events[0].id === fired[0].id, JSON.stringify(fired.map((e) => e.ruleId)));

  // ── Two evaluators at once ───────────────────────────────────────────────
  // C and D are armed and never evaluated; E re-arms on a new condition. Three rules fire — once each.
  await as(() => store.saveRule(p.id, { ...rule('E'), id: E!.id, threshold: { op: '>', value: 60 } }));
  const release2 = park();
  const two = [as(() => store.evaluateProject(p.id)), as(() => store.evaluateProject(p.id))];
  await until(() => asked >= 2);
  release2();
  const both = await Promise.all(two);
  const ids = [...both[0], ...both[1]].map((e) => e.ruleId);
  const stored2 = await as(() => store.load(p.id));
  ok(`${name}: two evaluators at once fire each of the three rules once in total`, ids.length === 3 && new Set(ids).size === 3 && ids.includes(E!.id)
    && stored2.events.length === 4, JSON.stringify({ returned: both.map((x) => x.length), stored: stored2.events.length }));

  // ── recordEvents and setDigest during the park ───────────────────────────
  const release3 = park();
  const third = as(() => store.evaluateProject(p.id));
  await until(() => asked > 0);
  const quality = { id: randomUUID(), ruleId: randomUUID(), at: new Date().toISOString(), message: 'A quality check failed', seen: false };
  const side = await as(() => Promise.all([store.recordEvents(p.id, [quality as never]), store.setDigest(p.id, true)]));
  release3();
  await third;
  const last = await as(() => store.load(p.id));
  ok(`${name}: recordEvents and setDigest issued during the park resolve and survive it`, side.every(Boolean) && last.digest === true && last.events.some((e) => e.id === quality.id), JSON.stringify({ side, digest: last.digest, events: last.events.length }));

  // ── NEGATIVE CONTROL: the old read → wait → whole write ─────────────────
  const X = await as(() => store.saveRule(p.id, rule('X')));
  const stale = await as(() => store.load(p.id));
  await as(() => store.deleteRule(p.id, X!.id));
  await as(async () => {
    const file = path.join(appPaths.userData(), 'projects', p.id, 'alerts.json');
    const tmp = `${file}.${randomUUID()}.tmp`;
    await recordFs.writeFile(tmp, JSON.stringify(stale));
    await recordFs.rename(tmp, file);
  });
  ok(`${name} NEGATIVE CONTROL: a plain read, a wait and a whole-file write bring the deleted rule back`, (await as(() => store.load(p.id))).rules.some((r) => r.id === X!.id));
}

(async () => {
  await leg('file');
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the Postgres leg: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_alertmerge_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: u.toString(), max: 10 });
  pool.on('error', () => undefined);
  try {
    await mig.migrate(pool);
    recordFs.useRecordDb(pool);
    await leg('db');
  } finally {
    recordFs.useRecordDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('alert merge suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
