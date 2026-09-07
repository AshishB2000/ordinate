// Month-truncated date labels, on the axis and in the tooltip.
//
// `datetrunc('month', order_date)` is the only way to chart by month — VizEncoding
// has no granularity — and it yields '2023-01-01'. A year of those printed twelve
// full ISO dates whose day part is noise on every one of them.
//
// Two things are checked, and the second is the one that rots: that the rewrite
// itself is right (all-or-nothing, timezone-safe), and that buildChart actually
// CALLS it, so the labels Chart.js receives are the formatted ones. A pure
// function nothing invokes passes every unit test.
//
// TZ IS SET FIRST, BEFORE ANY Date EXISTS. `new Date('2023-01-01')` is UTC
// midnight; formatted in a negative-offset zone without timeZone:'UTC' it reads
// "Dec 2022", which is the whole bug class this guards. Node re-reads TZ on
// assignment, so a single line here puts the suite in Los Angeles.
process.env.TZ = 'America/Los_Angeles';

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const HUB = path.join(__dirname, '..', 'renderer', 'hub');

// index.html's dependency order, same list test-chartSpec.ts loads.
const CHART_SCRIPTS = [
  'chartTraits.js', 'chartPalette.js', 'chartTypeSpec.js',
  'chartValueLabels.js', 'chartDatasets.js', 'chartScales.js', 'chartRender.js',
];

// The hub.js formatters, as RUNNABLE STUBS. test-chartSpec.ts restates them
// faithfully because it freezes a hash of the whole config; this suite only
// reads data.labels, so anything that returns a string will do.
const PRELUDE = `
function _fmtVal(v) { return v == null ? '' : String(v); }
function fmtWith(v) { return _fmtVal(v); }
function histogramBins() { return { labels: [], counts: [] }; }
`;

const recorded: any[] = [];
const sandbox: Record<string, any> = { console };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
function Chart(this: any, _canvas: unknown, config: any) { recorded.push(config); this.config = config; }
(Chart as any).defaults = { plugins: { legend: { labels: { generateLabels: () => [] } } } };
(Chart as any).register = () => {};
sandbox.Chart = Chart;
sandbox.ChartBoxPlot = undefined;
sandbox.matchMedia = () => ({ matches: false });
sandbox.document = { documentElement: {} };
sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' });
vm.createContext(sandbox);

const source = PRELUDE + '\n' + CHART_SCRIPTS
  .map((f) => '\n// ==== ' + f + ' ====\n' + fs.readFileSync(path.join(HUB, f), 'utf8'))
  .join('\n');
// Classic-script scope: top-level `const`s are unreachable from outside it, so
// the capture expression is appended INSIDE the script.
const api: { buildChart: Function; asMonthLabels: (l: any[]) => any[] } = vm.runInContext(
  source + '\n;({ buildChart: buildChart, asMonthLabels: asMonthLabels });',
  sandbox, { filename: 'chart-family.js' });

const eq = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// ── The rewrite ────────────────────────────────────────────────────────────
ok('a first-of-month ISO date becomes a month',
  eq(api.asMonthLabels(['2023-01-01', '2023-02-01', '2023-12-01']),
     ['Jan 2023', 'Feb 2023', 'Dec 2023']),
  JSON.stringify(api.asMonthLabels(['2023-01-01', '2023-02-01', '2023-12-01'])));

// The trap this suite exists for: UTC midnight formatted in a western zone.
ok('…in January, from a negative-offset timezone, not the December before it',
  api.asMonthLabels(['2023-01-01'])[0] === 'Jan 2023',
  process.env.TZ + ' → ' + api.asMonthLabels(['2023-01-01'])[0]);

// All-or-nothing: one label with a real day means the axis is daily and the days
// carry information, so nothing may be rewritten.
const daily = ['2023-01-01', '2023-01-02', '2023-02-01'];
ok('a daily axis is left exactly alone', eq(api.asMonthLabels(daily), daily),
  JSON.stringify(api.asMonthLabels(daily)));
const mixed = ['2023-01-01', 'Total'];
ok('…and so is a mixed one', eq(api.asMonthLabels(mixed), mixed), JSON.stringify(api.asMonthLabels(mixed)));

const plain = ['North', 'South'];
ok('a category axis is untouched', eq(api.asMonthLabels(plain), plain));
ok('numbers are untouched', eq(api.asMonthLabels([2023, 2024]), [2023, 2024]));
ok('an empty axis is untouched', eq(api.asMonthLabels([]), []));

// A timestamp is still a first-of-month — DuckDB's date_trunc returns one.
ok('a midnight timestamp counts as month-truncated',
  eq(api.asMonthLabels(['2023-03-01T00:00:00.000Z', '2023-04-01 00:00:00']), ['Mar 2023', 'Apr 2023']),
  JSON.stringify(api.asMonthLabels(['2023-03-01T00:00:00.000Z', '2023-04-01 00:00:00'])));
ok('…but a timestamp with a real time is not',
  eq(api.asMonthLabels(['2023-03-01T09:30:00Z']), ['2023-03-01T09:30:00Z']));

// ── Wired into buildChart ──────────────────────────────────────────────────
// Not a formality: the rewrite lives one line into buildChart, above the sort and
// above ChartCtx, so the axis, the value labels and the tooltip all read the same
// strings. A refactor that moves it below the sort would still pass everything above.
const chart = api.buildChart({}, {
  labels: ['2023-01-01', '2023-02-01'],
  series: [{ name: 'Revenue', values: [120, 340] }],
}, 'line');
ok('buildChart really built something', Boolean(chart) && recorded.length === 1, String(recorded.length));
ok('…and the labels Chart.js received are months, not ISO dates',
  Boolean(recorded[0]) && eq(recorded[0].data.labels, ['Jan 2023', 'Feb 2023']),
  JSON.stringify(recorded[0] && recorded[0].data.labels));

if (failureCount()) console.error('\n' + failureCount() + ' month-label check(s) FAILED.');
else console.log('\nAll month-label checks passed.');
finish();
