// The live-parity matrix on a REAL engine in CI: Postgres, standing in for
// Redshift (docs/live-data/00-plan.md L2.8). The Redshift dialect is written in
// the subset the two share; this runs every compiled statement through the
// real `amazon-redshift` connector's `live.runBound` — `$n` binds, the
// read-only session, statement_timeout, the row-cap wrapper — in server mode
// (the SSRF guard on, the database's address allowed and pinned), and compares
// each answer with the extract path exactly as the DuckDB run does
// (scripts/liveParityMatrix.ts: `Object.is`, ~1e-13 on float sums only). The
// pins (scripts/liveParityPins.ts) run again here, through this engine.
//
// The fixture lives in a scratch DATABASE, dropped at the end, created
// byte-ordered (`LC_COLLATE 'C'`, Redshift's only text order) and with a
// default zone of UTC+14. What Postgres does that Redshift does not, or that
// only shows on a real engine, is a named pin below:
//
//   R1  collation — Postgres can order text linguistically (CI's postgres:17
//       defaults to en_US.utf8); Redshift and the extract compare code points.
//       Shown on an ICU-collated twin; the matrix runs byte-ordered.
//   R2  session zone — a TIMESTAMPTZ's DAY is taken in the session's zone. The
//       connector's live session is UTC; shown against a session left at +14.
//   R3  ORDER BY through the row-cap wrapper (L2.1's concern) — Postgres keeps
//       a derived table's order; the shaping no longer relies on it.
//   R4  −0 — Postgres stores and returns −0, so the shaping's −0 → 0 runs here
//       on a real engine (DuckDB stores none).
//   R5  read-only — a write that passes the wrapper (`nextval`) is refused by
//       the session's read-only guard.
//
// The matrix runs again, thinned, over the LITERAL twin the real-account
// nightly loads into read-only Snowflake and BigQuery roles (a defining query
// over literals, scripts/liveParityLiteral.ts), so that twin is proved in CI.
//
// Skips without DATABASE_URL (CI's `check` job sets it: npm test runs this).
//
//   npm run build:ts && DATABASE_URL=postgres://… node scripts/test-liveParityPostgres.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('skip live parity on Postgres: DATABASE_URL is unset (CI sets it; any Postgres this suite may CREATE DATABASE on)');
  finish();
} else {
  void main(url).catch((e: unknown) => ok('live parity on Postgres threw', false, e instanceof Error ? e.stack : String(e))).finally(finish);
}

async function main(adminUrl: string): Promise<void> {
  const fs: typeof import('fs') = require('fs');
  const os: typeof import('os') = require('os');
  const path: typeof import('path') = require('path');
  const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-liveparity-pg-'));
  process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, so relative periods find rows

  // Server mode: the SSRF guard checks and pins every socket. Loopback and
  // private ranges are refused unless allowed, so the database's address —
  // exactly that one, the one that answers — is opened, as an operator would
  // with SSRF_ALLOW.
  const u = new URL(adminUrl);
  const reach = await eng.reachableAddress(u.hostname, Number(u.port || 5432));
  const before = process.env.SSRF_ALLOW;
  process.env.SSRF_ALLOW = [before, reach.cidr].filter(Boolean).join(',');
  const context: typeof import('../src/server/context') = require('../src/server/context');
  context.enterServerMode(path.join(tmp, 'data'));

  const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
  const pins: typeof import('./liveParityPins') = require('./liveParityPins');
  const ssrf: typeof import('../src/connectors/ssrf') = require('../src/connectors/ssrf');
  const liveRun: typeof import('../src/connectors/liveRun') = require('../src/connectors/liveRun');
  const registry: typeof import('../src/connectors') = require('../src/connectors');

  const identity = { user: { email: 'parity@ordinate.invalid', role: 'admin' as const }, org: { id: 'parity' } };
  await context.runInContext(identity, `live-parity-pg-${process.pid}`, async () => {
    const t0 = Date.now();
    const p = await eng.postgresParity(adminUrl, reach.address);
    try {
      const version = String((await p.query('select version()'))[0][0]).split(' on ')[0];
      console.log(`  ${version}: scratch database ${String(p.values.database)} byte-ordered (C), default zone ${eng.HOSTILE_ZONE}, reached at ${reach.address}`);
      const def = registry.getConnector('amazon-redshift')!;
      const bound = (sql: string, params: import('../src/connectors/types').LiveParam[] = []) =>
        liveRun.runLiveBound(def, p.values, p.secrets, sql, params, { signal: new AbortController().signal, timeoutMs: 10_000 });

      // The guard is really on: with SSRF_ALLOW as it was, the database's address is refused.
      process.env.SSRF_ALLOW = before ?? '';
      const internal = ssrf.refusedRange(reach.address) !== null;
      const refused = await bound('select 1 as one');
      process.env.SSRF_ALLOW = [before, reach.cidr].filter(Boolean).join(',');
      ok('NEGATIVE CONTROL: the SSRF guard is on in this run — without the allowance the database is refused before a socket opens',
        !internal || (!refused.ok && /internal address/.test(refused.error)), JSON.stringify(refused));

      const x = await mx.setupExtract(ok);
      if (!x) return;
      const report = await mx.runMatrix(x, p.engine, { ok });
      const caught = await mx.brokenBlankCaught(x, p.engine, report.envs.typed);
      ok(`NEGATIVE CONTROL: on ${p.engine.name}, a broken empty predicate (whitespace not empty) is caught`, caught.length >= 3, caught.join(' | '));
      const unfolded = await mx.unfoldedBlankCaught(x, p.engine, report.envs.typed);
      ok(`NEGATIVE CONTROL: on ${p.engine.name}, the same statements without the '' → NULL fold disagree with the extract (two blank rows)`,
        unfolded.stripped > 0 && unfolded.problems.length >= 3, `${unfolded.stripped} statements unfolded: ${unfolded.problems.join(' | ')}`);
      await pins.run({ pid: x.pid, ok, live: mx.parityKit(x, p.engine.run).live, env: report.envs.typed, stored: x.stored, engine: p.engine });
      const pgPins: typeof import('./liveParityPgPins') = require('./liveParityPgPins');
      await pgPins.run({ ok, pid: x.pid, pg: p, bound });

      // The LITERAL twin — the fixture as a defining query over E'…' literals,
      // the way the nightly loads it into read-only Snowflake and BigQuery
      // roles (scripts/liveParityLiteral.ts) — proved here, every 9th case.
      const literal: typeof import('./liveParityLiteral') = require('./liveParityLiteral');
      const twin = literal.literalEngine(`${p.engine.name}, literal twin`, 'redshift', literal.POSTGRES, p.engine.run);
      const lit = await mx.runMatrix(x, twin, { ok, stride: 9 });

      const s = p.seen;
      ok(`PIN R3 (ORDER BY through the row-cap wrapper): Postgres kept the compiled order in ${s.rankOrdered} of ${s.charts} chart statements`,
        s.charts > 0 && s.rankOrdered === s.charts, JSON.stringify(s));
      ok('PIN R3: NEGATIVE CONTROL — the order check sees a reply that is not in rank order',
        !eng.inRankOrder([[2, 'b'], [1, 'a']], ['o_cr', 'o_g']) && eng.inRankOrder([[1, 'a', 2], [1, 'a', 3], [2, 'b', 1]], ['o_cr', 'o_g', 'o_sr']));
      ok(`PIN R4 (−0): Postgres returned −0 in ${s.negZero} cells, and every figure still matched the extract (shaping reports +0)`, s.negZero > 0, JSON.stringify(s));
      console.log(`  postgres (redshift dialect): ${s.statements} statements through runBound, whole run ${Date.now() - t0} ms ` +
        `(matrix ${report.ms} ms: ${report.charts} charts, ${report.metrics} metrics, ${report.answers} answers; literal twin ${lit.ms} ms: ${lit.statements} statements)`);
    } finally {
      await p.close();
    }
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}
