// Folder watch (src/connectors/folderWatch.ts): the debounce, the extension
// filter, close(), one watcher per connection, and that a headless run starts
// nothing. The timing checks drive an INJECTED watch function with a short
// debounce, so they are deterministic; one last check runs the real fs.watch
// against a temp folder with a bounded wait.
//
//   npm run build:ts && node scripts/test-folderWatch.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
// ponytail: compiled sibling of the .ts source.
const fw: typeof import('../src/connectors/folderWatch') = require('../src/connectors/folderWatch');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A watch function the test fires by hand. */
function fakeWatch() {
  const state = { opened: [] as string[], closed: 0, fire: (_file: string | null): void => { /* set on open */ } };
  const watch: import('../src/connectors/folderWatch').WatchFn = (dir, _opts, onEvent) => {
    state.opened.push(dir);
    state.fire = (file) => onEvent('change', file);
    return { close: () => { state.closed += 1; } };
  };
  return { state, watch };
}

const conn = (id: string, values: Record<string, unknown>, connectorId = 'csv-folder') =>
  ({ id, projectId: 'p-1', connectorId, values });

void (async () => {
  // ── One folder: debounce, filter, close ────────────────────────────────────
  {
    const f = fakeWatch();
    let fired = 0;
    const w = fw.watchFolder('/data', '.csv', () => { fired += 1; }, { watch: f.watch, debounceMs: 40 });
    for (let i = 0; i < 6; i += 1) f.state.fire('sales.csv');
    await sleep(15);
    f.state.fire('sales.csv');
    ok('debounce: nothing fires during the burst', fired === 0);
    await sleep(90);
    ok('debounce: a burst of seven events is ONE change', fired === 1, fired);

    f.state.fire('notes.txt');
    f.state.fire('data.parquet');
    f.state.fire('sales.csv.tmp');
    await sleep(90);
    ok('filter: only files with the connector\'s extension count', fired === 1, fired);
    f.state.fire('UPPER.CSV');
    await sleep(90);
    ok('filter: the extension match ignores case', fired === 2, fired);
    f.state.fire(null);
    await sleep(90);
    ok('filter: an event with no filename counts (a spare refresh beats a missed one)', fired === 3, fired);

    f.state.fire('late.csv');
    w.close();
    await sleep(90);
    ok('close: a change pending at close() never fires', fired === 3, fired);
    f.state.fire('after.csv');
    await sleep(90);
    ok('close: events after close() are ignored, and the OS watcher is closed', fired === 3 && f.state.closed === 1);
  }

  // ── Which connections are watched ──────────────────────────────────────────
  ok('target: a ticked csv folder is watched for .csv',
    JSON.stringify(fw.watchTarget(conn('c', { path: '/data', watch: true }))) === '{"dir":"/data","ext":".csv","recursive":false}');
  ok('target: a parquet folder for .parquet, recursively when subfolders are on',
    fw.watchTarget(conn('c', { path: '/d', watch: true, recursive: true }, 'parquet-folder'))?.ext === '.parquet' &&
    fw.watchTarget(conn('c', { path: '/d', watch: true, recursive: true }, 'parquet-folder'))?.recursive === true);
  ok('target: unticked, a relative path, or another connector is not watched',
    fw.watchTarget(conn('c', { path: '/d', watch: false })) === null &&
    fw.watchTarget(conn('c', { path: 'data', watch: true })) === null &&
    fw.watchTarget(conn('c', { path: '/d', watch: true }, 'duckdb-file')) === null &&
    fw.watchTarget(conn('c', { path: '/d', watch: 'true' })) === null);

  // ── Headless starts nothing ────────────────────────────────────────────────
  {
    const f = fakeWatch();
    const n = fw.start({ headless: true, connections: [conn('h1', { path: '/data', watch: true })], refresh: () => {}, watch: f.watch });
    fw.sync('h2', conn('h2', { path: '/data', watch: true }));
    ok('headless: start() watches nothing, and a later sync() cannot start one', n === 0 && fw.activeCount() === 0 && f.state.opened.length === 0);
  }

  // ── The manager: one watcher per connection, following the record ─────────
  {
    const f = fakeWatch();
    const refreshed: string[] = [];
    const n = fw.start({
      connections: [conn('a', { path: '/one', watch: true }), conn('b', { path: '/two', watch: false })],
      refresh: (projectId, connId) => refreshed.push(projectId + '/' + connId),
      watch: f.watch,
      debounceMs: 30,
    });
    ok('start: only the ticked connection is watched', n === 1 && fw.isWatching('a') && !fw.isWatching('b'));
    f.state.fire('x.csv');
    await sleep(80);
    ok('start: a change refreshes THAT connection', refreshed.join() === 'p-1/a', refreshed.join());

    fw.sync('a', conn('a', { path: '/one', watch: true, lastStatus: 'ok' }));
    ok('sync: an unrelated write (a status update) keeps the same watcher', f.state.opened.length === 1 && f.state.closed === 0);
    fw.sync('a', conn('a', { path: '/moved', watch: true }));
    ok('sync: a new folder replaces the watcher', f.state.opened.join() === '/one,/moved' && f.state.closed === 1 && fw.activeCount() === 1);
    fw.sync('a', conn('a', { path: '/moved', watch: false }));
    ok('sync: clearing the box closes it', fw.activeCount() === 0 && f.state.closed === 2);
    fw.sync('b', conn('b', { path: '/two', watch: true }));
    fw.sync('b', null);
    ok('sync: deleting the connection closes its watcher', fw.activeCount() === 0 && f.state.closed === 3);
    fw.sync('c', conn('c', { path: '/three', watch: true }));
    fw.stopAll();
    ok('stopAll: every watcher closes (app quit)', fw.activeCount() === 0 && f.state.closed === 4);
  }

  // ── The real fs.watch, on a temp folder ────────────────────────────────────
  // A process sandbox (macOS Seatbelt) can refuse the OS watch facility outright
  // — fs.watch then errors with EMFILE/EPERM. That is the environment, not this
  // module, so it is reported as a skip; anywhere a watcher CAN open, it runs.
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-watch-probe-'));
  const refusal = await new Promise<string>((resolve) => {
    try {
      const w = fs.watch(probeDir, () => { /* probe only */ });
      w.on('error', (e: NodeJS.ErrnoException) => { w.close(); resolve(e.code || 'error'); });
      setTimeout(() => { w.close(); resolve(''); }, 150);
    } catch (e) {
      resolve((e as NodeJS.ErrnoException).code || 'error');
    }
  });
  fs.rmSync(probeDir, { recursive: true, force: true });
  if (refusal) console.log(`skip fs.watch checks: this environment refuses fs.watch (${refusal})`);
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-watch-'));
    const refreshed: string[] = [];
    fw.start({ connections: [conn('real', { path: dir, watch: true })], refresh: (_p, c) => refreshed.push(c), debounceMs: 100 });
    await sleep(100); // let the OS watcher settle before the first write
    fs.writeFileSync(path.join(dir, 'new.csv'), 'a,b\n1,2\n');
    fs.appendFileSync(path.join(dir, 'new.csv'), '3,4\n');
    const end = Date.now() + 5000;
    while (refreshed.length === 0 && Date.now() < end) await sleep(50);
    await sleep(300);
    ok('fs.watch: a new CSV in the folder triggers exactly one refresh', refreshed.length === 1, refreshed.length);
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'hi');
    await sleep(600);
    ok('fs.watch: a non-CSV file does not', refreshed.length === 1, refreshed.length);
    fw.stopAll();
    fs.writeFileSync(path.join(dir, 'after.csv'), 'a\n1\n');
    await sleep(400);
    ok('fs.watch: nothing fires after stopAll()', refreshed.length === 1, refreshed.length);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  finish();
})();
