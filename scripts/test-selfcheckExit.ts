// finish() must not abort a suite whose last handler left an async DuckDB
// query running. A bare process.exit() around a live @duckdb/node-api call
// dies with `terminate called after throwing an instance of 'Napi::Error'`
// (exit 134) — it failed test-dashboardsServer on CI after every check passed.
// selfcheck.finish() waits for the bridge worker (duckdb.busyWorker) instead.
//
//   npm run build:ts && node scripts/test-selfcheckExit.js

import { ok, finish } from './selfcheck';
import { spawnSync } from 'child_process';
import * as path from 'path';

const root = path.join(__dirname, '..');

function run(exit: 'bare' | 'finish'): { code: number | null; aborted: boolean } {
  const code = `
    const duck = require('./src/engine/duckdb.js');
    const { finish } = require('./scripts/selfcheck.js');
    // Warm the worker first, so the long query is running (not queued behind a cold boot) when the exit comes.
    duck.queryAsync('SELECT 1').then(() => {
      duck.queryAsync('SELECT count(*) AS n FROM range(400000000) t(i) WHERE i % 7 = 3').catch(() => {});
      setTimeout(() => ${exit === 'bare' ? 'process.exit(0)' : 'finish()'}, 300);
    });
  `;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 150_000 });
  return { code: r.status, aborted: /Napi::Error|terminate called/.test(r.stderr + r.stdout) };
}

const viaFinish = run('finish');
ok('finish() with a query in flight exits 0, no native abort', viaFinish.code === 0 && !viaFinish.aborted, JSON.stringify(viaFinish));
// Negative control: the same process with a bare exit does abort, so the check above can fail.
const bare = run('bare');
ok('negative control: a bare process.exit() around the query aborts', bare.code !== 0 && bare.aborted, JSON.stringify(bare));

finish();
