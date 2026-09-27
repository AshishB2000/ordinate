// Analytics overlays — the pure maths behind the builder's Analytics pane.
//
// Every expected figure below is written out by hand (the arithmetic is in the
// comment beside it), because analysis/analytics.ts is the ONLY place these
// numbers are made: the renderer draws what it returns, captions and the
// Assistant's facts narrate it. Groups:
//
//   1. sanitize — the whitelist a stored / renderer-supplied list goes through
//   2. statistics, OLS, moving average, highlight — the building blocks
//   3. forecasts — linear, seasonal naive, Holt-Winters, season detection,
//      the future axis, interior gaps
//   4. resolution — every kind end to end, metrics, warnings
//   5. parity — main's OVERLAY_ACCEPT against the renderer's chartTypeSpec.js,
//      run in a vm, for every chart id
//   6. narration — the caption clauses and the facts ledger (every printed
//      figure is in the ledger — the number audit passes on it)
//
//   npm run build:ts && node scripts/test-analytics.js

export {}; // module scope — sibling scripts share top-level names
import { ok, finish } from './selfcheck';
import {
  sanitizeOverlays, statOf, linearFit, movingAverage, highlightIndices, resolveOverlays,
  OVERLAY_ACCEPT, overlayAccepted, analyticsClauses, overlayFacts, mean, stdev,
} from '../src/analysis/analytics';
import { forecastSeries, detectSeason, fitSeries, futureLabels, stepGrainOf, autocorrelation } from '../src/analysis/forecast';
import { tileCaption } from '../src/analysis/captions';
import { visualFacts } from '../src/ai/copilotFacts';
import { auditNumbers } from '../src/ai/numberAudit';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const vm: typeof import('vm') = require('vm');

const close = (a: number | null | undefined, b: number, eps = 1e-9): boolean =>
  typeof a === 'number' && Math.abs(a - b) <= eps;
const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── 1. sanitize ──────────────────────────────────────────────────────────────

{
  const out = sanitizeOverlays([
    { id: 'a', kind: 'reference', value: { type: 'stat', stat: 'median' }, color: '#FF0000', label: '  Mid  ' },
    { id: 'a', kind: 'trend' },                                   // duplicate id → dropped
    { id: 'b', kind: 'sparkle' },                                 // unknown kind → dropped
    { id: '../x', kind: 'trend' },                                // bad id → dropped
    { id: 'c', kind: 'target', value: { type: 'metric', metricId: 'not-a-uuid' } }, // bad metric → default constant 0
    { id: 'd', kind: 'band' },                                    // no edges → mean ± 1σ
    { id: 'e', kind: 'moving_average', window: 999 },             // out of range → 3
    { id: 'f', kind: 'forecast', method: 'prophet', horizon: 0, season: 5 }, // → linear, 3, auto
    { id: 'g', kind: 'annotation', at: 'Jan' },                   // no text → dropped
    { id: 'h', kind: 'highlight', rule: 'above', threshold: 50, n: 4 }, // above keeps threshold, drops n
    { id: 'i', kind: 'reference', value: { type: 'stat', stat: 'percentile', p: 250 } }, // p out of range → 90
    { id: 'j', kind: 'trend', color: 'red', series: 2, hidden: true },
  ]);
  ok('sanitize: keeps valid, drops unknown kinds / bad or duplicate ids / empty annotations',
    out.map((o) => o.id).join(',') === 'a,c,d,e,f,h,i,j', out.map((o) => o.id).join(','));
  const a = out[0];
  ok('sanitize: label trimmed, colour lower-cased, source kept',
    a.label === 'Mid' && a.color === '#ff0000' && a.value?.type === 'stat' && (a.value as any).stat === 'median');
  ok('sanitize: an invalid metric id falls back to a constant target', JSON.stringify(out[1].value) === '{"type":"constant","value":0}');
  ok('sanitize: a band with no edges is mean ± 1σ', out[2].sd === 1);
  ok('sanitize: window clamped to its default', out[3].window === 3);
  ok('sanitize: forecast method / horizon / season defaulted',
    out[4].method === 'linear' && out[4].horizon === 3 && out[4].season === 'auto');
  ok('sanitize: highlight "above" carries a threshold and no n', out[5].threshold === 50 && out[5].n === undefined);
  ok('sanitize: percentile out of range → 90', (out[6].value as any).p === 90);
  ok('sanitize: bad colour dropped, series and hidden kept', out[7].color === undefined && out[7].series === 2 && out[7].hidden === true);
  ok('sanitize: not an array → []', sanitizeOverlays('nope').length === 0 && sanitizeOverlays(null).length === 0);
  const many = sanitizeOverlays(Array.from({ length: 40 }, (_, i) => ({ id: 'o' + i, kind: 'trend' })));
  ok('sanitize: capped at 24 overlays', many.length === 24);
  ok('sanitize: a metric source needs a UUID',
    sanitizeOverlays([{ id: 'm', kind: 'reference', value: { type: 'metric', metricId: ID(1) } }])[0].value?.type === 'metric');
}

// ── 2. building blocks ───────────────────────────────────────────────────────

{
  const v = [4, 1, null, 100, 3, 2, 'x'];
  // finite: 4,1,100,3,2 → sum 110 / 5 = 22; sorted 1,2,3,4,100 → median 3;
  // p90: pos 0.9·4 = 3.6 → 4 + 0.6·(100 − 4) = 61.6
  ok('stat: average skips nulls and text', close(statOf(v, 'avg'), 22));
  ok('stat: median', close(statOf(v, 'median'), 3));
  ok('stat: min / max', statOf(v, 'min') === 1 && statOf(v, 'max') === 100);
  ok('stat: percentile interpolates linearly', close(statOf(v, 'percentile', 90), 61.6));
  ok('stat: nothing numeric → null', statOf([null, 'a'], 'avg') === null);
  // mean 3, deviations −2,−1,0,1,2 → SS 10 / (5 − 1) = 2.5 → σ = √2.5
  ok('stdev: sample (n − 1)', close(stdev([1, 2, 3, 4, 5]), Math.sqrt(2.5)) && mean([1, 2, 3]) === 2);
  ok('stdev: one value → null', stdev([7]) === null);

  const f = linearFit([2, 4, 6, 8]);
  ok('OLS: a perfect line — slope 2, intercept 2, R² 1', !!f && close(f.slope, 2) && close(f.intercept, 2) && close(f.r2, 1));
  // x = 0,2,3; y = 1,5,7 → mx 5/3, my 13/3, Sxx 14/3, Sxy 28/3 → slope 2, intercept 13/3 − 10/3 = 1
  const g = linearFit([1, null, 5, 7]);
  ok('OLS: a null keeps its position (a gap, not a shift)', !!g && close(g.slope, 2) && close(g.intercept, 1) && g.n === 3);
  // y = 1,3,2 at x = 0,1,2 → slope 0.5, intercept 1.5; fitted 1.5,2,2.5 → SSres 0.25+1+0.25 = 1.5; SStot 2 → R² 0.25
  const h = linearFit([1, 3, 2]);
  ok('OLS: R² on an imperfect fit', !!h && close(h.slope, 0.5) && close(h.r2, 0.25));
  ok('OLS: a flat series has no R² to report', linearFit([5, 5, 5])?.r2 === null);
  ok('OLS: fewer than two points → null', linearFit([1]) === null);

  ok('moving average: first w−1 are null', JSON.stringify(movingAverage([1, 2, 3, 4, 5], 3)) === '[null,null,2,3,4]');
  // window 2 over 1,null,3,5 → [null, avg(1)=1, avg(3)=3, avg(3,5)=4]
  ok('moving average: a null inside a window is skipped', JSON.stringify(movingAverage([1, null, 3, 5], 2)) === '[null,1,3,4]');

  ok('highlight: top 2 keeps a tie at the cut', JSON.stringify(highlightIndices([5, 9, 9, 1], 'top', 1)) === '[1,2]');
  ok('highlight: bottom 1', JSON.stringify(highlightIndices([5, 9, 9, 1], 'bottom', 1)) === '[3]');
  ok('highlight: above a threshold', JSON.stringify(highlightIndices([5, 9, null, 1], 'above', 3, 4)) === '[0,1]');
  ok('highlight: fewer points than n → all of them', JSON.stringify(highlightIndices([2, 1], 'top', 5)) === '[0,1]');
}

// ── 3. forecasts ─────────────────────────────────────────────────────────────

{
  const fs1 = fitSeries([null, 1, null, 3, null]);
  ok('fit series: trims ends, interpolates the interior, counts the tail', JSON.stringify(fs1.ys) === '[1,2,3]' && fs1.tail === 1);

  const lin = forecastSeries([10, 20, 30, 40], { method: 'linear', horizon: 3, season: 0 });
  ok('linear: a perfect line extrapolates exactly, with a zero-width interval',
    !('error' in lin) && JSON.stringify(lin.values) === '[50,60,70]' && JSON.stringify(lin.lo) === '[50,60,70]');
  // A trailing gap is stepped over: the forecast lands on the periods AFTER the last label.
  const gap = forecastSeries([10, 20, 30, null], { method: 'linear', horizon: 2, season: 0 });
  ok('linear: a trailing empty period is skipped, not forecast into', !('error' in gap) && JSON.stringify(gap.values) === '[50,60]');
  const lin2 = forecastSeries([1, 3, 2, 4], { method: 'linear', horizon: 1, season: 0 });
  // OLS on 1,3,2,4: mx 1.5, my 2.5, Sxx 5, Sxy 4 → slope 0.8, intercept 1.3 → x=4: 4.5
  // residuals −0.3, 0.9, −0.9, 0.3 → SS 1.8 → se √(1.8/2) = √0.9
  // half = 1.28155 · √0.9 · √(1 + 1/4 + (4 − 1.5)²/5) = 1.28155 · 0.948683 · √2.5
  const half = 1.2815515655446004 * Math.sqrt(0.9) * Math.sqrt(2.5);
  ok('linear: the OLS prediction interval', !('error' in lin2) && close(lin2.values[0], 4.5) && close(lin2.hi[0] - lin2.values[0], half, 1e-9));

  const saw = [1, 2, 3, 4, 1, 2, 3, 4];
  const sn = forecastSeries(saw, { method: 'seasonal_naive', horizon: 5, season: 4 });
  ok('seasonal naive: repeats the season; zero error → zero width',
    !('error' in sn) && JSON.stringify(sn.values) === '[1,2,3,4,1]' && sn.season === 4 && JSON.stringify(sn.hi) === '[1,2,3,4,1]');
  const naive = forecastSeries([3, 5, 4], { method: 'seasonal_naive', horizon: 2, season: 0 });
  // no season → last value; errors 2, −1 → σ = √(5/2); h=2 → k = 2 → half = z·σ·√2
  ok('seasonal naive: no season is the naive forecast, widening each step',
    !('error' in naive) && JSON.stringify(naive.values) === '[4,4]'
    && close(naive.hi[1] - 4, 1.2815515655446004 * Math.sqrt(2.5) * Math.sqrt(2)));

  const season12 = Array.from({ length: 36 }, (_, t) => 100 + 2 * t + 20 * Math.sin((2 * Math.PI * t) / 12));
  ok('season: a monthly cycle is detected as 12', detectSeason(season12) === 12);
  const season4 = Array.from({ length: 24 }, (_, t) => 50 + t + [8, -8, 4, -4][t % 4]);
  ok('season: a quarterly cycle is detected as 4', detectSeason(season4) === 4);
  const season7 = Array.from({ length: 28 }, (_, t) => 10 + [0, 1, 2, 3, 9, 14, 2][t % 7]);
  ok('season: a weekly cycle is detected as 7', detectSeason(season7) === 7);
  ok('season: a straight line has none', detectSeason(Array.from({ length: 30 }, (_, t) => 3 * t)) === 0);
  ok('season: too short to tell → none', detectSeason([1, 2, 1, 2]) === 0);
  ok('autocorrelation: lag 2 of an alternating series is 1', close(autocorrelation([1, -1, 1, -1, 1, -1], 2), 4 / 6));

  const hw = forecastSeries(season4, { method: 'holt_winters', horizon: 4, season: 'auto' });
  const truth = [24, 25, 26, 27].map((t) => 50 + t + [8, -8, 4, -4][t % 4]);
  ok('Holt-Winters: detects the season and tracks a trend + season within 5%',
    !('error' in hw) && hw.season === 4 && hw.values.every((v, i) => Math.abs(v - truth[i]) / truth[i] < 0.05),
    'error' in hw ? hw.error : JSON.stringify({ got: hw.values, truth }));
  ok('Holt-Winters: the interval widens with the horizon',
    !('error' in hw) && hw.hi[3] - hw.lo[3] >= hw.hi[0] - hw.lo[0]);
  const holt = forecastSeries([10, 12, 14, 16, 18], { method: 'holt_winters', horizon: 1, season: 0 });
  ok('Holt (no season): a perfect line continues', !('error' in holt) && close(holt.values[0], 20, 1e-6));
  const short = forecastSeries([1, 2, 3, 4, 5, 6], { method: 'holt_winters', horizon: 1, season: 12 });
  ok('Holt-Winters: too short for the season is an error, never a guess', 'error' in short);
  ok('forecast: fewer than three periods is an error', 'error' in forecastSeries([1, 2], { method: 'linear', horizon: 1, season: 0 }));

  ok('future: months roll the year', JSON.stringify(futureLabels(['2024-11'], 'month', 3)) === '["2024-12","2025-01","2025-02"]');
  ok('future: quarters', JSON.stringify(futureLabels(['2024-Q3', '2024-Q4'], 'quarter', 2)) === '["2025-Q1","2025-Q2"]');
  ok('future: years', JSON.stringify(futureLabels(['2023', '2024'], 'year', 1)) === '["2025"]');
  ok('future: a day axis of 1st-of-months steps by month',
    JSON.stringify(futureLabels(['2024-11-01', '2024-12-01'], 'day', 2)) === '["2025-01-01","2025-02-01"]'
    && stepGrainOf(['2024-11-01', '2024-12-01'], 'day') === 'month');
  ok('future: weeks step seven days', JSON.stringify(futureLabels(['2024-12-30'], 'week', 1)) === '["2025-01-06"]');
  ok('future: days', JSON.stringify(futureLabels(['2024-02-28'], 'day', 2)) === '["2024-02-29","2024-03-01"]');
  ok('future: labels that are not buckets → null', futureLabels(['East'], 'month', 1) === null);
}

// ── 4. resolution ────────────────────────────────────────────────────────────

const months = { labels: ['2024-01', '2024-02', '2024-03', '2024-04'], series: [{ name: 'sum of revenue', values: [10, 20, 30, 40] }] };
const dateCat = { kind: 'date' as const, grain: 'month' as const };

{
  const r = resolveOverlays(months, sanitizeOverlays([
    { id: 'ref', kind: 'reference', value: { type: 'stat', stat: 'avg' } },
    { id: 'tgt', kind: 'target', value: { type: 'constant', value: 50 } },
    { id: 'bnd', kind: 'band', sd: 1 },
    { id: 'trd', kind: 'trend' },
    { id: 'mav', kind: 'moving_average', window: 2 },
    { id: 'fct', kind: 'forecast', method: 'linear', horizon: 2, season: 0 },
    { id: 'ann', kind: 'annotation', at: '2024-03', text: 'Launch' },
    { id: 'hil', kind: 'highlight', rule: 'top', n: 1 },
    { id: 'hid', kind: 'trend', hidden: true },
  ]), { category: dateCat });
  const by = (id: string) => r.find((x) => x.id === id)!;
  ok('resolve: hidden overlays are skipped', r.length === 8 && !r.some((x) => x.id === 'hid'));
  ok('resolve: reference = the series average (25), draggable only when constant',
    by('ref').value === 25 && by('ref').text === 'Average 25' && !by('ref').draggable);
  // latest 40 / target 50 = 80%
  ok('resolve: target attainment on a date axis is the latest value / target',
    by('tgt').value === 50 && close(by('tgt').target?.attainment, 0.8) && by('tgt').text === 'Target 50 · latest at 80%' && by('tgt').draggable === true);
  // mean 25, σ = √(500/3) ≈ 12.91
  const sd = Math.sqrt(500 / 3);
  ok('resolve: band mean ± 1σ', close(by('bnd').from, 25 - sd) && close(by('bnd').to, 25 + sd));
  ok('resolve: trend slope, R² and the grain noun',
    close(by('trd').trend?.slope, 10) && close(by('trd').trend?.r2, 1) && by('trd').text === '+10 per month · R² 1.00'
    && JSON.stringify(by('trd').points) === '[10,20,30,40]');
  ok('resolve: moving average points', JSON.stringify(by('mav').points) === '[null,15,25,35]' && by('mav').label === '2-month moving average');
  ok('resolve: forecast values, labels and readout',
    JSON.stringify(by('fct').forecast?.values) === '[50,60]' && JSON.stringify(by('fct').forecast?.labels) === '["2024-05","2024-06"]'
    && by('fct').text === '60 by 2024-06 (80%: 60–60) · Linear', by('fct').text);
  ok('resolve: annotation carries its value for placement', by('ann').annotation?.value === 30 && by('ann').text === '2024-03: Launch');
  ok('resolve: highlight indices', JSON.stringify(by('hil').highlight?.indices) === '[3]' && by('hil').text === 'Top 1: 1 point');

  const text = resolveOverlays({ labels: ['East', 'West', 'North'], series: [{ name: 's', values: [3, 1, 2] }] },
    sanitizeOverlays([{ id: 't', kind: 'trend' }, { id: 'f', kind: 'forecast' }, { id: 'g', kind: 'target', value: { type: 'constant', value: 2 } }]),
    { category: { kind: 'text' } });
  ok('resolve: a trend on a text axis is refused with a reason', text[0].warning === 'A trend needs a date or number axis' && !text[0].points);
  ok('resolve: a forecast needs a date axis', text[1].warning === 'A forecast needs a date axis');
  ok('resolve: a target off a date axis counts the points at or above it',
    text[2].target?.attainment === null && text[2].target?.met === 2 && text[2].text === 'Target 2 · 2 of 3 at or above');

  const inferred = resolveOverlays(months, sanitizeOverlays([{ id: 't', kind: 'trend' }]));
  ok('resolve: with no CategoryInfo, bucket-shaped labels are read as a date axis', !inferred[0].warning && close(inferred[0].trend?.slope, 10));

  const metric = new Map([[ID(7), { name: 'Revenue target', value: 35 }], [ID(8), { name: 'Empty', value: null }]]);
  const m = resolveOverlays(months, sanitizeOverlays([
    { id: 'm1', kind: 'target', value: { type: 'metric', metricId: ID(7) } },
    { id: 'm2', kind: 'reference', value: { type: 'metric', metricId: ID(8) } },
  ]), { category: dateCat, metrics: metric });
  ok('resolve: a metric target uses the metrics layer\'s figure and name',
    m[0].value === 35 && m[0].label === 'Revenue target' && !m[0].draggable);
  ok('resolve: a metric with no value under the scope is a warning, not a zero', !!m[1].warning && m[1].value === undefined);

  const miss = resolveOverlays(months, sanitizeOverlays([
    { id: 'x', kind: 'trend', series: 3 },
    { id: 'y', kind: 'annotation', at: '1999-01', text: 'gone' },
  ]), { category: dateCat });
  ok('resolve: a series that is not there is a warning', miss[0].warning === 'That series is not on this chart');
  ok('resolve: an annotation whose category left the axis is a warning', miss[1].warning === 'That category is not on the chart any more');
  ok('resolve: bad data never throws', resolveOverlays(null, sanitizeOverlays([{ id: 'z', kind: 'trend' }]))[0].warning !== undefined);
}

// ── 5. parity with the renderer's chartTypeSpec ──────────────────────────────

{
  const root = path.resolve(__dirname, '..');
  const specSrc = fs.readFileSync(path.join(root, 'renderer', 'hub', 'chartTypeSpec.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(specSrc + '\n;this.resolveChartType = resolveChartType;', sandbox);
  const resolve = sandbox.resolveChartType as (t: string) => { overlayKinds: string[] };
  const rr = fs.readFileSync(path.join(root, 'renderer', 'hub', 'renderResult.ts'), 'utf8');
  const idsMatch = /const\s+ALL_CHART_TYPE_IDS\s*=\s*\[([\s\S]*?)\]/.exec(rr);
  const ids = idsMatch ? (idsMatch[1].match(/'([a-z_]+)'/g) || []).map((q) => q.slice(1, -1)) : [];
  ok('parity: ALL_CHART_TYPE_IDS parsed', ids.length >= 29, String(ids.length));
  const drift = ids.filter((id) => JSON.stringify(resolve(id).overlayKinds) !== JSON.stringify(OVERLAY_ACCEPT[id] || []));
  ok('parity: main\'s OVERLAY_ACCEPT matches chartTypeSpec.overlayKinds for every chart id', drift.length === 0, drift.join(','));
  const five = ['waterfall', 'bullet', 'calendar', 'radar', 'pareto'];
  ok('parity: the five #177 types are each decided explicitly', five.every((t) => Array.isArray(OVERLAY_ACCEPT[t])));
  ok('accept: a line takes a forecast, a Pareto does not, a radar takes nothing',
    overlayAccepted('line', 'forecast') && !overlayAccepted('pareto', 'forecast') && !overlayAccepted('radar', 'reference')
    && overlayAccepted('waterfall', 'target') && !overlayAccepted('pie', 'reference'));
}

// ── 6. narration ─────────────────────────────────────────────────────────────

{
  const resolved = resolveOverlays(months, sanitizeOverlays([
    { id: 'trd', kind: 'trend' },
    { id: 'fct', kind: 'forecast', method: 'linear', horizon: 2, season: 0 },
    { id: 'ref', kind: 'reference', value: { type: 'constant', value: 12 } },
  ]), { category: dateCat });
  const cap = tileCaption({ chartType: 'line', data: { ...months, analytics: resolved } });
  ok('caption: trend and forecast clauses follow the line sentence',
    cap === 'Revenue rose 300% from 2024-01 to 2024-04; trend +10 per month (R² 1.00); forecast 60 by 2024-06, 80% range 60–60', cap);
  ok('caption: a type that does not draw them says nothing about them',
    !tileCaption({ chartType: 'pareto', data: { ...months, analytics: resolved } }).includes('trend'));
  ok('caption: clauses are empty with no overlays', analyticsClauses([], 'line') === '');

  const facts = overlayFacts(resolved, 'line');
  ok('facts: one line per drawn overlay, raw figures', facts.length === 3 && facts[0].figures.some((f) => f.value === 10));
  const visual: any = {
    id: ID(1), projectId: ID(2), name: 'Revenue by month', datasetId: ID(3), chartType: 'line',
    encoding: { category: 'month', values: [{ column: 'revenue', aggregation: 'sum' }] },
    overrides: {}, filters: [], favorite: false, createdAt: '', updatedAt: '', schemaVersion: 2,
  };
  const vf = visualFacts(visual, 'Orders', { data: months, recommendedShape: 'time_series', warnings: [] } as any, {}, resolved);
  ok('facts: the visual facts block carries the overlays', vf.text.includes('Analytics overlays on this chart') && vf.text.includes('Linear trend'));
  ok('facts: every overlay figure is in the ledger', [10, 50, 60, 12].every((n) => vf.ledger.some((e) => e.value === n)));
  const audit = auditNumbers(vf.text, vf.ledger);
  ok('facts: the facts text passes its own number audit', audit.violations.length === 0, JSON.stringify(audit.violations));
}

finish();
