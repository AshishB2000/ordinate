// The bundled sample CSV: deterministic, correctly typed, and shaped like data.
//
// The generator is the source of truth and the CSV beside it is committed
// output, so the two can drift — someone tunes a distribution, forgets to
// re-run, and every later diff of that file is enormous and unreviewable. The
// first assertion here is that they agree.
//
// The rest is about the sample being worth shipping. Charts drawn from modulo
// arithmetic have five identical bars and a flat line, which makes the app look
// broken on the one screen every new user sees first, so the seasonality, the
// spread and the planted anomaly are asserted rather than assumed.
//
//   npm run build:ts && node scripts/test-sampleData.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const gen: typeof import('./gen-sample-data') = require('./gen-sample-data');
const parse: typeof import('../src/data/parse') = require('../src/data/parse');

const CSV_PATH = path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv');

// ── Deterministic, and the committed file proves it ─────────────────────────
const a = gen.generateCsv();
const b = gen.generateCsv();
ok('the generator is deterministic across runs', a === b,
  a === b ? '' : 'two runs in one process disagree');

ok('the sample CSV is committed', fs.existsSync(CSV_PATH), CSV_PATH);
const committed = fs.existsSync(CSV_PATH) ? fs.readFileSync(CSV_PATH, 'utf8') : '';
ok('…and matches a fresh generation (re-run scripts/gen-sample-data.js)', committed === a,
  committed === a ? '' : `committed ${committed.length} bytes vs generated ${a.length}`);

// It ships inside the asar via package.json's "**/*" glob, so it has to stay
// small enough to be a reasonable thing to put in every download.
const kb = Math.round(Buffer.byteLength(a) / 1024);
ok('…and is a sane size to bundle', kb > 100 && kb < 600, kb + ' KB');

// ── It parses to the types the sample dashboard needs ───────────────────────
// isFiniteNumber is strict on purpose: a thousands separator, a currency symbol
// or a leading zero would type a measure as TEXT, `sum` over text is refused,
// and every KPI on the sample dashboard would render a dash.
const parsed = parse.parseCsv(a);
ok('the CSV parses with no warnings', parsed.warnings.length === 0, JSON.stringify(parsed.warnings));
ok('…with 5,000 rows', parsed.rowCount === 5000, String(parsed.rowCount));

const typeOf = (n: string): string => {
  const c = parsed.columns.find((x) => x.name === n);
  return c ? c.type : '(missing)';
};
const EXPECT: Record<string, string> = {
  order_date: 'date', region: 'text', state: 'text', category: 'text',
  sub_category: 'text', customer_segment: 'text',
  units: 'number', unit_price: 'number', discount: 'number',
  revenue: 'number', profit: 'number', ship_days: 'number',
};
for (const [col, want] of Object.entries(EXPECT)) {
  ok(`${col} parses as ${want}`, typeOf(col) === want, typeOf(col));
}

// ── Column helpers over the parsed rows ─────────────────────────────────────
const idx = (n: string): number => parsed.columns.findIndex((c) => c.name === n);
const col = (n: string): any[] => { const i = idx(n); return parsed.rows.map((r) => r[i]); };
const nums = (n: string): number[] => col(n).map(Number);
const distinct = (n: string): number => new Set(col(n).map(String)).size;

// ── Shaped like real business data ──────────────────────────────────────────
ok('five regions', distinct('region') === 5, String(distinct('region')));
ok('three categories and about a dozen sub-categories',
  distinct('category') === 3 && distinct('sub_category') === 12,
  `${distinct('category')} / ${distinct('sub_category')}`);
ok('three customer segments', distinct('customer_segment') === 3, String(distinct('customer_segment')));
// Enough states for a choropleth to look like a map rather than a few dots.
ok('at least twenty US states', distinct('state') >= 20, String(distinct('state')));

const dates = col('order_date').map(String);
ok('two full years of dates, in order',
  dates[0].startsWith('2023-01') && dates[dates.length - 1].startsWith('2024-12'),
  `${dates[0]} → ${dates[dates.length - 1]}`);

// Not modulo arithmetic: a real spread, so a bar chart has bars of different
// heights and a histogram is not a single spike.
const unitPrices = nums('unit_price');
ok('unit prices are spread, not repeated',
  new Set(unitPrices).size > 3000, String(new Set(unitPrices).size));

// December peak — the brief's "visible" is worth measuring, not eyeballing.
const revByMonth = new Map<string, number>();
const rev = nums('revenue');
dates.forEach((d, i) => {
  const k = d.slice(0, 7);
  revByMonth.set(k, (revByMonth.get(k) || 0) + rev[i]);
});
const months = [...revByMonth.keys()].sort();
ok('twenty-four months of revenue', months.length === 24, String(months.length));
const avgMonth = [...revByMonth.values()].reduce((s, v) => s + v, 0) / months.length;
const decs = months.filter((m) => m.endsWith('-12')).map((m) => revByMonth.get(m) as number);
ok('December is a visible peak, not noise',
  decs.every((v) => v > avgMonth * 1.25), decs.map((v) => (v / avgMonth).toFixed(2)).join(', '));

// Negative profit has to exist, or the profit map is a single flat colour and
// "some negative" in the brief is unmet.
const profit = nums('profit');
const negative = profit.filter((p) => p < 0).length;
ok('some orders lose money', negative > 100 && negative < profit.length / 3,
  `${negative} of ${profit.length}`);

// ── The planted anomaly ─────────────────────────────────────────────────────
// One region-month where deep discounting takes profit negative while revenue
// holds. It is what anomaly detection has to find and what Home's "Which region
// had the worst month?" chip is there to answer, so it must be BOTH present and
// unique — two bad months would make "the worst" ambiguous.
const regions = col('region').map(String);
const profitByRegionMonth = new Map<string, number>();
dates.forEach((d, i) => {
  const k = regions[i] + '|' + d.slice(0, 7);
  profitByRegionMonth.set(k, (profitByRegionMonth.get(k) || 0) + profit[i]);
});
const bad = [...profitByRegionMonth.entries()].filter(([, v]) => v < 0);
ok('exactly one region-month is unprofitable', bad.length === 1,
  JSON.stringify(bad.map(([k, v]) => k + '=' + Math.round(v))));
ok('…and it is a real outlier, not a rounding accident',
  bad.length === 1 && bad[0][1] < -2000, bad.length === 1 ? String(Math.round(bad[0][1])) : 'n/a');

if (failureCount()) {
  console.error('\n' + failureCount() + ' sample-data check(s) FAILED');
  process.exit(1);
}
console.log('\nAll sample-data checks passed.');
