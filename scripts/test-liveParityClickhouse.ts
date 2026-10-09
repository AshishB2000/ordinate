// The live-parity matrix on a REAL ClickHouse (docs/live-data/00-plan.md L2.8):
// every compiled statement goes through the real `clickhouse` connector's
// `live.runBound` — `{p0:Type}` placeholders with `param_p0=` values, the
// `readonly=2` setting, the result caps — in server mode (the SSRF guard on,
// the server's address allowed and pinned), and is compared with the extract
// path exactly as the DuckDB run does (scripts/liveParityMatrix.ts: `Object.is`,
// ~1e-13 on float sums only). The pins (scripts/liveParityPins.ts) run again here.
//
// The fixture lives in a scratch database, dropped at the end, in MergeTree
// tables typed as ClickHouse types them (Nullable Float64 / Int32 / Int16 /
// Decimal(38, 0) / Date / String).
//
// Runs when CLICKHOUSE_URL is set — `http://[user[:password]@]host:8123` — and
// prints that it skipped otherwise, so `npm test` passes without a ClickHouse.
// The `clickhouse` job of .github/workflows/warehouse-nightly.yml starts a
// clickhouse/clickhouse-server:25.8 service container and sets it.
//
//   npm run build:ts && CLICKHOUSE_URL=http://default:secret@localhost:8123 node scripts/test-liveParityClickhouse.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const raw = (process.env.CLICKHOUSE_URL ?? '').trim();
if (!raw) {
  console.log('skip live parity on ClickHouse: CLICKHOUSE_URL is unset (the nightly sets it; e.g. http://default:secret@localhost:8123)');
  finish();
} else {
  void main(raw).catch((e: unknown) => ok('live parity on ClickHouse threw', false, e instanceof Error ? e.stack : String(e))).finally(finish);
}

async function main(chUrl: string): Promise<void> {
  const fs: typeof import('fs') = require('fs');
  const os: typeof import('os') = require('os');
  const path: typeof import('path') = require('path');
  const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
  const target = eng.clickhouseTarget(chUrl);
  ok('CLICKHOUSE_URL is an http(s) URL (a set but unusable value fails, never skips)', !!target);
  if (!target) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-liveparity-ch-'));
  process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, so relative periods find rows

  // Server mode: the SSRF guard checks and pins every socket; the server's address — the one that answers — is allowed.
  const reach = await eng.reachableAddress(target.host, target.port);
  process.env.SSRF_ALLOW = [process.env.SSRF_ALLOW, reach.cidr].filter(Boolean).join(',');
  const context: typeof import('../src/server/context') = require('../src/server/context');
  context.enterServerMode(path.join(tmp, 'data'));

  const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
  const pins: typeof import('./liveParityPins') = require('./liveParityPins');
  const identity = { user: { email: 'parity@ordinate.invalid', role: 'admin' as const }, org: { id: 'parity' } };
  await context.runInContext(identity, `live-parity-ch-${process.pid}`, async () => {
    const t0 = Date.now();
    const c = await eng.clickhouseParity(chUrl, reach.address);
    try {
      console.log(`  ClickHouse ${c.version}: scratch database ${c.database}, reached at ${reach.address}`);
      const x = await mx.setupExtract(ok);
      if (!x) return;
      const report = await mx.runMatrix(x, c.engine, { ok });
      const caught = await mx.brokenBlankCaught(x, c.engine, report.envs.typed);
      ok(`NEGATIVE CONTROL: on ${c.engine.name}, a broken empty predicate (whitespace not empty) is caught`, caught.length >= 3, caught.join(' | '));
      const unfolded = await mx.unfoldedBlankCaught(x, c.engine, report.envs.typed);
      ok(`NEGATIVE CONTROL: on ${c.engine.name}, the same statements without the '' → NULL fold disagree with the extract (two blank rows)`,
        unfolded.stripped > 0 && unfolded.problems.length >= 3, `${unfolded.stripped} statements unfolded: ${unfolded.problems.join(' | ')}`);
      await pins.run({ pid: x.pid, ok, live: mx.parityKit(x, c.engine.run).live, env: report.envs.typed, stored: x.stored, engine: c.engine });
      const s = c.seen;
      // ClickHouse runs the statement unwrapped (the caps are settings), so its order is the statement's own.
      console.log(`  clickhouse: rows came back in rank order in ${s.rankOrdered} of ${s.charts} chart statements; −0 in ${s.negZero} cells; ` +
        `${s.statements} statements through runBound, whole run ${Date.now() - t0} ms (matrix ${report.ms} ms: ${report.charts} charts, ${report.metrics} metrics, ${report.answers} answers)`);
      ok(`clickhouse: every chart statement answered (${s.charts}), each re-sorted by its ranks before shaping`, s.charts > 0);
    } finally {
      await c.close();
    }
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}
