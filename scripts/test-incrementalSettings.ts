// Incremental refresh settings in the web app (`incremental:get` / `incremental:set`,
// src/data/incrementalSettings.ts) — the desktop panel's server port — over the
// real RPC route in server mode, records as files.
//
//   1. The view: the columns that can be the cursor (number and date only, of the
//      prepare SOURCE), every column as a key, the source read with the cursor
//      pushed down, nothing stored yet.
//   2. Turning it on (update by key): stored; the first run will be full; the
//      list says `incrementalOn`; the 5-minute cadence and fresh on ask, refused
//      before (NEGATIVE CONTROL), are now accepted.
//   3. Every field re-checked against the record, refused with the catalog's
//      sentence: a text cursor, an unknown cursor, update by key without a key or
//      with an unknown one, append with a key; the contract refuses a negative
//      lookback, an unknown mode, a missing field, an extra one (400).
//   4. A new cursor resets the mark (the next run is full); the same cursor with
//      a new lookback keeps it (NEGATIVE CONTROL). Append drops the key.
//   5. Off: kept with its log; a 5-minute schedule drops to hourly and fresh on
//      ask goes, in the same write.
//   6. Refused to turn on: Live, a paste, a connection that is gone, a table with
//      no number or date column, and a source that cannot take the cursor
//      (ClickHouse over HTTP: "filtered after fetch") — which may still be turned
//      OFF when an older record has it on.
//   7. The narrowest access: read for the view, write for a change. A missing
//      dataset, and a thrown error, answer with the catalog's sentence — never
//      the error's own text, which can carry a path (NEGATIVE CONTROL).
//
//   npm run build:ts && node scripts/test-incrementalSettings.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const api: typeof import('../src/api/index') = require('../src/api/index');

const EN: Record<string, string> = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));
const msg = (slug: string): string => EN[`incrementalMessages.${slug}`];
const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-incset-'));

(async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
  const cols = [{ name: 'id', type: 'number' as const }, { name: 'updated', type: 'number' as const }, { name: 'at', type: 'date' as const }, { name: 'region', type: 'text' as const }];
  const rows = [[1, 1, '2026-10-01', 'North'], [2, 2, '2026-10-02', 'South']];
  const seed = await context.runInContext(ADMIN, 'seed', async () => {
    await projects.init();
    const projectId = (await projects.createProject('Incremental settings')).id;
    const pg = await conns.saveConnection(projectId, { name: 'App DB', connectorId: 'postgres', values: { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' } });
    const ch = await conns.saveConnection(projectId, { name: 'Events', connectorId: 'clickhouse', values: { url: 'https://ch.example.com', database: 'default', user: 'reader' } });
    const rs = await conns.saveConnection(projectId, { name: 'Warehouse', connectorId: 'amazon-redshift', values: { host: 'dw.example.com', port: 5439, database: 'dw', user: 'reader', ssl: true } });
    if (!pg || !ch || !rs) throw new Error('connections not saved');
    const mk = (name: string, connId: string, c = cols, r: (string | number)[][] = rows) =>
      datasets.saveDataset(projectId, { name, sourceKind: 'postgres', columns: c, rows: r, origin: { kind: 'connection', connId, table: name.toLowerCase() } });
    const orders = await mk('Orders', pg.id);
    const events = await mk('Events', ch.id);
    const gone = await mk('Gone', '7d1f3c2a-0b6e-4f5a-9c8d-1e2f3a4b5c6d');
    const words = await mk('Words', pg.id, [{ name: 'word', type: 'text' }], [['a'], ['b']]);
    const pasted = await datasets.saveDataset(projectId, { name: 'Pasted', sourceKind: 'paste', columns: cols, rows });
    const live = await liveRecord.saveLiveRecord(projectId, { name: 'Live', columns: cols, origin: { kind: 'connection', connId: rs.id, table: 'orders' } });
    if (!orders || !events || !gone || !words || !pasted || !live) throw new Error('datasets not saved');
    // A prepare step that drops `updated` from the derived table: the cursor still comes from the source.
    await datasets.updateSteps(projectId, orders.id, [{ type: 'drop_column', column: 'updated' }]);
    return { projectId, orders: orders.id, events: events.id, gone: gone.id, words: words.id, pasted: pasted.id, live: live.id };
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
  const get = (datasetId: string) => post('incremental:get', { projectId: P, datasetId });
  const set = (datasetId: string, patch: object) => post('incremental:set', { projectId: P, datasetId, enabled: true, cursorColumn: 'updated', mode: 'upsert', keyColumn: 'id', lookback: 0, ...patch });
  const dsDir = path.join(DATA, 'orgs', 'acme', 'userData', 'projects', P, 'datasets');
  const raw = (id: string) => JSON.parse(fs.readFileSync(path.join(dsDir, `${id}.json`), 'utf8'));
  const summary = async (id: string) => ((await post('dataset:list', { projectId: P })).value as { id: string; incrementalOn?: boolean; autoRefresh?: { every: string }; freshOnAsk?: unknown }[]).find((d) => d.id === id);

  // ── 1. The view ────────────────────────────────────────────────────────────
  const v1 = await get(seed.orders);
  ok('the view: not blocked, the cursor pushed to PostgreSQL, nothing stored yet', v1.value?.ok === true && v1.value.blocked === null && v1.value.fetch === 'server'
    && v1.value.source === 'PostgreSQL' && v1.value.settings === null && v1.value.fullEvery === 7, v1.body.slice(0, 300));
  ok('the view: cursor candidates are the number and date columns of the SOURCE (updated survives a step that drops it)',
    JSON.stringify(v1.value.cursorColumns) === '[{"name":"id","type":"number"},{"name":"updated","type":"number"},{"name":"at","type":"date"}]'
      && !raw(seed.orders).columns.some((c: { name: string }) => c.name === 'updated'), JSON.stringify(v1.value.cursorColumns));
  ok('the view: every source column may be the key', JSON.stringify(v1.value.keyColumns) === '["id","updated","at","region"]');
  ok('the view carries no address, no SQL, no origin', !/db\.example\.com|select|"origin"|"table"/i.test(v1.body), v1.body);

  // ── 2. On, by key ──────────────────────────────────────────────────────────
  const fast0 = await post('dataset:update', { projectId: P, datasetId: seed.orders, autoRefresh: '5min' });
  const fo0 = await post('dataset:update', { projectId: P, datasetId: seed.orders, freshOnAsk: { maxStalenessSec: 300 } });
  ok('NEGATIVE CONTROL: before it is on, every 5 minutes and fresh on ask are refused', fast0.value?.ok === false && fo0.value?.ok === false);
  const on = await set(seed.orders, {});
  ok('turned on: stored with its cursor and key; the mark unset', on.value?.ok === true && on.value.settings.enabled === true && on.value.settings.cursorColumn === 'updated'
    && on.value.settings.keyColumn === 'id' && on.value.settings.highWater === null, on.body.slice(0, 300));
  ok('…the next run is full, and the view says why', on.value?.nextFull === 'The first run sets the high-water mark', String(on.value?.nextFull));
  ok('…on the record as incremental.ts stores it', raw(seed.orders).incremental.enabled === true && raw(seed.orders).incremental.keyColumn === 'id' && raw(seed.orders).incremental.runsSinceFull === 0);
  ok('…the list says incrementalOn', (await summary(seed.orders))?.incrementalOn === true);
  const fast1 = await post('dataset:update', { projectId: P, datasetId: seed.orders, autoRefresh: '5min' });
  const fo1 = await post('dataset:update', { projectId: P, datasetId: seed.orders, freshOnAsk: { maxStalenessSec: 300 } });
  ok('…and now every 5 minutes and fresh on ask are taken', fast1.value?.ok === true && fo1.value?.ok === true && raw(seed.orders).autoRefresh.every === '5min' && raw(seed.orders).freshOnAsk.maxStalenessSec === 300);

  // ── 3. Every field re-checked ──────────────────────────────────────────────
  const refusals: [string, object, string][] = [
    ['a text column as the cursor', { cursorColumn: 'region' }, msg('pick_a_number_or_date_column')],
    ['a cursor that is no column', { cursorColumn: 'nope' }, msg('pick_a_number_or_date_column')],
    ['update by key without a key', { keyColumn: undefined }, msg('pick_the_column_whose_value_identifies')],
    ['update by key with an unknown key', { keyColumn: 'nope' }, msg('pick_the_column_whose_value_identifies')],
    ['append with a key', { mode: 'append' }, msg('append_mode_adds_new_rows_and')],
  ];
  for (const [what, patch, want] of refusals) {
    const r = await set(seed.orders, patch);
    ok(`refused, with the catalog's sentence: ${what}`, r.value?.ok === false && r.value.error === want && raw(seed.orders).incremental.cursorColumn === 'updated', r.body.slice(0, 200));
  }
  for (const [what, payload] of [
    ['a negative lookback', { lookback: -1 }], ['an unknown mode', { mode: 'merge' }], ['a missing field', { enabled: undefined }], ['an extra field', { highWater: 9 }],
  ] as const) {
    const r = await set(seed.orders, payload);
    ok(`the contract refuses ${what} (400)`, r.status === 400, r.body.slice(0, 200));
  }

  // ── 4. The mark ────────────────────────────────────────────────────────────
  await context.runInContext(ADMIN, 'mark', () => datasets.writeIncremental(P, seed.orders, (cur) => (cur ? { ...cur, highWater: 2, runsSinceFull: 3 } : cur)));
  const sameCursor = await set(seed.orders, { lookback: 5 });
  ok('NEGATIVE CONTROL: the same cursor with a new lookback keeps the mark and the run count', sameCursor.value?.settings.highWater === 2 && sameCursor.value.settings.runsSinceFull === 3
    && sameCursor.value.settings.lookback === 5);
  const newCursor = await set(seed.orders, { cursorColumn: 'at', lookback: 86_400 });
  ok('a new cursor resets the mark and the count: the next run is full', newCursor.value?.settings.highWater === null && newCursor.value.settings.runsSinceFull === 0
    && newCursor.value.settings.cursorColumn === 'at' && newCursor.value.nextFull === 'The first run sets the high-water mark', newCursor.body.slice(0, 300));
  const append = await set(seed.orders, { cursorColumn: 'at', mode: 'append', keyColumn: undefined, lookback: 86_400 });
  ok('append: stored without a key', append.value?.ok === true && append.value.settings.keyColumn === null && !('keyColumn' in raw(seed.orders).incremental), append.body.slice(0, 200));

  // ── 5. Off ─────────────────────────────────────────────────────────────────
  await context.runInContext(ADMIN, 'log', () => datasets.writeIncremental(P, seed.orders, (cur) => (cur ? { ...cur, log: [{ at: '2026-10-09T01:00:00.000Z', mode: 'full', fetched: 2, inserted: null, updated: null, highWater: '2026-10-02', how: 'full' }] } : cur)));
  const off = await set(seed.orders, { enabled: false, mode: 'append', keyColumn: undefined });
  ok('off: kept (cursor and log) for when it is turned back on', off.value?.ok === true && off.value.settings.enabled === false && off.value.settings.cursorColumn === 'at' && off.value.log.length === 1, off.body.slice(0, 300));
  ok('off: the 5-minute schedule dropped to hourly and fresh on ask went, in the same write', raw(seed.orders).autoRefresh.every === 'hourly' && !('freshOnAsk' in raw(seed.orders)));
  ok('off: the list no longer says incrementalOn', !(await summary(seed.orders))?.incrementalOn);

  // ── 6. Refused to turn on ──────────────────────────────────────────────────
  const blocked: [string, string, string][] = [
    ['a Live dataset', seed.live, msg('a_live_dataset_is_asked_at')],
    ['a paste (no connection)', seed.pasted, msg('only_a_dataset_imported_from_a')],
    ['a dataset whose connection is gone', seed.gone, msg('the_connection_this_dataset_was_imported')],
    ['a table with no number or date column', seed.words, msg('this_dataset_has_no_number_or')],
    ['a source that cannot take the cursor (filtered after fetch)', seed.events, msg('cannot_filter_by_a_column_so').replace('{source}', 'ClickHouse')],
  ];
  for (const [what, id, want] of blocked) {
    const v = await get(id);
    const s = await set(id, { cursorColumn: 'updated' });
    ok(`blocked, the view says why: ${what}`, v.value?.ok === true && v.value.blocked === want, v.body.slice(0, 200));
    ok(`…and turning it on is refused with that sentence, nothing stored: ${what}`, s.value?.ok === false && s.value.error === want && !('incremental' in raw(id)), s.body.slice(0, 200));
  }
  ok('the ClickHouse view says how a run would read it: after the fetch', (await get(seed.events)).value.fetch === 'after');
  const noRead = await Promise.all([seed.live, seed.pasted, seed.gone].map(async (id) => (await get(id)).value?.fetch));
  ok('…while Live, a paste and a gone connection say no read at all (null), not "after the fetch"', noRead.every((f) => f === null), JSON.stringify(noRead));
  // An older record (a desktop import) may have it on over such a source: it can be turned off.
  await context.runInContext(ADMIN, 'legacy', () => datasets.writeIncremental(P, seed.events, () => ({ enabled: true, cursorColumn: 'updated', lookback: 0, highWater: 2, runsSinceFull: 1, log: [] })));
  const legacyOff = await set(seed.events, { enabled: false, mode: 'append', keyColumn: undefined });
  ok('…an older record on over a filtered-after-fetch source can be turned OFF', legacyOff.value?.ok === true && legacyOff.value.settings.enabled === false && raw(seed.events).incremental.enabled === false, legacyOff.body.slice(0, 200));
  const liveOff = await set(seed.live, { enabled: false, mode: 'append', keyColumn: undefined });
  ok('…while a Live dataset refuses even that (it keeps no incremental block)', liveOff.value?.ok === false && liveOff.value.error === msg('a_live_dataset_is_asked_at'));

  // ── 7. Access, and what an error says ──────────────────────────────────────
  ok('the narrowest access: read for the view, write for a change, both scoped to the project',
    api.contracts['incremental:get'].access === 'read' && api.contracts['incremental:set'].access === 'write'
      && typeof (api.contracts['incremental:set'] as { project?: unknown }).project === 'function');
  const missing = await get('5c0f2a1b-3d4e-4f50-8a6b-7c8d9e0f1a2b');
  ok('a dataset that is not there: the catalog\'s "could not read"', missing.value?.ok === false && missing.value.error === msg('could_not_read_the_incremental_refresh'), missing.body.slice(0, 200));
  // A thrown error can carry a path: it goes to the log, the browser gets the catalog's sentence.
  // incrementalSettings resolves `datasets.getDatasetMeta` off the module at call time, so this is observed.
  const realMeta = datasets.getDatasetMeta;
  const PLANTED = path.join(DATA, 'orgs', 'acme', 'planted-path.json');
  (datasets as { getDatasetMeta: unknown }).getDatasetMeta = async () => { throw new Error(`ENOENT: no such file, open '${PLANTED}'`); };
  const quiet = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  const thrownGet = await get(seed.orders);
  const thrownSet = await set(seed.orders, {});
  console.error = quiet;
  (datasets as { getDatasetMeta: unknown }).getDatasetMeta = realMeta;
  ok('a thrown error reaches the browser as the catalog\'s sentence, never its text (a path)',
    thrownGet.value?.ok === false && thrownGet.value.error === msg('could_not_read_the_incremental_refresh')
      && thrownSet.value?.ok === false && thrownSet.value.error === msg('could_not_save_the_incremental_refresh')
      && !thrownGet.body.includes('planted-path') && !thrownSet.body.includes('planted-path'), `${thrownGet.body.slice(0, 200)} ${thrownSet.body.slice(0, 200)}`);
  ok('NEGATIVE CONTROL: the planted path WAS in both errors — the log has it, twice', logged.filter((l) => l.includes('planted-path')).length === 2, logged.join(' | '));
  ok('…and with the reader restored the same dataset reads again', (await get(seed.orders)).value?.ok === true);

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
