// Generate the bundled sample dataset.
//
//   node scripts/gen-sample-data.js        → writes assets/samples/retail-orders.csv
//   node scripts/gen-sample-data.js --check → exits 1 if the committed file is stale
//
// THIS FILE IS THE SOURCE OF TRUTH; the CSV beside it is committed output. The
// CSV has to be committed rather than generated at install time, or a clean CI
// clone (and every packaged build made from one) ships without it — the same
// reason assets/geo/* are committed even though postinstall regenerates them.
//
// DETERMINISTIC, and that is a hard requirement, not a nicety: the committed
// file is diffed against a fresh generation by scripts/test-sampleData.ts, so a
// generator that drifts fails the build instead of quietly making every future
// diff enormous. Hence a seeded PRNG and no Math.random anywhere.
//
// The distributions are the point. Modulo arithmetic produces charts with five
// identical bars and a flat line, which makes the app look broken on the one
// screen every new user sees first. Everything here is weighted, skewed or
// seasonal so the sample reads as real business data.

import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = path.join(__dirname, '..', 'assets', 'samples');
const OUT_FILE = path.join(OUT_DIR, 'retail-orders.csv');

const ROWS = 5000;
const SEED = 0x5eed1e;
const START = new Date(Date.UTC(2023, 0, 1));
const DAYS = 730; // two full years

// ── A seeded PRNG (mulberry32). Five lines, no dependency, identical on every
//    platform — Math.random would make the committed CSV unreproducible. ──────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Re-seeded at the top of every generateCsv() call, NOT once at module load: as
// a load-time singleton the second call in a process continued the stream and
// produced a different file, so `--check` straight after a generate disagreed
// with the bytes it had just written.
let rnd = mulberry32(SEED);

/** Pick from `items` by weight. */
function weighted<T>(items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) return item;
  }
  return items[items.length - 1][0];
}

/** Box–Muller, so `units` and `unit_price` are bell-shaped rather than uniform. */
function normal(mean: number, sd: number): number {
  const u = Math.max(rnd(), 1e-9);
  const v = rnd();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Right-skewed positive number — the shape order sizes and prices actually have. */
function lognormal(median: number, sigma: number): number {
  return median * Math.exp(normal(0, sigma));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── The vocabulary ──────────────────────────────────────────────────────────
// FULL state names, never abbreviations. assets/geo/us-states.js features carry
// only `properties.name`, and geoMatch needs an exact or >4-char substring
// match, so "CA" can never join to "California" — the choropleth would render
// an empty map. scripts/test-geoLevels.ts pins that gap.
const REGIONS: readonly (readonly [string, number])[] = [
  ['West', 30], ['East', 26], ['Central', 20], ['South', 16], ['Northeast', 8],
];
const STATES: Record<string, readonly (readonly [string, number])[]> = {
  West: [['California', 40], ['Washington', 18], ['Oregon', 12], ['Arizona', 12], ['Nevada', 10], ['Colorado', 8]],
  East: [['New York', 34], ['Pennsylvania', 20], ['Virginia', 16], ['Georgia', 16], ['Florida', 14]],
  Central: [['Illinois', 30], ['Ohio', 24], ['Michigan', 20], ['Minnesota', 14], ['Missouri', 12]],
  South: [['Texas', 42], ['North Carolina', 20], ['Tennessee', 16], ['Alabama', 12], ['Louisiana', 10]],
  Northeast: [['Massachusetts', 40], ['New Jersey', 30], ['Connecticut', 18], ['Maine', 12]],
};

// sub_category is nested under category — a real hierarchy, so drilling from one
// to the other shows something, and the 12 subs are not uniformly distributed.
const CATEGORIES: readonly (readonly [string, number])[] = [
  ['Technology', 38], ['Furniture', 32], ['Office Supplies', 30],
];
const SUBS: Record<string, readonly (readonly [string, number])[]> = {
  Technology: [['Phones', 34], ['Computers', 26], ['Accessories', 24], ['Copiers', 16]],
  Furniture: [['Chairs', 34], ['Tables', 24], ['Bookcases', 22], ['Furnishings', 20]],
  'Office Supplies': [['Paper', 30], ['Binders', 26], ['Storage', 24], ['Art', 20]],
};
/** Median unit price and gross margin per sub-category. */
const PRICING: Record<string, { price: number; margin: number }> = {
  Phones: { price: 240, margin: 0.24 }, Computers: { price: 780, margin: 0.18 },
  Accessories: { price: 38, margin: 0.36 }, Copiers: { price: 1450, margin: 0.21 },
  Chairs: { price: 210, margin: 0.28 }, Tables: { price: 340, margin: 0.14 },
  Bookcases: { price: 160, margin: 0.19 }, Furnishings: { price: 46, margin: 0.34 },
  Paper: { price: 12, margin: 0.42 }, Binders: { price: 18, margin: 0.38 },
  Storage: { price: 64, margin: 0.26 }, Art: { price: 22, margin: 0.4 },
};
const SEGMENTS: readonly (readonly [string, number])[] = [
  ['Consumer', 52], ['Corporate', 32], ['Home Office', 16],
];
const DISCOUNTS: readonly (readonly [number, number])[] = [
  [0, 58], [0.1, 20], [0.15, 12], [0.2, 7], [0.3, 3],
];

// ── The planted anomaly ─────────────────────────────────────────────────────
// One region, one month, where deep discounting drags profit NEGATIVE while
// revenue holds near trend. That is a real shape — a promotion that moved units
// and lost money — and it is what src/analysis/anomalies.ts has to find and what
// Home's "Which region had the worst month?" chip is there to answer.
const ANOMALY_REGION = 'Central';
const ANOMALY_YEAR = 2024;
const ANOMALY_MONTH = 8; // September (0-based)

function isAnomaly(d: Date, region: string): boolean {
  return region === ANOMALY_REGION
    && d.getUTCFullYear() === ANOMALY_YEAR
    && d.getUTCMonth() === ANOMALY_MONTH;
}

/**
 * A date with weekly and yearly seasonality.
 *
 * Rejection sampling against a per-day weight, so the shape lives in one place
 * rather than in a cumulative table: weekends are thin (retail back-office
 * ordering), and December runs ~1.8x for the holiday peak the brief asks to be
 * visible in the "revenue by month" line.
 */
function pickDate(): Date {
  for (;;) {
    const day = Math.floor(rnd() * DAYS);
    const d = new Date(START.getTime() + day * 86400000);
    const dow = d.getUTCDay();
    const month = d.getUTCMonth();
    let w = dow === 0 ? 0.35 : dow === 6 ? 0.5 : 1;
    if (month === 11) w *= 1.8;
    else if (month === 10) w *= 1.25;
    else if (month === 0 || month === 1) w *= 0.75;
    // Mild year-over-year growth, so the trend line goes somewhere.
    if (d.getUTCFullYear() === 2024) w *= 1.15;
    if (rnd() < w / 1.8) return d;
  }
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

export function generateCsv(): string {
  rnd = mulberry32(SEED);
  const header = [
    'order_date', 'region', 'state', 'category', 'sub_category', 'customer_segment',
    'units', 'unit_price', 'discount', 'revenue', 'profit', 'ship_days',
  ].join(',');

  const rows: string[] = [];
  for (let i = 0; i < ROWS; i += 1) {
    const date = pickDate();
    const region = weighted(REGIONS);
    const state = weighted(STATES[region]);
    const category = weighted(CATEGORIES);
    const subCategory = weighted(SUBS[category]);
    const segment = weighted(SEGMENTS);
    const { price, margin } = PRICING[subCategory];

    const anomaly = isAnomaly(date, region);
    const units = Math.max(1, Math.round(lognormal(3, 0.7)));
    const unitPrice = round2(Math.max(1, lognormal(price, 0.22)));
    // The anomalous month discounts hard; everywhere else follows the normal mix.
    const discount = anomaly ? weighted([[0.3, 55], [0.2, 30], [0.15, 15]]) : weighted(DISCOUNTS);

    const revenue = round2(units * unitPrice * (1 - discount));
    // Margin is on list price, so a discount eats it directly and a deep one
    // takes the order under water. No clamping — negative profit is the point.
    const effMargin = margin - discount * 1.35 - (anomaly ? 0.08 : 0);
    const profit = round2(revenue * effMargin);
    const shipDays = Math.min(10, Math.max(1, Math.round(lognormal(3.2, 0.45))));

    rows.push([
      iso(date), region, state, category, subCategory, segment,
      units, unitPrice.toFixed(2), discount, revenue.toFixed(2), profit.toFixed(2), shipDays,
    ].join(','));
  }

  // Sorted by date so the file reads like an export and a human scanning it sees
  // the two-year span immediately. Ties keep generation order, which keeps the
  // output stable.
  rows.sort((a, b) => (a.slice(0, 10) < b.slice(0, 10) ? -1 : a.slice(0, 10) > b.slice(0, 10) ? 1 : 0));
  return header + '\n' + rows.join('\n') + '\n';
}

// No commas, no currency symbols, no thousands separators, no leading zeros
// anywhere above — parse.ts's isFiniteNumber is strict on purpose, and any of
// those would type a measure column as TEXT, where `sum` is refused and every
// KPI on the sample dashboard would render a dash.
if (require.main === module) {
  const csv = generateCsv();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    if (current === csv) {
      console.log('assets/samples/retail-orders.csv is up to date.');
    } else {
      console.error('assets/samples/retail-orders.csv is STALE — run: node scripts/gen-sample-data.js');
      process.exit(1);
    }
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, csv, 'utf8');
    const kb = Math.round(Buffer.byteLength(csv) / 1024);
    console.log(`Wrote ${OUT_FILE} — ${ROWS} rows, ${kb} KB.`);
  }
}
