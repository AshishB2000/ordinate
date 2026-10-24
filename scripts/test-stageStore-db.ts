// Staged imports in Postgres + Parquet (src/data/stageStore.ts; docs/any-pod/00-design.md §3.4),
// in-process, file mode, against a scratch database:
//
//   1. THE RACE (review M3): three puts by one user at once, the first one slow — before, the third
//      evicted the first's row mid-write: its id answered GONE and its Parquet stayed with no row,
//      forever. Now only READY stages are evicted and the newest-ready is kept: every returned id
//      but the oldest-ready resolves, two rows stay, and every stage file has a row;
//   2. the backstop: a stage file no row names, older than the TTL, is swept; a young one (a write in
//      flight) and one with a row are kept;
//   3. memory (review M4): a memory copy past its TTL leaves the heap;
//   4. get() against the very table put (review L7): Object.is on every cell — −0, NaN, ±Infinity,
//      a lone surrogate, NUL — from Parquet (no memory copy) and from memory.
//
// Needs DATABASE_URL; else one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-stageStore-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { randomUUID } from 'crypto';
import * as H from './podHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const context: typeof import('../src/server/context') = require('../src/server/context');
const stages: typeof import('../src/data/stageStore') = require('../src/data/stageStore');
const staging: typeof import('../src/server/staging') = require('../src/server/staging');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');

type Cell = import('../src/data/transforms').Cell;
type ParseResult = import('../src/data/parse').ParseResult;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-stagestore-'));
const ME = { user: { email: 'u1@acme.test', role: 'admin' as const }, org: { id: 'acme' } };
const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ME, 't', fn);
const NASTY: Cell[] = [-0, NaN, Infinity, -Infinity, '007', 'a\uD800b', 'n\u0000ul', '﻿bom', '', null, 1e21, 0.1 + 0.2];
const table = (rows: number, width = 4): ParseResult => ({
  columns: Array.from({ length: width }, (_, i) => ({ name: `c${i}`, type: i % 2 ? 'number' : 'text' })),
  rows: Array.from({ length: rows }, (_, r) => Array.from({ length: width }, (_, c) => NASTY[(r * 5 + c) % NASTY.length])),
  rowCount: rows,
  warnings: ['w'],
});
const same = (a: Cell[][], b: Cell[][]): boolean => a.length === b.length && a.every((row, r) => row.length === b[r].length && row.every((v, c) => Object.is(v, b[r][c])));
const stageFiles = (): string[] => fs.readdirSync(staging.tempDir('acme')).filter((n) => /^stage-.*\.parquet$/.test(n));

(async () => {
  const db = await H.scratchDb('stagestore');
  if (!db) {
    console.log('skip import-stage checks: DATABASE_URL is unset');
    return finish();
  }
  try {
    await mig.migrate(db.pool);
    context.enterServerMode(DATA);
    stages.useStageDb(db.pool);

    // 1. Three puts at once, the first slow (300k rows), the other two tiny.
    const slow = as(() => stages.put(table(300_000)));
    await H.sleep(80);
    const [b, c] = await Promise.all([as(() => stages.put(table(3))), as(() => stages.put(table(4)))]);
    const a = await slow;
    const rows = (await db.pool.query<{ id: string; ready: boolean }>('SELECT id, ready_at IS NOT NULL AS ready FROM import_stages')).rows;
    const files = stageFiles();
    const got = await as(async () => ({ a: await stages.get(a, 1), b: await stages.get(b, 1), c: await stages.get(c, 1) }));
    ok('three puts at once, the first slow: the slow one is kept (it finished last — never GONE on its own reply), two rows stay, one of the quick ones goes',
      !!got.a && [got.b, got.c].filter(Boolean).length === 1 && rows.length === 2 && rows.every((r) => r.ready), JSON.stringify({ rows: rows.length, got: { a: !!got.a, b: !!got.b, c: !!got.c } }));
    ok('…and no stage file is left without a row (nothing orphaned by an eviction mid-write)',
      files.length === rows.length && files.every((n) => rows.some((r) => n.includes(r.id))), JSON.stringify({ files, rows }));

    // 2. The orphan backstop.
    const dir = staging.tempDir('acme');
    const old = path.join(dir, `stage-${randomUUID()}.parquet`);
    const young = path.join(dir, `stage-${randomUUID()}.parquet`);
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(young, 'x');
    const past = new Date(Date.now() - stages.TTL_MS - 60_000);
    fs.utimesSync(old, past, past);
    await as(() => stages.sweep(db.pool, 'acme'));
    ok('the sweep deletes a stage file no row names once it is older than the TTL; a young one (a write in flight) and named ones stay',
      !fs.existsSync(old) && fs.existsSync(young) && stageFiles().length === rows.length + 1);

    // 3. Memory copies expire.
    stages.forgetMemoryForTest();
    await as(() => stages.put(table(10)));
    const held = stages.memoryForTest().size;
    stages.pruneMemory(Date.now() + stages.TTL_MS + 1);
    ok('a memory copy past its TTL leaves the heap (control: it was held)', held === 1 && stages.memoryForTest().size === 0, JSON.stringify({ held, after: stages.memoryForTest() }));

    // 4. get() against the very table put — from Parquet, then from memory.
    const big = table(70_000); // 280,000 cells: past the memory cap, so get() reads the Parquet
    const bigId = await as(() => stages.put(big));
    const fromParquet = await as(() => stages.get(bigId));
    ok('get() from Parquet is the table put: Object.is on every cell (−0, NaN, ±Infinity, a lone surrogate, NUL, a BOM)',
      !!fromParquet && same(fromParquet.rows, big.rows) && fromParquet.rowCount === big.rowCount && JSON.stringify(fromParquet.columns) === JSON.stringify(big.columns));
    const small = table(50);
    const smallId = await as(() => stages.put(small));
    const fromMemory = await as(() => stages.get(smallId));
    stages.forgetMemoryForTest();
    const smallFromParquet = await as(() => stages.get(smallId));
    ok('…and the memory fast path and the Parquet read give the same table', !!fromMemory && !!smallFromParquet && same(fromMemory.rows, smallFromParquet.rows) && same(smallFromParquet.rows, small.rows));
  } finally {
    stages.useStageDb(null);
    await db.drop();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  finish();
})().catch((err) => {
  ok('the suite ran to the end', false, err instanceof Error ? err.stack : err);
  finish();
});
