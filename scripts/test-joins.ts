// Self-check for relationships: key suggestion, path finding, and the join
// itself — engine/joinResident.ts held to `Object.is` agreement with the JS
// reference in analysis/joinJs.ts over the SAME Parquet bytes.
//
//   npm run build:ts && node scripts/test-joins.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pqSync from '../src/engine/parquetStoreSync';
import * as duck from '../src/engine/duckdb';
import * as jr from '../src/engine/joinResident';
import * as js from '../src/analysis/joinJs';
import * as jp from '../src/analysis/joinPlan';
import * as ks from '../src/analysis/keySuggest';
import type { Relationship } from '../src/analysis/relationships';
import { sanitizeRelationship } from '../src/analysis/relationships';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep, TableData } from '../src/data/transforms';
import type { VizEncoding } from '../src/analysis/visuals';
import { ok, failureCount } from './selfcheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-joins-'));
let seq = 0;

interface Fx { id: string; name: string; file: string; columns: ParsedColumn[]; rows: Cell[][] }

function fx(id: string, name: string, columns: ParsedColumn[], rows: Cell[][]): Fx {
  const file = path.join(dir, `t${seq++}.parquet`);
  pqSync.writeTable(file, columns, rows);
  const back = pqSync.readTable(file, columns);
  if (!back) throw new Error('fixture read-back failed');
  return { id, name, file, columns: back.columns, rows: back.rows };
}

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REGIONS = ['East', 'West', 'North', 'South', 'Nowhere', '', null];
const CATS = ['Tech', 'Office', 'Furniture'];

const orderRows: Cell[][] = [];
for (let i = 0; i < 60; i++) {
  orderRows.push([`o${i}`, REGIONS[i % REGIONS.length], CATS[i % 3], (i * 7) % 50, i % 4]);
}
const orders = fx(ID(1), 'Orders', [
  { name: 'order_id', type: 'text' }, { name: 'region', type: 'text' }, { name: 'category', type: 'text' },
  { name: 'revenue', type: 'number' }, { name: 'units', type: 'number' },
], orderRows);
// East appears TWICE: the first row (100) is the one every hop must take.
const targets = fx(ID(2), 'Targets', [
  { name: 'Region', type: 'text' }, { name: 'target', type: 'number' }, { name: 'tier', type: 'text' },
], [['East', 100, 'A'], ['West', 200, 'B'], ['North', 50, 'A'], ['South', null, 'C'], ['East', 999, 'Z']]);
const tiers = fx(ID(3), 'Tiers', [{ name: 'tier', type: 'text' }, { name: 'bonus', type: 'number' }],
  [['A', 10], ['B', 20]]);
const returns = fx(ID(4), 'Returns', [{ name: 'order_id', type: 'text' }, { name: 'refund', type: 'number' }],
  [['o1', 5], ['o1', 6], ['o2', 7]]);
const lonely = fx(ID(5), 'Lonely', [{ name: 'x', type: 'text' }], [['a']]);

const ALL = [orders, targets, tiers, returns, lonely];
const infos = new Map<string, jp.DsInfo>(ALL.map((f) => [f.id, { id: f.id, name: f.name, columns: f.columns }]));
const tables = new Map<string, TableData>(ALL.map((f) => [f.id, { columns: f.columns, rows: f.rows }]));
const sourceOf = (id: string): jr.JoinSource => {
  const f = ALL.find((x) => x.id === id) as Fx;
  return { datasetId: id, parquetPath: f.file, columns: f.columns };
};
const nameOf = (id: string): string => infos.get(id)?.name || id;

const rel = (n: number, from: [Fx, string], to: [Fx, string], cardinality = 'many_to_one'): Relationship =>
  sanitizeRelationship({ id: ID(100 + n), from: { datasetId: from[0].id, column: from[1] },
    to: { datasetId: to[0].id, column: to[1] }, cardinality }) as Relationship;
const RELS: Relationship[] = [
  rel(1, [orders, 'region'], [targets, 'Region']),
  rel(2, [targets, 'tier'], [tiers, 'tier']),
  rel(3, [returns, 'order_id'], [orders, 'order_id']),
];

async function main(): Promise<void> {
  // ── Sanitize ────────────────────────────────────────────────────────────────
  ok('sanitize: a self-join is refused', sanitizeRelationship({ from: { datasetId: ID(1), column: 'a' }, to: { datasetId: ID(1), column: 'b' } }) === null);
  ok('sanitize: a non-UUID dataset is refused', sanitizeRelationship({ from: { datasetId: '../x', column: 'a' }, to: { datasetId: ID(2), column: 'b' } }) === null);
  ok('sanitize: an unknown cardinality becomes many_to_one', RELS[0].cardinality === 'many_to_one'
    && sanitizeRelationship({ from: { datasetId: ID(1), column: 'a' }, to: { datasetId: ID(2), column: 'b' }, cardinality: 'many_to_many' })?.cardinality === 'many_to_one');

  // ── Key suggestion ──────────────────────────────────────────────────────────
  ok('name: case, underscores and a trailing id normalise away', ks.nameSimilarity('Customer ID', 'customer_id') === 1);
  ok('name: region ~ Region is exact', ks.nameSimilarity('region', 'Region') === 1);
  ok('name: unrelated headers score low', ks.nameSimilarity('revenue', 'tier') < 0.3);
  ok('name: containment floors at 0.8', ks.nameSimilarity('zip', 'zipcode') >= 0.8);

  const fi = (f: Fx, c: string): number => f.columns.findIndex((x) => x.name === c);
  const jsRate = (fc: string, tc: string): number | null =>
    js.joinRateJs(orders.rows.map((r) => r[fi(orders, fc)]), orders.columns[fi(orders, fc)].type,
      targets.rows.map((r) => r[fi(targets, tc)]), targets.columns[fi(targets, tc)].type, ks.RATE_SAMPLE);
  const sqlRate = (fc: string, tc: string): Promise<number | null> =>
    jr.joinRateResident({ parquetPath: orders.file, index: fi(orders, fc), type: orders.columns[fi(orders, fc)].type },
      { parquetPath: targets.file, index: fi(targets, tc), type: targets.columns[fi(targets, tc)].type }, ks.RATE_SAMPLE);
  const rankedJs = await ks.rankKeys(orders.columns, targets.columns, jsRate);
  const rankedSql = await ks.rankKeys(orders.columns, targets.columns, sqlRate);
  ok('rank: region → Region is the top suggestion', rankedJs[0].from === 'region' && rankedJs[0].to === 'Region', JSON.stringify(rankedJs[0]));
  // 60 rows, 5/7 keyed; 3 of those 5 region values exist in Targets.
  // 60 rows: 44 carry a region key, 36 of those exist in Targets.
  ok('rank: its sampled match rate is 36/44 of keyed rows', rankedJs[0].rate === 36 / 44, String(rankedJs[0].rate));
  ok('rank: SQL and JS rankings agree pair for pair', JSON.stringify(rankedJs) === JSON.stringify(rankedSql));
  for (const c of rankedJs.slice(0, 5)) {
    ok(`rate: ${c.from}→${c.to} SQL === JS (${c.rate})`, Object.is(await sqlRate(c.from, c.to), jsRate(c.from, c.to)));
  }
  ok('rank: a sample of 1 row counts only that row', Object.is(
    js.joinRateJs(['East', 'Nope'], 'text', ['East'], 'text', 1), 1));

  const stJs = js.keyStatsJs(orders.rows.map((r) => r[1]), 'text', targets.rows.map((r) => r[0]), 'text');
  const stSql = await jr.keyStatsResident({ parquetPath: orders.file, index: 1, type: 'text' }, { parquetPath: targets.file, index: 0, type: 'text' });
  ok('stats: SQL === JS', JSON.stringify(stJs) === JSON.stringify(stSql), JSON.stringify([stJs, stSql]));
  ok('stats: empty and unknown keys are unmatched', stJs.unmatchedFrom === 60 - stJs.matched && stJs.matched === 36, JSON.stringify(stJs));
  ok('stats: Targets repeats a key, so no cardinality is inferred', ks.inferCardinality(stJs) === null);
  ok('stats: unique keys both sides → one_to_one', ks.inferCardinality({ fromKeys: 3, fromKeyed: 3, toKeys: 3, toKeyed: 3 }) === 'one_to_one');
  ok('stats: repeated FROM keys → many_to_one', ks.inferCardinality({ fromKeys: 2, fromKeyed: 3, toKeys: 3, toKeyed: 3 }) === 'many_to_one');

  // ── Path finding ────────────────────────────────────────────────────────────
  const reach = jp.reachable(orders.id, RELS);
  ok('reach: Targets then Tiers, breadth-first', [...reach.keys()].join() === [targets.id, tiers.id].join());
  ok('reach: Tiers is two hops away', (reach.get(tiers.id) || []).length === 2);
  const refused = jp.findPath(orders.id, returns.id, RELS, nameOf);
  ok('path: Returns is REFUSED — Orders is on its one side', !refused.ok && /many side/.test(refused.ok ? '' : refused.error), JSON.stringify(refused));
  const unrelated = jp.findPath(orders.id, lonely.id, RELS, nameOf);
  ok('path: an unrelated dataset says so', !unrelated.ok && /not related/.test(unrelated.ok ? '' : unrelated.error));
  ok('path: from Returns, Orders AND Targets are reachable', jp.reachable(returns.id, RELS).has(targets.id));
  const oneToOne = [rel(9, [targets, 'tier'], [tiers, 'tier'], 'one_to_one')];
  ok('path: a one_to_one walks both ways', jp.reachable(tiers.id, oneToOne).has(targets.id));
  const viaRefused = jp.resolveVizJoin(orders.id,
    { category: 'region', values: [{ column: 'refund', aggregation: 'sum', datasetId: returns.id }] }, [], RELS, infos);
  ok('plan: a measure behind a refused hop is an error, never a silent fallback', !!viaRefused && !viaRefused.ok);
  ok('plan: nothing related → no join at all', jp.resolveVizJoin(orders.id,
    { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, [], RELS, infos) === null);

  // ── The join: SQL === JS ────────────────────────────────────────────────────
  const cases: { label: string; enc: VizEncoding; filters?: FilterStep[] }[] = [
    { label: 'sum(revenue) + sum(target) by region', enc: { category: 'region', values: [
      { column: 'revenue', aggregation: 'sum' }, { column: 'target', aggregation: 'sum', datasetId: targets.id }] } },
    { label: 'every aggregation of target by category', enc: { category: 'category', values: (['sum', 'avg', 'count', 'min', 'max'] as const)
      .map((a) => ({ column: 'target', aggregation: a, datasetId: targets.id })) } },
    { label: 'category from the related table (tier)', enc: { category: 'tier', categoryDatasetId: targets.id,
      values: [{ column: 'revenue', aggregation: 'sum' }, { column: 'units', aggregation: 'count' }] } },
    { label: 'two hops: bonus by category', enc: { category: 'category', values: [
      { column: 'bonus', aggregation: 'sum', datasetId: tiers.id }, { column: 'revenue', aggregation: 'avg' }] } },
    { label: 'a filter on a related column resolves through the join', enc: { category: 'category',
      values: [{ column: 'revenue', aggregation: 'sum' }] }, filters: [{ type: 'filter', column: 'tier', op: '=', value: 'A' }] },
    { label: 'filters on both sides', enc: { category: 'region', values: [{ column: 'target', aggregation: 'max', datasetId: targets.id }] },
      filters: [{ type: 'filter', column: 'units', op: '>', value: 0 }, { type: 'filter', column: 'bonus', op: 'not_empty' }] },
    { label: 'a numeric category bins over the join', enc: { category: 'target', categoryDatasetId: targets.id,
      values: [{ column: 'revenue', aggregation: 'sum' }] } },
  ];
  for (const c of cases) {
    const j = jp.resolveVizJoin(orders.id, c.enc, c.filters || [], RELS, infos);
    if (!j || !j.ok) { ok(`${c.label}: plans`, false, JSON.stringify(j)); continue; }
    const want = js.joinedVizDataJs(j.value, tables, infos);
    const got = await jr.joinedAggregateResident(j.value.plan.tables.map((t) => sourceOf(t.datasetId)), j.value, infos);
    ok(`${c.label}: resident path answers`, got !== null);
    if (!got) continue;
    ok(`${c.label}: labels SQL === JS`, JSON.stringify(got.data.labels) === JSON.stringify(want.data.labels),
      JSON.stringify([got.data.labels, want.data.labels]));
    const same = want.data.series.every((s, i) => got.data.series[i]?.name === s.name
      && s.values.every((v, k) => Object.is(v, got.data.series[i].values[k])));
    ok(`${c.label}: every value SQL === JS (Object.is)`, same, JSON.stringify([got.data.series, want.data.series]));
    ok(`${c.label}: the reference raised no warning`, want.warnings.length === 0, want.warnings.join('; '));
  }

  // The no-fan-in rule, stated without the reference: East's target is 100 —
  // its FIRST Targets row — not 100 × the number of East orders.
  const j0 = jp.resolveVizJoin(orders.id, cases[0].enc, [], RELS, infos);
  if (j0 && j0.ok) {
    const r = js.joinedVizDataJs(j0.value, tables, infos);
    const east = r.data.labels.indexOf('East');
    ok('no fan-in: sum of target for East is 100, once', r.data.series[1].values[east] === 100, JSON.stringify(r.data));
    const nowhere = r.data.labels.indexOf('Nowhere');
    ok('no match: Nowhere has revenue but a null target', typeof r.data.series[0].values[nowhere] === 'number' && r.data.series[1].values[nowhere] === null);
    ok('series names say where a measure came from', r.data.series[1].name === 'sum of Targets.target', r.data.series[1].name);
  }
  ok('primary rows never repeat: the joined table has exactly the primary row count',
    j0 !== null && j0.ok && js.joinTables(j0.value.plan, j0.value.layout, tables, infos).rows.length === orders.rows.length);

  // ── A metric across two datasets ────────────────────────────────────────────
  const plan = jp.planTables(orders.id, [targets.id], RELS);
  if (plan.ok) {
    const layout = jp.mergedLayout(plan.value, infos);
    const flt: FilterStep[] = [{ type: 'filter', column: 'category', op: '=', value: 'Tech' }];
    for (const agg of ['sum', 'avg', 'count', 'min', 'max'] as const) {
      const spec = { column: 'Targets.target', aggregation: agg };
      const want = js.joinedMetricJs(plan.value, layout, tables, infos, { ...spec, table: 1 }, flt);
      const got = await jr.joinedMetricResident([sourceOf(orders.id), sourceOf(targets.id)], plan.value, layout, infos, spec, flt);
      ok(`metric: ${agg}(Targets.target) where category = Tech — SQL === JS (${want})`, Object.is(want, got));
    }
    const all = js.joinedMetricJs(plan.value, layout, tables, infos, { column: 'Targets.target', aggregation: 'sum', table: 1 }, []);
    ok('metric: sum of target over all orders counts each region once (100+200+50)', all === 350, String(all));
    const rev = js.joinedMetricJs(plan.value, layout, tables, infos, { column: 'revenue', aggregation: 'sum', table: 0 },
      [{ type: 'filter', column: 'Targets.tier', op: '=', value: 'A' }]);
    const revSql = await jr.joinedMetricResident([sourceOf(orders.id), sourceOf(targets.id)], plan.value, layout, infos,
      { column: 'revenue', aggregation: 'sum' }, [{ type: 'filter', column: 'Targets.tier', op: '=', value: 'A' }]);
    ok('metric: revenue filtered by a related tier — SQL === JS', Object.is(rev, revSql), JSON.stringify([rev, revSql]));
  } else {
    ok('metric: plans', false);
  }

  duck.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failureCount() ? `\n${failureCount()} join check(s) FAILED.` : '\nAll join checks passed.');
  process.exit(failureCount() ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
