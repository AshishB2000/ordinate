// The differential of SQL on Live datasets on a REAL engine in CI: Postgres, standing in for
// Redshift (docs/live-data/01-live-sql.md, "Proof", F2). The same corpus (./liveSqlCorpus.ts) and the
// same reference (DuckDB running the model's text over the extract, ./liveSqlDiff.ts) as
// test-liveSqlParity; Live's side is translated, printed for the Redshift dialect and run through
// the real `amazon-redshift` connector's `live.runBound` — `$n` binds, the read-only session,
// statement_timeout, the row-cap wrapper — in server mode (the SSRF guard on, the database's address
// allowed and pinned), in a scratch database created byte-ordered (`LC_COLLATE 'C'`, Redshift's only
// text order; pin R1) with a hostile default zone (UTC+14; the session is UTC, pin R2).
//
// Every cell agrees under `Object.is` (float sums and means within 1e-13), unlocked and under a
// viewer's lock (md5-compared, row-policy D13). NEGATIVE CONTROLS: the PR plan's five, here the
// fifth too — a count with no `toDouble` divides as an integer on Postgres.
//
// Skips without DATABASE_URL (CI's `check` job sets it: npm test runs this).
//
//   npm run build:ts && DATABASE_URL=postgres://… node scripts/test-liveSqlParityPostgres.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('skip live SQL parity on Postgres: DATABASE_URL is unset (CI sets it; any Postgres this suite may CREATE DATABASE on)');
  finish();
} else {
  void main(url).catch((e: unknown) => ok('live SQL parity on Postgres threw', false, e instanceof Error ? e.stack : String(e))).finally(finish);
}

async function main(adminUrl: string): Promise<void> {
  const fs: typeof import('fs') = require('fs');
  const os: typeof import('os') = require('os');
  const path: typeof import('path') = require('path');
  const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livesql-pg-'));

  const u = new URL(adminUrl);
  const reach = await eng.reachableAddress(u.hostname, Number(u.port || 5432));
  process.env.SSRF_ALLOW = [process.env.SSRF_ALLOW, reach.cidr].filter(Boolean).join(',');
  const context: typeof import('../src/server/context') = require('../src/server/context');
  context.enterServerMode(path.join(tmp, 'data'));

  const corpus: typeof import('./liveSqlCorpus') = require('./liveSqlCorpus');
  const diff: typeof import('./liveSqlDiff') = require('./liveSqlDiff');
  const pins: typeof import('./liveSqlPins') = require('./liveSqlPins');

  const identity = { user: { email: 'parity@ordinate.invalid', role: 'admin' as const }, org: { id: 'parity' } };
  await context.runInContext(identity, `live-sql-parity-pg-${process.pid}`, async () => {
    const t0 = Date.now();
    const p = await eng.postgresParity(adminUrl, reach.address);
    try {
      const version = String((await p.query('select version()'))[0][0]).split(' on ')[0];
      console.log(`  ${version}: scratch database ${String(p.values.database)} byte-ordered (C), default zone ${eng.HOSTILE_ZONE}`);
      const kit = await diff.setupKit(ok);
      if (!kit) return;
      const sources = await diff.loadSources(kit, p.engine);
      const open = await diff.runCorpus(kit, sources, p.engine, ok, false);
      const locked = await diff.runCorpus(kit, sources, p.engine, ok, true);
      ok(`the corpus: ${corpus.CASES.length} statements agree on Postgres, unlocked (${open}) and locked (${locked})`, open === corpus.CASES.length && locked === corpus.CASES.length);
      for (const c of diff.literalCases()) {
        const problems = await diff.problems(kit, c, sources, p.engine, { lock: false });
        ok(`${p.engine.name}: ${c.name} binds and agrees`, problems.length === 0, problems.join(' | '));
      }
      await pins.controls(kit, sources, p.engine, ok);
      await pins.run(kit, sources, p.engine, ok);
      console.log(`  postgres (redshift dialect): ${p.seen.statements} statements through runBound in ${Date.now() - t0} ms`);
    } finally {
      await p.close();
    }
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}
