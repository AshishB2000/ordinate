'use strict';

// THE live-parity differential test (docs/live-data/00-plan.md L2.2, D1, D7).
//
// A live dataset has no rows to fall back on, so "the warehouse computes the
// same figure the app would have" is not a hope — it is this suite. One fixture
// (scripts/liveParityFixture.ts) is loaded twice: as an EXTRACT (a real dataset,
// stored to Parquet like any other) and as a WAREHOUSE would hold it (typed
// DuckDB tables). Then a generated matrix (scripts/liveParityMatrix.ts) —
// aggregation × category kind × grain × filter op × series × top N — is asked
// of BOTH:
//
//   extract  the functions the app calls today: `vizDataFor` (charts, resident
//            or JS), `computeCardMetric` (KPI tiles), `computeCard` (answers);
//   live     adapt (liveSpec) → compile with the DuckDB dialect → run on DuckDB
//            through the existing async bridge → shape (evaluateLive).
//
// Labels and values agree under `Object.is`; sum/avg figures within the
// documented ~1e-13 float tolerance only; warnings and the category note
// byte-for-byte. Order is checked against each path's OWN rule. Divergences are
// named, pinned exceptions (./liveParityPins.ts), never a loosened comparison.
// Negative controls inject a broken empty predicate, and strip the '' → NULL
// fold of a text key, and require failures.
//
// This is the run every `npm test` makes, in full. The same matrix runs on real
// engines (L2.8): Postgres in CI (test-liveParityPostgres), ClickHouse in a
// nightly container (test-liveParityClickhouse), Snowflake and BigQuery in the
// real-account nightly (test-warehouseLive).
//
//   npm run build:ts && node scripts/test-liveParity.js

import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-liveparity-'));
process.env.ORDINATE_LOCAL_DIR = tmp;
process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, so relative periods find rows

const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
const pins: typeof import('./liveParityPins') = require('./liveParityPins');

async function main(): Promise<void> {
  const x = await mx.setupExtract(ok);
  if (!x) return;
  const report = await mx.runMatrix(x, fx.duckEngine, { ok });

  // NEGATIVE CONTROL: an empty predicate that forgets tab and the rest of JS
  // whitespace. The harness must notice, or it proves nothing.
  const caught = await mx.brokenBlankCaught(x, fx.duckEngine, report.envs.typed, (v: string) => `(${v} IS NULL OR regexp_full_match(${v}, '[ ]*'))`);
  ok('NEGATIVE CONTROL: a broken empty predicate (tab and NBSP not empty) is caught', caught.length >= 3, caught.join(' | '));

  // NEGATIVE CONTROL for the '' → NULL fold of a text key (L3.2 found the
  // divergence, L2.8 fixed it): the very statements with the fold stripped —
  // the compiler as it was — must disagree on `cat`, a category, a split and
  // an answer, or the matrix's agreement above does not rest on the fold.
  const unfolded = await mx.unfoldedBlankCaught(x, fx.duckEngine, report.envs.typed);
  ok("NEGATIVE CONTROL: without the '' → NULL fold, live answers two blank rows where the extract has one — caught on a chart, a split and an answer",
    unfolded.stripped > 0 && unfolded.problems.length >= 3, `${unfolded.stripped} statements unfolded: ${unfolded.problems.join(' | ')}`);

  // NEGATIVE CONTROL for the import's '' → null: the same rows saved RAW (the
  // L2.2 bench's way, '' kept apart from null) must disagree with live on a
  // `cat` chart — two rows labelled '' there, one here — so the agreement above
  // rests on the extract being typed as a real import types it.
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const rawDs = await datasets.saveDataset(x.pid, { name: 'Fixture, saved raw', sourceKind: 'csv', columns: fx.COLUMNS.map((c) => ({ name: c.name, type: c.type })), rows: x.rows });
  const rawBack = rawDs ? await datasets.getDataset(x.pid, rawDs.id) : null;
  const rawKit = rawBack ? mx.parityKit({ ...x, did: rawDs!.id, stored: { columns: rawBack.columns, rows: rawBack.rows } }, fx.runDuck) : null;
  const split = rawKit ? await rawKit.chartProblems({ category: 'cat', values: [mx.M('amt', 'sum')] }, [], report.envs.typed) : [];
  ok("NEGATIVE CONTROL: an extract saved raw ('' apart from null) disagrees with live on a `cat` chart — the blank category is one row on live",
    split.some((p) => /label count/.test(p)), split.join(' | '));

  await pins.run({ pid: x.pid, ok, live: mx.parityKit(x, fx.runDuck).live, env: report.envs.typed, stored: x.stored, engine: fx.duckEngine });
}

main()
  .catch((e) => ok('live parity suite threw', false, e && (e as Error).stack))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
