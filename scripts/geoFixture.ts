// A deterministic COORDINATES dataset for the map tests: the bundled sample
// (retail orders by state) has regions but no latitude/longitude, so point,
// hexbin and flow maps need rows of their own. Shared by
// scripts/test-geoRoutes.ts and the e2e seed (web/e2e/seed.ts), which saves it
// into the sample project as "Shipments".
//
// 2,400 deliveries from six warehouses to 24 cities: `lat`/`lon` is the
// delivery point (a city centre plus up to ~0.4° of jitter — points and
// hexbins), `wh_lat`/`wh_lon` → `city_lat`/`city_lon` the route (flows group
// on exact coordinate pairs). Over geoCluster's 2,000-point threshold, so the
// point map clusters at country zoom.

export const GEO_FIXTURE_NAME = 'Shipments';

const WAREHOUSES: ReadonlyArray<[string, number, number]> = [
  ['Reno', 39.53, -119.81], ['Dallas', 32.78, -96.8], ['Atlanta', 33.75, -84.39],
  ['Columbus', 39.96, -83.0], ['Allentown', 40.6, -75.49], ['Kansas City', 39.1, -94.58],
];
const CITIES: ReadonlyArray<[string, number, number]> = [
  ['Seattle', 47.61, -122.33], ['Portland', 45.52, -122.68], ['San Francisco', 37.77, -122.42],
  ['Los Angeles', 34.05, -118.24], ['San Diego', 32.72, -117.16], ['Phoenix', 33.45, -112.07],
  ['Salt Lake City', 40.76, -111.89], ['Denver', 39.74, -104.99], ['Albuquerque', 35.08, -106.65],
  ['Houston', 29.76, -95.37], ['Austin', 30.27, -97.74], ['Minneapolis', 44.98, -93.27],
  ['Chicago', 41.88, -87.63], ['St. Louis', 38.63, -90.2], ['Nashville', 36.16, -86.78],
  ['New Orleans', 29.95, -90.07], ['Detroit', 42.33, -83.05], ['Charlotte', 35.23, -80.84],
  ['Miami', 25.76, -80.19], ['Orlando', 28.54, -81.38], ['Washington', 38.91, -77.04],
  ['Philadelphia', 39.95, -75.17], ['New York', 40.71, -74.01], ['Boston', 42.36, -71.06],
];
const CARRIERS = ['Ground', 'Express', 'Freight'];

export interface GeoFixture {
  columns: { name: string; type: 'text' | 'number' }[];
  rows: (string | number)[][];
}

export function geoFixture(rows = 2400): GeoFixture {
  let seed = 20261003;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const r2 = (v: number): number => Math.round(v * 1e4) / 1e4;
  const out: (string | number)[][] = [];
  for (let i = 0; i < rows; i += 1) {
    const [wh, wla, wlo] = WAREHOUSES[Math.floor(rand() * WAREHOUSES.length)];
    // Skewed toward the first cities, so routes and hexagons differ in weight.
    const [city, cla, clo] = CITIES[Math.floor(Math.pow(rand(), 1.6) * CITIES.length)];
    out.push([
      wh, wla, wlo, city, cla, clo,
      r2(cla + (rand() - 0.5) * 0.8), r2(clo + (rand() - 0.5) * 0.8),
      CARRIERS[Math.floor(rand() * CARRIERS.length)],
      Math.round(5 + rand() * 495),
    ]);
  }
  const num = (name: string) => ({ name, type: 'number' as const });
  const text = (name: string) => ({ name, type: 'text' as const });
  return {
    columns: [text('warehouse'), num('wh_lat'), num('wh_lon'), text('city'), num('city_lat'), num('city_lon'),
      num('lat'), num('lon'), text('carrier'), num('weight_kg')],
    rows: out,
  };
}
