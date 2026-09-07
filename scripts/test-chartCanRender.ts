// chartCanRender — the ONE rule for "can this chart type physically draw this
// data", and the thing that decides whether a SAVED visual keeps its own type
// when you reopen it (renderer/hub/renderResult.ts).
//
// WHY THIS FILE EXISTS. Opening a saved GAUGE rendered a column chart, and then
// re-saved the visual as a column — losing a chart type the user had chosen.
//
// The cause was two rules for one question. `buildVizPicker`'s own
// `canRenderType` knew the real answer: a type can draw when the data clears its
// `CHART_SERIES_MIN` / `CHART_LABELS_MIN`, and `gauge` sets neither, so one
// series and one label are enough. But `vizBuilder.ts`'s `canShow` — the gate
// that decides whether a reopened visual keeps its saved type — was a separate
// hand-written list that returned true for exactly `table`, `map_bubble` and
// `map_choropleth`. Every other saved type survived reopening only by being in
// `recommended`, and `gauge` is recommended only for the `single_metric` shape.
// So a gauge saved over a categorical encoding was silently replaced.
//
// The two are now one function. These checks are against that function, and the
// gauge case is the regression guard: it fails on the old three-case list.
//
//   npm run build:ts && node scripts/test-chartCanRender.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// Renderer files are classic global-scope scripts with no exports, so the module
// is evaluated in a vm sandbox and the symbol read back off it — the pattern
// scripts/test-chartLegend.ts and scripts/test-plotSpec.ts already use.
const HUB = path.join(__dirname, '..', 'renderer', 'hub');
const sandbox: any = { window: {}, document: {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['chartTraits.js', 'renderResult.js']) {
  vm.runInContext(fs.readFileSync(path.join(HUB, f), 'utf8'), sandbox, { filename: f });
}

const chartCanRender: (type: string, data: any, hasGeo?: boolean) => boolean = sandbox.chartCanRender;
ok('renderResult exposes chartCanRender', typeof chartCanRender === 'function');

/** A shape like the one `computeVisualData` returns: n numeric series, m labels. */
const shaped = (series: number, labels: number) => ({
  labels: Array.from({ length: labels }, (_, i) => 'L' + i),
  series: Array.from({ length: series }, (_, i) => ({
    name: 's' + i,
    values: Array.from({ length: labels }, () => 1),
  })),
});

// The sample's own "revenue by category": one measure, three categories. This is
// the exact shape a gauge was saved over and then lost.
const CATEGORICAL = shaped(1, 3);

// ── THE BUG ────────────────────────────────────────────────────────────────
ok('a gauge CAN draw one series over categories — the reopened-gauge case',
   chartCanRender('gauge', CATEGORICAL) === true);
ok('…so can a single-series column, which is what it was replaced by',
   chartCanRender('column', CATEGORICAL) === true);

// ── The minimums are real and are enforced ─────────────────────────────────
// Everything below comes from CHART_SERIES_MIN / CHART_LABELS_MIN. If the shared
// rule ever stops consulting them, these go red.
ok('clustered_column needs 2 series', chartCanRender('clustered_column', shaped(1, 3)) === false
   && chartCanRender('clustered_column', shaped(2, 3)) === true);
ok('bubble needs 3 series', chartCanRender('bubble', shaped(2, 3)) === false
   && chartCanRender('bubble', shaped(3, 3)) === true);
ok('pie and donut need 2 labels', chartCanRender('pie', shaped(1, 1)) === false
   && chartCanRender('donut', shaped(1, 2)) === true);
ok('funnel needs 3 labels', chartCanRender('funnel', shaped(1, 2)) === false
   && chartCanRender('funnel', shaped(1, 3)) === true);
ok('heatmap needs 2 of each', chartCanRender('heatmap', shaped(2, 1)) === false
   && chartCanRender('heatmap', shaped(2, 2)) === true);

// ── The three special cases the old list DID get right ─────────────────────
ok('a table can always draw', chartCanRender('table', shaped(0, 0)) === true);
ok('a map needs geo, and says so', chartCanRender('map_choropleth', CATEGORICAL, false) === false
   && chartCanRender('map_choropleth', CATEGORICAL, true) === true);
ok('…both map types', chartCanRender('map_bubble', CATEGORICAL, false) === false
   && chartCanRender('map_bubble', CATEGORICAL, true) === true);

// ── A series of nothing but nulls is not a series ──────────────────────────
// countNumericSeries filters on "carries at least one number", so a column that
// aggregated to all-null must not qualify a chart that needs one.
const ALL_NULL = { labels: ['a', 'b'], series: [{ name: 's', values: [null, null] }] };
ok('a series with no numbers does not count', chartCanRender('column', ALL_NULL) === false);

// ── Junk in, false out; never a throw ──────────────────────────────────────
for (const [name, data] of [
  ['null', null],
  ['empty object', {}],
  ['no series', { labels: ['a'] }],
  ['series not an array', { labels: ['a'], series: 'nope' }],
] as [string, any][]) {
  let threw = false;
  let out: boolean | null = null;
  try { out = chartCanRender('column', data); } catch (_) { threw = true; }
  ok('degenerate data (' + name + ') returns false without throwing',
     !threw && out === false, threw ? 'threw' : String(out));
}
ok('an unknown type still answers on the data minimums, not a crash',
   chartCanRender('not_a_chart', CATEGORICAL) === true);

finish();
if (failureCount()) process.exit(1);
