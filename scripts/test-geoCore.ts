// Self-check for the pure geo core (src/analysis/geo/): Web Mercator, the hex
// grid (assignment, edge and vertex points, the documented tie-break), the
// haversine (known distances with THIS module's radius, identities), point in
// polygon (holes, multipolygons, shared edges) and its bbox grid index, the
// `distance_km` formula function, and the spatial_join step through the fold.
//
//   npm run build:ts && node scripts/test-geoCore.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as merc from '../src/analysis/geo/mercator';
import * as hex from '../src/analysis/geo/hexgrid';
import { EARTH_RADIUS_KM, haversineKm, validCoord } from '../src/analysis/geo/haversine';
import { buildBoundaryIndex, locate, locateScan, pointInPolygon } from '../src/analysis/geo/pip';
import { compile } from '../src/formula/formula';
import { FUNCTION_DOCS } from '../src/formula/formulaDocs';
import { applyPipeline, sanitizeSteps } from '../src/data/transforms';
import type { Cell, TransformStep } from '../src/data/transforms';
import type { ParsedColumn } from '../src/data/parse';
import { bundledIndex } from '../src/data/spatialRefs';
import { checkSpatialJoin, spatialStats } from '../src/analysis/geo/spatialJoin';
import { flowArc, ARC_POINTS } from '../src/analysis/geo/flowArc';
import { generateSql } from '../src/engine/sqlGen';
import { matchPlace, resolvePlace } from '../src/analysis/places';

// A seeded generator — every run tests the same points.
let seed = 7;
const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// ── Mercator ────────────────────────────────────────────────────────────────
ok('mercX spans the world: -180 → 0, 180 → 1', merc.mercX(-180) === 0 && merc.mercX(180) === 1);
ok('mercY(0) is the equator, 0.5', merc.mercY(0) === 0.5);
ok('mercY(MAX_LAT) is the top edge (≈0)', Math.abs(merc.mercY(merc.MAX_LAT)) < 1e-9);
{
  let worst = 0;
  for (let i = 0; i < 1000; i += 1) {
    const lat = (rand() * 2 - 1) * 85;
    worst = Math.max(worst, Math.abs(merc.latOfY(merc.mercY(lat)) - lat));
  }
  ok(`latOfY inverts mercY (worst ${worst.toExponential(1)}°)`, worst < 1e-9);
}
ok('onMercator excludes the poles and NaN', !merc.onMercator(89, 0) && !merc.onMercator(null, 0) && merc.onMercator(85, 180));

// ── Hex grid ────────────────────────────────────────────────────────────────
ok('resolutions: zoom → level buckets', [[0, 0], [0.9, 0], [1, 1], [2.9, 1], [3, 2], [14, 7], [20, 7], [-3, 0]]
  .every(([z, r]) => hex.resForZoom(z) === r), [0, 1, 3, 14, 20].map(hex.resForZoom).join(','));
ok('each level is 4× finer than the last', hex.HEX_SIZES.every((s, k) => k === 0 || Math.abs(hex.HEX_SIZES[k - 1] / s - 4) < 1e-12));
ok('hex id is "res:q:r"', hex.hexId(3, -2, 5) === '3:-2:5');

{
  // A centre always maps back to its own hexagon.
  let bad = 0;
  for (let res = 0; res < hex.HEX_LEVELS; res += 1) {
    for (let i = 0; i < 200; i += 1) {
      const q = Math.floor(rand() * 40) - 20 + (res * 3);
      const r = Math.floor(rand() * 40) - 20;
      const c = hex.hexCenterWorld(res, q, r);
      const h = hex.hexOfWorld(c.x, c.y, res);
      if (h.q !== q || h.r !== r) bad += 1;
    }
  }
  ok('a hexagon centre is assigned to its own hexagon (1,600 cases)', bad === 0, `${bad} wrong`);
}
{
  // Any point lands in the hexagon whose centre is nearest (flat-top cells are Voronoi cells of their centres).
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
  let bad = 0;
  for (let i = 0; i < 5000; i += 1) {
    const res = Math.floor(rand() * hex.HEX_LEVELS);
    const x = rand();
    const y = rand();
    const h = hex.hexOfWorld(x, y, res);
    const own = hex.hexCenterWorld(res, h.q, h.r);
    const d0 = Math.hypot(x - own.x, y - own.y);
    for (const [dq, dr] of NB) {
      const c = hex.hexCenterWorld(res, h.q + dq, h.r + dr);
      if (Math.hypot(x - c.x, y - c.y) < d0 - 1e-12 * hex.HEX_SIZES[res]) { bad += 1; break; }
    }
    if (d0 > hex.HEX_SIZES[res] * (1 + 1e-9)) bad += 1;
  }
  ok('every point goes to its nearest hexagon centre, within one circumradius (5,000 points)', bad === 0, `${bad} wrong`);
}
{
  // The documented tie-break, on exact halves in cube space.
  const a = hex.cubeRound(0.5, 0);
  const b = hex.cubeRound(-0.5, 0);
  ok('edge tie: qf = 0.5 rounds UP to q = 1 (floor(v + 0.5))', a.q === 1 && a.r === 0, JSON.stringify(a));
  ok('edge tie: qf = -0.5 rounds up to q = 0', b.q === 0 && b.r === 0, JSON.stringify(b));
  const c = hex.cubeRound(0, 0.5);
  ok('edge tie on r: rf = 0.5 → r = 1', c.q === 0 && c.r === 1, JSON.stringify(c));
  const v = hex.cubeRound(1 / 3, 1 / 3);
  const three = ['0:0', '1:0', '0:1'];
  ok('a vertex (equidistant from three hexagons) lands in exactly one of them', three.includes(`${v.q}:${v.r}`), JSON.stringify(v));
  ok('…and always the same one', JSON.stringify(hex.cubeRound(1 / 3, 1 / 3)) === JSON.stringify(v));
  ok('no -0 in a hex coordinate', !Object.is(hex.cubeRound(-0.2, 0.1).q, -0) && !Object.is(hex.cubeRound(0.1, -0.2).r, -0));
  // A world point exactly on the edge between two neighbours: assigned to one of them, deterministically.
  let bad = 0;
  for (let i = 0; i < 300; i += 1) {
    const res = 3;
    const q = Math.floor(rand() * 20);
    const r = Math.floor(rand() * 20);
    const A = hex.hexCenterWorld(res, q, r);
    const B = hex.hexCenterWorld(res, q + 1, r);
    const m = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const h1 = hex.hexOfWorld(m.x, m.y, res);
    const h2 = hex.hexOfWorld(m.x, m.y, res);
    const either = (h1.q === q && h1.r === r) || (h1.q === q + 1 && h1.r === r);
    if (!either || h1.q !== h2.q || h1.r !== h2.r) bad += 1;
  }
  ok('an edge midpoint goes to one of its two hexagons, the same one every time', bad === 0, `${bad} wrong`);
}
{
  const ring = hex.hexRing(4, 3, -2);
  const c = hex.hexCenterWorld(4, 3, -2);
  const ok6 = ring.length === 12 && [0, 1, 2, 3, 4, 5].every((i) => {
    const x = merc.mercX(ring[i * 2]);
    const y = merc.mercY(ring[i * 2 + 1]);
    return Math.abs(Math.hypot(x - c.x, y - c.y) - hex.HEX_SIZES[4]) < hex.HEX_SIZES[4] * 1e-3;
  });
  ok('hexRing: six corners, flat [lng, lat, …], one circumradius from the centre', ok6);
}

// ── Haversine ───────────────────────────────────────────────────────────────
// An INDEPENDENT great-circle formula (the spherical Vincenty form, atan2 of the
// chord components) with the same radius — so each known distance below is
// recomputed, not copied from a source that used another Earth.
function vincentySphere(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * merc.DEG;
  const p2 = lat2 * merc.DEG;
  const dl = (lon2 - lon1) * merc.DEG;
  const y = Math.hypot(Math.cos(p2) * Math.sin(dl), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  const x = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return EARTH_RADIUS_KM * Math.atan2(y, x);
}
ok('the Earth radius is the IUGG mean radius, 6371.0088 km', EARTH_RADIUS_KM === 6371.0088);
{
  const lax = haversineKm(33.9425, -118.4081, 40.6397, -73.7789);
  const ref = vincentySphere(33.9425, -118.4081, 40.6397, -73.7789);
  ok(`LAX → JFK = ${lax.toFixed(6)} km, matching the independent formula to 1e-6`, Math.abs(lax - ref) < 1e-6 && lax > 3970 && lax < 3980, ref);
  const lp = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
  const lpRef = vincentySphere(51.5074, -0.1278, 48.8566, 2.3522);
  ok(`London → Paris = ${lp.toFixed(6)} km, matching to 1e-6`, Math.abs(lp - lpRef) < 1e-6 && lp > 340 && lp < 347, lpRef);
  const short = haversineKm(30.2672, -97.7431, 30.2682, -97.7431);
  ok(`0.001° of latitude = ${short.toFixed(9)} km (R·π/180/1000)`, Math.abs(short - EARTH_RADIUS_KM * Math.PI / 180 / 1000) < 1e-9);
}
ok('zero distance to itself', haversineKm(30.27, -97.74, 30.27, -97.74) === 0);
ok('antipodes are π·R apart (equator)', Math.abs(haversineKm(0, 0, 0, 180) - Math.PI * EARTH_RADIUS_KM) < 1e-9);
// Off the equator the haversine is ill-conditioned at the antipodes (asin near
// π/2 turns a 1e-16 error in `a` into ~1e-8 rad), so this one is held to a metre.
ok('antipodes are π·R apart (off the equator, to 1 m)', Math.abs(haversineKm(40, -105, -40, 75) - Math.PI * EARTH_RADIUS_KM) < 1e-3);
{
  let asym = 0;
  for (let i = 0; i < 2000; i += 1) {
    const a = [(rand() * 2 - 1) * 90, (rand() * 2 - 1) * 180];
    const b = [(rand() * 2 - 1) * 90, (rand() * 2 - 1) * 180];
    if (!Object.is(haversineKm(a[0], a[1], b[0], b[1]), haversineKm(b[0], b[1], a[0], a[1]))) asym += 1;
  }
  ok('symmetric, bit for bit (2,000 pairs)', asym === 0, `${asym} differ`);
}
ok('validCoord refuses text, NaN and out-of-range', validCoord(90, -180) && !validCoord(91, 0) && !validCoord('30', 1) && !validCoord(NaN, 0));

// ── distance_km (formula engine) ───────────────────────────────────────────
{
  const f = compile('distance_km([lat], [lng], 51.5074, -0.1278)');
  ok('distance_km compiles', f.ok);
  if (f.ok) {
    const got = f.fn.evaluate({ lat: 48.8566, lng: 2.3522 });
    ok('distance_km === haversineKm (Object.is)', Object.is(got, haversineKm(48.8566, 2.3522, 51.5074, -0.1278)), got);
    ok('distance_km is null for a text cell', f.fn.evaluate({ lat: '48.8', lng: 2.3 }) === null);
    ok('distance_km is null for an empty cell', f.fn.evaluate({ lat: null, lng: 2.3 }) === null);
    ok('distance_km is null off the globe', f.fn.evaluate({ lat: 95, lng: 2.3 }) === null);
  }
  const doc = FUNCTION_DOCS.distance_km;
  ok('formulaDocs documents distance_km with signature and example', !!doc && /lat1, lon1, lat2, lon2/.test(doc.signature) && compile(doc.example).ok);
}

// ── Point in polygon ────────────────────────────────────────────────────────
const sq = (x0: number, y0: number, x1: number, y1: number): number[][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
{
  const donut = [sq(0, 0, 10, 10), sq(4, 4, 6, 6)];
  ok('inside the outer ring', pointInPolygon(2, 2, donut));
  ok('inside the HOLE is outside', !pointInPolygon(5, 5, donut));
  ok('outside everything', !pointInPolygon(11, 5, donut));
  const fc = {
    type: 'FeatureCollection',
    features: [
      { properties: { name: 'West' }, geometry: { type: 'Polygon', coordinates: [sq(0, 0, 1, 1)] } },
      { properties: { name: 'East' }, geometry: { type: 'Polygon', coordinates: [sq(1, 0, 2, 1)] } },
      { properties: { name: 'North' }, geometry: { type: 'Polygon', coordinates: [sq(0, 1, 2, 2)] } },
      { properties: { name: 'Islands' }, geometry: { type: 'MultiPolygon', coordinates: [[sq(5, 5, 6, 6)], [sq(8, 8, 9, 9), sq(8.4, 8.4, 8.6, 8.6)]] } },
      { properties: { name: '' }, geometry: { type: 'Polygon', coordinates: [sq(20, 20, 21, 21)] } },
      { properties: { name: 'Line' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
    ],
  };
  const idx = buildBoundaryIndex(fc, (p) => String(p.name || ''));
  ok('index skips nameless and non-polygon features', !!idx && idx.features.length === 4);
  if (idx) {
    ok('a point in the second part of a MultiPolygon', locate(idx, 8.2, 8.9) === 'Islands');
    ok('…but not in that part\'s hole', locate(idx, 8.5, 8.5) === null);
    ok('shared vertical edge → the polygon to the EAST', locate(idx, 1, 0.5) === 'East');
    ok('shared horizontal edge → the polygon to the NORTH', locate(idx, 0.5, 1) === 'North');
    ok('outside every bbox → null', locate(idx, -3, -3) === null && locate(idx, 20.5, 20.5) === null);
  }
}
{
  const states = bundledIndex('us_state');
  ok('the bundled US states are indexed', !!states && states.features.length >= 50);
  if (states) {
    const known: Array<[number, number, string]> = [
      [30.2672, -97.7431, 'Texas'], [39.7392, -104.9903, 'Colorado'], [40.7128, -74.006, 'New York'],
      [47.6062, -122.3321, 'Washington'], [41.8781, -87.6298, 'Illinois'], [25.7617, -80.1918, 'Florida'],
    ];
    ok('known cities fall in their states', known.every(([la, lo, name]) => locate(states, lo, la) === name),
      known.map(([la, lo]) => locate(states, lo, la)).join(', '));
    ok('the Gulf of Mexico is in no state', locate(states, -90, 25) === null);
    let differ = 0;
    for (let i = 0; i < 3000; i += 1) {
      const lng = -125 + rand() * 60;
      const lat = 24 + rand() * 26;
      if (locate(states, lng, lat) !== locateScan(states, lng, lat)) differ += 1;
    }
    ok('the bbox grid index answers exactly as a full scan (3,000 points)', differ === 0, `${differ} differ`);
  }
  const counties = bundledIndex('us_county');
  ok('a county is named with its state', !!counties && locate(counties, -97.7431, 30.2672) === 'Travis, Texas');
  const world = bundledIndex('country');
  ok('countries: Paris is in France', !!world && locate(world, 2.3522, 48.8566) === 'France');
}

// ── spatial_join through the fold ───────────────────────────────────────────
{
  const cols: ParsedColumn[] = [{ name: 'id', type: 'number' }, { name: 'lat', type: 'number' }, { name: 'lng', type: 'number' }];
  const rows: Cell[][] = [[1, 30.2672, -97.7431], [2, 39.7392, -104.9903], [3, 25, -90], [4, null, -97], [5, 95, 0]];
  const step = checkSpatialJoin({ type: 'spatial_join', lat: 'lat', lng: 'lng', boundary: 'us_state', unmatched: 'Elsewhere' });
  ok('checkSpatialJoin accepts a bundled step, defaulting the column to "region"', typeof step !== 'string' && step.as === 'region');
  ok('checkSpatialJoin refuses a custom set with no valid id', typeof checkSpatialJoin({ lat: 'a', lng: 'b', boundary: 'custom', boundaryId: '../x', property: 'n' }) === 'string');
  ok('checkSpatialJoin refuses a missing column', typeof checkSpatialJoin({ lng: 'b', boundary: 'us_state' }) === 'string');
  ok('sanitizeSteps keeps a spatial_join step', sanitizeSteps([{ type: 'spatial_join', lat: 'lat', lng: 'lng', boundary: 'country' }]).length === 1);
  if (typeof step !== 'string') {
    const ctx = { tables: {}, boundaries: { us_state: bundledIndex('us_state') as any } }; // any: an index or a reason, per PipelineContext
    const out = applyPipeline({ columns: cols, rows }, [step as TransformStep], ctx);
    ok('the region column is appended as TEXT', out.columns[3].name === 'region' && out.columns[3].type === 'text');
    ok('regions and the unmatched value, row for row', JSON.stringify(out.rows.map((r) => r[3])) === JSON.stringify(['Texas', 'Colorado', 'Elsewhere', 'Elsewhere', 'Elsewhere']),
      JSON.stringify(out.rows.map((r) => r[3])));
    const stats = spatialStats({ columns: cols, rows }, step, ctx);
    ok('stats: 2 of 5 matched, 2 with no usable coordinates', typeof stats !== 'string' && stats.matched === 2 && stats.noCoords === 2 && stats.total === 5,
      JSON.stringify(stats));
    const missing = applyPipeline({ columns: cols, rows }, [step as TransformStep], { tables: {} });
    ok('without loaded boundaries the step is SKIPPED with a warning', missing.columns.length === 3 && missing.warnings.some((w) => /not loaded/.test(w)));
    const dup = applyPipeline({ columns: cols.concat([{ name: 'region', type: 'text' }]), rows: rows.map((r) => r.concat(['x'])) }, [step as TransformStep], ctx);
    ok('an existing output column skips the step', dup.warnings.some((w) => /already exists/.test(w)));
    const gen = generateSql('t', cols.map((c, i) => ({ physical: `c${i}`, name: c.name, type: c.type })), [step as TransformStep]);
    ok('the SQL pipeline BAILS on spatial_join (the fold answers)', gen.sql === null);
    const radius = generateSql('t', cols.map((c, i) => ({ physical: `c${i}`, name: c.name, type: c.type })),
      [{ type: 'filter', column: 'lat', op: 'within_km', radius: { lngColumn: 'lng', lat: 30, lng: -97, km: 10 } }]);
    ok('…and on a within_km filter', radius.sql === null);
  }
}

// ── The radius control's place box (offline places, #178) ────────────────────
{
  const austin = resolvePlace('Austin, TX');
  ok('"Austin, TX" resolves to Austin, TX', !!austin && austin.label === 'Austin, TX' && Math.abs(austin.lat - 30.27) < 0.05, JSON.stringify(austin));
  const zip = resolvePlace('78701');
  ok('a ZIP resolves to its ZIP3 area', !!zip && zip.label === 'ZIP 787xx' && zip.level === 'us_zip', JSON.stringify(zip));
  const county = resolvePlace('Travis County, TX');
  ok('a county resolves as a county', !!county && county.level === 'us_county' && /^Travis County, TX$/.test(county.label), JSON.stringify(county));
  const paris = resolvePlace('Paris, FR');
  ok('a world city resolves with its country', !!paris && paris.label === 'Paris, FR', JSON.stringify(paris));
  ok('an unknown place resolves to nothing — never a guess', resolvePlace('Atlantis-under-the-sea') === null && resolvePlace('') === null);
  ok('matchPlace is unchanged by the refactor', JSON.stringify(matchPlace('Austin, TX', 'us_city')) === JSON.stringify({ lat: austin && austin.lat, lng: austin && austin.lng }));
}

// ── Flow arcs ───────────────────────────────────────────────────────────────
{
  const a = flowArc(30.27, -97.74, 32.78, -96.8);
  const b = flowArc(32.78, -96.8, 30.27, -97.74);
  ok('an arc has ARC_POINTS + 1 points and starts/ends on its ends',
    a.length === (ARC_POINTS + 1) * 2 && Math.abs(a[0] + 97.74) < 1e-6 && Math.abs(a[a.length - 1] - 32.78) < 1e-6);
  const mid = ARC_POINTS; // the middle point's lng index
  ok('A → B and B → A bow to opposite sides', Math.abs(a[mid] - b[mid]) > 1e-3);
  const dateline = flowArc(35, 170, 35, -170);
  ok('a route over the antimeridian goes the short way (past 180°)', dateline[dateline.length - 2] > 180);
}

finish();
