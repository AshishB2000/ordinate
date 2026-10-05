// Self-check for maps that carry more: lat/long detection, the app's grid
// clustering, imported boundary validation, and the offline place table.
//
//   npm run build:ts && node scripts/test-mapPoints.js

import { ok, failureCount, finish } from './selfcheck';
import { checkBoundaries } from '../src/analysis/geojsonCheck';
import { matchPlace, matchPlaces, normPlace, zip3Of, loadPlaces } from '../src/analysis/places';
import { decorateGeoReply, pointItems } from '../src/analysis/mapData';

// ponytail: geoCluster.js is a UMD script, not a TS module (see test-geo-match.ts)
const gc = require('../src/analysis/geoCluster') as any;

// ── Lat/long detection: name AND range ───────────────────────────────────────
{
  const cols = [
    { name: 'store', type: 'text' }, { name: 'Latitude', type: 'number' },
    { name: 'LONGITUDE', type: 'number' }, { name: 'sales', type: 'number' },
  ];
  ok('detect: Latitude / LONGITUDE by name', JSON.stringify(gc.detectLatLon(cols)) === '{"lat":"Latitude","lon":"LONGITUDE"}');
  ok('detect: snake and camel case', JSON.stringify(gc.detectLatLon([{ name: 'pickup_lat', type: 'number' }, { name: 'pickupLng', type: 'number' }])) === '{"lat":"pickup_lat","lon":"pickupLng"}');
  ok('detect: the shortest matching name wins', gc.detectLatLon([{ name: 'lat_rounded_2', type: 'number' }, { name: 'lat', type: 'number' }, { name: 'lon', type: 'number' }]).lat === 'lat');
  ok('detect: a text column is never a coordinate', gc.detectLatLon([{ name: 'lat', type: 'text' }, { name: 'lon', type: 'number' }]) === null);
  ok('detect: "latte" and "longest_wait" are not coordinates', gc.detectLatLon([{ name: 'latte', type: 'number' }, { name: 'longest_wait', type: 'number' }]) === null);
  const sample = (vals: Record<string, unknown[]>) => (n: string) => vals[n] || [];
  ok('detect: a "long" column of durations fails the range check',
    gc.detectLatLon([{ name: 'lat', type: 'number' }, { name: 'long', type: 'number' }], sample({ lat: [40, 41], long: [300, 900, 12] })) === null);
  ok('detect: in-range values pass', gc.detectLatLon([{ name: 'lat', type: 'number' }, { name: 'long', type: 'number' }], sample({ lat: [40, '41.5', ''], long: [-73.9, -74] })) !== null);
  ok('detect: 95% in range is enough — one stray row does not veto', gc.detectLatLon([{ name: 'lat', type: 'number' }, { name: 'lon', type: 'number' }],
    sample({ lat: Array(39).fill(10).concat([999]), lon: Array(40).fill(20) })) !== null);
}

// ── Grid clustering ──────────────────────────────────────────────────────────
{
  const pts: any[] = [];
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < 5000; i++) pts.push({ lat: 30 + rnd() * 15, lng: -120 + rnd() * 45, value: Math.round(rnd() * 100) });
  const low = gc.gridCluster(pts, 3);
  const high = gc.gridCluster(pts, 16);
  ok('cluster: above 2,000 points, low zoom makes clusters', low.length < 200 && low.some((c: any) => c.count > 1), String(low.length));
  ok('cluster: every point is counted exactly once', low.reduce((s: number, c: any) => s + c.count, 0) === 5000);
  ok('cluster: values sum across clusters', low.reduce((s: number, c: any) => s + c.sum, 0) === pts.reduce((s, p) => s + p.value, 0));
  ok('cluster: high zoom separates into single points', high.filter((c: any) => c.count === 1).length > 4900, String(high.filter((c: any) => c.count === 1).length));
  ok('cluster: a single point carries its index', high.filter((c: any) => c.count === 1).every((c: any) => pts[c.index].lat === c.lat));
  const shuffled = pts.slice().reverse();
  const again = gc.gridCluster(shuffled, 3);
  ok('cluster: deterministic — the same points in another order give identical clusters',
    JSON.stringify(low.map((c: any) => [c.lat, c.lng, c.count, c.sum])) === JSON.stringify(again.map((c: any) => [c.lat, c.lng, c.count, c.sum])));
  ok('cluster: deterministic — twice is identical', JSON.stringify(gc.gridCluster(pts, 5)) === JSON.stringify(gc.gridCluster(pts, 5)));
  const few = gc.gridCluster(pts.slice(0, 2000), 1);
  ok('cluster: at or below 2,000 points nothing clusters, whatever the zoom', few.length === 2000 && few.every((c: any) => c.count === 1));
  ok('cluster: poles do not blow up the projection', gc.gridCluster(Array(2001).fill({ lat: 90, lng: 0 }), 4).length === 1);
}

// ── Imported boundaries ──────────────────────────────────────────────────────
{
  const sq = (x: number, y: number): number[][][] => [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]];
  const fc = (features: unknown[]): string => JSON.stringify({ type: 'FeatureCollection', features });
  const good = checkBoundaries(fc([
    { type: 'Feature', properties: { zone: 'North', code: 1, junk: { nested: true }, __proto: 'x' }, geometry: { type: 'Polygon', coordinates: sq(0, 0) } },
    { type: 'Feature', properties: { zone: 'South', code: 2 }, geometry: { type: 'MultiPolygon', coordinates: [sq(2, 0), sq(4, 0)] } },
    { type: 'Feature', properties: { zone: 'East', code: 2 }, geometry: { type: 'Polygon', coordinates: sq(6, 0) } },
  ]));
  ok('geojson: three polygons are accepted', good.ok === true);
  if (good.ok) {
    ok('geojson: nested objects and __-keys are dropped from properties', !('junk' in good.collection.features[0].properties) && !('__proto' in good.collection.features[0].properties));
    ok('geojson: properties are listed with uniqueness for the join picker',
      JSON.stringify(good.properties) === JSON.stringify([{ key: 'zone', count: 3, unique: true }, { key: 'code', count: 3, unique: false }]), JSON.stringify(good.properties));
    ok('geojson: the bbox spans every ring', JSON.stringify(good.bbox) === '[0,0,7,1]');
  }
  const refusals: Array<[string, string]> = [
    ['not json {', 'valid JSON'],
    [JSON.stringify({ type: 'Feature' }), 'FeatureCollection'],
    [fc([]), 'no features'],
    [fc([{ type: 'Feature', properties: { a: 1 }, geometry: { type: 'Point', coordinates: [0, 0] } }]), 'Polygon'],
    [fc([{ type: 'Feature', properties: { a: 1 }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [500, 0], [1, 1], [0, 0]]] } }]), 'longitude/latitude'],
    [fc([{ type: 'Feature', properties: { a: 1 }, geometry: { type: 'Polygon', coordinates: [[[0, 0], ['1', 0], [1, 1], [0, 0]]] } }]), 'longitude/latitude'],
    [fc([{ type: 'Feature', properties: { a: 1 }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } }]), 'longitude/latitude'],
    [fc([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: sq(0, 0) } }]), 'no text or number properties'],
    [fc(Array(5001).fill({ type: 'Feature', properties: { a: 1 }, geometry: { type: 'Polygon', coordinates: sq(0, 0) } })), '5,000'],
    ['x'.repeat(16 * 1024 * 1024), '15 MB'],
  ];
  for (const [text, why] of refusals) {
    const r = checkBoundaries(text);
    ok(`geojson: refused — ${why}`, r.ok === false && r.error.includes(why), r.ok ? 'accepted' : r.error);
  }
}

// ── The offline place table ──────────────────────────────────────────────────
{
  ok('places: the bundled table loads', loadPlaces());
  ok('normalise: case, accents, punctuation, St.', normPlace('  São  Paulo ') === 'sao paulo' && normPlace('St. Louis') === 'saint louis' && normPlace('Winston-Salem') === 'winston salem');
  ok('zip: 5-digit, ZIP+4, and a number that lost its leading zero', zip3Of('02134') === '021' && zip3Of('02134-1234') === '021' && zip3Of(2134) === '021' && zip3Of('abcde') === null);
  const near = (p: any, lat: number, lng: number, tol = 1): boolean => !!p && Math.abs(p.lat - lat) < tol && Math.abs(p.lng - lng) < tol;
  ok('city: a world city by name', near(matchPlace('Paris', 'world_city'), 48.86, 2.35));
  ok('city: accents are optional', near(matchPlace('Sao Paulo', 'world_city'), -23.55, -46.63) && near(matchPlace('São Paulo', 'world_city'), -23.55, -46.63));
  ok('city: "Portland, OR" and "Portland, Maine" are two places',
    near(matchPlace('Portland, OR', 'us_city'), 45.5, -122.6) && near(matchPlace('Portland, Maine', 'us_city'), 43.66, -70.25));
  ok('city: "Austin TX" without a comma', near(matchPlace('Austin TX', 'us_city'), 30.27, -97.74));
  ok('city: us_city never answers with a foreign city', matchPlace('Mumbai', 'us_city') === null && matchPlace('Mumbai', 'world_city') !== null);
  ok('city: …but a US place of the same name is a US answer (Toronto, Ohio)', near(matchPlace('Toronto', 'us_city'), 40.46, -80.6));
  ok('county: "Cook County, IL", "Cook, Illinois", any case', near(matchPlace('Cook County, IL', 'us_county'), 41.8, -87.8) && near(matchPlace('cook, illinois', 'us_county'), 41.8, -87.8));
  ok('county: a parish', near(matchPlace('Orleans Parish, LA', 'us_county'), 30.0, -90.0));
  ok('zip: a ZIP places at its prefix centroid', near(matchPlace('10001', 'us_zip'), 40.75, -73.99, 1.5));
  const m = matchPlaces(['Paris', 'paris', 'Atlantis', 'Gotham', 'Atlantis', null], 'world_city');
  ok('many: each distinct value looked up once; misses counted and listed',
    m.points.size === 2 && m.unmatched.count === 3 && m.unmatched.values.join() === 'Atlantis,Gotham,', JSON.stringify(m.unmatched));
}

// ── Points from rows, and a finished map reply ───────────────────────────────
{
  const cols = [{ name: 'store', type: 'text' as const }, { name: 'lat', type: 'number' as const }, { name: 'lng', type: 'number' as const }, { name: 'sales', type: 'number' as const }, { name: 'tier', type: 'text' as const }];
  // Enough good rows that one stray coordinate cannot veto the column (the 95% rule).
  const filler = Array.from({ length: 40 }, (_, i) => ['F' + i, 35 + i / 10, -100 - i / 10, 1, 'bronze']);
  const rows = [['A', 40.7, -74, 10, 'gold'], ['B', 34, -118.2, 20, 'silver'], ['C', 999, 0, 5, 'gold'], ['D', '', '', 1, 'x'], ...filler];
  const r = pointItems(cols, rows, { category: 'store', values: [{ column: 'sales', aggregation: 'sum' }], geo: { level: 'point', color: 'tier' } });
  ok('points: coordinates found by name, bad rows skipped and counted', r.ok && r.items.length === 42 && r.skipped === 2 && r.lat === 'lat' && r.lon === 'lng', JSON.stringify(r).slice(0, 300));
  ok('points: size is the raw measure, colour the chosen column', r.ok && r.items[1].value === 20 && r.items[1].color === 'silver' && r.items[1].name === 'B');
  const f = pointItems(cols, rows, { category: 'store', values: [] , geo: { level: 'point' } }, [{ type: 'filter', column: 'tier', op: '=', value: 'gold' }]);
  ok('points: filters apply first', f.ok && f.items.length === 1 && f.items[0].name === 'A');
  ok('points: no coordinates is a sentence, not an empty map', pointItems([{ name: 'x', type: 'number' }], [[1]], { category: 'x', values: [], geo: { level: 'point' } }).ok === false);
  const reply = decorateGeoReply({ ok: true, data: { labels: [], series: [], geo: { level: 'us_city', items: [{ name: 'Denver', value: 3 }, { name: 'Nowhere', value: 1 }] } } },
    { category: 'city', values: [], geo: { level: 'us_city', basemap: 'none' } });
  const g = reply.data.geo;
  ok('reply: a city level is placed, the miss listed, the click column and basemap carried',
    g.points === true && g.items.length === 1 && typeof g.items[0].lat === 'number' && g.unmatched.count === 1 && reply.data.markColumn === 'city' && g.basemap === 'none', JSON.stringify(g));
}

console.log(failureCount() ? `\n${failureCount()} map check(s) FAILED.` : '\nAll map checks passed.');
finish();
