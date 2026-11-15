// Does the cast on a date column cost a warehouse its pruning? The measurement behind
// compileFilter's RAW_RANGE_DIALECTS (docs/assistant/00-design.md, "Live date filters on key
// columns") — part of scripts/test-warehouseLive.ts (the real-account nightly), not a suite.
//
// For each configured warehouse, the SAME date-filtered KPI (a count over one month of a partitioned
// or clustered table's date column) is compiled twice by the live compiler: the cast form every Live
// question sends today (`CAST(col AS DATE) >= …`), and the half-open raw range the switch would send
// (`col >= … AND col < …`). Neither runs:
//
//   BigQuery   a DRY RUN of each (`live.estimate`, free): totalBytesProcessed. A table that requires a
//              partition filter may refuse the cast form outright ("no partition elimination"): that
//              is recorded as the result, not as an error.
//   Snowflake  SYSTEM$EXPLAIN_PLAN_JSON of each (compile only, no warehouse time): partitionsTotal,
//              partitionsAssigned, bytesAssigned.
//
// The numbers never fail the run; an error does. They are printed, added to the run's summary and
// written as JSON to WAREHOUSE_PRUNING_OUT (default warehouse-pruning.json), which the nightly
// uploads. Reading them: raw well under cast on a warehouse means its cast stops pruning; once the
// parity matrix agrees there with the switch on, that dialect may join RAW_RANGE_DIALECTS. Equal
// means leave the dialect alone.
//
// The table (variables are inputs to this test, docs/server/live-data.md "Testing against a real account"):
//   BIGQUERY_PRUNING_TABLE + BIGQUERY_PRUNING_COLUMN     default: a public table partitioned by hour
//                                                       that requires a partition filter
//   SNOWFLAKE_PRUNING_TABLE + SNOWFLAKE_PRUNING_COLUMN   no default (no sample table is clustered on a
//                                                       timestamp): unset, Snowflake's half is skipped
//   *_PRUNING_MONTH (YYYY-MM)                            default: the default table's month, else last month
// A configured table's name is an identifier of the account: it is redacted from the log and kept out
// of the artifact.

import { ident, keep, ok, say, summary } from './warehouseLiveHarness';
import type { CompiledQuery } from '../src/engine/live/compile';
import type { LiveColumn, LiveIR } from '../src/engine/live/liveSpec';
import type { CompileDialectId } from '../src/engine/live/dialect';

const fs: typeof import('fs') = require('fs');
const compile: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const compileFilter: typeof import('../src/engine/live/compileFilter') = require('../src/engine/live/compileFilter');
const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');

export type Warehouse = 'snowflake' | 'bigquery';
export interface PruningPlan { table: string; column: string; from: string; to: string; isDefault: boolean }

const DEFAULTS: Record<Warehouse, { table: string; column: string; month: string } | null> = {
  // Partitioned by `datehour` (TIMESTAMP), clustered, require_partition_filter: readable by any account, in US.
  bigquery: { table: 'bigquery-public-data.wikipedia.pageviews_2024', column: 'datehour', month: '2024-06' },
  snowflake: null,
};
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The month as inclusive ISO days. */
function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  return { from, to: dateIntel.isoFromDays(dateIntel.daysFromIso(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`)! - 1) };
}

/** What to measure on `wh`, or why not: unset is a skip, half-set or malformed a failure (`missing`). */
export function pruningPlan(env: (name: string) => string, wh: Warehouse): { run: true; plan: PruningPlan } | { run: false; why: string; missing?: string[] } {
  const P = wh.toUpperCase() + '_PRUNING_';
  const [table, column, month] = [env(P + 'TABLE'), env(P + 'COLUMN'), env(P + 'MONTH')];
  const def = DEFAULTS[wh];
  if (!table && !column && !def) return { run: false, why: `${P}TABLE is not set` };
  if (!table !== !column) return { run: false, why: `only one of ${P}TABLE and ${P}COLUMN is set`, missing: [table ? P + 'COLUMN' : P + 'TABLE'] };
  const col = column || def!.column;
  if (!COLUMN_RE.test(col) || (month && !MONTH_RE.test(month))) return { run: false, why: `${P}COLUMN must be a plain identifier and ${P}MONTH YYYY-MM`, missing: [`a valid ${P}COLUMN / ${P}MONTH`] };
  const isDefault = !table;
  const last = dateIntel.resolvePeriodNow({ preset: 'last_month' })!.from!.slice(0, 7);
  return { run: true, plan: { table: table || def!.table, column: col, ...monthRange(month || (isDefault ? def!.month : last)), isDefault } };
}

/** The cast form and the raw form of one count over the month, both with every value bound; or why there is no pair. */
export function forms(dialect: CompileDialectId, source: import('../src/engine/live/compile').LiveSource, col: LiveColumn, from: string, to: string): { cast: CompiledQuery; raw: CompiledQuery } | string {
  const ir: LiveIR = { kind: 'metric', measures: [{ column: col.name, aggregation: 'count' }], filters: [{ kind: 'range', column: col.name, from, to }], order: 'natural', weekCal: null };
  const env = { dialect, source, columns: [col] };
  const cast = compile.compileMetric(ir, env);
  const had = compileFilter.RAW_RANGE_DIALECTS.has(dialect);
  compileFilter.RAW_RANGE_DIALECTS.add(dialect);
  let raw: ReturnType<typeof compile.compileMetric>;
  try {
    raw = compile.compileMetric(ir, { ...env, keys: [col.name] });
  } finally {
    if (!had) compileFilter.RAW_RANGE_DIALECTS.delete(dialect);
  }
  if (!cast.ok || !raw.ok) return `the compiler refused the count: ${JSON.stringify(cast.ok ? raw : cast)}`;
  if (raw.query.sql === cast.query.sql) return `a ${col.sourceType} column has no raw form`;
  return { cast: cast.query, raw: raw.query };
}

/**
 * The statement with its values as literals, for EXPLAIN (which takes no binds). Only the measurement's
 * own ISO days are inlined, each checked to be one; any other value refuses.
 */
export function inlined(q: CompiledQuery): string {
  const parts = q.sql.split('?');
  if (parts.length - 1 !== q.params.length) throw new Error('placeholders and parameters disagree');
  return parts.reduce((out, p, i) => {
    if (i === 0) return p;
    const v = q.params[i - 1].value;
    if (typeof v !== 'string' || dateIntel.daysFromIso(v) === null) throw new Error('only an ISO day is inlined');
    return `${out}'${v}'${p}`;
  });
}

type Measured = Record<string, number | string | null>;
const results: Record<string, unknown>[] = [];

async function setUp(wh: Warehouse, values: Record<string, unknown>, secrets: Record<string, string>, plan: PruningPlan): Promise<{ def: import('../src/connectors/types').ConnectorDef; got: { cast: CompiledQuery; raw: CompiledQuery }; col: LiveColumn } | null> {
  const registry: typeof import('../src/connectors') = require('../src/connectors');
  const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
  const { liveSourceOf }: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
  if (!plan.isDefault) ident(`${wh} pruning table`, plan.table);
  const def = registry.getConnector(wh)!;
  const source = def?.live ? liveSourceOf({ table: plan.table }, def, def.live.dialect) : null;
  ok(`pruning ${wh}: the table name is one the live compiler can quote`, !!source);
  if (!source || !def.live) return null;
  const desc = keep(await connectionRun.describeTable(wh, values, secrets, plan.table));
  const type = desc && desc.ok ? desc.columns.find((c) => c.name === plan.column)?.type : undefined;
  ok(`pruning ${wh}: describeTable finds the date column and its type`, !!type, desc && desc.ok ? desc.columns.map((c) => c.name).join() : String(desc && desc.error));
  if (!type) return null;
  const col: LiveColumn = { name: plan.column, type: 'date', sourceType: type };
  const got = forms(def.live.dialect, source, col, plan.from, plan.to);
  ok(`pruning ${wh}: both forms compile, every value bound`, typeof got !== 'string', got);
  return typeof got === 'string' ? null : { def, got, col };
}

function record(wh: Warehouse, plan: PruningPlan, sourceType: string | undefined, cast: Measured, raw: Measured, cols: string[]): void {
  const table = plan.isDefault ? plan.table : `(${wh.toUpperCase()}_PRUNING_TABLE)`;
  results.push({ warehouse: wh, table, column: plan.column, sourceType, from: plan.from, to: plan.to, cast, raw, measuredAt: new Date().toISOString() });
  const cell = (m: Measured): string => cols.map((k) => (m[k] === null ? '—' : String(m[k]))).join(' / ');
  say(`pruning ${wh} (${table}.${plan.column}, ${plan.from}..${plan.to}) — ${cols.join(' / ')}: cast ${cell(cast)}; raw ${cell(raw)}`);
  summary(`- ${wh} pruning, ${cols.join(' / ')}: cast form ${cell(cast)}, raw range ${cell(raw)} (${table}.${plan.column}, ${plan.from} to ${plan.to})`);
}

/** BigQuery: the dry run's bytes for each form. A refusal for want of partition elimination is a result. */
export async function measureBigquery(values: Record<string, unknown>, secrets: Record<string, string>, plan: PruningPlan): Promise<void> {
  const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
  const v = { ...values };
  if (plan.isDefault) delete v.location; // the public table lives in US; an unset location follows the data
  const s = await setUp('bigquery', v, secrets, plan);
  if (!s) return;
  const dry = async (q: CompiledQuery): Promise<Measured> => {
    const r = keep(await s.def.live!.estimate!(connectionRun.buildContext(v, secrets, { rowLimit: 1 }), q.sql, q.params));
    if (r.ok) return { bytes: r.bytes, refused: null };
    if (/partition elimination/i.test(r.error)) return { bytes: null, refused: 'no partition elimination' };
    throw new Error(`the dry run failed: ${r.error}`);
  };
  const cast = await dry(s.got.cast);
  const raw = await dry(s.got.raw);
  ok('pruning bigquery: the raw range dry-runs (a partition filter BigQuery accepts)', typeof raw.bytes === 'number', raw);
  record('bigquery', plan, s.col.sourceType, cast, raw, ['bytes', 'refused']);
}

/** Snowflake: the compiled plan's partitions and bytes for each form, from SYSTEM$EXPLAIN_PLAN_JSON (nothing runs). */
export async function measureSnowflake(values: Record<string, unknown>, secrets: Record<string, string>, plan: PruningPlan): Promise<void> {
  const liveRun: typeof import('../src/connectors/liveRun') = require('../src/connectors/liveRun');
  const s = await setUp('snowflake', values, secrets, plan);
  if (!s) return;
  const explain = async (q: CompiledQuery): Promise<Measured> => {
    const text = inlined(q);
    if (text.includes('$$')) throw new Error('the statement cannot sit in a $$ string');
    const r = keep(await liveRun.runLiveBound(s.def, values, secrets, `SELECT SYSTEM$EXPLAIN_PLAN_JSON($$${text}$$) AS "plan"`, [], { signal: new AbortController().signal, timeoutMs: 60_000 }));
    if (!r.ok) throw new Error(`EXPLAIN failed: ${r.error}`);
    const cell = r.rows[0]?.[0];
    const stats = ((typeof cell === 'string' ? JSON.parse(cell) : cell) as { GlobalStats?: Record<string, unknown> } | null)?.GlobalStats ?? {};
    const n = (k: string): number | null => (typeof stats[k] === 'number' ? stats[k] : null);
    return { partitionsAssigned: n('partitionsAssigned'), partitionsTotal: n('partitionsTotal'), bytesAssigned: n('bytesAssigned') };
  };
  const cast = await explain(s.got.cast);
  const raw = await explain(s.got.raw);
  ok('pruning snowflake: the plan of each form reports its partitions', typeof cast.partitionsTotal === 'number' && typeof raw.partitionsTotal === 'number', { cast, raw });
  record('snowflake', plan, s.col.sourceType, cast, raw, ['partitionsAssigned', 'partitionsTotal', 'bytesAssigned']);
}

/** The JSON artifact, when anything was measured. */
export function writePruning(): void {
  if (!results.length) return;
  const file = process.env.WAREHOUSE_PRUNING_OUT || 'warehouse-pruning.json';
  fs.writeFileSync(file, JSON.stringify({ note: 'docs/assistant/00-design.md, "Live date filters on key columns"', results }, null, 2) + '\n');
  say(`pruning: ${results.length} measurement${results.length === 1 ? '' : 's'} written to ${file}`);
}
