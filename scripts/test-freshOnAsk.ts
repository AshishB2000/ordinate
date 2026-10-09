// Fresh on ask (docs/live-data/00-plan.md L3.1): the setting and its due rule.
//
//   1. The due rule, PURE (src/data/freshOnAskRule.ts): fresh / stale / never
//      refreshed / incremental off / Live → never / a pull already started in
//      this window / a full refresh due — with the window's boundaries.
//   2. The stored block: only with incremental refresh on and not Live; an
//      out-of-range age is clamped on load and REFUSED on request (negative
//      controls on both sides); FRESH_ON_ASK_WAIT_MS is validated at startup.
//   3. Over the RPC route (server mode, records as files): `dataset:update`'s
//      `freshOnAsk` is refused with the catalog's sentence without
//      incremental refresh, on a Live dataset and out of range (the contract
//      answers 400) — and accepted with it (negative control); `null` turns
//      it off; the list carries the age and "waits for a full refresh";
//      turning incremental refresh off drops it in the same write, and
//      turning it back on does not revive it; a hand-edited block on a
//      dataset without incremental refresh reads back as absent.
//
//   npm run build:ts && node scripts/test-freshOnAsk.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const rule: typeof import('../src/data/freshOnAskRule') = require('../src/data/freshOnAskRule');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const api: typeof import('../src/api/index') = require('../src/api/index');

const EN: Record<string, string> = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));
const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const ago = (sec: number): string => new Date(NOW - sec * 1000).toISOString();

(async () => {
  // ── 1. The due rule ────────────────────────────────────────────────────────
  const on = { maxStalenessSec: 300 };
  const inc = { enabled: true };
  const v = (m: Partial<import('../src/data/freshOnAskRule').VerdictInput>) =>
    rule.freshOnAskVerdict({ freshOnAsk: on, incremental: inc, lastRefreshedAt: ago(600), fullReason: null, ...m }, NOW);
  ok('stale (10 min old, 5 min setting) → due', v({}) === 'due');
  ok('not stale (1 min old) → fresh', v({ lastRefreshedAt: ago(60) }) === 'fresh');
  ok('boundary: exactly the setting\'s age is stale (due), a second younger is fresh', v({ lastRefreshedAt: ago(300) }) === 'due' && v({ lastRefreshedAt: ago(299) }) === 'fresh');
  ok('never refreshed (no stamp) → infinitely old → due', v({ lastRefreshedAt: undefined }) === 'due');
  ok('an unreadable stamp reads as never refreshed → due', v({ lastRefreshedAt: 'yesterday-ish' }) === 'due');
  ok('incremental refresh off → off (never), however stale', v({ incremental: { enabled: false } }) === 'off' && v({ incremental: undefined }) === 'off');
  ok('Live → off (never), however stale', v({ mode: 'live' }) === 'off');
  ok('no setting → off', v({ freshOnAsk: undefined }) === 'off');
  ok('a pull started inside this window → held', v({ triggeredAtMs: NOW - 120_000 }) === 'held');
  ok('…one started a whole window ago → due again', v({ triggeredAtMs: NOW - 300_000 }) === 'due');
  ok('a full refresh due → full (never a pull)', v({ fullReason: 'Every 7th run is a full refresh' }) === 'full');
  ok('…but a fresh copy is just fresh', v({ fullReason: 'x', lastRefreshedAt: ago(10) }) === 'fresh');
  ok('negative control: the same stale record with the rule\'s inputs flipped back is due', v({ fullReason: null, triggeredAtMs: undefined, mode: undefined }) === 'due');
  ok('ageMs: never → Infinity; 90 s ago → 90,000', rule.ageMs(undefined, NOW) === Infinity && rule.ageMs(ago(90), NOW) === 90_000);
  ok('nextRunIsFull: fullNext, no mark, the 7th run → true; a 3rd run → false; off → false',
    rule.nextRunIsFull({ enabled: true, fullNext: true, highWater: 5, runsSinceFull: 0 })
      && rule.nextRunIsFull({ enabled: true, highWater: null, runsSinceFull: 0 })
      && rule.nextRunIsFull({ enabled: true, highWater: 5, runsSinceFull: 6 })
      && !rule.nextRunIsFull({ enabled: true, highWater: 5, runsSinceFull: 2 })
      && !rule.nextRunIsFull({ enabled: false, fullNext: true, highWater: null, runsSinceFull: 9 }));

  // ── 2. The stored block and the env var ────────────────────────────────────
  const both = { incrementalOn: true, live: false };
  ok('stored: kept with incremental on', JSON.stringify(rule.sanitizeFreshOnAsk({ maxStalenessSec: 300 }, both)) === '{"maxStalenessSec":300}');
  ok('negative control — stored: dropped with incremental off', rule.sanitizeFreshOnAsk({ maxStalenessSec: 300 }, { incrementalOn: false, live: false }) === undefined);
  ok('stored: dropped on a Live record', rule.sanitizeFreshOnAsk({ maxStalenessSec: 300 }, { incrementalOn: true, live: true }) === undefined);
  ok('stored: 10 s clamps to 60, 2 days to 1 day, 90.7 floors', rule.sanitizeFreshOnAsk({ maxStalenessSec: 10 }, both)?.maxStalenessSec === 60
    && rule.sanitizeFreshOnAsk({ maxStalenessSec: 172_800 }, both)?.maxStalenessSec === 86_400 && rule.sanitizeFreshOnAsk({ maxStalenessSec: 90.7 }, both)?.maxStalenessSec === 90);
  ok('stored: a non-number age, or no block, is absent', rule.sanitizeFreshOnAsk({ maxStalenessSec: '300' }, both) === undefined && rule.sanitizeFreshOnAsk(null, both) === undefined);
  ok('stored: a readable triggeredAt is kept, garbage dropped', rule.sanitizeFreshOnAsk({ maxStalenessSec: 60, triggeredAt: ago(5) }, both)?.triggeredAt === ago(5)
    && rule.sanitizeFreshOnAsk({ maxStalenessSec: 60, triggeredAt: 'soon' }, both)?.triggeredAt === undefined);
  ok('requested: 60, 300, 900, 3600 and 86,400 are taken', [60, 300, 900, 3600, 86_400].every((s) => rule.parseMaxStaleness(s) === s));
  ok('negative control — requested: 59, 86,401, 1.5, "300" and NaN are REFUSED, not clamped',
    [59, 86_401, 1.5, '300', NaN, -60].every((s) => rule.parseMaxStaleness(s) === null));
  ok('the picker\'s choices are inside the bounds', rule.FRESH_ON_ASK_CHOICES.every((s) => rule.parseMaxStaleness(s) === s));
  const target: { freshOnAsk?: unknown; incremental?: { enabled: boolean }; mode?: string } = { incremental: { enabled: true } };
  rule.applyFreshOnAsk(target as Parameters<typeof rule.applyFreshOnAsk>[0], { freshOnAsk: { maxStalenessSec: 900 } });
  const liveTarget: { freshOnAsk?: unknown; incremental?: { enabled: boolean }; mode?: string } = { incremental: { enabled: true }, mode: 'live' };
  rule.applyFreshOnAsk(liveTarget as Parameters<typeof rule.applyFreshOnAsk>[0], { freshOnAsk: { maxStalenessSec: 900 } });
  ok('applyFreshOnAsk carries it onto a normalized extract, never onto a Live one', JSON.stringify(target.freshOnAsk) === '{"maxStalenessSec":900}' && liveTarget.freshOnAsk === undefined);

  ok('FRESH_ON_ASK_WAIT_MS: unset → 5000, "0" → 0, "30000" → 30000',
    envMod.freshOnAskWaitMs(undefined) === 5000 && envMod.freshOnAskWaitMs('') === 5000 && envMod.freshOnAskWaitMs('0') === 0 && envMod.freshOnAskWaitMs('30000') === 30_000);
  const refusedEnv = ['30001', '5s', '-1', '1e3'].filter((raw) => {
    try {
      envMod.parseEnv({ AUTH_MODE: 'dev', FRESH_ON_ASK_WAIT_MS: raw });
      return false;
    } catch (err) {
      return err instanceof envMod.EnvError && /FRESH_ON_ASK_WAIT_MS/.test(err.message);
    }
  });
  ok('negative control: parseEnv stops startup on 30001, "5s", -1 and 1e3, naming the variable', refusedEnv.length === 4, refusedEnv.join(','));
  ok('…and starts with a good one', envMod.parseEnv({ AUTH_MODE: 'dev', FRESH_ON_ASK_WAIT_MS: '2500' }).port === 8080);

  // ── 3. Over the RPC route ──────────────────────────────────────────────────
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-freshonask-'));
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
  const cols = [{ name: 'id', type: 'number' as const }, { name: 'updated', type: 'number' as const }, { name: 'amount', type: 'number' as const }];
  const incOn = { enabled: true, cursorColumn: 'updated', keyColumn: 'id', lookback: 0, highWater: 3, runsSinceFull: 1, log: [] };
  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    const projectId = (await projects.createProject('Fresh on ask')).id;
    const pg = await conns.saveConnection(projectId, { name: 'App DB', connectorId: 'postgres', values: { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' } });
    const rs = await conns.saveConnection(projectId, { name: 'Warehouse', connectorId: 'amazon-redshift', values: { host: 'dw.example.com', port: 5439, database: 'dw', user: 'reader', ssl: true } });
    if (!pg || !rs) throw new Error('connections not saved');
    const mk = (name: string) => datasets.saveDataset(projectId, { name, sourceKind: 'postgres', columns: cols, rows: [[1, 1, 10], [2, 2, 20], [3, 3, 30]], origin: { kind: 'connection', connId: pg.id, table: name.toLowerCase() } });
    const withInc = await mk('Orders');
    const without = await mk('Plain');
    const fullDue = await mk('Fresh table');
    const pasted = await datasets.saveDataset(projectId, { name: 'Pasted', sourceKind: 'paste', columns: cols, rows: [[1, 1, 1]] });
    const live = await liveRecord.saveLiveRecord(projectId, { name: 'Live', columns: cols, origin: { kind: 'connection', connId: rs.id, table: 'orders' } });
    if (!withInc || !without || !fullDue || !pasted || !live) throw new Error('datasets not saved');
    await datasets.writeIncremental(projectId, withInc.id, () => incOn);
    await datasets.writeIncremental(projectId, fullDue.id, () => ({ ...incOn, highWater: null }));
    return { projectId, withInc: withInc.id, without: without.id, fullDue: fullDue.id, pasted: pasted.id, live: live.id };
  });
  const P = seed.projectId;
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  const post = async (channel: string, payload: unknown) => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
    });
    return { status: r.statusCode, body: r.body, value: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as any }; // any: each reply is narrowed by the check that reads it
  };
  const dsDir = path.join(DATA, 'orgs', 'acme', 'userData', 'projects', P, 'datasets');
  const raw = (id: string) => JSON.parse(fs.readFileSync(path.join(dsDir, `${id}.json`), 'utf8'));
  const set = (datasetId: string, freshOnAsk: unknown) => post('dataset:update', { projectId: P, datasetId, freshOnAsk });

  const noInc = await set(seed.without, { maxStalenessSec: 300 });
  ok('refused without incremental refresh, with the catalog\'s sentence', noInc.value?.ok === false && noInc.value.error === EN['freshOnAskMessages.fresh_on_ask_needs_incremental_refresh'], noInc.body);
  ok('…and nothing was stored', !('freshOnAsk' in raw(seed.without)));
  const pasted = await set(seed.pasted, { maxStalenessSec: 300 });
  ok('refused on a paste (no connection, so no incremental refresh)', pasted.value?.ok === false && pasted.value.error === EN['freshOnAskMessages.fresh_on_ask_needs_incremental_refresh'], pasted.body);
  const live = await set(seed.live, { maxStalenessSec: 300 });
  ok('refused on a Live dataset, saying why', live.value?.ok === false && live.value.error === EN['freshOnAskMessages.a_live_dataset_is_asked_at'] && !('freshOnAsk' in raw(seed.live)), live.body);
  const accepted = await set(seed.withInc, { maxStalenessSec: 300 });
  ok('negative control: accepted with incremental refresh on', accepted.status === 200 && accepted.value?.ok === true, accepted.body);
  ok('…stored on the record as the age alone', JSON.stringify(raw(seed.withInc).freshOnAsk) === '{"maxStalenessSec":300}', JSON.stringify(raw(seed.withInc).freshOnAsk));
  for (const bad of [59, 86_401, 1.5]) {
    const r = await set(seed.withInc, { maxStalenessSec: bad });
    ok(`the contract refuses ${bad} s (400), and the stored age is unchanged`, r.status === 400 && raw(seed.withInc).freshOnAsk.maxStalenessSec === 300, r.body);
  }
  const shape = api.contracts['dataset:update'].input;
  ok('contract: { maxStalenessSec } or null — an extra key is refused', shape.safeParse({ projectId: P, datasetId: seed.withInc, freshOnAsk: null }).success
    && !shape.safeParse({ projectId: P, datasetId: seed.withInc, freshOnAsk: { maxStalenessSec: 60, triggeredAt: ago(1) } }).success);

  const list = await post('dataset:list', { projectId: P });
  const row = (id: string) => (list.value as { id: string; freshOnAsk?: unknown }[]).find((d) => d.id === id);
  ok('the list carries the age (and never the pull\'s stamp)', JSON.stringify(row(seed.withInc)?.freshOnAsk) === '{"maxStalenessSec":300}', JSON.stringify(row(seed.withInc)));
  ok('…and no block on a dataset without it', row(seed.without)?.freshOnAsk === undefined);
  await set(seed.fullDue, { maxStalenessSec: 60 });
  const list2 = await post('dataset:list', { projectId: P });
  const full = (list2.value as { id: string; freshOnAsk?: { fullDue?: boolean } }[]).find((d) => d.id === seed.fullDue);
  ok('a dataset whose next refresh is full says it waits for it (fullDue)', full?.freshOnAsk?.fullDue === true, JSON.stringify(full));

  const off = await set(seed.withInc, null);
  ok('null turns it off', off.value?.ok === true && !('freshOnAsk' in raw(seed.withInc)), off.body);
  await set(seed.withInc, { maxStalenessSec: 900 });
  await context.runInContext(ADMIN, 'inc-off', () => datasets.writeIncremental(P, seed.withInc, (cur) => (cur ? { ...cur, enabled: false } : cur)));
  ok('turning incremental refresh off drops fresh on ask in the same write', !('freshOnAsk' in raw(seed.withInc)) && raw(seed.withInc).incremental.enabled === false);
  await context.runInContext(ADMIN, 'inc-on', () => datasets.writeIncremental(P, seed.withInc, (cur) => (cur ? { ...cur, enabled: true } : cur)));
  ok('…and turning it back on does not revive it', !('freshOnAsk' in raw(seed.withInc)));

  // A hand-edited block on a dataset without incremental refresh reads back as absent.
  const file = path.join(dsDir, `${seed.without}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...raw(seed.without), freshOnAsk: { maxStalenessSec: 60 } }));
  const meta = await context.runInContext(ADMIN, 'meta', () => datasets.getDatasetMeta(P, seed.without));
  ok('a hand-edited block without incremental refresh is dropped on load', meta !== null && meta.freshOnAsk === undefined);
  const metaOn = await context.runInContext(ADMIN, 'meta', async () => {
    await datasets.updateSteps(P, seed.fullDue, [{ type: 'filter', column: 'amount', op: '>', value: 0 }]);
    return datasets.getDatasetMeta(P, seed.fullDue);
  });
  ok('a table write (a prepare edit persists the record) keeps the block', metaOn?.freshOnAsk?.maxStalenessSec === 60 && raw(seed.fullDue).freshOnAsk.maxStalenessSec === 60);

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
