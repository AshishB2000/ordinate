// A row access lock on a Live dataset (docs/row-policy/00-design.md D13), as
// compiled SQL, per dialect — PURE, no warehouse.
//
// A lock is a filter step marked `lock: true`. Every dialect must compare it
// byte for byte (a warehouse's default collation may be case-insensitive: `east`
// is not `East`), bind every value as a parameter (none in the SQL text), and
// put it on the two lookups that otherwise run without the question's filters:
// the latest date (a relative period's anchor) and the stored spelling of a
// typed value. A filter that is NOT a lock compiles exactly as before.
//
//   npm run build:ts && node scripts/test-rowPolicyLive.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

type LiveColumn = import('../src/engine/live/liveSpec').LiveColumn;
type CompileDialectId = import('../src/engine/live/dialect').CompileDialectId;
type FilterStep = import('../src/data/transforms').FilterStep;
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const comp: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const rowLock: typeof import('../src/data/rowLock') = require('../src/data/rowLock');

const COLS: LiveColumn[] = [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'day', type: 'date' }];
const env = (dialect: CompileDialectId) => ({ dialect, source: { kind: 'table' as const, parts: ['db', 'sch', 'orders'] }, columns: COLS });
/** The byte form each dialect must use (refutation S3). */
const BINARY: Record<CompileDialectId, RegExp> = {
  duckdb: /encode\(/, bigquery: /CAST\(.* AS BYTES\)/, databricks: /CAST\(.* AS BINARY\)/, snowflake: /TO_BINARY\(.*'UTF-8'\)/, redshift: /md5\(/, clickhouse: /(IN \(|= \{p)/,
};
const SECRET = ['East_SECRET_V1', "O'Brien_SECRET_V2"];

const metricSql = (id: CompileDialectId, filters: FilterStep[]) => {
  const a = spec.fromMetric({ column: 'amount', aggregation: 'sum' }, filters, COLS);
  if (!a.ok) throw new Error(`refused: ${a.code}`);
  const r = comp.compileMetric(a.ir, env(id));
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return r.query;
};

(async () => {
  ok('every Live dialect declares a binary form (the interface requires one)', dialects.DIALECT_IDS.every((id) => typeof dialects.dialectFor(id).binary === 'function'), dialects.DIALECT_IDS.join(','));
  const lockIn = rowLock.lockStep('region', SECRET);
  const lockEq = rowLock.lockStep('region', [SECRET[0]]);
  ok('a lock step is marked, `=` for one value and `in` for several', lockIn.lock === true && lockIn.op === 'in' && lockEq.op === '=' && lockEq.lock === true);
  for (const id of dialects.DIALECT_IDS) {
    for (const [label, step] of [['in', lockIn], ['=', lockEq]] as const) {
      const q = metricSql(id, [step]);
      ok(`${id}: a lock (${label}) compares byte for byte`, BINARY[id].test(q.sql), q.sql);
      ok(`${id}: …every lock value is a bound parameter, none in the SQL text`,
        SECRET.slice(0, label === 'in' ? 2 : 1).every((v) => q.params.some((p) => p.value === v) && !q.sql.includes(v)), JSON.stringify(q.params));
    }
    const plain = metricSql(id, [{ type: 'filter', column: 'region', op: '=', value: 'East' }]);
    const binaryRe = id === 'clickhouse' ? /(?!)/ : BINARY[id];
    ok(`${id}: NEGATIVE CONTROL — a filter that is not a lock compiles as before (no byte form)`, !binaryRe.test(plain.sql), plain.sql);
  }

  // The two lookups that run without the question's filters take the lock (D13).
  const answer = spec.fromAnswerSpec({ datasetId: 'x', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [{ column: 'day', period: 'last_month' }] } as never, COLS, { lock: [lockIn] });
  ok('an answer\'s IR carries the lock beside its own filters (never in the spec, so no label names it)', answer.ok && answer.ir.filters.some((f) => 'binary' in f && f.binary === true));
  if (answer.ok) {
    const latest = comp.compileLatestDates(answer.ir, env('duckdb'));
    ok('the latest-date anchor is computed over the locked rows only', latest.ok && /WHERE/.test(latest.query.sql) && latest.query.params.some((p) => p.value === SECRET[0]), latest.ok ? latest.query.sql : '');
    const unlocked = spec.fromAnswerSpec({ datasetId: 'x', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [{ column: 'day', period: 'last_month' }] } as never, COLS);
    const open = unlocked.ok ? comp.compileLatestDates(unlocked.ir, env('duckdb')) : null;
    ok('NEGATIVE CONTROL: without a lock the anchor reads every row, as before', !!open && open.ok && !/WHERE/.test(open.query.sql));
  }
  const lockF = spec.adaptFilter(lockIn, COLS, {}, []);
  const fix = comp.compileCaseMatches('region', ['east'], env('duckdb'), lockF && !('code' in lockF) ? [lockF] : []);
  ok('the stored-spelling lookup is limited to the locked rows', fix.ok && /encode\(/.test(fix.query.sql) && fix.query.params.some((p) => p.value === SECRET[1]), fix.ok ? fix.query.sql : '');
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
