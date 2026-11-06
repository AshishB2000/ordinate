// A REAL Snowflake semantic view (semantic layer part 7, c1; docs/live-data/snowflake-semantic-views.md): the part
// of scripts/test-warehouseLive.ts that runs when SNOWFLAKE_SEMANTIC_VIEW names the view the owner made once with
// scripts/fixtures/snowflake-semantic-view.sql. Same credentials, same server mode (every socket SSRF-checked and
// pinned), same secret canary; the role only needs SELECT on the view.
//
//   1. SHOW SEMANTIC VIEWS lists it; DESCRIBE SEMANTIC VIEW types its eight dimensions as the fixture declares them
//      and says SUM and COUNT add up, AVG and MAX do not.
//   2. PROBES: one statement each for what the docs leave open (docs/live-data/snowflake-semantic-views.md, "What
//      only a real account can prove"): a `?` bind inside the clause, DATE_TRUNC in DIMENSIONS, a DIMENSIONS-only
//      lookup — each relied on, so each a check — and TO_BINARY inside the clause, recorded only (D17 stays closed
//      until it is pinned).
//   3. The semantic parity MATRIX (./semanticParityMatrix.ts, the one every `npm test` asks the fake layer): charts,
//      "Other", every grain, every filter, KPIs and answers asked of the view through the shipped encoder and the
//      connector's semantic door, against an extract of the same literal rows (Object.is; sum/avg within 1e-13).
//      NEGATIVE CONTROL: a question with its filter dropped disagrees.

import type { SnowflakeConfig } from './warehouseLiveSnowflake';
import type { SemanticRunner } from '../src/engine/live/semantic/evaluateSemantic';
import type { SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';
import type { Log } from './semanticParityMatrix';
import { errOf, ident, keep, ok, say, summary } from './warehouseLiveHarness';

const registry: typeof import('../src/connectors') = require('../src/connectors');
const semanticRun: typeof import('../src/connectors/semanticRun') = require('../src/connectors/semanticRun');
const sfSem: typeof import('../src/engine/live/semantic/snowflake') = require('../src/engine/live/semantic/snowflake');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const sync: typeof import('../src/engine/live/semantic/semanticSync') = require('../src/engine/live/semantic/semanticSync');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
const pm: typeof import('./semanticParityMatrix') = require('./semanticParityMatrix');

const show = (v: unknown): string => JSON.stringify(v);

export async function runSnowflakeSemantic(cfg: SnowflakeConfig): Promise<void> {
  const view = cfg.semanticView ?? '';
  ident('snowflake semantic view', view, true);
  view.split('.').forEach((p, i) => ident(`snowflake semantic view part ${i + 1}`, p, true));
  const def = registry.getConnector('snowflake');
  ok('semantic: the snowflake connector has its semantic capability', !!def?.semantic && def.semantic.backend === 'snowflake');
  if (!def?.semantic) return;
  const { values, secrets } = (require('./warehouseLiveSnowflake') as typeof import('./warehouseLiveSnowflake')).snowflakeConnection(cfg);
  const vals = { ...values, database: view.split('.')[0] }; // SHOW … IN DATABASE lists the view's own database
  const opts = { timeoutMs: 120_000, signal: new AbortController().signal };

  // 1. The catalog.
  const listed = keep(await semanticRun.listSemanticModels(def, vals, secrets, opts));
  ok('semantic: SHOW SEMANTIC VIEWS lists the view', listed.ok && listed.models.some((m) => m.name === view), errOf(listed));
  const d = keep(await semanticRun.describeSemanticModel(def, vals, secrets, view, opts));
  ok('semantic: DESCRIBE SEMANTIC VIEW types the eight dimensions as the fixture declares them',
    d.ok && show(d.dimensions.map((x) => [x.name, x.type])) === show(fx.COLUMNS.map((c) => [c.name, c.type])), d.ok ? show(d.dimensions) : errOf(d));
  ok('semantic: …and reads SUM and COUNT as adding up, AVG and MAX as not',
    d.ok && show(d.metrics.map((m) => [m.name, m.additive])) === show([['revenue', true], ['orders', true], ['avg_amount', false], ['max_amount', false]]), d.ok ? show(d.metrics) : '');
  if (!d.ok) return;
  const read = sync.readModel(d, 'snowflake', view, new Date().toISOString());
  const env: SemanticEnv = {
    dataset: 'Fixture', layer: 'Snowflake', columns: read.columns,
    metrics: new Map(read.semantic.metrics.map((m) => [m.name, { additive: m.additive }])),
    grains: new Map(read.semantic.grains.map((g) => [g.column, g.grains])),
    caps: def.semantic.caps,
  };

  let statements = 0;
  const ask = (log: Log): SemanticRunner => async (q, step) => {
    const req = sfSem.snowflakeAdapter.encode(q, view, env.columns);
    statements += 1;
    const r = keep(await semanticRun.runSemanticBound(def, vals, secrets, req, opts));
    if (!r.ok) throw new Error(`Snowflake refused a ${step} question: ${r.error}`);
    const rows = sq.alignRows(r.columns.map((c) => c.name), r.rows, req.columns);
    if (!rows) return spec.refuse('rowShape');
    log.push({ q, step, rows: rows.length });
    return { columns: req.columns.slice(), rows };
  };

  // 2. The probes.
  const probe = async (q: SemanticQuery): Promise<unknown[][] | string> => {
    try {
      const a = await ask([])(q, 'chart');
      return spec.isRefusal(a) ? `refused: ${a.code}` : a.rows;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const north: SemanticQuery['where'] = [{ kind: 'compare', column: 'region', op: '=', value: 'North' }];
  const kpi = (where: SemanticQuery['where']): SemanticQuery => ({ dimensions: [], metrics: ['orders'], where, order: [] });
  const bound = await probe(kpi(north));
  ok('semantic probe: a `?` bind inside the clause\'s WHERE is accepted', Array.isArray(bound) && bound.length === 1, show(bound));
  const month = await probe({ dimensions: [{ name: 'd', grain: 'month' }], metrics: ['revenue'], where: [], order: [{ by: 'd', desc: false }] });
  ok('semantic probe: DATE_TRUNC in DIMENSIONS is accepted, one row a month at its first day', Array.isArray(month) && month.length > 20
    && month.every((r) => r[0] === null || /^\d{4}-\d{2}-01$/.test(String(r[0]))), show(Array.isArray(month) ? month.slice(0, 3) : month));
  const regions = await probe({ dimensions: [{ name: 'region' }], metrics: [], where: [], order: [{ by: 'region', desc: false }] });
  ok('semantic probe: a DIMENSIONS-only statement lists each value once', Array.isArray(regions) && show(regions.map((r) => r[0])) === show(['East', 'North', 'South', 'West', null]), show(regions));
  const locked = await probe(kpi([{ kind: 'compare', column: 'region', op: '=', value: 'North', binary: true }]));
  const same = Array.isArray(locked) && Array.isArray(bound) && Object.is(locked[0]?.[0], bound[0]?.[0]);
  say(`semantic probe: TO_BINARY inside the clause ${Array.isArray(locked) ? (same ? 'is accepted and answers as the plain compare' : `is accepted but answers ${show(locked)}`) : `is refused (${locked})`} — recorded only; binaryCompare stays false until pinned`);
  summary(`- Snowflake semantic view: TO_BINARY inside the clause ${Array.isArray(locked) ? (same ? 'works' : 'answers differently') : 'is refused'} (D17 stays closed until it is pinned)`);

  // 3. The matrix, against an extract of the same literal rows; the SQL path's order over the same rows in DuckDB.
  const today = process.env.ORDINATE_TODAY;
  process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, so relative periods find rows
  const t0 = Date.now();
  try {
    const x = await mx.setupExtract(ok);
    if (!x) return;
    const layout = fx.layout(fx.COLUMNS);
    const source = await fx.duckEngine.load('semantic_nightly_twin', layout, fx.warehouseCells(fx.COLUMNS, x.rows));
    const b: import('./semanticParityMatrix').Bench = { x, env, typed: fx.env(source, mx.declared(fx.duckEngine, layout)), kit: mx.parityKit(x, fx.runDuck), ask };
    await pm.matrix(b, (label, cond, extra) => ok(`semantic: ${label}`, cond, extra));
    const dropped: import('./semanticParityMatrix').Bench = { ...b, ask: (log) => async (q, step) => ask(log)({ ...q, where: [] }, step) };
    const broken = await pm.chartCase(dropped, { name: 'n', metrics: ['revenue'], enc: { category: 'cat' }, filters: [mx.F('region', '=', 'North')] });
    ok('semantic: NEGATIVE CONTROL a question with its filter dropped disagrees with the extract', broken.problems.length > 0);
  } finally {
    if (today === undefined) delete process.env.ORDINATE_TODAY;
    else process.env.ORDINATE_TODAY = today;
  }
  say(`semantic: ${statements} statements to the view in ${Math.round((Date.now() - t0) / 1000)} s`);
  summary(`- Snowflake semantic view parity: ${statements} statements`);
}
