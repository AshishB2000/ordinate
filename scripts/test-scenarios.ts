// Scenarios — the driver algebra, the resolver end to end against a real
// (temporary) project store, and the resident fast path against its reference.
//
//   1. model        sanitize, labels, the pieces algebra, list order, params,
//                   the tornado's ordering
//   2. baseline     computing a scenario never changes the baseline (Object.is
//                   resolveMetric), the record, or the stored dataset; no
//                   drivers ⇒ every scenario figure IS its baseline
//   3. drivers      sum, avg, min/max and ratio metrics under column and metric
//                   drivers — filtered, overlapping, in list order; count is
//                   untouched; a dashboard scope and a bound parameter apply
//   4. tornado      symmetric swings for an additive metric, widest first
//   5. differential scenarioResident ≡ scenarioInputs (Object.is, every piece),
//                   and a resident scenario never hydrates the table
//   6. surfaces     compare, the KPI card, the facts ledger, the IPC names,
//                   the store and the bundle whitelist
//
// Integer measures, deliberately: the resident path sums in parallel and the
// reference folds left, and whole numbers are exact on both (test-metrics.ts).
//
//   npm run build:ts && node scripts/test-scenarios.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

type Cell = import('../src/data/transforms').Cell;
type FilterStep = import('../src/data/transforms').FilterStep;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-scenarios-'));
// Handlers land in the RPC registry (src/ipc/bus.ts).
const handlers: Map<string, IpcHandler> = require('../src/server/rpc').handlers;
process.env.ORDINATE_LOCAL_DIR = tmp;

const model: typeof import('../src/analysis/scenarioModel') = require('../src/analysis/scenarioModel');
const store: typeof import('../src/analysis/scenarios') = require('../src/analysis/scenarios');
const resolve: typeof import('../src/analysis/scenarioResolve') = require('../src/analysis/scenarioResolve');
const inputsJs: typeof import('../src/analysis/scenarioInputs') = require('../src/analysis/scenarioInputs');
const resident: typeof import('../src/engine/scenarioResident') = require('../src/engine/scenarioResident');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const params: typeof import('../src/analysis/params') = require('../src/analysis/params');
const metricsIpc: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const scenariosIpc: typeof import('../src/ipc/scenarios') = require('../src/ipc/scenarios');
const copilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const audit: typeof import('../src/ai/numberAudit') = require('../src/ai/numberAudit');

scenariosIpc.register();

// ── the hydration spy (ipc/dashboards and the resolver read getDataset off the namespace at call time) ──
const realGetDataset = datasets.getDataset;
let hydrations = 0;
(datasets as any).getDataset = async (...args: any[]): Promise<any> => {
  hydrations += 1;
  return (realGetDataset as any)(...args);
};

const close = (a: unknown, b: number, eps = 1e-9): boolean => typeof a === 'number' && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = (column: string, value: number, filter?: any): any => ({ kind: 'pct', target: filter ? { column, filter } : { column }, value });
const A = (column: string, value: number, filter?: any): any => ({ kind: 'abs', target: filter ? { column, filter } : { column }, value });
const WEST: FilterStep = { type: 'filter', column: 'region', op: '=', value: 'West' };
const EAST_OR_WEST: FilterStep = { type: 'filter', column: 'region', op: 'in', values: ['West', 'East'] } as FilterStep;

// ── 1. model ─────────────────────────────────────────────────────────────────

function modelChecks(): void {
  const ds = model.sanitizeDrivers([
    P('unit_price', 5),
    P('units', -3, { type: 'filter', column: 'region', op: '=', value: 'West' }),
    A('discount', 0),
    { kind: 'pct', target: { metricId: U(1) }, value: -500 },          // clamped to −100
    { kind: 'pct', target: { column: '' }, value: 5 },                 // no column → dropped
    { kind: 'abs', target: { column: 'x' }, value: 'seven' },          // no value → dropped
    { kind: 'boost', target: { column: 'x' }, value: 1 },              // unknown kind → dropped
    { kind: 'pct', target: { metricId: '../etc' }, value: 1 },          // not a UUID → dropped
    { kind: 'pct', target: { column: 'y', filter: { type: 'drop_column', column: 'y' } }, value: 1, param: 'bad name!' },
  ]);
  ok('sanitize: unusable drivers are dropped, never guessed', ds.length === 5, JSON.stringify(ds));
  ok('sanitize: pct is clamped at −100', ds[3].value === -100);
  ok('sanitize: a non-filter step is not a driver filter, a bad param name is dropped', !('filter' in ds[4].target) && ds[4].param === undefined);
  ok('sanitize: base metrics are distinct UUIDs, capped',
    JSON.stringify(model.sanitizeBaseMetricIds([U(1), U(1), 'x', U(2)])) === JSON.stringify([U(1), U(2)])
    && model.sanitizeBaseMetricIds(Array.from({ length: 30 }, (_, i) => U(i + 1))).length === model.MAX_BASE_METRICS);

  ok('label: pct on a column', model.driverLabel(ds[0]) === 'unit_price +5%', model.driverLabel(ds[0]));
  ok('label: a filtered driver, with a real minus sign', model.driverLabel(ds[1]) === 'units in West −3%', model.driverLabel(ds[1]));
  ok('label: abs sets the target', model.driverLabel(ds[2]) === 'discount = 0');
  ok('label: a metric target is named', model.driverLabel(ds[3], 'Revenue') === 'Revenue −100%');
  ok('label: an in-list filter', model.driverLabel(P('revenue', 2.5, EAST_OR_WEST)) === 'revenue in West, East +2.5%');

  const pieces = { sum: 60, n: 3, nonEmpty: 4, min: 10, max: 30 };
  const up = model.movePieces(pieces, { index: 0, kind: 'pct', value: 50 });
  ok('pieces: pct scales sum, min and max; counts stay', up.sum === 90 && up.min === 15 && up.max === 45 && up.n === 3 && up.nonEmpty === 4);
  const set = model.movePieces(pieces, { index: 0, kind: 'abs', value: 7 });
  ok('pieces: abs sets every numeric cell (sum = value × count)', set.sum === 21 && set.min === 7 && set.max === 7 && set.nonEmpty === 4);
  ok('pieces: abs over no numeric cell moves nothing', model.movePieces({ sum: 0, n: 0, nonEmpty: 2, min: null, max: null }, { index: 0, kind: 'abs', value: 7 }).n === 0);
  ok('fold: count is non-empty cells, sum/avg over numeric cells', model.foldPieces([pieces, set], 'count') === 8
    && model.foldPieces([pieces, set], 'sum') === 81 && model.foldPieces([pieces, set], 'avg') === 81 / 6);
  ok('fold: no numeric cell → null, never 0 (count → 0)', model.foldPieces([], 'sum') === null && model.foldPieces([], 'count') === 0);

  // List order: "West = 10, then +10%" is 11 in the West; the reverse is 10.
  const parts = [{ key: [true, true], pieces: { sum: 5, n: 1, nonEmpty: 1, min: 5, max: 5 } }];
  const moves = [{ index: 0, kind: 'abs' as const, value: 10 }, { index: 1, kind: 'pct' as const, value: 10 }];
  ok('order: drivers apply in list order', close(model.applyColumnMoves(parts, moves)[0].sum, 11) && model.applyColumnMoves(parts, moves.slice().reverse())[0].sum === 10);
  ok('nudge: only the named driver is pushed', close(model.applyColumnMoves(parts, moves, { index: 0, factor: 1.1 })[0].sum, 12.1));
  ok('metric move: pct scales, abs sets, null stays null for pct',
    model.applyMetricMoves(200, [{ index: 0, kind: 'pct', value: -10 }]) === 180 && model.applyMetricMoves(null, [{ index: 0, kind: 'abs', value: 3 }]) === 3
    && model.applyMetricMoves(null, [{ index: 0, kind: 'pct', value: 3 }]) === null);

  const bound = model.effectiveDrivers([{ ...P('revenue', 5), name: '', param: 'uplift' }], params.paramValues([{ name: 'uplift', kind: 'number', value: 20 }]));
  ok('params: a bound NUMBER parameter replaces the value', bound[0].value === 20);
  const text = model.effectiveDrivers([{ ...P('revenue', 5), name: '', param: 'uplift' }], params.paramValues([{ name: 'uplift', kind: 'text', value: 'x' }]));
  ok('params: a text parameter of that name does not', text[0].value === 5);

  const bars = model.tornadoBars([
    { index: 0, label: 'a', low: 9, high: 11 }, { index: 1, label: 'b', low: 5, high: 15 },
    { index: 2, label: 'c', low: 10, high: 10 }, { index: 3, label: 'd', low: 8, high: 12 },
  ]);
  ok('tornado: widest swing first', bars.map((b) => b.label).join('') === 'bdac' && bars[0].swing === 10);
}

// ── fixture ──────────────────────────────────────────────────────────────────

const COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' }, { name: 'units', type: 'number' }, { name: 'unit_price', type: 'number' },
  { name: 'discount', type: 'number' }, { name: 'revenue', type: 'number' }, { name: 'profit', type: 'number' },
  { name: 'note', type: 'text' },
];
const REGIONS = ['North', 'South', 'East', 'West'];

function buildRows(n: number): Cell[][] {
  const rows: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    rows.push([
      REGIONS[i % 4], i % 17 === 0 ? null : (i % 9) + 1, (i % 23) + 10, i % 5 === 0 ? 0 : i % 3,
      (i % 97) + 3, (i % 13) - 4, i % 3 === 0 ? '   ' : 'n' + i,
    ]);
  }
  return rows;
}

const ROWS = buildRows(2500);
const col = (name: string): number => COLUMNS.findIndex((c) => c.name === name);
/** Σ of a column over the rows a predicate keeps — the independent arithmetic. */
function total(name: string, keep: (r: Cell[]) => boolean = () => true): number {
  let s = 0;
  for (const r of ROWS) if (keep(r) && typeof r[col(name)] === 'number') s += r[col(name)] as number;
  return s;
}
function numericCount(name: string, keep: (r: Cell[]) => boolean = () => true): number {
  return ROWS.filter((r) => keep(r) && typeof r[col(name)] === 'number').length;
}
const isWest = (r: Cell[]): boolean => r[0] === 'West';
const notWest = (r: Cell[]): boolean => r[0] !== 'West';

// ── 2–6 ──────────────────────────────────────────────────────────────────────

async function resolverChecks(): Promise<void> {
  await projects.init();
  const project = await projects.createProject('Scenario test');
  const pid = project.id;
  const saved = await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
  ok('fixture: dataset saved', !!saved);
  if (!saved) return;
  const dsid = saved.id;
  const mk = async (name: string, definition: any, format: any = { kind: 'number', decimals: 2 }): Promise<string> =>
    (await metrics.saveMetric(pid, { name, datasetId: dsid, definition, format }))!.id;
  const revenue = await mk('Revenue', { column: 'revenue', aggregation: 'sum' });
  const profit = await mk('Profit', { column: 'profit', aggregation: 'sum' });
  const margin = await mk('Margin', { formula: '[Profit] / [Revenue]' }, { kind: 'percent', decimals: 1 });
  const units = await mk('Units', { column: 'units', aggregation: 'sum' });
  const avgPrice = await mk('Avg price', { column: 'unit_price', aggregation: 'avg' });
  const maxPrice = await mk('Max price', { column: 'unit_price', aggregation: 'max' });
  const minPrice = await mk('Min price', { column: 'unit_price', aggregation: 'min' });
  const discount = await mk('Discount', { column: 'discount', aggregation: 'sum' });
  const rowsWithUnits = await mk('Rows with units', { column: 'units', aggregation: 'count' });
  const perUnit = await mk('Revenue per unit', { formula: 'sum(revenue) / sum(units)' });
  const ALL = [revenue, profit, margin, units, avgPrice, maxPrice, minPrice, discount, rowsWithUnits, perUnit];

  const R = total('revenue');
  const PR = total('profit');
  const run = async (drivers: any[], ids: string[] = ALL, opts: any = {}): Promise<Map<string, number | null>> => {
    const res = await resolve.computeScenario(pid, { id: U(99), name: 't', baseMetricIds: ids, drivers: model.sanitizeDrivers(drivers) }, opts);
    return new Map(res.metrics.map((m) => [m.metricId, m.value]));
  };

  // ── 2. the baseline never changes ─────────────────────────────────────────
  const before = new Map<string, number | null>();
  for (const id of ALL) before.set(id, (await metricsIpc.resolveMetric(pid, id))!.value);
  const rec = await store.saveScenario(pid, { name: 'Price +5%', baseMetricIds: ALL, drivers: [P('revenue', 5), P('revenue', -3, WEST), A('discount', 0)] });
  ok('store: a scenario saved', !!rec);
  if (!rec) return;
  const dsDir = path.join(tmp, 'projects', pid, 'datasets');
  const bytesOf = (): string => fs.readdirSync(dsDir).sort().map((f) => f + ':' + fs.readFileSync(path.join(dsDir, f)).toString('base64')).join('|');
  const dataBefore = bytesOf();
  const recBefore = JSON.stringify(await store.getScenario(pid, rec.id));
  const res = await resolve.computeScenario(pid, rec);
  ok('baseline: every baseline IS resolveMetric\'s figure (Object.is)', res.metrics.every((m) => Object.is(m.baseline, before.get(m.metricId))),
    JSON.stringify(res.metrics.map((m) => [m.name, m.baseline, before.get(m.metricId)])));
  ok('baseline: the scenario moved Revenue (so the check above is not vacuous)', res.metrics[0].value !== res.metrics[0].baseline);
  const after = new Map<string, number | null>();
  for (const id of ALL) after.set(id, (await metricsIpc.resolveMetric(pid, id))!.value);
  ok('baseline: resolveMetric is unchanged after computing a scenario', ALL.every((id) => Object.is(after.get(id), before.get(id))));
  ok('baseline: the record is not mutated', JSON.stringify(await store.getScenario(pid, rec.id)) === recBefore);
  ok('baseline: the stored dataset is byte-identical', bytesOf() === dataBefore);
  const none = await resolve.computeScenario(pid, { ...rec, drivers: [] });
  ok('baseline: no drivers ⇒ every scenario figure IS its baseline', none.metrics.every((m) => Object.is(m.value, m.baseline) && m.delta === 0));

  // ── 3. drivers ────────────────────────────────────────────────────────────
  let v = await run([P('revenue', 5)]);
  ok('sum: revenue +5% scales Revenue by 1.05', close(v.get(revenue), R * 1.05), `${v.get(revenue)} vs ${R * 1.05}`);
  ok('ratio: Margin recomputes from the moved operand', close(v.get(margin), PR / (R * 1.05)));
  ok('ratio: a formula over aggregates recomputes too', close(v.get(perUnit), (R * 1.05) / total('units')));
  ok('untouched: Profit and Units stay at their baseline', Object.is(v.get(profit), before.get(profit)) && Object.is(v.get(units), before.get(units)));

  v = await run([P('revenue', -3, WEST)]);
  const westR = total('revenue', isWest);
  ok('filtered: only the West\'s revenue moves', close(v.get(revenue), total('revenue', notWest) + westR * 0.97));
  ok('filtered ratio: West-only change flows into Margin', close(v.get(margin), PR / (total('revenue', notWest) + westR * 0.97)));

  v = await run([P('revenue', 10, EAST_OR_WEST), P('revenue', -50, WEST)]);
  const eastR = total('revenue', (r) => r[0] === 'East');
  ok('overlap: partitions are exact — West ×1.1×0.5, East ×1.1, the rest as is',
    close(v.get(revenue), total('revenue', (r) => r[0] === 'North' || r[0] === 'South') + eastR * 1.1 + westR * 1.1 * 0.5));

  const nW = numericCount('units', isWest);
  v = await run([A('units', 10, WEST), P('units', 10)]);
  ok('order: "units in West = 10" then "+10%" makes the West 11 a unit', close(v.get(units), total('units', notWest) * 1.1 + 11 * nW));
  v = await run([P('units', 10), A('units', 10, WEST)]);
  ok('order: reversed, the West is 10 a unit', close(v.get(units), total('units', notWest) * 1.1 + 10 * nW));
  ok('count: a value driver never changes a count', Object.is(v.get(rowsWithUnits), before.get(rowsWithUnits)));
  ok('abs: "units in West = 2" in a ratio', close((await run([A('units', 2, WEST)])).get(perUnit), R / (total('units', notWest) + 2 * nW)));

  v = await run([P('unit_price', 10, WEST)]);
  ok('avg: the moved sum over the unmoved count', close(v.get(avgPrice), (total('unit_price', notWest) + total('unit_price', isWest) * 1.1) / numericCount('unit_price')));
  v = await run([A('unit_price', 1000, WEST), P('unit_price', -100)]);
  ok('max/min: "= 1000 in the West" then "−100%" is 0 everywhere', v.get(maxPrice) === 0 && v.get(minPrice) === 0);
  v = await run([A('unit_price', 1000, WEST)]);
  ok('max: "= 1000 in the West" is the new max; min is the rest\'s', v.get(maxPrice) === 1000 && v.get(minPrice) === 10);
  ok('abs: discount = 0', (await run([A('discount', 0)])).get(discount) === 0);

  v = await run([{ kind: 'pct', target: { metricId: revenue }, value: -10 }]);
  ok('metric target: Revenue −10% is 0.9 × Revenue', close(v.get(revenue), R * 0.9));
  ok('metric target: [Revenue] in Margin reads the moved value', close(v.get(margin), PR / (R * 0.9)));
  ok('metric target: a formula over sum(revenue) is NOT a reference, so it stays', Object.is(v.get(perUnit), before.get(perUnit)));

  const east: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'East' }];
  const scoped = await resolve.computeScenario(pid, { ...rec, drivers: model.sanitizeDrivers([P('revenue', -3, WEST), P('profit', 20)]) }, { filters: east });
  const eastBase = (await metricsIpc.resolveMetric(pid, revenue, { filters: east }))!.value;
  ok('scope: the baseline is resolveMetric under the same filters', Object.is(scoped.metrics[0].baseline, eastBase));
  ok('scope: a West driver moves nothing under an East filter', close(scoped.metrics[0].value, eastR) && scoped.drivers[0].applied === false && scoped.drivers[1].applied === true);

  const withParam = { ...rec, drivers: model.sanitizeDrivers([{ ...P('revenue', 5), param: 'uplift' }]) };
  const card = await resolve.scenarioCardValue(pid, withParam, revenue, [], params.paramValues([{ name: 'uplift', kind: 'number', value: 20 }]));
  ok('param: a bound driver takes the dashboard parameter\'s current value', !!card && close(card.value, R * 1.2) && Object.is(card.baseline, before.get(revenue)));
  const cardPlain = await resolve.scenarioCardValue(pid, withParam, revenue, [], new Map());
  ok('param: without the parameter the stored value applies', !!cardPlain && close(cardPlain.value, R * 1.05));

  // ── 4. tornado ────────────────────────────────────────────────────────────
  const t = await resolve.computeScenario(pid, { ...rec, drivers: model.sanitizeDrivers([P('revenue', -3, WEST), P('revenue', 5), P('profit', 2)]) });
  const tor = t.tornado!;
  ok('tornado: drawn for the first metric', !!tor && tor.metricId === revenue && tor.bars.length === 3);
  const val = tor.value as number;
  ok('tornado: an additive metric swings symmetrically (±10%)', tor.bars.every((b) => close((b.high as number) - val, val - (b.low as number), 1e-9)),
    JSON.stringify(tor.bars.map((b) => [b.label, b.low, val, b.high])));
  ok('tornado: widest swing first — the unfiltered driver, then the West one, then the one that misses',
    tor.bars.map((b) => b.label).join(' | ') === 'revenue +5% | revenue in West −3% | profit +2%' && tor.bars[2].swing === 0);
  ok('tornado: the swing is 20% of what the driver\'s target contributes', close(tor.bars[0].swing, 0.2 * (total('revenue', notWest) + westR * 0.97) * 1.05));
  const focused = await resolve.computeScenario(pid, { ...rec, drivers: model.sanitizeDrivers([P('revenue', 5)]) }, { focusMetricId: margin });
  ok('tornado: the focus metric is selectable', focused.tornado?.metricId === margin && focused.tornado.bars.length === 1);
  const moved = await resolve.computeScenario(pid, { ...rec, baseMetricIds: [profit, revenue], drivers: model.sanitizeDrivers([P('revenue', 5)]) });
  ok('tornado: by default it shows the first metric the drivers move', moved.tornado?.metricId === revenue);

  // ── 5. differential ───────────────────────────────────────────────────────
  const src = await datasets.residentSource(pid, dsid);
  if (!src || !residentQuery.isResident()) {
    console.log('ok   no resident bridge here — the differential is skipped, the reference was asserted above');
  } else {
    const cases: Array<[string, FilterStep[], Array<FilterStep | null>]> = [
      ['revenue', [], [null]],
      ['revenue', [], [WEST]],
      ['units', [{ type: 'filter', column: 'region', op: '!=', value: 'North' }], [WEST, EAST_OR_WEST]],
      ['unit_price', [], [{ type: 'filter', column: 'units', op: '>', value: 5 }]],
      ['note', [], [{ type: 'filter', column: 'region', op: 'not in', values: ['West'] } as FilterStep]],
      ['revenue', [], [{ type: 'filter', column: 'missing', op: '=', value: 'x' }]],
      ['units', [], [{ type: 'filter', column: 'note', op: 'is_empty' }, WEST]],
      ['profit', [WEST], [{ type: 'filter', column: 'region', op: 'contains', value: 'st' }]],
      ['units', [{ type: 'filter', column: 'region', op: '=', value: 'Nowhere' }], [WEST]],
    ];
    for (const [c, scope, filters] of cases) {
      const js = inputsJs.scenarioInputsJs(COLUMNS, ROWS, c, scope, filters);
      const sql = await resident.scenarioInputsResident(src, c, scope, filters);
      const same = !!js && !!sql && js.length === sql.length && js.every((p, i) =>
        p.key.join() === sql[i].key.join()
        && (['sum', 'n', 'nonEmpty', 'min', 'max'] as const).every((k) => Object.is(p.pieces[k], sql[i].pieces[k])));
      ok(`differential: ${c} by ${filters.map((f) => (f ? f.column + ' ' + f.op : 'all')).join(', ')}${scope.length ? ' under a scope' : ''}`,
        same, JSON.stringify({ js, sql }));
    }
    ok('differential: an unknown column is null on both', inputsJs.scenarioInputsJs(COLUMNS, ROWS, 'nope', [], [WEST]) === null
      && await resident.scenarioInputsResident(src, 'nope', [], [WEST]) === null);
    hydrations = 0;
    const r0 = trace.snapshot().scenario ? trace.snapshot().scenario.resident : 0;
    await resolve.computeScenario(pid, { ...rec, drivers: model.sanitizeDrivers([P('revenue', 5), A('units', 1, WEST), P('unit_price', -2)]) });
    ok('differential: a resident scenario never hydrates the table (0 getDataset calls)', hydrations === 0, `${hydrations} hydration(s)`);
    ok('differential: the resident path answered (residentTrace)', (trace.snapshot().scenario?.resident || 0) > r0);
  }

  // ── 6. surfaces ───────────────────────────────────────────────────────────
  const b = await store.saveScenario(pid, { name: 'Volume −3%', baseMetricIds: [units, revenue], drivers: [P('units', -3)] });
  const cmp = await resolve.compareScenarios(pid, [rec, b!]);
  const solo = await resolve.computeScenario(pid, rec);
  ok('compare: rows are the union of the base metrics, in order', cmp.rows.length === ALL.length && cmp.rows[0].metricId === revenue && cmp.scenarios.length === 2);
  ok('compare: each column is that scenario\'s own figure (Object.is)', solo.metrics.every((m, i) => Object.is(cmp.rows[i].cells[0].value, m.value))
    && cmp.rows.every((r: any) => Object.is(r.baseline, before.get(r.metricId))));
  ok('compare: the second scenario moves Units, not Revenue', close(cmp.rows[3].cells[1].value, total('units') * 0.97) && Object.is(cmp.rows[0].cells[1].value, before.get(revenue)));

  const created = await handlers.get('scenario:create')!(null, { projectId: pid, input: { name: 'Via IPC', baseMetricIds: [revenue], drivers: [{ ...P('revenue', 5), name: 'stale' }, { kind: 'abs', target: { metricId: profit }, value: 0 }] } });
  ok('ipc: main names every driver in words on save', created.ok && created.scenario.drivers[0].name === 'revenue +5%' && created.scenario.drivers[1].name === 'Profit = 0', JSON.stringify(created));
  const viaCard = await handlers.get('scenario:card')!(null, { projectId: pid, scenarioId: rec.id, metricId: revenue, filters: [{ type: 'drop_column', column: 'revenue' }, WEST], params: [] });
  ok('ipc: the card sanitizes its filters and scopes both sides', viaCard.ok && Object.is(viaCard.baseline, (await metricsIpc.resolveMetric(pid, revenue, { filters: [WEST] }))!.value)
    && close(viaCard.value, westR * 1.05 * 0.97) && viaCard.scenarioName === 'Price +5%', JSON.stringify(viaCard));
  const targets = await handlers.get('scenario:targets')!(null, { projectId: pid, baseMetricIds: [margin, rowsWithUnits] });
  ok('ipc: targets walk formulas to their columns (a count offers no column); every metric involved is a target',
    targets.ok && targets.columns.map((c: any) => c.column).sort().join() === 'profit,revenue' && targets.metrics.length === 4 && targets.datasets.length === 1, JSON.stringify(targets));

  const facts = await copilot.buildFacts(pid, { kind: 'scenario', id: rec.id });
  ok('facts: the open scenario is the context', facts.text.includes('Scenario: "Price +5%"') && facts.text.includes('revenue in West −3%'), facts.text);
  ok('facts: baseline and scenario figures are in the ledger', facts.ledger.some((e) => Object.is(e.value, before.get(revenue))) && facts.ledger.some((e) => Object.is(e.value, solo.metrics[0].value)));
  const a = audit.auditNumbers(facts.text, facts.ledger);
  ok('facts: the block passes its own number audit', a.violations.length === 0, JSON.stringify(a.violations));

  ok('list: three scenarios, newest first, drivers named', (await store.listScenarios(pid)).length === 3);
  const upd = await store.updateScenario(pid, rec.id, { name: 'Renamed', drivers: [P('units', 1)] });
  ok('update: name and drivers replaced, base metrics kept', upd?.name === 'Renamed' && upd.drivers.length === 1 && upd.baseMetricIds.length === ALL.length);
  const dup = await store.duplicateScenario(pid, rec.id);
  ok('duplicate: a new id, "(copy)"', !!dup && dup.id !== rec.id && dup.name === 'Renamed (copy)');
  ok('delete', await store.deleteScenario(pid, dup ? dup.id : ''));
  ok('get: a non-UUID id never touches a path', (await store.getScenario(pid, '../x')) === null && (await store.saveScenario('../..', { name: 'x' })) === null);
  fs.writeFileSync(path.join(tmp, 'projects', pid, 'scenarios', U(7) + '.json'), '{ not json');
  ok('list: a corrupt file is skipped, never fatal', (await store.listScenarios(pid)).length === 3);
  const bundleSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'bundle.ts'), 'utf8');
  ok('bundle: scenarios travel in a project bundle', /\^scenarios\//.test(bundleSrc));
}

void (async () => {
  try {
    modelChecks();
    await resolverChecks();
  } catch (e: any) {
    ok('no exception', false, e && e.stack);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
  finish();
})();
