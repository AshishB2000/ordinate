// DIFFERENTIAL self-check for distance: the haversine SQL (engine/geoSql.ts)
// against the JS haversine, and the `within_km` radius filter's resident SQL
// (residentQuery.filterPredicate → geoSql) against the JS fold
// (transforms.stepFilter) over the SAME stored bytes — same rows, same order,
// and Object.is-identical metrics computed through the filter.
//
// The one KNOWN DIVERGENCE, pinned here: DuckDB's sin/cos/asin (platform libm)
// and V8's differ in the last bit on a few percent of inputs, so a distance can
// differ by ~1e-12 km. The rows agree because no fixture point sits within a
// nanometre of a radius — which no real coordinate does either.
//
//   npm run build:ts && node scripts/test-geoRadius.js

export {}; // module scope — sibling test scripts share top-level names
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as rq from '../src/engine/residentQuery';
import * as pq from '../src/engine/parquetStore';
import * as duck from '../src/engine/duckdb';
import * as metricValue from '../src/analysis/metricValue';
import { applyPipeline, sanitizeSteps } from '../src/data/transforms';
import { runResidentPipeline } from '../src/engine/pipelineDuck';
import { sqlBind, sqlHaversine } from '../src/engine/geoSql';
import { haversineKm } from '../src/analysis/geo/haversine';
import { controlSteps } from '../src/analysis/dashboardFilters';
import { radiusText, sanitizeRadiusValue } from '../src/analysis/geo/radius';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep } from '../src/data/transforms';
import { ok, failureCount } from './selfcheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-georadius-'));
const cleanup = (): void => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };

let seed = 11;
const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const COLS: ParsedColumn[] = [
  { name: 'id', type: 'number' },
  { name: 'lat', type: 'number' },
  { name: 'lng', type: 'number' },
  { name: 'amount', type: 'number' },
  { name: 'tlat', type: 'text' },
];
const CITIES: Array<[number, number]> = [[30.2672, -97.7431], [32.7767, -96.797], [29.7604, -95.3698], [39.7392, -104.9903]];
const ROWS: Cell[][] = [];
for (let i = 0; i < 4000; i += 1) {
  const [la, lo] = CITIES[i % 4];
  const lat = la + (rand() - 0.5) * 1.2;
  const lng = lo + (rand() - 0.5) * 1.2;
  ROWS.push([i, lat, lng, Math.floor(rand() * 500), String(lat)]);
}
// The cells a radius must never keep.
ROWS.push([4000, null, -97.7, 5, null], [4001, 30.2, null, 5, ''], [4002, 95, -97.7, 5, '95'], [4003, 30.2, -190, 5, 'x']);

const file = path.join(dir, 'points.parquet');
pq.writeTable(file, COLS, ROWS);
const back = pq.readTable(file, COLS);
if (!back) throw new Error('fixture read-back failed');
const src: rq.ResidentSource = { parquetPath: file, columns: COLS };

function jsIds(filters: FilterStep[]): string {
  return JSON.stringify(applyPipeline({ columns: back!.columns, rows: back!.rows }, filters).rows.map((r) => r[0]));
}
function sqlIds(filters: FilterStep[]): string {
  const params: duck.DuckValue[] = [];
  const preds = rq.filterPredicates(COLS, filters, params);
  const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
  const rows = duck.query(`SELECT CAST(c0 AS DOUBLE) AS id FROM ${pq.relationSql(file, { fileRowNumber: true })}${where} ORDER BY file_row_number;`, params);
  return JSON.stringify(rows.map((r) => r.id));
}

function radius(lat: number, lng: number, km: number, latCol = 'lat', lngCol = 'lng'): FilterStep {
  return { type: 'filter', column: latCol, op: 'within_km', radius: { lngColumn: lngCol, lat, lng, km } };
}

async function diff(label: string, filters: FilterStep[], expectSome = true): Promise<void> {
  const want = jsIds(filters);
  const got = sqlIds(filters);
  const n = (JSON.parse(want) as unknown[]).length;
  ok(`${label}: resident rows === fold rows (${n} rows)`, want === got && (!expectSome || n > 0), `fold ${want.slice(0, 200)}\n     sql  ${got.slice(0, 200)}`);
  const rows = applyPipeline({ columns: back!.columns, rows: back!.rows }, filters).rows;
  for (const aggregation of ['sum', 'count', 'avg'] as metricValue.MetricAggregation[]) {
    const w = metricValue.computeMetric(back!.columns, rows, { column: 'amount', aggregation });
    const g = await rq.computeMetricResident(src, { column: 'amount', aggregation }, filters);
    ok(`${label}: ${aggregation}(amount) resident === JS (${w})`, Object.is(w, g), `resident ${g}`);
  }
}

async function main(): Promise<void> {
  if (!rq.isResident()) {
    console.error('FAIL geoRadius: DuckDB bridge unavailable — nothing was verified');
    process.exit(1);
  }

  // ── The haversine, SQL vs JS ──────────────────────────────────────────────
  {
    const pairs: number[][] = [];
    for (let i = 0; i < 2000; i += 1) {
      pairs.push([(rand() * 2 - 1) * 89, (rand() * 2 - 1) * 179, (rand() * 2 - 1) * 89, (rand() * 2 - 1) * 179]);
    }
    pairs.push([30.2672, -97.7431, 30.2672, -97.7431], [0, 0, 0, 180], [33.9425, -118.4081, 40.6397, -73.7789]);
    const params: duck.DuckValue[] = [];
    const cols = [0, 1, 2, 3].map((k) => `CAST(string_split(v, ',')[${k + 1}] AS DOUBLE)`);
    const expr = sqlHaversine(() => cols[0], () => cols[1], () => cols[2], () => cols[3], params);
    const text = pairs.map((p) => p.join(',')).join(';');
    params.push(text); // the FROM clause comes after the expression
    const rows = duck.query(`SELECT ${expr} AS d FROM (SELECT unnest(string_split(?, ';')) AS v)`, params);
    let worst = 0;
    let exact = 0;
    rows.forEach((r, i) => {
      const js = haversineKm(pairs[i][0], pairs[i][1], pairs[i][2], pairs[i][3]);
      const d = Math.abs((r.d as number) - js);
      if (d === 0) exact += 1;
      worst = Math.max(worst, d);
    });
    ok(`haversine SQL vs JS: ${exact}/${rows.length} bit-identical, worst ${worst.toExponential(2)} km — KNOWN libm divergence, bounded by 1e-9 km`,
      rows.length === pairs.length && worst <= 1e-9);
    ok('haversine SQL: zero to itself', rows[pairs.length - 3].d === 0);
    // Bound in text order — sqlBind pushes as the expression is spelled.
    const p2: duck.DuckValue[] = [];
    const e2 = sqlHaversine(sqlBind(p2, 51.5074), sqlBind(p2, -0.1278), sqlBind(p2, 48.8566), sqlBind(p2, 2.3522), p2);
    const lp = duck.query(`SELECT ${e2} AS d`, p2)[0].d as number;
    ok(`haversine SQL with every argument bound (London → Paris ${lp.toFixed(6)} km)`,
      Math.abs(lp - haversineKm(51.5074, -0.1278, 48.8566, 2.3522)) <= 1e-9);
  }

  // ── The radius filter ─────────────────────────────────────────────────────
  await diff('25 km of Austin', [radius(30.2672, -97.7431, 25)]);
  await diff('100 km of Dallas', [radius(32.7767, -96.797, 100)]);
  await diff('0.8 km of a point (very few rows)', [radius(30.2672, -97.7431, 0.8)], false);
  await diff('500 km of Denver', [radius(39.7392, -104.9903, 500)]);
  await diff('the whole Earth keeps every coordinate row', [radius(0, 0, 20_016)]);
  await diff('radius AND a value filter', [radius(29.7604, -95.3698, 60), { type: 'filter', column: 'amount', op: '>', value: 250 }]);
  await diff('a TEXT-declared latitude matches nothing (never cast)', [radius(30.2672, -97.7431, 25, 'tlat')], false);
  {
    const all = jsIds([]);
    ok('an unknown longitude column: the fold skips the step (every row)', jsIds([radius(30, -97, 25, 'lat', 'nope')]) === all);
    ok('…and the SQL applies nothing, so the rows agree', sqlIds([radius(30, -97, 25, 'lat', 'nope')]) === all);
    const warn = applyPipeline({ columns: back!.columns, rows: back!.rows }, [radius(30, -97, 25, 'lat', 'nope')]).warnings;
    ok('…with a warning that names the column', warn.some((w) => /unknown column "nope"/.test(w)), warn.join(' | '));
  }
  ok('the prepare-pipeline SQL declines a radius filter (the fold runs it)', runResidentPipeline(file, COLS, [radius(30.2672, -97.7431, 25)]) === null);

  // ── Sanitising and the dashboard control ─────────────────────────────────
  ok('sanitizeSteps keeps a well-formed within_km step', sanitizeSteps([radius(30, -97, 25)]).length === 1);
  ok('…drops one with no radius, a zero radius or an off-globe centre',
    sanitizeSteps([{ type: 'filter', column: 'lat', op: 'within_km' }, radius(30, -97, 0), radius(95, -97, 5)]).length === 0);
  const value = sanitizeRadiusValue({ place: 'Austin, TX', lat: 30.2672, lng: -97.7431, km: 25 });
  ok('a radius control value reads "within 25 km of Austin, TX"', !!value && value.value === 'within 25 km of Austin, TX');
  const steps = controlSteps({ kind: 'radius', column: 'lat', lngColumn: 'lng' }, value as any); // any: the ControlValue union member
  ok('a radius control becomes ONE within_km step on its two columns',
    steps.length === 1 && steps[0].op === 'within_km' && steps[0].column === 'lat' && !!steps[0].radius && steps[0].radius.lngColumn === 'lng');
  ok('…which filters exactly as the step built by hand', jsIds(steps) === jsIds([radius(30.2672, -97.7431, 25)]));
  ok('an unset radius control filters nothing', controlSteps({ kind: 'radius', column: 'lat', lngColumn: 'lng' }, { value: '' } as any).length === 0);
  ok('radiusText names the centre by coordinates when there is no place', radiusText({ lngColumn: 'x', lat: 1, lng: 2, km: 2.5 }) === 'within 2.5 km of 1.000, 2.000');
}

main()
  .finally(cleanup)
  .then(() => {
    if (failureCount()) {
      console.error(`\n${failureCount()} geoRadius check(s) FAILED.`);
      process.exit(1);
    }
    console.log('\nAll geoRadius checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
