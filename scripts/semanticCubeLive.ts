// A REAL Cube deployment, asked the semantic parity matrix (semantic layer part 7, e1; docs/live-data/cube.md).
// Helper, not a suite: scripts/test-semanticCubeLive.ts runs it against the deployment scripts/fixtures/cube/compose.yml
// starts (the warehouse nightly's `cube` job), and scripts/test-semanticCubeDoors.ts runs it on every pull request
// against the in-process fake, so it cannot rot before (or between) real runs.
//
//   1. /v1/meta lists the cube and the view, types the eight dimensions as the fixture declares them, and says sum
//      and count add up, avg and max do not.
//   2. PROBES for what the docs leave open (docs/live-data/cube.md, "What only a real deployment can prove"): a
//      dimensions-only query lists each value once, NULL last on `asc`; a week bucket starts on a Monday; the
//      50,000-row limit is accepted — each relied on, so each a check.
//   3. The semantic parity MATRIX (./semanticParityMatrix.ts): charts, "Other", every grain, every filter, KPIs and
//      answers asked of Cube through the shipped encoder and the connector's semantic door, against an extract of the
//      same rows (Object.is; sum/avg within 1e-13); the filters Cube cannot express refused (`layerFilter`).
//      NEGATIVE CONTROL: a question with its filter dropped disagrees.
//
// Every request goes through the server's SSRF guard and pin (the caller admits the deployment's address with
// SSRF_ALLOW), signed with a fresh token from the API secret.

import type { SemanticRunner } from '../src/engine/live/semantic/evaluateSemantic';
import type { SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';
import type { Log } from './semanticParityMatrix';

const registry: typeof import('../src/connectors') = require('../src/connectors');
const semanticRun: typeof import('../src/connectors/semanticRun') = require('../src/connectors/semanticRun');
const cubeEnc: typeof import('../src/engine/live/semantic/cube') = require('../src/engine/live/semantic/cube');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const sync: typeof import('../src/engine/live/semantic/semanticSync') = require('../src/engine/live/semantic/semanticSync');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
const pm: typeof import('./semanticParityMatrix') = require('./semanticParityMatrix');

const show = (v: unknown): string => JSON.stringify(v);

/** The matrix filters Cube cannot express exactly: refused `layerFilter` at every door (docs/live-data/cube.md). */
export function cubeRefusedFilters(): ReadonlyMap<string, string> {
  return new Map([[show([mx.F('cat', 'is_empty')]), 'layerFilter'], [show([mx.F('cat', 'not_empty')]), 'layerFilter'], [show([mx.F('cat', 'contains', 'a')]), 'layerFilter']]);
}

export interface CubeLiveConfig {
  url: string;
  secret: string;
}

type Ok = (label: string, cond: boolean, extra?: unknown) => void;

export async function runCubeLive(cfg: CubeLiveConfig, ok: Ok, say: (line: string) => void = console.log): Promise<{ loads: number }> {
  const def = registry.getConnector('cube');
  ok('cube: the registry has the cube connector, with its semantic capability', !!def?.semantic && def.semantic.backend === 'cube');
  if (!def?.semantic) return { loads: 0 };
  const values = { url: cfg.url, auth: 'secret' };
  const secrets = { token: cfg.secret };
  const opts = { timeoutMs: 120_000, signal: new AbortController().signal };

  // 1. The catalog.
  const listed = await semanticRun.listSemanticModels(def, values, secrets, opts);
  ok('cube: /v1/meta lists the cube and the view', listed.ok && ['orders', 'orders_view'].every((n) => listed.models.some((m) => m.name === n)), show(listed));
  const d = await semanticRun.describeSemanticModel(def, values, secrets, 'orders', opts);
  ok('cube: the eight dimensions typed as the fixture declares them', d.ok && show(d.dimensions.map((x) => [x.name, x.type])) === show(fx.COLUMNS.map((c) => [c.name, c.type])), d.ok ? show(d.dimensions) : show(d));
  ok('cube: …sum and count add up, avg and max do not', d.ok && show(d.metrics.map((m) => [m.name, m.additive])) === show([['revenue', true], ['orders', true], ['avg_amount', false], ['max_amount', false]]), d.ok ? show(d.metrics) : '');
  if (!d.ok) return { loads: 0 };
  const read = sync.readModel(d, 'cube', 'orders', new Date().toISOString());
  const env: SemanticEnv = {
    dataset: 'Fixture', layer: 'Cube', columns: read.columns,
    metrics: new Map(read.semantic.metrics.map((m) => [m.name, { additive: m.additive }])),
    grains: new Map(read.semantic.grains.map((g) => [g.column, g.grains])),
    caps: def.semantic.caps,
  };

  let loads = 0;
  const ask = (log: Log): SemanticRunner => async (q, step) => {
    const req = cubeEnc.cubeAdapter.encode(q, 'orders', env.columns, { dataset: env.dataset, layer: env.layer });
    if (spec.isRefusal(req)) return req;
    loads += 1;
    const r = await semanticRun.runSemanticBound(def, values, secrets, req, opts);
    if (!r.ok) throw new Error(`Cube refused a ${step} question: ${r.error}`);
    if (r.truncated) throw new Error(`Cube answered a ${step} question past the row cap`);
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
  const regions = await probe({ dimensions: [{ name: 'region' }], metrics: [], where: [], order: [{ by: 'region', desc: false }] });
  ok('cube probe: a dimensions-only query lists each value once, NULL last on asc', Array.isArray(regions) && show(regions.map((r) => r[0])) === show(['East', 'North', 'South', 'West', null]), show(regions));
  const weeks = await probe({ dimensions: [{ name: 'd', grain: 'week' }], metrics: ['orders'], where: [], order: [{ by: 'd', desc: false }] });
  ok('cube probe: a week bucket starts on a Monday (ISO weeks)', Array.isArray(weeks) && weeks.length > 10 && weeks.every((r) => r[0] === null || new Date(`${String(r[0]).slice(0, 10)}T00:00:00Z`).getUTCDay() === 1), show(Array.isArray(weeks) ? weeks.slice(0, 3) : weeks));
  const all = await probe({ dimensions: [{ name: 'many' }], metrics: ['revenue'], where: [], order: [{ by: 'many', desc: false }] });
  ok('cube probe: the 50,000-row limit is accepted (every question without the plan\'s own limit asks it)', Array.isArray(all) && all.length === 60, show(Array.isArray(all) ? all.length : all));

  // 3. The matrix, against an extract of the same rows; the SQL path's order over the same rows in DuckDB.
  const today = process.env.ORDINATE_TODAY;
  process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, so relative periods find rows
  const t0 = Date.now();
  try {
    const x = await mx.setupExtract(ok);
    if (!x) return { loads };
    const layout = fx.layout(fx.COLUMNS);
    const source = await fx.duckEngine.load('cube_nightly_twin', layout, fx.warehouseCells(fx.COLUMNS, x.rows));
    const b: import('./semanticParityMatrix').Bench = { x, env, typed: fx.env(source, mx.declared(fx.duckEngine, layout)), kit: mx.parityKit(x, fx.runDuck), ask, refused: cubeRefusedFilters() };
    await pm.matrix(b, (label, cond, extra) => ok(`cube: ${label}`, cond, extra));
    const dropped: import('./semanticParityMatrix').Bench = { ...b, ask: (log) => async (q, step) => ask(log)({ ...q, where: [] }, step) };
    const broken = await pm.chartCase(dropped, { name: 'n', metrics: ['revenue'], enc: { category: 'cat' }, filters: [mx.F('region', '=', 'North')] });
    ok('cube: NEGATIVE CONTROL a question with its filter dropped disagrees with the extract', broken.problems.length > 0);
  } finally {
    if (today === undefined) delete process.env.ORDINATE_TODAY;
    else process.env.ORDINATE_TODAY = today;
  }
  say(`  cube: ${loads} loads in ${Math.round((Date.now() - t0) / 1000)} s`);
  return { loads };
}
