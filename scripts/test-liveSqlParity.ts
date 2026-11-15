'use strict';

// THE differential of SQL on Live datasets, on DuckDB (docs/live-data/01-live-sql.md, "Proof", F2).
//
// The model's DuckDB SQL is the reference: DuckDB runs the corpus (./liveSqlCorpus.ts) over the
// EXTRACT, through phase B's own lane (`runSql`: compile(), the gate, our Parquet), each table a view
// projecting exactly as the Live view does. Live translates the same text, prints it for the DuckDB
// dialect and runs it over the fixture as a warehouse types it (./liveParityFixture.ts). Every cell
// agrees under `Object.is` (float sums and means within 1e-13), in order — unlocked, and again under
// a viewer's row lock. The normalisations are ./liveSqlDiff.ts's, each pinned (./liveSqlPins.ts).
//
// NEGATIVE CONTROLS, each must make the differential disagree: the lock dropped from the view,
// LEFT printed as INNER, the '' → NULL fold removed, the null order flipped. (The fifth — integer
// division with no `toDouble` on a count — needs an engine that divides integers as integers, so it
// runs in test-liveSqlParityPostgres.) Every hostile literal binds and agrees too.
//
//   npm run build:ts && node scripts/test-liveSqlParity.js

import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livesql-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const corpus: typeof import('./liveSqlCorpus') = require('./liveSqlCorpus');
const diff: typeof import('./liveSqlDiff') = require('./liveSqlDiff');
const pins: typeof import('./liveSqlPins') = require('./liveSqlPins');

async function main(): Promise<void> {
  const kit = await diff.setupKit(ok);
  if (!kit) return;
  const engine = fx.duckEngine;
  const sources = await diff.loadSources(kit, engine);
  const open = await diff.runCorpus(kit, sources, engine, ok, false);
  const locked = await diff.runCorpus(kit, sources, engine, ok, true);
  ok(`the corpus: ${corpus.CASES.length} statements agree on DuckDB, unlocked (${open}) and locked (${locked})`, open === corpus.CASES.length && locked === corpus.CASES.length);
  for (const c of diff.literalCases()) {
    const p = await diff.problems(kit, c, sources, engine, { lock: false });
    ok(`${engine.name}: ${c.name} binds and agrees`, p.length === 0, p.join(' | '));
  }
  await pins.controls(kit, sources, engine, ok);
  await pins.run(kit, sources, engine, ok);
}

main()
  .catch((e) => ok('live SQL parity suite threw', false, e && (e as Error).stack))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
