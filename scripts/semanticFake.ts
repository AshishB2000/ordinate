// The test harness's FAKE SEMANTIC LAYER (semantic layer part 7, b1; docs/semantic-layer/07-portability.md
// Tests, "Layer parity"). Not a suite itself.
//
// CI has no Snowflake semantic view, Cube or dbt Cloud, so this layer answers a neutral `SemanticQuery` by
// running, in DuckDB, the SQL its metric definitions (FAKE_METRICS) expand to, over a table the test loaded.
// Its dimensions and filters read the table as the Live compiler does (compileFilter: the '' → NULL fold of a
// text key, the declared-type casts, the filter semantics), so the parity suite proves OUR plan and shaping,
// not a vendor's math or collation: each backend's own differences are pinned by its own PR (c1, e1, d1).
//
// Test code: values are bound parameters, identifiers come from the declared columns only.

import type { ConnectorContext, ConnectorDef, ConnectorError, ConnectorRows } from '../src/connectors/types';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { SemanticAnswer, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';

const cf: typeof import('../src/engine/live/compileFilter') = require('../src/engine/live/compileFilter');
const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const sqlParams: typeof import('../src/engine/live/sqlParams') = require('../src/engine/live/sqlParams');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');

/** The layer's metrics, over the parity fixture's `amt`. The first two can be added up. */
export const FAKE_METRICS: Readonly<Record<string, string>> = {
  revenue: 'SUM(lv_src."amt")',
  orders: 'COUNT(*)',
  avg_amount: 'AVG(lv_src."amt")',
  max_amount: 'MAX(lv_src."amt")',
};
export const FAKE_ADDITIVE: ReadonlySet<string> = new Set(['revenue', 'orders']);

/** The SQL the fake runs for `q` over `table` (declared `columns`): dimensions then metrics, by position. */
export function fakeSql(table: string, columns: LiveColumn[], q: SemanticQuery): import('../src/engine/live/sqlParams').CompiledQuery {
  const d = dialects.dialectFor('duckdb');
  const c = { d, b: new sqlParams.ParamSink(), columns };
  const col = (name: string): LiveColumn => {
    const found = spec.columnOf(columns, name);
    if (!found) throw new Error(`fake layer: no dimension ${name}`);
    return found;
  };
  const alias = new Map<string, string>();
  const sel = q.dimensions.map((dim, i) => {
    const k = col(dim.name);
    alias.set(dim.name, `d${i}`);
    if (k.type === 'text') return `${d.label(cf.keyText(c, k))} AS d${i}`; // label: the bench's BOM fix (dialects/duckdb)
    if (k.type === 'number') return `${cf.numberOf(c, k)} AS d${i}`;
    if (!dim.grain) throw new Error(`fake layer: ${dim.name} needs a grain`);
    const day = cf.dateOf(c, k);
    // A JSON API's spelling of a date: ISO text at the grain's first day.
    return `strftime(${dim.grain === 'day' ? day : d.trunc(day, dim.grain)}, '%Y-%m-%d') AS d${i}`;
  });
  q.metrics.forEach((m, j) => {
    if (!FAKE_METRICS[m]) throw new Error(`fake layer: no metric ${m}`);
    alias.set(m, `m${j}`);
    sel.push(`${d.toDouble(FAKE_METRICS[m])} AS m${j}`);
  });
  const preds = cf.predicates(c, q.where);
  if (!Array.isArray(preds)) throw new Error(`fake layer: ${preds.message}`);
  if (q.exclude) preds.push(`NOT ${cf.predicate(c, { kind: 'in', column: q.exclude.dimension, values: q.exclude.values, negate: false }) as string}`);
  const order = q.order.map((o) => {
    const a = alias.get(o.by);
    if (!a) throw new Error(`fake layer: cannot order by ${o.by}`);
    return `${cf.nullsLast(a)}, ${a}${o.desc ? ' DESC' : ''}`;
  });
  if (q.limit !== undefined && !Number.isInteger(q.limit)) throw new Error('fake layer: a bad limit');
  const sql = `SELECT ${sel.join(', ')} FROM "${table}" AS lv_src${preds.length ? ` WHERE ${preds.join(' AND ')}` : ''}` +
    `${q.dimensions.length ? ` GROUP BY ${q.dimensions.map((_x, i) => `d${i}`).join(', ')}` : ''}` +
    `${order.length ? ` ORDER BY ${order.join(', ')}` : ''}${q.limit !== undefined ? ` LIMIT ${q.limit}` : ''}`;
  return c.b.finish(sql, d, [...q.dimensions.map((_x, i) => `d${i}`), ...q.metrics.map((_x, j) => `m${j}`)]);
}

/** Answer `q` from `table`, columns named by the query's dimensions then metrics (a layer's member names). */
export async function runFake(table: string, columns: LiveColumn[], q: SemanticQuery): Promise<SemanticAnswer> {
  const compiled = fakeSql(table, columns, q);
  return { columns: [...q.dimensions.map((x) => x.name), ...q.metrics], rows: await fx.runDuck(compiled) };
}

// ── The fake as a connector (semantic layer part 7, b1 Task 4) ───────────────
//
// `semantic-fake` answers `semantic.run(ctx, body)` with `body = { table, columns, query }` — its own request,
// as each backend's encoder writes its own — and `semantic-fake-net` is the same with a `host` field, so the
// SSRF guard resolves, checks and pins it first. Registered ONLY by a test, through `registerTestConnector`: the
// registry resolves the id, no catalog lists it. `layerFake.calls` records every call; `layerFake.hook` may hold,
// fail or slow one, as a real layer would.


export const SEMANTIC_FAKE_ID = 'semantic-fake';
export const SEMANTIC_FAKE_NET_ID = 'semantic-fake-net';

export interface LayerCall {
  body: { table: string; columns: LiveColumn[]; query: SemanticQuery };
  signal: AbortSignal | undefined;
  timeoutMs: number;
  rowLimit: number;
  costTag: ConnectorContext['costTag'];
  pinned: string | undefined;
}

type Described = Awaited<ReturnType<NonNullable<ConnectorDef['semantic']>['describeModel']>>;
type Listed = Awaited<ReturnType<NonNullable<ConnectorDef['semantic']>['listModels']>>;

export const layerFake: {
  calls: LayerCall[];
  hook: ((call: LayerCall, ctx: ConnectorContext) => Promise<ConnectorRows | ConnectorError | undefined>) | null;
  /** b2: what describeModel / listModels answer instead of the fixture's (a dropped metric, a planted model name, a layer error). */
  describe: ((model: string, ctx: ConnectorContext) => Promise<Described>) | null;
  list: ((ctx: ConnectorContext) => Promise<Listed>) | null;
  /** The models describeModel was asked for. */
  described: string[];
} = { calls: [], hook: null, describe: null, list: null, described: [] };

/** The fixture as the layer describes it: its columns as dimensions (a date at every grain), FAKE_METRICS as metrics. */
export function fixtureModel(): Extract<Described, { ok: true }> {
  const grains: import('../src/analysis/categoryKey').DateGrain[] = ['day', 'week', 'month', 'quarter', 'year'];
  return {
    ok: true,
    dimensions: fx.COLUMNS.map((c) => (c.type === 'date' ? { name: c.name, type: c.type, grains: grains.slice() } : { name: c.name, type: c.type })),
    metrics: Object.keys(FAKE_METRICS).map((name) => ({ name, additive: FAKE_ADDITIVE.has(name) })),
  };
}

async function layerRun(ctx: ConnectorContext, body: unknown): Promise<ConnectorRows | ConnectorError> {
  const b = body as LayerCall['body'];
  const call: LayerCall = { body: b, signal: ctx.signal, timeoutMs: ctx.timeoutMs, rowLimit: ctx.rowLimit, costTag: ctx.costTag, pinned: ctx.pinned?.address };
  layerFake.calls.push(call);
  try {
    const held = layerFake.hook ? await layerFake.hook(call, ctx) : undefined;
    if (held) return held;
    if (ctx.signal?.aborted) return { ok: false, error: 'Cancelled' };
    const a = await runFake(b.table, b.columns, b.query);
    return { ok: true, columns: a.columns.map((name) => ({ name, type: '' })), rows: a.rows.slice(0, ctx.rowLimit) as ConnectorRows['rows'], truncated: a.rows.length > ctx.rowLimit };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function layerDef(id: string, withHost: boolean): ConnectorDef {
  return {
    id,
    label: 'Fake semantic layer (tests)',
    family: 'semantic-fake',
    category: 'Cloud warehouses',
    readOnly: true,
    fields: [...(withHost ? [{ key: 'host', label: 'Host', type: 'text' as const }] : []), { key: 'token', label: 'Token', type: 'password', secret: true }],
    listTables: async () => ({ ok: true, tables: [] }),
    run: async () => ({ ok: false, error: 'A semantic layer has no rows to copy.' }),
    semantic: {
      backend: 'fake',
      caps: { lookups: true, binaryCompare: false },
      listModels: async (ctx) => (layerFake.list ? layerFake.list(ctx) : { ok: true, models: [{ name: 'fixture' }] }),
      describeModel: async (ctx, model) => {
        layerFake.described.push(model);
        return layerFake.describe ? layerFake.describe(model, ctx) : fixtureModel();
      },
      run: layerRun,
    },
  };
}

let registered = false;

/** Make the fake layer resolvable by id (never listed), with its label for the sentences. Idempotent. */
export function registerSemanticFake(): void {
  if (registered) return;
  const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');
  const refusals: typeof import('../src/engine/live/semantic/semanticRefusals') = require('../src/engine/live/semantic/semanticRefusals');
  registry.registerTestConnector(layerDef(SEMANTIC_FAKE_ID, false));
  registry.registerTestConnector(layerDef(SEMANTIC_FAKE_NET_ID, true));
  refusals.registerLayerLabel('fake', 'Fake layer');
  registered = true;
}

export function resetLayerFake(): void {
  layerFake.calls.length = 0;
  layerFake.hook = null;
  layerFake.describe = null;
  layerFake.list = null;
  layerFake.described.length = 0;
}
