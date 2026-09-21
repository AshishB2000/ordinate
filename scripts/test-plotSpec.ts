// Self-check for the PURE half of renderer/hub/plotRender.ts — the Mosaic/vgplot
// chart-type decision, the spec it produces, and its identifier quoting.
//
// This does NOT mirror the source the way scripts/test-more-charts.ts has to.
// plotRender's spec layer touches no DOM, no vgplot and no IPC, so the emitted
// sibling is EXECUTED here in a `vm` sandbox and the real functions are called.
// A classic renderer <script> has no exports, and its top-level `const`s stay in
// the script's own lexical scope, so the capture expression appended below —
// evaluated inside that same scope — is how they are reached. Mirroring would
// pass green forever after the source changed; this cannot.
//
// What it does not cover, deliberately: whether a spec actually DRAWS. That is
// not knowable in Node (it needs Electron, the vendor bundle and a live DuckDB),
// and it was verified separately by driving the real app.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const HUB = path.join(__dirname, '..', 'renderer', 'hub');

/** Run a renderer script in a sandbox and return the named lexical bindings. */
function loadRendererScript(file: string, names: string[]): Record<string, any> {
  const code = fs.readFileSync(path.join(HUB, file), 'utf8');
  const sandbox: Record<string, any> = { console };
  sandbox.globalThis = sandbox;
  // Browser globals the file only ever touches from INSIDE a function body.
  // Present so a stray load-time reference fails loudly rather than silently.
  sandbox.window = sandbox;
  sandbox.document = undefined;
  sandbox.localStorage = undefined;
  vm.createContext(sandbox);
  return vm.runInContext(code + '\n;({' + names.map((n) => n + ': ' + n).join(', ') + '});', sandbox);
}

const plot = loadRendererScript('plotRender.js', [
  'MOSAIC_CHART_TYPES', 'MOSAIC_FALLBACK_TYPES', 'mosaicChartCapable',
  'buildPlotSpec', 'mosaicQuoteIdent', 'mosaicSpecSql',
]);
const result = loadRendererScript('renderResult.js', ['ALL_CHART_TYPE_IDS', 'VIZ_LABELS']);

const {
  MOSAIC_CHART_TYPES, MOSAIC_FALLBACK_TYPES, mosaicChartCapable,
  buildPlotSpec, mosaicQuoteIdent, mosaicSpecSql,
} = plot;
const ALL_CHART_TYPE_IDS: string[] = result.ALL_CHART_TYPE_IDS;
const VIZ_LABELS: Record<string, string> = result.VIZ_LABELS;


// ── The two lists PARTITION every wired chart type ──────────────────────────
// The whole reason coverage is spelled out as two explicit sets rather than one
// set plus "everything else": a chart type added to the picker without a Mosaic
// decision must fail HERE, not quietly render on Chart.js forever.
const everyType = ALL_CHART_TYPE_IDS.concat(['table', 'map_bubble', 'map_choropleth']);
ok('the id list under test is the real one', everyType.length === 29, `${everyType.length} types`);

for (const type of everyType) {
  const inMosaic = MOSAIC_CHART_TYPES.has(type);
  const inFallback = MOSAIC_FALLBACK_TYPES.has(type);
  ok('classified exactly once: ' + type, (inMosaic ? 1 : 0) + (inFallback ? 1 : 0) === 1,
     inMosaic && inFallback ? 'in BOTH sets' : (!inMosaic && !inFallback ? 'in NEITHER set' : ''));
}
const classified = [...MOSAIC_CHART_TYPES, ...MOSAIC_FALLBACK_TYPES];
ok('neither set invents a type the picker does not have',
   classified.every((t: string) => everyType.indexOf(t) >= 0),
   classified.filter((t: string) => everyType.indexOf(t) < 0).join(',') || 'none');
ok('every classified type has a chip label',
   classified.every((t: string) => typeof VIZ_LABELS[t] === 'string'));

// ── The 5 documented GAPs stay on Chart.js ──────────────────────────────────
// docs/phase-3/README.md §4: @uwdata/vgplot exports no pie, donut, arc, gauge,
// treemap or sankey mark. If one of these ever flips to Mosaic-capable it is
// because a mark was invented for it, and that needs a decision, not a diff.
for (const gap of ['pie', 'donut', 'gauge', 'treemap', 'sankey']) {
  ok('GAP type falls back: ' + gap, !mosaicChartCapable(gap) && MOSAIC_FALLBACK_TYPES.has(gap));
}
// `table` is a further hard rule, not a taste call: vg.table() builds a <style>
// element with per-instance, schema-derived rules that cannot be pre-extracted
// into vendor/plot.css, so it would violate style-src 'self' on every update.
ok('table never routes to vgplot (vg.table() injects a dynamic <style>)',
   !mosaicChartCapable('table') && MOSAIC_FALLBACK_TYPES.has('table'));
ok('maps stay on Leaflet', !mosaicChartCapable('map_bubble') && !mosaicChartCapable('map_choropleth'));

// ── The spec for a representative aggregated chart ──────────────────────────
const VIEW = 'ds_1111_2222';
const aggEnc = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };
const colSpec = buildPlotSpec('column', aggEnc, VIEW);

ok('column builds a spec', !!colSpec);
ok('column queries the view it was given', colSpec.relation === VIEW);
ok('column is one barY mark', colSpec.marks.length === 1 && colSpec.marks[0].mark === 'barY');
ok('column puts the category on x, verbatim and unaggregated',
   JSON.stringify(colSpec.marks[0].options.x) === '{"column":"region"}');
ok('column puts the aggregated measure on y',
   JSON.stringify(colSpec.marks[0].options.y) === '{"column":"amount","agg":"sum"}');
ok('column requires the measure to be NUMERIC in the view',
   colSpec.requires.some((r: any) => r.column === 'amount' && r.numeric === true));
ok('column does NOT require the category to be numeric',
   colSpec.requires.some((r: any) => r.column === 'region' && r.numeric === false));
ok('column names both axes', colSpec.attributes.xLabel === 'region' && colSpec.attributes.yLabel === 'amount');
ok('the aggregated query is what it should be',
   mosaicSpecSql(colSpec) === 'SELECT "region" AS "x", sum("amount") AS "y" FROM "ds_1111_2222" GROUP BY "x"',
   mosaicSpecSql(colSpec));

// bar is column with the axes swapped — the measure becomes the x channel.
const barSpec = buildPlotSpec('bar', aggEnc, VIEW);
ok('bar is barX with the category on y',
   barSpec.marks[0].mark === 'barX'
   && JSON.stringify(barSpec.marks[0].options.y) === '{"column":"region"}'
   && JSON.stringify(barSpec.marks[0].options.x) === '{"column":"amount","agg":"sum"}');

// count() reads no column, so it imposes no numeric requirement — anything else
// would decline a perfectly good "count of rows by region" over a text column.
const countSpec = buildPlotSpec('column', { category: 'region', values: [{ column: 'sku', aggregation: 'count' }] }, VIEW);
ok('count imposes no numeric requirement',
   countSpec.requires.every((r: any) => r.column !== 'sku' || r.numeric === false));
ok('count renders as count(), not count(col)',
   mosaicSpecSql(countSpec) === 'SELECT "region" AS "x", count() AS "y" FROM "ds_1111_2222" GROUP BY "x"',
   mosaicSpecSql(countSpec));

// ── Stack order is pinned, because an unpinned one is a WRONG chart ─────────
// Plot stacks in input order and a GROUP BY returns groups in hash order, so
// without an explicit series channel the same split value lands at a different
// height in every category. Measured; see the comment beside `stackOrder`.
const splitEnc = { category: 'region', series: 'channel', values: [{ column: 'amount', aggregation: 'sum' }] };
for (const type of ['stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar', 'stacked_area']) {
  const s = buildPlotSpec(type, splitEnc, VIEW);
  const o = s.marks[0].options as any;
  ok(type + ' pins its stack order to the split VALUE',
     JSON.stringify(o.z) === '{"column":"channel"}' && o.order === 'z');
}
ok('100% stacked uses Plot\'s normalize offset',
   (buildPlotSpec('pct_stacked_column', splitEnc, VIEW).marks[0].options as any).offset === 'normalize');
ok('a single-series area has no stack order to pin',
   (buildPlotSpec('area', aggEnc, VIEW).marks[0].options as any).z === undefined);

// Clustered bars are FACETED, not stacked — the category becomes fx/fy.
const clustered = buildPlotSpec('clustered_column', splitEnc, VIEW);
ok('clustered_column facets by the category',
   JSON.stringify((clustered.marks[0].options as any).fx) === '{"column":"region"}'
   && JSON.stringify((clustered.marks[0].options as any).x) === '{"column":"channel"}');

// line_markers is one line plus one dot over the SAME channels, so the
// coordinator's cache serves the second mark's identical query.
const lm = buildPlotSpec('line_markers', aggEnc, VIEW);
ok('line_markers is lineY + dot', lm.marks.length === 2 && lm.marks[0].mark === 'lineY' && lm.marks[1].mark === 'dot');
ok('line_markers draws both marks off the same channels',
   JSON.stringify(lm.marks[0].options.x) === JSON.stringify(lm.marks[1].options.x)
   && JSON.stringify(lm.marks[0].options.y) === JSON.stringify(lm.marks[1].options.y));

// ── Encodings this file declines rather than draw differently ───────────────
ok('no category → no spec', buildPlotSpec('column', { values: [{ column: 'amount', aggregation: 'sum' }] } as any, VIEW) === null);
ok('no measure → no spec', buildPlotSpec('column', { category: 'region', values: [] } as any, VIEW) === null);
ok('a geo encoding is a map, not a plot',
   buildPlotSpec('column', { ...aggEnc, geo: { level: 'country' } } as any, VIEW) === null);
ok('a fallback type never yields a spec', buildPlotSpec('pie', aggEnc, VIEW) === null);
// N measures become N sibling series in src/vizData.ts; sibling vgplot marks do
// not stack or cluster with each other, so this declines instead of drawing
// measure 0 and dropping the rest.
const twoMeasures = { category: 'region', values: [
  { column: 'amount', aggregation: 'sum' }, { column: 'qty', aggregation: 'sum' }] };
ok('two measures on a bar chart → no spec (would silently drop one)',
   buildPlotSpec('column', twoMeasures as any, VIEW) === null);
ok('stacked_column without a split → no spec', buildPlotSpec('stacked_column', aggEnc, VIEW) === null);
ok('heatmap without a split → no spec', buildPlotSpec('heatmap', aggEnc, VIEW) === null);
ok('column WITH a split → no spec (that is the clustered chart under another name)',
   buildPlotSpec('column', splitEnc, VIEW) === null);

// scatter/bubble are the exception: Ordinate already reads their measures
// POSITIONALLY as x / y / r, which is one mark, not N.
ok('scatter needs two measures', buildPlotSpec('scatter', aggEnc, VIEW) === null);
const scatter = buildPlotSpec('scatter', twoMeasures as any, VIEW);
ok('scatter maps measure 0 → x and measure 1 → y',
   JSON.stringify(scatter.marks[0].options.x) === '{"column":"amount","agg":"sum"}'
   && JSON.stringify(scatter.marks[0].options.y) === '{"column":"qty","agg":"sum"}');
ok('an AGGREGATED scatter groups (and colours) by the category',
   JSON.stringify((scatter.marks[0].options as any).fill) === '{"column":"region"}');
const rawScatter = buildPlotSpec('scatter', { category: 'region', values: [
  { column: 'amount', aggregation: 'none' }, { column: 'qty', aggregation: 'none' }] } as any, VIEW);
ok('a RAW scatter is one dot per row — no grouping channel at all',
   (rawScatter.marks[0].options as any).fill === undefined);
ok('bubble needs three measures', buildPlotSpec('bubble', twoMeasures as any, VIEW) === null);
const bubble = buildPlotSpec('bubble', { category: 'region', values: [
  { column: 'amount', aggregation: 'sum' }, { column: 'qty', aggregation: 'sum' },
  { column: 'weight', aggregation: 'sum' }] } as any, VIEW);
ok('bubble maps measure 2 → r', JSON.stringify(bubble.marks[0].options.r) === '{"column":"weight","agg":"sum"}');

// Chart.js bins the SERIES values (a distribution of group totals); binning the
// raw column is a distribution of ROWS. Different charts, so only raw is claimed.
ok('an aggregated histogram falls back — it would bin group totals, not rows',
   buildPlotSpec('histogram', aggEnc, VIEW) === null);
const hist = buildPlotSpec('histogram', { category: 'region', values: [{ column: 'amount', aggregation: 'none' }] } as any, VIEW);
ok('a raw histogram bins the column', JSON.stringify(hist.marks[0].options.x) === '{"bin":"amount"}');
ok('a raw histogram counts rows per bin',
   mosaicSpecSql(hist) === 'SELECT bin("amount") AS "x", count() AS "y" FROM "ds_1111_2222" GROUP BY "x"',
   mosaicSpecSql(hist));

// ── Identifier quoting ──────────────────────────────────────────────────────
// The same rule and the same hostile name src/datasetView.ts is verified against
// (docs/phase-3b §2): `"…"` with an embedded `"` doubled, and that is the WHOLE
// escape. A name crafted to close the quote and start a new statement must come
// back out as ONE identifier, semicolon and all.
const HOSTILE = 'evil"; DROP VIEW x; --';
ok('a hostile column name is one quoted identifier',
   mosaicQuoteIdent(HOSTILE) === '"evil""; DROP VIEW x; --"', mosaicQuoteIdent(HOSTILE));
ok('quoting is balanced — the identifier cannot end early',
   mosaicQuoteIdent(HOSTILE).slice(1, -1).split('""').join('').indexOf('"') === -1);
ok('an ordinary name is quoted, not mangled', mosaicQuoteIdent('region') === '"region"');
ok('an empty name still produces a syntactically closed identifier', mosaicQuoteIdent('') === '""');

const hostileSpec = buildPlotSpec('column', { category: HOSTILE, values: [{ column: HOSTILE, aggregation: 'sum' }] } as any, VIEW);
ok('a hostile name survives into the spec verbatim (never rewritten)',
   (hostileSpec.marks[0].options.x as any).column === HOSTILE);
ok('and reaches the SQL quoted, as one identifier per occurrence',
   mosaicSpecSql(hostileSpec)
     === 'SELECT "evil""; DROP VIEW x; --" AS "x", sum("evil""; DROP VIEW x; --") AS "y" '
        + 'FROM "ds_1111_2222" GROUP BY "x"',
   mosaicSpecSql(hostileSpec));
ok('a hostile VIEW name would be quoted too',
   mosaicSpecSql({ ...colSpec, relation: HOSTILE }).indexOf('FROM "evil""; DROP VIEW x; --"') > 0);

// A spec with no aggregate must not emit a GROUP BY (a raw scatter is one row
// per point; grouping it would collapse the chart).
ok('a fully raw mark emits no GROUP BY', mosaicSpecSql(rawScatter).indexOf('GROUP BY') === -1,
   mosaicSpecSql(rawScatter));

if (failureCount()) { console.error('\n' + failureCount() + ' assertion(s) failed'); process.exit(1); }
console.log('\nAll Mosaic plot-spec checks passed.');
