// Refresh every 5 or 15 minutes (L0.3, docs/live-data/00-plan.md) — the rule,
// where it is enforced, and "Behind schedule".
//
//   1. The pure table (src/data/refreshCadence.ts): intervals, which cadences
//      need incremental refresh, how late a schedule is, and behindSchedule at
//      its boundary.
//   2. THE RULE, at every layer, each with its negative control:
//        sanitizer   — a stored 5-minute schedule without incremental refresh
//                      reads back as no schedule; with it, as itself;
//        store       — setAutoRefresh refuses it (false) without incremental;
//        RPC         — dataset:update and pipelines:setNodeSchedule refuse it
//                      with the catalog's sentence, over the real route;
//        turning incremental OFF under a fast schedule drops it to hourly in
//        the same write, never to nothing.
//      The control for each: the SAME call on a dataset with incremental on
//      succeeds, and an hourly schedule on the plain one does too — so the
//      refusal is the rule, not a broken path.
//   3. What the browser gets: `incrementalOn` and `behindSchedule` flags on the
//      summary (computed by the server), never the cursor or the mark; the
//      Pipelines step carries the same two.
//
//   npm run build:ts && node scripts/test-refreshCadence.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const cad: typeof import('../src/data/refreshCadence') = require('../src/data/refreshCadence');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

type Any = any; // any: each channel's own reply shape, read field by field below

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MARK = 'HIGHWATER-91f3-never-in-a-summary';
const EN: Record<string, string> = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));
const REFUSAL = EN['refreshMessages.every_5_or_15_minutes_needs'];

// ── 1. The pure table ───────────────────────────────────────────────────────

ok('cadences, shortest first', cad.AUTO_REFRESH_EVERY.join() === '5min,15min,hourly,daily,weekly');
ok('intervals: 5 min, 15 min, 1 h, 1 d, 7 d', cad.INTERVAL_MS['5min'] === 5 * MIN && cad.INTERVAL_MS['15min'] === 15 * MIN
  && cad.INTERVAL_MS.hourly === HOUR && cad.INTERVAL_MS.daily === DAY && cad.INTERVAL_MS.weekly === 7 * DAY);
ok('every listed cadence has an interval, and nothing else is one',
  cad.AUTO_REFRESH_EVERY.every((e) => cad.isAutoRefreshEvery(e)) && !cad.isAutoRefreshEvery('monthly')
    && !cad.isAutoRefreshEvery('toString') && !cad.isAutoRefreshEvery(5));
ok('5 and 15 minutes need incremental refresh; hourly and slower do not',
  cad.needsIncremental('5min') && cad.needsIncremental('15min') && !['hourly', 'daily', 'weekly', null, undefined].some((e) => cad.needsIncremental(e)));
ok('cadenceAllowed: fast only with incremental on',
  !cad.cadenceAllowed('5min', false) && !cad.cadenceAllowed('15min', false) && cad.cadenceAllowed('5min', true) && cad.cadenceAllowed('15min', true));
ok('cadenceAllowed: hourly either way; an unknown cadence never',
  cad.cadenceAllowed('hourly', false) && cad.cadenceAllowed('weekly', true) && !cad.cadenceAllowed('minutely', true) && !cad.cadenceAllowed(undefined, true));

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
ok('overdueMs: never run is infinitely overdue', cad.overdueMs({ every: '5min' }, NOW) === Infinity);
ok('overdueMs: a corrupt stamp is too (the schedule self-heals)', cad.overdueMs({ every: '5min', lastAutoAt: 'nope' }, NOW) === Infinity);
ok('overdueMs: not yet due is null', cad.overdueMs({ every: '15min', lastAutoAt: ago(14 * MIN) }, NOW) === null);
ok('overdueMs: exactly due is 0 (a tick on the boundary counts)', cad.overdueMs({ every: '15min', lastAutoAt: ago(15 * MIN) }, NOW) === 0);
ok('overdueMs: time past due', cad.overdueMs({ every: '5min', lastAutoAt: ago(12 * MIN) }, NOW) === 7 * MIN);

ok('behind: a run longer than its interval', cad.behindSchedule({ every: '5min', lastAutoMs: 5 * MIN + 1 }));
ok('behind: exactly the interval is on time', !cad.behindSchedule({ every: '5min', lastAutoMs: 5 * MIN }));
ok('behind: never measured is not behind', !cad.behindSchedule({ every: '5min' }) && !cad.behindSchedule(undefined));
ok('behind: per interval — 20 min is late for 15 min, on time for hourly',
  cad.behindSchedule({ every: '15min', lastAutoMs: 20 * MIN }) && !cad.behindSchedule({ every: 'hourly', lastAutoMs: 20 * MIN }));
ok('sanitizeRunMs: whole, non-negative, bounded',
  cad.sanitizeRunMs(1234.6) === 1235 && cad.sanitizeRunMs(-1) === undefined && cad.sanitizeRunMs(NaN) === undefined
    && cad.sanitizeRunMs('5') === undefined && cad.sanitizeRunMs(31 * DAY) === undefined && cad.sanitizeRunMs(0) === 0);

// ── 2a. The sanitizer ───────────────────────────────────────────────────────

const san = record.sanitizeAutoRefresh;
ok('sanitizer: 5 min WITHOUT incremental is refused (no schedule)', san({ every: '5min' }, true, false) === undefined);
ok('sanitizer: 15 min without incremental, the default argument, is refused too', san({ every: '15min' }, true) === undefined);
ok('sanitizer (control): 5 min WITH incremental is kept', san({ every: '5min' }, true, true)?.every === '5min');
ok('sanitizer (control): hourly without incremental is kept', san({ every: 'hourly' }, true, false)?.every === 'hourly');
ok('sanitizer: no origin, no schedule, whatever the cadence', san({ every: '5min' }, false, true) === undefined);
ok('sanitizer: lastAutoMs survives whitelisted, junk is dropped',
  san({ every: '5min', lastAutoMs: 61_000 }, true, true)?.lastAutoMs === 61_000 && !('lastAutoMs' in (san({ every: 'daily', lastAutoMs: 'x' }, true) ?? {})));

// ── Server mode: the store, the RPC, the summary ────────────────────────────

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-cadence-'));

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const env = envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA });
  const app = appMod.buildApp(env);
  const dev = context.identityFor(env)({} as never);
  const inOrg = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(dev, 'test', fn);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
  const messages: typeof import('../src/data/refreshMessages') = require('../src/data/refreshMessages');

  const conn = (n: number) => ({ kind: 'connection', connId: `7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6${n}`, table: 'orders' });
  const cols = [{ name: 'id', type: 'number' as const }, { name: 'updated', type: 'number' as const }];
  const fx = await inOrg(async () => {
    await projects.init();
    const p = await projects.createProject('Cadence');
    const save = async (name: string, origin: unknown) =>
      (await datasets.saveDataset(p.id, { name, sourceKind: 'postgres', columns: cols, rows: [[1, 100]], origin } as never))!.id;
    const plain = await save('Plain', conn(1));
    const inc = await save('Incremental', conn(2));
    const url = await save('From a URL', { kind: 'url', url: 'https://api.example.com/orders.json' });
    const raw = await save('Hand-edited', conn(3));
    for (const id of [inc, raw]) {
      await datasets.writeIncremental(p.id, id, () => ({ enabled: true, cursorColumn: 'updated', lookback: 0, highWater: MARK, runsSinceFull: 0, log: [] }));
    }
    return { projectId: p.id, plain, inc, url, raw };
  });
  const P = fx.projectId;
  const meta = (id: string) => inOrg(() => datasets.getDatasetMeta(P, id));

  ok('catalog: the refusal is a translated sentence, read through t()', typeof REFUSAL === 'string' && REFUSAL.length > 20
    && (await inOrg(async () => messages.fastCadenceNeedsIncremental())) === REFUSAL);

  // ── 2b. The store ─────────────────────────────────────────────────────────
  ok('store: setAutoRefresh(5min) WITHOUT incremental is refused', (await inOrg(() => datasets.setAutoRefresh(P, fx.plain, { every: '5min' }))) === false);
  ok('store: …and nothing was written', (await meta(fx.plain))?.autoRefresh === undefined);
  ok('store (control): hourly on the same dataset is stored', (await inOrg(() => datasets.setAutoRefresh(P, fx.plain, { every: 'hourly' })) as Any)?.every === 'hourly');
  ok('store (control): 15min WITH incremental is stored', (await inOrg(() => datasets.setAutoRefresh(P, fx.inc, { every: '15min' })) as Any)?.every === '15min');
  ok('store: a stamp-only patch keeps a fast cadence on an incremental dataset',
    (await inOrg(() => datasets.setAutoRefresh(P, fx.inc, { lastAutoAt: ago(0) })) as Any)?.every === '15min');

  // ── 2a'. The sanitizer, on a record written by hand ───────────────────────
  const handEdit = async (patch: Record<string, unknown>) => inOrg(async () => {
    const file = record.datasetFilePath(P, fx.raw); // under the org's userData: inside the request
    const r = JSON.parse(await recordFs.readFile(file, 'utf8'));
    await recordFs.writeFile(file, JSON.stringify({ ...r, ...patch }), 'utf8');
  });
  await handEdit({ autoRefresh: { every: '5min' } });
  ok('sanitizer (control): a hand-written 5 min reads back on an incremental dataset', (await meta(fx.raw))?.autoRefresh?.every === '5min');
  await handEdit({ incremental: { enabled: false, cursorColumn: 'updated', lookback: 0, highWater: null, runsSinceFull: 0, log: [] } });
  ok('sanitizer: the same 5 min, incremental now off by hand, reads back as NO schedule', (await meta(fx.raw))?.autoRefresh === undefined);
  const listed = await inOrg(() => datasets.listDatasets(P));
  ok('sanitizer: …and the scheduler\'s enumeration (the summary) has none either', listed.find((d) => d.id === fx.raw)?.autoRefresh === undefined);

  // Incremental turned off THROUGH the store: the schedule drops to hourly.
  await inOrg(() => datasets.setAutoRefresh(P, fx.inc, { lastAutoMs: 20 * MIN }));
  await inOrg(() => datasets.writeIncremental(P, fx.inc, (cur) => cur && { ...cur, enabled: false }));
  const down = (await meta(fx.inc))?.autoRefresh;
  ok('incremental off under 15 min: the schedule becomes hourly, in the same write (never silently off)', down?.every === 'hourly', JSON.stringify(down));
  ok('…and its run length is dropped: "behind" was judged against 15 minutes', down?.lastAutoMs === undefined);
  await inOrg(() => datasets.writeIncremental(P, fx.inc, (cur) => cur && { ...cur, enabled: true }));
  ok('…turned back on, the schedule stays hourly (nothing guesses the old cadence)', (await meta(fx.inc))?.autoRefresh?.every === 'hourly');

  // ── 2c. The RPC ───────────────────────────────────────────────────────────
  const bodies: string[] = [];
  const post = async (channel: string, payload: unknown): Promise<{ status: number; json: Any }> => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }),
      payload: wire.encode({ args: [payload] }),
    });
    bodies.push(r.body);
    return { status: r.statusCode, json: r.statusCode === 200 ? wire.decode(r.body) : null };
  };
  const update = (datasetId: string, autoRefresh: string) => post('dataset:update', { projectId: P, datasetId, autoRefresh });
  const node = (datasetId: string, every: string) => post('pipelines:setNodeSchedule', { projectId: P, nodeId: `dataset:${datasetId}`, every });

  for (const every of ['5min', '15min']) {
    const r = await update(fx.plain, every);
    ok(`RPC dataset:update ${every} WITHOUT incremental: refused with the catalog's sentence`, r.status === 200 && r.json.ok === false && r.json.error === REFUSAL, JSON.stringify(r.json));
  }
  ok('RPC: …and the stored schedule is untouched (still hourly)', (await meta(fx.plain))?.autoRefresh?.every === 'hourly');
  const onUrl = await update(fx.url, '5min');
  ok('RPC: a URL dataset (no incremental possible) is refused too', onUrl.json.ok === false && onUrl.json.error === REFUSAL);
  const viaNode = await node(fx.plain, '15min');
  ok('RPC pipelines:setNodeSchedule 15min WITHOUT incremental: refused with the same sentence', viaNode.json.ok === false && viaNode.json.error === REFUSAL, JSON.stringify(viaNode.json));
  ok('RPC (control): dataset:update 5min WITH incremental is accepted', (await update(fx.inc, '5min')).json.ok === true);
  ok('RPC (control): …and stored', (await meta(fx.inc))?.autoRefresh?.every === '5min');
  ok('RPC (control): pipelines:setNodeSchedule 15min WITH incremental is accepted', (await node(fx.inc, '15min')).json.ok === true
    && (await meta(fx.inc))?.autoRefresh?.every === '15min');
  ok('RPC (control): hourly on the plain dataset is accepted', (await update(fx.plain, 'hourly')).json.ok === true);
  ok('RPC: an unknown cadence is still a 400 at the contract', (await update(fx.plain, 'minutely')).status === 400);
  ok('RPC: "off" still turns a fast schedule off', (await update(fx.inc, 'off')).json.ok === true && (await meta(fx.inc))?.autoRefresh === undefined);

  // ── 3. What the browser gets ──────────────────────────────────────────────
  await update(fx.inc, '5min');
  await inOrg(() => datasets.setAutoRefresh(P, fx.inc, { lastAutoMs: 6 * MIN }));
  await inOrg(() => datasets.setAutoRefresh(P, fx.plain, { lastAutoMs: 59 * MIN }));
  const list = (await post('dataset:list', { projectId: P })).json as Any[];
  const byId = (id: string) => list.find((d: Any) => d.id === id);
  ok('summary: incrementalOn on the incremental dataset only', byId(fx.inc)?.incrementalOn === true && byId(fx.plain)?.incrementalOn === undefined,
    JSON.stringify([byId(fx.inc), byId(fx.plain)]));
  ok('summary: behindSchedule when the last run (6 min) outran 5 minutes', byId(fx.inc)?.behindSchedule === true);
  ok('summary: not behind when it (59 min) kept to hourly', byId(fx.plain)?.behindSchedule === undefined);
  ok('summary: the incremental settings themselves (the mark) never reach the browser', !bodies.some((b) => b.includes(MARK)));
  await inOrg(() => datasets.setAutoRefresh(P, fx.inc, { lastAutoMs: 5 * MIN }));
  ok('summary: exactly the interval is on time', (await post('dataset:list', { projectId: P })).json.find((d: Any) => d.id === fx.inc)?.behindSchedule === undefined);

  const stamped = new Date(Date.now() - 2 * MIN).toISOString();
  await inOrg(() => datasets.setAutoRefresh(P, fx.inc, { lastAutoMs: 7 * MIN, lastAutoAt: stamped }));
  const pv = (await post('pipelines:get', { projectId: P })).json;
  const step = pv.nodes?.find((n: Any) => n.id === `dataset:${fx.inc}`);
  ok('pipelines:get: the step says "Every 5 minutes", behind, incremental on',
    step?.schedule?.text === 'Every 5 minutes · behind schedule' && step.schedule.every === '5min' && step.schedule.incremental === true && step.schedule.behind === true,
    JSON.stringify(step?.schedule));
  const plainStep = pv.nodes?.find((n: Any) => n.id === `dataset:${fx.plain}`);
  ok('pipelines:get: the plain step is not incremental (its picker greys the fast options)', plainStep?.schedule?.incremental === false, JSON.stringify(plainStep?.schedule));
  ok('pipelines:get: the next run is 5 minutes after the last stamp',
    Date.parse(String(step?.nextRunAt)) === Date.parse(stamped) + 5 * MIN, `${step?.nextRunAt} vs ${stamped}`);

  await app.close();
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
