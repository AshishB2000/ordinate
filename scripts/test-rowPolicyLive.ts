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
// § semantic (part 7 b2, D17): on a semantic dataset the lock reaches the layer's plan as binary filters and is
// refused `layerRowPolicy` at every question (a chart, a KPI, an answer, a value list, the spellings) unless the
// backend declares `binaryCompare`, which plans it (the hook c1 uses). Over the real route: test-semanticRowPolicy.
//
//   npm run build:ts && node scripts/test-rowPolicyLive.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

type LiveColumn = import('../src/engine/live/liveSpec').LiveColumn;
type CompileDialectId = import('../src/engine/live/dialect').CompileDialectId;
type FilterStep = import('../src/data/transforms').FilterStep;
type LiveFilter = import('../src/engine/live/liveSpec').LiveFilter;
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const comp: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const rowLock: typeof import('../src/data/rowLock') = require('../src/data/rowLock');

const COLS: LiveColumn[] = [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'day', type: 'date' }];
const env = (dialect: CompileDialectId) => ({ dialect, source: { kind: 'table' as const, parts: ['db', 'sch', 'orders'] }, columns: COLS });
/** The EXACT lock clause per dialect (refutation S3): both sides in the byte form, every value a placeholder.
 *  ClickHouse compares String bytes already, so its form is the identity. `c` is the column, `p(i)` a placeholder. */
const COL: Record<CompileDialectId, string> = {
  duckdb: 'coalesce(CAST(lv_src."region" AS VARCHAR), \'\')', snowflake: 'coalesce(CAST(lv_src."region" AS VARCHAR), \'\')',
  redshift: 'coalesce(CAST(lv_src."region" AS VARCHAR(65535)), \'\')', bigquery: 'coalesce(CAST(lv_src.`region` AS STRING), \'\')',
  databricks: 'coalesce(CAST(lv_src.`region` AS STRING), \'\')', clickhouse: 'coalesce(CAST(lv_src.`region` AS Nullable(String)), \'\')',
};
const PARAM: Record<CompileDialectId, (i: number) => string> = {
  duckdb: (i) => `CAST($${i + 1} AS VARCHAR)`, snowflake: () => 'CAST(? AS VARCHAR)', redshift: (i) => `CAST($${i + 1} AS VARCHAR(65535))`,
  bigquery: (i) => `CAST(@p${i} AS STRING)`, databricks: (i) => `CAST(:p${i} AS STRING)`, clickhouse: (i) => `{p${i}:String}`,
};
const BYTES: Record<CompileDialectId, (x: string) => string> = {
  duckdb: (x) => `encode(${x})`, snowflake: (x) => `TO_BINARY(${x}, 'UTF-8')`, redshift: (x) => `md5(${x})`,
  bigquery: (x) => `CAST(${x} AS BYTES)`, databricks: (x) => `CAST(${x} AS BINARY)`, clickhouse: (x) => x,
};
const expectedWhere = (id: CompileDialectId, n: number, lock: boolean): string => {
  const b = lock ? BYTES[id] : (x: string) => x;
  const ps = Array.from({ length: n }, (_, i) => b(PARAM[id](i)));
  return `WHERE (${b(COL[id])} ${n > 1 ? `IN (${ps.join(', ')})` : `= ${ps[0]}`})`;
};
const whereOf = (sql: string): string => { const i = sql.indexOf('WHERE'); const e = sql.indexOf('\n', i); return i < 0 ? '' : sql.slice(i, e < 0 ? undefined : e); };
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
    for (const [label, step, n] of [['in', lockIn, 2], ['=', lockEq, 1]] as const) {
      const q = metricSql(id, [step]);
      const want = expectedWhere(id, n, true);
      ok(`${id}: a lock (${label}) compiles to exactly ${want}`, whereOf(q.sql) === want, whereOf(q.sql));
      const wantParams = SECRET.slice(0, n).map((value, i) => ({ name: `p${i}`, type: 'text', value }));
      ok(`${id}: …its values are exactly the bound parameters, none in the SQL text`,
        JSON.stringify(q.params) === JSON.stringify(wantParams) && SECRET.every((v) => !q.sql.includes(v)), JSON.stringify(q.params));
    }
    const plain = metricSql(id, [{ type: 'filter', column: 'region', op: '=', value: 'East' }]);
    ok(`${id}: NEGATIVE CONTROL — a filter that is not a lock compiles exactly as before (no byte form)`, whereOf(plain.sql) === expectedWhere(id, 1, false), whereOf(plain.sql));
    if (id !== 'clickhouse') ok(`${id}: NEGATIVE CONTROL — the lock's expected clause differs from the plain one, so the check above can fail`, expectedWhere(id, 1, true) !== expectedWhere(id, 1, false));
  }

  // The two lookups that run without the question's filters take the lock (D13).
  const answer = spec.fromAnswerSpec({ datasetId: 'x', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [{ column: 'day', period: 'last_month' }] } as never, COLS, { lock: [lockIn] });
  ok('an answer\'s IR carries the lock beside its own filters (never in the spec, so no label names it)', answer.ok && answer.ir.filters.some((f) => 'binary' in f && f.binary === true));
  if (answer.ok) {
    // An empty answer's latest day (ipc/liveAnswers' note) is read through the lock too: it is the caller's rows' last day.
    const lockF0 = spec.adaptFilter(lockIn, COLS, {}, []);
    const latest = comp.compileLatestDates('day', env('duckdb'), lockF0 && !('code' in lockF0) ? [lockF0] : []);
    ok('the latest day an empty answer names is computed over the locked rows only', latest.ok && /WHERE/.test(latest.query.sql) && latest.query.params.some((p) => p.value === SECRET[0]), latest.ok ? latest.query.sql : '');
    const open = comp.compileLatestDates('day', env('duckdb'));
    ok('NEGATIVE CONTROL: without a lock it reads every row', open.ok && !/WHERE/.test(open.query.sql));
  }
  // A distinct count is counted again from rows at every level it folds or ranks at (semantic layer part 5, step 03):
  // each count reads `lv_base`, the one place the source is read, and that read carries the lock.
  for (const id of dialects.DIALECT_IDS) {
    const a = spec.fromVizEncoding({ category: 'region', series: 'amount', values: [{ column: 'day', aggregation: 'countd' }] }, [lockIn], COLS, { weekCal: null });
    const q = a.ok ? comp.compileChart(a.ir, { kind: 'text' }, env(id)) : null;
    ok(`${id}: a split distinct count, counted again from rows, reads the source once, inside the lock`,
      !!q && q.ok && q.query.sql.split(' AS lv_src').length === 2 && whereOf(q.query.sql).startsWith(`${expectedWhere(id, 2, true)}),`) && (q.query.sql.match(/FROM lv_base/g) ?? []).length === 3, q && q.ok ? q.query.sql : JSON.stringify(q));
  }
  const lockF = spec.adaptFilter(lockIn, COLS, {}, []);
  const fix = comp.compileCaseMatches('region', ['east'], env('duckdb'), lockF && !('code' in lockF) ? [lockF] : []);
  ok('the stored-spelling lookup is limited to the locked rows', fix.ok && /encode\(/.test(fix.query.sql) && fix.query.params.some((p) => p.value === SECRET[1]), fix.ok ? fix.query.sql : '');

  // ── § semantic ──
  const ss: typeof import('../src/engine/live/semantic/semanticSpec') = require('../src/engine/live/semantic/semanticSpec');
  const sp: typeof import('../src/engine/live/semantic/semanticPlan') = require('../src/engine/live/semantic/semanticPlan');
  const senv = (binaryCompare: boolean) => ({ dataset: 'Orders', layer: 'Snowflake', columns: COLS, metrics: new Map([['revenue', { additive: true }]]), grains: new Map([['day', ['day', 'month'] as const]]) as never, caps: { lookups: true, binaryCompare } });
  const mirrors = new Map([['m1', 'revenue']]);
  const chartIr = (b: boolean) => ss.fromSemanticViz({ category: 'region', values: [{ column: '', aggregation: 'sum', metricId: 'm1' }] }, [lockIn], COLS, senv(b), { mirrors, weekCal: null });
  const kpiIr = (b: boolean) => ss.fromSemanticMetric({ metric: 'revenue' }, [lockIn], COLS, senv(b));
  const ansIr = (b: boolean) => ss.fromSemanticAnswer({ datasetId: 'x', category: 'region', measures: [{ column: '', aggregation: 'sum', metricId: 'm1' }], filters: [] } as never, COLS, senv(b), { lock: [lockIn], mirrors });
  const lockedF = (): LiveFilter[] => { const f = spec.adaptFilter(lockIn, COLS, {}, []); return f && !('code' in f) ? [f] : []; };
  const plans: Array<[string, (b: boolean) => unknown]> = [
    ['a chart', (b) => { const a = chartIr(b); return a.ok ? sp.planChart(a.ir, senv(b)) : a; }],
    ['a KPI', (b) => { const a = kpiIr(b); return a.ok ? sp.planMetric(a.ir, senv(b)) : a; }],
    ['an answer', (b) => { const a = ansIr(b); return a.ok ? sp.planChart(a.ir, senv(b)) : a; }],
    ['a value list (and the spellings)', (b) => sp.planValues('region', lockedF(), senv(b), { limit: 201 })],
  ];
  for (const [what, plan] of plans) {
    const r = plan(false) as { ok?: boolean; code?: string; message?: string };
    ok(`semantic: ${what} under a lock is refused layerRowPolicy, naming the layer`, r.ok === false && r.code === 'layerRowPolicy' && /Snowflake/.test(String(r.message)), JSON.stringify(r));
    const b = JSON.stringify(plan(true));
    ok(`semantic: NEGATIVE CONTROL — with binaryCompare ${what} is planned, the lock kept as a binary filter`, !b.includes('layerRowPolicy') && b.includes('"binary":true') && SECRET.every((v) => b.includes(JSON.stringify(v).slice(1, -1))), b.slice(0, 300));
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
