// The nightly's partition-time case, on every `npm test`: scripts/warehouseLivePartitionTime.ts, whose real run (a
// BigQuery project with BIGQUERY_SCRATCH_DATASET) only the warehouse nightly makes.
//
//   1. The whole case against a STAND-IN BigQuery (./bigqueryFake.ts's transport, under the real connector, executor
//      and doors): it keeps the rows the fixture script wrote, keeps BigQuery's rule (a statement with no
//      `_PARTITIONTIME` filter is refused, in BigQuery's words), and answers each statement from the rows inside the
//      bound TIMESTAMP range and any day range sent. Every check of the case passes; the script went with the
//      `bigquery`-scope token and every Live statement with the read-only one; every bound on the pseudo-column went
//      as a TIMESTAMP parameter.
//   2. NEGATIVE CONTROLS: an executor that drops the range fails the case (its statements refused); a table that
//      does not require a filter fails the case's own control (it would otherwise pass by proving nothing).
//   3. No BIGQUERY_SCRATCH_DATASET: no check and no request (the case prints its one skip line); one that is no
//      dataset name fails, never skips.
//
//   npm run build:ts && node scripts/test-warehousePartitionTime.js

export {}; // module scope — sibling test scripts share top-level names
import { finish, ok } from './selfcheck';
import type { Call, Reply } from './bigqueryFake';
import { captureLogs } from './logCapture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_TODAY = '2025-03-15';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-partitiontime-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const fakeBq: typeof import('./bigqueryFake') = require('./bigqueryFake');
const pt: typeof import('./warehouseLivePartitionTime') = require('./warehouseLivePartitionTime');
const dateRange: typeof import('../src/engine/live/liveDateRange') = require('../src/engine/live/liveDateRange');
const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');

const key = fakeBq.makeKey();
const CFG = { keyJson: key.json, project: fakeBq.PROJECT, scratch: 'nightly_scratch', location: 'US' };
const ROW_RE = /SELECT TIMESTAMP '([\d-]+)' AS pt, '([A-Za-z]+)' AS region, CAST\((\d+) AS FLOAT64\) AS amount, DATE '\1' AS day FROM UNNEST\(GENERATE_ARRAY\(1, (\d+)\)\)/g;
const BYTES_PER_ROW = 24;

/** A stand-in BigQuery holding one ingestion-time table; `enforce`: it requires a partition filter, as the real one does. */
function standIn(enforce = true) {
  let rows: import('./warehouseLivePartitionTime').Row[] = [];
  const s = { stamps: [] as string[], refused: 0, scriptToken: '', liveTokens: new Set<string>(), calls: 0 };
  let jobs = 0;
  const done = (extra: Record<string, unknown>): Reply => ({ json: { kind: 'bigquery#queryResponse', jobReference: { projectId: fakeBq.PROJECT, jobId: `job-${(jobs += 1)}`, location: 'US' }, jobComplete: true, ...extra } });
  const table = (cols: [string, string][], out: unknown[][], read: number): Reply => done({
    schema: { fields: cols.map(([name, type]) => ({ name, type, mode: 'NULLABLE' })) },
    rows: out.map((r) => ({ f: r.map((v) => ({ v: v === null ? null : String(v) })) })),
    totalRows: String(out.length), totalBytesProcessed: String(read), totalBytesBilled: String(read ? 10 * 2 ** 20 : 0), cacheHit: false,
  });
  const route = fakeBq.happy((c: Call): Reply | null => {
    s.calls += 1;
    if (c.method === 'GET' && /\/tables\//.test(c.url.pathname)) {
      return { json: { schema: { fields: [{ name: 'region', type: 'STRING' }, { name: 'amount', type: 'FLOAT' }, { name: 'day', type: 'DATE' }] }, timePartitioning: { type: 'DAY' },
        requirePartitionFilter: true, numRows: String(rows.reduce((a, r) => a + r.n, 0)), numBytes: String(rows.reduce((a, r) => a + r.n, 0) * BYTES_PER_ROW) } };
    }
    if (!fakeBq.isQuery(c) && !fakeBq.isDry(c)) return null;
    const sql = String(c.json?.query ?? '');
    if (sql.startsWith('CREATE OR REPLACE TABLE')) {
      s.scriptToken = c.headers.authorization ?? '';
      rows = [...sql.matchAll(ROW_RE)].map((m) => ({ day: m[1], region: m[2], amount: Number(m[3]), n: Number(m[4]) }));
      return done({ statementType: 'SCRIPT' });
    }
    s.liveTokens.add(c.headers.authorization ?? '');
    if (enforce && !sql.includes('_PARTITIONTIME')) {
      s.refused += 1;
      return { status: 400, json: { error: { code: 400, message: "Cannot query over table 'acme-analytics.nightly_scratch.ordinate_partitiontime' without a filter that can be used for partition elimination", status: 'INVALID_ARGUMENT' } } };
    }
    const params = new Map<string, { parameterType: { type: string }; parameterValue: { value?: string } }>((c.json?.queryParameters ?? []).map((p: { name: string }) => [p.name, p]));
    const bound = (re: RegExp): string | undefined => { const m = re.exec(sql); const p = m ? params.get(m[1]) : undefined; if (p && /PARTITIONTIME/.test(re.source)) s.stamps.push(p.parameterType.type); return p?.parameterValue.value; };
    const [lo, hi] = [bound(/_PARTITIONTIME >= CAST\(@(p\d+) AS TIMESTAMP\)/), bound(/_PARTITIONTIME < CAST\(@(p\d+) AS TIMESTAMP\)/)];
    const [dlo, dhi] = [bound(/`day` AS DATE\) >= CAST\(@(p\d+) AS DATE\)/), bound(/`day` AS DATE\) <= CAST\(@(p\d+) AS DATE\)/)];
    const read = rows.filter((r) => (!lo || `${r.day}T00:00:00.000Z` >= lo) && (!hi || `${r.day}T00:00:00.000Z` < hi) && (!dlo || r.day >= dlo) && (!dhi || r.day <= dhi));
    const bytes = read.reduce((a, r) => a + r.n, 0) * BYTES_PER_ROW;
    if (fakeBq.isDry(c)) return done({ statementType: 'SELECT', totalBytesProcessed: String(bytes) });
    const sums = new Map<string, number>();
    for (const r of read) sums.set(r.region, (sums.get(r.region) ?? 0) + r.amount * r.n);
    const ranked = [...sums].sort((a, b) => b[1] - a[1]);
    if (/ AS o_l0 FROM /.test(sql)) return table([['o_l0', 'INTEGER']], [[read.length ? Math.max(...read.map((r) => dateIntel.daysFromIso(r.day)!)) : null]], bytes);
    if (/ AS o_v FROM /.test(sql)) {
      const asked = new Set([...params.values()].map((p) => p.parameterValue.value ?? '').filter((v) => /^[a-z]+$/.test(v)));
      return table([['o_v', 'STRING']], [...new Set(read.map((r) => r.region))].filter((v) => asked.has(v.toLowerCase())).sort().map((v) => [v]), bytes);
    }
    if (/ AS o_g, /.test(sql)) return table([['o_g', 'STRING'], ['o_m0s', 'FLOAT'], ['o_cr', 'INTEGER'], ['o_nc', 'FLOAT']], ranked.map(([g, v], i) => [g, v, i + 1, ranked.length]), bytes);
    if (/ AS o_m0s FROM /.test(sql)) return table([['o_m0s', 'FLOAT']], [[read.length ? [...sums.values()].reduce((a, b) => a + b, 0) : null]], bytes);
    if (/ AS o_0, /.test(sql)) return table([['o_0', 'STRING'], ['o_1', 'FLOAT']], ranked.sort((a, b) => (a[0] < b[0] ? -1 : 1)), bytes);
    return { status: 400, json: { error: { code: 400, message: `the stand-in has no answer for: ${sql.slice(0, 80)}` } } };
  });
  return { s, transport: fakeBq.fakeTransport(route).transport };
}

type Check = { label: string; cond: boolean; extra?: unknown };
async function run(cfg: typeof CFG | Omit<typeof CFG, 'scratch'>, enforce = true): Promise<{ checks: Check[]; s: ReturnType<typeof standIn>['s'] }> {
  const bench = standIn(enforce);
  const checks: Check[] = [];
  await pt.runPartitionTime(cfg, bench.transport, (label, cond, extra) => checks.push({ label, cond, extra }));
  return { checks, s: bench.s };
}
const failing = (c: Check[]): Check[] => c.filter((x) => !x.cond);

async function main(): Promise<void> {
  context.enterServerMode(tmp);
  await context.runInContext({ user: { email: 'nightly@ordinate.invalid', role: 'admin' }, org: { id: 'nightly' } }, 'partition-time', async () => {
    // 1. The whole case on the stand-in.
    const good = await run(CFG);
    ok(`the case on the stand-in: all ${good.checks.length} of its checks pass`, good.checks.length >= 10 && failing(good.checks).length === 0, failing(good.checks));
    ok('…the fixture script went with the bigquery-scope token, every Live statement with the read-only one',
      /^Bearer ya29\.cancel-/.test(good.s.scriptToken) && good.s.liveTokens.size > 0 && [...good.s.liveTokens].every((t) => /^Bearer ya29\.read-/.test(t)), [good.s.scriptToken, [...good.s.liveTokens]]);
    ok(`…every bound on the pseudo-column went as a TIMESTAMP parameter (${good.s.stamps.length})`, good.s.stamps.length >= 16 && good.s.stamps.every((t) => t === 'TIMESTAMP'), good.s.stamps);
    ok('…and only the case\'s own CONTROL was refused for a missing partition filter', good.s.refused === 1, good.s.refused);

    // 2. NEGATIVE CONTROL: an executor that forgets the partition time.
    const real = dateRange.withRequiredRange;
    (dateRange as { withRequiredRange: typeof real }).withRequiredRange = (ir, t) => ({ ok: true, ir, env: t.env, notes: [] });
    let dropped: Awaited<ReturnType<typeof run>>;
    const quiet = captureLogs(); // the refused statements' warnings
    try {
      dropped = await run(CFG);
    } finally {
      (dateRange as { withRequiredRange: typeof real }).withRequiredRange = real;
      quiet.restore();
    }
    const lost = failing(dropped.checks).map((c) => c.label);
    ok('NEGATIVE CONTROL: an executor that drops the range fails the case — the chart, the KPI and the statement check, refused by the stand-in',
      dropped.s.refused > 1 && ['a chart', 'a KPI', 'every statement'].every((w) => lost.some((l) => l.includes(w))), lost);
    // NEGATIVE CONTROL: a table that answers without a partition filter fails the case's own control.
    const lax = await run(CFG, false);
    ok('NEGATIVE CONTROL: a table that does not require the filter fails the case\'s CONTROL, and only it', failing(lax.checks).length === 1 && /CONTROL/.test(failing(lax.checks)[0].label), failing(lax.checks).map((c) => c.label));

    // 3. Unset: nothing asked.
    const { scratch: _unset, ...noScratch } = CFG;
    const skipped = await run(noScratch);
    ok('no BIGQUERY_SCRATCH_DATASET: no check, no request', skipped.checks.length === 0 && skipped.s.calls === 0, skipped);
    const bad = await run({ ...CFG, scratch: 'not a dataset;' });
    ok('NEGATIVE CONTROL: a BIGQUERY_SCRATCH_DATASET that is no dataset name fails, never skips, and asks nothing', bad.checks.length === 1 && !bad.checks[0].cond && bad.s.calls === 0, bad);
  });
}

main()
  .catch((e: unknown) => ok('the partition-time case suite threw', false, e instanceof Error ? e.stack : String(e)))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
