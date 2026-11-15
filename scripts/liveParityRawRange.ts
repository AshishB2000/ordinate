// The live-parity matrix's raw-range case (docs/assistant/00-design.md, "Live date filters on key
// columns") — helper for scripts/test-liveParity.ts; not a suite itself.
//
// With 'duckdb' in compileFilter's RAW_RANGE_DIALECTS and `d` named a key column, a date range
// compiles as `d >= start AND d < end + 1 day` on the raw column instead of through its cast. The
// switch is off for every real warehouse until the nightly's numbers (scripts/warehousePruning.ts)
// say otherwise, so this is what proves the raw form answers what the cast form answers:
//
//   DATE        every period filter of the matrix, and boundary ranges (a leap day, month and year
//               ends, an end that must exclude the next day, an empty range), on a chart, two KPIs
//               and answers — against the extract, through the matrix's own comparisons;
//   TIMESTAMP,  rows a microsecond either side of midnight, raw form against cast form (the extract
//   TIMESTAMPTZ of a timestamp keeps its time text, PIN 7), under Object.is; the zoned table under
//               America/New_York, across both DST days of 2024.
//
// NEGATIVE CONTROL: a planted raw form whose end is inclusive (`<=` the next day) is caught.

import type { CompileEnv, CompiledQuery } from '../src/engine/live/compile';
import type { LiveStep } from '../src/engine/live/evaluate';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { LiveRows } from '../src/engine/live/shape';
import type { FilterStep } from '../src/data/transforms';
import type { Extract, Ok } from './liveParityMatrix';

const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const compile: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const compileFilter: typeof import('../src/engine/live/compileFilter') = require('../src/engine/live/compileFilter');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const ev: typeof import('../src/engine/live/evaluate') = require('../src/engine/live/evaluate');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');

const { F, M } = mx;
const custom = (from?: string, to?: string): FilterStep[] => [F('d', 'period', undefined, { period: { preset: 'custom', ...(from ? { from } : {}), ...(to ? { to } : {}) } })];

/** Ranges whose edges sit on the fixture's own boundary days. */
const BOUNDS: FilterStep[][] = [
  custom('2024-02-29', '2024-02-29'), custom('2024-03-31', '2024-03-31'), custom('2024-03-31', '2024-04-01'), custom(undefined, '2023-12-31'),
  custom('2024-07-01'), custom('2024-12-31', '2025-01-01'), custom('2024-06-30', '2024-07-01'), custom('2024-04-01', '2024-03-31'),
];

/** Deep equality with Object.is at the leaves. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export async function rawRangeCase(x: Extract, run: (q: CompiledQuery, step: LiveStep) => Promise<LiveRows>, typed: CompileEnv, ok: Ok): Promise<void> {
  const keyed: CompileEnv = { ...typed, keys: ['d'] };
  const sql = (env: CompileEnv, f: FilterStep[]): CompiledQuery | null => {
    const a = spec.fromMetric({ column: 'amt', aggregation: 'sum' }, f, env.columns);
    const c = a.ok ? compile.compileMetric(a.ir, env) : null;
    return c && c.ok ? c.query : null;
  };
  const off = sql(keyed, BOUNDS[2]);
  ok('raw range, switch OFF: a key column compiles exactly as today (byte-equal SQL and parameters)', !!off && same(off, sql(typed, BOUNDS[2])), off?.sql);

  compileFilter.RAW_RANGE_DIALECTS.add('duckdb');
  try {
    const on = sql(keyed, BOUNDS[2]);
    ok('raw range, switch ON: `d` is compared raw and half-open, both ends bound, no cast on it',
      !!on && on.sql.includes('lv_src."d" >= CAST($1 AS DATE)') && on.sql.includes('lv_src."d" < CAST($2 AS DATE)') && !/TRY_CAST\(lv_src\."d"/.test(on.sql)
        && same(on.params.map((p) => p.value), ['2024-03-31', '2024-04-02']), on?.sql);
    ok('raw range, switch ON: a column that is not a key keeps the cast', same(sql({ ...typed, keys: ['amt'] }, BOUNDS[2]), sql(typed, BOUNDS[2])));

    // DATE: the matrix's period filters and the boundary ranges, against the extract.
    const kit = mx.parityKit(x, run);
    const ranges = [...mx.FILTERS.filter((f) => f.some((s) => s.op === 'period')), ...BOUNDS];
    let bad = 0;
    for (const f of ranges) {
      const p = (await kit.chartProblems({ category: 'cat', values: [M('amt', 'sum'), M('region', 'count')] }, f, keyed))
        .concat(await kit.chartProblems({ category: 'd', grain: 'day', values: [M('amt', 'sum')] }, f, keyed))
        .concat(await kit.metricProblems({ column: 'amt', aggregation: 'sum' }, f, keyed))
        .concat(await kit.metricProblems({ column: 'd', aggregation: 'count' }, f, keyed));
      if (p.length && ++bad <= 6) ok(`raw range: ${JSON.stringify(f)}`, false, p.join(' | '));
    }
    ok(`raw range: ${ranges.length} date ranges on a DATE key agree with the extract (two charts, two KPIs each)`, bad === 0, `${bad} disagree`);
    let abad = 0;
    for (const filters of [[{ column: 'd', period: 'last_quarter' as const }], [{ column: 'd', period: 'last_year' as const, yearsBack: 1 }], [{ column: 'd', period: 'last_month' as const }]]) {
      const p = await kit.answerProblems({ datasetId: x.did, category: 'region', measures: [M('amt', 'sum')], filters, chartType: 'bar', title: 't' }, keyed);
      if (p.length && ++abad <= 3) ok(`raw range answer ${JSON.stringify(filters)}`, false, p.join(' | '));
    }
    ok('raw range: answers with data-relative periods agree with the extract', abad === 0, `${abad} disagree`);

    // TIMESTAMP and TIMESTAMPTZ: the raw form against the cast form.
    const zone = String((await duck.queryAsync("SELECT current_setting('TimeZone') AS tz"))[0].tz);
    await duck.execAsync("SET TimeZone = 'America/New_York'");
    try {
      const edges = ['2024-03-09', '2024-03-10', '2024-03-11', '2024-03-31', '2024-04-01', '2024-11-02', '2024-11-03', '2024-11-04', '2024-02-29', '2024-12-31', '2025-01-01'];
      const tsRows = edges.flatMap((d, i) => [`${d} 00:00:00`, `${d} 00:00:00.000001`, `${d} 12:00:00`, `${d} 23:59:59.999999`].map((t, j) => `(TIMESTAMP '${t}', ${i * 4 + j + 1})`));
      // Zoned: the same wall times in New York, and each a microsecond before UTC midnight (the NY evening before or same day).
      const tzRows = edges.flatMap((d, i) => [`${d} 00:00:00`, `${d} 23:59:59.999999`].map((t, j) => `(TIMESTAMPTZ '${t} America/New_York', ${i * 4 + j + 1})`)
        .concat([`(TIMESTAMPTZ '${d} 00:00:00+00', ${i * 4 + 3})`, `(TIMESTAMPTZ '${d} 04:59:59.999999+00', ${i * 4 + 4})`]));
      await duck.execAsync(`CREATE OR REPLACE TABLE raw_ts (t TIMESTAMP, v DOUBLE); INSERT INTO raw_ts VALUES ${tsRows.join(', ')}`);
      await duck.execAsync(`CREATE OR REPLACE TABLE raw_tz (t TIMESTAMPTZ, v DOUBLE); INSERT INTO raw_tz VALUES ${tzRows.join(', ')}, (NULL, 99)`);
      const tsCustom = (from?: string, to?: string): FilterStep[] => [F('t', 'period', undefined, { period: { preset: 'custom', ...(from ? { from } : {}), ...(to ? { to } : {}) } })];
      const tsRanges = [tsCustom('2024-03-10', '2024-03-10'), tsCustom('2024-11-03', '2024-11-03'), tsCustom('2024-03-31', '2024-04-01'), tsCustom('2024-02-29'), tsCustom(undefined, '2024-03-10'), tsCustom('2024-12-31', '2024-12-31'), tsCustom('2025-01-01', '2024-12-31')];
      for (const [table, sourceType] of [['raw_ts', 'TIMESTAMP'], ['raw_tz', 'TIMESTAMP WITH TIME ZONE']] as const) {
        const columns: LiveColumn[] = [{ name: 't', type: 'date', sourceType }, { name: 'v', type: 'number', sourceType: 'DOUBLE' }];
        const cast: CompileEnv = { dialect: 'duckdb', source: { kind: 'table', parts: [table] }, columns };
        const raw: CompileEnv = { ...cast, keys: ['t'] };
        let differ = 0;
        let checked = 0;
        let rawSql = '';
        for (const f of tsRanges) {
          for (const a of [spec.fromMetric({ column: 'v', aggregation: 'sum' }, f, columns), spec.fromMetric({ column: 't', aggregation: 'count' }, f, columns), spec.fromVizEncoding({ category: 't', grain: 'day', values: [M('v', 'sum')] }, f, columns)]) {
            if (!a.ok) { differ += 1; continue; }
            const [c, r] = [await ev.evaluateLive(a.ir, cast, run), await ev.evaluateLive(a.ir, raw, (q, step) => { rawSql = q.sql; return run(q, step); })];
            checked += 1;
            if (!c.ok || !same(c, r)) { differ += 1; if (differ <= 3) ok(`raw range ${sourceType} ${JSON.stringify(f)}`, false, JSON.stringify([c, r])); }
          }
        }
        ok(`raw range: on a ${sourceType} key (New York session), ${checked} figures by the raw form are Object.is the cast form's, across midnight and both DST days`,
          differ === 0 && checked === tsRanges.length * 3 && /lv_src\."t" < CAST\(\$\d+ AS DATE\)/.test(rawSql), `${differ} differ; ${rawSql}`);
      }

      // NEGATIVE CONTROL: an end that includes the next day must be caught by the same comparison.
      const columns: LiveColumn[] = [{ name: 't', type: 'date', sourceType: 'TIMESTAMP' }, { name: 'v', type: 'number', sourceType: 'DOUBLE' }];
      const cast: CompileEnv = { dialect: 'duckdb', source: { kind: 'table', parts: ['raw_ts'] }, columns };
      const a = spec.fromMetric({ column: 'v', aggregation: 'sum' }, tsCustom('2024-03-31', '2024-03-31'), columns);
      const planted = (q: CompiledQuery, step: LiveStep): Promise<LiveRows> => run({ ...q, sql: q.sql.replace('lv_src."t" < ', 'lv_src."t" <= ') }, step);
      const [c, r] = a.ok ? [await ev.evaluateLive(a.ir, cast, run), await ev.evaluateLive(a.ir, { ...cast, keys: ['t'] }, planted)] : [null, null];
      ok('NEGATIVE CONTROL: a planted raw form with an inclusive end (next midnight counted) disagrees with the cast form', !!c && c.ok && !!r && r.ok && !same(c, r), JSON.stringify([c, r]));
    } finally {
      await duck.execAsync(`SET TimeZone = '${zone.replace(/'/g, "''")}'`);
    }
  } finally {
    compileFilter.RAW_RANGE_DIALECTS.delete('duckdb');
  }
}
