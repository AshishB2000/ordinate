// A REAL dbt Cloud Semantic Layer, asked the semantic parity matrix (semantic layer part 7, d1, BETA;
// docs/live-data/dbt-semantic-layer.md). Helper, not a suite: scripts/test-semanticDbtLive.ts runs it against the
// account the warehouse nightly's secrets name, and scripts/test-semanticDbtDoors.ts runs it on every pull request
// against the fake API, so it cannot rot before (or between) real runs.
//
//   1. The saved query `ordinate_parity` (scripts/dbtFixture.ts: the project files the owner adds) is listed; its
//      group-bys are the fixture's columns as dbt types them (`order__many`, … text, `order__d` a date at every
//      grain); sum and count add up, average and max do not.
//   2. PROBES for what the docs leave open: a group-by-only query lists each value once with the blanks dropped; a
//      week bucket starts on a Monday. Each relied on, so each a check.
//   3. The semantic parity MATRIX (./semanticParityMatrix.ts) asked of dbt through the shipped encoder and the
//      connector's semantic door, against an extract of the same rows (Object.is; sum/avg within 1e-13); what dbt
//      cannot express refused. NEGATIVE CONTROL: a question with its filter dropped disagrees.
//
// The matrix asks by the fixture's own names; each question is renamed to dbt's (`order__` + the column) on the way
// in. Every request goes through the server's SSRF guard and pin, with the service token in its header only.

import type { SemanticRunner } from '../src/engine/live/semantic/evaluateSemantic';
import type { SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';
import type { Log } from './semanticParityMatrix';

const registry: typeof import('../src/connectors') = require('../src/connectors');
const semanticRun: typeof import('../src/connectors/semanticRun') = require('../src/connectors/semanticRun');
const dbtEnc: typeof import('../src/engine/live/semantic/dbt') = require('../src/engine/live/semantic/dbt');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const sync: typeof import('../src/engine/live/semantic/semanticSync') = require('../src/engine/live/semantic/semanticSync');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
const pm: typeof import('./semanticParityMatrix') = require('./semanticParityMatrix');
const fakeDbt: typeof import('./semanticFakeDbt') = require('./semanticFakeDbt');
const project: typeof import('./dbtFixture') = require('./dbtFixture');

const show = (v: unknown): string => JSON.stringify(v);

export interface DbtLiveConfig {
  region: string;
  environmentId: string;
  token: string;
}

type Ok = (label: string, cond: boolean, extra?: unknown) => void;

/** The question by dbt's names: every dimension the fixture's column with the entity's prefix. */
export function qualify(q: SemanticQuery): SemanticQuery {
  const p = (n: string): string => `${project.PREFIX}${n}`;
  const dims = new Set(q.dimensions.map((d) => d.name));
  return {
    ...q,
    dimensions: q.dimensions.map((d) => ({ ...d, name: p(d.name) })),
    where: q.where.map((f) => ({ ...f, column: p(f.column) })),
    order: q.order.map((o) => (dims.has(o.by) ? { ...o, by: p(o.by) } : o)),
    ...(q.exclude ? { exclude: { ...q.exclude, dimension: p(q.exclude.dimension) } } : {}),
  };
}

export async function runDbtLive(cfg: DbtLiveConfig, ok: Ok, say: (line: string) => void = console.log): Promise<{ queries: number }> {
  const def = registry.getConnector('dbt-semantic-layer');
  ok('dbt: the registry has the dbt Semantic Layer connector, with its semantic capability', !!def?.semantic && def.semantic.backend === 'dbt');
  if (!def?.semantic) return { queries: 0 };
  const values = { region: cfg.region, environmentId: cfg.environmentId };
  const secrets = { token: cfg.token };
  const opts = { timeoutMs: 120_000, signal: new AbortController().signal };

  // 1. The catalog.
  const listed = await semanticRun.listSemanticModels(def, values, secrets, opts);
  ok(`dbt: savedQueriesPaginated lists ${project.SAVED_QUERY}`, listed.ok && listed.models.some((m) => m.name === project.SAVED_QUERY), show(listed));
  const d = await semanticRun.describeSemanticModel(def, values, secrets, project.SAVED_QUERY, opts);
  const want = fakeDbt.asDbtTypes(fx.COLUMNS).map((c) => [`${project.PREFIX}${c.name}`, c.type]);
  ok('dbt: its group-bys typed as dbt types them (categorical text, time date)', d.ok && show(d.dimensions.map((x) => [x.name, x.type])) === show(want), d.ok ? show(d.dimensions) : show(d));
  // Sum and count add up only where the API can say a measure has no non-additive dimension; one that refuses the field
  // (the SDK's Measure has none) reads every metric as not additive (fail safe). Average and max never add up.
  const adds = d.ok ? show(d.metrics.map((m) => [m.name, m.additive])) : '';
  ok('dbt: …sum and count add up (or, on an API without nonAdditiveDimension, nothing does), average and max do not',
    adds === show([['revenue', true], ['orders', true], ['avg_amount', false], ['max_amount', false]]) || adds === show([['revenue', false], ['orders', false], ['avg_amount', false], ['max_amount', false]]), d.ok ? show(d.metrics) : '');
  if (!d.ok) return { queries: 0 };
  const read = sync.readModel(d, 'dbt', project.SAVED_QUERY, new Date().toISOString());

  let queries = 0;
  const ask = (log: Log): SemanticRunner => async (q, step) => {
    const req = dbtEnc.dbtAdapter.encode(qualify(q), project.SAVED_QUERY, read.columns, { dataset: 'Fixture', layer: 'dbt' });
    if (spec.isRefusal(req)) return req;
    queries += 1;
    const r = await semanticRun.runSemanticBound(def, values, secrets, req, opts);
    if (!r.ok) throw new Error(`dbt refused a ${step} question: ${r.error}`);
    if (r.truncated) throw new Error(`dbt answered a ${step} question past the row cap`);
    const rows = sq.alignRows(r.columns.map((c) => c.name), r.rows, req.columns);
    if (!rows) return spec.refuse('rowShape');
    log.push({ q, step, rows: rows.length });
    return { columns: sq.answerColumns(q), rows };
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
  const regions = await probe({ dimensions: [{ name: 'region' }], metrics: [], where: [{ kind: 'empty', column: 'region', negate: true }], order: [{ by: 'region', desc: false }] });
  ok('dbt probe: a group-by-only query lists each value once, the blanks dropped', Array.isArray(regions) && show(regions.map((r) => r[0])) === show(['East', 'North', 'South', 'West']), show(regions));
  const weeks = await probe({ dimensions: [{ name: 'd', grain: 'week' }], metrics: ['orders'], where: [], order: [{ by: 'd', desc: false }] });
  ok('dbt probe: a week bucket starts on a Monday (ISO weeks)', Array.isArray(weeks) && weeks.length > 10 && weeks.every((r) => r[0] === null || new Date(`${String(r[0]).slice(0, 10)}T00:00:00Z`).getUTCDay() === 1), show(Array.isArray(weeks) ? weeks.slice(0, 3) : weeks));

  // 3. The matrix, against an extract of the same rows; the SQL path's order over the same rows in DuckDB.
  const today = process.env.ORDINATE_TODAY;
  process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, so relative periods find rows
  const t0 = Date.now();
  try {
    const x = await mx.setupExtract(ok);
    if (!x) return { queries };
    const layout = fx.layout(fx.COLUMNS);
    const source = await fx.duckEngine.load('dbt_nightly_twin', layout, fx.warehouseCells(fx.COLUMNS, x.rows));
    const typed = mx.declared(fx.duckEngine, layout);
    // The plan keeps the fixture's types (the matrix's extract twins total `amt`); the encoder sees the dataset's.
    const env: SemanticEnv = {
      dataset: 'Fixture', layer: 'dbt', columns: typed,
      metrics: new Map(read.semantic.metrics.map((m) => [m.name, { additive: m.additive }])),
      grains: new Map(read.semantic.grains.map((g) => [g.column.slice(project.PREFIX.length), g.grains])),
      caps: def.semantic.caps,
    };
    const b: import('./semanticParityMatrix').Bench = { x, env, typed: fx.env(source, typed), kit: mx.parityKit(x, fx.runDuck), ask, refused: fakeDbt.dbtRefusedFilters(), refusedCases: fakeDbt.dbtRefusedCases() };
    await pm.matrix(b, (label, cond, extra) => ok(`dbt: ${label}`, cond, extra));
    const dropped: import('./semanticParityMatrix').Bench = { ...b, ask: (log) => async (q, step) => ask(log)({ ...q, where: [] }, step) };
    const broken = await pm.chartCase(dropped, { name: 'n', metrics: ['revenue'], enc: { category: 'cat' }, filters: [mx.F('region', '=', 'North')] });
    ok('dbt: NEGATIVE CONTROL a question with its filter dropped disagrees with the extract', broken.problems.length > 0);
  } finally {
    if (today === undefined) delete process.env.ORDINATE_TODAY;
    else process.env.ORDINATE_TODAY = today;
  }
  say(`  dbt: ${queries} questions in ${Math.round((Date.now() - t0) / 1000)} s`);
  return { queries };
}
