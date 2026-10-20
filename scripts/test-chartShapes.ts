// The figures a chart draws, computed once on the server (docs/chart-figures/00-design.md):
//
//   goldens   src/analysis/chartShapes.ts against what the in-app chart answered
//             before the math moved (web/src/charts/__golden__/shapes.json, over
//             scripts/fixtures/figureCases.ts), Object.is on every number. A
//             100%-stacked share and a funnel's or bullet's percent are unrounded
//             now: each rounds to the whole percent the chart used to draw
//   /p/ bugs  the published page's own copy got three things wrong: it drew a
//             Pareto in arrival order, let negatives drag the cumulative line, and
//             drew a Total row as one more step. Pinned as fixed, in the figures
//   doors     every door that draws one of these types — visual:data, dataBatch,
//             preview, thumbs, analysis:tiles, the Ask card, the published page,
//             the plan preview, a capture — on an EXTRACT and on a LIVE dataset:
//             the reply's figures equal chartShapes over the reply's own series
//             (attached last); a type without figures carries none
//   controls  a deliberately wrong reference fails the golden check; a reply that
//             skipped withFigures fails the door check
//
//   npm run build:ts && node scripts/test-chartShapes.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { BULLET, CALENDAR, FUNNEL, HISTOGRAM, PARETO, SHARES, WATERFALL } from './fixtures/figureCases';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const { chartShapes, withChartFigures }: typeof import('../src/analysis/chartShapes') = require('../src/analysis/chartShapes');
const { figureAsk, FIGURE_TYPES }: typeof import('../src/analysis/figureAsk') = require('../src/analysis/figureAsk');
const { formatCompact }: typeof import('../src/app/format') = require('../src/app/format');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const dashData: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const planPreview: typeof import('../src/analysis/planPreview') = require('../src/analysis/planPreview');
const capture: typeof import('../src/app/captureUpload') = require('../src/app/captureUpload');
const subscriptionFigures: typeof import('../src/ipc/subscriptionFigures') = require('../src/ipc/subscriptionFigures');

type Any = any; // golden shapes and replies, read field by field
const G = wire.decode(fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'charts', '__golden__', 'shapes.json'), 'utf8')) as Record<string, Record<string, Any>>;
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x));

/** Deep equality with Object.is at every leaf — the house rule. The first difference, or ''. */
function diff(a: unknown, b: unknown, at = '$'): string {
  if (Object.is(a, b)) return '';
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = diff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return '';
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (show(ka) !== show(kb)) return `${at}: keys ${show(ka)} vs ${show(kb)}`;
    for (const k of ka) { const d = diff((a as Any)[k], (b as Any)[k], `${at}.${k}`); if (d) return d; }
    return '';
  }
  return `${at}: ${show(a)} vs ${show(b)}`;
}

// ── 1. The goldens ────────────────────────────────────────────────────────────

/** The waterfall's recorded shape, as a list of the server's steps (base→start, delta→value, running→end). */
function waterfallProblem(c: (typeof WATERFALL)[number], g: Any): string {
  const f = chartShapes('waterfall', { labels: c.labels, series: c.series }, { waterfallTotals: c.totals });
  if (!f) return g.kind.length ? 'no figures where the chart drew steps' : '';
  const w = f.waterfall!;
  const want = { from: g.from, to: g.to, steps: g.kind.map((kind: string, i: number) => ({ label: g.labels[i], start: g.base[i], end: g.running[i], value: g.delta[i], kind, src: g.src[i] })) };
  return diff(w, want);
}
function paretoProblem(c: (typeof PARETO)[number], g: Any): string {
  const f = chartShapes('pareto', { labels: c.labels, series: [{ name: 'v', values: c.values }] });
  if (!f) return g.src.length ? 'no figures where the chart drew bars' : '';
  const positives = g.values.filter((v: number | null) => v !== null && v > 0).length;
  return diff(f.pareto, { order: g.src, cumPct: g.cumPct, count80: g.count80, total: g.total, positives });
}
/** A percent the chart printed, read back out of its tooltip text ("420 (42% of top)" → 42), or null. */
const printedPct = (text: string): number | null => {
  const m = /\((-?\d+)%/.exec(text);
  return m ? Number(m[1]) : null;
};
const rounded = (v: number | null): number | null => (v === null ? null : Math.round(v));

for (const c of WATERFALL) {
  const p = waterfallProblem(c, G.waterfall[c.name]);
  ok(`golden waterfall (${c.name}): every step's start, end, value, kind and label, and the ends`, !p, p);
}
for (const c of PARETO) {
  const p = paretoProblem(c, G.pareto[c.name]);
  ok(`golden Pareto (${c.name}): the order, the cumulative %, the 80% count, the total`, !p, p);
}
for (const c of SHARES) {
  const f = chartShapes('pct_stacked_column', { labels: c.labels, series: c.series });
  const p = diff(f && f.sharePct!.map((row) => row.map((v) => Math.round(v))), G.shares[c.name]);
  ok(`golden 100%-stacked (${c.name}): each share rounds to the whole percent the chart drew`, !p, p);
}
{
  const thirds = chartShapes('pct_stacked_bar', { labels: ['a'], series: [{ name: 'x', values: [1] }, { name: 'y', values: [1] }, { name: 'z', values: [1] }] })!.sharePct!;
  ok('…and the shares are now unrounded: three thirds are 33.33…%, not 33%', thirds.every((r) => Object.is(r[0], (1 / 3) * 100)), show(thirds));
}
for (const c of HISTOGRAM) {
  const f = chartShapes('histogram', { labels: c.values.map((_, i) => i), series: [{ name: 'n', values: c.values }] });
  const bins = f ? f.histogram![0] : [];
  const labels = bins.map((b) => (b.from === b.to ? formatCompact(b.from) : `${formatCompact(b.from)}–${formatCompact(b.to)}`));
  const p = diff({ labels, counts: bins.map((b) => b.count) }, G.histogram[c.name]);
  ok(`golden histogram (${c.name}): the same bins, labelled the same, the same counts`, !p, p);
}
for (const c of FUNNEL) {
  const f = chartShapes('funnel', { labels: c.labels, series: [{ name: 'n', values: c.values }] })!;
  const p = diff(f.funnel!.ofTopPct[0].map(rounded), (G.funnel[c.name] as string[]).map(printedPct));
  ok(`golden funnel (${c.name}): each stage's % of the first, as the tooltip printed it`, !p, p);
}
for (const c of BULLET) {
  const f = chartShapes('bullet', { labels: c.labels, series: c.series }, { bulletTarget: c.target })!;
  const p = diff(f.bullet!.ofTargetPct.map(rounded), (G.bullet[c.name] as string[]).map(printedPct));
  ok(`golden bullet (${c.name}): each row's % of its target, as the tooltip printed it`, !p, p);
}
for (const c of CALENDAR) {
  const f = chartShapes('calendar', { labels: c.labels, series: [{ name: 'v', values: c.values }] })!.calendar!;
  const g = G.calendar[c.name];
  const byDay = new Map(f.days.map((d, i) => [d, f.values[i]]));
  const iso = (d: number): string => new Date(d * 86400000).toISOString().slice(0, 10);
  if (g === null) {
    const span = f.days.length ? Math.max(...f.days) - Math.min(...f.days) : 0;
    ok(`golden calendar (${c.name}): nothing the chart could draw — no day, or a span it refuses`, f.days.length === 0 || span > 366 * 20, show(f));
    continue;
  }
  const cells: Array<{ date: string; v: number | null }> = g.cells;
  const p = cells.map((cell) => {
    const day = f.days.find((d) => iso(d) === cell.date);
    const v = day === undefined ? null : byDay.get(day);
    return Object.is(v, cell.v) ? '' : `${cell.date}: ${show(v)} vs ${show(cell.v)}`;
  }).filter(Boolean).concat(f.days.filter((d) => !cells.some((cell) => cell.date === iso(d))).map((d) => `${iso(d)} is not a day the chart drew`));
  ok(`golden calendar (${c.name}): one value per day, two labels on one day summed`, p.length === 0, p.join(' | '));
}
{
  // NEGATIVE CONTROL: the check fails a reference with one number moved.
  const g = structuredClone(G.waterfall['negatives']);
  g.running[1] += 1e-9;
  ok('control: a waterfall reference one hair off fails the golden check', !!waterfallProblem(WATERFALL[0], g));
  const gp = structuredClone(G.pareto['unsorted']);
  gp.src = [...gp.src].reverse();
  ok('control: a Pareto reference in another order fails it', !!paretoProblem(PARETO[0], gp));
}
ok('the goldens hold every case the fixtures name',
  ['waterfall', 'pareto', 'shares', 'histogram', 'funnel', 'bullet', 'calendar'].every((k) => Object.keys(G[k]).length > 0) &&
  Object.keys(G.waterfall).length === WATERFALL.length && Object.keys(G.pareto).length === PARETO.length && Object.keys(G.calendar).length === CALENDAR.length);

// ── 2. The published page's three wrong answers, fixed in the figures ─────────
{
  const p = chartShapes('pareto', { labels: ['C', 'A', 'D', 'B'], series: [{ name: 'v', values: [10, 50, 5, 35] }] })!.pareto!;
  ok('/p/ bug fixed — an unsorted Pareto is drawn largest first (A, B, C, D)', show(p.order) === '[1,3,0,2]' && show(p.cumPct) === show([50, 85, 95, 100]), show(p));
  const n = chartShapes('pareto', { labels: ['a', 'b', 'c'], series: [{ name: 'v', values: [60, -30, 40] }] })!.pareto!;
  ok('/p/ bug fixed — a negative never drags the cumulative line: it climbs to 100% and stays',
    n.cumPct.every((v, i) => i === 0 || v >= n.cumPct[i - 1]) && n.cumPct[1] === 100 && n.cumPct[2] === 100, show(n));
  const w = chartShapes('waterfall', { labels: ['Opening', 'Sales', 'Total'], series: [{ name: 'v', values: [50, 20, 999] }] })!.waterfall!;
  const total = w.steps[2];
  ok('/p/ bug fixed — a Total row is a total from 0 at its own value, not one more step on the running level',
    total.kind === 'total' && total.start === 0 && total.end === 999 && w.steps.length === 3 && w.to === 999, show(w));
  const b = chartShapes('waterfall', { labels: ['East', 'West'], series: [{ name: '2023', values: [10, 20] }, { name: '2024', values: [15, 12] }] })!.waterfall!;
  ok('…and two series are a bridge: last year\'s total → each change → this year\'s',
    show(b.steps.map((s) => [s.kind, s.start, s.end])) === show([['start', 0, 30], ['up', 30, 35], ['down', 35, 27], ['end', 0, 27]]), show(b));
}
{
  const kinds = [...FIGURE_TYPES].map((t) => [t, !!chartShapes(t, { labels: ['a'], series: [{ name: 'v', values: [1] }] })]);
  ok('every figure type has figures; a column chart has none', kinds.every(([, has]) => has) && chartShapes('column', { labels: ['a'], series: [{ name: 'v', values: [1] }] }) === null, show(kinds));
  ok('a prior-period overlay is not drawn by these types, so it is not in their figures',
    show(chartShapes('pct_stacked_column', { labels: ['a'], series: [{ name: 'x', values: [1] }, { name: 'prior', values: [3], role: 'overlay' } as Any] })!.sharePct) === '[[100]]');
  ok('figureAsk: only a figure type asks; the two overrides that change a figure travel with their own type only',
    figureAsk('column', {}) === null && show(figureAsk('waterfall', { waterfallTotals: ['T', 7], bulletTarget: 9, color: 'x' })) === show({ chartType: 'waterfall', waterfallTotals: ['T'] })
    && show(figureAsk('bullet', { bulletTarget: 9, waterfallTotals: ['T'] })) === show({ chartType: 'bullet', bulletTarget: 9 }) && figureAsk('bullet', { bulletTarget: Infinity })!.bulletTarget === undefined);
  const both = withChartFigures(withChartFigures({ labels: ['a', 'b'], series: [{ name: 'v', values: [2, 1] }] }, figureAsk('pareto')), figureAsk('waterfall')) as Any;
  ok('one table, several suggested types: the figures add up per family', !!both.figures.pareto && !!both.figures.waterfall);
}

// ── 3. Every door, on an extract and on a Live dataset ────────────────────────

/** What a door owes: the figures chartShapes gives over the reply's OWN series. '' when it pays. */
function doorProblem(data: Any, type: string, ask: Any = {}): string {
  if (!data || !Array.isArray(data.series)) return 'no chart';
  const want = chartShapes(type, data, ask);
  if (!want) return 'nothing to draw (the fixture should have rows)';
  return diff(data.figures, want);
}

(async () => {
  const s = await H.setupOrg(H.ORG_A);
  const P = s.projectId;
  const M = (column: string, aggregation: string) => ({ column, aggregation });
  const BY_CAT = { category: 'cat', values: [M('amt', 'sum')] };
  const SPLIT = { category: 'region', values: [M('amt', 'sum'), M('qty', 'sum')] };
  const WF_TOTALS = ['North'];

  for (const [kind, D] of [['extract', s.extractId], ['Live', s.liveId]] as const) {
    {
      const r = (await post('visual:data', { projectId: P, datasetId: D, encoding: BY_CAT, chartType: 'pareto' })).value;
      const p = doorProblem(r.data, 'pareto');
      ok(`visual:data (${kind}): a Pareto's figures are chartShapes over its own reply`, r.ok === true && !p, p || show(r).slice(0, 300));
    }
    {
      const r = (await post('visual:data', { projectId: P, datasetId: D, encoding: { category: 'region', values: [M('amt', 'sum')] }, chartType: 'waterfall', waterfallTotals: WF_TOTALS })).value;
      const p = doorProblem(r.data, 'waterfall', { waterfallTotals: WF_TOTALS });
      ok(`visual:data (${kind}): a waterfall's, its named total included`, r.ok === true && !p && r.data.figures.waterfall.steps.some((x: Any) => x.kind === 'total'), p || show(r.data && r.data.figures));
    }
    {
      const r = (await post('visual:dataBatch', { projectId: P, items: [{ datasetId: D, encoding: SPLIT, chartType: 'pct_stacked_column' }, { datasetId: D, encoding: BY_CAT }] })).value as unknown as Reply[];
      const p = doorProblem(r[0].data, 'pct_stacked_column');
      ok(`visual:dataBatch (${kind}): a 100%-stacked item carries its shares; a plain item carries no figures`, !p && r[1].ok === true && !('figures' in r[1].data), p || show(r[1].data));
    }
    {
      const r = (await post('visual:preview', { projectId: P, datasetId: D, encoding: BY_CAT, chartType: 'pareto' })).value;
      const p = doorProblem(r.data, 'pareto');
      ok(`visual:preview (${kind}): the builder's chart too`, r.ok === true && !p, p || show(r).slice(0, 300));
    }
    {
      const r = (await post('analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: D, encoding: SPLIT, chartType: 'pct_stacked_bar' }] })).value as unknown as Reply[];
      const p = doorProblem(r[0] && r[0].data, 'pct_stacked_bar');
      ok(`analysis:tiles (${kind}): a dashboard tile's`, !p, p || show(r).slice(0, 300));
    }
    {
      const v = await H.as(H.ORG_A, () => visuals.saveVisual(P, { name: `Bridge ${kind}`, datasetId: D, chartType: 'waterfall', encoding: { category: 'region', values: [M('amt', 'sum')] }, overrides: { waterfallTotals: WF_TOTALS }, filters: [] } as Any));
      const r = (await post('visual:thumbs', { projectId: P, ids: [v!.id] })).value as unknown as Reply[];
      const p = doorProblem(r[0] && r[0].data, 'waterfall', { waterfallTotals: WF_TOTALS });
      ok(`visual:thumbs (${kind}): a gallery thumbnail's, from the visual's stored type and overrides`, !p, p || show(r).slice(0, 300));
    }
    {
      const r = (await post('answer:card', { projectId: P, spec: { datasetId: D, category: 'region', series: 'cat', measures: [M('amt', 'sum')], filters: [], chartType: 'pct_stacked_column', title: 'Mix', top: 5 } })).value;
      const p = doorProblem(r.data, 'pct_stacked_column');
      ok(`answer:card (${kind}): the Ask card's`, r.ok === true && !p, p || show(r).slice(0, 300));
    }
  }

  // The published page and an embed (chartPayload), on both datasets; a column tile carries no figures.
  {
    const vids = await H.as(H.ORG_A, async () => {
      const mk = async (name: string, d: string, chartType: string, encoding: Any, overrides?: Any) => (await visuals.saveVisual(P, { name, datasetId: d, chartType, encoding, overrides, filters: [] } as Any))!.id;
      return [
        await mk('Pareto x', s.extractId, 'pareto', BY_CAT), await mk('Pareto L', s.liveId, 'pareto', BY_CAT),
        await mk('Bridge x', s.extractId, 'waterfall', { category: 'region', values: [M('amt', 'sum')] }, { waterfallTotals: WF_TOTALS }),
        await mk('Mix L', s.liveId, 'pct_stacked_column', SPLIT), await mk('Plain', s.extractId, 'column', BY_CAT),
      ];
    });
    const types = ['pareto', 'pareto', 'waterfall', 'pct_stacked_column', 'column'];
    const a = await H.as(H.ORG_A, () => analysis.saveAnalysis(P, {
      name: 'Figures board',
      sheets: [{ id: 's1', name: 'S', cards: vids.map((id, i) => ({ id: `c${i}`, type: 'visual', visualId: id, layout: { x: 0, y: i * 4, w: 12, h: 4 } })) }],
    } as Any));
    const d = await H.as(H.ORG_A, () => dashData.buildDashboard(P, a!.id, 4));
    const cards = d!.sheets[0].cards as Any[];
    const problems = cards.map((c, i) => {
      const payload = c.payloads[c.variants[0]];
      const data = { labels: payload.labels, series: payload.series.map((x: Any) => ({ name: x.label, values: x.values })), figures: payload.figures };
      if (types[i] === 'column') return 'figures' in payload ? 'a column tile carries figures' : '';
      return doorProblem(data, types[i], types[i] === 'waterfall' ? { waterfallTotals: WF_TOTALS } : {});
    }).filter(Boolean);
    ok('the published page (and an embed, the same build): every tile\'s figures are chartShapes over the page\'s own series', problems.length === 0, problems.join(' | '));
  }
  // The Assistant's plan preview, and a capture's suggested charts.
  {
    const pv = await H.as(H.ORG_A, () => planPreview.previewPlan(P, {
      name: 'Plan', sheets: [{ name: 'S', visuals: [{ dataset: 'Fixture copy', name: 'Concentration', chartType: 'pareto', encoding: BY_CAT }] }],
    }));
    const v = pv.ok ? pv.sheets[0].visuals[0] : null;
    const p = v ? doorProblem(v.data, 'pareto') : 'no preview';
    ok('the plan preview: the chart the review shows carries its figures', !p, p || show(pv).slice(0, 300));
    const view = capture.viewOf({
      id: 'x', result: {
        extractedTable: {
          columns: [{ id: 'region', label: 'Region', role: 'dimension', type: 'text' }, { id: 'sales', label: 'Sales', role: 'measure', type: 'number' }],
          rows: [{ region: 'North', sales: 30 }, { region: 'South', sales: 50 }, { region: 'East', sales: 20 }],
        },
        dataShape: 'categorical', columnRoles: { category: 'region', primaryValue: 'sales' },
        visualizations: [{ type: 'pareto' }, { type: 'waterfall' }, { type: 'column' }],
      },
    });
    const both = view.chart as Any;
    const pp = doorProblem({ ...both, figures: { pareto: both.figures && both.figures.pareto } }, 'pareto');
    const pw = doorProblem({ ...both, figures: { waterfall: both.figures && both.figures.waterfall } }, 'waterfall');
    ok('a capture: one table, the figures of every suggested type that has them', !pp && !pw && Object.keys(both.figures || {}).length === 2, pp || pw || show(both));
  }
  // A subscription (Slack, Teams, email): its visual card through `visual:data`, and its caption from those figures.
  {
    const vid = await H.as(H.ORG_A, async () => (await visuals.saveVisual(P, { name: 'Sent bridge', datasetId: s.extractId, chartType: 'waterfall',
      encoding: { category: 'region', values: [M('amt', 'sum')] }, overrides: { waterfallTotals: WF_TOTALS }, filters: [] } as Any))!.id);
    const a = await H.as(H.ORG_A, () => analysis.saveAnalysis(P, { name: 'Sent', sheets: [{ id: 's1', name: 'S', cards: [{ id: 'c1', type: 'visual', visualId: vid, layout: { x: 0, y: 0, w: 12, h: 4 } }] }] } as Any));
    const sent = await H.as(H.ORG_A, () => subscriptionFigures.resolveFigures(P, a!, null, null));
    const v = sent.visuals[0] as Any;
    const p = doorProblem(v && v.data, 'waterfall', { waterfallTotals: WF_TOTALS });
    ok('a subscription\'s waterfall carries its figures, its named total included, and its caption reads them', !p && /steps? takes?/.test(String(v.caption)), p || show(v).slice(0, 300));
  }
  // Every server-side call of `visual:data` names what it draws (src/analysis/figureAsk.ts). Enumerated, not listed:
  // a new door that forgets is a failure here.
  {
    const askless = (src: string, file: string): string[] => {
      const out: string[] = [];
      for (const m of src.matchAll(/(?:call\((?:e|event)?,?\s*|handlers\.get\()'visual:data'/g)) {
        // The call's own text: from the match to the end of its statement (a handler fetched by name is called just below).
        const from = m.index as number;
        const end = src.indexOf(');', src.indexOf(m[0].startsWith('handlers') ? 'data(e,' : '{', from));
        if (!src.slice(from, end).includes('figureAsk(')) out.push(`${file}:${src.slice(0, from).split('\n').length}`);
      }
      return out;
    };
    const roots = ['src/ipc', 'src/publish', 'src/analysis', 'src/server', 'src/app', 'src/automation'];
    const files = roots.flatMap((d) => fs.readdirSync(path.join(__dirname, '..', d)).filter((f) => f.endsWith('.ts')).map((f) => path.join(d, f)));
    const calls = files.flatMap((f) => askless(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), f));
    const scanned = files.filter((f) => /'visual:data'/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))).length;
    ok('every server-side call of visual:data asks for the figures of what it draws', calls.length === 0 && scanned >= 5, `${calls.join(', ')} (${scanned} files)`);
    ok('…and the scan sees one that does not (negative control)', askless("const r = await call(e, 'visual:data', { projectId, datasetId });", 'planted.ts').length === 1);
  }
  // Small multiples: every panel of a faceted figure-type chart carries its own.
  {
    const r = (await post('visual:data', { projectId: P, datasetId: s.extractId, encoding: { ...BY_CAT, facet: { rows: 'region' } }, chartType: 'pareto' })).value;
    const panels: Any[] = r.ok && r.data.facets ? r.data.facets.panels : [];
    const p = panels.map((x) => doorProblem(x, 'pareto')).filter(Boolean);
    ok('small multiples: each panel\'s figures are chartShapes over that panel', panels.length > 1 && p.length === 0, p.join(' | ') || show(r).slice(0, 300));
  }
  // NEGATIVE CONTROL: a door that skipped withFigures (or ran it before a step that changed the series) fails.
  {
    const r = (await post('visual:data', { projectId: P, datasetId: s.extractId, encoding: BY_CAT, chartType: 'pareto' })).value;
    const skipped = { ...r.data, figures: undefined };
    const stale = { ...r.data, series: [{ ...r.data.series[0], values: r.data.series[0].values.map((v: number) => v * 2) }] };
    const plain = (await post('visual:data', { projectId: P, datasetId: s.extractId, encoding: BY_CAT })).value;
    ok('control: a reply without figures fails the door check', !!doorProblem(skipped, 'pareto'));
    ok('control: figures computed before the series changed fail it too', !!doorProblem(stale, 'pareto') || show(stale.figures) !== show(chartShapes('pareto', stale)));
    ok('control: without a chartType the same request carries no figures', plain.ok === true && !('figures' in plain.data));
  }

  await close();
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
