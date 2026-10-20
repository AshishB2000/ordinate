// Publish to folder, end to end in plain node (userData in a temp dir):
//   1. the sanitizer covers every new field — unknown keys dropped, numbers
//      clamped, http(s) and SVG images refused, enums closed;
//   2. a page's CSP pins exactly its own inline scripts and stylesheet, and the
//      page references nothing outside itself;
//   3. the client renderer's pure core (src/publish/site/publishCore.js) under
//      a bare vm context — jsdom-free: combo lookup, single-mode picks, chart
//      configs, projections;
//   4. a REAL publish of a seeded project into a temp folder: the files, the
//      manifest, size accounting, the data block, every combination's answer
//      Object.is-equal to a direct vizDataFor call, re-publish replacing only
//      its own files, and the size-limit refusal.
//
//   npm run build:ts && node scripts/test-publishSite.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const vm: typeof import('vm') = require('vm');
const crypto: typeof import('crypto') = require('crypto');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-publish-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const pub: typeof import('../src/publish/publish') = require('../src/publish/publish');
const { sanitizePage } = require('../src/publish/sanitize') as typeof import('../src/publish/sanitize');
const { sanitizeBundle } = require('../src/analysis/dashboardExport') as typeof import('../src/analysis/dashboardExport');
const { pageHtml, scriptHashes, sizeCss } = require('../src/publish/siteHtml') as typeof import('../src/publish/siteHtml');
const { BREAKPOINTS } = require('../src/analysis/sizeLayout') as { BREAKPOINTS: { phone: number } };

/**
 * The phone's new elements, wherever a rule is NOT inside a media query: only
 * ever hidden (or a wrapper that draws nothing), so no window wider than a
 * phone can see one (docs/phone-dashboards). The offending rules, or none.
 */
function phoneLeaks(css: string): string[] {
  let flat = css;
  // Drop every @media block (one level of nesting: a block of rules).
  for (;;) {
    const at = flat.indexOf('@media');
    if (at < 0) break;
    let i = flat.indexOf('{', at) + 1;
    let depth = 1;
    for (; depth && i < flat.length; i++) depth += flat[i] === '{' ? 1 : flat[i] === '}' ? -1 : 0;
    flat = flat.slice(0, at) + flat.slice(i);
  }
  const PHONE = /pub-(kpis|dashhead|scrim|filters-grab|filters-foot|sheet|dot|in-strip|filters-badge)/;
  return [...flat.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => PHONE.test(m[1]) && !/^\s*display:\s*(none|contents);\s*$/.test(m[2]))
    .map((m) => m[0].trim());
}
const { vizDataFor } = require('../src/ipc/visuals') as typeof import('../src/ipc/visuals');
const { chartShapes } = require('../src/analysis/chartShapes') as typeof import('../src/analysis/chartShapes');
const { sanitizeEncoding } = visuals;

function dataBlock(html: string): any { // any: the page's JSON, asserted field by field
  const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

async function main(): Promise<void> {
  // ── 1. Sanitizer coverage ───────────────────────────────────────────────────
  const evil = sanitizePage({
    kind: 'dashboard',
    site: { title: 'T', nav: [{ file: 'ok-page.html', kind: 'dashboard', name: 'Ok' }, { file: '../../etc/passwd', name: 'x' }, { file: 'https://evil.example/x.html' }], logo: 'https://evil.example/logo.png' },
    secret: 'sk-live-123',
    formats: { locale: 'en-US' },
    brand: { logo: 'data:image/png;base64,AAAA', ramp: { accent: 'red; background: url(x)' } },
    geo: { country: { features: [{ properties: { name: 'X', token: 'sk-1' }, geometry: { type: 'Polygon', coordinates: [[[1, 2], ['3', 4], [NaN, 5]]] } }] }, 'http://x': {} },
    dashboard: {
      name: 'D', apiKey: 'sk-9', style: { theme: 'dark', accent: 'teal', density: 'compact', injected: '"}' },
      controls: [{ id: 'c', label: 'Region', kind: 'evil', column: 'region', options: Array.from({ length: 100 }, (_, i) => 'r' + i), defaultIndex: 999, extra: 1 }],
      keys: ['0', '1', '../x', '0.1.2', 'abc'],
      mode: 'weird',
      sheets: [{
        name: 'S',
        cards: [
          { kind: 'chart', chartType: '<script>', title: 'Chart', layout: { x: 30, y: -2, w: 99, h: 0 }, variants: [0, 5, 'x'],
            payloads: [{ labels: ['a', { o: 1 }, 3], series: [{ label: 'v', values: [1, '2', null, Infinity] }], caption: 'c', url: 'http://x',
              pivot: { rowHeaders: [['a']], colHeaders: [['b']], cells: [[1, 'x']], rowTotals: null, colTotals: [2], grand: [3], rowKinds: ['leaf', 'bogus'], valueNames: ['v'], valueCount: 1, formats: [''], showAs: ['value'], secret: 's' },
              geo: { level: 'moon', items: [{ name: 'X', value: 'nan', lat: 1, lng: 2, token: 'x' }] } }] },
          { kind: 'metric', title: 'M', layout: {}, variants: [0], payloads: [{ value: 5, display: '5', caption: 'k', password: 'p' }] },
          { kind: 'image', png: 'http://x/y.png' },
          { kind: 'script', code: 'alert(1)' },
        ],
      }],
    },
  }) as any; // any: asserting a sanitizer's output shape
  const text = JSON.stringify(evil);
  ok('sanitize: no secret, token, password or api key survives', !/sk-live|sk-9|sk-1|"secret"|"password"|"token"|apiKey/.test(text), text.slice(0, 300));
  ok('sanitize: no http(s) URL survives anywhere', !/https?:\/\//.test(text));
  ok('sanitize: nav keeps only plain .html file names', evil.site.nav.length === 1 && evil.site.nav[0].file === 'ok-page.html');
  ok('sanitize: an http logo is dropped', evil.site.logo === undefined);
  ok('sanitize: a brand ramp with a non-colour is dropped whole', !evil.brand.ramp);
  ok('sanitize: controls clamp kind, options (≤60) and the default index',
    evil.dashboard.controls[0].kind === 'dropdown' && evil.dashboard.controls[0].options.length === 60 && evil.dashboard.controls[0].defaultIndex === 0 && !('extra' in evil.dashboard.controls[0]));
  ok('sanitize: combination keys must be dotted indexes', JSON.stringify(evil.dashboard.keys) === '["0","1","0.1.2"]');
  ok('sanitize: mode is a closed enum', evil.dashboard.mode === 'all');
  const chart = evil.dashboard.sheets[0].cards[0];
  ok('sanitize: chart type is a closed set', chart.chartType === 'column');
  ok('sanitize: layout clamps to the 12-column grid', chart.layout.x === 11 && chart.layout.w === 1 && chart.layout.y === 0 && chart.layout.h === 1);
  ok('sanitize: variants index into payloads only', JSON.stringify(chart.variants) === '[0,0,0]');
  ok('sanitize: labels keep strings/numbers, values keep finite numbers',
    JSON.stringify(chart.payloads[0].labels) === '["a",3]' && JSON.stringify(chart.payloads[0].series[0].values) === '[1,null,null,null]');
  ok('sanitize: pivot cells are numbers or null; row kinds a closed set',
    JSON.stringify(chart.payloads[0].pivot.cells) === '[[1,null]]' && chart.payloads[0].pivot.rowKinds[1] === 'leaf' && !('secret' in chart.payloads[0].pivot));
  ok('sanitize: geo level closed, values numeric, stray keys gone',
    chart.payloads[0].geo.level === 'country' && chart.payloads[0].geo.items[0].value === null && !('token' in chart.payloads[0].geo.items[0]));
  ok('sanitize: a metric keeps value/display/caption only', JSON.stringify(evil.dashboard.sheets[0].cards[1].payloads[0]) === '{"value":5,"display":"5","caption":"k"}');
  ok('sanitize: unknown card kinds (image with an http png, script) are dropped', evil.dashboard.sheets[0].cards.length === 2);
  ok('sanitize: boundary coordinates are numbers or null, props whitelisted',
    JSON.stringify(evil.geo.country.features[0].geometry.coordinates) === '[[[1,2],[null,4],[null,5]]]' && !('token' in evil.geo.country.features[0].properties));
  ok('sanitize: a boundary key outside the vocabulary is dropped', !('http://x' in evil.geo));
  ok('sanitize: the style goes through sanitizeBundle (closed enums only)',
    evil.dashboard.style.theme === 'dark' && !('injected' in evil.dashboard.style));
  // The chart's figures (analysis/chartShapes) are whitelisted field by field — never spread.
  const figuresIn = {
    waterfall: { from: 1, to: 3, leak: 'sk-live-w', steps: [{ label: 'East', start: 1, end: 3, value: 2, kind: 'up', src: 0, extra: 'sk-live-s' }, { label: 'x', start: 'NaN', end: Infinity, value: 1, kind: '<b>', src: 99_999_999 }] },
    pareto: { order: [1, 0, 'x'], cumPct: [60, 100], count80: 1, total: 5, positives: 2, rows: [['secret']] },
    sharePct: [[25, 'x'], [75, null]], histogram: [[{ from: 0, to: 1, count: 2, raw: [1, 2] }]],
    funnel: { ofTopPct: [[100, 42]], spare: 1 }, bullet: { ofTargetPct: [90, null] }, calendar: { days: [19723, 1.5], values: [3, null] },
    url: 'http://x', secret: 'sk-live-f',
  };
  const figPage = sanitizePage({ kind: 'dashboard', site: {}, dashboard: { name: 'F', keys: ['0'], controls: [], sheets: [{ name: 'S', cards: [
    { kind: 'chart', chartType: 'waterfall', title: 'W', layout: {}, variants: [0], payloads: [{ labels: ['East'], series: [{ label: 'v', values: [2] }], figures: figuresIn }] },
  ] }] } }) as any; // any: asserting a sanitizer's output shape
  const figOut = figPage.dashboard.sheets[0].cards[0].payloads[0].figures;
  ok('sanitize: a chart keeps its figures, field by field',
    JSON.stringify(figOut.waterfall) === JSON.stringify({ from: 1, to: 3, steps: [{ label: 'East', start: 1, end: 3, value: 2, kind: 'up', src: 0 }, { label: 'x', start: 0, end: 0, value: 1, kind: 'up', src: -1 }] })
    && JSON.stringify(figOut.pareto) === '{"order":[1,0,-1],"cumPct":[60,100],"count80":1,"total":5,"positives":2}'
    && JSON.stringify(figOut.sharePct) === '[[25,0],[75,0]]' && JSON.stringify(figOut.histogram) === '[[{"from":0,"to":1,"count":2}]]'
    && JSON.stringify(figOut.funnel) === '{"ofTopPct":[[100,42]]}' && JSON.stringify(figOut.bullet) === '{"ofTargetPct":[90,null]}'
    && JSON.stringify(figOut.calendar) === '{"days":[19723,0],"values":[3,null]}', JSON.stringify(figOut));
  ok('sanitize: an unknown sibling anywhere in the figures is stripped — no leak, no secret, no row, no URL',
    !/sk-live|leak|extra|rows|raw|spare|"url"|"secret"|http/.test(JSON.stringify(figOut)), JSON.stringify(figOut));
  ok('sanitize: …and the check sees one (negative control: the raw block carries them)', /sk-live|leak|extra|rows|raw|spare/.test(JSON.stringify(figuresIn)));
  const exported = sanitizeBundle({ pages: [{ cards: [{ kind: 'chart', chartType: 'bar', layout: {}, data: { labels: ['a'], series: [], figures: { sharePct: [[100]], token: 'sk-live-e' } } }] }] }) as any; // any: an export bundle
  ok('sanitize: the export bundle keeps the same figures through the same whitelist, and strips the same strays',
    JSON.stringify(exported.pages[0].cards[0].data.figures) === '{"sharePct":[[100]]}');
  const story = sanitizePage({ kind: 'story', site: {}, story: { name: 'S', blocks: [
    { kind: 'image', src: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' },
    { kind: 'callout', tone: 'evil', text: 't' },
    { kind: 'metrics', metrics: [{ name: 'n', display: 'd', value: 'x' }] },
  ] } }) as any; // any: sanitizer output
  ok('sanitize: story images are raster only (an SVG data URL is a document)', story.story.blocks.filter((b: any) => b.kind === 'image').length === 1);
  ok('sanitize: story callout tone and metric values are clamped',
    story.story.blocks.some((b: any) => b.kind === 'callout' && b.tone === 'info') && story.story.blocks.some((b: any) => b.kind === 'metrics' && b.metrics[0].value === null));

  // ── 2. The CSP pins the page ────────────────────────────────────────────────
  const assets = pub.readAssets();
  ok('assets: the app\'s own Chart.js, formatter, geo matcher and renderer are on disk',
    assets.chartJs.length > 100_000 && assets.formatJs.length > 1000 && assets.geoMatchJs.length > 500 && assets.coreJs.length > 1000 && assets.clientJs.length > 1000);
  const html = pageHtml(sanitizePage({ kind: 'index', site: { title: 'Site', nav: [] } }), assets, 'Site');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const pinned = scriptHashes(html);
  const hashOf = (t: string) => "'sha256-" + crypto.createHash('sha256').update(t, 'utf8').digest('base64') + "'";
  ok('csp: default-src none, no unsafe-inline, images only from data:',
    /default-src 'none'/.test(html) && !/unsafe-inline|unsafe-eval/.test(html) && /img-src data:/.test(html));
  ok('csp: every inline script is pinned by its SHA-256, and nothing else is',
    inline.length === pinned.length && inline.every((s) => pinned.includes(hashOf(s))));
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  ok('csp: the one stylesheet is pinned too', !!style && html.includes('style-src ' + hashOf(style[1])));
  ok('page: its icon is inline, so no browser asks for /favicon.ico (img-src data: would refuse it)',
    /<link rel="icon" href="data:image\/[^"]+">/.test(html));
  ok('page: no external reference — no src/href/url()/@import to http(s)',
    !/(src|href)\s*=\s*["']?https?:/i.test(html) && !/url\(\s*["']?https?:/i.test(html) && !/@import/i.test(html));
  // Tags only: the inlined scripts' own TEXT may mention `<script src=` in a
  // comment (format.js does), which the HTML parser never treats as a tag.
  const tagsOnly = html.replace(/(<script[^>]*>)[\s\S]*?<\/script>/g, '$1</script>');
  ok('page: no script tag with a src at all', !/<script[^>]*\ssrc=/i.test(tagsOnly));
  ok('page: the data block is JSON, never executed', /<script type="application\/json" id="ordinate-page">/.test(html));
  // The region matcher reaches the client as page globals, bound by the line after geoMatch.js.
  // Run exactly those scripts (the module shim, geoMatch.js, the binding): a name the client calls
  // but the page never binds is a blank map, and a join without the shape names is a wrong figure.
  const geoPage: any = {}; // any: a bare vm global the page's vars land on
  vm.createContext(geoPage);
  for (const i of [1, 4, 5]) vm.runInContext(inline[i], geoPage);
  ok('page: binds every matcher function the client calls',
    ['matchGeoItem', 'featureNameSet', 'normalizeName'].every((n) => typeof geoPage[n] === 'function'));
  const twoShapes = [{ properties: { name: 'Kansas' } }, { properties: { name: 'Arkansas' } }];
  const lone = [{ name: 'Arkansas', value: 1 }];
  ok('page: a region takes its own row or none ("arkansas" contains "kansas")',
    geoPage.matchGeoItem(lone, twoShapes[0].properties, geoPage.featureNameSet(twoShapes)) === undefined &&
    geoPage.matchGeoItem(lone, twoShapes[1].properties, geoPage.featureNameSet(twoShapes)) === lone[0]);
  const joins = assets.clientJs.match(/\bmatchGeoItem\([^)]*\)/g) || [];
  ok('page: every region join in the client passes the shape names',
    joins.length > 0 && joins.every((c) => /,\s*shapeNames\)$/.test(c)) && /shapeNames = featureNameSet\(features\)/.test(assets.clientJs));

  // ── 3. The client core, jsdom-free ──────────────────────────────────────────
  const ctx: any = {}; // any: a bare vm global the core's functions land on
  vm.createContext(ctx);
  vm.runInContext(assets.coreJs, ctx);
  ok('core: loads with no DOM at all', typeof ctx.pkComboIndex === 'function' && typeof ctx.pkChartConfig === 'function');
  ok('core: a combination is found by its picks', ctx.pkComboIndex(['0.0', '0.1', '1.0'], [1, 0]) === 2 && ctx.pkComboIndex(['0'], [9]) === -1);
  ok('core: single mode resets the other controls to their defaults',
    JSON.stringify(ctx.pkNextPicks('single', [1, 0], [3, 2], 1, 4)) === '[1,4]' && JSON.stringify(ctx.pkNextPicks('all', [1, 0], [3, 2], 1, 4)) === '[3,4]');
  ok('core: a variant picks its payload', ctx.pkPayload({ variants: [1, 0], payloads: ['a', 'b'] }, 0) === 'b' && ctx.pkPayload({ variants: [], payloads: ['a'] }, 3) === 'a');
  const p = { labels: ['a', 'b'], series: [{ label: 's1', values: [1, 3] }, { label: 's2', values: [3, 1] }] };
  const fmt = (v: number) => String(v);
  ok('core: column → a vertical bar', ctx.pkChartConfig('column', p, [], fmt).type === 'bar' && ctx.pkChartConfig('column', p, [], fmt).options.indexAxis === 'x');
  ok('core: bar → horizontal', ctx.pkChartConfig('bar', p, [], fmt).options.indexAxis === 'y');
  ok('core: pie draws the first series', ctx.pkChartConfig('pie', p, [], fmt).data.datasets.length === 1);
  // The figure types draw EXACTLY the payload's figures (analysis/chartShapes) — and nothing without them.
  const served = (type: string, labels: any[], series: Array<{ label: string; values: any[] }>, ask: any = {}) => ({ // any: a published payload
    labels, series, figures: chartShapes(type, { labels, series: series.map((x) => ({ name: x.label, values: x.values })) }, ask),
  });
  const pctPay = served('pct_stacked_column', ['a', 'b'], [{ label: 's1', values: [1, 2] }, { label: 's2', values: [2, 2] }]);
  const pctCfg = ctx.pkChartConfig('pct_stacked_column', pctPay, [], fmt);
  ok('core: a 100% stacked bar is the payload\'s unrounded share', pctCfg.data.datasets.every((d: any, i: number) => d.data.every((v: number, j: number) => Object.is(v, pctPay.figures!.sharePct![i][j])))
    && Object.is(pctCfg.data.datasets[0].data[0], (1 / 3) * 100) && pctCfg.options.scales.y.max === 100);
  const wfPay = served('waterfall', ['Opening', 'Sales', 'Total', 'Refunds'], [{ label: 'x', values: [50, 20, 999, -9] }]);
  const wf = ctx.pkChartConfig('waterfall', wfPay, [], fmt);
  ok('core: a waterfall draws the payload\'s steps — the Total row a total from 0, then a closing Total (the /p/ bug, fixed)',
    JSON.stringify(wf.data.datasets[0].data) === '[[0,50],[50,70],[0,999],[999,990],[0,990]]' && JSON.stringify(wf.data.labels) === '["Opening","Sales","Total","Refunds","Total"]'
    && JSON.stringify(wf.src) === '[0,1,2,3,-1]', JSON.stringify([wf.data, wf.src]));
  const bridge = ctx.pkChartConfig('waterfall', served('waterfall', ['East', 'West'], [{ label: '2023', values: [10, 20] }, { label: '2024', values: [15, 12] }]), [], fmt);
  ok('core: two series are the bridge the app draws', JSON.stringify(bridge.data.datasets[0].data) === '[[0,30],[30,35],[35,27],[0,27]]' && JSON.stringify(bridge.data.labels) === '["2023","East","West","2024"]');
  const parPay = served('pareto', ['C', 'A', 'D', 'B'], [{ label: 'v', values: [10, 50, -5, 35] }]);
  const par = ctx.pkChartConfig('pareto', parPay, [], fmt);
  ok('core: a Pareto is sorted and its line is over the positive values (the two /p/ bugs, fixed)',
    JSON.stringify(par.data.labels) === '["A","B","C","D"]' && JSON.stringify(par.data.datasets[0].data) === '[50,35,10,-5]'
    && par.data.datasets[1].data === parPay.figures!.pareto!.cumPct && par.data.datasets[1].data[3] === 100 && JSON.stringify(par.src) === '[1,3,0,2]', JSON.stringify(par.data));
  const hist = ctx.pkChartConfig('histogram', served('histogram', [0, 1, 2], [{ label: 'n', values: [1, 1, 9] }]), [], fmt);
  ok('core: a histogram draws the payload\'s bins, as the app does (not its series as bars)', JSON.stringify(hist.data.datasets[0].data) === JSON.stringify(chartShapes('histogram', { labels: [0, 1, 2], series: [{ name: 'n', values: [1, 1, 9] }] })!.histogram![0].map((b) => b.count)));
  ok('core: without its figures a figure type is not drawn — the card says so; it never works them out',
    ['waterfall', 'pareto', 'pct_stacked_column', 'pct_stacked_bar', 'histogram'].every((t) => ctx.pkChartConfig(t, p, [], fmt) === null) && ctx.pkChartConfig('column', p, [], fmt) !== null);
  ok('core: a month axis is named as the app names it', JSON.stringify(ctx.pkChartConfig('column', { labels: ['2024-01-01', '2024-02-01'], series: [{ label: 'v', values: [1, 2] }] }, [], fmt, (l: string[]) => l.map((x) => x.slice(0, 7))).data.labels) === '["2024-01","2024-02"]');
  ok('core: plugin types render as a table, maps and pivots as themselves',
    ctx.pkRenderKind('treemap') === 'table' && ctx.pkRenderKind('map_choropleth') === 'map' && ctx.pkRenderKind('pivot') === 'pivot' && ctx.pkRenderKind('line') === 'chart');
  const tm = ctx.pkTableModel(p, 'cat');
  ok('core: the table model is label × series', JSON.stringify(tm.head) === '["cat","s1","s2"]' && JSON.stringify(tm.rows[1]) === '["b",3,1]');
  const ny = ctx.pkAlbersUsa(-74, 40.7);
  const la = ctx.pkAlbersUsa(-118.2, 34);
  const ak = ctx.pkAlbersUsa(-150, 61);
  const hi = ctx.pkAlbersUsa(-157.8, 21.3);
  ok('core: Albers USA — New York east of Los Angeles', ny[0] > la[0]);
  // d3's layout: Alaska's inset sits under California, Hawaii's under Arizona —
  // both south of Los Angeles, Alaska further west than Hawaii.
  ok('core: Alaska and Hawaii are insets below the lower 48, Alaska west of Hawaii',
    ak[1] > la[1] && hi[1] > la[1] && ak[0] < hi[0] && ak[0] < 0 && hi[0] > la[0] && hi[0] < ny[0]);
  ok('core: Albers USA covers the states and leaves territories off the map',
    ctx.pkUsaCovers(-74, 40.7) && ctx.pkUsaCovers(-150, 61) && ctx.pkUsaCovers(-157.8, 21.3) && !ctx.pkUsaCovers(-66.5, 18.2));
  ok('core: a feature is placed by its first vertex', JSON.stringify(ctx.pkFirstPoint({ type: 'MultiPolygon', coordinates: [[[[1, 2], [3, 4]]]] })) === '[1,2]');
  // The phone (docs/phone-dashboards): tiles in the phone layout's order, KPI runs folded into strips.
  const cell = (x: number, y: number) => ({ phone: { x, y, w: 1, h: 2 } });
  // A published card has no id (sanitize.ts): the fold names cards by their index in the sheet.
  const blocks = (cards: any[]) => JSON.stringify(ctx.pkPhoneBlocks(cards.map(({ id: _id, ...c }) => c))); // any: published cards
  ok('phone: a run of KPIs is one strip, a chart after it a card',
    blocks([{ id: 'c', kind: 'chart', layout: { x: 0, y: 2 }, sizes: { phone: { x: 0, y: 4, w: 2, h: 6 } } },
      { id: 'a', kind: 'metric', layout: { x: 0, y: 0 }, sizes: cell(0, 0) }, { id: 'b', kind: 'metric', layout: { x: 3, y: 0 }, sizes: cell(1, 0) }])
      === JSON.stringify([{ kind: 'strip', at: [1, 2] }, { kind: 'card', at: 0 }]));
  ok('phone: a lone KPI stays a card; a chart between two KPIs splits them',
    blocks([{ id: 'a', kind: 'metric', layout: { x: 0, y: 0 }, sizes: cell(0, 0) }, { id: 'c', kind: 'chart', layout: { x: 0, y: 1 }, sizes: cell(0, 2) },
      { id: 'b', kind: 'metric', layout: { x: 0, y: 5 }, sizes: cell(0, 8) }])
      === JSON.stringify([{ kind: 'card', at: 0 }, { kind: 'card', at: 1 }, { kind: 'card', at: 2 }]));
  ok('phone: the PHONE cell orders (an edited phone order wins over the desktop grid); hidden cards are left out; no cell goes last',
    blocks([{ id: 'late', kind: 'text', layout: { x: 0, y: 0 } }, { id: 'a', kind: 'chart', layout: { x: 0, y: 0 }, sizes: cell(0, 9) },
      { id: 'b', kind: 'chart', layout: { x: 0, y: 9 }, sizes: cell(0, 0) }, { id: 'gone', kind: 'metric', layout: { x: 0, y: 1 }, sizes: { phone: { hidden: true } } }])
      === JSON.stringify([{ kind: 'card', at: 2 }, { kind: 'card', at: 1 }, { kind: 'card', at: 0 }]));
  ok('phone: an empty sheet folds to nothing', blocks([]) === '[]');
  const phoneMq = `(max-width: ${BREAKPOINTS.phone + 39}px)`;
  ok('phone: the client\'s breakpoint is the stylesheet\'s, to the pixel',
    assets.phoneJs.includes(`'${phoneMq}'`) && sizeCss().includes(`@media ${phoneMq}`) && !assets.phoneJs.includes(`(max-width: ${BREAKPOINTS.phone + 40}px)`));
  ok('phone: outside the phone media query its elements are only ever hidden', phoneLeaks(sizeCss()).length === 0, phoneLeaks(sizeCss()).join(' | '));
  ok('phone: …and the check sees a leak (negative control)', phoneLeaks('.pub-kpis { display: flex; } @media (max-width: 1px) { .pub-sheet { color: red; } }').length === 1);
  ok('phone: the page inlines the phone script before the client that calls it',
    inline.indexOf(assets.phoneJs) > inline.indexOf(assets.coreJs) && inline.indexOf(assets.phoneJs) < inline.indexOf(assets.clientJs) && assets.phoneJs.length > 1000);
  ok('core: a polygon becomes an SVG path', /^M[\d.-]+,[\d.-]+L/.test(ctx.pkPathD({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10]]] }, ctx.pkWorld, 100, 0, 0)));

  // ── 4. A real publish ───────────────────────────────────────────────────────
  await projects.init();
  const proj = await projects.createProject('Publish test');
  const rows: any[][] = []; // any: fixture rows
  for (let i = 0; i < 600; i++) rows.push(['region' + (i % 3), String(i % 5).padStart(3, '0'), (i % 17) - 3]);
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Sales', sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'sku', type: 'text' }, { name: 'amount', type: 'number' }], rows,
  });
  const v = await visuals.saveVisual(proj.id, { datasetId: ds!.id, name: 'By sku', chartType: 'column', encoding: { category: 'sku', values: [{ column: 'amount', aggregation: 'sum' }] } } as any);
  const { randomUUID } = crypto;
  const dash = await analysis.saveAnalysis(proj.id, {
    name: 'Sales overview',
    sheets: [{ id: randomUUID(), name: 'Main', cards: [
      { id: randomUUID(), type: 'control', layout: { x: 0, y: 0, w: 3, h: 1 }, control: { kind: 'dropdown', label: 'Region', datasetId: ds!.id, column: 'region' } },
      { id: randomUUID(), type: 'visual', visualId: v!.id, layout: { x: 0, y: 1, w: 6, h: 4 } },
      { id: randomUUID(), type: 'metric', metric: { datasetId: ds!.id, column: 'amount', aggregation: 'sum', label: 'Total' }, layout: { x: 6, y: 1, w: 3, h: 2 } },
      { id: randomUUID(), type: 'text', heading: 'Notes', text: 'Hello', layout: { x: 9, y: 1, w: 3, h: 2 } },
    ] }],
  } as any); // any: a record literal the saver sanitizes
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-site-'));
  fs.writeFileSync(path.join(out, 'my-notes.txt'), 'not ours');
  const cfg = pub.sanitizePublishConfig({ projectId: proj.id, dashboardIds: [dash!.id], storyIds: [], outDir: out, options: { title: 'Acme site' } });
  ok('config: a valid config sanitizes', !('error' in cfg));
  ok('config: no targets / relative folder / disk root are refused',
    'error' in pub.sanitizePublishConfig({ projectId: proj.id, dashboardIds: [], outDir: out })
    && 'error' in pub.sanitizePublishConfig({ projectId: proj.id, dashboardIds: [dash!.id], outDir: 'relative/dir' })
    && 'error' in pub.sanitizePublishConfig({ projectId: proj.id, dashboardIds: [dash!.id], outDir: path.parse(out).root }));
  if ('error' in cfg) { finish(); return; }

  const plan = await pub.planPublish(cfg);
  ok('plan: 1 dashboard, "All" + 3 regions = 4 combinations', plan.pages.length === 1 && plan.combos === 4 && plan.pages[0].mode === 'all', plan.summary);
  ok('plan: the summary line reads the way the dialog shows it', /^4 control combinations · [\d.]+ (KB|MB)$/.test(plan.summary), plan.summary);
  ok('plan: comfortably under the limit', !plan.tooBig && plan.bytes < plan.maxBytes);

  const progress: number[] = [];
  const res = await pub.publishSite(cfg, { progress: (f) => progress.push(f) });
  const files = fs.readdirSync(out).sort();
  ok('publish: index.html, one page per dashboard, manifest.json', JSON.stringify(files) === '["index.html","manifest.json","my-notes.txt","sales-overview.html"]', files.join(','));
  ok('publish: progress reaches 1 and never goes back', progress[progress.length - 1] === 1 && progress.every((x, i) => i === 0 || x >= progress[i - 1]));
  const onDisk = res.files.reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
  ok('size: the reported bytes are the bytes on disk', onDisk === res.bytes, `${onDisk} vs ${res.bytes}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  ok('manifest: format, version, pages and totals', manifest.format === 'ordinate-site' && manifest.version === 1 && manifest.pages[0].combos === 4 && manifest.offline === true);
  const page = dataBlock(fs.readFileSync(path.join(out, 'sales-overview.html'), 'utf8'));
  ok('page: the data block parses', !!page && page.kind === 'dashboard');
  ok('page: the filter bar lists All + the three regions', JSON.stringify(page.dashboard.controls[0].options) === '["All","region0","region1","region2"]');
  const card = page.dashboard.sheets[0].cards.find((c: any) => c.kind === 'chart');
  const kpi = page.dashboard.sheets[0].cards.find((c: any) => c.kind === 'metric');
  ok('page: one chart, one KPI and the text card; the control is the filter bar, not a tile',
    !!card && !!kpi && page.dashboard.sheets[0].cards.length === 3);
  // DIFFERENTIAL: every combination's chart answer is exactly what the app computes directly.
  let same = true;
  for (let k = 0; k < page.dashboard.keys.length; k++) {
    const opt = page.dashboard.controls[0].options[Number(page.dashboard.keys[k])];
    const filters = opt === 'All' ? [] : [{ type: 'filter', column: 'region', op: '=', value: opt }];
    const direct: any = await vizDataFor(proj.id, ds!.id, sanitizeEncoding(v!.encoding), filters as any); // any: FilterStep literal
    const shown = card.payloads[card.variants[k]];
    if (!direct.ok || JSON.stringify(shown.labels) !== JSON.stringify(direct.data.labels)
      || shown.series[0].label !== direct.data.series[0].name
      || !shown.series[0].values.every((x: number, i: number) => Object.is(x, direct.data.series[0].values[i]))) same = false;
  }
  ok('differential: every combination\'s chart — labels, series names, values — equals a direct vizDataFor answer (Object.is)', same);
  ok('page: series carry their names for the legend and tooltips', card.payloads[0].series[0].label === 'sum of amount', card.payloads[0].series[0].label);
  const total = rows.reduce((n, r) => n + r[2], 0);
  ok('page: the KPI for "All" is the app\'s figure', kpi.payloads[kpi.variants[0]].value === total, kpi.payloads[kpi.variants[0]].value);
  ok('page: every tile answer carries the app\'s caption', typeof card.payloads[0].caption === 'string' && card.payloads[0].caption.length > 10);

  // Re-publish with a renamed dashboard: the old page goes, the user's file stays.
  await analysis.updateAnalysis(proj.id, dash!.id, { name: 'Renamed board' } as any); // any: a partial patch
  await pub.publishSite(cfg);
  const after = fs.readdirSync(out).sort();
  ok('re-publish: replaces its own files and removes the page it no longer writes',
    after.includes('renamed-board.html') && !after.includes('sales-overview.html'));
  ok('re-publish: never touches a file it did not write', after.includes('my-notes.txt'));

  // The limit refuses BEFORE writing anything.
  pub.setMaxBytesForTest(10_000);
  const before = fs.readdirSync(out).map((f) => f + ':' + fs.statSync(path.join(out, f)).mtimeMs).join('|');
  let refused = '';
  try { await pub.publishSite(cfg); } catch (e: any) { refused = String(e && e.message); }
  ok('limit: an oversize site is refused with what to drop', /over the .* limit/.test(refused) && /Renamed board/.test(refused), refused);
  ok('limit: …and nothing in the folder changed', fs.readdirSync(out).map((f) => f + ':' + fs.statSync(path.join(out, f)).mtimeMs).join('|') === before);
  const tooBig = await pub.planPublish(cfg);
  ok('limit: the plan says so up front, with suggestions', tooBig.tooBig && tooBig.suggestions.length > 0 && tooBig.suggestions.some((s) => /Region/.test(s)), tooBig.suggestions.join(' / '));
  pub.setMaxBytesForTest(0);

  // The Share policy applies INSIDE the engine (feature 3): a column marked
  // sensitive is masked on the publish path — labels become tokens and the
  // caption is written from the tokens — or the tile is dropped.
  const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
  const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
  await catalog.setColumn(proj.id, ds!.id, 'sku', { sensitivity: 'personal' } as any); // any: a ColumnPatch literal
  await pub.publishSite(cfg);
  const masked = dataBlock(fs.readFileSync(path.join(out, 'renamed-board.html'), 'utf8'));
  const mcard = masked.dashboard.sheets[0].cards.find((c: any) => c.kind === 'chart');
  const shownLabels: string[] = mcard.payloads[mcard.variants[0]].labels.map(String);
  const rawSkus = ['000', '001', '002', '003', '004'];
  ok('policy: a sensitive category is published as tokens, never its values',
    shownLabels.length === 5 && shownLabels.every((l) => !rawSkus.includes(l)), shownLabels.join(','));
  ok('policy: …and the caption names tokens, not the raw values',
    // The tokens themselves (#<12 hex>) are random and can contain "000" — read the caption around them.
    !rawSkus.some((v) => String(mcard.payloads[mcard.variants[0]].caption).replace(/#[0-9a-f]{12}/g, '#token').includes(v)), mcard.payloads[mcard.variants[0]].caption);
  const salt = await privacy.getSalt(proj.id);
  const siteText = fs.readdirSync(out).map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
  ok('policy: the project salt never reaches a published file', !!salt && !siteText.includes(String(salt)));
  await privacy.setPolicy(proj.id, { publish: 'drop' });
  await pub.publishSite(cfg);
  const dropped = dataBlock(fs.readFileSync(path.join(out, 'renamed-board.html'), 'utf8'));
  const dcard = dropped.dashboard.sheets[0].cards.find((c: any) => c.kind === 'chart');
  ok('policy: drop hides the tile, saying why', dcard.payloads.every((p: any) => p.hidden === 'Hidden by the share policy'));
  await privacy.setPolicy(proj.id, { publish: 'include' });
  await pub.publishSite(cfg);
  const included = dataBlock(fs.readFileSync(path.join(out, 'renamed-board.html'), 'utf8'));
  const icard = included.dashboard.sheets[0].cards.find((c: any) => c.kind === 'chart');
  ok('policy: include (confirmed in the dialog) publishes the values',
    icard.payloads[icard.variants[0]].labels.map(String).every((l: string) => rawSkus.includes(l)));
  await privacy.setPolicy(proj.id, { publish: 'mask' });
  await catalog.setColumn(proj.id, ds!.id, 'sku', { sensitivity: 'none' } as any); // any: a ColumnPatch literal

  const single = await pub.dashboardPageHtml(proj.id, dash!.id);
  const one = dataBlock(single);
  ok('dashboardPageHtml: one self-contained page, default state only', one.kind === 'dashboard' && one.dashboard.keys.length === 1 && /default-src 'none'/.test(single));

  await pub.storeConfig(cfg);
  const back = await pub.getStoredConfig(proj.id);
  ok('re-publish memory: the stored config round-trips', !!back && back.outDir === out && back.dashboardIds[0] === dash!.id && back.options.title === 'Acme site');

  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(tmpUserData, { recursive: true, force: true });
  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
