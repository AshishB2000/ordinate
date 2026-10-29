// finish() must never exit the process around a live DuckDB worker. A bare
// process.exit() around one dies with `terminate called after throwing an
// instance of 'Napi::Error'` (exit 134) — every time with a query in flight,
// and sometimes even with the worker idle (test-geoAgg, 16 at a time: 33 aborts
// in 280 runs). It failed suites on CI after every check had passed. finish()
// closes every DuckDB worker through its own queue (duckdb.closeAll) and exits
// once each has gone. Each child below reports how many DuckDB workers were
// still alive when process.exit ran; the invariant is none.
//
//   npm run build:ts && node scripts/test-selfcheckExit.js

import { ok, finish } from './selfcheck';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-exit-'));

type How = 'bare' | 'finish' | 'idle' | 'shutdown' | 'routed';

function run(how: How): { code: number | null; aborted: boolean; alive: number } {
  // The long query is issued after a warm-up, so it is RUNNING (not queued
  // behind a cold boot) when the exit comes 300 ms later.
  const exit = {
    bare: `issue(); setTimeout(() => process.exit(0), 300);`,
    finish: `issue(); setTimeout(finish, 300);`,
    idle: `finish();`,
    // app.close()'s shape: shutdown() lets the bridge's worker go mid-query, then the suite finishes.
    shutdown: `issue(); setTimeout(() => { duck.shutdown(); finish(); }, 300);`,
    routed: `issue(); setTimeout(finish, 300);`,
  }[how];
  const code = `
    const wt = require('worker_threads');
    const duckWorkers = [];
    wt.Worker = class extends wt.Worker {
      constructor(file, opts) {
        super(file, opts);
        if (String(file).endsWith('duckdbWorker.js')) { duckWorkers.push(this); this.once('exit', () => { this.gone = true; }); }
      }
    };
    const exit = process.exit;
    process.exit = (c) => { process.stdout.write('alive=' + duckWorkers.filter((w) => !w.gone).length + '\\n'); exit(c); };
    const duck = require('./src/engine/duckdb.js');
    const { finish } = require('./scripts/selfcheck.js');
    const issue = () => duck.queryAsync('SELECT count(*) AS n FROM range(400000000) t(i) WHERE i % 7 = 3').catch(() => {});
    const go = () => duck.queryAsync('SELECT 1').then(() => { ${exit} });
    if (${how === 'routed'}) {
      require('./src/engine/duckdbPool.js').routeByOrg({ dataDir: ${JSON.stringify(dataDir)}, maxWorkers: 2, memoryLimit: '256MiB', threads: 4, queryTimeoutMs: 60000, idleMs: 60000 });
      require('./src/server/context.js').runInContext({ user: { email: 'u@acme.test', role: 'admin' }, org: { id: 'acme' } }, 'exit', go);
    } else go();
  `;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 150_000 });
  const alive = /alive=(\d+)/.exec(r.stdout);
  return { code: r.status, aborted: /Napi::Error|terminate called/.test(r.stderr + r.stdout), alive: alive ? Number(alive[1]) : -1 };
}

const clean = (r: ReturnType<typeof run>): boolean => r.code === 0 && !r.aborted && r.alive === 0;

const viaFinish = run('finish');
ok('finish() with a query in flight: every DuckDB worker gone first, exit 0, no native abort', clean(viaFinish), JSON.stringify(viaFinish));
const idle = run('idle');
ok('finish() with the worker idle: it is closed and gone before the exit', clean(idle), JSON.stringify(idle));
const shutdown = run('shutdown');
ok('finish() after shutdown() let the busy worker go: still waits for it', clean(shutdown), JSON.stringify(shutdown));
const routed = run('routed');
ok("finish() with a query in flight in an org's pool worker (routeByOrg): waits for that worker", clean(routed), JSON.stringify(routed));
// Negative control: the same process with a bare exit does abort, so the checks above can fail.
const bare = run('bare');
ok('negative control: a bare process.exit() around the query aborts, its worker still alive', bare.code !== 0 && bare.aborted && bare.alive === 1, JSON.stringify(bare));

// A harness that threw sets exitCode 1 with no failed check: finish() must keep it (it once reset it to 0).
const verdict = (pre: string) => spawnSync(process.execPath, ['-e', `${pre}; require('./scripts/selfcheck.js').finish();`], { cwd: root, encoding: 'utf8' }).status;
ok('finish(): a harness that threw (exitCode 1, no failed check) still exits 1', verdict('process.exitCode = 1') === 1);
ok('finish() (NEGATIVE CONTROL): nothing failed → exit 0', verdict('') === 0);

fs.rmSync(dataDir, { recursive: true, force: true });
finish();
